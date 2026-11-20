"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { FieldPath, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

const REGION = "us-east4";
const MAX_DOCUMENTS = 20;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SESSION_MS = 15 * 60_000;
const POLICY_MS = 10 * 60_000;
const CLEANUP_GRACE_MS = 25 * 60_000;
const EXPIRABLE_STATES = ["OPEN", "FAILED", "REJECTED", "SCANNING", "CLEANING"];
const CONTRACT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

function clean(value, maxLength) {
  return typeof value === "string"
    ? value.trim().replace(/[\\/\r\n\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").slice(0, maxLength)
    : "";
}

function validUid(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{10,128}$/.test(value);
}

function validObjectId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{10,80}$/.test(value);
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") {
    const result = Number(value.toMillis());
    return Number.isFinite(result) ? result : null;
  }
  return null;
}

function isoDate(value) {
  return value && typeof value.toDate === "function" ? value.toDate().toISOString() : null;
}

function safeDocument(data, id) {
  return {
    id,
    name: clean(data.name, 180) || "Justificatif",
    contentType: clean(data.contentType, 60),
    size: Number(data.size) || 0,
    uploadedByUid: clean(data.uploadedByUid, 128),
    uploadedAt: isoDate(data.uploadedAt),
    antivirusStatus: data.antivirusStatus === "CLEAN" ? "CLEAN" : "UNVERIFIED",
  };
}

function validStoredDocument(data, providerUid, documentId) {
  return data.antivirusStatus === "CLEAN" &&
    data.storagePath === "nexa-diagnostic-partner-contracts/" + providerUid + "/" + documentId &&
    CONTRACT_TYPES.has(String(data.contentType || "")) &&
    Number.isSafeInteger(data.size) && Number(data.size) >= 1 && Number(data.size) <= MAX_FILE_BYTES;
}

function getBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  if (!Buffer.isBuffer(req.rawBody)) return null;
  try {
    const body = JSON.parse(req.rawBody.toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch { return null; }
}

function apiError(ApiError, status, code, message) {
  return new ApiError(status, code, message);
}

function matchesMimeSignature(buffer, mime) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (mime === "application/pdf") return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  if (mime === "image/jpeg") return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return false;
}

async function scannerToken(audience, localScanner, ApiError) {
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
    throw apiError(ApiError, 503, "scanner-identity-unavailable", "L’identité de l’analyse de sécurité n’est pas disponible.");
  }
  if (!response.ok) throw apiError(ApiError, 503, "scanner-identity-unavailable", "L’identité de l’analyse de sécurité n’est pas disponible.");
  const token = (await response.text()).trim();
  if (!token || token.length > 20_000) throw apiError(ApiError, 503, "scanner-identity-unavailable", "L’identité de l’analyse de sécurité n’est pas disponible.");
  return token;
}

