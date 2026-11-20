import { createHash, randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { normalizeDiagnosticResultRequirements, type DiagnosticProviderType } from "@/lib/diagnostic-results.server";
import { createUserNotification } from "@/lib/notifications.server";
import { buildPrescriptionAvailabilityLines, isDiagnosticAvailabilityMatch, isPrescriptionPastExpiry } from "@/lib/prescription-availability";
import { calculateTransactionAmounts, getTransactionFeePolicy } from "@/lib/payments/transaction-fees.server";

const HOLD_MINUTES = 30;
const PAYMENT_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "diagnostic-order-create-failed";
  const message = error instanceof ApiRequestError ? error.message : "La commande d’examen ne peut pas être préparée pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA diagnostic order creation failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

function requestedOfferIds(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw new ApiRequestError(400, "invalid-diagnostic-order", "Choisissez entre 1 et 10 examens pour une même clinique.");
  const ids = value.map((entry) => clean(entry, 200));
  if (ids.some((id) => !/^[A-Za-z0-9_-]{10,200}$/.test(id)) || new Set(ids).size !== ids.length) throw new ApiRequestError(400, "invalid-diagnostic-offers", "Une offre sélectionnée n’est pas valide ou apparaît plusieurs fois.");
  return ids;
}

function requestedPrescriptionLineIds(value: unknown, offerIds: string[]) {
  if (value === undefined) return {} as Record<string, string>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiRequestError(400, "invalid-prescription-line-links", "Les liens avec l’ordonnance ne sont pas valides.");
  const input = value as Record<string, unknown>;
  const allowedOffers = new Set(offerIds);
  const links = Object.create(null) as Record<string, string>;
  const usedLines = new Set<string>();
  for (const [offerId, rawLineId] of Object.entries(input)) {
    const lineId = clean(rawLineId, 64);
    if (!allowedOffers.has(offerId) || !/^(laboratory|imaging)-[1-9]\d{0,2}$/.test(lineId) || usedLines.has(lineId)) {
      throw new ApiRequestError(400, "invalid-prescription-line-links", "Un examen est lié à une ligne d’ordonnance invalide ou répétée.");
    }
    links[offerId] = lineId;
    usedLines.add(lineId);
  }
  return links;
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "diagnostic-order-create", limit: 8, windowMs: 5 * 60_000 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande de commande n’est pas valide.");
    const input = body as Record<string, unknown>;
    const offerIds = requestedOfferIds(input.offerIds);
    const prescriptionId = clean(input.prescriptionId, 200);
    const prescriptionLineIds = requestedPrescriptionLineIds(input.prescriptionLineIds, offerIds);
    const orderRequestId = clean(input.orderRequestId, 64);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(orderRequestId)) throw new ApiRequestError(400, "invalid-order-request-id", "La référence de la demande est invalide. Rechargez la page et réessayez.");
    if (prescriptionId && !/^[A-Za-z0-9_-]{10,200}$/.test(prescriptionId)) throw new ApiRequestError(400, "invalid-prescription", "La référence d’ordonnance n’est pas valide.");
    if (Object.keys(prescriptionLineIds).length && !prescriptionId) throw new ApiRequestError(400, "prescription-required-for-line-link", "Une ordonnance doit être sélectionnée pour relier un examen à sa ligne prescrite.");

    const db = getFirebaseAdminDb();
    const feePolicy = await getTransactionFeePolicy();
    const patientRef = db.collection("patientProfiles").doc(user.uid);
    const offerRefs = offerIds.map((id) => db.collection("diagnosticOffers").doc(id));
    const prescriptionRef = prescriptionId ? db.collection("clinicalPrescriptions").doc(prescriptionId) : null;
    const orderRef = db.collection("nexaOrders").doc();
    const paymentRef = randomBytes(24).toString("base64url");
    if (!PAYMENT_REFERENCE_PATTERN.test(paymentRef)) throw new ApiRequestError(500, "payment-reference-failed", "La commande ne peut pas être créée.");
    const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
    const fingerprint = createHash("sha256").update(`${offerIds.join("|")}|${prescriptionId}|${JSON.stringify(Object.fromEntries(Object.entries(prescriptionLineIds).sort(([left], [right]) => left.localeCompare(right))))}`).digest("hex");
    const idempotencyRef = db.collection("diagnosticOrderRequests").doc(createHash("sha256").update(`${user.uid}|${orderRequestId}`).digest("hex"));
    const auditRef = db.collection("adminAuditLogs").doc();
    const eventRef = db.collection("nexaOrderEvents").doc();
    const holdExpiresAt = Date.now() + HOLD_MINUTES * 60_000;

    const result = await db.runTransaction(async (transaction) => {
      const snapshots = await Promise.all([
        transaction.get(patientRef),
        ...offerRefs.map((ref) => transaction.get(ref)),
        ...(prescriptionRef ? [transaction.get(prescriptionRef)] : []),
        transaction.get(idempotencyRef),
      ]);
      const patientSnapshot = snapshots[0];
      const offerSnapshots = snapshots.slice(1, 1 + offerRefs.length);
      const prescriptionSnapshot = prescriptionRef ? snapshots[1 + offerRefs.length] : null;
      const idempotencySnapshot = snapshots[snapshots.length - 1];
      if (idempotencySnapshot.exists) {
        if (idempotencySnapshot.get("uid") !== user.uid || idempotencySnapshot.get("fingerprint") !== fingerprint) throw new ApiRequestError(409, "order-request-conflict", "Cette référence a déjà été utilisée pour une autre commande. Rechargez la page avant de réessayer.");
        const priorResponse = idempotencySnapshot.get("response");
        if (!priorResponse || typeof priorResponse !== "object" || Array.isArray(priorResponse)) throw new ApiRequestError(409, "order-request-incomplete", "La demande précédente est en cours de vérification; consultez votre espace patient.");
        return priorResponse as Record<string, unknown>;
      }
      if (!patientSnapshot.exists || patientSnapshot.get("role") !== "patient" || patientSnapshot.get("profileComplete") !== true || typeof patientSnapshot.get("patientNumber") !== "string") {
        throw new ApiRequestError(403, "complete-patient-profile-required", "Terminez votre inscription patient avant de commander un examen.");
      }

      const offers = offerSnapshots.map((snapshot) => {
        if (!snapshot.exists) throw new ApiRequestError(404, "diagnostic-offer-not-found", "Une offre sélectionnée n’est plus disponible.");
        const offer = snapshot.data() || {};
        if (!new Set(["laboratory", "imaging"]).has(String(offer.providerType)) || offer.publicationStatus !== "PUBLISHED" || offer.active !== true || offer.requestedAvailability === false) {
          throw new ApiRequestError(409, "diagnostic-offer-unavailable", "Une offre sélectionnée n’est plus publiée ou disponible.");
        }
        if (offer.appointmentRequired === true) throw new ApiRequestError(409, "appointment-required", "Cette offre exige un rendez-vous. Appelez le centre pour convenir d’une heure avant de commander.");
        return offer;
      });
      const providerType = String(offers[0]?.providerType) as "laboratory" | "imaging";
      const providerUid = String(offers[0]?.providerUid || "");
      if (offers.some((offer) => offer.providerType !== providerType || offer.providerUid !== providerUid)) {
        throw new ApiRequestError(400, "single-diagnostic-provider-required", "Une commande doit regrouper des offres du même centre.");
      }
      const providerRef = db.collection("providerProfiles").doc(providerUid);
      const providerSnapshot = await transaction.get(providerRef);
      if (!providerSnapshot.exists || providerSnapshot.get("type") !== providerType || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true) {
        throw new ApiRequestError(409, "diagnostic-provider-unavailable", "Ce centre n’est plus disponible sur NEXA.");
      }

      const needsPrescription = offers.some((offer) => offer.requiresPrescription === true);
      const prescription = prescriptionSnapshot?.exists ? prescriptionSnapshot.data() || {} : null;
      if (needsPrescription && (!prescription || prescription.patientUid !== user.uid || prescription.status !== "VALIDATED")) {
        throw new ApiRequestError(403, "valid-prescription-required", "Une ordonnance NEXA validée vous appartenant est requise pour les examens sélectionnés.");
      }
      if (prescriptionId && (!prescription || prescription.patientUid !== user.uid || prescription.status !== "VALIDATED")) {
        throw new ApiRequestError(403, "prescription-not-available", "Cette ordonnance NEXA ne peut pas être utilisée.");
      }
      if (prescription && isPrescriptionPastExpiry(prescription)) throw new ApiRequestError(409, "prescription-expired", "Cette ordonnance a expiré et ne peut plus être utilisée.");

      const availablePrescriptionLines = prescription ? buildPrescriptionAvailabilityLines(prescription).filter((line) => line.type === providerType) : [];
      const reservedLines = new Set<string>();
      let subtotal = 0;
      const orderLines: Record<string, unknown>[] = [];
      for (let index = 0; index < offers.length; index += 1) {
        const offer = offers[index];
        const name = clean(offer.name, 180);
        const price = Number(offer.price);
        if (!name || !Number.isSafeInteger(price) || price < 0 || price > 10_000_000) throw new ApiRequestError(409, "diagnostic-offer-invalid", "Le nom ou le prix d’une offre doit être corrigé par le centre.");
        const requestedLineId = prescriptionLineIds[offerSnapshots[index].id];
        let prescriptionLineId: string | undefined;
        if (requestedLineId) {
          const line = availablePrescriptionLines.find((candidate) => candidate.id === requestedLineId);
          if (!line || reservedLines.has(requestedLineId) || line.type !== providerType || !isDiagnosticAvailabilityMatch(line, offer)) {
            throw new ApiRequestError(409, "prescription-line-mismatch", "L’offre ne correspond pas à la ligne d’ordonnance sélectionnée. Actualisez les disponibilités.");
          }
          prescriptionLineId = requestedLineId;
        } else if (offer.requiresPrescription === true) {
          const match = availablePrescriptionLines.find((line) => !reservedLines.has(line.id) && isDiagnosticAvailabilityMatch(line, offer));
          if (!match) throw new ApiRequestError(409, "prescription-exam-mismatch", `L’ordonnance sélectionnée ne contient pas l’examen « ${name} » sous ce nom.`);
          prescriptionLineId = match.id;
        }
        if (prescriptionLineId) reservedLines.add(prescriptionLineId);
        subtotal += price;
        if (!Number.isSafeInteger(subtotal) || subtotal > 10_000_000) throw new ApiRequestError(400, "diagnostic-order-total-invalid", "Le total de la commande dépasse la limite autorisée.");
        orderLines.push({
          offerId: offerSnapshots[index].id,
          name,
          category: clean(offer.category, 120),
          price,
          lineTotal: price,
          specimenType: clean(offer.specimenType, 120),
          preparation: clean(offer.preparation, 1000),
          precautions: clean(offer.precautions, 1000),
          technique: clean(offer.technique, 180),
          resultDelay: clean(offer.resultDelay, 160),
          instructions: clean(offer.instructions, 1200),
          requiresPrescription: offer.requiresPrescription === true,
          ...(prescriptionLineId ? { prescriptionLineId } : {}),
          resultRequirements: normalizeDiagnosticResultRequirements(
            offer.resultRequirements,
            offer.providerType as DiagnosticProviderType,
            409,
          ),
        });
      }

      const profile = providerSnapshot.get("profile") && typeof providerSnapshot.get("profile") === "object" ? providerSnapshot.get("profile") as Record<string, unknown> : {};
      const providerName = clean(profile.name || profile.displayName || providerSnapshot.get("displayName"), 120) || (providerType === "laboratory" ? "Laboratoire NEXA" : "Centre d’imagerie NEXA");
      const now = FieldValue.serverTimestamp();
      const freeOrder = subtotal === 0;
      const paymentAmounts = calculateTransactionAmounts(subtotal, freeOrder ? { active: false, rateBps: 0 } : feePolicy);
      transaction.create(orderRef, {
        kind: providerType,
        workflowVersion: `${providerType}-commerce-v1`,
        patientUid: user.uid,
        patientNumber: patientSnapshot.get("patientNumber"),
        providerUid,
        providerType,
        providerName,
        providerAddress: clean(profile.address, 200),
        providerPhone: clean(profile.publicPhone, 30),
        providerDepartment: clean(profile.department, 80),
        providerCommune: clean(profile.commune, 80),
        items: orderLines,
        ...(prescriptionId ? { prescriptionId } : {}),
        subtotal,
        amount: subtotal,
        transactionFee: paymentAmounts.feeAmount,
        transactionFeeRateBps: paymentAmounts.feeRateBps,
        transactionFeeRecipient: paymentAmounts.feeRecipient,
        totalAmount: paymentAmounts.totalAmount,
        currency: "HTG",
        paymentMethod: freeOrder ? "FREE" : "MONCASH",
        paymentStatus: freeOrder ? "FREE" : "PENDING",
        status: freeOrder ? "PAID" : "PENDING_PAYMENT",
        settlementStatus: freeOrder ? "CONFIRMED" : "PENDING",
        holdExpiresAt: freeOrder ? null : holdExpiresAt,
        ...(freeOrder ? {} : { moncashPaymentRef: paymentRef }),
        createdAt: now,
        updatedAt: now,
      });
      if (!freeOrder) transaction.create(paymentRefDoc, {
        uid: user.uid,
        paymentMethod: "MONCASH",
        resourceType: providerType === "laboratory" ? "laboratory-order" : "imaging-order",
        resourcePath: orderRef.path,
        amount: paymentAmounts.totalAmount,
        serviceAmount: subtotal,
        transactionFee: paymentAmounts.feeAmount,
        transactionFeeRateBps: paymentAmounts.feeRateBps,
        feeRecipient: paymentAmounts.feeRecipient,
        currency: "HTG",
        status: "created",
        createdAt: now,
        updatedAt: now,
      });
      transaction.create(auditRef, { actorUid: user.uid, action: `${providerType}_order_created`, resource: `nexaOrders/${orderRef.id}`, createdAt: now });
      transaction.create(eventRef, { orderId: orderRef.id, fromStatus: null, toStatus: freeOrder ? "PAID" : "PENDING_PAYMENT", action: freeOrder ? "FREE_ORDER_CREATED" : "ORDER_CREATED", actorUid: user.uid, createdAt: now });
      const response = {
        orderId: orderRef.id,
        orderNumber: `NMC-${providerType === "laboratory" ? "LAB" : "IMG"}-${orderRef.id.slice(-8).toUpperCase()}`,
        providerName,
        providerUid,
        amount: subtotal,
        transactionFee: paymentAmounts.feeAmount,
        totalAmount: paymentAmounts.totalAmount,
        transactionFeeRateBps: paymentAmounts.feeRateBps,
        feeRecipient: paymentAmounts.feeRecipient,
        currency: "HTG",
        paymentRequired: !freeOrder,
        ...(freeOrder ? {} : { paymentRef, holdExpiresAt }),
      };
      transaction.create(idempotencyRef, { uid: user.uid, fingerprint, response, orderId: orderRef.id, createdAt: now });
      return response;
    });

    if (result.paymentRequired === false) {
      const tasks = [createUserNotification({ uid: user.uid, eventKey: `diagnostic-order-free:${String(result.orderId)}`, type: "diagnostic_order_confirmed", title: "Commande d’examen confirmée", body: "Votre commande gratuite a été transmise au centre NEXA.", url: "/espace#commandes" })];
      if (typeof result.providerUid === "string") tasks.push(createUserNotification({ uid: result.providerUid, eventKey: `diagnostic-order-free:${String(result.orderId)}`, type: "diagnostic_order_received", title: "Nouvelle commande d’examen", body: "Une commande gratuite a été reçue. Consultez votre espace partenaire.", url: "/professionnels/espace" }));
      await Promise.all(tasks);
    }

    return json(request, { ok: true, ...result });
  } catch (error) { return fail(request, error); }
}
