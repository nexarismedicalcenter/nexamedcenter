"use strict";

const { createHash } = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");

const REGION = "us-east4";
const PROVIDER_TYPES = new Set(["laboratory", "imaging"]);
const PROFILE_FIELDS = new Set(["name", "address", "department", "commune", "publicPhone", "services", "openingHours"]);
const EDIT_REASONS = new Set(["PARTNER_REQUEST", "VERIFIED_CORRECTION", "ADMIN_QUALITY_REVIEW"]);

function cleanText(value, maximum) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum)
    : "";
}

function profileRevision(profile) {
  const source = profile && typeof profile === "object" && !Array.isArray(profile) ? profile : {};
  const value = {
    name: typeof source.name === "string" ? source.name.trim().slice(0, 160) : "",
    address: typeof source.address === "string" ? source.address.trim().slice(0, 200) : "",
    department: typeof source.department === "string" ? source.department.trim().slice(0, 80) : "",
    commune: typeof source.commune === "string" ? source.commune.trim().slice(0, 80) : "",
    publicPhone: typeof source.publicPhone === "string" ? source.publicPhone.trim().slice(0, 30) : "",
    services: Array.isArray(source.services)
      ? source.services.map((service) => typeof service === "string" ? service.trim().slice(0, 100) : "").filter(Boolean).slice(0, 12)
      : [],
    openingHours: typeof source.openingHours === "string" ? source.openingHours.trim().slice(0, 300) : "",
  };
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requestBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  if (!Buffer.isBuffer(req.rawBody)) return null;
  try {
    const body = JSON.parse(req.rawBody.toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function normalizeProfile(value, ApiError) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !PROFILE_FIELDS.has(key)) ||
    [...PROFILE_FIELDS].some((key) => !Object.hasOwn(value, key))) {
    throw new ApiError(400, "invalid-diagnostic-profile", "La fiche publique du partenaire est incomplète ou contient un champ non autorisé.");
  }
  const profile = {
    name: cleanText(value.name, 160),
    address: cleanText(value.address, 200),
    department: cleanText(value.department, 80),
    commune: cleanText(value.commune, 80),
    publicPhone: cleanText(value.publicPhone, 30),
    openingHours: cleanText(value.openingHours, 300),
  };
  if (profile.name.length < 2 || (profile.publicPhone &&
    (!/^[+0-9(). -]{6,30}$/.test(profile.publicPhone) || profile.publicPhone.replace(/\D/g, "").length < 6))) {
    throw new ApiError(400, "invalid-diagnostic-profile", "Vérifiez le nom et le numéro public du centre.");
  }
  if (!Array.isArray(value.services) || value.services.length > 12) {
    throw new ApiError(400, "invalid-diagnostic-services", "La liste de services doit contenir au maximum 12 éléments.");
  }
  const services = value.services.map((service) => cleanText(service, 100));
  if (services.some((service) => service.length < 2) || new Set(services.map((service) => service.toLocaleLowerCase("fr"))).size !== services.length) {
    throw new ApiError(400, "invalid-diagnostic-services", "Vérifiez les services : chaque entrée doit être renseignée et unique.");
  }
  return { ...profile, services };
}

