import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

function json(request: Request, payload: Record<string, unknown>) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "patient-orders-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Vos commandes ne sont pas accessibles pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA patient orders failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
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
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    const db = getFirebaseAdminDb();
    const profile = await db.collection("patientProfiles").doc(user.uid).get();
    if (!profile.exists || profile.get("role") !== "patient" || profile.get("profileComplete") !== true) throw new ApiRequestError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
    const snapshot = await db.collection("nexaOrders").where("patientUid", "==", user.uid).orderBy("createdAt", "desc").limit(100).get();
    const orders = snapshot.docs.filter((doc) => ["pharmacy", "laboratory", "imaging"].includes(String(doc.get("kind")))).map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        kind: data.kind,
        orderNumber: typeof data.orderNumber === "string" ? data.orderNumber : `NMC-${data.kind === "laboratory" ? "LAB" : data.kind === "imaging" ? "IMG" : "PH"}-${doc.id.slice(-8).toUpperCase()}`,
        providerName: data.providerName || (data.kind === "laboratory" ? "Laboratoire NEXA" : data.kind === "imaging" ? "Centre d’imagerie NEXA" : "Pharmacie NEXA"),
        items: Array.isArray(data.items) ? data.items : [],
        subtotal: Number(data.subtotal) || 0,
        deliveryFee: Number(data.deliveryFee) || 0,
        amount: Number(data.amount) || 0,
        transactionFee: Number(data.transactionFee) || 0,
        totalAmount: Number.isSafeInteger(data.totalAmount) ? Number(data.totalAmount) : (Number(data.amount) || 0) + (Number(data.transactionFee) || 0),
        transactionFeeRateBps: Number(data.transactionFeeRateBps) || 0,
        transactionFeeRecipient: data.transactionFeeRecipient || "NEXARIS",
        currency: data.currency || "HTG",
        deliveryMethod: data.deliveryMethod || "pickup",
        deliveryAddress: data.kind === "pharmacy" && data.deliveryAddress && typeof data.deliveryAddress === "object" ? (() => {
          const address = data.deliveryAddress as Record<string, unknown>;
          return { recipientName: String(address.recipientName || ""), phone: String(address.phone || ""), department: String(address.department || ""), commune: String(address.commune || ""), addressLine: String(address.addressLine || ""), instructions: String(address.instructions || "") };
        })() : null,
        paymentStatus: data.paymentStatus || "PENDING",
        refundMethod: typeof data.refundMethod === "string" ? data.refundMethod : null,
        requestedRefundMethod: typeof data.requestedRefundMethod === "string" ? data.requestedRefundMethod : null,
        refundRequired: data.refundRequired === true,
        refundedAmount: Number.isSafeInteger(data.refundedAmount) ? Number(data.refundedAmount) : null,
        settlementStatus: data.settlementStatus || "PENDING",
        status: data.status || "UNKNOWN",
        createdAt: iso(data.createdAt),
        holdExpiresAt: Number(data.holdExpiresAt) || null,
        paymentRef: typeof data.moncashPaymentRef === "string" ? data.moncashPaymentRef : null,
      };
    });
    return json(request, { ok: true, orders });
  } catch (error) { return fail(request, error); }
}
