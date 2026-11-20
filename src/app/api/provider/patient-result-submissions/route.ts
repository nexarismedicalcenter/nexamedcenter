import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { cleanPatientResultText, getPatientAge, isoPatientResultDate } from "@/lib/patient-result-submissions.server";

function json(request: Request, body: Record<string, unknown>) {
  const headers = corsHeaders(request); headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "provider-result-submissions-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les résultats transmis par vos patients ne sont pas accessibles pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA provider patient results failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

async function requireDoctor(uid: string) {
  const provider = await getFirebaseAdminDb().collection("providerProfiles").doc(uid).get();
  if (!provider.exists || provider.get("type") !== "doctor" || provider.get("status") !== "verified" || provider.get("clinicalCredentialsVerified") !== true) {
    throw new ApiRequestError(403, "verified-doctor-required", "La boîte des résultats patients est réservée aux médecins NEXA vérifiés.");
  }
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const user = await requireFirebaseUser(request); await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "provider-patient-result-list", limit: 30, windowMs: 5 * 60_000 });
    await requireDoctor(user.uid);
    const db = getFirebaseAdminDb();
    const snapshot = await db.collection("patientSubmittedResults")
      .where("providerUid", "==", user.uid)
      .where("status", "==", "AVAILABLE_TO_PRESCRIBER")
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();
    const profiles = await Promise.all(snapshot.docs.map((doc) => db.collection("patientProfiles").doc(String(doc.get("patientUid") || "")).get()));
    const results = snapshot.docs.flatMap((doc, index) => {
      const data = doc.data();
      const profile = profiles[index];
      if (!profile.exists || profile.get("role") !== "patient") return [];
      const profileData = profile.data() || {};
      const patientName = cleanPatientResultText(profileData.displayName || `${profileData.firstName || ""} ${profileData.lastName || ""}`.trim(), 140);
      const files = Array.isArray(data.files) ? data.files.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const file = entry as Record<string, unknown>;
        if (file.antivirusStatus !== "CLEAN" || !/^[A-Za-z0-9_-]{10,80}$/.test(String(file.id || ""))) return [];
        return [{ id: String(file.id), category: cleanPatientResultText(file.category, 40), fileName: cleanPatientResultText(file.fileName, 180), contentType: cleanPatientResultText(file.contentType, 100), size: Number(file.size) || 0 }];
      }) : [];
      return [{
        id: doc.id,
        examName: cleanPatientResultText(data.examName, 250) || "Résultat médical",
        examType: cleanPatientResultText(data.examType, 20),
        patient: {
          name: patientName || "Patient NEXA",
          patientNumber: cleanPatientResultText(profileData.patientNumber, 32),
          sex: cleanPatientResultText(profileData.sex, 32) || "Non communiqué",
          age: getPatientAge(profileData.birthDate),
        },
        createdAt: isoPatientResultDate(data.createdAt),
        files,
      }];
    });
    if (results.length) {
      const batch = db.batch();
      for (const result of results) batch.create(db.collection("patientResultAuditLogs").doc(), { actorUid: user.uid, action: "prescriber_patient_results_listed", resultId: result.id, createdAt: FieldValue.serverTimestamp() });
      await batch.commit();
    }
    return json(request, { ok: true, results });
  } catch (error) { return fail(request, error); }
}
