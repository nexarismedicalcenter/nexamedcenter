"use strict";

const { onRequest } = require("firebase-functions/v2/https");

function cleanText(value, maximum) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maximum) : "";
}

function requestBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from("{}");
  try {
    const body = JSON.parse(raw.toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function dateIso(value) {
  return value && typeof value.toDate === "function" ? value.toDate().toISOString() : null;
}

module.exports = function createNexaProfessionalFunctions(dependencies) {
  const { db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger } = dependencies;

  const nexaProfessionalApplication = onRequest({ region: "us-east4" }, async (req, res) => {
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
      await enforceUserRateLimit(user.uid, req.method === "GET" ? "read-doctor-application" : "submit-doctor-application", req.method === "GET" ? 30 : 4, 10 * 60_000);
      res.set("Cache-Control", "no-store, max-age=0");
      const applicationRef = db.collection("professionalApplications").doc(user.uid);

      if (req.method === "GET") {
        const snapshot = await applicationRef.get();
        if (!snapshot.exists) return res.status(200).json({ ok: true, status: "not_submitted" });
        const application = snapshot.data() || {};
        if (application.uid !== user.uid || application.providerType !== "doctor") {
          return res.status(200).json({ ok: true, status: "other_application" });
        }
        const profile = application.profile && typeof application.profile === "object" && !Array.isArray(application.profile) ? application.profile : {};
        const sourceStatus = application.status === "verified" ? "approved" : application.status;
        const status = ["pending", "approved", "rejected"].includes(sourceStatus) ? sourceStatus : "unknown";
        return res.status(200).json({
          ok: true,
          status,
          submittedAt: dateIso(application.submittedAt),
          reviewNote: status === "rejected" ? cleanText(application.reviewNote, 500) : "",
          ...(status === "rejected" ? {
            profile: {
              name: cleanText(profile.name, 120),
              specialty: cleanText(profile.specialty, 100),
              indicativeFee: Number.isSafeInteger(profile.indicativeFee) ? profile.indicativeFee : "",
              phone: cleanText(profile.publicPhone, 30),
              department: cleanText(profile.department, 80),
              commune: cleanText(profile.commune, 80),
              publicBio: cleanText(profile.publicBio, 300),
            },
          } : {}),
        });
      }

      if (!user.email) throw new ApiError(400, "email-required", "Une adresse e-mail est nécessaire pour déposer une candidature.");
      const body = requestBody(req);
      if (!body) throw new ApiError(400, "invalid-request", "La requête est invalide.");
      const name = cleanText(body.name, 120);
      const specialty = cleanText(body.specialty, 100);
      const phone = cleanText(body.phone, 30);
      const department = cleanText(body.department, 80);
      const commune = cleanText(body.commune, 80);
      const publicBio = typeof body.publicBio === "string" ? body.publicBio.trim() : "";
      const indicativeFee = body.indicativeFee;
      if (!name || !specialty || !phone || !department || !commune || publicBio.length > 300 ||
        !/^\+?[0-9\s().-]{7,30}$/.test(phone) || body.termsAccepted !== true) {
        throw new ApiError(400, "invalid-doctor-application", "Vérifiez les coordonnées, la spécialité, la présentation et l’acceptation des conditions.");
      }
      if (!Number.isSafeInteger(indicativeFee) || indicativeFee < 1 || indicativeFee > 10_000_000) {
        throw new ApiError(400, "consultation-fee-required", "Saisissez un tarif de consultation entier en HTG, entre 1 et 10 000 000.");
      }

      const providerRef = db.collection("providerProfiles").doc(user.uid);
      const result = await db.runTransaction(async (transaction) => {
        const [applicationSnapshot, providerSnapshot] = await Promise.all([
          transaction.get(applicationRef), transaction.get(providerRef),
        ]);
        const previous = applicationSnapshot.data() || {};
        if (providerSnapshot.exists && providerSnapshot.get("status") === "verified") {
          throw new ApiError(409, "provider-already-verified", "Ce compte dispose déjà d’un profil professionnel vérifié.");
        }
        if (providerSnapshot.exists && providerSnapshot.get("type") && providerSnapshot.get("type") !== "doctor") {
          throw new ApiError(409, "provider-type-conflict", "Ce compte possède déjà un autre type de profil professionnel.");
        }
        if (previous.status === "pending") {
          if (previous.providerType === "doctor") return { applicationId: applicationRef.id, alreadySubmitted: true };
          throw new ApiError(409, "other-application-pending", "Une autre candidature professionnelle est déjà en cours pour ce compte.");
        }
        if (previous.status === "approved" || previous.status === "verified") {
          throw new ApiError(409, "application-already-approved", "Cette candidature a déjà été approuvée. Connectez-vous à votre espace médecin.");
        }
        if (applicationSnapshot.exists && previous.providerType !== "doctor") {
          throw new ApiError(409, "provider-type-conflict", "Ce compte est associé à une autre candidature professionnelle.");
        }

        transaction.set(applicationRef, {
          uid: user.uid,
          email: user.email,
          providerType: "doctor",
          profile: { name, specialty, indicativeFee, publicBio, publicPhone: phone, department, commune },
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
          action: "doctor_affiliation_application_submitted",
          resource: `professionalApplications/${user.uid}`,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      return res.status(200).json({ ok: true, ...result, status: "pending" });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA doctor application failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "doctor-application-unavailable", "La candidature médecin n’est pas accessible pour le moment.");
    }
  });

  return { nexaProfessionalApplication };
};
