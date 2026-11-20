"use strict";

const { randomBytes } = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");
const sharp = require("sharp");

const REGION = "us-east4";
const CONSENT_VERSION = "nexa-nursing-photo-v1";
const MAX_REQUEST_BYTES = 1_500_000;
const MAX_INPUT_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 350_000;
const MAX_INPUT_PIXELS = 20_000_000;
const READ_URL_TTL_MS = 5 * 60_000;

function validPhotoPath(uid, value, pathPrefix) {
  if (typeof uid !== "string" || typeof value !== "string" || typeof pathPrefix !== "string") return false;
  const prefix = `${pathPrefix}/${uid}/`;
  const fileName = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  return /^[a-f0-9]{32}\.jpg$/.test(fileName);
}

function parseBody(req, ApiError) {
  const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;
  if (raw && raw.length > MAX_REQUEST_BYTES) {
    throw new ApiError(413, "nursing-photo-too-large", "La photo dépasse la taille permise.");
  }
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  if (!raw) throw new ApiError(400, "invalid-nursing-photo", "La photo n’est pas valide.");
  try {
    const body = JSON.parse(raw.toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid body");
    return body;
  } catch {
    throw new ApiError(400, "invalid-nursing-photo", "La photo n’est pas valide.");
  }
}

function decodePhoto(value, ApiError) {
  if (typeof value !== "string" || value.length < 4 || value.length > Math.ceil(MAX_INPUT_BYTES * 4 / 3) + 8 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new ApiError(400, "invalid-nursing-photo", "Choisissez une image JPEG, PNG ou WebP valide.");
  }
  const buffer = Buffer.from(value, "base64");
  if (!buffer.length || buffer.length > MAX_INPUT_BYTES || buffer.toString("base64") !== value) {
    throw new ApiError(400, "invalid-nursing-photo", "Choisissez une image JPEG, PNG ou WebP valide.");
  }
  return buffer;
}

async function normalizePhoto(input, ApiError) {
  const options = { failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS, limitInputChannels: 4, animated: false };
  let metadata;
  try {
    metadata = await sharp(input, options).metadata();
  } catch {
    throw new ApiError(400, "invalid-nursing-photo", "Le fichier n’est pas une image lisible.");
  }
  if (!new Set(["jpeg", "png", "webp"]).has(metadata.format) || !metadata.width || !metadata.height ||
    metadata.width * metadata.height > MAX_INPUT_PIXELS || (metadata.pages && metadata.pages > 1)) {
    throw new ApiError(400, "invalid-nursing-photo", "Utilisez une image JPEG, PNG ou WebP fixe de dimensions raisonnables.");
  }
  try {
    let output = await sharp(input, options).rotate().resize(512, 512, {
      fit: "cover", position: "centre", withoutEnlargement: true,
    }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    if (output.length > MAX_OUTPUT_BYTES) {
      output = await sharp(input, options).rotate().resize(440, 440, {
        fit: "cover", position: "centre", withoutEnlargement: true,
      }).jpeg({ quality: 70, mozjpeg: true }).toBuffer();
    }
    if (!output.length || output.length > MAX_OUTPUT_BYTES) {
      throw new ApiError(413, "nursing-photo-too-large", "Cette photo ne peut pas être réduite sous la taille permise.");
    }
    return output;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid-nursing-photo", "Cette image ne peut pas être traitée. Choisissez-en une autre.");
  }
}

async function scannerIdentityToken(audience, localScanner, ApiError) {
  if (localScanner) return "";
  const identityUrl = new URL("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity");
  identityUrl.searchParams.set("audience", audience);
  identityUrl.searchParams.set("format", "full");
  let response;
  try {
    response = await fetch(identityUrl, {
      headers: { "Metadata-Flavor": "Google" }, cache: "no-store", signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new ApiError(503, "scanner-identity-unavailable", "L’analyse de sécurité n’est pas disponible.");
  }
  if (!response.ok) throw new ApiError(503, "scanner-identity-unavailable", "L’analyse de sécurité n’est pas disponible.");
  const token = (await response.text()).trim();
  if (!token || token.length > 20_000) throw new ApiError(503, "scanner-identity-unavailable", "L’analyse de sécurité n’est pas disponible.");
  return token;
}

async function scanPhoto(buffer, ApiError) {
  const configuredUrl = process.env.NEXA_MALWARE_SCANNER_URL || "";
  const configuredAudience = process.env.NEXA_MALWARE_SCANNER_AUDIENCE || "";
  let target;
  try { target = new URL(configuredUrl); } catch {
    throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité n’est pas configurée.");
  }
  const localScanner = process.env.NODE_ENV !== "production" && target.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if ((target.protocol !== "https:" && !localScanner) || target.username || target.password || target.search ||
    target.hash || !["", "/"].includes(target.pathname)) {
    throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité n’est pas configurée.");
  }
  let audience = "";
  if (!localScanner) {
    let parsedAudience;
    try { parsedAudience = new URL(configuredAudience); } catch { /* fail closed */ }
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
      headers: { "Content-Type": "image/jpeg", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: new Blob([new Uint8Array(buffer)], { type: "image/jpeg" }),
      cache: "no-store", signal: AbortSignal.timeout(40_000),
    });
  } catch {
    throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité n’est pas disponible.");
  }
  const verdict = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité n’est pas disponible.");
  if (verdict.status === "INFECTED") throw new ApiError(422, "malware-detected", "Cette image a été bloquée par l’analyse de sécurité.");
  if (verdict.status !== "CLEAN") throw new ApiError(503, "malware-scanner-invalid-response", "L’analyse de sécurité n’a pas confirmé que l’image est propre.");
  return typeof verdict.scannerVersion === "string" ? verdict.scannerVersion.slice(0, 80) : "unknown";
}

module.exports = function createNexaProfilePhotoFunction(dependencies, configuration = {}) {
  const {
    db, FieldValue, storage, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit,
    setCors, fail, logger,
  } = dependencies;
  const providerType = configuration.providerType || "nurse";
  const credentialField = configuration.credentialField || "nursingCredentialsVerified";
  const pathPrefix = configuration.pathPrefix || "nexa-nursing-profile-photos";
  const photoPathField = configuration.photoPathField || "nursingProfilePhotoPath";
  const photoStatusField = configuration.photoStatusField || "nursingProfilePhotoStatus";
  const photoConsentVersionField = configuration.photoConsentVersionField || "nursingProfilePhotoConsentVersion";
  const photoConsentedAtField = configuration.photoConsentedAtField || "nursingProfilePhotoConsentedAt";
  const consentVersion = configuration.consentVersion || "nexa-nursing-photo-v1";
  const isNurse = providerType === "nurse";
  const bucket = storage.bucket(process.env.NEXA_STORAGE_BUCKET || "nexaris-1339d.firebasestorage.app");

  async function verifiedNurse(uid) {
    const ref = db.collection("providerProfiles").doc(uid);
    const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.get("type") !== providerType || snapshot.get("status") !== "verified" ||
      snapshot.get(credentialField) !== true) {
      throw new ApiError(403, "verified-provider-required", "Seul un profil professionnel vérifié par NEXA peut transmettre une photo.");
    }
    return { ref, snapshot };
  }

  async function signedPhotoUrl(path) {
    const [url] = await bucket.file(path).getSignedUrl({ action: "read", expires: Date.now() + READ_URL_TTL_MS });
    return url;
  }

  return onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    res.set("Cache-Control", "no-store, max-age=0");
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) {
      res.set("Allow", "GET, POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if (req.method === "POST" && (Number(req.get("Content-Length")) > MAX_REQUEST_BYTES ||
      (Buffer.isBuffer(req.rawBody) && req.rawBody.length > MAX_REQUEST_BYTES))) {
      return fail(res, 413, "nursing-photo-too-large", "La photo dépasse la taille permise.");
    }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, `${providerType}-profile-photo`, req.method === "POST" ? 3 : 20, 60 * 60_000);
      const { ref: providerRef, snapshot: provider } = await verifiedNurse(user.uid);
      const path = provider.get(photoPathField);
      const status = String(provider.get(photoStatusField) || "MISSING");
      const consentToPublicDisplay = provider.get(photoConsentVersionField) === consentVersion;

      if (req.method === "GET") {
        if (!validPhotoPath(user.uid, path, pathPrefix) || !["PENDING_REVIEW", "APPROVED", "REJECTED"].includes(status) ||
          !consentToPublicDisplay) {
          return res.status(200).json({ ok: true, photoUrl: "", photoStatus: "MISSING", consentToPublicDisplay });
        }
        const [metadata] = await bucket.file(path).getMetadata();
        if (metadata.contentType !== "image/jpeg" || metadata.metadata?.nexaScanStatus !== "CLEAN" ||
          metadata.metadata?.nexaOwnerUid !== user.uid || metadata.metadata?.nexaConsentVersion !== consentVersion) {
          throw new ApiError(503, "provider-photo-unavailable", "La photo du profil n’est pas accessible.");
        }
        return res.status(200).json({ ok: true, photoUrl: await signedPhotoUrl(path), photoStatus: status, consentToPublicDisplay });
      }

      await enforceUserRateLimit(user.uid, `${providerType}-profile-photo-upload`, 2, 24 * 60 * 60_000);
      const body = parseBody(req, ApiError);
      if (Object.keys(body).some((key) => !["photoBase64", "consentToPublicDisplay"].includes(key)) ||
        body.consentToPublicDisplay !== true) {
        throw new ApiError(400, "nursing-photo-consent-required", "Acceptez la publication de la photo dans l’annuaire NEXA après approbation.");
      }
      const input = decodePhoto(body.photoBase64, ApiError);
      const normalized = await normalizePhoto(input, ApiError);
      const scannerVersion = await scanPhoto(normalized, ApiError);
      const photoPath = `${pathPrefix}/${user.uid}/${randomBytes(16).toString("hex")}.jpg`;
      const photoFile = bucket.file(photoPath);
      await photoFile.save(normalized, {
        resumable: false,
        metadata: {
          contentType: "image/jpeg",
          cacheControl: "private, no-store",
          metadata: {
            nexaScanStatus: "CLEAN",
            nexaScannerVersion: scannerVersion,
            nexaOwnerUid: user.uid,
            nexaConsentVersion: consentVersion,
            firebaseStorageDownloadTokens: "",
          },
        },
      });

      const auditRef = db.collection("adminAuditLogs").doc();
      let oldPath = "";
      try {
        await db.runTransaction(async (transaction) => {
          const current = await transaction.get(providerRef);
          if (!current.exists || current.get("type") !== providerType || current.get("status") !== "verified" ||
            current.get(credentialField) !== true) {
            throw new ApiError(403, "verified-provider-required", "Le profil professionnel n’est plus autorisé à transmettre une photo.");
          }
          const previousPath = current.get(photoPathField);
          if (validPhotoPath(user.uid, previousPath, pathPrefix)) oldPath = previousPath;
          transaction.set(providerRef, {
            [photoPathField]: photoPath,
            [photoStatusField]: "PENDING_REVIEW",
            [photoConsentVersionField]: consentVersion,
            [photoConsentedAtField]: FieldValue.serverTimestamp(),
            ...(isNurse ? {
              serviceProfileStatus: current.get("nursingServiceProfile") ? "PENDING_REVIEW" : String(current.get("serviceProfileStatus") || "INCOMPLETE"),
              nursingDirectoryListed: false,
              serviceProfileReviewReason: FieldValue.delete(),
            } : {}),
            publiclyListed: false,
            ...(!isNurse ? {
              profilePhotoReviewReason: FieldValue.delete(),
              profilePhotoReviewedAt: FieldValue.delete(),
              profilePhotoReviewedBy: FieldValue.delete(),
            } : {}),
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          transaction.create(auditRef, {
            actorUid: user.uid,
            action: isNurse ? "nursing_public_profile_photo_uploaded" : "doctor_public_profile_photo_uploaded",
            resource: `providerProfiles/${user.uid}`,
            outputBytes: normalized.length,
            createdAt: FieldValue.serverTimestamp(),
          });
        });
      } catch (error) {
        await photoFile.delete({ ignoreNotFound: true }).catch(() => undefined);
        throw error;
      }

      if (oldPath && oldPath !== photoPath) await bucket.file(oldPath).delete({ ignoreNotFound: true }).catch(() => undefined);
      return res.status(200).json({
        ok: true,
        photoUrl: await signedPhotoUrl(photoPath),
        photoStatus: "PENDING_REVIEW",
        message: "Photo reçue. Elle apparaîtra dans l’annuaire après approbation NEXA.",
      });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA nursing profile photo failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "nursing-photo-unavailable", "La photo du profil ne peut pas être traitée pour le moment.");
    }
  });
};
