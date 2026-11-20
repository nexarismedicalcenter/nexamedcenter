import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

type RouteContext = { params: Promise<{ orderId: string }> };

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "diagnostic-prescription-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "L’ordonnance liée à la commande n’est pas accessible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA provider diagnostic prescription failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/\s+/g, " ").trim();
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "diagnostic-order-prescription-read", limit: 20, windowMs: 60_000 });
    const { orderId } = await context.params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(orderId)) throw new ApiRequestError(400, "invalid-diagnostic-order", "La référence de commande n’est pas valide.");
    const db = getFirebaseAdminDb();
    const orderRef = db.collection("nexaOrders").doc(orderId);
    const [providerSnapshot, orderSnapshot] = await Promise.all([
      db.collection("providerProfiles").doc(user.uid).get(), orderRef.get(),
    ]);
    const type = providerSnapshot.get("type");
    if (!providerSnapshot.exists || !["laboratory", "imaging"].includes(String(type)) || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true) {
      throw new ApiRequestError(403, "verified-diagnostic-provider-required", "L’accès est réservé aux laboratoires et centres d’imagerie NEXA vérifiés.");
    }
    if (!orderSnapshot.exists || orderSnapshot.get("providerUid") !== user.uid || orderSnapshot.get("kind") !== type) throw new ApiRequestError(404, "diagnostic-order-not-found", "Cette commande n’est pas accessible à votre centre.");
    const order = orderSnapshot.data() || {};
    const allowedStatuses = new Set(["PAID", "ACCEPTED", "PATIENT_PRESENTED", "SAMPLE_COLLECTED", "SAMPLE_RECEIVED", "ANALYSIS_IN_PROGRESS", "EXAM_IN_PROGRESS", "EXAM_COMPLETED", "COMPLETED"]);
    if (order.paymentStatus !== "PAID" && order.paymentStatus !== "FREE" || (order.paymentStatus === "PAID" && order.settlementStatus !== "CONFIRMED") || !allowedStatuses.has(String(order.status))) {
      throw new ApiRequestError(409, "diagnostic-order-not-authorized", "L’ordonnance n’est accessible que pour une commande confirmée en cours de traitement.");
    }
    const prescriptionId = typeof order.prescriptionId === "string" ? order.prescriptionId : "";
    if (!prescriptionId) throw new ApiRequestError(404, "prescription-not-attached", "Aucune ordonnance n’est liée à cette commande.");
    const prescriptionRef = db.collection("clinicalPrescriptions").doc(prescriptionId);
    const prescriptionSnapshot = await prescriptionRef.get();
    if (!prescriptionSnapshot.exists || prescriptionSnapshot.get("patientUid") !== order.patientUid || prescriptionSnapshot.get("status") !== "VALIDATED") throw new ApiRequestError(409, "prescription-no-longer-valid", "L’ordonnance associée n’est plus valide.");
    const prescription = prescriptionSnapshot.data() || {};
    const field = type === "laboratory" ? "labExams" : "imagingExams";
    const prescribed = Array.isArray(prescription[field]) ? (prescription[field] as unknown[]).filter((value): value is string => typeof value === "string") : [];
    const orderNames = Array.isArray(order.items) ? (order.items as Record<string, unknown>[]).map((item) => typeof item.name === "string" ? item.name : "") : [];
    const selectedExams = prescribed.filter((line) => orderNames.some((name) => normalize(name) === normalize(line)));
    if (!selectedExams.length || selectedExams.length !== new Set(orderNames.map(normalize)).size) throw new ApiRequestError(409, "prescription-order-mismatch", "Les examens de la commande ne correspondent plus à l’ordonnance.");
    await db.collection("clinicalAuditLogs").doc().set({
      actorUid: user.uid,
      patientUid: order.patientUid,
      orderId,
      action: "diagnostic_prescription_viewed",
      resource: `clinicalPrescriptions/${prescriptionId}`,
      providerType: type,
      createdAt: FieldValue.serverTimestamp(),
    });
    return json(request, {
      ok: true,
      prescription: {
        providerName: prescription.providerName || "Professionnel NEXA",
        specialtyName: prescription.specialtyName || "",
        version: Number(prescription.version) || 1,
        validatedAt: prescription.validatedAt && typeof prescription.validatedAt === "object" && "toDate" in prescription.validatedAt && typeof prescription.validatedAt.toDate === "function" ? (prescription.validatedAt.toDate() as Date).toISOString() : null,
        exams: selectedExams,
      },
    });
  } catch (error) { return fail(request, error); }
}
