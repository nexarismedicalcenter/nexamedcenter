import { randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { buildPrescriptionAvailabilityLines, isMedicationAvailabilityMatch, isPrescriptionPastExpiry } from "@/lib/prescription-availability";
import { isPharmacyDeliveryEnabled } from "@/lib/pharmacy/delivery-config.server";
import { reserveSellableLots } from "@/lib/pharmacy/stock";
import { calculateTransactionAmounts, getTransactionFeePolicy } from "@/lib/payments/transaction-fees.server";

const HOLD_MINUTES = 30;
const PAYMENT_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
type RequestedItem = { productId: string; quantity: number; prescriptionLineId?: string };

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "pharmacy-order-create-failed";
  const message = error instanceof ApiRequestError ? error.message : "La commande pharmacie ne peut pas être préparée pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA pharmacy order creation failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

function normalize(value: unknown): string {
  return clean(value, 180).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/\s+/g, " ");
}

function requestedItems(value: unknown): RequestedItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new ApiRequestError(400, "invalid-order-items", "Choisissez entre 1 et 20 produits dans une seule commande.");
  const items = value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiRequestError(400, "invalid-order-item", "Un article du panier n’est pas valide.");
    const input = raw as Record<string, unknown>;
    const productId = clean(input.productId, 200);
    const quantity = input.quantity;
    const prescriptionLineId = clean(input.prescriptionLineId, 64);
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(productId) || !Number.isSafeInteger(quantity) || Number(quantity) < 1 || Number(quantity) > 20 || (prescriptionLineId && !/^medication-[1-9]\d{0,2}$/.test(prescriptionLineId))) {
      throw new ApiRequestError(400, "invalid-order-item", "Vérifiez les produits et les quantités du panier.");
    }
    return { productId, quantity: Number(quantity), ...(prescriptionLineId ? { prescriptionLineId } : {}) };
  });
  if (new Set(items.map((item) => item.productId)).size !== items.length) throw new ApiRequestError(400, "duplicate-order-item", "Chaque produit doit apparaître une seule fois dans le panier.");
  return items;
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "pharmacy-order-create", limit: 8, windowMs: 5 * 60_000 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande de commande n’est pas valide.");
    const input = body as Record<string, unknown>;
    const deliveryMethod = input.deliveryMethod === "delivery" ? "delivery" : input.deliveryMethod === undefined || input.deliveryMethod === "pickup" ? "pickup" : null;
    if (!deliveryMethod) throw new ApiRequestError(400, "invalid-delivery-method", "Choisissez le retrait ou la livraison à domicile.");
    if (deliveryMethod === "delivery" && !isPharmacyDeliveryEnabled()) {
      throw new ApiRequestError(409, "delivery-not-available", "La livraison à domicile n’est pas encore ouverte par NEXA. Choisissez le retrait en pharmacie.");
    }
    let deliveryAddress: { recipientName: string; phone: string; department: string; commune: string; addressLine: string; instructions: string } | null = null;
    if (deliveryMethod === "delivery") {
      const raw = input.deliveryAddress;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiRequestError(400, "delivery-address-required", "Renseignez une adresse complète pour la livraison.");
      const address = raw as Record<string, unknown>;
      const phone = clean(address.phone, 32).replace(/\s+/g, " ");
      const phoneDigits = phone.replace(/\D/g, "");
      deliveryAddress = {
        recipientName: clean(address.recipientName, 120),
        phone,
        department: clean(address.department, 80),
        commune: clean(address.commune, 80),
        addressLine: clean(address.addressLine, 300),
        instructions: clean(address.instructions, 300),
      };
      if (!deliveryAddress.recipientName || !deliveryAddress.department || !deliveryAddress.commune || !deliveryAddress.addressLine || phoneDigits.length < 8 || phoneDigits.length > 15 || !/^\+?[0-9 ()-]{8,32}$/.test(phone)) {
        throw new ApiRequestError(400, "invalid-delivery-address", "Vérifiez le nom du destinataire, le téléphone, le département, la commune et l’adresse détaillée.");
      }
    }
    const items = requestedItems(input.items);
    const prescriptionId = clean(input.prescriptionId, 200);
    if (prescriptionId && !/^[A-Za-z0-9_-]{10,200}$/.test(prescriptionId)) throw new ApiRequestError(400, "invalid-prescription", "La référence d’ordonnance n’est pas valide.");
    if (items.some((item) => item.prescriptionLineId) && !prescriptionId) throw new ApiRequestError(400, "prescription-required-for-line-link", "Une ordonnance doit être sélectionnée pour relier un produit à sa ligne prescrite.");

    const db = getFirebaseAdminDb();
    const feePolicy = await getTransactionFeePolicy("pharmacy");
    const patientRef = db.collection("patientProfiles").doc(user.uid);
    const pharmacyUid = clean(input.pharmacyId, 128);
    if (!pharmacyUid || pharmacyUid === user.uid) throw new ApiRequestError(400, "invalid-pharmacy", "Choisissez une pharmacie publiée dans le catalogue NEXA.");
    const providerRef = db.collection("providerProfiles").doc(pharmacyUid);
    const productRefs = items.map((item) => db.collection("pharmacyProducts").doc(item.productId));
    const prescriptionRef = prescriptionId ? db.collection("clinicalPrescriptions").doc(prescriptionId) : null;
    const orderRef = db.collection("nexaOrders").doc();
    const paymentRef = randomBytes(24).toString("base64url");
    if (!PAYMENT_REFERENCE_PATTERN.test(paymentRef)) throw new ApiRequestError(500, "payment-reference-failed", "La commande ne peut pas être créée.");
    const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
    const auditRef = db.collection("adminAuditLogs").doc();
    const movementRefs = items.map((_, index) => db.collection("pharmacyStockMovements").doc(`${orderRef.id}__reservation__${index}`));
    const holdExpiresAt = Date.now() + HOLD_MINUTES * 60_000;

    const result = await db.runTransaction(async (transaction) => {
      const reads = await Promise.all([
        transaction.get(patientRef),
        transaction.get(providerRef),
        ...productRefs.map((ref) => transaction.get(ref)),
        ...(prescriptionRef ? [transaction.get(prescriptionRef)] : []),
      ]);
      const patientSnapshot = reads[0];
      const providerSnapshot = reads[1];
      const productSnapshots = reads.slice(2, 2 + items.length);
      const prescriptionSnapshot = prescriptionRef ? reads[2 + items.length] : null;
      const prescriptionData = prescriptionSnapshot?.data();
      if (!patientSnapshot.exists || patientSnapshot.get("role") !== "patient" || patientSnapshot.get("profileComplete") !== true || typeof patientSnapshot.get("patientNumber") !== "string") {
        throw new ApiRequestError(403, "complete-patient-profile-required", "Terminez votre inscription patient avant de commander.");
      }
      if (!providerSnapshot.exists || providerSnapshot.get("type") !== "pharmacy" || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true) {
        throw new ApiRequestError(409, "pharmacy-unavailable", "Cette pharmacie n’est plus disponible sur NEXA.");
      }

      let subtotal = 0;
      let deliveryFee = 0;
      let requiresPrescription = false;
      const orderLines: Record<string, unknown>[] = [];
      const stockUpdates: { index: number; lots: ReturnType<typeof reserveSellableLots>["lots"]; stock: number; reservedStock: number }[] = [];
      const matchedPrescriptionLines = new Set<string>();
      const prescribedMeds = prescriptionData ? buildPrescriptionAvailabilityLines(prescriptionData).filter((line) => line.type === "medication") : [];
      for (let index = 0; index < items.length; index += 1) {
        const requested = items[index];
        const productSnapshot = productSnapshots[index];
        if (!productSnapshot.exists) throw new ApiRequestError(404, "pharmacy-product-not-found", "Un produit du panier n’est plus disponible.");
        const product = productSnapshot.data() || {};
        if (product.providerUid !== pharmacyUid || product.publicationStatus !== "PUBLISHED" || product.active !== true) throw new ApiRequestError(409, "product-unavailable", "Un produit du panier a été retiré ou suspendu.");
        let reservation: ReturnType<typeof reserveSellableLots>;
        try { reservation = reserveSellableLots(product, requested.quantity); }
        catch { throw new ApiRequestError(409, "insufficient-stock", `Le stock en lots valides de « ${clean(product.name, 100) || "ce produit"} » vient de changer. Actualisez le panier.`); }
        stockUpdates.push({ index, ...reservation });
        const price = Number(product.price);
        if (!Number.isSafeInteger(price) || price < 1) throw new ApiRequestError(409, "product-price-invalid", "Le prix d’un produit du panier n’est pas valide.");
        const lineTotal = price * requested.quantity;
        subtotal += lineTotal;
        if (!Number.isSafeInteger(subtotal) || subtotal > 10_000_000) throw new ApiRequestError(400, "order-total-invalid", "Le total de la commande dépasse la limite autorisée.");
        if (deliveryMethod === "delivery") {
          const productMode = product.deliveryMode === "delivery" || product.deliveryMode === "both" ? product.deliveryMode : "pickup";
          if (productMode === "pickup" || product.coldChainRequired === true) throw new ApiRequestError(409, "home-delivery-unavailable", `La livraison à domicile n’est pas disponible pour « ${clean(product.name, 100) || "ce produit"} ». Choisissez le retrait en pharmacie.`);
          const zones = Array.isArray(product.deliveryZones) ? product.deliveryZones as Record<string, unknown>[] : [];
          const matchingZone = zones.find((zone) => zone.active !== false && normalize(zone.department) === normalize(deliveryAddress?.department) && normalize(zone.commune) === normalize(deliveryAddress?.commune));
          if (!matchingZone || !Number.isSafeInteger(matchingZone.feeHTG) || Number(matchingZone.feeHTG) < 0 || typeof matchingZone.etaLabel !== "string") {
            throw new ApiRequestError(409, "delivery-zone-unavailable", `La pharmacie ne livre pas « ${clean(deliveryAddress?.commune, 80)} » pour « ${clean(product.name, 100) || "ce produit"} ». Vérifiez les zones ou choisissez le retrait.`);
          }
          deliveryFee = Math.max(deliveryFee, Number(matchingZone.feeHTG));
        }
        const required = product.prescriptionRequired === true || product.regulatoryCategory !== "OTC";
        requiresPrescription ||= required;
        let prescriptionLineId: string | undefined;
        if (required) {
          if (!prescriptionSnapshot?.exists || prescriptionSnapshot.get("patientUid") !== user.uid || prescriptionSnapshot.get("status") !== "VALIDATED") {
            throw new ApiRequestError(403, "valid-prescription-required", "Une ordonnance NEXA validée vous appartenant est requise pour les produits sélectionnés.");
          }
          if (prescriptionData && isPrescriptionPastExpiry(prescriptionData)) throw new ApiRequestError(409, "prescription-expired", "Cette ordonnance a expiré et ne peut plus être utilisée.");
          const requestedLine = requested.prescriptionLineId ? prescribedMeds.find((line) => line.id === requested.prescriptionLineId) : undefined;
          if (requested.prescriptionLineId && (!requestedLine || matchedPrescriptionLines.has(requestedLine.id) || !isMedicationAvailabilityMatch(requestedLine, product))) {
            throw new ApiRequestError(409, "prescription-line-mismatch", "Le produit ne correspond pas à la ligne d’ordonnance sélectionnée. Actualisez les disponibilités.");
          }
          const matchedLine = requestedLine || prescribedMeds.find((line) => !matchedPrescriptionLines.has(line.id) && isMedicationAvailabilityMatch(line, product));
          if (!matchedLine) throw new ApiRequestError(409, "prescription-product-mismatch", `L’ordonnance sélectionnée ne contient pas de ligne correspondant à « ${clean(product.name, 100) || "ce produit"} » avec le même dosage et la même forme prescrite.`);
          const prescribedQuantity = Number(matchedLine.quantity);
          if (Number.isSafeInteger(prescribedQuantity) && prescribedQuantity > 0 && requested.quantity > prescribedQuantity) throw new ApiRequestError(409, "prescribed-quantity-exceeded", "La quantité sélectionnée dépasse celle inscrite sur l’ordonnance.");
          matchedPrescriptionLines.add(matchedLine.id);
          prescriptionLineId = matchedLine.id;
        } else if (requested.prescriptionLineId) {
          throw new ApiRequestError(400, "unexpected-prescription-line", "Une ligne d’ordonnance ne peut être liée qu’à un médicament qui la requiert.");
        }
        orderLines.push({ productId: requested.productId, name: clean(product.name, 180), dci: clean(product.dci, 180), dosage: clean(product.dosage, 120), pharmaceuticalForm: clean(product.pharmaceuticalForm, 100), quantity: requested.quantity, reservedLots: reservation.allocations, unitPrice: price, lineTotal, prescriptionRequired: required, ...(prescriptionLineId ? { prescriptionLineId } : {}) });
      }
      if (requiresPrescription && !prescriptionId) throw new ApiRequestError(403, "valid-prescription-required", "Sélectionnez une ordonnance NEXA validée avant de commander ce produit.");
      if (!requiresPrescription && prescriptionId) throw new ApiRequestError(400, "unexpected-prescription", "Retirez l’ordonnance ou choisissez un produit qui la requiert.");
      const amount = subtotal + deliveryFee;
      if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10_000_000) throw new ApiRequestError(400, "order-total-invalid", "Le total de la commande dépasse la limite autorisée.");
      const paymentAmounts = calculateTransactionAmounts(amount, feePolicy);

      const now = FieldValue.serverTimestamp();
      const providerProfile = providerSnapshot.get("profile") && typeof providerSnapshot.get("profile") === "object" ? providerSnapshot.get("profile") as Record<string, unknown> : {};
      const order = {
        kind: "pharmacy",
        patientUid: user.uid,
        patientNumber: patientSnapshot.get("patientNumber"),
        providerUid: pharmacyUid,
        providerName: clean(providerProfile.name, 120) || "Pharmacie NEXA",
        items: orderLines,
        ...(prescriptionId ? { prescriptionId } : {}),
        subtotal,
        deliveryFee,
        deliveryMethod,
        ...(deliveryAddress ? { deliveryAddress } : {}),
        amount,
        transactionFee: paymentAmounts.feeAmount,
        transactionFeeRateBps: paymentAmounts.feeRateBps,
        transactionFeeRecipient: paymentAmounts.feeRecipient,
        totalAmount: paymentAmounts.totalAmount,
        currency: "HTG",
        paymentMethod: "MONCASH",
        paymentStatus: "PENDING",
        status: "PENDING_PAYMENT",
        settlementStatus: "PENDING",
        holdExpiresAt,
        moncashPaymentRef: paymentRef,
        createdAt: now,
        updatedAt: now,
      };
      transaction.create(orderRef, order);
      transaction.create(paymentRefDoc, {
        uid: user.uid,
        paymentMethod: "MONCASH",
        resourceType: "pharmacy-order",
        resourcePath: orderRef.path,
        amount: paymentAmounts.totalAmount,
        serviceAmount: amount,
        transactionFee: paymentAmounts.feeAmount,
        transactionFeeRateBps: paymentAmounts.feeRateBps,
        feeRecipient: paymentAmounts.feeRecipient,
        currency: "HTG",
        status: "created",
        createdAt: now,
        updatedAt: now,
      });
      stockUpdates.forEach(({ index, lots, stock, reservedStock }) => transaction.set(productRefs[index], {
        lots,
        stock,
        reservedStock,
        updatedAt: now,
      }, { merge: true }));
      stockUpdates.forEach(({ index }) => transaction.create(movementRefs[index], {
        productId: items[index].productId,
        providerUid: pharmacyUid,
        orderId: orderRef.id,
        movementType: "RESERVATION",
        direction: "HOLD",
        quantity: items[index].quantity,
        lotAllocations: orderLines[index].reservedLots,
        actorUid: user.uid,
        reason: "ORDER_PAYMENT_HOLD",
        createdAt: now,
      }));
      transaction.create(auditRef, {
        actorUid: user.uid,
        action: "pharmacy_order_created",
        resource: `nexaOrders/${orderRef.id}`,
        createdAt: now,
      });
      return { orderId: orderRef.id, orderNumber: `NMC-PH-${orderRef.id.slice(-8).toUpperCase()}`, paymentRef, subtotal, deliveryFee, amount, transactionFee: paymentAmounts.feeAmount, totalAmount: paymentAmounts.totalAmount, transactionFeeRateBps: paymentAmounts.feeRateBps, feeRecipient: paymentAmounts.feeRecipient, currency: "HTG", holdExpiresAt };
    });

    return json(request, { ok: true, ...result });
  } catch (error) { return fail(request, error); }
}