async function scanFile(fileBuffer, contentType, ApiError) {
  const configuredUrl = process.env.NEXA_MALWARE_SCANNER_URL || "";
  const configuredAudience = process.env.NEXA_MALWARE_SCANNER_AUDIENCE || "";
  let target;
  try { target = new URL(configuredUrl); } catch {
    throw apiError(ApiError, 503, "malware-scanner-unavailable", "L’analyse de sécurité n’est pas configurée. Aucun justificatif n’a été transmis.");
  }
  const localScanner = process.env.NODE_ENV !== "production" && target.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if ((target.protocol !== "https:" && !localScanner) || target.username || target.password || target.search ||
    target.hash || !["", "/"].includes(target.pathname)) {
    throw apiError(ApiError, 503, "malware-scanner-unavailable", "L’analyse de sécurité n’est pas configurée. Aucun justificatif n’a été transmis.");
  }
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length < 1 || fileBuffer.length > MAX_FILE_BYTES || !CONTRACT_TYPES.has(contentType)) {
    throw apiError(ApiError, 400, "invalid-contract-file", "Le fichier ne respecte pas les limites de sécurité NEXA.");
  }
  if (!matchesMimeSignature(fileBuffer, contentType)) {
    throw apiError(ApiError, 400, "invalid-contract-file", "Le contenu du fichier ne correspond pas au type annoncé.");
  }
  let audience = "";
  if (!localScanner) {
    let parsedAudience;
    try { parsedAudience = new URL(configuredAudience); } catch { /* fail closed */ }
    if (!parsedAudience || parsedAudience.origin !== target.origin || !["", "/"].includes(parsedAudience.pathname) ||
      parsedAudience.search || parsedAudience.hash || parsedAudience.username || parsedAudience.password) {
      throw apiError(ApiError, 503, "scanner-audience-not-configured", "L’identité de l’analyse de sécurité n’est pas configurée.");
    }
    audience = configuredAudience;
  }
  const token = await scannerToken(audience, localScanner, ApiError);
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
    throw apiError(ApiError, 503, "malware-scanner-unavailable", "L’analyse de sécurité est temporairement indisponible. Aucun justificatif n’a été transmis.");
  }
  const verdict = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 413 || response.status === 415) {
      throw apiError(ApiError, 400, "invalid-contract-file", "Le fichier ne correspond pas à son type ou dépasse la taille permise.");
    }
    throw apiError(ApiError, 503, "malware-scanner-unavailable", "L’analyse de sécurité est temporairement indisponible.");
  }
  if (verdict.status === "INFECTED") throw apiError(ApiError, 422, "malware-detected", "Un justificatif a été bloqué par l’analyse antivirus.");
  if (verdict.status !== "CLEAN") throw apiError(ApiError, 503, "malware-scanner-invalid-response", "L’analyse de sécurité n’a pas confirmé que le justificatif est propre.");
  return { scannerVersion: typeof verdict.scannerVersion === "string" ? verdict.scannerVersion.slice(0, 80) : "unknown" };
}

