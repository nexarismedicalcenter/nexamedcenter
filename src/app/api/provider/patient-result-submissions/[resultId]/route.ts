import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { listOtherPhysicianClinicalHistory } from "@/lib/clinical-record/history.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { cleanPatientResultText, getPatientAge, isoPatientResultDate } from "@/lib/patient-result-submissions.server";

type RouteContext = { params: Promise<{ resultId: string }> };

function json(request: Request, body: Record<string, unknown>) {
  const headers = corsHeaders(request); headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "provider-patient-result-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le dossier associé à ce résultat n’est pas accessible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA provider patient result detail failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function projectMedicalProfile(value: Record<string, unknown> | undefined) {
  if (!value) return null;
  const yesNo = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return { yes: false, details: "" };
    const item = input as Record<string, unknown>;
    return { yes: item.yes === true, details: item.yes === true ? cleanPatientResultText(item.details, 500) : "" };
  };
  const condition = (input: unknown) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return { diagnosed: false, sinceMonth: "" };
    const item = input as Record<string, unknown>;
    return { diagnosed: item.diagnosed === true, sinceMonth: item.diagnosed === true ? cleanPatientResultText(item.sinceMonth, 7) : "" };
  };
  const allowedLanguages = new Set(["creole", "french", "english", "spanish"]);
  return {
    languages: Array.isArray(value.languages) ? value.languages.filter((entry) => typeof entry === "string" && allowedLanguages.has(entry)) : [],
    allergies: yesNo(value.allergies), diabetes: condition(value.diabetes), hypertension: condition(value.hypertension),
    tobacco: yesNo(value.tobacco), alcohol: yesNo(value.alcohol), coffee: yesNo(value.coffee), tea: yesNo(value.tea),
  };
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireFirebaseUser(request); await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "provider-patient-result-detail", limit: 20, windowMs: 5 * 60_000 });
    const { resultId } = await context.params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(resultId)) throw new ApiRequestError(400, "invalid-result-id", "La référence du résultat n’est pas valide.");
    const db = getFirebaseAdminDb();
    const [provider, resultSnapshot, grantSnapshot] = await Promise.all([
      db.collection("providerProfiles").doc(user.uid).get(),
      db.collection("patientSubmittedResults").doc(resultId).get(),
      db.collection("patientResultFollowUpGrants").doc(resultId).get(),
    ]);
    if (!provider.exists || provider.get("type") !== "doctor" || provider.get("status") !== "verified" || provider.get("clinicalCredentialsVerified") !== true) throw new ApiRequestError(403, "verified-doctor-required", "Cette action est réservée au médecin NEXA vérifié.");
    if (!resultSnapshot.exists || resultSnapshot.get("providerUid") !== user.uid || resultSnapshot.get("status") !== "AVAILABLE_TO_PRESCRIBER" || !grantSnapshot.exists || grantSnapshot.get("providerUid") !== user.uid || grantSnapshot.get("patientUid") !== resultSnapshot.get("patientUid") || grantSnapshot.get("status") !== "OPEN") throw new ApiRequestError(404, "patient-result-not-found", "Ce dossier n’est pas accessible.");
    const patientUid = String(resultSnapshot.get("patientUid") || "");
    const [patient, medicalProfile] = await Promise.all([
      db.collection("patientProfiles").doc(patientUid).get(),
      db.collection("patientMedicalProfiles").doc(patientUid).get(),
    ]);
    if (!patient.exists || patient.get("role") !== "patient") throw new ApiRequestError(404, "patient-not-found", "Le profil associé à ce résultat n’est pas disponible.");
    const patientData = patient.data() || {};
    const identity = {
      name: cleanPatientResultText(patientData.displayName || `${patientData.firstName || ""} ${patientData.lastName || ""}`.trim(), 140) || "Patient NEXA",
      patientNumber: cleanPatientResultText(patientData.patientNumber, 32),
      sex: cleanPatientResultText(patientData.sex, 32) || "Non communiqué",
      age: getPatientAge(patientData.birthDate),
    };
    const history = await listOtherPhysicianClinicalHistory({ db, patientUid, requestingProviderUid: user.uid, excludeRecordId: "" });
    const followUpActionsSnapshot = await db.collection("patientSubmittedResults").doc(resultId).collection("followUpActions").orderBy("createdAt", "desc").limit(20).get();
    const followUpActions = followUpActionsSnapshot.docs.map((doc) => {
      const action = doc.data();
      return { id: doc.id, type: cleanPatientResultText(action.type, 30), content: cleanPatientResultText(action.content, 5_000), recordId: cleanPatientResultText(action.recordId, 200), recordNumber: cleanPatientResultText(action.recordNumber, 100), createdAt: isoPatientResultDate(action.createdAt), providerName: cleanPatientResultText(action.providerName, 180) };
    });
    const freshGrant = await db.collection("patientResultFollowUpGrants").doc(resultId).get();
    const freshResult = await db.collection("patientSubmittedResults").doc(resultId).get();
    const freshProvider = await db.collection("providerProfiles").doc(user.uid).get();
    if (!freshGrant.exists || freshGrant.get("status") !== "OPEN" || freshGrant.get("providerUid") !== user.uid || !freshResult.exists || freshResult.get("status") !== "AVAILABLE_TO_PRESCRIBER" || freshResult.get("providerUid") !== user.uid || freshResult.get("patientUid") !== patientUid || !freshProvider.exists || freshProvider.get("status") !== "verified" || freshProvider.get("clinicalCredentialsVerified") !== true) throw new ApiRequestError(403, "follow-up-access-closed", "L’accès de suivi a été fermé ou n’est plus autorisé.");
    await db.collection("patientResultAuditLogs").doc().create({ actorUid: user.uid, action: "prescriber_patient_result_dossier_opened", resultId, historyRecordCount: history.records.length, createdAt: FieldValue.serverTimestamp() });
    return json(request, {
      ok: true,
      result: { id: resultId, examName: cleanPatientResultText(resultSnapshot.get("examName"), 250), examType: cleanPatientResultText(resultSnapshot.get("examType"), 20), createdAt: isoPatientResultDate(resultSnapshot.get("createdAt")) },
      patient: identity,
      medicalProfile: projectMedicalProfile(medicalProfile.exists ? medicalProfile.data() : undefined),
      history,
      followUpActions,
      allowedActions: ["note", "prescription", "appointment", "close"],
    });
  } catch (error) { return fail(request, error); }
}
