import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb, getFirebaseAdminStorage } from "@/lib/firebase/admin";
import { RESULT_MAX_FILE_BYTES, SESSION_MEDIA_MIME_TYPES, cleanResultText } from "@/lib/diagnostic-results.server";
import { isValidAppointmentId, loadSessionForParticipant } from "@/lib/teleconsultation/session-messages.server";

const UPLOAD_TTL_MS = 10 * 60_000;
type MediaKind = "photo" | "voice";

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "session-media-upload-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le dépôt sécurisé du média n’est pas disponible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA session media upload initialization failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function mediaKind(value: unknown): MediaKind {
  if (value === "photo" || value === "voice") return value;
  throw new ApiRequestError(400, "invalid-session-media-kind", "Choisissez une photo ou un message vocal.");
}

function safeLimit(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(20, Math.floor(number))) : 0;
}

function filename(value: unknown, kind: MediaKind, contentType: string): string {
  const extensions: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
    "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3",
  };
  const base = cleanResultText(value, 80).replace(/[\\/\r\n"<>:|?*]/g, "_").replace(/\.[^.]*$/, "").trim() || (kind === "photo" ? "photo" : "vocal");
  return `${base}.${extensions[contentType]}`;
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request, { params }: { params: Promise<{ appointmentId: string }> }) {
  let createdSession: { id: string; storagePath: string } | null = null;
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "session-media-upload-start", limit: 10, windowMs: 10 * 60_000 });
    const { appointmentId } = await params;
    if (!isValidAppointmentId(appointmentId)) throw new ApiRequestError(400, "invalid-appointment", "La référence de consultation n’est pas valide.");
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande de dépôt n’est pas valide.");
    const input = body as Record<string, unknown>;
    const kind = mediaKind(input.kind);
    const contentType = cleanResultText(input.contentType, 100).split(";", 1)[0].trim().toLowerCase();
    const allowedForKind = kind === "photo"
      ? new Set(["image/jpeg", "image/png", "image/webp"])
      : new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"]);
    if (!SESSION_MEDIA_MIME_TYPES.has(contentType) || !allowedForKind.has(contentType)) throw new ApiRequestError(400, "invalid-session-media-type", "Ce format de photo ou d’audio n’est pas accepté.");
    const size = Number(input.size);
    if (!Number.isSafeInteger(size) || size < 1 || size > RESULT_MAX_FILE_BYTES) throw new ApiRequestError(400, "invalid-session-media-size", "Le média doit peser au maximum 15 Mio.");
    const appointment = await loadSessionForParticipant(appointmentId, user.uid, true);
    const isPatient = user.uid === appointment.patientUid;
    const rights = appointment.consultationRights && typeof appointment.consultationRights === "object" ? appointment.consultationRights as Record<string, unknown> : {};
    const maxVoiceSeconds = Math.max(1, Math.min(300, Math.floor(Number(rights.maxVoiceSeconds) || 60)));
    const durationSeconds = kind === "voice" ? Number(input.durationSeconds) : 0;
    if (kind === "voice" && (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > maxVoiceSeconds)) {
      throw new ApiRequestError(400, "invalid-session-voice-duration", `Le message vocal doit durer entre 1 et ${maxVoiceSeconds} secondes.`);
    }
    if (isPatient) {
      const cap = safeLimit(kind === "photo" ? rights.maxPhotos : rights.maxVoiceMessages);
      if (!cap) throw new ApiRequestError(403, "session-media-not-included", "Cette consultation ne comprend pas l’envoi de ce type de média.");
      const prior = await getFirebaseAdminDb().collection("sessionMessages")
        .where("appointmentId", "==", appointmentId).where("senderUid", "==", user.uid).where("kind", "==", kind).get();
      const activeCount = prior.docs.filter((doc) => {
        const expiry = doc.get("expiresAt");
        const expiryMillis = expiry && typeof expiry === "object" && "toMillis" in expiry && typeof expiry.toMillis === "function" ? expiry.toMillis() as number : 0;
        return doc.get("antivirusStatus") === "CLEAN" && (!expiryMillis || expiryMillis > Date.now());
      }).length;
      if (activeCount >= cap) throw new ApiRequestError(409, "session-media-limit-reached", kind === "photo" ? "La limite de photos de cette séance est atteinte." : "La limite de messages vocaux de cette séance est atteinte.");
    }

    const db = getFirebaseAdminDb();
    const uploadRef = db.collection("sessionMessageMediaUploads").doc();
    const storagePath = `nexa-session-media-quarantine/${appointmentId}/${uploadRef.id}`;
    const fileName = filename(input.fileName, kind, contentType);
    const expiresAt = Date.now() + UPLOAD_TTL_MS;
    await uploadRef.create({
      appointmentId,
      patientUid: appointment.patientUid,
      providerUid: appointment.providerUid,
      ownerUid: user.uid,
      kind,
      contentType,
      expectedSize: size,
      durationSeconds: kind === "voice" ? durationSeconds : null,
      fileName,
      storagePath,
      status: "OPEN",
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(expiresAt),
    });
    createdSession = { id: uploadRef.id, storagePath };

    const metadataFields: Record<string, string> = { "x-goog-meta-firebasestoragedownloadtokens": "" };
    const metadataConditions: Array<[string, string, string]> = [["eq", "$x-goog-meta-firebasestoragedownloadtokens", ""]];
    if (kind === "voice") {
      metadataFields["x-goog-meta-duration-seconds"] = String(durationSeconds);
      metadataConditions.push(["eq", "$x-goog-meta-duration-seconds", String(durationSeconds)]);
    }
    let uploadUrl: string;
    let fields: Record<string, string>;
    try {
      const [policy] = await getFirebaseAdminStorage().bucket().file(storagePath).generateSignedPostPolicyV4({
        expires: expiresAt,
        fields: { "Content-Type": contentType, success_action_status: "201", "x-goog-if-generation-match": "0", ...metadataFields },
        conditions: [
          ["content-length-range", 1, RESULT_MAX_FILE_BYTES],
          ["eq", "$key", storagePath],
          ["eq", "$Content-Type", contentType],
          ["eq", "$success_action_status", "201"],
          ["eq", "$x-goog-if-generation-match", "0"],
          ...metadataConditions,
        ],
      });
      uploadUrl = policy.url;
      fields = policy.fields;
    } catch {
      await uploadRef.update({ status: "FAILED", failedAt: FieldValue.serverTimestamp(), expiresAt: Timestamp.now() });
      throw new ApiRequestError(503, "session-media-upload-unavailable", "Le téléversement sécurisé est indisponible. Réessayez plus tard.");
    }
    return json(request, { ok: true, uploadId: uploadRef.id, uploadUrl, fields, expiresAt, fileName });
  } catch (error) {
    if (createdSession) {
      try {
        await getFirebaseAdminDb().collection("sessionMessageMediaUploads").doc(createdSession.id).update({ status: "FAILED", failedAt: FieldValue.serverTimestamp(), expiresAt: Timestamp.now() });
        await getFirebaseAdminStorage().bucket().file(createdSession.storagePath).delete({ ignoreNotFound: true });
      } catch { /* an unissued, expired policy is cleaned up by the scheduled job */ }
    }
    return fail(request, error);
  }
}
