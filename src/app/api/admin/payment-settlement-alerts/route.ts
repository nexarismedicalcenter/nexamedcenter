import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { createUserNotification } from "@/lib/notifications.server";
import { getNexaRefundLedgerId, type RefundableResourceType } from "@/lib/wallet/nexa-wallet.server";
import { appointmentPaymentMatches, nexaOrderPaymentMatches } from "@/lib/payments/transaction-fees.server";

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "settlement-alerts-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les incidents de paiement ne sont pas accessibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA settlement alert review failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function dateIso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).toISOString();
  return null;
}

export async function GET(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-payment-alert-list", limit: 30, windowMs: 60_000 });
    const snapshot = await getFirebaseAdminDb().collection("paymentSettlementAlerts")
      .where("status", "in", ["open", "in_review"])
      .limit(100)
      .get();
    const db = getFirebaseAdminDb();
    const alerts = await Promise.all(snapshot.docs.map(async (doc) => {
      const resourceType = typeof doc.get("resourceType") === "string" ? doc.get("resourceType") : "unknown";
      const resourceId = typeof doc.get("resourceId") === "string" ? doc.get("resourceId") : "";
      const collection = resourceType === "appointment" ? "appointments" : ["pharmacy-order", "laboratory-order", "imaging-order"].includes(resourceType) ? "nexaOrders" : "";
      const resourceSnapshot = collection && /^[A-Za-z0-9_-]{10,200}$/.test(resourceId)
        ? await db.collection(collection).doc(resourceId).get()
        : null;
      const source = resourceSnapshot?.data() || {};
      return {
        alertId: doc.id,
        resourceType,
        resourceId,
        amount: Number.isSafeInteger(source.amount) && Number(source.amount) > 0 ? Number(source.amount) : 0,
        currency: String(source.currency || "HTG").slice(0, 8),
        transactionFee: Number.isSafeInteger(source.transactionFee) && Number(source.transactionFee) > 0 ? Number(source.transactionFee) : 0,
        reason: typeof doc.get("reason") === "string" ? doc.get("reason") : "UNKNOWN",
        status: typeof doc.get("status") === "string" ? doc.get("status") : "open",
        requestedRefundMethod: typeof doc.get("requestedRefundMethod") === "string" ? doc.get("requestedRefundMethod") : "",
        createdAt: dateIso(doc.get("createdAt")),
        reviewNote: typeof doc.get("reviewNote") === "string" ? doc.get("reviewNote") : "",
      };
    }));
    return json(request, { ok: true, alerts });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-payment-alert-review", limit: 20, windowMs: 60_000 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande de suivi est invalide.");
    const input = body as Record<string, unknown>;
    const alertId = typeof input.alertId === "string" ? input.alertId.trim() : "";
    const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) : "";
    const refundReference = typeof input.refundReference === "string" ? input.refundReference.trim().slice(0, 120) : "";
    const requestedRefundMethod = typeof input.refundMethod === "string" ? input.refundMethod.trim().toUpperCase() : "";
    const resolve = input.resolve === true;
    if (resolve && !["MONCASH_EXTERNAL", "CASH_MANUAL"].includes(requestedRefundMethod)) throw new ApiRequestError(400, "invalid-refund-method", "Choisissez un remboursement MonCash déjà effectué ou des espèces remises manuellement.");
    const refundMethod = requestedRefundMethod as "MONCASH_EXTERNAL" | "CASH_MANUAL";
    if (!/^[A-Za-z0-9_-]{10,128}$/.test(alertId) || !note) throw new ApiRequestError(400, "invalid-review", "L’incident et une note de suivi sont requis.");
    if (resolve && !refundReference) throw new ApiRequestError(400, "refund-reference-required", "Une référence ou un reçu doit être enregistré après le remboursement manuel.");

    const db = getFirebaseAdminDb();
    const alertRef = db.collection("paymentSettlementAlerts").doc(alertId);
    const auditRef = db.collection("adminAuditLogs").doc();
    const outcome = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(alertRef);
      if (!snapshot.exists) throw new ApiRequestError(404, "alert-not-found", "Cet incident n’existe pas.");
      if (snapshot.get("status") === "resolved") {
        if (resolve && snapshot.get("resolutionReference") === refundReference && snapshot.get("refundMethod") === refundMethod) return { userUid: "", amount: 0, notifyPatient: false, refundMethod };
        throw new ApiRequestError(409, "alert-already-resolved", "Cet incident a déjà été clôturé.");
      }
      if (resolve && snapshot.get("requestedRefundMethod") === "CASH_MANUAL" && refundMethod !== "CASH_MANUAL") {
        throw new ApiRequestError(409, "cash-refund-method-mismatch", "Le patient a demandé des espèces. Enregistrez uniquement une remise manuelle en espèces avec son reçu.");
      }
      const resourceType = String(snapshot.get("resourceType") || "");
      const resourceId = String(snapshot.get("resourceId") || "");
      const orderTypes: Record<string, string> = {
        "pharmacy-order": "pharmacy",
        "laboratory-order": "laboratory",
        "imaging-order": "imaging",
      };
      const resourceCollection = resourceType === "appointment" ? "appointments" : orderTypes[resourceType] ? "nexaOrders" : "";
      if (resolve && !resourceCollection) throw new ApiRequestError(409, "refund-resource-unsupported", "Cette ressource ne peut pas être clôturée comme remboursement.");
      if (resolve && !/^[A-Za-z0-9_-]{10,200}$/.test(resourceId)) throw new ApiRequestError(409, "refund-resource-invalid", "La ressource de remboursement n’est pas valide.");
      let resourceRef: FirebaseFirestore.DocumentReference | null = null;
      let resourceSnapshot: FirebaseFirestore.DocumentSnapshot | null = null;
      let refundLedgerRef: FirebaseFirestore.DocumentReference | null = null;
      let refundLedgerSnapshot: FirebaseFirestore.DocumentSnapshot | null = null;
      let relatedAlerts: FirebaseFirestore.QueryDocumentSnapshot[] = [];
      let amount = 0;
      let alreadyRefundedManually = false;
      if (resolve && resourceCollection && /^[A-Za-z0-9_-]{10,200}$/.test(resourceId)) {
        resourceRef = db.collection(resourceCollection).doc(resourceId);
        const resourceAlertsQuery = db.collection("paymentSettlementAlerts").where("resourceId", "==", resourceId).limit(100);
        refundLedgerRef = db.collection("nexaRefundLedger").doc(getNexaRefundLedgerId(resourceType as RefundableResourceType, resourceId));
        const [resourceRead, relatedAlertsRead, refundLedgerRead] = await Promise.all([
          transaction.get(resourceRef),
          transaction.get(resourceAlertsQuery),
          transaction.get(refundLedgerRef),
        ]);
        resourceSnapshot = resourceRead;
        relatedAlerts = relatedAlertsRead.docs.filter((item) => item.get("resourceType") === resourceType);
        refundLedgerSnapshot = refundLedgerRead;
        if (!resourceSnapshot.exists) throw new ApiRequestError(404, "refund-resource-not-found", "La ressource liée à cet incident n’existe plus.");
        const source = resourceSnapshot.data() || {};
        if (refundMethod === "CASH_MANUAL" && source.requestedRefundMethod !== "CASH_MANUAL") {
          throw new ApiRequestError(409, "cash-refund-not-requested", "Le patient n’a pas demandé un remboursement en espèces. Utilisez le crédit du portefeuille NEXA par défaut.");
        }
        amount = Number(source.amount);
        const amountValid = Number.isSafeInteger(amount) && amount > 0 && amount <= 10_000_000;
        if (!amountValid) throw new ApiRequestError(409, "refund-amount-invalid", "Le montant de cette ressource ne peut pas être confirmé.");
        const refundLedger = refundLedgerSnapshot.data() || {};
        const recordedReference = refundMethod === "CASH_MANUAL" ? refundLedger.manualCashRefundReference : refundLedger.externalRefundReference;
        const alreadyRecorded = refundLedgerSnapshot.exists && refundLedger.refundMethod === refundMethod && recordedReference === refundReference && refundLedger.status === "COMPLETED";
        if (refundLedgerSnapshot.exists && !alreadyRecorded) {
          throw new ApiRequestError(409, "refund-already-processed", "Un autre mode de remboursement est déjà enregistré pour cette ressource.");
        }
        const sourceReference = refundMethod === "CASH_MANUAL" ? source.manualCashRefundReference : source.externalRefundReference;
        const alreadyMarked = source.refundMethod === refundMethod && sourceReference === refundReference && source.refundStatus === "COMPLETED";
        if (alreadyRecorded !== alreadyMarked) throw new ApiRequestError(409, "refund-ledger-conflict", "Le registre de remboursement et la ressource ne concordent pas.");
        alreadyRefundedManually = alreadyRecorded;

        const resourceEligible = resourceType === "appointment"
          ? (source.status === "PAYMENT_CONFLICT_REFUND_REQUIRED" && source.refundRequired === true) ||
            (source.bookingType === "home_visit" && source.status === "PROVIDER_NO_SHOW_REFUND_REQUIRED" && source.refundRequired === true && source.homeVisitMissionStatus === "PROVIDER_ABSENT_REFUND_REQUIRED" && source.requestedRefundMethod === "CASH_MANUAL" && source.refundStatus === "PENDING_MANUAL_CASH")
          : source.kind === orderTypes[resourceType] && (source.refundRequired === true || source.settlementStatus === "REVIEW_REQUIRED");
        if (!alreadyRefundedManually && (!resourceEligible || source.paymentStatus !== "PAID" || source.refundMethod === "NEXA_WALLET" || source.refundStatus === "COMPLETED")) {
          throw new ApiRequestError(409, "refund-already-processed", "Cette ressource a déjà été remboursée ou son paiement n’est plus à rapprocher.");
        }

        const paymentRef = typeof source.moncashPaymentRef === "string" ? source.moncashPaymentRef : "";
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(paymentRef)) throw new ApiRequestError(409, "refund-payment-invalid", "La référence de paiement NEXA est absente ou invalide.");
        const paymentSnapshot = await transaction.get(db.collection("paymentIntents").doc(paymentRef));
        const payment = paymentSnapshot.data() || {};
        const amountMatches = resourceType === "appointment" ? appointmentPaymentMatches(source, payment) : nexaOrderPaymentMatches(source, payment);
        const paymentMethodMatches = refundMethod === "MONCASH_EXTERNAL" ? payment.paymentMethod === "MONCASH" : ["MONCASH", "SMART_WALLET"].includes(String(payment.paymentMethod || ""));
        if (!paymentSnapshot.exists || payment.status !== "paid" || !paymentMethodMatches || payment.resourceType !== resourceType || payment.resourcePath !== `${resourceCollection}/${resourceId}` || payment.uid !== source.patientUid || !amountMatches || String(payment.currency || "").toUpperCase() !== "HTG" || String(source.currency || "").toUpperCase() !== "HTG") {
          throw new ApiRequestError(409, "refund-payment-mismatch", "Le paiement NEXA ne correspond pas à cette ressource.");
        }
      }
      const resolutionData = {
        status: resolve ? "resolved" : "in_review",
        reviewNote: note,
        reviewedBy: admin.uid,
        reviewedAt: FieldValue.serverTimestamp(),
        ...(resolve ? {
          resolution: refundMethod === "CASH_MANUAL" ? "manual_cash_refund_confirmed" : "manual_moncash_refund_confirmed",
          resolutionReference: refundReference,
          refundMethod,
          resolvedBy: admin.uid,
          resolvedAt: FieldValue.serverTimestamp(),
        } : {}),
      };
      transaction.set(alertRef, resolutionData, { merge: true });
      if (resolve && resourceRef && resourceSnapshot) {
        const source = resourceSnapshot.data() || {};
        const refundLedgerId = getNexaRefundLedgerId(resourceType as RefundableResourceType, resourceId);
        if (!alreadyRefundedManually && refundLedgerRef) {
          transaction.create(refundLedgerRef, {
            userUid: source.patientUid,
            resourceType,
            resourceId,
            paymentRef: source.moncashPaymentRef,
            amountMinor: amount * 100,
            ...(Number(source.transactionFee) > 0 ? { nonRefundableTransactionFeeMinor: Number(source.transactionFee) * 100 } : {}),
            currency: "HTG",
            refundMethod,
            ...(refundMethod === "CASH_MANUAL" ? { manualCashRefundReference: refundReference } : { externalRefundReference: refundReference }),
            status: "COMPLETED",
            createdAt: FieldValue.serverTimestamp(),
            createdByUid: admin.uid,
          });
          transaction.set(resourceRef, {
            status: "REFUNDED",
            paymentStatus: "REFUNDED",
            refundRequired: false,
            refundStatus: "COMPLETED",
            refundMethod,
            ...(refundMethod === "CASH_MANUAL" ? { manualCashRefundReference: refundReference } : { externalRefundReference: refundReference }),
            refundLedgerId,
            refundedAmount: amount,
            refundedAmountMinor: amount * 100,
            ...(Number(source.transactionFee) > 0 ? { nonRefundableTransactionFee: Number(source.transactionFee) } : {}),
            refundedAt: FieldValue.serverTimestamp(),
            refundedByUid: admin.uid,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }
      }
      if (resolve && relatedAlerts.length) relatedAlerts.forEach((relatedAlert) => transaction.set(relatedAlert.ref, resolutionData, { merge: true }));
      transaction.create(auditRef, {
        actorUid: admin.uid,
        action: resolve ? refundMethod === "CASH_MANUAL" ? "manual_cash_refund_recorded" : "manual_moncash_refund_recorded" : "payment_settlement_alert_reviewed",
        resource: `paymentSettlementAlerts/${alertId}`,
        ...(resolve && resourceRef ? { refundMethod, amountMinor: amount * 100, nonRefundableTransactionFeeMinor: (Number(resourceSnapshot?.get("transactionFee")) || 0) * 100 } : {}),
        createdAt: FieldValue.serverTimestamp(),
      });
      const source = resourceSnapshot?.data() || {};
      return {
        userUid: resolve && typeof source.patientUid === "string" && !alreadyRefundedManually ? source.patientUid : "",
        amount: resolve && resourceRef && !alreadyRefundedManually ? amount : 0,
        notifyPatient: resolve && Boolean(resourceRef) && !alreadyRefundedManually,
        refundMethod,
      };
    });
    if (outcome.notifyPatient && outcome.userUid) await createUserNotification({
      uid: outcome.userUid,
      eventKey: `manual-refund:${alertId}:${refundMethod}:${refundReference}`,
      type: refundMethod === "CASH_MANUAL" ? "manual_cash_refund_recorded" : "external_refund_recorded",
      title: refundMethod === "CASH_MANUAL" ? "Remboursement en espèces enregistré" : "Remboursement MonCash enregistré",
      body: refundMethod === "CASH_MANUAL"
        ? `NEXA a enregistré le remboursement manuel de ${new Intl.NumberFormat("fr-HT").format(outcome.amount)} HTG. Le frais de transaction initial, s’il y en avait un, n’est pas remboursé.`
        : `NEXA a enregistré le remboursement externe de ${new Intl.NumberFormat("fr-HT").format(outcome.amount)} HTG. Le frais de transaction initial, s’il y en avait un, n’est pas remboursé.`,
      url: "/espace",
    });
    return json(request, { ok: true, alertId, status: resolve ? "resolved" : "in_review", ...(resolve ? { refundMethod } : {}) });
  } catch (error) { return fail(request, error); }
}
