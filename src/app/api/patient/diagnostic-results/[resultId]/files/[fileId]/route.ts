import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb, getFirebaseAdminStorage } from "@/lib/firebase/admin";
import { cleanResultText } from "@/lib/diagnostic-results.server";

type RouteContext = { params: Promise<{ resultId: string; fileId: string }> };

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "patient-diagnostic-result-file-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Ce fichier ne peut pas être ouvert pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA patient diagnostic result file failed", error instanceof Error ? error.name : "unknown-error");
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
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "patient-diagnostic-result-file", limit: 20, windowMs: 60_000 });
    const { resultId, fileId } = await context.params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(resultId) || !/^[A-Za-z0-9_-]{10,100}$/.test(fileId)) throw new ApiRequestError(400, "invalid-result-file", "La référence du fichier n’est pas valide.");
    const db = getFirebaseAdminDb();
    const partnerRef = db.collection("diagnosticResults").doc(resultId);
    const [partnerSnapshot, patientSnapshot] = await Promise.all([
      partnerRef.get(), db.collection("patientSubmittedResults").doc(resultId).get(),
    ]);
    const isPartnerResult = partnerSnapshot.exists;
    const snapshot = isPartnerResult ? partnerSnapshot : patientSnapshot;
    if (!snapshot.exists) throw new ApiRequestError(404, "diagnostic-result-not-found", "Ce résultat n’est pas disponible.");
    const result = snapshot.data() || {};
    if (result.patientUid !== user.uid || (isPartnerResult
      ? result.status !== "RESULT_AVAILABLE" || !result.patientTransferredAt
      : !["AVAILABLE_TO_PRESCRIBER", "FOLLOW_UP_CLOSED"].includes(String(result.status)))) throw new ApiRequestError(404, "diagnostic-result-not-found", "Ce résultat n’est pas disponible.");
    const file = Array.isArray(result.files) ? result.files.find((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).id === fileId) as Record<string, unknown> | undefined : undefined;
    const storagePath = cleanResultText(file?.storagePath, 600);
    const expectedPrefix = isPartnerResult
      ? `nexa-diagnostic-results/${result.orderId}/${resultId}/`
      : `nexa-patient-submitted-results/${user.uid}/${resultId}/`;
    if (!file || file.antivirusStatus !== "CLEAN" || !storagePath.startsWith(expectedPrefix)) throw new ApiRequestError(409, "diagnostic-result-file-not-cleared", "Ce fichier n’a pas reçu un verdict de sécurité valide.");
    const fileName = cleanResultText(file.fileName, 180).replace(/[\r\n"\\]/g, "_") || "resultat";
    const [url] = await getFirebaseAdminStorage().bucket().file(storagePath).getSignedUrl({ action: "read", expires: Date.now() + 5 * 60_000, responseDisposition: `inline; filename="${fileName}"` });
    if (isPartnerResult) {
      await db.collection("diagnosticResultAuditLogs").add({ actorUid: user.uid, action: "patient_diagnostic_result_file_opened", resource: `diagnosticResults/${resultId}`, orderId: result.orderId, fileId, createdAt: FieldValue.serverTimestamp() });
    } else {
      await db.collection("patientResultAuditLogs").add({ actorUid: user.uid, action: "patient_submitted_result_file_opened", resultId, fileId, createdAt: FieldValue.serverTimestamp() });
    }
    const headers = corsHeaders(request);
    headers.set("Cache-Control", "no-store, max-age=0");
    return NextResponse.json({ ok: true, url, expiresInSeconds: 300 }, { headers });
  } catch (error) { return fail(request, error); }
}
