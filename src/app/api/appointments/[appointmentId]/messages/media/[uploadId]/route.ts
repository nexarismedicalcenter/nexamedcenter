import { FieldValue, Timestamp, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb, getFirebaseAdminStorage } from "@/lib/firebase/admin";
import { RESULT_MAX_FILE_BYTES, scanSessionMediaFile } from "@/lib/diagnostic-results.server";
import { isValidAppointmentId, SESSION_MESSAGE_RETENTION_MS } from "@/lib/teleconsultation/session-messages.server";
import { createUserNotification } from "@/lib/notifications.server";

type RouteContext = { params: Promise<{ appointmentId: string; uploadId: string }> };

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "session-media-submit-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le média n’a pas pu être contrôlé et transmis.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA session media scan failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function validId(value: string): boolean { return /^[A-Za-z0-9_-]{10,200}$/.test(value); }

function interactive(appointment: Record<string, unknown>, userUid: string): boolean {
  const status = String(appointment.status || "").toUpperCase();
  const end = Date.parse(String(appointment.interactiveEndsAt || ""));
  return (appointment.patientUid === userUid || appointment.providerUid === userUid) &&
    appointment.providerType === "doctor" && appointment.paymentStatus === "PAID" && status === "IN_PROGRESS" &&
    !["TERMINATED", "INTERACTIVE_TIME_EXPIRED"].includes(String(appointment.sessionStatus || "").toUpperCase()) &&
    Number.isFinite(end) && Date.now() < end;
}

function safeLimit(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(20, Math.floor(number))) : 0;
}

