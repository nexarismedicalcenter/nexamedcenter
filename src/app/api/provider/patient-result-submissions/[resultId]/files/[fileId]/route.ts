import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb, getFirebaseAdminStorage } from "@/lib/firebase/admin";
import { cleanPatientResultText } from "@/lib/patient-result-submissions.server";

type RouteContext = { params: Promise<{ resultId: string; fileId: string }> };

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "provider-patient-result-file-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Ce résultat ne peut pas être ouvert pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA provider patient result file failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireFirebaseUser(request); await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "provider-patient-result-file", limit: 20, windowMs: 60_000 });
    const { resultId, fileId } = await context.params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(resultId) || !/^[A-Za-z0-9_-]{10,100}$/.test(fileId)) throw new ApiRequestError(400, "invalid-result-file", "La référence du fichier n’est pas valide.");
    const db = getFirebaseAdminDb();
    const [provider, resultSnapshot, grantSnapshot] = await Promise.all([
      db.collection("providerProfiles").doc(user.uid).get(),
      db.collection("patientSubmittedResults").doc(resultId).get(),
      db.collection("patientResultFollowUpGrants").doc(resultId).get(),
    ]);
    if (!provider.exists || provider.get("type") !== "doctor" || provider.get("status") !== "verified" || provider.get("clinicalCredentialsVerified") !== true) throw new ApiRequestError(403, "verified-doctor-required", "Cette action est réservée au médecin NEXA vérifié.");
    if (!resultSnapshot.exists || resultSnapshot.get("providerUid") !== user.uid || resultSnapshot.get("status") !== "AVAILABLE_TO_PRESCRIBER" || !grantSnapshot.exists || grantSnapshot.get("providerUid") !== user.uid || grantSnapshot.get("status") !== "OPEN") throw new ApiRequestError(404, "patient-result-not-found", "Ce résultat n’est pas accessible.");
    const result = resultSnapshot.data() || {};
    const file = Array.isArray(result.files) ? result.files.find((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).id === fileId) as Record<string, unknown> | undefined : undefined;
    const storagePath = cleanPatientResultText(file?.storagePath, 600);
    if (!file || file.antivirusStatus !== "CLEAN" || !storagePath.startsWith(`nexa-patient-submitted-results/${result.patientUid}/${resultId}/`)) throw new ApiRequestError(409, "patient-result-file-not-cleared", "Ce fichier n’a pas reçu un verdict de sécurité valide.");
    const fileName = cleanPatientResultText(file.fileName, 180).replace(/[\r\n"\\]/g, "_") || "resultat";
    const [url] = await getFirebaseAdminStorage().bucket().file(storagePath).getSignedUrl({ action: "read", expires: Date.now() + 5 * 60_000, responseDisposition: `inline; filename="${fileName}"` });
    await db.collection("patientResultAuditLogs").add({ actorUid: user.uid, action: "prescriber_patient_result_file_opened", resultId, fileId, createdAt: FieldValue.serverTimestamp() });
    const headers = corsHeaders(request); headers.set("Cache-Control", "no-store, max-age=0");
    return NextResponse.json({ ok: true, url, expiresInSeconds: 300 }, { headers });
  } catch (error) { return fail(request, error); }
}
