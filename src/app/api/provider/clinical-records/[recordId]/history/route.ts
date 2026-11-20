import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { hasActiveStandaloneClinicalAccess } from "@/lib/clinical-record/access";
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
  if (!(error instanceof ApiRequestError)) console.error("NEXA standalone clinical history request failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request, { params }: { params: Promise<{ recordId: string }> }) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "clinical-history-read", limit: 20, windowMs: 5 * 60_000 });
    const { recordId } = await params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(recordId)) throw new ApiRequestError(400, "invalid-record", "La référence du dossier n’est pas valide.");
    const db = getFirebaseAdminDb();
    const [recordSnapshot, providerSnapshot] = await Promise.all([
      db.collection("electronicPatientRecords").doc(recordId).get(),
      db.collection("providerProfiles").doc(user.uid).get(),
    ]);
    if (!recordSnapshot.exists || recordSnapshot.get("recordType") !== "STANDALONE" || recordSnapshot.get("providerUid") !== user.uid) {
      throw new ApiRequestError(404, "clinical-record-not-found", "Ce dossier clinique autonome n’est pas accessible.");
    }
    if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) {
      throw new ApiRequestError(403, "verified-doctor-required", "Un profil médecin NEXA vérifié est requis.");
    }
    const record = recordSnapshot.data() || {};
    if (!hasActiveStandaloneClinicalAccess(record)) throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation patient est expirée ou révoquée.");
    const patientUid = typeof record.patientUid === "string" ? record.patientUid : "";
    if (!patientUid) throw new ApiRequestError(409, "patient-required", "Ce dossier n’est pas associé à un profil patient.");
    const cursor = new URL(request.url).searchParams.get("cursor") || undefined;
    let page;
    try {
      page = await listOtherPhysicianClinicalHistory({ db, patientUid, requestingProviderUid: user.uid, excludeRecordId: recordId, cursor });
    } catch (error) {
      if (error instanceof Error && error.message === "invalid-cursor") throw new ApiRequestError(400, "invalid-history-cursor", "Le curseur de pagination n’est pas valide pour ce dossier.");
      throw error;
    }
    const currentRecord = await db.collection("electronicPatientRecords").doc(recordId).get();
    if (!currentRecord.exists || currentRecord.get("patientUid") !== patientUid || !hasActiveStandaloneClinicalAccess(currentRecord.data() || {})) {
      throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation patient est expirée ou révoquée.");
    }
    await db.collection("clinicalAuditLogs").doc().create({
      actorUid: user.uid,
      action: "prior_clinical_history_accessed",
      recordId,
      recordCount: page.records.length,
      hasMore: Boolean(page.nextCursor),
      createdAt: FieldValue.serverTimestamp(),
    });
    return json(request, { ok: true, ...page });
  } catch (error) { return fail(request, error); }
}
