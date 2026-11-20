"use strict";

const { onRequest } = require("firebase-functions/v2/https");

const PARTNER_TYPES = new Set(["pharmacy", "laboratory", "imaging"]);

function text(value, maximum) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized.length <= maximum ? normalized : "";
}

function requestBody(req) {
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) return req.body;
  try {
    const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString("utf8") : "";
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function dateIso(value) {
  return value && typeof value.toDate === "function" ? value.toDate().toISOString() : null;
}

module.exports = function createNexaPartnerFunctions(dependencies) {
  const { db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger } = dependencies;

  const nexaPartnerApplication = onRequest({ region: "us-east4" }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) {
      res.set("Allow", "GET, POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if (req.method === "POST" && ((Number(req.get("Content-Length")) || 0) > 16_384 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 16_384))) {
      return fail(res, 413, "request-too-large", "La candidature dépasse la taille autorisée.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, req.method === "GET" ? "read-partner-application" : "submit-partner-application", req.method === "GET" ? 30 : 4, 10 * 60_000);
      res.set("Cache-Control", "no-store, max-age=0");
      const applicationRef = db.collection("professionalApplications").doc(user.uid);

      if (req.method === "GET") {
        const snapshot = await applicationRef.get();
        if (!snapshot.exists) return res.status(200).json({ ok: true, status: "not_submitted" });
        const application = snapshot.data() || {};
        if (application.uid !== user.uid || !PARTNER_TYPES.has(application.providerType)) {
          return res.status(200).json({ ok: true, status: "other_application" });
        }
        const profile = application.profile && typeof application.profile === "object" && !Array.isArray(application.profile) ? application.profile : {};
        const storedStatus = application.status === "verified" ? "approved" : application.status;
        const status = ["pending", "approved", "rejected"].includes(storedStatus) ? storedStatus : "unknown";
        return res.status(200).json({
          ok: true,
          status,
          providerType: application.providerType,
          submittedAt: dateIso(application.submittedAt),
          reviewNote: status === "rejected" ? text(application.reviewNote, 500) : "",
          ...(status === "rejected" ? { profile: {
            name: text(profile.name, 120),
            phone: text(profile.publicPhone, 30),
            department: text(profile.department, 80),
            commune: text(profile.commune, 80),
            publicBio: text(profile.publicBio, 300),
          } } : {}),
        });
      }

      if (!user.email) throw new ApiError(400, "email-required", "Une adresse e-mail est nécessaire pour déposer une candidature.");
      const body = requestBody(req);
      if (!body) throw new ApiError(400, "invalid-request", "La requête est invalide.");
      const providerType = text(body.providerType, 20);
      const name = text(body.name, 120);
      const phone = text(body.phone, 30);
      const department = text(body.department, 80);
      const commune = text(body.commune, 80);
      const publicBio = typeof body.publicBio === "string" ? body.publicBio.trim() : "";
      if (!PARTNER_TYPES.has(providerType) || !name || !phone || !department || !commune || publicBio.length > 300 ||
        !/^\+?[0-9\s().-]{7,30}$/.test(phone) || body.termsAccepted !== true) {
        throw new ApiError(400, "invalid-partner-application", "Vérifiez le type de partenaire, les coordonnées et l’acceptation des conditions.");
      }

      const providerRef = db.collection("providerProfiles").doc(user.uid);
      const result = await db.runTransaction(async (transaction) => {
        const [applicationSnapshot, providerSnapshot] = await Promise.all([transaction.get(applicationRef), transaction.get(providerRef)]);
        const previous = applicationSnapshot.data() || {};
        const providerTypeOnProfile = providerSnapshot.get("type");
        if (providerSnapshot.exists && providerSnapshot.get("status") === "verified") {
          throw new ApiError(409, "provider-already-verified", "Ce compte dispose déjà d’un profil partenaire vérifié.");
        }
        if (providerSnapshot.exists && providerTypeOnProfile && providerTypeOnProfile !== providerType) {
          throw new ApiError(409, "provider-type-conflict", "Ce compte possède déjà un autre type de profil partenaire.");
        }
        if (previous.status === "pending") {
          if (previous.providerType === providerType) return { applicationId: applicationRef.id, alreadySubmitted: true };
          throw new ApiError(409, "other-application-pending", "Une autre candidature professionnelle est déjà en cours pour ce compte.");
        }
        if (["approved", "verified"].includes(previous.status)) {
          throw new ApiError(409, "application-already-approved", "Cette candidature a déjà été approuvée. Connectez-vous à l’espace partenaire.");
        }
        if (applicationSnapshot.exists && previous.providerType !== providerType) {
          throw new ApiError(409, "provider-type-conflict", "Ce compte est associé à une candidature professionnelle d’un autre type.");
        }

        transaction.set(applicationRef, {
          uid: user.uid,
          email: user.email,
          providerType,
          profile: { name, publicBio, publicPhone: phone, department, commune },
          status: "pending",
          termsAccepted: true,
          submittedAt: FieldValue.serverTimestamp(),
          reviewedAt: null,
          reviewedBy: null,
          reviewNote: null,
        });
        return { applicationId: applicationRef.id, alreadySubmitted: false };
      });

      if (!result.alreadySubmitted) {
        await db.collection("adminAuditLogs").doc().create({
          actorUid: user.uid,
          action: `${providerType}_partner_application_submitted`,
          resource: `professionalApplications/${user.uid}`,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      return res.status(200).json({ ok: true, ...result, status: "pending", providerType });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA partner application failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "partner-application-unavailable", "La candidature partenaire n’est pas accessible pour le moment.");
    }
  });

  return { nexaPartnerApplication };
};
