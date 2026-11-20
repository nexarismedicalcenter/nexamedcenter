import { FieldValue, Filter } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { createUserNotification } from "@/lib/notifications.server";

type DiagnosticType = "laboratory" | "imaging";
const ORDER_PAGE_SIZE = 50;
const labTransitions: Record<string, string> = { PAID: "ACCEPTED", ACCEPTED: "PATIENT_PRESENTED", PATIENT_PRESENTED: "SAMPLE_COLLECTED", SAMPLE_COLLECTED: "SAMPLE_RECEIVED", SAMPLE_RECEIVED: "ANALYSIS_IN_PROGRESS", ANALYSIS_IN_PROGRESS: "EXAM_COMPLETED" };
const imagingTransitions: Record<string, string> = { PAID: "ACCEPTED", ACCEPTED: "PATIENT_PRESENTED", PATIENT_PRESENTED: "EXAM_IN_PROGRESS", EXAM_IN_PROGRESS: "EXAM_COMPLETED" };

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "diagnostic-orders-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les commandes de ce centre ne sont pas accessibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA provider diagnostic orders failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function iso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).toISOString();
  return typeof value === "string" ? value : null;
}

async function verifiedProvider(request: Request) {
  const user = await requireFirebaseUser(request);
  await requireAppCheck(request);
  const profile = await getFirebaseAdminDb().collection("providerProfiles").doc(user.uid).get();
  const type = profile.get("type");
  if (!profile.exists || !["laboratory", "imaging"].includes(String(type)) || profile.get("status") !== "verified" || profile.get("publiclyListed") !== true) {
    throw new ApiRequestError(403, "verified-diagnostic-provider-required", "La gestion des commandes est réservée aux laboratoires et centres d’imagerie NEXA vérifiés.");
  }
  return { user, type: type as DiagnosticType };
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const { user, type } = await verifiedProvider(request);
    await enforceUserRateLimit({ uid: user.uid, action: "diagnostic-orders-read", limit: 60, windowMs: 60_000 });
    const db = getFirebaseAdminDb();
    const params = new URL(request.url).searchParams;
    const cursor = params.get("cursor")?.trim() || "";
    const rawSearch = params.get("q")?.trim() || "";
    if (rawSearch && !/^[A-Za-z0-9_-]{3,100}$/.test(rawSearch)) throw new ApiRequestError(400, "invalid-diagnostic-order-search", "Recherchez avec un numéro de commande ou un numéro patient NMC complet.");
    const searchTerm = rawSearch.toUpperCase();
    if (cursor && !/^[A-Za-z0-9_-]{10,200}$/.test(cursor)) throw new ApiRequestError(400, "invalid-diagnostic-order-cursor", "Le repère de pagination n’est pas valide.");
    let query = db.collection("nexaOrders").where("providerUid", "==", user.uid).where("kind", "==", type).where("paymentStatus", "in", ["PAID", "FREE"]).where("settlementStatus", "==", "CONFIRMED").orderBy("createdAt", "desc");
    if (searchTerm) query = query.where(Filter.or(
      Filter.where("orderNumber", "==", searchTerm),
      Filter.where("patientNumber", "==", searchTerm),
    ));
    if (cursor) {
      const cursorSnapshot = await db.collection("nexaOrders").doc(cursor).get();
      const cursorOrder = cursorSnapshot.data() || {};
      const matchesSearch = !searchTerm || cursorOrder.orderNumber === searchTerm || cursorOrder.patientNumber === searchTerm;
      if (!cursorSnapshot.exists || cursorOrder.providerUid !== user.uid || cursorOrder.kind !== type || !["PAID", "FREE"].includes(String(cursorOrder.paymentStatus)) || cursorOrder.settlementStatus !== "CONFIRMED" || !cursorOrder.createdAt || !matchesSearch) {
        throw new ApiRequestError(400, "invalid-diagnostic-order-cursor", "Le repère de pagination n’est pas valide pour ce centre.");
      }
      query = query.startAfter(cursorSnapshot);
    }
    const snapshot = await query.limit(ORDER_PAGE_SIZE + 1).get();
    const pageDocs = snapshot.docs.slice(0, ORDER_PAGE_SIZE);
    const correctionResultIds = [...new Set(pageDocs.flatMap((doc) => {
      const items = doc.get("items");
      if (!Array.isArray(items)) return [];
      return items.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const value = item as Record<string, unknown>;
        return value.resultStatus === "CORRECTION_REQUESTED" && typeof value.resultId === "string" && /^[A-Za-z0-9_-]{10,200}$/.test(value.resultId)
          ? [value.resultId]
          : [];
      });
    }))];
    const correctionSnapshots = [];
    for (let offset = 0; offset < correctionResultIds.length; offset += 100) {
      correctionSnapshots.push(...await db.getAll(...correctionResultIds.slice(offset, offset + 100).map((resultId) => db.collection("diagnosticResults").doc(resultId))));
    }
    const correctionResults = new Map(correctionSnapshots.map((snapshot) => [snapshot.id, snapshot]));
    const orders = pageDocs.map((doc) => {
      const data = doc.data();
      const items = Array.isArray(data.items) ? data.items.map((rawItem) => {
        if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return rawItem;
        const item = rawItem as Record<string, unknown>;
        const safeItem = { ...item };
        delete safeItem.correctionReason;
        if (item.resultStatus !== "CORRECTION_REQUESTED" || typeof item.resultId !== "string") return safeItem;
        const resultSnapshot = correctionResults.get(item.resultId);
        const result = resultSnapshot?.data();
        const reason = result?.reviewReason;
        const matchesOrder = resultSnapshot?.exists === true
          && result?.providerUid === user.uid
          && result?.providerType === type
          && result?.orderId === doc.id
          && result?.examLineId === item.offerId
          && result?.status === "CORRECTION_REQUESTED";
        return matchesOrder && typeof reason === "string" ? { ...safeItem, correctionReason: reason.slice(0, 1000) } : safeItem;
      }) : [];
      return {
        id: doc.id,
        orderNumber: typeof data.orderNumber === "string" ? data.orderNumber : `NMC-${type === "laboratory" ? "LAB" : "IMG"}-${doc.id.slice(-8).toUpperCase()}`,
        patientNumber: typeof data.patientNumber === "string" ? data.patientNumber : "Patient NEXA",
        providerName: data.providerName || "Partenaire NEXA",
        items,
        amount: Number(data.amount) || 0,
        currency: data.currency || "HTG",
        paymentStatus: data.paymentStatus || "PENDING",
        status: data.status || "UNKNOWN",
        requiresPrescription: Boolean(data.prescriptionId),
        createdAt: iso(data.createdAt),
      };
    });
    const hasMore = snapshot.docs.length > ORDER_PAGE_SIZE;
    await db.collection("adminAuditLogs").doc().set({
      actorUid: user.uid,
      action: `${type}_orders_listed`,
      resource: `providerProfiles/${user.uid}`,
      resultCount: orders.length,
      hasMore,
      searchApplied: Boolean(searchTerm),
      createdAt: FieldValue.serverTimestamp(),
    });
    return json(request, { ok: true, orders, hasMore, nextCursor: hasMore ? pageDocs.at(-1)?.id || null : null });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const { user, type } = await verifiedProvider(request);
    await enforceUserRateLimit({ uid: user.uid, action: "diagnostic-order-update", limit: 30, windowMs: 60_000 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande de mise à jour n’est pas valide.");
    const input = body as Record<string, unknown>;
    const orderId = typeof input.orderId === "string" ? input.orderId.trim() : "";
    const action = typeof input.action === "string" ? input.action.trim() : "";
    const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(orderId) || !["accept", "refuse", "advance"].includes(action)) throw new ApiRequestError(400, "invalid-diagnostic-order-action", "La commande ou l’action n’est pas valide.");
    if (action === "refuse" && reason.length < 5) throw new ApiRequestError(400, "refusal-reason-required", "Indiquez un motif de refus de cinq caractères au minimum.");

    const db = getFirebaseAdminDb();
    const orderRef = db.collection("nexaOrders").doc(orderId);
    const providerRef = db.collection("providerProfiles").doc(user.uid);
    const alertRef = db.collection("paymentSettlementAlerts").doc(`diagnostic_refusal_${orderId}`);
    const auditRef = db.collection("adminAuditLogs").doc();
    const eventRef = db.collection("nexaOrderEvents").doc();
    const result = await db.runTransaction(async (transaction) => {
      const [providerSnapshot, orderSnapshot, alertSnapshot] = await Promise.all([
        transaction.get(providerRef), transaction.get(orderRef), transaction.get(alertRef),
      ]);
      if (!providerSnapshot.exists || providerSnapshot.get("type") !== type || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true) throw new ApiRequestError(403, "provider-no-longer-authorized", "Le profil partenaire n’est plus autorisé à traiter des commandes.");
      if (!orderSnapshot.exists || orderSnapshot.get("kind") !== type || orderSnapshot.get("providerUid") !== user.uid) throw new ApiRequestError(404, "diagnostic-order-not-found", "Cette commande n’est pas accessible à votre centre.");
      const order = orderSnapshot.data() || {};
      if (!["PAID", "FREE"].includes(String(order.paymentStatus))) throw new ApiRequestError(409, "diagnostic-order-not-settled", "Le paiement doit être confirmé avant le traitement de cette commande.");
      const current = String(order.status || "");
      let next = "";
      if (action === "refuse") {
        if (!["PAID", "ACCEPTED"].includes(current)) throw new ApiRequestError(409, "diagnostic-order-transition-invalid", "Cette commande ne peut plus être refusée à cette étape.");
        next = "PROVIDER_REFUSED";
        if (order.paymentStatus === "PAID" && !alertSnapshot.exists) transaction.create(alertRef, {
          resourceType: type === "laboratory" ? "laboratory-order" : "imaging-order",
          resourceId: orderId,
          patientUid: order.patientUid || null,
          reason: `${type.toUpperCase()}_PROVIDER_REFUSED_AFTER_PAYMENT`,
          status: "open",
          createdAt: FieldValue.serverTimestamp(),
        });
      } else if (action === "accept") {
        if (current !== "PAID") throw new ApiRequestError(409, "diagnostic-order-transition-invalid", "Seule une commande réglée peut être acceptée.");
        next = "ACCEPTED";
      } else {
        const table = type === "laboratory" ? labTransitions : imagingTransitions;
        next = table[current] || "";
        if (!next) throw new ApiRequestError(409, "diagnostic-order-transition-invalid", "Cette commande ne peut pas passer à l’étape suivante.");
      }
      const now = FieldValue.serverTimestamp();
      transaction.set(orderRef, {
        status: next,
        ...(action === "refuse" ? { refundRequired: order.paymentStatus === "PAID", refundStatus: order.paymentStatus === "PAID" ? "PENDING_REVIEW" : "NOT_APPLICABLE", refusalReason: reason } : {}),
        ...(next === "ACCEPTED" ? { acceptedAt: now } : {}),
        ...(next === "PATIENT_PRESENTED" ? { patientPresentedAt: now } : {}),
        ...(next === "SAMPLE_COLLECTED" ? { sampleCollectedAt: now } : {}),
        ...(next === "SAMPLE_RECEIVED" ? { sampleReceivedAt: now } : {}),
        ...(next === "ANALYSIS_IN_PROGRESS" || next === "EXAM_IN_PROGRESS" ? { examinationStartedAt: now } : {}),
        ...(next === "EXAM_COMPLETED" ? { examinationCompletedAt: now } : {}),
        ...(next === "COMPLETED" ? { completedAt: now } : {}),
        updatedAt: now,
      }, { merge: true });
      transaction.create(eventRef, { orderId, fromStatus: current, toStatus: next, action: action === "advance" ? "ADVANCE" : action.toUpperCase(), actorUid: user.uid, ...(action === "refuse" ? { reason } : {}), createdAt: now });
      transaction.create(auditRef, { actorUid: user.uid, action: `${type}_order_${action}`, resource: `nexaOrders/${orderId}`, createdAt: now });
      return { patientUid: String(order.patientUid || ""), status: next, paymentStatus: String(order.paymentStatus || "") };
    });

    if (result.patientUid) {
      const messages: Record<string, { title: string; body: string }> = {
        ACCEPTED: { title: "Commande d’examen acceptée", body: "Le centre a accepté votre demande. Consultez les consignes et contactez le centre si un rendez-vous est nécessaire." },
        PATIENT_PRESENTED: { title: "Présence confirmée", body: "Le centre a confirmé votre arrivée." },
        SAMPLE_COLLECTED: { title: "Prélèvement effectué", body: "Le laboratoire a confirmé le prélèvement." },
        SAMPLE_RECEIVED: { title: "Échantillon reçu", body: "Le laboratoire a reçu l’échantillon pour analyse." },
        ANALYSIS_IN_PROGRESS: { title: "Analyse en cours", body: "Le laboratoire a commencé l’analyse." },
        EXAM_IN_PROGRESS: { title: "Examen en cours", body: "Le centre a commencé l’examen d’imagerie." },
        EXAM_COMPLETED: { title: "Examen réalisé", body: "Le résultat est en préparation. Vous le retrouverez dans votre espace patient après vérification par NEXA." },
        COMPLETED: { title: "Commande terminée", body: "Le laboratoire a terminé votre commande. Contactez-le pour récupérer le résultat." },
        PROVIDER_REFUSED: { title: "Commande refusée", body: result.paymentStatus === "PAID" ? "Le centre a refusé la commande payée. NEXA doit vérifier le remboursement; ne payez pas à nouveau." : "Le centre a refusé cette demande gratuite." },
      };
      const copy = messages[result.status];
      if (copy) await createUserNotification({ uid: result.patientUid, eventKey: `diagnostic-order:${orderId}:${result.status}`, type: result.status === "PROVIDER_REFUSED" ? "diagnostic_order_refund_review" : "diagnostic_order_status", title: copy.title, body: copy.body, url: "/espace#commandes" });
    }
    return json(request, { ok: true, orderId, status: result.status });
  } catch (error) { return fail(request, error); }
}