module.exports = function createNexaAdminDiagnosticCenterFunctions(dependencies) {
  const { db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger } = dependencies;

  const nexaAdminDiagnosticCenters = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    res.set("Cache-Control", "no-store, max-age=0");
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      res.set("Allow", "POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if ((Number(req.get("Content-Length")) || 0) > 8_192 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 8_192)) {
      return fail(res, 413, "request-too-large", "La fiche publique dépasse la taille autorisée.");
    }

    try {
      const admin = await requireUser(req);
      await requireAppCheckToken(req);
      const administrators = new Set(String(process.env.NEXA_ADMIN_UIDS || "").split(",").map((value) => value.trim()).filter(Boolean));
      if (!administrators.size) throw new ApiError(503, "admin-access-not-configured", "L’accès administrateur NEXA n’est pas configuré.");
      if (!administrators.has(admin.uid)) throw new ApiError(403, "administrator-required", "Accès administrateur requis.");
      await enforceUserRateLimit(admin.uid, "admin-diagnostic-center-profile-write", 20, 60_000);

      const body = requestBody(req);
      if (!body || Object.keys(body).some((key) => !["action", "providerUid", "profile", "profileRevision", "reason"].includes(key)) ||
        body.action !== "UPDATE_PUBLIC_PROFILE") {
        throw new ApiError(400, "invalid-diagnostic-center-action", "L’action de mise à jour de la fiche n’est pas valide.");
      }
      const providerUid = typeof body.providerUid === "string" ? body.providerUid.trim() : "";
      const expectedProfileRevision = typeof body.profileRevision === "string" ? body.profileRevision : "";
      const reason = typeof body.reason === "string" ? body.reason : "";
      if (!/^[A-Za-z0-9:_-]{10,128}$/.test(providerUid)) throw new ApiError(400, "invalid-diagnostic-partner", "Le compte partenaire n’est pas valide.");
      if (!/^[a-f0-9]{64}$/.test(expectedProfileRevision)) throw new ApiError(400, "invalid-diagnostic-profile-revision", "Actualisez la fiche avant de l’enregistrer.");
      if (!EDIT_REASONS.has(reason)) throw new ApiError(400, "diagnostic-profile-reason-required", "Choisissez un motif autorisé pour cette correction.");
      const profile = normalizeProfile(body.profile, ApiError);
      const providerRef = db.collection("providerProfiles").doc(providerUid);
      const auditRef = db.collection("adminAuditLogs").doc();

      const outcome = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(providerRef);
        if (!snapshot.exists || !PROVIDER_TYPES.has(String(snapshot.get("type") || ""))) {
          throw new ApiError(404, "diagnostic-partner-not-found", "Ce compte n’est pas un partenaire de laboratoire ou d’imagerie.");
        }
        const current = snapshot.get("profile");
        const currentProfile = current && typeof current === "object" && !Array.isArray(current) ? current : {};
        if (profileRevision(currentProfile) !== expectedProfileRevision) {
          throw new ApiError(409, "diagnostic-profile-changed", "La fiche a été modifiée ailleurs. Actualisez le répertoire avant de réessayer.");
        }
        const previousProfile = {
          name: cleanText(currentProfile.name, 160),
          address: cleanText(currentProfile.address, 200),
          department: cleanText(currentProfile.department, 80),
          commune: cleanText(currentProfile.commune, 80),
          publicPhone: cleanText(currentProfile.publicPhone, 30),
          services: Array.isArray(currentProfile.services) ? currentProfile.services.map((service) => cleanText(service, 100)).filter(Boolean).slice(0, 12) : [],
          openingHours: cleanText(currentProfile.openingHours, 300),
        };
        const changedFields = [...PROFILE_FIELDS].filter((key) => JSON.stringify(previousProfile[key]) !== JSON.stringify(profile[key]));
        if (!changedFields.length) return { type: snapshot.get("type"), updated: false };
        transaction.update(providerRef, {
          profile: { ...currentProfile, ...profile },
          updatedAt: FieldValue.serverTimestamp(),
          adminProfileUpdatedAt: FieldValue.serverTimestamp(),
          adminProfileUpdatedBy: admin.uid,
        });
        transaction.create(auditRef, {
          actorUid: admin.uid,
          action: "diagnostic_partner_public_profile_updated",
          resource: "providerProfiles/" + providerUid,
          providerType: snapshot.get("type"),
          changedFields,
          reason,
          createdAt: FieldValue.serverTimestamp(),
        });
        return { type: snapshot.get("type"), updated: true };
      });
      return res.status(200).json({ ok: true, providerUid, providerType: outcome.type, updated: outcome.updated });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA diagnostic center profile update failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "diagnostic-center-profile-unavailable", "La fiche publique du partenaire n’a pas pu être mise à jour.");
    }
  });

  return { nexaAdminDiagnosticCenters };
};
