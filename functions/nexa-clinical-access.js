"use strict";

const { createHash, randomBytes, randomUUID } = require("node:crypto");
const { Timestamp } = require("firebase-admin/firestore");
const { onRequest } = require("firebase-functions/v2/https");

const REGION = "us-east4";
const GRANT_CODE_TTL_MS = 30 * 60_000;

function iso(value) {
  if (value && typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return typeof value === "string" ? value : null;
}

function timestamp(value) {
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(String(value || ""));
}

function readBody(req, maximumBytes = 2_048) {
  if (Buffer.isBuffer(req.rawBody) && req.rawBody.byteLength > maximumBytes) return { tooLarge: true };
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) {
    return { value: req.body };
  }
  if (!Buffer.isBuffer(req.rawBody)) return { value: null };
  try {
    const parsed = JSON.parse(req.rawBody.toString("utf8"));
    return { value: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null };
  } catch {
    return { value: null };
  }
}

module.exports = function createNexaClinicalAccessFunctions(dependencies) {
  const { db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger } = dependencies;

  async function requirePatient(req) {
    const user = await requireUser(req);
    await requireAppCheckToken(req);
    const profile = await db.collection("patientProfiles").doc(user.uid).get();
    const patientNumber = profile.exists ? String(profile.get("patientNumber") || "") : "";
    if (!profile.exists || profile.get("role") !== "patient" || profile.get("profileComplete") !== true || !/^NMC-\d{7}$/.test(patientNumber)) {
      throw new ApiError(403, "complete-patient-profile-required", "Terminez votre profil patient avant de gérer les autorisations cliniques.");
    }
    return { user, patientNumber };
  }

  const nexaPatientClinicalAccess = onRequest({ region: REGION }, async (req, res) => {
    res.set("Cache-Control", "no-store, max-age=0");
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST", "DELETE"].includes(req.method)) {
      res.set("Allow", "GET, POST, DELETE, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }

    try {
      const { user, patientNumber } = await requirePatient(req);
      if (req.method === "GET") {
        await enforceUserRateLimit(user.uid, "patient-clinical-access-read", 30, 5 * 60_000);
        const snapshot = await db.collection("clinicalAccessGrants")
          .where("patientUid", "==", user.uid)
          .orderBy("issuedAt", "desc")
          .limit(50)
          .get();
        const now = Date.now();
        const grants = snapshot.docs.map((document) => {
          const data = document.data() || {};
          const status = String(data.status || "ISSUED").toUpperCase();
          const expiresAtMs = timestamp(status === "CLAIMED" ? data.accessExpiresAt : data.expiresAt);
          return {
            grantId: document.id,
            providerName: typeof data.providerName === "string" ? data.providerName.slice(0, 120) : "Médecin NEXA",
            status: status !== "REVOKED" && (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) ? "EXPIRED" : status,
            issuedAt: iso(data.issuedAt),
            expiresAt: iso(data.expiresAt),
            accessExpiresAt: iso(data.accessExpiresAt),
          };
        }).sort((left, right) => Date.parse(right.issuedAt || "") - Date.parse(left.issuedAt || ""));
        return res.status(200).json({ ok: true, grants });
      }

      if (req.method === "POST") {
        await enforceUserRateLimit(user.uid, "patient-clinical-access-issue", 5, 60 * 60_000);
        const parsed = readBody(req);
        if (parsed.tooLarge) throw new ApiError(413, "request-too-large", "La demande est trop volumineuse.");
        const input = parsed.value;
        if (!input || Object.keys(input).some((key) => key !== "providerUid")) {
          throw new ApiError(400, "invalid-request", "Seul le médecin destinataire peut être choisi.");
        }
        const providerUid = typeof input.providerUid === "string" ? input.providerUid.trim() : "";
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(providerUid) || providerUid === user.uid) {
          throw new ApiError(400, "invalid-provider", "Choisissez un médecin NEXA valide.");
        }

        const code = randomBytes(24).toString("base64url");
        const codeHash = createHash("sha256").update(code).digest("hex");
        const providerRef = db.collection("providerProfiles").doc(providerUid);
        const patientRef = db.collection("patientProfiles").doc(user.uid);
        const grantRef = db.collection("clinicalAccessGrants").doc(randomUUID());
        const codeRef = db.collection("clinicalAccessCodeIndex").doc(codeHash);
        const auditRef = db.collection("clinicalAuditLogs").doc();
        const expiresAt = Date.now() + GRANT_CODE_TTL_MS;
        let providerName = "";

        await db.runTransaction(async (transaction) => {
          const [patient, provider, priorCode] = await Promise.all([
            transaction.get(patientRef), transaction.get(providerRef), transaction.get(codeRef),
          ]);
          if (!patient.exists || patient.get("role") !== "patient" || patient.get("profileComplete") !== true || patient.get("patientNumber") !== patientNumber) {
            throw new ApiError(403, "complete-patient-profile-required", "Le profil patient n’est plus complet.");
          }
          if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("publiclyListed") !== true || provider.get("clinicalCredentialsVerified") !== true) {
            throw new ApiError(404, "doctor-not-available", "Ce médecin NEXA n’est pas disponible pour recevoir une autorisation.");
          }
          if (priorCode.exists) throw new ApiError(503, "authorization-code-unavailable", "Le code d’autorisation n’a pas pu être préparé.");
          const profile = provider.get("profile") && typeof provider.get("profile") === "object" && !Array.isArray(provider.get("profile"))
            ? provider.get("profile")
            : {};
          providerName = typeof profile.name === "string" ? profile.name.slice(0, 120) : "Médecin NEXA";
          transaction.create(grantRef, {
            patientUid: user.uid,
            patientNumber,
            providerUid,
            providerName,
            status: "ISSUED",
            accessCodeHash: codeHash,
            issuedAt: FieldValue.serverTimestamp(),
            expiresAt: Timestamp.fromMillis(expiresAt),
          });
          transaction.create(codeRef, {
            grantId: grantRef.id,
            providerUid,
            status: "ISSUED",
            expiresAt: Timestamp.fromMillis(expiresAt),
            createdAt: FieldValue.serverTimestamp(),
          });
          transaction.create(auditRef, {
            actorUid: user.uid,
            action: "patient_clinical_access_grant_issued",
            resource: `clinicalAccessGrants/${grantRef.id}`,
            createdAt: FieldValue.serverTimestamp(),
          });
        });

        return res.status(201).json({ ok: true, grantId: grantRef.id, providerName, accessCode: code, expiresAt: new Date(expiresAt).toISOString() });
      }

      await enforceUserRateLimit(user.uid, "patient-clinical-access-revoke", 10, 5 * 60_000);
      const parsed = readBody(req);
      if (parsed.tooLarge) throw new ApiError(413, "request-too-large", "La demande est trop volumineuse.");
      const grantId = parsed.value && typeof parsed.value.grantId === "string" ? parsed.value.grantId.trim() : "";
      if (!/^[0-9a-f-]{36}$/i.test(grantId)) throw new ApiError(400, "invalid-grant", "L’autorisation clinique n’est pas valide.");

      const grantRef = db.collection("clinicalAccessGrants").doc(grantId);
      const auditRef = db.collection("clinicalAuditLogs").doc();
      let alreadyRevoked = false;
      await db.runTransaction(async (transaction) => {
        const grant = await transaction.get(grantRef);
        if (!grant.exists || grant.get("patientUid") !== user.uid) throw new ApiError(404, "grant-not-found", "Cette autorisation clinique n’est pas disponible.");
        if (String(grant.get("status") || "").toUpperCase() === "REVOKED") { alreadyRevoked = true; return; }
        const recordId = typeof grant.get("claimedRecordId") === "string" ? grant.get("claimedRecordId") : "";
        const codeHash = typeof grant.get("accessCodeHash") === "string" ? grant.get("accessCodeHash") : "";
        const recordRef = /^[A-Za-z0-9_-]{10,200}$/.test(recordId) ? db.collection("electronicPatientRecords").doc(recordId) : null;
        const codeRef = /^[a-f0-9]{64}$/.test(codeHash) ? db.collection("clinicalAccessCodeIndex").doc(codeHash) : null;
        const [record, codeIndex] = await Promise.all([
          recordRef ? transaction.get(recordRef) : Promise.resolve(null),
          codeRef ? transaction.get(codeRef) : Promise.resolve(null),
        ]);
        transaction.set(grantRef, { status: "REVOKED", revokedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        if (recordRef && record?.exists && record.get("accessGrantId") === grantId && record.get("patientUid") === user.uid) {
          transaction.set(recordRef, { accessRevoked: true, accessRevokedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        }
        if (codeRef && codeIndex?.exists) transaction.set(codeRef, { status: "REVOKED", revokedAt: FieldValue.serverTimestamp() }, { merge: true });
        transaction.create(auditRef, {
          actorUid: user.uid,
          action: "patient_clinical_access_grant_revoked",
          resource: `clinicalAccessGrants/${grantId}`,
          createdAt: FieldValue.serverTimestamp(),
        });
      });
      return res.status(200).json({ ok: true, grantId, status: "REVOKED", alreadyRevoked });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA patient clinical access request failed", {
        errorName: error instanceof Error ? error.name : "unknown-error",
      });
      return fail(res, 500, "clinical-access-unavailable", "Les autorisations d’accès clinique ne sont pas disponibles.");
    }
  });

  return { nexaPatientClinicalAccess };
};
