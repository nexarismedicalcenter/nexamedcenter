"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const { FieldPath } = require("firebase-admin/firestore");
const { normalizeRequirements } = require("./nexa-diagnostic-provider");

const REGION = "us-east4";
const OFFER_REVIEW_PAGE_SIZE = 50;
const REVIEW_ACTIONS = new Set(["PUBLISH", "UPDATE_REQUIREMENTS", "REQUEST_CORRECTION", "REJECT", "SUSPEND", "ARCHIVE"]);

function cleanText(value, maximum) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

function requestBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  if (!Buffer.isBuffer(req.rawBody)) return null;
  try {
    const value = JSON.parse(req.rawBody.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

module.exports = function createNexaAdminDiagnosticOfferFunctions(dependencies) {
  const { db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger, createNexaNotification } = dependencies;

  const nexaAdminDiagnosticOffers = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) {
      res.set("Allow", "GET, POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if (req.method === "POST" && ((Number(req.get("Content-Length")) || 0) > 16_384 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 16_384))) {
      return fail(res, 413, "request-too-large", "La demande de revue est trop volumineuse.");
    }

    try {
      const admin = await requireUser(req);
      await requireAppCheckToken(req);
      const administrators = new Set(String(process.env.NEXA_ADMIN_UIDS || "").split(",").map((value) => value.trim()).filter(Boolean));
      if (!administrators.size) throw new ApiError(503, "admin-access-not-configured", "L’accès administrateur NEXA n’est pas configuré.");
      if (!administrators.has(admin.uid)) throw new ApiError(403, "administrator-required", "Accès administrateur requis.");
      await enforceUserRateLimit(admin.uid, req.method === "GET" ? "admin-diagnostic-offers-read" : "admin-diagnostic-offers-review", req.method === "GET" ? 60 : 30, 60_000);
      res.set("Cache-Control", "no-store, max-age=0");

      if (req.method === "GET") {
        const rawCursor = typeof req.query?.cursor === "string" ? req.query.cursor : "";
        if (rawCursor && (!/^[A-Za-z0-9_-]{10,200}$/.test(rawCursor) || rawCursor.includes("/"))) {
          throw new ApiError(400, "invalid-diagnostic-offer-cursor", "Le repère des offres diagnostiques n’est pas valide.");
        }
        const collection = db.collection("diagnosticOffers");
        let query = collection
          .where("publicationStatus", "in", ["PENDING_REVIEW", "PUBLISHED"])
          .orderBy(FieldPath.documentId());
        if (rawCursor) query = query.startAfter(collection.doc(rawCursor));
        const snapshot = await query.limit(OFFER_REVIEW_PAGE_SIZE + 1).get();
        const hasMore = snapshot.docs.length > OFFER_REVIEW_PAGE_SIZE;
        const page = snapshot.docs.slice(0, OFFER_REVIEW_PAGE_SIZE);
        const offers = page.map((doc) => {
          const data = doc.data() || {};
          const providerType = cleanText(data.providerType, 20);
          const requirementsType = providerType === "imaging" ? "imaging" : "laboratory";
          return {
            id: doc.id,
            publicationStatus: data.publicationStatus === "PUBLISHED" ? "PUBLISHED" : "PENDING_REVIEW",
            providerUid: cleanText(data.providerUid, 128),
            providerType,
            name: cleanText(data.name, 180),
            category: cleanText(data.category, 120),
            description: cleanText(data.description, 500),
            specimenType: cleanText(data.specimenType, 120),
            preparation: cleanText(data.preparation, 1_000),
            precautions: cleanText(data.precautions, 1_000),
            technique: cleanText(data.technique, 180),
            resultDelay: cleanText(data.resultDelay, 160),
            instructions: cleanText(data.instructions, 1_200),
            price: Number.isSafeInteger(data.price) && data.price >= 0 ? data.price : 0,
            requiresPrescription: data.requiresPrescription === true,
            appointmentRequired: data.appointmentRequired === true,
            homeSampling: data.homeSampling === true,
            requestedAvailability: data.requestedAvailability !== false,
            resultRequirements: normalizeRequirements(data.resultRequirements, requirementsType, ApiError, 409),
          };
        });
        await db.collection("adminAuditLogs").doc().create({
          actorUid: admin.uid, action: "diagnostic_offers_review_listed", resultCount: offers.length, cursorUsed: Boolean(rawCursor), createdAt: FieldValue.serverTimestamp(),
        });
        return res.status(200).json({ ok: true, offers, hasMore, nextCursor: hasMore ? page[page.length - 1]?.id || null : null });
      }

      const body = requestBody(req);
      const offerId = cleanText(body?.offerId, 200);
      const action = cleanText(body?.action, 40).toUpperCase();
      const reason = cleanText(body?.reason, 500);
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(offerId) || !REVIEW_ACTIONS.has(action)) {
        throw new ApiError(400, "invalid-diagnostic-offer-review", "L’offre ou la décision de revue n’est pas valide.");
      }
      if (!["PUBLISH", "UPDATE_REQUIREMENTS"].includes(action) && !reason) {
        throw new ApiError(400, "review-reason-required", "Un motif est obligatoire pour cette décision.");
      }
      if (action === "UPDATE_REQUIREMENTS" && body.resultRequirements === undefined) {
        throw new ApiError(400, "result-requirements-required", "Les exigences à enregistrer sont manquantes.");
      }

      const offerRef = db.collection("diagnosticOffers").doc(offerId);
      const auditRef = db.collection("adminAuditLogs").doc();
      const outcome = await db.runTransaction(async (transaction) => {
        const offerSnapshot = await transaction.get(offerRef);
        if (!offerSnapshot.exists) throw new ApiError(404, "diagnostic-offer-not-found", "Cette offre est introuvable.");
        const offer = offerSnapshot.data() || {};
        const providerType = cleanText(offer.providerType, 20);
        if (!["laboratory", "imaging"].includes(providerType)) {
          throw new ApiError(409, "diagnostic-provider-type-invalid", "Le type de partenaire de cette offre doit être vérifié.");
        }
        const providerRef = db.collection("providerProfiles").doc(cleanText(offer.providerUid, 128) || "_");
        const providerSnapshot = await transaction.get(providerRef);
        const resultRequirements = ["PUBLISH", "UPDATE_REQUIREMENTS"].includes(action)
          ? normalizeRequirements(body.resultRequirements, providerType, ApiError, 400)
          : undefined;

        if (action === "UPDATE_REQUIREMENTS" && offer.publicationStatus !== "PUBLISHED") {
          throw new ApiError(409, "diagnostic-offer-not-published", "Seule une offre publiée peut recevoir une mise à jour de ses exigences.");
        }
        if (action === "PUBLISH" && offer.publicationStatus !== "PENDING_REVIEW") {
          throw new ApiError(409, "diagnostic-offer-not-pending", "Seule une offre en attente de revue peut être publiée.");
        }
        if (action === "PUBLISH" && (!providerSnapshot.exists || providerSnapshot.get("type") !== providerType || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true)) {
          throw new ApiError(409, "diagnostic-provider-not-publishable", "Le partenaire propriétaire n’est plus vérifié et publié.");
        }
        if (action === "PUBLISH" && (cleanText(offer.name, 180).length < 2 || !Number.isSafeInteger(offer.price) || offer.price < 0 || offer.price > 10_000_000)) {
          throw new ApiError(409, "diagnostic-offer-incomplete", "Le nom et le prix HTG de l’offre doivent être valides avant publication.");
        }

        const status = action === "PUBLISH" || action === "UPDATE_REQUIREMENTS" ? "PUBLISHED"
          : action === "REQUEST_CORRECTION" ? "NEEDS_CORRECTION"
            : action === "SUSPEND" ? "SUSPENDED"
              : action === "ARCHIVE" ? "ARCHIVED" : "REJECTED";
        if (action === "UPDATE_REQUIREMENTS") {
          transaction.update(offerRef, { resultRequirements, updatedAt: FieldValue.serverTimestamp() });
        } else {
          transaction.set(offerRef, {
            publicationStatus: status,
            active: action === "PUBLISH" && offer.requestedAvailability !== false,
            reviewReason: action === "PUBLISH" ? "" : reason,
            reviewedByUid: admin.uid,
            reviewedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            ...(resultRequirements ? { resultRequirements } : {}),
          }, { merge: true });
        }
        transaction.create(auditRef, {
          actorUid: admin.uid,
          action: action === "UPDATE_REQUIREMENTS" ? "diagnostic_offer_requirements_updated" : `diagnostic_offer_${action.toLowerCase()}`,
          resource: `diagnosticOffers/${offerId}`,
          providerType,
          ...(resultRequirements ? { resultRequirements } : {}),
          createdAt: FieldValue.serverTimestamp(),
        });
        return { providerUid: cleanText(offer.providerUid, 128), status, action };
      });

      if (outcome.providerUid) {
        const notification = {
          type: "diagnostic_offer_review",
          title: outcome.action === "UPDATE_REQUIREMENTS" ? "Exigences de résultat mises à jour"
            : outcome.status === "PUBLISHED" ? "Offre publiée"
              : outcome.status === "NEEDS_CORRECTION" ? "Correction demandée"
                : outcome.status === "SUSPENDED" ? "Offre suspendue"
                  : outcome.status === "ARCHIVED" ? "Offre archivée" : "Offre refusée",
          body: outcome.action === "UPDATE_REQUIREMENTS"
            ? "Les exigences mises à jour s’appliquent aux nouvelles commandes; les commandes existantes conservent leurs exigences initiales."
            : outcome.status === "PUBLISHED" ? "Votre offre est publiée dans le répertoire NEXA."
              : reason,
          url: "/espace-centre.html",
        };
        try { await createNexaNotification(outcome.providerUid, `diagnostic-offer-review:${offerId}:${auditRef.id}`, notification); }
        catch (error) { logger.warn("NEXA diagnostic offer notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }); }
      }
      return res.status(200).json({ ok: true, offerId, publicationStatus: outcome.status, action: outcome.action });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA admin diagnostic offers failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "admin-diagnostic-offers-unavailable", "Les offres diagnostiques ne sont pas accessibles.");
    }
  });

  return { nexaAdminDiagnosticOffers };
};
