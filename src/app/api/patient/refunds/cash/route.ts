import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { appointmentPaymentMatches, nexaOrderPaymentMatches } from "@/lib/payments/transaction-fees.server";
import { getNexaRefundLedgerId, type RefundableResourceType } from "@/lib/wallet/nexa-wallet.server";

const ORDER_TYPES: Record<string, string> = {
  "pharmacy-order": "pharmacy",
  "laboratory-order": "laboratory",
  "imaging-order": "imaging",
};

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "cash-refund-request-failed";
  const message = error instanceof ApiRequestError ? error.message : "La demande de remboursement en espèces n’a pas pu être enregistrée.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA cash refund request failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "request-cash-refund", limit: 6, windowMs: 10 * 60_000 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-refund-request", "La demande de remboursement n’est pas valide.");
    const input = body as Record<string, unknown>;
    const resourceType = typeof input.resourceType === "string" ? input.resourceType.trim() : "";
    const resourceId = typeof input.resourceId === "string" ? input.resourceId.trim() : "";
    if (!(resourceType === "appointment" || Object.hasOwn(ORDER_TYPES, resourceType)) || !/^[A-Za-z0-9_-]{10,200}$/.test(resourceId)) {
      throw new ApiRequestError(400, "invalid-refund-resource", "La référence du remboursement n’est pas valide.");
    }

    const type = resourceType as RefundableResourceType;
    const db = getFirebaseAdminDb();
    const collection = type === "appointment" ? "appointments" : "nexaOrders";
    const resourceRef = db.collection(collection).doc(resourceId);
    const resourceAlertsQuery = db.collection("paymentSettlementAlerts").where("resourceId", "==", resourceId).limit(100);
    const refundLedgerRef = db.collection("nexaRefundLedger").doc(getNexaRefundLedgerId(type, resourceId));
    const auditRef = db.collection("adminAuditLogs").doc();
    const outcome = await db.runTransaction(async (transaction) => {
      const [resourceSnapshot, alertsSnapshot, refundLedgerSnapshot] = await Promise.all([
        transaction.get(resourceRef), transaction.get(resourceAlertsQuery), transaction.get(refundLedgerRef),
      ]);
      if (!resourceSnapshot.exists || resourceSnapshot.get("patientUid") !== user.uid) throw new ApiRequestError(404, "refund-resource-not-found", "Cette demande de remboursement n’est pas accessible.");
      if (refundLedgerSnapshot.exists || ["COMPLETED", "REFUNDED"].includes(String(resourceSnapshot.get("refundStatus") || "").toUpperCase())) {
        throw new ApiRequestError(409, "refund-already-processed", "Un remboursement a déjà été enregistré pour cette ressource.");
      }

      const resource = resourceSnapshot.data() || {};
      const amount = Number(resource.amount);
      const expectedKind = ORDER_TYPES[type];
      const eligible = type === "appointment"
        ? resource.status === "PAYMENT_CONFLICT_REFUND_REQUIRED" && resource.refundRequired === true
        : resource.kind === expectedKind && resource.status === "PROVIDER_REFUSED" && resource.paymentStatus === "PAID" && resource.settlementStatus === "CONFIRMED" && resource.refundRequired === true;
      if (!eligible || resource.paymentStatus !== "PAID" || resource.refundMethod === "NEXA_WALLET" || !Number.isSafeInteger(amount) || amount <= 0 || amount > 10_000_000 || String(resource.currency || "").toUpperCase() !== "HTG") {
        throw new ApiRequestError(409, "refund-not-eligible", "Cette ressource n’est pas encore admissible à une demande de remboursement en espèces.");
      }

      const paymentRef = typeof resource.moncashPaymentRef === "string" ? resource.moncashPaymentRef : "";
      if (!/^[A-Za-z0-9_-]{20,64}$/.test(paymentRef)) throw new ApiRequestError(409, "refund-payment-invalid", "Le paiement lié à cette ressource ne peut pas être vérifié.");
      const paymentSnapshot = await transaction.get(db.collection("paymentIntents").doc(paymentRef));
      const payment = paymentSnapshot.data() || {};
      const amountMatches = type === "appointment" ? appointmentPaymentMatches(resource, payment) : nexaOrderPaymentMatches(resource, payment);
      if (!paymentSnapshot.exists || payment.status !== "paid" || !["MONCASH", "SMART_WALLET"].includes(String(payment.paymentMethod || "")) || payment.resourceType !== type || payment.resourcePath !== `${collection}/${resourceId}` || payment.uid !== user.uid || !amountMatches || String(payment.currency || "").toUpperCase() !== "HTG") {
        throw new ApiRequestError(409, "refund-payment-mismatch", "Le paiement ne correspond pas à cette ressource.");
      }

      const relatedAlerts = alertsSnapshot.docs.filter((alert) => alert.get("resourceType") === type);
      const activeAlerts = relatedAlerts.filter((alert) => ["open", "in_review"].includes(String(alert.get("status") || "")));
      const alertRef = activeAlerts[0]?.ref || db.collection("paymentSettlementAlerts").doc(`patient_cash_refund_${type.replaceAll("-", "_")}_${resourceId}`);
      const now = FieldValue.serverTimestamp();
      transaction.set(resourceRef, {
        requestedRefundMethod: "CASH_MANUAL",
        refundRequestStatus: "REQUESTED",
        refundRequestedAt: now,
        updatedAt: now,
      }, { merge: true });
      if (activeAlerts.length) {
        for (const alert of activeAlerts) transaction.set(alert.ref, {
          requestedRefundMethod: "CASH_MANUAL",
          refundRequestedByUid: user.uid,
          refundRequestedAt: now,
        }, { merge: true });
      } else {
        transaction.create(alertRef, {
          paymentRef,
          resourceType: type,
          resourceId,
          reason: "PATIENT_REQUESTED_CASH_REFUND",
          requestedRefundMethod: "CASH_MANUAL",
          refundRequestedByUid: user.uid,
          refundRequestedAt: now,
          status: "open",
          createdAt: now,
        });
      }
      transaction.create(auditRef, {
        actorUid: user.uid,
        action: "patient_cash_refund_requested",
        resource: `${collection}/${resourceId}`,
        refundMethod: "CASH_MANUAL",
        amountMinor: amount * 100,
        currency: "HTG",
        createdAt: now,
      });
      return { alreadyRequested: resource.requestedRefundMethod === "CASH_MANUAL" && resource.refundRequestStatus === "REQUESTED" };
    });
    return json(request, { ok: true, requestedRefundMethod: "CASH_MANUAL", status: "REQUESTED", alreadyRequested: outcome.alreadyRequested });
  } catch (error) { return fail(request, error); }
}
