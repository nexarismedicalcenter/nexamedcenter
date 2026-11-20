import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "pharmacy-prescription-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "L’ordonnance liée à cette commande n’est pas accessible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA pharmacy prescription access failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function iso(value: unknown): string | null {
  return value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function" ? (value.toDate() as Date).toISOString() : null;
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "pharmacy-prescription-access", limit: 30, windowMs: 5 * 60_000 });
    const { orderId } = await params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(orderId)) throw new ApiRequestError(400, "invalid-order", "La référence de commande n’est pas valide.");
    const db = getFirebaseAdminDb();
    const providerRef = db.collection("providerProfiles").doc(user.uid);
    const orderRef = db.collection("nexaOrders").doc(orderId);
    const [providerSnapshot, orderSnapshot] = await Promise.all([providerRef.get(), orderRef.get()]);
    if (!providerSnapshot.exists || providerSnapshot.get("type") !== "pharmacy" || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true) throw new ApiRequestError(403, "verified-pharmacy-required", "Cet accès est réservé à une pharmacie vérifiée.");
    if (!orderSnapshot.exists || orderSnapshot.get("kind") !== "pharmacy" || orderSnapshot.get("providerUid") !== user.uid || orderSnapshot.get("paymentStatus") !== "PAID" || !new Set(["PAID", "ACCEPTED", "PREPARING", "READY", "DELIVERING", "DELIVERED", "COMPLETED"]).has(String(orderSnapshot.get("status")))) throw new ApiRequestError(404, "pharmacy-order-not-found", "Cette commande payée n’est pas accessible à votre pharmacie.");
    const prescriptionId = typeof orderSnapshot.get("prescriptionId") === "string" ? orderSnapshot.get("prescriptionId") as string : "";
    if (!prescriptionId) throw new ApiRequestError(404, "prescription-not-linked", "Aucune ordonnance n’est associée à cette commande.");
    const prescriptionRef = db.collection("clinicalPrescriptions").doc(prescriptionId);
    const prescriptionSnapshot = await prescriptionRef.get();
    if (!prescriptionSnapshot.exists || prescriptionSnapshot.get("patientUid") !== orderSnapshot.get("patientUid") || prescriptionSnapshot.get("status") !== "VALIDATED") throw new ApiRequestError(409, "prescription-no-longer-valid", "L’ordonnance liée à cette commande n’est pas valide.");
    await db.collection("clinicalAuditLogs").add({
      actorUid: user.uid,
      action: "pharmacy_accessed_prescription_for_paid_order",
      appointmentId: prescriptionSnapshot.get("appointmentId") || null,
      prescriptionId,
      orderId,
      createdAt: FieldValue.serverTimestamp(),
    });
    return json(request, { ok: true, prescription: {
      id: prescriptionId,
      providerName: prescriptionSnapshot.get("providerName") || "Médecin NEXA",
      specialtyName: prescriptionSnapshot.get("specialtyName") || "",
      medications: Array.isArray(prescriptionSnapshot.get("medications")) ? prescriptionSnapshot.get("medications") : [],
      validatedAt: iso(prescriptionSnapshot.get("validatedAt")),
    } });
  } catch (error) { return fail(request, error); }
}