module.exports = function createNexaAdminContractFunctions(dependencies) {
  const {
    db, FieldValue, storage, ApiError, requireUser, requireAppCheckToken,
    enforceUserRateLimit, setCors, fail, logger,
  } = dependencies;
  const bucket = storage.bucket(process.env.NEXA_STORAGE_BUCKET || "nexaris-1339d.firebasestorage.app");

  async function requireAdmin(req, action, limit) {
    const user = await requireUser(req);
    await requireAppCheckToken(req);
    const admins = new Set(String(process.env.NEXA_ADMIN_UIDS || "").split(",").map((value) => value.trim()).filter(Boolean));
    if (!admins.size) throw new ApiError(503, "admin-access-not-configured", "L’accès administrateur NEXA n’est pas configuré.");
    if (!admins.has(user.uid)) throw new ApiError(403, "administrator-required", "Accès administrateur requis.");
    await enforceUserRateLimit(user.uid, action, limit, 60_000);
    return user;
  }

  function prepare(req, res, methods, maxBytes = 4_096) {
    res.set("Cache-Control", "no-store, max-age=0");
    if (!setCors(req, res)) {
      fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
      return false;
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return false;
    }
    if (!methods.includes(req.method)) {
      res.set("Allow", methods.concat("OPTIONS").join(", "));
      fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
      return false;
    }
    if ((Number(req.get("Content-Length")) || 0) > maxBytes || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > maxBytes)) {
      fail(res, 413, "request-too-large", "La demande de justificatif dépasse la taille autorisée.");
      return false;
    }
    return true;
  }

  async function execute(req, res, options, handler) {
    if (!prepare(req, res, options.methods, options.maxBytes)) return;
    try {
      const admin = await requireAdmin(req, options.action, options.limit);
      return await handler(req, res, admin);
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA partner contract operation failed", {
        errorName: error instanceof Error ? error.name : "unknown-error",
      });
      return fail(res, 500, "diagnostic-partner-contract-unavailable", "Les documents du partenaire ne sont pas accessibles.");
    }
  }

  const nexaAdminDiagnosticPartnerContracts = onRequest({ region: REGION }, async (req, res) => {
    const options = {
      methods: req.method === "GET" ? ["GET"] : ["POST"],
      action: req.method === "GET" ? "admin-diagnostic-partner-contract-read" : "admin-diagnostic-partner-contract-write",
      limit: req.method === "GET" ? 60 : 12,
      maxBytes: 4_096,
    };
    return execute(req, res, options, async (request, response, admin) => {
      if (request.method === "GET") {
        const providerUid = typeof request.query?.providerUid === "string" ? request.query.providerUid.trim() : "";
        const documentId = typeof request.query?.documentId === "string" ? request.query.documentId.trim() : "";
        if (!providerUid) {
          const cursor = typeof request.query?.cursor === "string" ? request.query.cursor.trim() : "";
          if (cursor && !validUid(cursor)) throw new ApiError(400, "invalid-provider-cursor", "Le repère du partenaire n’est pas valide.");
          let query = db.collection("providerProfiles").orderBy(FieldPath.documentId());
          if (cursor) query = query.startAfter(cursor);
          const snapshot = await query.limit(101).get();
          const hasMore = snapshot.docs.length > 100;
          const page = snapshot.docs.slice(0, 100);
          const providers = page.flatMap((doc) => {
            const data = doc.data() || {};
            if (!["laboratory", "imaging"].includes(String(data.type || ""))) return [];
            const profile = data.profile && typeof data.profile === "object" && !Array.isArray(data.profile) ? data.profile : {};
            return [{
              uid: doc.id,
              type: data.type,
              name: clean(profile.name || data.name, 160) || "Partenaire diagnostic",
              status: clean(data.status, 32) || "unknown",
              contractDocumentCount: Number.isSafeInteger(data.contractDocumentCount) && data.contractDocumentCount >= 0
                ? data.contractDocumentCount
                : 0,
            }];
          });
          await db.collection("adminAuditLogs").doc().create({
            actorUid: admin.uid,
            action: "diagnostic_partner_contract_directory_listed",
            resultCount: providers.length,
            createdAt: FieldValue.serverTimestamp(),
          });
          return response.status(200).json({
            ok: true,
            providers,
            nextCursor: hasMore ? page[page.length - 1]?.id || null : null,
          });
        }

        if (!validUid(providerUid)) throw new ApiError(400, "invalid-diagnostic-partner", "Le partenaire diagnostic n’est pas valide.");
        if (documentId && !validObjectId(documentId)) throw new ApiError(400, "invalid-contract-document", "Le document n’est pas valide.");
        const providerRef = db.collection("providerProfiles").doc(providerUid);
        const provider = await providerRef.get();
        if (!provider.exists || !["laboratory", "imaging"].includes(String(provider.get("type") || ""))) {
          throw new ApiError(404, "diagnostic-partner-not-found", "Ce partenaire diagnostic n’existe pas.");
        }
        const documentsRef = providerRef.collection("contractDocuments");
        if (documentId) {
          const snapshot = await documentsRef.doc(documentId).get();
          const data = snapshot.data() || {};
          const expectedPath = "nexa-diagnostic-partner-contracts/" + providerUid + "/" + documentId;
          if (!snapshot.exists || !validStoredDocument(data, providerUid, documentId)) {
            throw new ApiError(404, "contract-document-not-found", "Le justificatif privé n’est pas disponible.");
          }
          const [exists] = await bucket.file(expectedPath).exists();
          if (!exists) throw new ApiError(404, "contract-document-not-found", "Le justificatif privé n’est pas disponible.");
          const fileName = clean(data.name, 180).replace(/["\\\r\n]/g, "_") || "justificatif";
          const [downloadUrl] = await bucket.file(expectedPath).getSignedUrl({
            action: "read",
            expires: Date.now() + 5 * 60_000,
            responseDisposition: "attachment; filename=\"" + fileName + "\"",
          });
          await db.collection("adminAuditLogs").doc().create({
            actorUid: admin.uid,
            action: "diagnostic_partner_contract_download_link_created",
            resource: "providerProfiles/" + providerUid + "/contractDocuments/" + documentId,
            createdAt: FieldValue.serverTimestamp(),
          });
          return response.status(200).json({ ok: true, downloadUrl, expiresInSeconds: 300 });
        }

        const snapshot = await documentsRef.orderBy("uploadedAt", "desc").limit(MAX_DOCUMENTS).get();
        const documents = snapshot.docs.flatMap((doc) =>
          validStoredDocument(doc.data(), providerUid, doc.id) ? [safeDocument(doc.data(), doc.id)] : []);
        await db.collection("adminAuditLogs").doc().create({
          actorUid: admin.uid,
          action: "diagnostic_partner_contract_documents_listed",
          resource: "providerProfiles/" + providerUid + "/contractDocuments",
          count: documents.length,
          createdAt: FieldValue.serverTimestamp(),
        });
        const profile = provider.get("profile") && typeof provider.get("profile") === "object" ? provider.get("profile") : {};
        return response.status(200).json({
          ok: true,
          provider: {
            uid: providerUid,
            type: provider.get("type"),
            name: clean(profile.name || provider.get("name"), 160) || "Partenaire diagnostic",
          },
          documents,
          remainingSlots: Math.max(0, MAX_DOCUMENTS - snapshot.size),
        });
      }

      const body = getBody(request);
      if (!body) throw new ApiError(400, "invalid-request", "La demande de justificatif n’est pas valide.");
      const action = clean(body.action, 20).toLowerCase();
      if (action === "start") {
        const providerUid = clean(body.providerUid, 128);
        const name = clean(body.fileName, 180).replace(/[\\/\r\n"]/g, "_");
        const contentType = clean(body.contentType, 60).toLowerCase();
        const size = Number(body.size);
        if (!validUid(providerUid) || !name || !CONTRACT_TYPES.has(contentType) ||
          !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) {
          throw new ApiError(400, "invalid-contract-upload", "Choisissez un PDF, JPG ou PNG de 10 Mio maximum.");
        }
        const providerRef = db.collection("providerProfiles").doc(providerUid);
        const provider = await providerRef.get();
        if (!provider.exists || !["laboratory", "imaging"].includes(String(provider.get("type") || ""))) {
          throw new ApiError(404, "diagnostic-partner-not-found", "Ce partenaire laboratoire ou imagerie n’existe pas.");
        }
        const currentDocs = await providerRef.collection("contractDocuments").limit(MAX_DOCUMENTS + 1).get();
        if (currentDocs.size >= MAX_DOCUMENTS) {
          throw new ApiError(409, "contract-document-limit", "Un partenaire peut avoir au maximum " + MAX_DOCUMENTS + " justificatifs.");
        }

        const sessionRef = db.collection("diagnosticPartnerContractUploadSessions").doc(randomBytes(18).toString("base64url"));
        const sessionId = sessionRef.id;
        const expiresAt = Date.now() + SESSION_MS;
        const quarantinePath = "nexa-diagnostic-partner-contract-quarantine/" + providerUid + "/" + sessionId;
        await sessionRef.create({
          providerUid,
          createdByUid: admin.uid,
          fileName: name,
          contentType,
          expectedSize: size,
          storagePath: quarantinePath,
          status: "OPEN",
          createdAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(expiresAt),
          cleanupAfterAt: Timestamp.fromMillis(expiresAt + CLEANUP_GRACE_MS),
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
              "x-goog-meta-nexa-admin-uid": admin.uid,
              "x-goog-meta-nexa-provider-uid": providerUid,
              "x-goog-meta-nexa-upload-session-id": sessionId,
            },
            conditions: [
              ["content-length-range", 1, size],
              ["eq", "$key", quarantinePath],
              ["eq", "$Content-Type", contentType],
              ["eq", "$success_action_status", "201"],
              ["eq", "$x-goog-if-generation-match", "0"],
              ["eq", "$x-goog-meta-firebasestoragedownloadtokens", ""],
              ["eq", "$x-goog-meta-nexa-admin-uid", admin.uid],
              ["eq", "$x-goog-meta-nexa-provider-uid", providerUid],
              ["eq", "$x-goog-meta-nexa-upload-session-id", sessionId],
            ],
          });
        } catch {
          await sessionRef.set({
            status: "FAILED",
            closedAt: FieldValue.serverTimestamp(),
            cleanupAfterAt: Timestamp.fromMillis(expiresAt + CLEANUP_GRACE_MS),
          }, { merge: true });
          throw new ApiError(503, "secure-upload-unavailable", "Le téléversement sécurisé n’est pas disponible actuellement.");
        }
        return response.status(201).json({ ok: true, uploadId: sessionId, uploadUrl: policy.url, fields: policy.fields, expiresAt });
      }

      if (action !== "finalize") throw new ApiError(400, "invalid-contract-action", "L’action de téléversement n’est pas valide.");
      const sessionId = clean(body.uploadId, 80);
      if (!validObjectId(sessionId)) throw new ApiError(400, "invalid-contract-upload-session", "La session de justificatif n’est pas valide.");
      const sessionRef = db.collection("diagnosticPartnerContractUploadSessions").doc(sessionId);
      const preview = await sessionRef.get();
      if (preview.exists && preview.get("createdByUid") === admin.uid && preview.get("status") === "SUBMITTED") {
        const providerUid = clean(preview.get("providerUid"), 128);
        const documentId = clean(preview.get("documentId"), 80);
        if (validUid(providerUid) && validObjectId(documentId)) {
          const document = await db.collection("providerProfiles").doc(providerUid).collection("contractDocuments").doc(documentId).get();
          if (document.exists) return response.status(200).json({ ok: true, document: safeDocument(document.data() || {}, document.id) });
        }
      }
      const previewExpiry = preview.exists ? timestampMillis(preview.get("expiresAt")) : null;
      if (!preview.exists || preview.get("createdByUid") !== admin.uid || preview.get("status") !== "OPEN" ||
        previewExpiry === null || previewExpiry <= Date.now()) {
        throw new ApiError(404, "contract-upload-session-not-found", "Cette session de téléversement n’est plus disponible.");
      }
      const providerUid = clean(preview.get("providerUid"), 128);
      const expectedQuarantinePath = "nexa-diagnostic-partner-contract-quarantine/" + providerUid + "/" + sessionId;
      if (!validUid(providerUid) || preview.get("storagePath") !== expectedQuarantinePath) {
        throw new ApiError(409, "contract-upload-path-invalid", "Le fichier ne correspond pas à ce partenaire.");
      }

      const claim = await db.runTransaction(async (transaction) => {
        const session = await transaction.get(sessionRef);
        const expiresAt = session.exists ? timestampMillis(session.get("expiresAt")) : null;
        if (!session.exists || session.get("createdByUid") !== admin.uid || session.get("providerUid") !== providerUid ||
          session.get("status") !== "OPEN" || expiresAt === null || expiresAt <= Date.now()) {
          throw new ApiError(409, "contract-upload-session-locked", "La session a expiré ou a déjà été utilisée.");
        }
        transaction.update(sessionRef, { status: "SCANNING", scanningStartedAt: FieldValue.serverTimestamp() });
        return {
          fileName: clean(session.get("fileName"), 180) || "Justificatif",
          contentType: clean(session.get("contentType"), 60).toLowerCase(),
          expectedSize: Number(session.get("expectedSize")),
        };
      });
      let finalPath = "";
      try {
        const quarantineObject = bucket.file(expectedQuarantinePath);
        const [exists] = await quarantineObject.exists();
        if (!exists) throw new ApiError(400, "contract-upload-file-missing", "Le fichier n’a pas été téléversé. Réessayez.");
        const [metadata] = await quarantineObject.getMetadata();
        const size = Number(metadata.size || 0);
        const contentType = String(metadata.contentType || "").toLowerCase();
        const custom = metadata.metadata && typeof metadata.metadata === "object"
          ? Object.fromEntries(Object.entries(metadata.metadata).map(([key, value]) => [
            key.toLowerCase().replace(/^x-goog-meta-/, "").replace(/[^a-z0-9]/g, ""),
            value,
          ]))
          : {};
        if (contentType !== claim.contentType || size !== claim.expectedSize || size < 1 || size > MAX_FILE_BYTES ||
          !CONTRACT_TYPES.has(contentType) || custom.nexaadminuid !== admin.uid || custom.nexaprovideruid !== providerUid ||
          custom.nexauploadsessionid !== sessionId ||
          (typeof custom.firebasestoragedownloadtokens === "string" && custom.firebasestoragedownloadtokens)) {
          throw new ApiError(400, "contract-upload-metadata-invalid", "Le fichier ne correspond pas au format, à la taille ou à la session annoncés.");
        }
        const [contents] = await quarantineObject.download();
        const scan = await scanFile(contents, contentType, ApiError);
        const sha256Hash = createHash("sha256").update(contents).digest("hex");
        const documentId = randomBytes(18).toString("base64url");
        finalPath = "nexa-diagnostic-partner-contracts/" + providerUid + "/" + documentId;
        await sessionRef.update({ finalStoragePath: finalPath, finalDocumentId: documentId });
        await quarantineObject.move(finalPath);
        await bucket.file(finalPath).setMetadata({
          contentType,
          cacheControl: "private, no-store",
          metadata: {
            nexaAntivirusStatus: "CLEAN",
            nexaAntivirusScannerVersion: scan.scannerVersion || "unknown",
            nexaSha256: sha256Hash,
            firebaseStorageDownloadTokens: "",
          },
        });

        const providerRef = db.collection("providerProfiles").doc(providerUid);
        const documentRef = providerRef.collection("contractDocuments").doc(documentId);
        const auditRef = db.collection("adminAuditLogs").doc();
        await db.runTransaction(async (transaction) => {
          const documentsQuery = providerRef.collection("contractDocuments").limit(MAX_DOCUMENTS + 1);
          const [session, provider, documents] = await Promise.all([
            transaction.get(sessionRef),
            transaction.get(providerRef),
            transaction.get(documentsQuery),
          ]);
          if (!session.exists || session.get("status") !== "SCANNING" || session.get("createdByUid") !== admin.uid ||
            session.get("providerUid") !== providerUid || !provider.exists ||
            !["laboratory", "imaging"].includes(String(provider.get("type") || ""))) {
            throw new ApiError(409, "contract-upload-session-conflict", "La session ou le partenaire n’est plus disponible.");
          }
          if (documents.size >= MAX_DOCUMENTS) {
            throw new ApiError(409, "contract-document-limit", "Un partenaire peut avoir au maximum " + MAX_DOCUMENTS + " justificatifs.");
          }
          transaction.create(documentRef, {
            name: claim.fileName,
            contentType,
            size,
            sha256Hash,
            storagePath: finalPath,
            antivirusStatus: "CLEAN",
            scannerVersion: scan.scannerVersion,
            uploadedByUid: admin.uid,
            uploadedAt: FieldValue.serverTimestamp(),
          });
          transaction.update(providerRef, {
            contractDocumentCount: documents.size + 1,
            updatedAt: FieldValue.serverTimestamp(),
            updatedByUid: admin.uid,
          });
          transaction.update(sessionRef, {
            status: "SUBMITTED",
            documentId,
            closedAt: FieldValue.serverTimestamp(),
            cleanupAfterAt: FieldValue.delete(),
          });
          transaction.create(auditRef, {
            actorUid: admin.uid,
            action: "diagnostic_partner_contract_document_added",
            resource: "providerProfiles/" + providerUid + "/contractDocuments/" + documentId,
            contentType,
            size,
            createdAt: FieldValue.serverTimestamp(),
          });
        });
        return response.status(201).json({
          ok: true,
          document: {
            id: documentId,
            name: claim.fileName,
            contentType,
            size,
            uploadedByUid: admin.uid,
            uploadedAt: new Date().toISOString(),
            antivirusStatus: "CLEAN",
          },
        });
      } catch (error) {
        await Promise.allSettled([expectedQuarantinePath, finalPath].filter(Boolean).map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
        const status = error instanceof ApiError && error.code === "malware-detected" ? "REJECTED" : "FAILED";
        await db.runTransaction(async (transaction) => {
          const session = await transaction.get(sessionRef);
          if (session.exists && session.get("createdByUid") === admin.uid && session.get("status") === "SCANNING") {
            transaction.update(sessionRef, {
              status,
              closedAt: FieldValue.serverTimestamp(),
              cleanupAfterAt: Timestamp.fromMillis(Date.now() + CLEANUP_GRACE_MS),
            });
          }
        }).catch(() => undefined);
        throw error;
      }
    });
  });

  const nexaCleanupDiagnosticPartnerContractUploads = onSchedule({
    region: REGION,
    schedule: "every 10 minutes",
    timeZone: "America/Port-au-Prince",
    maxInstances: 1,
  }, async () => {
    const due = await db.collection("diagnosticPartnerContractUploadSessions")
      .where("cleanupAfterAt", "<=", Timestamp.now())
      .orderBy("cleanupAfterAt", "asc")
      .limit(50)
      .get();
    let cleanedSessions = 0;
    let deletedObjects = 0;
    let failed = 0;

    for (const candidate of due.docs) {
      const claim = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(candidate.ref);
        if (!snapshot.exists || (timestampMillis(snapshot.get("cleanupAfterAt")) || 0) > Date.now()) return null;
        const status = String(snapshot.get("status") || "");
        if (!EXPIRABLE_STATES.includes(status)) return null;
        const startedAt = timestampMillis(snapshot.get(status === "SCANNING" ? "scanningStartedAt" : "cleanupStartedAt"));
        if (["SCANNING", "CLEANING"].includes(status) && startedAt && startedAt > Date.now() - 10 * 60_000) return null;

        const providerUid = String(snapshot.get("providerUid") || "");
        const quarantinePath = snapshot.get("storagePath");
        const documentId = String(snapshot.get("finalDocumentId") || snapshot.get("documentId") || "");
        const finalPath = snapshot.get("finalStoragePath");
        if (!validUid(providerUid) || quarantinePath !== "nexa-diagnostic-partner-contract-quarantine/" + providerUid + "/" + candidate.id) {
          return { invalid: true };
        }
        if (finalPath !== undefined &&
          (!validObjectId(documentId) || finalPath !== "nexa-diagnostic-partner-contracts/" + providerUid + "/" + documentId)) {
          return { invalid: true };
        }
        transaction.update(candidate.ref, { status: "CLEANING", cleanupStartedAt: FieldValue.serverTimestamp() });
        return {
          invalid: false,
          quarantinePath,
          finalPath: typeof finalPath === "string" ? finalPath : "",
          previousStatus: status,
        };
      });
      if (!claim) continue;
      if (claim.invalid) {
        failed += 1;
        continue;
      }
      const paths = [claim.quarantinePath, claim.finalPath].filter(Boolean);
      try {
        await Promise.all(paths.map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
        await candidate.ref.set({
          status: "EXPIRED",
          closedAt: FieldValue.serverTimestamp(),
          cleanupAfterAt: FieldValue.delete(),
          finalStoragePath: FieldValue.delete(),
          finalDocumentId: FieldValue.delete(),
        }, { merge: true });
        cleanedSessions += 1;
        deletedObjects += paths.length;
      } catch {
        await candidate.ref.set({
          status: claim.previousStatus,
          cleanupAfterAt: Timestamp.fromMillis(Date.now() + 5 * 60_000),
        }, { merge: true });
        failed += 1;
      }
    }
    logger.info("NEXA diagnostic partner contract cleanup completed", { cleanedSessions, deletedObjects, failed });
  });

  return { nexaAdminDiagnosticPartnerContracts, nexaCleanupDiagnosticPartnerContractUploads };
};
