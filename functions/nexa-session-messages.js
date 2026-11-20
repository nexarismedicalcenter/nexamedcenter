"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

const REGION = "us-east4";
const SESSION_MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const SESSION_MEDIA_MAX_FILE_BYTES = 15 * 1024 * 1024;
const SESSION_MEDIA_UPLOAD_TTL_MS = 10 * 60 * 1_000;
const APPOINTMENT_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
const PHOTO_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VOICE_MIME_TYPES = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"]);
const SESSION_MEDIA_MIME_TYPES = new Set([...PHOTO_MIME_TYPES, ...VOICE_MIME_TYPES]);

function requestBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length > 16_384) return null;
  try {
    const body = JSON.parse(req.rawBody.toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch { return null; }
}

function hasOnlyKeys(value, allowedKeys) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key)));
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(String(value || ""));
}

function isoDate(value) {
  const milliseconds = timestampMillis(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function isUnexpired(value, now) {
  const expiresAt = timestampMillis(value);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function isInteractive(appointment, now = Date.now()) {
  const endsAt = timestampMillis(appointment.interactiveEndsAt);
  return appointment.providerType === "doctor" && appointment.paymentStatus === "PAID" && String(appointment.status || "").toUpperCase() === "IN_PROGRESS" &&
    !["TERMINATED", "INTERACTIVE_TIME_EXPIRED"].includes(String(appointment.sessionStatus || "").toUpperCase()) &&
    Number.isFinite(endsAt) && now < endsAt;
}

async function loadSession(db, appointmentId, uid, sending, ApiError) {
  const snapshot = await db.collection("appointments").doc(appointmentId).get();
  if (!snapshot.exists) throw new ApiError(404, "appointment-not-found", "Consultation introuvable.");
  const appointment = snapshot.data() || {};
  if (appointment.patientUid !== uid && appointment.providerUid !== uid) {
    throw new ApiError(403, "forbidden", "Vous ne participez pas à cette séance.");
  }
  if (appointment.providerUid === uid) {
    const provider = await db.collection("providerProfiles").doc(uid).get();
    if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
      throw new ApiError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à accéder à cette séance.");
    }
  }
  const status = String(appointment.status || "").toUpperCase();
  if (appointment.providerType !== "doctor" || !["IN_PROGRESS", "COMPLETED"].includes(status)) {
    throw new ApiError(409, "session-not-active", "La messagerie est disponible pendant la séance et dans son historique récent.");
  }
  if (sending && !isInteractive(appointment)) {
    throw new ApiError(409, "session-not-interactive", "L’envoi de messages est fermé pour cette séance.");
  }
  return appointment;
}

function cleanMessage(value) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim().slice(0, 4_000)
    : "";
}

function boundedLimit(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(20, Math.floor(number))) : 0;
}

