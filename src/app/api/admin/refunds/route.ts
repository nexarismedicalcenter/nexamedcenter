import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { creditNexaWalletForRefund, type RefundableResourceType } from "@/lib/wallet/nexa-wallet.server";

const REFUNDABLE_TYPES = new Set<RefundableResourceType>([
  "appointment", "pharmacy-order", "laboratory-order", "imaging-order",
]);

function isRefundableType(value: string): value is RefundableResourceType {
  return REFUNDABLE_TYPES.has(value as RefundableResourceType);
}

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "admin-refunds-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les remboursements NEXA ne sont pas accessibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA admin refunds failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* no CORS for disallowed origins */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function iso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).toISOString();
  return typeof value === "string" ? value : null;
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-pending-refunds", limit: 30, windowMs: 60_000 });
    const db = getFirebaseAdminDb();
    const [appointments, orders] = await Promise.all([
      db.collection("appointments").where("refundRequired", "==", true).limit(100).get(),
      db.collection("nexaOrders").where("refundRequired", "==", true).limit(100).get(),
    ]);
    const refunds = [
      ...appointments.docs.flatMap((doc) => {
        const data = doc.data();
        if (data.status !== "PAYMENT_CONFLICT_REFUND_REQUIRED" || data.paymentStatus !== "PAID" || data.requestedRefundMethod === "CASH_MANUAL" || ![undefined, "PENDING_REVIEW", "MANUAL_REVIEW_REQUIRED"].includes(data.refundStatus)) return [];
        return [{
          resourceType: "appointment" as const,
          resourceId: doc.id,
          patientUid: typeof data.patientUid === "string" ? data.patientUid.slice(0, 128) : "",
          providerName: typeof data.providerName === "string" ? data.providerName.slice(0, 120) : "Professionnel NEXA",
          amount: Number.isSafeInteger(data.amount) && Number(data.amount) > 0 ? Number(data.amount) : 0,
          currency: String(data.currency || "HTG").slice(0, 8),
          reason: typeof data.cancellationReason === "string" ? data.cancellationReason.slice(0, 48) : "REFUND_REVIEW_REQUIRED",
          createdAt: iso(data.updatedAt || data.createdAt),
        }];
      }),
      ...orders.docs.flatMap((doc) => {
        const data = doc.data();
        const resourceType = data.kind === "pharmacy" ? "pharmacy-order" : data.kind === "laboratory" ? "laboratory-order" : data.kind === "imaging" ? "imaging-order" : "";
        if (!resourceType || data.status !== "PROVIDER_REFUSED" || data.paymentStatus !== "PAID" || data.settlementStatus !== "CONFIRMED" || data.requestedRefundMethod === "CASH_MANUAL" || ![undefined, "PENDING_REVIEW"].includes(data.refundStatus)) return [];
        return [{
          resourceType: resourceType as RefundableResourceType,
          resourceId: doc.id,
          patientUid: typeof data.patientUid === "string" ? data.patientUid.slice(0, 128) : "",
          providerName: typeof data.providerName === "string" ? data.providerName.slice(0, 120) : "Partenaire NEXA",
          amount: Number.isSafeInteger(data.amount) && Number(data.amount) > 0 ? Number(data.amount) : 0,
          currency: String(data.currency || "HTG").slice(0, 8),
          reason: typeof data.refusalReason === "string" ? data.refusalReason.slice(0, 160) : "PROVIDER_REFUSED",
          createdAt: iso(data.updatedAt || data.createdAt),
        }];
      }),
    ].filter((item) => item.patientUid && item.amount > 0 && item.currency.toUpperCase() === "HTG")
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    await db.collection("adminAuditLogs").doc().create({
      actorUid: admin.uid,
      action: "admin_pending_wallet_refunds_listed",
      resultCount: refunds.length,
      createdAt: FieldValue.serverTimestamp(),
    });
    return json(request, { ok: true, refunds });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-wallet-refund-credit", limit: 20, windowMs: 60_000 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-refund-request", "La demande de remboursement n’est pas valide.");
    const input = body as Record<string, unknown>;
    const rawResourceType = typeof input.resourceType === "string" ? input.resourceType.trim() : "";
    const resourceId = typeof input.resourceId === "string" ? input.resourceId.trim() : "";
    const confirmNoExternalRefund = input.confirmNoExternalRefund === true;
    if (!isRefundableType(rawResourceType)) throw new ApiRequestError(400, "invalid-refund-type", "Le type de remboursement n’est pas pris en charge.");
    const resourceType = rawResourceType;

    const result = await creditNexaWalletForRefund({ resourceType, resourceId, actor: { kind: "ADMIN", adminUid: admin.uid, confirmNoExternalRefund } });
    return json(request, {
      ok: true,
      amount: result.amount,
      currency: result.currency,
      ledgerId: result.ledgerId,
      refundLedgerId: result.refundLedgerId,
      alreadyProcessed: result.alreadyProcessed,
    });
  } catch (error) { return fail(request, error); }
}
