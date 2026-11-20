import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { createUserNotification } from "@/lib/notifications.server";
import { consumeReservedLots, releaseReservedLots } from "@/lib/pharmacy/stock";

const transitions: Record<"accept" | "prepare" | "ready", { from: string; to: string }> = {
  accept: { from: "PAID", to: "ACCEPTED" },
  prepare: { from: "ACCEPTED", to: "PREPARING" },
  ready: { from: "PREPARING", to: "READY" },
};

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "pharmacy-orders-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les commandes pharmacie ne sont pas accessibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA provider pharmacy orders failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

async function verifiedPharmacy(request: Request) {
  const user = await requireFirebaseUser(request);
  await requireAppCheck(request);
  const provider = await getFirebaseAdminDb().collection("providerProfiles").doc(user.uid).get();
  if (!provider.exists || provider.get("type") !== "pharmacy" || provider.get("status") !== "verified" || provider.get("publiclyListed") !== true) {
    throw new ApiRequestError(403, "verified-pharmacy-required", "La gestion des commandes est réservée aux pharmacies NEXA vérifiées.");
  }
  return user;
}

function safeOrder(id: string, data: Record<string, unknown>) {
  return {
    id,
    orderNumber: `NMC-PH-${id.slice(-8).toUpperCase()}`,
    items: Array.isArray(data.items) ? data.items : [],
    subtotal: Number(data.subtotal) || 0,
    deliveryFee: Number(data.deliveryFee) || 0,
    amount: Number(data.amount) || 0,
    currency: typeof data.currency === "string" ? data.currency : "HTG",
    deliveryMethod: data.deliveryMethod || "pickup",
    deliveryAddress: data.deliveryMethod === "delivery" && data.deliveryAddress && typeof data.deliveryAddress === "object" ? (() => {
      const address = data.deliveryAddress as Record<string, unknown>;
      return { recipientName: String(address.recipientName || ""), phone: String(address.phone || ""), department: String(address.department || ""), commune: String(address.commune || ""), addressLine: String(address.addressLine || ""), instructions: String(address.instructions || "") };
    })() : null,
    paymentStatus: data.paymentStatus || "PENDING",
    status: data.status || "UNKNOWN",
    requiresPrescription: Boolean(data.prescriptionId),
    createdAt: data.createdAt && typeof data.createdAt === "object" && "toDate" in data.createdAt && typeof data.createdAt.toDate === "function" ? (data.createdAt.toDate() as Date).toISOString() : null,
  };
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const user = await verifiedPharmacy(request);
    const snapshot = await getFirebaseAdminDb().collection("nexaOrders").where("providerUid", "==", user.uid).where("kind", "==", "pharmacy").orderBy("createdAt", "desc").limit(100).get();
    return json(request, { ok: true, orders: snapshot.docs.map((doc) => safeOrder(doc.id, doc.data())) });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const user = await verifiedPharmacy(request);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande de commande n’est pas valide.");
    const input = body as Record<string, unknown>;
    const orderId = typeof input.orderId === "string" ? input.orderId.trim() : "";
    const action = input.action;
    const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
    const deliveryProofReference = typeof input.deliveryProofReference === "string" ? input.deliveryProofReference.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) : "";
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(orderId) || !["accept", "refuse", "prepare", "ready", "dispatch", "deliver", "complete"].includes(String(action))) {
      throw new ApiRequestError(400, "invalid-pharmacy-order-action", "La commande ou l’action n’est pas valide.");
    }
    if (action === "refuse" && !reason) throw new ApiRequestError(400, "refusal-reason-required", "Un motif de refus est obligatoire.");
    if (action === "deliver" && deliveryProofReference.length < 3) throw new ApiRequestError(400, "delivery-proof-required", "Saisissez une référence de preuve de remise avant de confirmer la livraison.");

    const db = getFirebaseAdminDb();
    const orderRef = db.collection("nexaOrders").doc(orderId);
    const providerRef = db.collection("providerProfiles").doc(user.uid);
    const alertRef = db.collection("paymentSettlementAlerts").doc(`pharmacy_refusal_${orderId}`);
    const auditRef = db.collection("adminAuditLogs").doc();
    const eventRef = db.collection("nexaOrderEvents").doc();
    const result = await db.runTransaction(async (transaction) => {
      const [providerSnapshot, orderSnapshot, alertSnapshot] = await Promise.all([
        transaction.get(providerRef), transaction.get(orderRef), transaction.get(alertRef),
      ]);
      if (!providerSnapshot.exists || providerSnapshot.get("type") !== "pharmacy" || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true) throw new ApiRequestError(403, "verified-pharmacy-required", "Le profil pharmacie n’est plus autorisé.");
      if (!orderSnapshot.exists || orderSnapshot.get("kind") !== "pharmacy" || orderSnapshot.get("providerUid") !== user.uid) throw new ApiRequestError(404, "pharmacy-order-not-found", "Cette commande n’est pas accessible à votre pharmacie.");
      const order = orderSnapshot.data() || {};
      if (order.paymentStatus !== "PAID") throw new ApiRequestError(409, "order-not-paid", "Le paiement confirmé est requis avant de traiter cette commande.");

      const productLines = Array.isArray(order.items) ? order.items as Record<string, unknown>[] : [];
      const movementRefs = productLines.map((_, index) => db.collection("pharmacyStockMovements").doc(`${orderId}__${action}__${index}`));
      const requiresStockUpdate = action === "refuse" || action === "complete" || action === "deliver";
      const productRefs = requiresStockUpdate ? productLines.map((item) => db.collection("pharmacyProducts").doc(String(item.productId || "_"))) : [];
      const productSnapshots = requiresStockUpdate ? await Promise.all(productRefs.map((ref) => transaction.get(ref))) : [];
      const stockUpdates: { index: number; lots: ReturnType<typeof releaseReservedLots>["lots"]; stock: number; reservedStock: number }[] = [];
      const reconcileProductStock = (mode: "release" | "consume") => {
        for (let index = 0; index < productLines.length; index += 1) {
          const snapshot = productSnapshots[index];
          const allocations = productLines[index].reservedLots;
          if (!snapshot?.exists || !Array.isArray(allocations)) throw new ApiRequestError(409, "order-stock-reservation-invalid", "La réservation par lot doit être rapprochée avant de traiter cette commande.");
          try {
            const stock = mode === "release"
              ? releaseReservedLots(snapshot.data() || {}, allocations as { lotNumber: string; quantity: number }[])
              : consumeReservedLots(snapshot.data() || {}, allocations as { lotNumber: string; quantity: number }[]);
            stockUpdates.push({ index, ...stock });
          } catch {
            throw new ApiRequestError(409, "order-stock-reservation-invalid", "La réservation par lot ne correspond plus au stock disponible. Faites vérifier cette commande avant de la clôturer.");
          }
        }
      };
      let nextStatus = "";
      if (action === "refuse") {
        if (!["PAID", "ACCEPTED", "PREPARING"].includes(String(order.status))) throw new ApiRequestError(409, "order-transition-invalid", "Cette commande ne peut plus être refusée à cette étape.");
        nextStatus = "PROVIDER_REFUSED";
        if (!alertSnapshot.exists) transaction.create(alertRef, {
          resourceType: "pharmacy-order", resourceId: orderId, patientUid: order.patientUid || null,
          reason: "PHARMACY_REFUSED_AFTER_PAYMENT", status: "open", createdAt: FieldValue.serverTimestamp(),
        });
        reconcileProductStock("release");
      } else if (action === "complete") {
        if (order.status !== "READY" || order.deliveryMethod !== "pickup") throw new ApiRequestError(409, "order-transition-invalid", "Seule une commande de retrait prête peut être terminée ici.");
        nextStatus = "COMPLETED";
        reconcileProductStock("consume");
      } else if (action === "dispatch") {
        if (order.status !== "READY" || order.deliveryMethod !== "delivery") throw new ApiRequestError(409, "order-transition-invalid", "Seule une commande de livraison prête peut être remise au livreur.");
        nextStatus = "DELIVERING";
      } else if (action === "deliver") {
        if (order.status !== "DELIVERING" || order.deliveryMethod !== "delivery") throw new ApiRequestError(409, "order-transition-invalid", "Cette commande doit être en cours de livraison avant la confirmation de remise.");
        nextStatus = "DELIVERED";
        reconcileProductStock("consume");
      } else {
        const transition = transitions[action as "accept" | "prepare" | "ready"];
        if (!transition || order.status !== transition.from) throw new ApiRequestError(409, "order-transition-invalid", "Cette commande ne peut pas passer à cette étape.");
        nextStatus = transition.to;
      }

      stockUpdates.forEach(({ index, lots, stock, reservedStock }) => transaction.set(productRefs[index], {
        lots,
        stock,
        reservedStock,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true }));
      if (action === "refuse" || action === "complete" || action === "deliver") {
        stockUpdates.forEach(({ index }) => {
          const line = productLines[index];
          const releasing = action === "refuse";
          transaction.create(movementRefs[index], {
            productId: String(line.productId || ""),
            providerUid: user.uid,
            orderId,
            movementType: releasing ? "RELEASE" : "SALE",
            direction: releasing ? "RELEASE" : "OUT",
            quantity: Number(line.quantity) || 0,
            lotAllocations: Array.isArray(line.reservedLots) ? line.reservedLots : [],
            actorUid: user.uid,
            reason: releasing ? "PROVIDER_REFUSED_PAID_ORDER" : "ORDER_FULFILLED",
            createdAt: FieldValue.serverTimestamp(),
          });
        });
      }
      transaction.set(orderRef, {
        status: nextStatus,
        ...(action === "refuse" ? { refundRequired: true, refundStatus: "PENDING_REVIEW", refusalReason: reason } : {}),
        ...(action === "complete" || action === "deliver" ? { fulfilledAt: FieldValue.serverTimestamp() } : {}),
        ...(action === "dispatch" ? { dispatchedAt: FieldValue.serverTimestamp() } : {}),
        ...(action === "deliver" ? { deliveredAt: FieldValue.serverTimestamp(), deliveryProofReference } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.create(eventRef, {
        orderId, fromStatus: order.status, toStatus: nextStatus,
        action: String(action).toUpperCase(), actorUid: user.uid,
        ...(action === "refuse" ? { reason } : {}),
        createdAt: FieldValue.serverTimestamp(),
      });
      transaction.create(auditRef, {
        actorUid: user.uid, action: `pharmacy_order_${String(action)}`,
        resource: `nexaOrders/${orderId}`, createdAt: FieldValue.serverTimestamp(),
      });
      return { patientUid: String(order.patientUid || ""), status: nextStatus, deliveryMethod: order.deliveryMethod };
    });

    if (result.patientUid) {
      const copy = action === "accept" ? { title: "Commande acceptée", body: "La pharmacie a accepté votre commande." }
        : action === "prepare" ? { title: "Commande en préparation", body: "La pharmacie prépare votre commande." }
        : action === "ready" ? { title: "Commande prête", body: result.deliveryMethod === "delivery" ? "Votre commande est prête à être remise au livreur." : "Votre commande est prête à être retirée à la pharmacie." }
        : action === "dispatch" ? { title: "Commande en livraison", body: "La pharmacie a remis votre commande au livreur." }
        : action === "deliver" ? { title: "Commande livrée", body: "La pharmacie a confirmé la remise de votre commande." }
        : action === "complete" ? { title: "Commande terminée", body: "Le retrait de votre commande a été confirmé." }
        : { title: "Commande refusée", body: "La pharmacie a refusé la commande payée. NEXA doit vérifier le remboursement; ne payez pas à nouveau." };
      await createUserNotification({
        uid: result.patientUid,
        eventKey: `pharmacy-order:${orderId}:${result.status}`,
        type: action === "refuse" ? "pharmacy_order_refund_review" : "pharmacy_order_status",
        title: copy.title,
        body: copy.body,
        url: "/espace#commandes",
      });
    }
    return json(request, { ok: true, orderId, status: result.status });
  } catch (error) { return fail(request, error); }
}
