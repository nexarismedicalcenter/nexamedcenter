import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb, getFirebaseAdminStorage } from "@/lib/firebase/admin";
import { cleanResultText, RESULT_MAX_FILE_BYTES } from "@/lib/diagnostic-results.server";
import { isValidAppointmentId, loadSessionForParticipant } from "@/lib/teleconsultation/session-messages.server";

type RouteContext = { params: Promise<{ appointmentId: string; messageId: string }> };

function json(request: Request, payload: Record<string, unknown>) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "session-media-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le média de cette séance n’est pas accessible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA session media read failed", error instanceof Error ? error.name : "unknown-error");
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
    await enforceUserRateLimit({ uid: user.uid, action: "session-media-read", limit: 30, windowMs: 60_000 });
    const { appointmentId, messageId } = await context.params;
    if (!isValidAppointmentId(appointmentId) || !/^[A-Za-z0-9_-]{10,200}$/.test(messageId)) throw new ApiRequestError(400, "invalid-session-media", "La référence du média n’est pas valide.");
    await loadSessionForParticipant(appointmentId, user.uid, false);
    const db = getFirebaseAdminDb();
    const messageSnapshot = await db.collection("sessionMessages").doc(messageId).get();
    if (!messageSnapshot.exists) throw new ApiRequestError(404, "session-media-not-found", "Ce média n’est plus disponible.");
    const message = messageSnapshot.data() || {};
    if (message.appointmentId !== appointmentId || (message.patientUid !== user.uid && message.providerUid !== user.uid) || !["photo", "voice"].includes(String(message.kind))) {
      throw new ApiRequestError(404, "session-media-not-found", "Ce média n’est plus disponible.");
    }
    const expiry = message.expiresAt && typeof message.expiresAt === "object" && "toMillis" in message.expiresAt && typeof message.expiresAt.toMillis === "function"
      ? message.expiresAt.toMillis() as number
      : 0;
    if (expiry <= Date.now() || message.antivirusStatus !== "CLEAN") throw new ApiRequestError(409, "session-media-not-cleared", "Ce média est expiré ou n’a pas reçu un verdict antivirus valide.");
    const storagePath = cleanResultText(message.storagePath, 500);
    if (storagePath !== `nexa-session-media/${appointmentId}/${messageId}`) throw new ApiRequestError(409, "session-media-path-invalid", "Ce média n’est pas correctement relié à la séance.");
    const file = getFirebaseAdminStorage().bucket().file(storagePath);
    const [metadata] = await file.getMetadata();
    const objectSize = Number(metadata.size || 0);
    const customMetadata = metadata.metadata && typeof metadata.metadata === "object" ? metadata.metadata as Record<string, string> : {};
    const downloadTokens = Object.entries(customMetadata).find(([key]) => key.toLowerCase() === "firebasestoragedownloadtokens")?.[1];
    if (metadata.contentType !== message.contentType || objectSize !== Number(message.size) || objectSize < 1 || objectSize > RESULT_MAX_FILE_BYTES || customMetadata.nexaAntivirusStatus !== "CLEAN" || (downloadTokens && downloadTokens.length > 0)) {
      throw new ApiRequestError(409, "session-media-object-invalid", "Le fichier ne correspond plus aux vérifications de sécurité.");
    }
    const fileName = cleanResultText(message.fileName, 120).replace(/[\r\n"\\]/g, "_") || (message.kind === "photo" ? "photo" : "message-vocal");
    const [url] = await file.getSignedUrl({ action: "read", expires: Date.now() + 5 * 60_000, responseDisposition: `inline; filename="${fileName}"` });
    await db.collection("clinicalAuditLogs").add({
      actorUid: user.uid,
      action: "session_media_download_url_issued",
      appointmentId,
      recordId: appointmentId,
      messageId,
      mediaKind: message.kind,
      createdAt: FieldValue.serverTimestamp(),
    });
    return json(request, { ok: true, url, expiresInSeconds: 300, kind: message.kind });
  } catch (error) { return fail(request, error); }
}