function mediaFileName(value, kind, contentType) {
  const extensions = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
    "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3",
  };
  const base = typeof value === "string"
    ? value.slice(0, 80).replace(/[\\/\r\n"<>:|?*]/g, "_").replace(/\.[^.]*$/, "").trim()
    : "";
  return `${base || (kind === "photo" ? "photo" : "vocal")}.${extensions[contentType]}`;
}

function safeText(value, maximum = 120) {
  return typeof value === "string"
    ? value.trim().replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").slice(0, maximum)
    : "";
}

function requestBodyTooLarge(req, maximum) {
  return (Number(req.get("Content-Length")) || 0) > maximum ||
    (Buffer.isBuffer(req.rawBody) && req.rawBody.length > maximum);
}

async function scannerIdentityToken(audience, localScanner, ApiError) {
  if (localScanner) return "";
  let response;
  try {
    const identityUrl = new URL("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity");
    identityUrl.searchParams.set("audience", audience);
    identityUrl.searchParams.set("format", "full");
    response = await fetch(identityUrl, {
      headers: { "Metadata-Flavor": "Google" },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new ApiError(503, "scanner-identity-unavailable", "L’analyse de sécurité n’est pas configurée. Aucun média n’a été transmis.");
  }
  if (!response.ok) throw new ApiError(503, "scanner-identity-unavailable", "L’analyse de sécurité n’est pas configurée. Aucun média n’a été transmis.");
  const token = (await response.text()).trim();
  if (!token || token.length > 20_000) throw new ApiError(503, "scanner-identity-unavailable", "L’analyse de sécurité n’est pas configurée. Aucun média n’a été transmis.");
  return token;
}

async function scanSessionMediaFile(input, ApiError) {
  if (!Buffer.isBuffer(input.fileBuffer) || input.fileBuffer.length < 1 || input.fileBuffer.length > SESSION_MEDIA_MAX_FILE_BYTES || !SESSION_MEDIA_MIME_TYPES.has(input.contentType)) {
    throw new ApiError(400, "invalid-session-media", "Le fichier ne respecte pas les limites de sécurité NEXA.");
  }
  const configuredUrl = process.env.NEXA_MALWARE_SCANNER_URL || "";
  const audience = process.env.NEXA_MALWARE_SCANNER_AUDIENCE || "";
  let target;
  try { target = new URL(configuredUrl); }
  catch { throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité n’est pas configurée. Aucun média n’a été transmis."); }
  const localScanner = process.env.NODE_ENV !== "production" && target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if ((target.protocol !== "https:" && !localScanner) || target.username || target.password || target.search || target.hash || !["", "/"].includes(target.pathname)) {
    throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité n’est pas configurée. Aucun média n’a été transmis.");
  }
  if (!localScanner) {
    let parsedAudience;
    try { parsedAudience = new URL(audience); } catch { /* fail closed below */ }
    if (!parsedAudience || parsedAudience.origin !== target.origin || !["", "/"].includes(parsedAudience.pathname) || parsedAudience.search || parsedAudience.hash || parsedAudience.username || parsedAudience.password) {
      throw new ApiError(503, "scanner-audience-not-configured", "L’identité de l’analyse de sécurité n’est pas configurée.");
    }
  }
  const token = await scannerIdentityToken(audience, localScanner, ApiError);
  let response;
  try {
    response = await fetch(new URL("/scan", target.origin), {
      method: "POST",
      headers: { "Content-Type": input.contentType, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: new Blob([new Uint8Array(input.fileBuffer)], { type: input.contentType }),
      cache: "no-store",
      signal: AbortSignal.timeout(40_000),
    });
  } catch {
    throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité est temporairement indisponible. Aucun média n’a été transmis.");
  }
  const verdict = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 413 || response.status === 415) throw new ApiError(400, "invalid-session-media", "Le média ne correspond pas au type ou à la taille autorisés.");
    throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité est temporairement indisponible. Aucun média n’a été transmis.");
  }
  if (verdict.status === "INFECTED") throw new ApiError(422, "malware-detected", "Ce média a été bloqué par l’analyse antivirus. Vérifiez-le puis recommencez.");
  if (verdict.status !== "CLEAN") throw new ApiError(503, "malware-scanner-invalid-response", "L’analyse de sécurité n’a pas confirmé que le média est propre.");
  if (input.kind === "voice") {
    const duration = Number(verdict.durationSeconds);
    if (!Number.isSafeInteger(duration) || duration < 1) throw new ApiError(503, "session-media-duration-unavailable", "La durée du message vocal n’a pas pu être vérifiée.");
    if (Math.abs(duration - input.expectedDurationSeconds) > 1) throw new ApiError(400, "session-media-duration-mismatch", "La durée du message vocal ne correspond pas à l’enregistrement.");
    if (duration > input.maximumDurationSeconds) throw new ApiError(400, "session-media-duration-too-long", `Le message vocal dépasse la durée autorisée de ${input.maximumDurationSeconds} secondes.`);
    return { scannerVersion: typeof verdict.scannerVersion === "string" ? verdict.scannerVersion.slice(0, 80) : "unknown", durationSeconds: duration };
  }
  return { scannerVersion: typeof verdict.scannerVersion === "string" ? verdict.scannerVersion.slice(0, 80) : "unknown" };
}

module.exports = function createNexaSessionMessageFunctions(dependencies) {
  const { db, FieldValue, storage, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger, createNexaNotification } = dependencies;
  const bucket = storage.bucket(process.env.NEXA_STORAGE_BUCKET || "nexaris-1339d.firebasestorage.app");

  const nexaSessionMediaUpload = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["POST", "DELETE"].includes(req.method)) {
      res.set("Allow", "POST, DELETE, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if (requestBodyTooLarge(req, 8_192)) return fail(res, 413, "request-too-large", "La demande de média dépasse la taille autorisée.");

    let createdSession = null;
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      const body = requestBody(req);
      const appointmentId = typeof body?.appointmentId === "string" ? body.appointmentId.trim() : "";
      if (!APPOINTMENT_ID_PATTERN.test(appointmentId)) throw new ApiError(400, "invalid-appointment", "La référence de consultation n’est pas valide.");

      if (req.method === "DELETE") {
        if (!hasOnlyKeys(body, ["appointmentId", "uploadId"])) throw new ApiError(400, "invalid-request", "La demande d’annulation n’est pas valide.");
        await enforceUserRateLimit(user.uid, "session-media-upload-cancel", 10, 10 * 60_000);
        const uploadId = typeof body?.uploadId === "string" ? body.uploadId.trim() : "";
        if (!MEDIA_ID_PATTERN.test(uploadId)) throw new ApiError(400, "invalid-session-media", "La référence du média n’est pas valide.");
        const uploadRef = db.collection("sessionMessageMediaUploads").doc(uploadId);
        const snapshot = await uploadRef.get();
        if (!snapshot.exists || snapshot.get("ownerUid") !== user.uid || snapshot.get("appointmentId") !== appointmentId || !["OPEN", "SCANNING"].includes(String(snapshot.get("status")))) {
          throw new ApiError(404, "session-media-upload-not-found", "Ce dépôt ne peut pas être annulé.");
        }
        const expectedPath = `nexa-session-media-quarantine/${appointmentId}/${uploadId}`;
        if (snapshot.get("storagePath") !== expectedPath) throw new ApiError(409, "session-media-path-invalid", "Le fichier ne correspond pas à cette séance.");
        await uploadRef.update({ status: "CANCELLED", cancelledAt: FieldValue.serverTimestamp() });
        await bucket.file(expectedPath).delete({ ignoreNotFound: true });
        res.set("Cache-Control", "no-store, max-age=0");
        return res.status(200).json({ ok: true, uploadId, status: "CANCELLED" });
      }

      await enforceUserRateLimit(user.uid, "session-media-upload-start", 10, 10 * 60_000);
      if (!hasOnlyKeys(body, ["action", "appointmentId", "kind", "contentType", "size", "durationSeconds", "fileName"])) {
        throw new ApiError(400, "invalid-request", "La demande de dépôt n’est pas valide.");
      }
      if (body?.action !== "start") throw new ApiError(400, "invalid-request", "La demande de dépôt n’est pas valide.");
      const kind = body.kind === "photo" || body.kind === "voice" ? body.kind : "";
      if (!kind) throw new ApiError(400, "invalid-session-media-kind", "Choisissez une photo ou un message vocal.");
      const contentType = safeText(body.contentType, 100).split(";", 1)[0].trim().toLowerCase();
      const allowedTypes = kind === "photo" ? PHOTO_MIME_TYPES : VOICE_MIME_TYPES;
      if (!SESSION_MEDIA_MIME_TYPES.has(contentType) || !allowedTypes.has(contentType)) {
        throw new ApiError(400, "invalid-session-media-type", "Ce format de photo ou d’audio n’est pas accepté.");
      }
      const size = Number(body.size);
      if (!Number.isSafeInteger(size) || size < 1 || size > SESSION_MEDIA_MAX_FILE_BYTES) {
        throw new ApiError(400, "invalid-session-media-size", "Le média doit peser au maximum 15 Mio.");
      }
      const appointment = await loadSession(db, appointmentId, user.uid, true, ApiError);
      const isPatient = user.uid === appointment.patientUid;
      const rights = appointment.consultationRights && typeof appointment.consultationRights === "object" ? appointment.consultationRights : {};
      const maximumVoiceSeconds = Math.max(1, Math.min(300, Math.floor(Number(rights.maxVoiceSeconds) || 60)));
      const durationSeconds = kind === "voice" ? Number(body.durationSeconds) : null;
      if (kind === "voice" && (!Number.isSafeInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > maximumVoiceSeconds)) {
        throw new ApiError(400, "invalid-session-voice-duration", `Le message vocal doit durer entre 1 et ${maximumVoiceSeconds} secondes.`);
      }
      if (isPatient) {
        const cap = boundedLimit(kind === "photo" ? rights.maxPhotos : rights.maxVoiceMessages);
        if (!cap) throw new ApiError(403, "session-media-not-included", "Cette consultation ne comprend pas l’envoi de ce type de média.");
        const previous = await db.collection("sessionMessages")
          .where("appointmentId", "==", appointmentId)
          .where("senderUid", "==", user.uid)
          .get();
        const used = previous.docs.filter((document) => document.get("kind") === kind && document.get("antivirusStatus") === "CLEAN" && isUnexpired(document.get("expiresAt"), Date.now())).length;
        if (used >= cap) throw new ApiError(409, "session-media-limit-reached", kind === "photo" ? "La limite de photos de cette séance est atteinte." : "La limite de messages vocaux de cette séance est atteinte.");
      }

      const uploadRef = db.collection("sessionMessageMediaUploads").doc();
      const storagePath = `nexa-session-media-quarantine/${appointmentId}/${uploadRef.id}`;
      const fileName = mediaFileName(body.fileName, kind, contentType);
      const expiresAt = Date.now() + SESSION_MEDIA_UPLOAD_TTL_MS;
      await uploadRef.create({
        appointmentId,
        patientUid: appointment.patientUid,
        providerUid: appointment.providerUid,
        ownerUid: user.uid,
        kind,
        contentType,
        expectedSize: size,
        durationSeconds,
        fileName,
        storagePath,
        status: "OPEN",
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: new Date(expiresAt),
      });
      createdSession = { id: uploadRef.id, storagePath };

      const metadataFields = { "x-goog-meta-firebasestoragedownloadtokens": "" };
      const metadataConditions = [["eq", "$x-goog-meta-firebasestoragedownloadtokens", ""]];
      if (kind === "voice") {
        metadataFields["x-goog-meta-duration-seconds"] = String(durationSeconds);
        metadataConditions.push(["eq", "$x-goog-meta-duration-seconds", String(durationSeconds)]);
      }
      let policy;
      try {
        [policy] = await bucket.file(storagePath).generateSignedPostPolicyV4({
          expires: expiresAt,
          fields: {
            "Content-Type": contentType,
            success_action_status: "201",
            "x-goog-if-generation-match": "0",
            ...metadataFields,
          },
          conditions: [
            ["content-length-range", 1, SESSION_MEDIA_MAX_FILE_BYTES],
            ["eq", "$key", storagePath],
            ["eq", "$Content-Type", contentType],
            ["eq", "$success_action_status", "201"],
            ["eq", "$x-goog-if-generation-match", "0"],
            ...metadataConditions,
          ],
        });
      } catch {
        await uploadRef.update({ status: "FAILED", failedAt: FieldValue.serverTimestamp(), expiresAt: new Date() });
        throw new ApiError(503, "session-media-upload-unavailable", "Le téléversement sécurisé est indisponible. Réessayez plus tard.");
      }
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, uploadId: uploadRef.id, uploadUrl: policy.url, fields: policy.fields, expiresAt, fileName });
    } catch (error) {
      if (createdSession) {
        try {
          await db.collection("sessionMessageMediaUploads").doc(createdSession.id).update({ status: "FAILED", failedAt: FieldValue.serverTimestamp(), expiresAt: new Date() });
          await bucket.file(createdSession.storagePath).delete({ ignoreNotFound: true });
        } catch { /* the scheduled cleanup retries expired sessions */ }
      }
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA session media upload initialization failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "session-media-upload-unavailable", "Le dépôt sécurisé du média n’est pas disponible.");
    }
  });

  const nexaSessionMessages = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) {
      res.set("Allow", "GET, POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if (req.method === "POST" && ((Number(req.get("Content-Length")) || 0) > 16_384 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 16_384))) {
      return fail(res, 413, "request-too-large", "Le message dépasse la taille autorisée.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      res.set("Cache-Control", "no-store, max-age=0");

      if (req.method === "GET") {
        await enforceUserRateLimit(user.uid, "session-message-read", 30, 60_000);
        const appointmentId = typeof req.query.appointmentId === "string" ? req.query.appointmentId.trim() : "";
        if (!APPOINTMENT_ID_PATTERN.test(appointmentId)) throw new ApiError(400, "invalid-appointment", "La référence de consultation n’est pas valide.");
        const appointment = await loadSession(db, appointmentId, user.uid, false, ApiError);
        const now = Date.now();
        const snapshot = await db.collection("sessionMessages")
          .where("appointmentId", "==", appointmentId)
          .orderBy("createdAt", "desc")
          .limit(100)
          .get();
        const messages = snapshot.docs
          .filter((document) => isUnexpired(document.get("expiresAt"), now))
          .map((document) => {
            const item = document.data();
            const kind = ["photo", "voice"].includes(String(item.kind)) && item.antivirusStatus === "CLEAN" ? item.kind : "text";
            return {
              id: document.id,
              senderUid: String(item.senderUid || ""),
              kind,
              text: kind === "text" && typeof item.text === "string" ? item.text.slice(0, 4_000) : "",
              ...(kind !== "text" && typeof item.fileName === "string" ? { fileName: safeText(item.fileName, 120) } : {}),
              ...(kind === "voice" && Number.isSafeInteger(item.durationSeconds) ? { durationSeconds: item.durationSeconds } : {}),
              createdAt: isoDate(item.createdAt),
            };
          })
          .reverse();
        const isPatient = user.uid === appointment.patientUid;
        const rights = appointment.consultationRights && typeof appointment.consultationRights === "object" ? appointment.consultationRights : {};
        const patientMediaSnapshot = isPatient
          ? await db.collection("sessionMessages").where("appointmentId", "==", appointmentId).where("senderUid", "==", appointment.patientUid).get()
          : null;
        const activePatientMedia = (patientMediaSnapshot?.docs || []).filter((document) =>
          ["photo", "voice"].includes(String(document.get("kind"))) && document.get("antivirusStatus") === "CLEAN" && isUnexpired(document.get("expiresAt"), now));
        const mediaLimits = {
          maxPhotos: isPatient ? boundedLimit(rights.maxPhotos) : null,
          maxVoiceMessages: isPatient ? boundedLimit(rights.maxVoiceMessages) : null,
          maxVoiceSeconds: Math.max(1, Math.min(300, Math.floor(Number(rights.maxVoiceSeconds) || 60))),
          photosUsed: activePatientMedia.filter((document) => document.get("kind") === "photo").length,
          voiceMessagesUsed: activePatientMedia.filter((document) => document.get("kind") === "voice").length,
        };
        return res.status(200).json({ ok: true, messages, canSend: isInteractive(appointment), mediaLimits });
      }

      await enforceUserRateLimit(user.uid, "session-text-message", 40, 5 * 60_000);
      const body = requestBody(req);
      const appointmentId = typeof body?.appointmentId === "string" ? body.appointmentId.trim() : "";
      if (!APPOINTMENT_ID_PATTERN.test(appointmentId)) throw new ApiError(400, "invalid-appointment", "La référence de consultation n’est pas valide.");
      const text = cleanMessage(body?.text);
      if (!text) throw new ApiError(400, "message-required", "Écrivez un message avant de l’envoyer.");
      const appointment = await loadSession(db, appointmentId, user.uid, true, ApiError);
      const recipientUid = user.uid === appointment.patientUid ? String(appointment.providerUid || "") : String(appointment.patientUid || "");
      if (!recipientUid) throw new ApiError(409, "session-recipient-missing", "Le participant destinataire n’est pas disponible.");

      const appointmentRef = db.collection("appointments").doc(appointmentId);
      const providerRef = db.collection("providerProfiles").doc(String(appointment.providerUid || "_"));
      const messageRef = db.collection("sessionMessages").doc();
      const now = Date.now();
      await db.runTransaction(async (transaction) => {
        const [currentSnapshot, providerSnapshot] = await Promise.all([
          transaction.get(appointmentRef),
          user.uid === appointment.providerUid ? transaction.get(providerRef) : Promise.resolve(null),
        ]);
        if (!currentSnapshot.exists) throw new ApiError(404, "appointment-not-found", "Consultation introuvable.");
        const current = currentSnapshot.data() || {};
        if (current.patientUid !== appointment.patientUid || current.providerUid !== appointment.providerUid ||
          (current.patientUid !== user.uid && current.providerUid !== user.uid) || current.providerType !== "doctor" || !isInteractive(current, now)) {
          throw new ApiError(409, "session-not-interactive", "L’envoi de messages est fermé pour cette séance.");
        }
        if (user.uid === current.providerUid && (!providerSnapshot?.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true)) {
          throw new ApiError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à accéder à cette séance.");
        }
        transaction.create(messageRef, {
          appointmentId,
          patientUid: current.patientUid,
          providerUid: current.providerUid,
          senderUid: user.uid,
          kind: "text",
          text,
          createdAt: FieldValue.serverTimestamp(),
          expiresAt: new Date(now + SESSION_MESSAGE_RETENTION_MS),
        });
      });

      await createNexaNotification(recipientUid, `session-message:${messageRef.id}`, {
        type: "session_message",
        title: "Nouveau message de consultation",
        body: "Un message vous attend dans votre séance NEXA.",
        url: `/teleconsultation.html?appointmentId=${encodeURIComponent(appointmentId)}`,
      }, appointmentId).catch((error) => logger.warn("NEXA session message notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
      return res.status(200).json({ ok: true, message: { id: messageRef.id, senderUid: user.uid, kind: "text", text, createdAt: new Date(now).toISOString() } });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA session messages request failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "session-messages-unavailable", "La messagerie de cette consultation n’est pas accessible pour le moment.");
    }
  });

  const nexaSessionMediaFinalize = onRequest({ region: REGION, maxInstances: 10, concurrency: 2, memory: "1GiB", timeoutSeconds: 90 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      res.set("Allow", "POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if (requestBodyTooLarge(req, 8_192)) return fail(res, 413, "request-too-large", "La demande de média dépasse la taille autorisée.");

    let userUid = "";
    let appointmentId = "";
    let uploadId = "";
    let quarantinePath = "";
    let finalPath = "";
    let scanClaimed = false;
    let messageCreated = false;
    try {
      const user = await requireUser(req);
      userUid = user.uid;
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "session-media-submit", 10, 10 * 60_000);
      const body = requestBody(req);
      if (!hasOnlyKeys(body, ["appointmentId", "uploadId"])) throw new ApiError(400, "invalid-request", "La demande de transmission n’est pas valide.");
      appointmentId = typeof body?.appointmentId === "string" ? body.appointmentId.trim() : "";
      uploadId = typeof body?.uploadId === "string" ? body.uploadId.trim() : "";
      if (!APPOINTMENT_ID_PATTERN.test(appointmentId) || !MEDIA_ID_PATTERN.test(uploadId)) {
        throw new ApiError(400, "invalid-session-media", "La référence du média n’est pas valide.");
      }

      const uploadRef = db.collection("sessionMessageMediaUploads").doc(uploadId);
      const appointmentRef = db.collection("appointments").doc(appointmentId);
      const claimed = await db.runTransaction(async (transaction) => {
        const [uploadSnapshot, appointmentSnapshot] = await Promise.all([transaction.get(uploadRef), transaction.get(appointmentRef)]);
        if (!uploadSnapshot.exists || uploadSnapshot.get("appointmentId") !== appointmentId || uploadSnapshot.get("ownerUid") !== user.uid || uploadSnapshot.get("status") !== "OPEN") {
          throw new ApiError(404, "session-media-upload-not-found", "Ce dépôt n’est plus disponible.");
        }
        if (!isUnexpired(uploadSnapshot.get("expiresAt"), Date.now())) throw new ApiError(410, "session-media-upload-expired", "Le délai de dépôt a expiré. Sélectionnez de nouveau le fichier.");
        if (!appointmentSnapshot.exists) throw new ApiError(404, "appointment-not-found", "Consultation introuvable.");
        const appointment = appointmentSnapshot.data() || {};
        if (!isInteractive(appointment) || appointment.patientUid !== uploadSnapshot.get("patientUid") || appointment.providerUid !== uploadSnapshot.get("providerUid")) {
          throw new ApiError(409, "session-not-interactive", "L’envoi de médias est fermé pour cette séance.");
        }
        if (appointment.patientUid !== user.uid && appointment.providerUid !== user.uid) {
          throw new ApiError(403, "forbidden", "Vous ne participez pas à cette séance.");
        }
        if (appointment.providerUid === user.uid) {
          const doctor = await transaction.get(db.collection("providerProfiles").doc(user.uid));
          if (!doctor.exists || doctor.get("status") !== "verified" || doctor.get("type") !== "doctor" || doctor.get("clinicalCredentialsVerified") !== true) {
            throw new ApiError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à accéder à cette séance.");
          }
        }
        const expectedPath = `nexa-session-media-quarantine/${appointmentId}/${uploadId}`;
        if (uploadSnapshot.get("storagePath") !== expectedPath) throw new ApiError(409, "session-media-path-invalid", "Le fichier ne correspond pas à cette séance.");
        transaction.update(uploadRef, { status: "SCANNING", scanStartedAt: FieldValue.serverTimestamp() });
        const rights = appointment.consultationRights && typeof appointment.consultationRights === "object" ? appointment.consultationRights : {};
        return {
          ...(uploadSnapshot.data() || {}),
          maximumVoiceSeconds: Math.max(1, Math.min(300, Math.floor(Number(rights.maxVoiceSeconds) || 60))),
        };
      });
      scanClaimed = true;
      quarantinePath = `nexa-session-media-quarantine/${appointmentId}/${uploadId}`;

      const kind = claimed.kind === "photo" || claimed.kind === "voice" ? claimed.kind : "";
      const contentType = String(claimed.contentType || "").toLowerCase();
      const allowedTypes = kind === "photo" ? PHOTO_MIME_TYPES : VOICE_MIME_TYPES;
      const expectedSize = Number(claimed.expectedSize);
      const expectedDurationSeconds = Number(claimed.durationSeconds);
      if (!kind || !allowedTypes.has(contentType) || !Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > SESSION_MEDIA_MAX_FILE_BYTES) {
        throw new ApiError(400, "invalid-session-media", "Le fichier n’a pas les caractéristiques attendues.");
      }
      if (kind === "voice" && (!Number.isSafeInteger(expectedDurationSeconds) || expectedDurationSeconds < 1 || expectedDurationSeconds > claimed.maximumVoiceSeconds)) {
        throw new ApiError(400, "invalid-session-media-duration", "La durée du message vocal n’est pas valide.");
      }
      const quarantineFile = bucket.file(quarantinePath);
      const [exists] = await quarantineFile.exists();
      if (!exists) throw new ApiError(400, "session-media-file-missing", "Le fichier n’a pas été téléversé. Sélectionnez-le de nouveau.");
      const [metadata] = await quarantineFile.getMetadata();
      const objectSize = Number(metadata.size || 0);
      const customMetadata = metadata.metadata && typeof metadata.metadata === "object" ? metadata.metadata : {};
      const downloadToken = Object.entries(customMetadata).find(([key]) => key.toLowerCase() === "firebasestoragedownloadtokens")?.[1];
      if (String(metadata.contentType || "").toLowerCase() !== contentType || objectSize !== expectedSize || objectSize < 1 || objectSize > SESSION_MEDIA_MAX_FILE_BYTES || (downloadToken && String(downloadToken).length > 0)) {
        throw new ApiError(400, "session-media-file-mismatch", "Le fichier ne correspond pas au format ou à la taille annoncés.");
      }
      if (kind === "voice" && Number(customMetadata.durationSeconds) !== expectedDurationSeconds) {
        throw new ApiError(400, "session-media-duration-mismatch", "La durée déclarée ne correspond pas au fichier envoyé.");
      }
      const [contents] = await quarantineFile.download();
      const scan = await scanSessionMediaFile({
        fileBuffer: contents,
        contentType,
        kind,
        expectedDurationSeconds,
        maximumDurationSeconds: claimed.maximumVoiceSeconds,
      }, ApiError);

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
      const now = Date.now();
      await db.runTransaction(async (transaction) => {
        const reads = [transaction.get(uploadRef), transaction.get(appointmentRef)];
        const providerRef = user.uid === claimed.providerUid ? db.collection("providerProfiles").doc(user.uid) : null;
        const patientMessageQuery = user.uid === claimed.patientUid
          ? db.collection("sessionMessages").where("appointmentId", "==", appointmentId).where("senderUid", "==", user.uid)
          : null;
        if (providerRef) reads.push(transaction.get(providerRef));
        if (patientMessageQuery) reads.push(transaction.get(patientMessageQuery));
        const snapshots = await Promise.all(reads);
        const freshUpload = snapshots[0];
        const freshAppointment = snapshots[1];
        const providerSnapshot = providerRef ? snapshots[2] : null;
        const patientMessagesSnapshot = patientMessageQuery ? snapshots[providerRef ? 3 : 2] : null;
        if (!freshUpload.exists || freshUpload.get("ownerUid") !== user.uid || freshUpload.get("status") !== "SCANNING" || !isUnexpired(freshUpload.get("expiresAt"), now) || !freshAppointment.exists) {
          throw new ApiError(409, "session-media-upload-stale", "La session de dépôt a expiré ou a été annulée.");
        }
        const appointment = freshAppointment.data() || {};
        if (!isInteractive(appointment, now) || appointment.patientUid !== claimed.patientUid || appointment.providerUid !== claimed.providerUid ||
          (appointment.patientUid !== user.uid && appointment.providerUid !== user.uid)) {
          throw new ApiError(409, "session-not-interactive", "La séance s’est terminée avant la transmission du média.");
        }
        if (providerRef && (!providerSnapshot?.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true)) {
          throw new ApiError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à accéder à cette séance.");
        }
        if (user.uid === appointment.patientUid) {
          const rights = appointment.consultationRights && typeof appointment.consultationRights === "object" ? appointment.consultationRights : {};
          const cap = boundedLimit(kind === "photo" ? rights.maxPhotos : rights.maxVoiceMessages);
          if (!cap) throw new ApiError(403, "session-media-not-included", "Cette consultation ne comprend pas l’envoi de ce type de média.");
          const used = (patientMessagesSnapshot?.docs || []).filter((document) => document.get("kind") === kind && document.get("antivirusStatus") === "CLEAN" && isUnexpired(document.get("expiresAt"), now)).length;
          if (used >= cap) throw new ApiError(409, "session-media-limit-reached", kind === "photo" ? "La limite de photos de cette séance est atteinte." : "La limite de messages vocaux de cette séance est atteinte.");
        }
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
          durationSeconds: kind === "voice" ? scan.durationSeconds : null,
          antivirusStatus: "CLEAN",
          antivirusScannerVersion: scan.scannerVersion,
          antivirusScannedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
          expiresAt: new Date(now + SESSION_MESSAGE_RETENTION_MS),
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
      await createNexaNotification(recipientUid, `session-message:${messageRef.id}`, {
        type: "session_message",
        title: "Nouveau message de consultation",
        body: kind === "photo" ? "Une photo vous attend dans votre séance NEXA." : "Un message vocal vous attend dans votre séance NEXA.",
        url: `/teleconsultation.html?appointmentId=${encodeURIComponent(appointmentId)}`,
      }, appointmentId).catch((error) => logger.warn("NEXA session media notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, messageId: messageRef.id, kind, status: "CLEAN" });
    } catch (error) {
      const cleanupPaths = [quarantinePath, ...(!messageCreated && finalPath ? [finalPath] : [])].filter(Boolean);
      await Promise.allSettled(cleanupPaths.map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
      if (scanClaimed && uploadId && userUid) {
        const uploadRef = db.collection("sessionMessageMediaUploads").doc(uploadId);
        await db.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(uploadRef);
          if (snapshot.exists && snapshot.get("ownerUid") === userUid && snapshot.get("appointmentId") === appointmentId && snapshot.get("status") === "SCANNING") {
            transaction.update(uploadRef, { status: "REJECTED", rejectedAt: FieldValue.serverTimestamp(), expiresAt: new Date() });
          }
        }).catch(() => undefined);
      }
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA session media scan failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "session-media-submit-unavailable", "Le média n’a pas pu être contrôlé et transmis.");
    }
  });

  const nexaSessionMediaRead = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") {
      res.set("Allow", "GET, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "session-media-read", 30, 60_000);
      const appointmentId = typeof req.query.appointmentId === "string" ? req.query.appointmentId.trim() : "";
      const messageId = typeof req.query.messageId === "string" ? req.query.messageId.trim() : "";
      if (!APPOINTMENT_ID_PATTERN.test(appointmentId) || !MEDIA_ID_PATTERN.test(messageId)) throw new ApiError(400, "invalid-session-media", "La référence du média n’est pas valide.");
      const appointment = await loadSession(db, appointmentId, user.uid, false, ApiError);
      const messageSnapshot = await db.collection("sessionMessages").doc(messageId).get();
      if (!messageSnapshot.exists) throw new ApiError(404, "session-media-not-found", "Ce média n’est plus disponible.");
      const message = messageSnapshot.data() || {};
      if (message.appointmentId !== appointmentId || message.patientUid !== appointment.patientUid || message.providerUid !== appointment.providerUid ||
        (message.patientUid !== user.uid && message.providerUid !== user.uid) || !["photo", "voice"].includes(String(message.kind))) {
        throw new ApiError(404, "session-media-not-found", "Ce média n’est plus disponible.");
      }
      if (!Number.isFinite(timestampMillis(message.expiresAt)) || !isUnexpired(message.expiresAt, Date.now()) || message.antivirusStatus !== "CLEAN") {
        throw new ApiError(409, "session-media-not-cleared", "Ce média est expiré ou n’a pas reçu un verdict antivirus valide.");
      }
      const expectedPath = `nexa-session-media/${appointmentId}/${messageId}`;
      if (message.storagePath !== expectedPath || !SESSION_MEDIA_MIME_TYPES.has(String(message.contentType || ""))) {
        throw new ApiError(409, "session-media-path-invalid", "Ce média n’est pas correctement relié à la séance.");
      }
      const file = bucket.file(expectedPath);
      const [metadata] = await file.getMetadata();
      const size = Number(metadata.size || 0);
      const customMetadata = metadata.metadata && typeof metadata.metadata === "object" ? metadata.metadata : {};
      const downloadToken = Object.entries(customMetadata).find(([key]) => key.toLowerCase() === "firebasestoragedownloadtokens")?.[1];
      if (String(metadata.contentType || "") !== message.contentType || size !== Number(message.size) || size < 1 || size > SESSION_MEDIA_MAX_FILE_BYTES || customMetadata.nexaAntivirusStatus !== "CLEAN" || (downloadToken && String(downloadToken).length > 0)) {
        throw new ApiError(409, "session-media-object-invalid", "Le fichier ne correspond plus aux vérifications de sécurité.");
      }
      const fileName = safeText(message.fileName, 120).replace(/[\r\n"\\]/g, "_") || (message.kind === "photo" ? "photo" : "message-vocal");
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
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, url, expiresInSeconds: 300, kind: message.kind });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA session media read failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "session-media-unavailable", "Le média de cette séance n’est pas accessible.");
    }
  });

  const nexaCleanupSessionMessages = onSchedule({ schedule: "every 15 minutes", region: REGION, maxInstances: 1 }, async () => {
    const cutoff = new Date();
    const expiredMessages = await db.collection("sessionMessages")
      .where("expiresAt", "<=", cutoff)
      .orderBy("expiresAt", "asc")
      .limit(400)
      .get();
    const bucket = storage.bucket(process.env.NEXA_STORAGE_BUCKET || "nexaris-1339d.firebasestorage.app");
    let deletedMessages = 0;
    let failedMessages = 0;
    await Promise.all(expiredMessages.docs.map(async (document) => {
      const appointmentId = String(document.get("appointmentId") || "");
      const storagePath = document.get("storagePath");
      if (typeof storagePath === "string") {
        if (storagePath !== `nexa-session-media/${appointmentId}/${document.id}`) {
          failedMessages += 1;
          logger.warn("NEXA session media cleanup skipped an unexpected object path", { errorName: "unexpected-storage-path" });
          return;
        }
        try {
          await bucket.file(storagePath).delete({ ignoreNotFound: true });
        } catch (error) {
          failedMessages += 1;
          logger.warn("NEXA session media cleanup could not delete an object", { errorName: error instanceof Error ? error.name : "unknown-error" });
          return;
        }
      }
      try {
        await document.ref.delete();
        deletedMessages += 1;
      } catch (error) {
        failedMessages += 1;
        logger.warn("NEXA session message cleanup could not delete a record", { errorName: error instanceof Error ? error.name : "unknown-error" });
      }
    }));

    const expiredUploads = await db.collection("sessionMessageMediaUploads")
      .where("expiresAt", "<=", cutoff)
      .orderBy("expiresAt", "asc")
      .limit(400)
      .get();
    let deletedUploads = 0;
    await Promise.all(expiredUploads.docs.map(async (document) => {
      const appointmentId = String(document.get("appointmentId") || "");
      const expectedPath = `nexa-session-media-quarantine/${appointmentId}/${document.id}`;
      if (document.get("storagePath") !== expectedPath) {
        logger.warn("NEXA expired session upload cleanup skipped an unexpected object path", { errorName: "unexpected-storage-path" });
        return;
      }
      try {
        await bucket.file(expectedPath).delete({ ignoreNotFound: true });
        await document.ref.delete();
        deletedUploads += 1;
      } catch (error) {
        logger.warn("NEXA expired session upload cleanup could not remove an item", { errorName: error instanceof Error ? error.name : "unknown-error" });
      }
    }));
    logger.info("NEXA session message retention pass completed", {
      expiredMessageRecords: expiredMessages.size,
      deletedMessages,
      failedMessages,
      expiredUploadRecords: expiredUploads.size,
      deletedUploads,
    });
  });

  return { nexaSessionMessages, nexaSessionMediaUpload, nexaSessionMediaFinalize, nexaSessionMediaRead, nexaCleanupSessionMessages };
};
