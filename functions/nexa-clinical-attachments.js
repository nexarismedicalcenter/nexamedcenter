"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { Timestamp } = require("firebase-admin/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

const REGION = "us-east4";
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const SESSION_MS = 15 * 60_000;
const POLICY_MS = 10 * 60_000;
const CLEANUP_GRACE_MS = 15 * 60_000;
const ACCEPTED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
const CLEANUP_SESSION_STATES = new Set(["OPEN", "CANCELLED", "FAILED", "REJECTED", "SUBMITTED", "SCANNING", "CLEANING"]);
const TEXT_FIELDS = [
  "consultationReason", "history", "relevantHistory", "allergies", "currentTreatments", "symptoms",
  "clinicalObservations", "clinicalAssessment", "diagnoses", "carePlan", "recommendations",
  "followUp", "additionalNotes",
];

function clean(value, maximum = 180) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum)
    : "";
}

function validId(value, minimum = 10, maximum = 200) {
  return typeof value === "string" && new RegExp("^[A-Za-z0-9_-]{" + minimum + "," + maximum + "}$").test(value);
}

function millis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

function iso(value) {
  const time = millis(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function activeStandaloneAccess(record, now = Date.now()) {
  const grantedAt = millis(record.accessGrantedAt);
  const expiresAt = millis(record.accessExpiresAt);
  return record.accessRevoked !== true && Number.isFinite(grantedAt) && Number.isFinite(expiresAt) &&
    grantedAt > 0 && now >= grantedAt && now < expiresAt;
}

function activeAppointmentAccess(appointment, now = Date.now()) {
  if (appointment.paymentStatus !== "PAID") return false;
  const status = String(appointment.status || "").toUpperCase();
  const homeVisitClosed = appointment.bookingType === "home_visit" &&
    appointment.homeVisitMissionStatus === "COMPLETED" && status === "COMPLETED";
  const homeVisitStarted = appointment.bookingType === "home_visit" &&
    ["CONFIRMED", "COMPLETED"].includes(status) && millis(appointment.effectiveConsultationStartedAt) > 0;
  const startedAt = homeVisitStarted ? millis(appointment.effectiveConsultationStartedAt)
    : homeVisitClosed ? millis(appointment.homeVisitMissionClosedAt)
    : ["IN_PROGRESS", "COMPLETED"].includes(status) ? millis(appointment.effectiveConsultationStartedAt) : Number.NaN;
  return Number.isFinite(startedAt) && startedAt > 0 && now >= startedAt && now < startedAt + 24 * 60 * 60_000;
}

function parseBody(req, maximumBytes) {
  if (Buffer.isBuffer(req.rawBody) && req.rawBody.byteLength > maximumBytes) return { tooLarge: true };
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return { value: req.body };
  if (!Buffer.isBuffer(req.rawBody)) return { value: null };
  try {
    const value = JSON.parse(req.rawBody.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? { value } : { value: null };
  } catch { return { value: null }; }
}

function safeAttachment(value, recordId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = typeof value.id === "string" ? value.id : "";
  const contentType = typeof value.contentType === "string" ? value.contentType.toLowerCase() : "";
  const size = Number(value.size);
  const sha256Hash = typeof value.sha256Hash === "string" ? value.sha256Hash : "";
  const storagePath = typeof value.storagePath === "string" ? value.storagePath : "";
  if (!validId(id, 10, 80) || !ACCEPTED_TYPES.has(contentType) || !Number.isSafeInteger(size) ||
    size < 1 || size > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(sha256Hash) ||
    value.antivirusStatus !== "CLEAN" || storagePath !== "nexa-clinical-records/" + recordId + "/" + id) return null;
  return {
    id,
    originalFileName: clean(value.originalFileName) || "Pièce jointe clinique",
    contentType,
    size,
    sha256Hash,
    storagePath,
    antivirusStatus: "CLEAN",
    scannerVersion: clean(value.scannerVersion, 80) || "unknown",
    uploadedAt: typeof value.uploadedAt === "string" ? value.uploadedAt : "",
  };
}

function publicAttachment(value, recordId) {
  const item = safeAttachment(value, recordId);
  if (!item) return null;
  return {
    id: item.id,
    originalFileName: item.originalFileName,
    contentType: item.contentType,
    size: item.size,
    sha256Hash: item.sha256Hash,
    uploadedAt: item.uploadedAt,
  };
}

function revisionRef(recordRef, version) {
  return recordRef.collection("versions").doc(String(version).padStart(8, "0"));
}

function revisionPayload(data, actorUid, changeType) {
  return {
    version: Number(data.version) || 1,
    status: data.status || "DRAFT",
    clinicalContent: data.clinicalContent || {},
    attachments: Array.isArray(data.attachments) ? data.attachments : [],
    actorUid,
    createdAt: data.updatedAt || data.createdAt || Timestamp.now(),
    changeType,
    ...(data.signature ? { signature: data.signature } : {}),
    ...(data.documentHash ? { documentHash: data.documentHash } : {}),
  };
}

async function scannerIdentityToken(audience, localScanner, ApiError) {
  if (localScanner) return "";
  const identityUrl = new URL("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity");
  identityUrl.searchParams.set("audience", audience);
  identityUrl.searchParams.set("format", "full");
  let response;
  try {
    response = await fetch(identityUrl, {
      headers: { "Metadata-Flavor": "Google" },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new ApiError(503, "scanner-identity-unavailable", "L’analyse de sécurité n’est pas configurée. Aucun fichier n’a été transmis.");
  }
  if (!response.ok) throw new ApiError(503, "scanner-identity-unavailable", "L’analyse de sécurité n’est pas configurée. Aucun fichier n’a été transmis.");
  const token = (await response.text()).trim();
  if (!token || token.length > 20_000) throw new ApiError(503, "scanner-identity-unavailable", "L’analyse de sécurité n’est pas configurée. Aucun fichier n’a été transmis.");
  return token;
}

async function scanClinicalFile(fileBuffer, contentType, ApiError) {
  const configuredUrl = process.env.NEXA_MALWARE_SCANNER_URL || "";
  const configuredAudience = process.env.NEXA_MALWARE_SCANNER_AUDIENCE || "";
  let target;
  try { target = new URL(configuredUrl); } catch {
    throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité est temporairement indisponible. Réessayez plus tard.");
  }
  const localScanner = process.env.NODE_ENV !== "production" && target.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if ((target.protocol !== "https:" && !localScanner) || target.username || target.password || target.search ||
    target.hash || !["", "/"].includes(target.pathname)) {
    throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité est temporairement indisponible. Réessayez plus tard.");
  }
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length < 1 || fileBuffer.length > MAX_FILE_BYTES || !ACCEPTED_TYPES.has(contentType)) {
    throw new ApiError(400, "invalid-clinical-attachment", "Le fichier ne respecte pas les limites de sécurité NEXA.");
  }
  let audience = "";
  if (!localScanner) {
    let parsedAudience;
    try { parsedAudience = new URL(configuredAudience); } catch { /* fail closed below */ }
    if (!parsedAudience || parsedAudience.origin !== target.origin || !["", "/"].includes(parsedAudience.pathname) ||
      parsedAudience.search || parsedAudience.hash || parsedAudience.username || parsedAudience.password) {
      throw new ApiError(503, "scanner-audience-not-configured", "L’identité de l’analyse de sécurité n’est pas configurée.");
    }
    audience = configuredAudience;
  }
  const token = await scannerIdentityToken(audience, localScanner, ApiError);
  let response;
  try {
    response = await fetch(new URL("/scan", target.origin), {
      method: "POST",
      headers: { "Content-Type": contentType, ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: new Blob([new Uint8Array(fileBuffer)], { type: contentType }),
      cache: "no-store",
      signal: AbortSignal.timeout(40_000),
    });
  } catch {
    throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité est temporairement indisponible. Aucun fichier n’a été transmis.");
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 415 || response.status === 413) throw new ApiError(400, "invalid-clinical-attachment", "Le fichier ne correspond pas à son type ou dépasse la taille permise.");
    throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité est temporairement indisponible. Aucun fichier n’a été transmis.");
  }
  if (result.status === "INFECTED") throw new ApiError(422, "malware-detected", "Le fichier a été bloqué par l’analyse antivirus.");
  if (result.status !== "CLEAN") throw new ApiError(503, "malware-scanner-invalid-response", "L’analyse de sécurité n’a pas confirmé que le fichier est propre.");
  return { scannerVersion: typeof result.scannerVersion === "string" ? result.scannerVersion.slice(0, 80) : "unknown" };
}

module.exports = function createNexaClinicalAttachmentFunctions(dependencies) {
  const { db, FieldValue, storage, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger } = dependencies;
  const bucket = storage.bucket(process.env.NEXA_STORAGE_BUCKET || "nexaris-1339d.firebasestorage.app");

  function prepare(req, res, methods) {
    res.set("Cache-Control", "no-store, max-age=0");
    if (!setCors(req, res)) { fail(res, 403, "origin-not-allowed", "Origine non autorisée."); return false; }
    if (req.method === "OPTIONS") { res.status(204).end(); return false; }
    if (!methods.includes(req.method)) {
      res.set("Allow", methods.join(", ") + ", OPTIONS");
      fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
      return false;
    }
    return true;
  }

  async function requireDoctor(req) {
    const user = await requireUser(req);
    await requireAppCheckToken(req);
    const provider = await db.collection("providerProfiles").doc(user.uid).get();
    if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
      throw new ApiError(403, "verified-doctor-required", "Seul le médecin NEXA vérifié peut gérer les pièces jointes.");
    }
    return user;
  }

  async function verifyEditableRecord(transaction, recordId, uid) {
    const recordRef = db.collection("electronicPatientRecords").doc(recordId);
    const appointmentRef = db.collection("appointments").doc(recordId);
    const providerRef = db.collection("providerProfiles").doc(uid);
    const [record, appointment, provider] = await Promise.all([
      transaction.get(recordRef), transaction.get(appointmentRef), transaction.get(providerRef),
    ]);
    if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
      throw new ApiError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à gérer les pièces jointes.");
    }
    if (!record.exists) throw new ApiError(404, "clinical-record-not-found", "Ce dossier clinique n’est pas accessible.");
    const data = record.data() || {};
    if (data.recordType === "STANDALONE") {
      if (data.recordId !== recordId || data.providerUid !== uid) throw new ApiError(404, "clinical-record-not-found", "Ce dossier clinique n’est pas accessible.");
      if (!activeStandaloneAccess(data)) throw new ApiError(403, "clinical-access-expired", "L’autorisation patient a expiré ou a été révoquée.");
    } else {
      if (!appointment.exists || data.appointmentId !== recordId || data.providerUid !== uid ||
        data.patientUid !== appointment.get("patientUid") || appointment.get("providerUid") !== uid ||
        appointment.get("providerType") !== "doctor" || appointment.get("paymentStatus") !== "PAID" ||
        !["IN_PROGRESS", "COMPLETED"].includes(String(appointment.get("status") || "").toUpperCase())) {
        throw new ApiError(404, "clinical-record-not-found", "Ce dossier de consultation n’est pas accessible.");
      }
      if (!activeAppointmentAccess(appointment.data() || {})) throw new ApiError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée.");
    }
    if (!["DRAFT"].includes(String(data.status || "").toUpperCase())) {
      throw new ApiError(409, "record-immutable", "Le dossier est finalisé. Il n’est plus possible d’y ajouter ou retirer des pièces jointes.");
    }
    return { recordRef, record, appointmentRef };
  }

  async function writeAttachmentRevision(transaction, recordRef, current, attachments, uid, changeType) {
    const currentVersion = Number(current.version) || 1;
    const nextVersion = currentVersion + 1;
    const oldRef = revisionRef(recordRef, currentVersion);
    const nextRef = revisionRef(recordRef, nextVersion);
    const [oldRevision, nextRevision] = await Promise.all([transaction.get(oldRef), transaction.get(nextRef)]);
    if (nextRevision.exists) throw new ApiError(409, "record-version-conflict", "Le dossier vient d’être modifié. Rechargez-le puis réessayez.");
    if (!oldRevision.exists) transaction.create(oldRef, revisionPayload(current, typeof current.updatedBy === "string" ? current.updatedBy : uid, "INITIAL"));
    transaction.create(nextRef, {
      version: nextVersion,
      status: String(current.status || "DRAFT"),
      clinicalContent: current.clinicalContent || {},
      attachments,
      actorUid: uid,
      createdAt: FieldValue.serverTimestamp(),
      changeType,
      ...(current.signature ? { signature: current.signature } : {}),
      ...(current.documentHash ? { documentHash: current.documentHash } : {}),
    });
    return nextVersion;
  }

  const nexaClinicalRecordAttachments = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!prepare(req, res, ["GET", "POST", "DELETE"])) return;
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      const parsedRequest = ["POST", "DELETE"].includes(req.method) ? parseBody(req, 4_096) : null;
      if (parsedRequest && parsedRequest.tooLarge) throw new ApiError(413, "request-too-large", "La demande est trop volumineuse.");
      const requestBody = parsedRequest ? parsedRequest.value : null;
      const recordId = req.method === "GET"
        ? typeof req.query.recordId === "string" ? req.query.recordId.trim() : ""
        : requestBody && typeof requestBody.recordId === "string" ? requestBody.recordId.trim() : "";
      if (!validId(recordId)) throw new ApiError(400, "invalid-record-id", "La référence du dossier n’est pas valide.");

      if (req.method === "GET") {
        await enforceUserRateLimit(user.uid, "clinical-attachment-read", 20, 5 * 60_000);
        const attachmentId = typeof req.query.attachmentId === "string" ? req.query.attachmentId.trim() : "";
        if (!validId(attachmentId, 10, 80)) throw new ApiError(400, "invalid-clinical-attachment", "La référence de la pièce jointe n’est pas valide.");
        const recordRef = db.collection("electronicPatientRecords").doc(recordId);
        const [recordSnapshot, appointmentSnapshot] = await Promise.all([
          recordRef.get(), db.collection("appointments").doc(recordId).get(),
        ]);
        if (!recordSnapshot.exists) throw new ApiError(404, "clinical-attachment-not-found", "Cette pièce jointe n’est pas disponible.");
        const data = recordSnapshot.data() || {};
        const standalone = data.recordType === "STANDALONE";
        if (standalone ? data.recordId !== recordId : (!appointmentSnapshot.exists ||
          data.appointmentId !== recordId || data.patientUid !== appointmentSnapshot.get("patientUid") ||
          data.providerUid !== appointmentSnapshot.get("providerUid"))) {
          throw new ApiError(404, "clinical-attachment-not-found", "Cette pièce jointe n’est pas disponible.");
        }

        if (data.patientUid === user.uid) {
          const patient = await db.collection("patientProfiles").doc(user.uid).get();
          if (!patient.exists || patient.get("role") !== "patient" || patient.get("profileComplete") !== true ||
            !["FINALIZED", "SIGNED"].includes(String(data.status || "").toUpperCase())) {
            throw new ApiError(404, "clinical-attachment-not-found", "Cette pièce jointe n’est pas disponible.");
          }
        } else {
          const provider = await db.collection("providerProfiles").doc(user.uid).get();
          if (data.providerUid !== user.uid || !provider.exists || provider.get("status") !== "verified" ||
            provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
            throw new ApiError(404, "clinical-attachment-not-found", "Cette pièce jointe n’est pas disponible.");
          }
          if (standalone ? !activeStandaloneAccess(data) : !activeAppointmentAccess(appointmentSnapshot.data() || {})) {
            throw new ApiError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée.");
          }
        }

        const attachments = Array.isArray(data.attachments) ? data.attachments : [];
        const attachment = attachments.map((item) => safeAttachment(item, recordId)).find((item) => item && item.id === attachmentId);
        if (!attachment) throw new ApiError(404, "clinical-attachment-not-found", "Cette pièce jointe n’est pas disponible.");
        const file = bucket.file(attachment.storagePath);
        const [metadata] = await file.getMetadata();
        const custom = metadata.metadata && typeof metadata.metadata === "object" ? metadata.metadata : {};
        const downloadToken = Object.entries(custom).find(([key]) => key.toLowerCase() === "firebasestoragedownloadtokens");
        if (String(metadata.contentType || "").toLowerCase() !== attachment.contentType ||
          Number(metadata.size || 0) !== attachment.size || custom.nexaAntivirusStatus !== "CLEAN" ||
          custom.nexaSha256 !== attachment.sha256Hash || (downloadToken && String(downloadToken[1] || "").length > 0)) {
          throw new ApiError(409, "clinical-attachment-object-invalid", "Le fichier ne correspond plus aux vérifications de sécurité.");
        }
        const fileName = attachment.originalFileName.replace(/[\r\n"\\]/g, "_").slice(0, 120) || "piece-jointe-clinique";
        const [url] = await file.getSignedUrl({
          action: "read",
          expires: Date.now() + 5 * 60_000,
          responseDisposition: "attachment; filename=\"" + fileName + "\"",
        });
        await db.collection("clinicalAuditLogs").doc().create({
          actorUid: user.uid,
          action: "clinical_record_attachment_accessed",
          appointmentId: standalone ? null : recordId,
          recordId,
          attachmentId,
          createdAt: FieldValue.serverTimestamp(),
        });
        return res.status(200).json({
          ok: true,
          url,
          expiresInSeconds: 300,
          attachment: { id: attachment.id, originalFileName: attachment.originalFileName, contentType: attachment.contentType, size: attachment.size },
        });
      }

      if (req.method === "POST") {
        await enforceUserRateLimit(user.uid, "clinical-attachment-write", 15, 10 * 60_000);
        const input = requestBody;
        if (!input || Object.keys(input).some((key) => !["action", "recordId", "fileName", "contentType", "size", "uploadId"].includes(key))) {
          throw new ApiError(400, "invalid-request", "La demande de pièce jointe n’est pas valide.");
        }
        const doctorProfile = await db.collection("providerProfiles").doc(user.uid).get();
        if (!doctorProfile.exists || doctorProfile.get("status") !== "verified" || doctorProfile.get("type") !== "doctor" || doctorProfile.get("clinicalCredentialsVerified") !== true) {
          throw new ApiError(403, "verified-doctor-required", "Seul le médecin NEXA vérifié peut gérer les pièces jointes.");
        }

        if (input.action === "start") {
          const fileName = clean(input.fileName, 180);
          const contentType = typeof input.contentType === "string" ? input.contentType.toLowerCase() : "";
          const size = Number(input.size);
          if (!fileName || !ACCEPTED_TYPES.has(contentType) || !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) {
            throw new ApiError(400, "invalid-clinical-attachment", "Choisissez un PDF, JPEG ou PNG de 15 Mio maximum.");
          }
          const sessionRef = db.collection("clinicalRecordUploadSessions").doc(randomBytes(18).toString("base64url"));
          const sessionId = sessionRef.id;
          const expiresAtMs = Date.now() + SESSION_MS;
          const quarantinePath = "nexa-clinical-record-quarantine/" + recordId + "/" + sessionId;
          await db.runTransaction(async (transaction) => {
            const { record } = await verifyEditableRecord(transaction, recordId, user.uid);
            const attachments = Array.isArray(record.get("attachments")) ? record.get("attachments") : [];
            if (attachments.length >= MAX_ATTACHMENTS) throw new ApiError(409, "clinical-attachment-limit", "Un dossier peut contenir au maximum 10 pièces jointes.");
            const pending = await transaction.get(db.collection("clinicalRecordUploadSessions")
              .where("recordId", "==", recordId).where("providerUid", "==", user.uid).where("status", "==", "OPEN").limit(10));
            if (pending.size >= 3) throw new ApiError(409, "clinical-attachment-upload-limit", "Terminez ou annulez les dépôts déjà ouverts avant d’en commencer un autre.");
            transaction.create(sessionRef, {
              recordId,
              appointmentId: record.get("recordType") === "STANDALONE" ? null : recordId,
              patientUid: record.get("patientUid"),
              providerUid: user.uid,
              originalFileName: fileName,
              contentType,
              expectedSize: size,
              storagePath: quarantinePath,
              status: "OPEN",
              createdAt: FieldValue.serverTimestamp(),
              expiresAt: Timestamp.fromMillis(expiresAtMs),
              cleanupAfterAt: Timestamp.fromMillis(expiresAtMs + CLEANUP_GRACE_MS),
            });
          });
          let policy;
          try {
            [policy] = await bucket.file(quarantinePath).generateSignedPostPolicyV4({
              expires: Date.now() + POLICY_MS,
              fields: {
                "Content-Type": contentType,
                success_action_status: "201",
                "x-goog-if-generation-match": "0",
                "x-goog-meta-firebasestoragedownloadtokens": "",
              },
              conditions: [
                ["content-length-range", 1, MAX_FILE_BYTES],
                ["eq", "$key", quarantinePath],
                ["eq", "$Content-Type", contentType],
                ["eq", "$success_action_status", "201"],
                ["eq", "$x-goog-if-generation-match", "0"],
                ["eq", "$x-goog-meta-firebasestoragedownloadtokens", ""],
              ],
            });
          } catch {
            await sessionRef.set({ status: "FAILED", closedAt: FieldValue.serverTimestamp() }, { merge: true });
            throw new ApiError(503, "secure-upload-unavailable", "Le téléversement sécurisé est indisponible. Le dossier n’a pas été modifié.");
          }
          return res.status(200).json({ ok: true, uploadId: sessionId, uploadUrl: policy.url, fields: policy.fields, expiresAt: expiresAtMs });
        }

        if (input.action !== "finalize") throw new ApiError(400, "invalid-attachment-action", "Action de pièce jointe invalide.");
        const uploadId = typeof input.uploadId === "string" ? input.uploadId.trim() : "";
        if (!validId(uploadId, 10, 80)) throw new ApiError(400, "invalid-upload-session", "La session de dépôt n’est pas valide.");
        const sessionRef = db.collection("clinicalRecordUploadSessions").doc(uploadId);
        const preview = await sessionRef.get();
        if (!preview.exists || preview.get("recordId") !== recordId || preview.get("providerUid") !== user.uid || preview.get("status") !== "OPEN") {
          throw new ApiError(404, "upload-session-not-found", "Cette session de dépôt n’est plus disponible.");
        }
        if (millis(preview.get("expiresAt")) <= Date.now()) throw new ApiError(410, "upload-session-expired", "La session de dépôt a expiré. Sélectionnez de nouveau le fichier.");
        const quarantinePath = "nexa-clinical-record-quarantine/" + recordId + "/" + uploadId;
        if (preview.get("storagePath") !== quarantinePath) throw new ApiError(409, "upload-session-path-invalid", "Le fichier ne correspond pas à ce dossier.");

        let ownsScanLock = false;
        let finalPath = "";
        try {
          const claim = await db.runTransaction(async (transaction) => {
            const { recordRef, record } = await verifyEditableRecord(transaction, recordId, user.uid);
            const freshSession = await transaction.get(sessionRef);
            if (!freshSession.exists || freshSession.get("status") !== "OPEN" ||
              freshSession.get("providerUid") !== user.uid || freshSession.get("recordId") !== recordId ||
              millis(freshSession.get("expiresAt")) <= Date.now()) {
              throw new ApiError(409, "upload-session-locked", "La session de dépôt est expirée, annulée ou déjà utilisée.");
            }
            const attachments = Array.isArray(record.get("attachments")) ? record.get("attachments") : [];
            if (attachments.length >= MAX_ATTACHMENTS) throw new ApiError(409, "clinical-attachment-limit", "Un dossier peut contenir au maximum 10 pièces jointes.");
            transaction.update(sessionRef, { status: "SCANNING", scanningStartedAt: FieldValue.serverTimestamp() });
            return {
              recordRef,
              fileName: String(freshSession.get("originalFileName") || "").slice(0, 180),
              contentType: String(freshSession.get("contentType") || "").toLowerCase(),
              expectedSize: Number(freshSession.get("expectedSize")),
            };
          });
          ownsScanLock = true;
          const object = bucket.file(quarantinePath);
          const [exists] = await object.exists();
          if (!exists) throw new ApiError(400, "clinical-attachment-file-missing", "Le fichier n’a pas été téléversé. Réessayez.");
          const [metadata] = await object.getMetadata();
          const size = Number(metadata.size || 0);
          const contentType = String(metadata.contentType || "").toLowerCase();
          const custom = metadata.metadata && typeof metadata.metadata === "object" ? metadata.metadata : {};
          const downloadToken = Object.entries(custom).find(([key]) => key.toLowerCase() === "firebasestoragedownloadtokens");
          if (contentType !== claim.contentType || size !== claim.expectedSize || size < 1 ||
            size > MAX_FILE_BYTES || (downloadToken && String(downloadToken[1] || "").length > 0)) {
            throw new ApiError(400, "clinical-attachment-metadata-invalid", "Le fichier ne correspond pas au format ou à la taille annoncés.");
          }
          const [contents] = await object.download();
          const scan = await scanClinicalFile(contents, contentType, ApiError);
          const sha256Hash = createHash("sha256").update(contents).digest("hex");
          const attachmentId = randomBytes(18).toString("base64url");
          finalPath = "nexa-clinical-records/" + recordId + "/" + attachmentId;
          await sessionRef.set({ finalStoragePath: finalPath, scanningAttachmentId: attachmentId }, { merge: true });
          await object.move(finalPath);
          const finalObject = bucket.file(finalPath);
          await finalObject.setMetadata({
            contentType,
            cacheControl: "private, no-store",
            metadata: {
              nexaAntivirusStatus: "CLEAN",
              nexaAntivirusScannerVersion: scan.scannerVersion || "unknown",
              nexaSha256: sha256Hash,
              firebaseStorageDownloadTokens: "",
            },
          });
          const attachment = {
            id: attachmentId,
            originalFileName: claim.fileName || "Pièce jointe clinique",
            contentType,
            size,
            sha256Hash,
            storagePath: finalPath,
            antivirusStatus: "CLEAN",
            scannerVersion: scan.scannerVersion || "unknown",
            uploadedAt: new Date().toISOString(),
          };
          const auditRef = db.collection("clinicalAuditLogs").doc();
          const recordVersion = await db.runTransaction(async (transaction) => {
            const { recordRef, record } = await verifyEditableRecord(transaction, recordId, user.uid);
            const session = await transaction.get(sessionRef);
            if (!session.exists || session.get("status") !== "SCANNING" || session.get("providerUid") !== user.uid ||
              session.get("recordId") !== recordId) {
              throw new ApiError(409, "clinical-attachment-session-conflict", "La session de dépôt n’est plus active.");
            }
            const current = record.data() || {};
            const existing = Array.isArray(current.attachments) ? current.attachments : [];
            if (existing.length >= MAX_ATTACHMENTS) throw new ApiError(409, "clinical-attachment-limit", "Un dossier peut contenir au maximum 10 pièces jointes.");
            const next = existing.concat([attachment]);
            const version = await writeAttachmentRevision(transaction, recordRef, current, next, user.uid, "ATTACHMENT_ADDED");
            transaction.update(recordRef, { attachments: next, version, updatedAt: FieldValue.serverTimestamp(), updatedBy: user.uid });
            transaction.update(sessionRef, { status: "SUBMITTED", attachmentId, closedAt: FieldValue.serverTimestamp() });
            transaction.create(auditRef, {
              actorUid: user.uid,
              action: "clinical_record_attachment_added",
              appointmentId: current.recordType === "STANDALONE" ? null : recordId,
              recordId,
              attachmentId,
              contentType,
              size,
              scannerVersion: scan.scannerVersion || "unknown",
              createdAt: FieldValue.serverTimestamp(),
            });
            return version;
          });
          ownsScanLock = false;
          return res.status(200).json({
            ok: true,
            attachment: publicAttachment(attachment, recordId),
            recordVersion,
          });
        } catch (error) {
          if (ownsScanLock) {
            await Promise.allSettled([quarantinePath, finalPath].filter(Boolean).map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
            await sessionRef.set({
              status: error instanceof ApiError && error.code === "malware-detected" ? "REJECTED" : "FAILED",
              closedAt: FieldValue.serverTimestamp(),
            }, { merge: true }).catch(() => undefined);
          }
          throw error;
        }
      }

      if (req.method === "DELETE") {
        await enforceUserRateLimit(user.uid, "clinical-attachment-delete", 12, 10 * 60_000);
        const input = requestBody || {};
        if (Object.keys(input).some((key) => !["recordId", "uploadId", "attachmentId"].includes(key))) {
          throw new ApiError(400, "invalid-request", "La demande de suppression n’est pas valide.");
        }
        const provider = await db.collection("providerProfiles").doc(user.uid).get();
        if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
          throw new ApiError(403, "verified-doctor-required", "Seul le médecin NEXA vérifié peut gérer les pièces jointes.");
        }
        const uploadId = typeof input.uploadId === "string" ? input.uploadId.trim() : "";
        if (uploadId) {
          if (!validId(uploadId, 10, 80)) throw new ApiError(400, "invalid-upload-session", "La session de dépôt n’est pas valide.");
          const sessionRef = db.collection("clinicalRecordUploadSessions").doc(uploadId);
          const expectedPath = "nexa-clinical-record-quarantine/" + recordId + "/" + uploadId;
          await db.runTransaction(async (transaction) => {
            const session = await transaction.get(sessionRef);
            if (!session.exists || session.get("recordId") !== recordId || session.get("providerUid") !== user.uid ||
              session.get("storagePath") !== expectedPath || session.get("status") !== "OPEN") {
              throw new ApiError(404, "upload-session-not-found", "Cette session de dépôt ne peut pas être annulée.");
            }
            transaction.update(sessionRef, { status: "CANCELLED", closedAt: FieldValue.serverTimestamp() });
          });
          return res.status(200).json({ ok: true, uploadId, status: "CANCELLED" });
        }

        const attachmentId = typeof input.attachmentId === "string" ? input.attachmentId.trim() : "";
        if (!validId(attachmentId, 10, 80)) throw new ApiError(400, "invalid-clinical-attachment", "La référence de la pièce jointe n’est pas valide.");
        const deletionRef = db.collection("clinicalRecordAttachmentDeletionQueue").doc(randomBytes(18).toString("base64url"));
        const auditRef = db.collection("clinicalAuditLogs").doc();
        let storagePath = "";
        let recordVersion = 1;
        await db.runTransaction(async (transaction) => {
          const { recordRef, record } = await verifyEditableRecord(transaction, recordId, user.uid);
          const current = record.data() || {};
          const attachments = Array.isArray(current.attachments) ? current.attachments : [];
          const attachment = attachments.map((item) => safeAttachment(item, recordId)).find((item) => item && item.id === attachmentId);
          if (!attachment) throw new ApiError(404, "clinical-attachment-not-found", "Cette pièce jointe n’est pas disponible.");
          storagePath = attachment.storagePath;
          const next = attachments.filter((item) => !item || typeof item !== "object" || item.id !== attachmentId);
          const version = await writeAttachmentRevision(transaction, recordRef, current, next, user.uid, "ATTACHMENT_REMOVED");
          recordVersion = version;
          transaction.update(recordRef, { attachments: next, version, updatedAt: FieldValue.serverTimestamp(), updatedBy: user.uid });
          transaction.create(deletionRef, {
            recordId,
            appointmentId: current.recordType === "STANDALONE" ? null : recordId,
            attachmentId,
            storagePath,
            status: "PENDING",
            cleanupAfterAt: Timestamp.now(),
            createdAt: FieldValue.serverTimestamp(),
          });
          transaction.create(auditRef, {
            actorUid: user.uid,
            action: "clinical_record_attachment_removed",
            appointmentId: current.recordType === "STANDALONE" ? null : recordId,
            recordId,
            attachmentId,
            createdAt: FieldValue.serverTimestamp(),
          });
        });
        try {
          await bucket.file(storagePath).delete({ ignoreNotFound: true });
          await deletionRef.set({ status: "DONE", completedAt: FieldValue.serverTimestamp(), cleanupAfterAt: FieldValue.delete() }, { merge: true });
        } catch (error) {
          logger.warn("NEXA clinical attachment deletion queued", { errorName: error instanceof Error ? error.name : "unknown-error" });
        }
        return res.status(200).json({ ok: true, attachmentId, removed: true, recordVersion });
      }
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA clinical attachment request failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "clinical-attachment-unavailable", "Les pièces jointes cliniques ne sont pas accessibles pour le moment.");
    }
  });

  const nexaClinicalRecordVersions = onRequest({ region: REGION }, async (req, res) => {
    if (!prepare(req, res, ["GET"])) return;
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "clinical-record-version-history", 15, 5 * 60_000);
      const recordId = typeof req.query.recordId === "string" ? req.query.recordId.trim() : "";
      if (!validId(recordId)) throw new ApiError(400, "invalid-record-id", "La référence du dossier n’est pas valide.");
      const beforeVersion = req.query.beforeVersion === undefined ? null : Number(req.query.beforeVersion);
      if (beforeVersion !== null && (!Number.isSafeInteger(beforeVersion) || beforeVersion < 2)) {
        throw new ApiError(400, "invalid-version-cursor", "Le repère d’historique n’est pas valide.");
      }
      const limitRaw = Number(req.query.limit || 20);
      const limit = Number.isSafeInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20;
      const recordRef = db.collection("electronicPatientRecords").doc(recordId);
      const [record, appointment, provider] = await Promise.all([
        recordRef.get(), db.collection("appointments").doc(recordId).get(), db.collection("providerProfiles").doc(user.uid).get(),
      ]);
      const data = record.data() || {};
      if (!record.exists || data.providerUid !== user.uid || !provider.exists || provider.get("status") !== "verified" ||
        provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
        throw new ApiError(404, "clinical-record-not-found", "L’historique de ce dossier n’est pas disponible.");
      }
      if (data.recordType === "STANDALONE") {
        if (data.recordId !== recordId || !activeStandaloneAccess(data)) throw new ApiError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée.");
      } else if (!appointment.exists || appointment.get("providerUid") !== user.uid || appointment.get("providerType") !== "doctor" ||
        appointment.get("paymentStatus") !== "PAID" || !activeAppointmentAccess(appointment.data() || {}) ||
        data.appointmentId !== recordId || data.patientUid !== appointment.get("patientUid")) {
        throw new ApiError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée.");
      }
      const versionsRef = recordRef.collection("versions");
      const query = beforeVersion === null ? versionsRef.orderBy("version", "desc")
        : versionsRef.where("version", "<", beforeVersion).orderBy("version", "desc");
      const snapshot = await query.limit(limit).get();
      const versions = snapshot.docs.map((document) => {
        const version = document.data() || {};
        const content = version.clinicalContent && typeof version.clinicalContent === "object" && !Array.isArray(version.clinicalContent) ? version.clinicalContent : {};
        const vitals = content.patientVitals && typeof content.patientVitals === "object" && !Array.isArray(content.patientVitals) ? content.patientVitals : {};
        const clinicalContent = {};
        for (const field of TEXT_FIELDS) clinicalContent[field] = clean(content[field], 5_000);
        clinicalContent.patientVitals = Object.fromEntries(["systolic", "diastolic", "heartRate", "respiratoryRate", "spo2", "glycemia", "temperature", "weight", "height", "weightUnit", "heightUnit"]
          .map((field) => [field, typeof vitals[field] === "number" && Number.isFinite(vitals[field]) ? vitals[field] : clean(vitals[field], 10)]));
        clinicalContent.medications = Array.isArray(content.medications) ? content.medications.slice(0, 50).flatMap((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
          const item = entry;
          const name = clean(item.name, 180);
          return name ? [{ name, dosage: clean(item.dosage, 120), form: clean(item.form, 120), route: clean(item.route, 120), quantity: typeof item.quantity === "number" && Number.isFinite(item.quantity) ? item.quantity : null, instructions: clean(item.instructions, 300), duration: clean(item.duration, 120) }] : [];
        }) : [];
        for (const field of ["laboratoryTests", "imagingExams"]) clinicalContent[field] = Array.isArray(content[field]) ? content[field].slice(0, 50).map((entry) => clean(entry, 250)).filter(Boolean) : [];
        const attachments = Array.isArray(version.attachments) ? version.attachments.slice(0, MAX_ATTACHMENTS)
          .map((entry) => publicAttachment(entry, recordId)).filter(Boolean) : [];
        return {
          version: Number(version.version) || 0,
          status: clean(version.status, 30),
          changeType: clean(version.changeType, 40),
          createdAt: iso(version.createdAt),
          clinicalContent,
          attachments,
          signature: version.signature && typeof version.signature === "object"
            ? { name: clean(version.signature.name, 180), specialty: clean(version.signature.specialty, 160), signedAt: clean(version.signature.signedAt, 80) }
            : null,
          documentHash: /^[a-f0-9]{64}$/.test(String(version.documentHash || "")) ? version.documentHash : null,
        };
      });
      await db.collection("clinicalAuditLogs").doc().create({
        actorUid: user.uid,
        action: "clinical_record_versions_accessed",
        appointmentId: data.recordType === "STANDALONE" ? null : recordId,
        recordId,
        versionCount: versions.length,
        createdAt: FieldValue.serverTimestamp(),
      });
      const lastVersion = versions.length ? versions[versions.length - 1].version : 0;
      return res.status(200).json({ ok: true, versions, nextBeforeVersion: versions.length === limit && lastVersion > 1 ? lastVersion : null });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA clinical record version history failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "clinical-record-history-unavailable", "L’historique du dossier n’est pas accessible pour le moment.");
    }
  });

  const nexaCleanupClinicalRecordAttachments = onSchedule({
    schedule: "every 15 minutes",
    region: REGION,
    timeZone: "America/Port-au-Prince",
  }, async () => {
    const now = Timestamp.now();
    const sessions = await db.collection("clinicalRecordUploadSessions")
      .where("cleanupAfterAt", "<=", now).orderBy("cleanupAfterAt", "asc").limit(100).get();
    for (const candidate of sessions.docs) {
      const claim = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(candidate.ref);
        if (!snapshot.exists || millis(snapshot.get("cleanupAfterAt")) > Date.now()) return null;
        const data = snapshot.data() || {};
        const status = String(data.status || "");
        if (!CLEANUP_SESSION_STATES.has(status)) return null;
        if (status === "SCANNING" && millis(data.scanningStartedAt) > Date.now() - 10 * 60_000) return null;
        const recordId = String(data.recordId || "");
        const sessionId = candidate.id;
        const quarantinePath = "nexa-clinical-record-quarantine/" + recordId + "/" + sessionId;
        if (!validId(recordId) || data.storagePath !== quarantinePath || !validId(sessionId, 10, 80)) {
          transaction.update(candidate.ref, { status: "CLEANUP_REJECTED", cleanupAfterAt: FieldValue.delete() });
          return { invalid: true };
        }
        let finalPath = "";
        if (status !== "SUBMITTED" && typeof data.finalStoragePath === "string" &&
          validId(data.scanningAttachmentId, 10, 80) &&
          data.finalStoragePath === "nexa-clinical-records/" + recordId + "/" + data.scanningAttachmentId) {
          finalPath = data.finalStoragePath;
        }
        transaction.update(candidate.ref, { status: "CLEANING", cleanupStartedAt: FieldValue.serverTimestamp() });
        return { invalid: false, quarantinePath, finalPath, previousStatus: status };
      });
      if (!claim) continue;
      if (claim.invalid) {
        logger.error("NEXA clinical upload cleanup rejected an invalid storage path");
        continue;
      }
      try {
        await Promise.all([bucket.file(claim.quarantinePath).delete({ ignoreNotFound: true }),
          ...(claim.finalPath ? [bucket.file(claim.finalPath).delete({ ignoreNotFound: true })] : [])]);
        await candidate.ref.set({ status: "EXPIRED", closedAt: FieldValue.serverTimestamp(), cleanupAfterAt: FieldValue.delete() }, { merge: true });
      } catch (error) {
        await candidate.ref.set({
          status: claim.previousStatus,
          cleanupAfterAt: Timestamp.fromMillis(Date.now() + 5 * 60_000),
        }, { merge: true });
        logger.warn("NEXA clinical upload cleanup will retry", { errorName: error instanceof Error ? error.name : "unknown-error" });
      }
    }

    const deletions = await db.collection("clinicalRecordAttachmentDeletionQueue")
      .where("cleanupAfterAt", "<=", Timestamp.now()).orderBy("cleanupAfterAt", "asc").limit(100).get();
    for (const candidate of deletions.docs) {
      const claim = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(candidate.ref);
        if (!snapshot.exists || !["PENDING", "DELETING"].includes(String(snapshot.get("status") || "")) ||
          millis(snapshot.get("cleanupAfterAt")) > Date.now()) return null;
        const data = snapshot.data() || {};
        const recordId = String(data.recordId || "");
        const attachmentId = String(data.attachmentId || "");
        const path = data.storagePath;
        if (!validId(recordId) || !validId(attachmentId, 10, 80) ||
          path !== "nexa-clinical-records/" + recordId + "/" + attachmentId) {
          transaction.update(candidate.ref, { status: "CLEANUP_REJECTED", cleanupAfterAt: FieldValue.delete() });
          return { invalid: true };
        }
        transaction.update(candidate.ref, { status: "DELETING", cleanupStartedAt: FieldValue.serverTimestamp() });
        return { invalid: false, path };
      });
      if (!claim) continue;
      if (claim.invalid) {
        logger.error("NEXA clinical attachment deletion rejected an invalid storage path");
        continue;
      }
      try {
        await bucket.file(claim.path).delete({ ignoreNotFound: true });
        await candidate.ref.set({ status: "DONE", completedAt: FieldValue.serverTimestamp(), cleanupAfterAt: FieldValue.delete() }, { merge: true });
      } catch (error) {
        await candidate.ref.set({ status: "PENDING", cleanupAfterAt: Timestamp.fromMillis(Date.now() + 5 * 60_000) }, { merge: true });
        logger.warn("NEXA clinical attachment deletion will retry", { errorName: error instanceof Error ? error.name : "unknown-error" });
      }
    }
  });

  return { nexaClinicalRecordAttachments, nexaClinicalRecordVersions, nexaCleanupClinicalRecordAttachments };
};