function expiresAtMillis(value: unknown): number {
  if (value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") return value.toMillis() as number;
  return 0;
}

function activeMessage(message: QueryDocumentSnapshot, now: number): boolean {
  const expiration = message.get("expiresAt");
  const expiry = expiresAtMillis(expiration);
  return message.get("antivirusStatus") === "CLEAN" && (!expiry || expiry > now);
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request, context: RouteContext) {
  const { appointmentId, uploadId } = await context.params;
  let quarantinePath = "";
  let finalPath = "";
  let userUid = "";
  let scanClaimed = false;
  let messageCreated = false;
  try {
    const user = await requireFirebaseUser(request);
    userUid = user.uid;
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "session-media-submit", limit: 10, windowMs: 10 * 60_000 });
    if (!isValidAppointmentId(appointmentId) || !validId(uploadId)) throw new ApiRequestError(400, "invalid-session-media", "La référence du média n’est pas valide.");

    const db = getFirebaseAdminDb();
    const uploadRef = db.collection("sessionMessageMediaUploads").doc(uploadId);
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const claimed = await db.runTransaction(async (transaction) => {
      const [uploadSnapshot, appointmentSnapshot] = await Promise.all([transaction.get(uploadRef), transaction.get(appointmentRef)]);
      if (!uploadSnapshot.exists || uploadSnapshot.get("appointmentId") !== appointmentId || uploadSnapshot.get("ownerUid") !== user.uid || uploadSnapshot.get("status") !== "OPEN") {
        throw new ApiRequestError(404, "session-media-upload-not-found", "Ce dépôt n’est plus disponible.");
      }
      if (expiresAtMillis(uploadSnapshot.get("expiresAt")) <= Date.now()) throw new ApiRequestError(410, "session-media-upload-expired", "Le délai de dépôt a expiré. Sélectionnez de nouveau le fichier.");
      if (!appointmentSnapshot.exists) throw new ApiRequestError(404, "appointment-not-found", "Consultation introuvable.");
      const appointment = appointmentSnapshot.data() || {};
      if (!interactive(appointment, user.uid) || appointment.patientUid !== uploadSnapshot.get("patientUid") || appointment.providerUid !== uploadSnapshot.get("providerUid")) {
        throw new ApiRequestError(409, "session-not-interactive", "L’envoi de médias est fermé pour cette séance.");
      }
      if (appointment.providerUid === user.uid) {
        const doctorRef = db.collection("providerProfiles").doc(user.uid);
        const doctor = await transaction.get(doctorRef);
        if (!doctor.exists || doctor.get("status") !== "verified" || doctor.get("type") !== "doctor" || doctor.get("clinicalCredentialsVerified") !== true) {
          throw new ApiRequestError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à accéder à cette séance.");
        }
      }
      const expectedPath = `nexa-session-media-quarantine/${appointmentId}/${uploadId}`;
      if (uploadSnapshot.get("storagePath") !== expectedPath) throw new ApiRequestError(409, "session-media-path-invalid", "Le fichier ne correspond pas à cette session.");
      transaction.update(uploadRef, { status: "SCANNING", scanStartedAt: FieldValue.serverTimestamp() });
      const rights = appointment.consultationRights && typeof appointment.consultationRights === "object" ? appointment.consultationRights as Record<string, unknown> : {};
      return { ...(uploadSnapshot.data() || {}), maximumVoiceSeconds: Math.max(1, Math.min(300, Math.floor(Number(rights.maxVoiceSeconds) || 60))) } as Record<string, unknown>;
    });
    scanClaimed = true;
    quarantinePath = `nexa-session-media-quarantine/${appointmentId}/${uploadId}`;

    const kind = claimed.kind === "photo" || claimed.kind === "voice" ? claimed.kind : null;
    const contentType = typeof claimed.contentType === "string" ? claimed.contentType : "";
    const expectedSize = Number(claimed.expectedSize);
    if (!kind || !Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > RESULT_MAX_FILE_BYTES) throw new ApiRequestError(400, "invalid-session-media", "Le fichier n’a pas les caractéristiques attendues.");
    const bucket = getFirebaseAdminStorage().bucket();
    const quarantineFile = bucket.file(quarantinePath);
    const [exists] = await quarantineFile.exists();
    if (!exists) throw new ApiRequestError(400, "session-media-file-missing", "Le fichier n’a pas été téléversé. Réessayez.");
    const [metadata] = await quarantineFile.getMetadata();
    const objectSize = Number(metadata.size || 0);
    const customMetadata = metadata.metadata && typeof metadata.metadata === "object" ? metadata.metadata as Record<string, string> : {};
    const downloadTokens = Object.entries(customMetadata).find(([key]) => key.toLowerCase() === "firebasestoragedownloadtokens")?.[1];
    if (String(metadata.contentType || "").toLowerCase() !== contentType || objectSize !== expectedSize || objectSize > RESULT_MAX_FILE_BYTES || (downloadTokens && downloadTokens.length > 0)) {
      throw new ApiRequestError(400, "session-media-file-mismatch", "Le fichier ne correspond pas au format ou à la taille annoncés.");
    }
    if (kind === "voice" && Number(customMetadata.durationSeconds) !== Number(claimed.durationSeconds)) throw new ApiRequestError(400, "session-media-duration-mismatch", "La durée déclarée ne correspond pas au fichier envoyé.");
    const [contents] = await quarantineFile.download();
    const scan = await scanSessionMediaFile({
      fileBuffer: contents,
      contentType,
      ...(kind === "voice" ? {
        expectedDurationSeconds: Number(claimed.durationSeconds),
        maximumDurationSeconds: Number(claimed.maximumVoiceSeconds) || 60,
      } : {}),
    });

    const messageRef = db.collection("sessionMessages").doc();
    finalPath = `nexa-session-media/${appointmentId}/${messageRef.id}`;
    await quarantineFile.move(finalPath);
    const finalFile = bucket.file(finalPath);
    await finalFile.setMetadata({
      contentType,
      cacheControl: "private, no-store, max-age=0",
      metadata: {
        nexaAntivirusStatus: "CLEAN",
        nexaAntivirusScannerVersion: scan.scannerVersion || "unknown",
        firebaseStorageDownloadTokens: "",
      },
    });

    const recipientUid = user.uid === claimed.patientUid ? String(claimed.providerUid || "") : String(claimed.patientUid || "");
    await db.runTransaction(async (transaction) => {
      const [freshUpload, freshAppointment] = await Promise.all([transaction.get(uploadRef), transaction.get(appointmentRef)]);
      if (!freshUpload.exists || freshUpload.get("ownerUid") !== user.uid || freshUpload.get("status") !== "SCANNING" || !freshAppointment.exists) {
        throw new ApiRequestError(409, "session-media-upload-stale", "La session de dépôt a expiré ou a été annulée.");
      }
      const appointment = freshAppointment.data() || {};
      if (!interactive(appointment, user.uid) || appointment.patientUid !== claimed.patientUid || appointment.providerUid !== claimed.providerUid) {
        throw new ApiRequestError(409, "session-not-interactive", "La séance s’est terminée avant la transmission du média.");
      }
      if (appointment.providerUid === user.uid) {
        const doctor = await transaction.get(db.collection("providerProfiles").doc(user.uid));
        if (!doctor.exists || doctor.get("status") !== "verified" || doctor.get("type") !== "doctor" || doctor.get("clinicalCredentialsVerified") !== true) {
          throw new ApiRequestError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à accéder à cette séance.");
        }
      }
      if (user.uid === appointment.patientUid) {
        const rights = appointment.consultationRights && typeof appointment.consultationRights === "object" ? appointment.consultationRights as Record<string, unknown> : {};
        const cap = safeLimit(kind === "photo" ? rights.maxPhotos : rights.maxVoiceMessages);
        if (!cap) throw new ApiRequestError(403, "session-media-not-included", "Cette consultation ne comprend pas l’envoi de ce type de média.");
        const query = db.collection("sessionMessages").where("appointmentId", "==", appointmentId).where("senderUid", "==", user.uid).where("kind", "==", kind);
        const previous = await transaction.get(query);
        const used = previous.docs.filter((doc) => activeMessage(doc, Date.now())).length;
        if (used >= cap) throw new ApiRequestError(409, "session-media-limit-reached", kind === "photo" ? "La limite de photos de cette séance est atteinte." : "La limite de messages vocaux de cette séance est atteinte.");
      }
      const expiresAt = Timestamp.fromMillis(Date.now() + SESSION_MESSAGE_RETENTION_MS);
      transaction.create(messageRef, {
        appointmentId,
        patientUid: appointment.patientUid,
        providerUid: appointment.providerUid,
        senderUid: user.uid,
        kind,
        text: null,
        storagePath: finalPath,
        fileName: claimed.fileName,
        contentType,
        size: objectSize,
        durationSeconds: kind === "voice" ? Number(scan.durationSeconds) : null,
        antivirusStatus: "CLEAN",
        antivirusScannerVersion: scan.scannerVersion,
        antivirusScannedAt: FieldValue.serverTimestamp(),
        createdAt: Timestamp.now(),
        expiresAt,
      });
      transaction.update(uploadRef, { status: "SUBMITTED", submittedAt: FieldValue.serverTimestamp(), messageId: messageRef.id });
      transaction.create(db.collection("clinicalAuditLogs").doc(), {
        actorUid: user.uid,
        action: "session_media_message_created",
        appointmentId,
        recordId: appointmentId,
        messageId: messageRef.id,
        mediaKind: kind,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    messageCreated = true;
    if (recipientUid) {
      await createUserNotification({
        uid: recipientUid,
        eventKey: `session-message:${messageRef.id}`,
        type: "session_message",
        title: "Nouveau message de consultation",
        body: kind === "photo" ? "Une photo vous attend dans votre séance NEXA." : "Un message vocal vous attend dans votre séance NEXA.",
        url: `/teleconsultation?appointmentId=${encodeURIComponent(appointmentId)}`,
        appointmentId,
      }).catch((error) => console.error("NEXA session media notification failed", error instanceof Error ? error.name : "unknown-error"));
    }
    return json(request, { ok: true, messageId: messageRef.id, status: "CLEAN" });
  } catch (error) {
    const cleanupPaths = [quarantinePath, ...(!messageCreated && finalPath ? [finalPath] : [])].filter(Boolean);
    if (cleanupPaths.length) {
      try {
        const bucket = getFirebaseAdminStorage().bucket();
        await Promise.allSettled(cleanupPaths.map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
      } catch { /* expired private uploads are removed by the cleanup job */ }
    }
    if (scanClaimed && !messageCreated && uploadId && userUid) {
      await getFirebaseAdminDb().collection("sessionMessageMediaUploads").doc(uploadId).update({ status: "REJECTED", rejectedAt: FieldValue.serverTimestamp() }).catch(() => undefined);
    }
    return fail(request, error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const { appointmentId, uploadId } = await context.params;
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "session-media-upload-cancel", limit: 10, windowMs: 10 * 60_000 });
    if (!isValidAppointmentId(appointmentId) || !validId(uploadId)) throw new ApiRequestError(400, "invalid-session-media", "La référence du média n’est pas valide.");
    const db = getFirebaseAdminDb();
    const uploadRef = db.collection("sessionMessageMediaUploads").doc(uploadId);
    const snapshot = await uploadRef.get();
    if (!snapshot.exists || snapshot.get("ownerUid") !== user.uid || snapshot.get("appointmentId") !== appointmentId || !["OPEN", "SCANNING"].includes(String(snapshot.get("status")))) {
      throw new ApiRequestError(404, "session-media-upload-not-found", "Ce dépôt ne peut pas être annulé.");
    }
    await uploadRef.update({ status: "CANCELLED", cancelledAt: FieldValue.serverTimestamp() });
    const expectedPath = `nexa-session-media-quarantine/${appointmentId}/${uploadId}`;
    if (snapshot.get("storagePath") === expectedPath) await getFirebaseAdminStorage().bucket().file(expectedPath).delete({ ignoreNotFound: true });
    return json(request, { ok: true, uploadId, status: "CANCELLED" });
  } catch (error) { return fail(request, error); }
}
