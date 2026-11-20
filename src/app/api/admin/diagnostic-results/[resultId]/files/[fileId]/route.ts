import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { getFirebaseAdminDb, getFirebaseAdminStorage } from "@/lib/firebase/admin";
import { cleanResultText } from "@/lib/diagnostic-results.server";

type RouteContext = { params: Promise<{ resultId: string; fileId: string }> };

function errorResponse(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "diagnostic-result-file-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le fichier ne peut pas être ouvert.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA admin diagnostic result file failed", error instanceof Error ? error.name : "unknown-error");
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
    const admin = await requireNexaAdministrator(request);
    const { resultId, fileId } = await context.params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(resultId) || !/^[A-Za-z0-9_-]{10,100}$/.test(fileId)) throw new ApiRequestError(400, "invalid-result-file", "La référence du fichier n’est pas valide.");
    const db = getFirebaseAdminDb();
    const resultRef = db.collection("diagnosticResults").doc(resultId);
    const snapshot = await resultRef.get();
    if (!snapshot.exists) throw new ApiRequestError(404, "diagnostic-result-not-found", "Ce résultat est introuvable.");
    const result = snapshot.data() || {};
    if (!["RESULT_PENDING_REVIEW", "VALIDATED", "RESULT_AVAILABLE"].includes(String(result.status))) throw new ApiRequestError(409, "diagnostic-result-not-reviewable", "Ce résultat n’est pas disponible pour la revue.");
    const file = Array.isArray(result.files) ? result.files.find((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).id === fileId) as Record<string, unknown> | undefined : undefined;
    const storagePath = cleanResultText(file?.storagePath, 600);
    if (!file || file.antivirusStatus !== "CLEAN" || !storagePath.startsWith(`nexa-diagnostic-results/${result.orderId}/${resultId}/`)) throw new ApiRequestError(409, "diagnostic-result-file-not-cleared", "Ce fichier n’a pas reçu un verdict de sécurité valide.");
    const fileName = cleanResultText(file.fileName, 180).replace(/[\r\n"\\]/g, "_") || "resultat";
    const [url] = await getFirebaseAdminStorage().bucket().file(storagePath).getSignedUrl({ action: "read", expires: Date.now() + 5 * 60_000, responseDisposition: `inline; filename="${fileName}"` });
    await db.runTransaction(async (transaction) => {
      const fresh = await transaction.get(resultRef);
      const freshData = fresh.data() || {};
      const freshFiles = Array.isArray(freshData.files) ? freshData.files as Record<string, unknown>[] : [];
      if (!fresh.exists || !["RESULT_PENDING_REVIEW", "VALIDATED", "RESULT_AVAILABLE"].includes(String(freshData.status)) || !freshFiles.some((entry) => entry.id === fileId && entry.antivirusStatus === "CLEAN" && entry.storagePath === storagePath)) throw new ApiRequestError(409, "diagnostic-result-file-changed", "Le fichier ou son état a changé. Actualisez la revue.");
      const viewed = freshData.adminViewedByUid === admin.uid && Array.isArray(freshData.adminViewedFileIds) ? freshData.adminViewedFileIds as string[] : [];
      transaction.update(resultRef, { adminViewedAt: FieldValue.serverTimestamp(), adminViewedByUid: admin.uid, adminViewedFileIds: [...new Set([...viewed, fileId])] });
      transaction.create(db.collection("diagnosticResultAuditLogs").doc(), { actorUid: admin.uid, action: "diagnostic_result_file_opened_by_admin", orderId: result.orderId, resultId, fileId, createdAt: FieldValue.serverTimestamp() });
    });
    const headers = corsHeaders(request);
    headers.set("Cache-Control", "no-store, max-age=0");
    return NextResponse.json({ ok: true, url, expiresInSeconds: 300, file: { id: fileId, fileName, contentType: file.contentType, size: file.size, category: file.category } }, { headers });
  } catch (error) { return errorResponse(request, error); }
}
