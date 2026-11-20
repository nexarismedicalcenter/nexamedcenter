import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { hasActiveConsultationClinicalAccess } from "@/lib/clinical-record/access";
import { listOtherPhysicianClinicalHistory } from "@/lib/clinical-record/history.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "clinical-history-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "L’historique clinique n’est pas accessible pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA clinical history request failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request, { params }: { params: Promise<{ appointmentId: string }> }) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "clinical-history-read", limit: 20, windowMs: 5 * 60_000 });
    const { appointmentId } = await params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) throw new ApiRequestError(400, "invalid-appointment", "La référence de consultation n’est pas valide.");
    const db = getFirebaseAdminDb();
    const [appointmentSnapshot, providerSnapshot] = await Promise.all([
      db.collection("appointments").doc(appointmentId).get(),
      db.collection("providerProfiles").doc(user.uid).get(),
    ]);
    if (!appointmentSnapshot.exists || appointmentSnapshot.get("providerUid") !== user.uid || appointmentSnapshot.get("providerType") !== "doctor") {
      throw new ApiRequestError(403, "consultation-not-authorized", "L’historique est réservé au médecin associé à cette consultation.");
    }
    if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) {
      throw new ApiRequestError(403, "verified-doctor-required", "Un profil médecin NEXA vérifié est requis.");
    }
    const appointment = appointmentSnapshot.data() || {};
    if (appointment.paymentStatus !== "PAID" || !hasActiveConsultationClinicalAccess(appointment)) {
      throw new ApiRequestError(403, "clinical-access-expired", "L’historique est disponible uniquement pendant l’accès clinique actif d’une consultation payée.");
    }
    const patientUid = typeof appointment.patientUid === "string" ? appointment.patientUid : "";
    if (!patientUid) throw new ApiRequestError(409, "patient-required", "Cette consultation n’est pas associée à un profil patient.");
    const cursor = new URL(request.url).searchParams.get("cursor") || undefined;
    let page;
    try {
      page = await listOtherPhysicianClinicalHistory({ db, patientUid, requestingProviderUid: user.uid, excludeRecordId: appointmentId, cursor });
    } catch (error) {
      if (error instanceof Error && error.message === "invalid-cursor") throw new ApiRequestError(400, "invalid-history-cursor", "Le curseur de pagination n’est pas valide pour ce dossier.");
      throw error;
    }
    const currentAppointmentSnapshot = await db.collection("appointments").doc(appointmentId).get();
    const currentAppointment = currentAppointmentSnapshot.data() || {};
    if (!currentAppointmentSnapshot.exists || currentAppointmentSnapshot.get("providerUid") !== user.uid || currentAppointmentSnapshot.get("patientUid") !== patientUid || !hasActiveConsultationClinicalAccess(currentAppointment)) {
      throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation d’accès clinique a expiré.");
    }
    await db.collection("clinicalAuditLogs").doc().create({
      actorUid: user.uid,
      action: "prior_clinical_history_accessed",
      appointmentId,
      recordCount: page.records.length,
      hasMore: Boolean(page.nextCursor),
      createdAt: FieldValue.serverTimestamp(),
    });
    return json(request, { ok: true, ...page });
  } catch (error) { return fail(request, error); }
}
