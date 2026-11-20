"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const { FieldPath } = require("firebase-admin/firestore");

const OFFER_PAGE_SIZE = 100;

function clean(value, max) {
  return typeof value === "string" ? value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "";
}

module.exports = function createNexaDiagnosticCatalogFunctions(dependencies) {
  const { db, requireAppCheckToken, setCors, fail, logger } = dependencies;

  const nexaDiagnosticPublicOffers = onRequest({ region: "us-east4", maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") {
      res.set("Allow", "GET, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }

    const requestedType = typeof req.query.type === "string" ? req.query.type : "";
    if (requestedType && !["laboratory", "imaging"].includes(requestedType)) {
      return fail(res, 400, "invalid-diagnostic-provider-type", "Type de centre invalide.");
    }
    const requestedOfferId = typeof req.query.offerId === "string" ? req.query.offerId.trim() : "";
    if (requestedOfferId && (!/^[A-Za-z0-9_-]{10,200}$/.test(requestedOfferId) || req.query.cursor)) {
      return fail(res, 400, "invalid-diagnostic-offer", "L’offre demandée n’est pas valide.");
    }
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : "";
    if (cursor.length > 1500 || cursor.includes("/") || /[\u0000-\u001f\u007f]/.test(cursor)) {
      return fail(res, 400, "invalid-diagnostic-offer-cursor", "Le repère des offres n’est pas valide.");
    }

    try {
      await requireAppCheckToken(req);
      const offersQuery = db.collection("diagnosticOffers")
        .where("publicationStatus", "==", "PUBLISHED")
        .where("active", "==", true)
        .orderBy(FieldPath.documentId());
      let page;
      let hasMore = false;
      if (requestedOfferId) {
        const offerSnapshot = await db.collection("diagnosticOffers").doc(requestedOfferId).get();
        page = offerSnapshot.exists ? [offerSnapshot] : [];
      } else {
        const pageQuery = cursor ? offersQuery.startAfter(cursor) : offersQuery;
        const snapshot = await pageQuery.limit(OFFER_PAGE_SIZE + 1).get();
        hasMore = snapshot.docs.length > OFFER_PAGE_SIZE;
        page = snapshot.docs.slice(0, OFFER_PAGE_SIZE);
      }
      const candidates = page
        .map((doc) => ({ ...doc.data(), id: doc.id }))
        .filter((offer) => offer.publicationStatus === "PUBLISHED" && offer.active === true &&
          ["laboratory", "imaging"].includes(String(offer.providerType)) &&
          (!requestedType || offer.providerType === requestedType) && offer.requestedAvailability !== false);
      const providerIds = [...new Set(candidates
        .map((offer) => String(offer.providerUid || ""))
        .filter((uid) => /^[A-Za-z0-9_-]{1,128}$/.test(uid)))];
      const providerSnapshots = providerIds.length
        ? await db.getAll(...providerIds.map((uid) => db.collection("providerProfiles").doc(uid)))
        : [];
      const providers = new Map(providerSnapshots
        .filter((provider) => provider.exists && provider.get("status") === "verified" && provider.get("publiclyListed") === true)
        .map((provider) => [provider.id, provider.data() || {}]));

      const offers = candidates.flatMap((offer) => {
        const providerUid = String(offer.providerUid || "");
        const provider = providers.get(providerUid);
        const providerType = String(offer.providerType);
        if (!provider || provider.type !== providerType) return [];
        const profile = provider.profile && typeof provider.profile === "object" && !Array.isArray(provider.profile)
          ? provider.profile
          : {};
        const name = clean(offer.name, 180);
        if (!name) return [];
        const price = Number(offer.price);

        return [{
          id: offer.id,
          providerUid,
          providerType,
          providerName: clean(profile.name || profile.displayName || provider.displayName, 120) || "Partenaire NEXA",
          department: clean(profile.department, 80),
          commune: clean(profile.commune, 80),
          address: clean(profile.address, 200),
          phone: clean(profile.publicPhone, 30),
          openingHours: clean(profile.openingHours, 300),
          name,
          category: clean(offer.category, 120),
          catalogExamId: clean(offer.catalogExamId, 120),
          description: clean(offer.description, 500),
          specimenType: clean(offer.specimenType, 120),
          preparation: clean(offer.preparation, 1000),
          precautions: clean(offer.precautions, 1000),
          technique: clean(offer.technique, 180),
          resultDelay: clean(offer.resultDelay, 160),
          instructions: clean(offer.instructions, 1200),
          price: Number.isSafeInteger(price) && price >= 0 ? price : null,
          requiresPrescription: offer.requiresPrescription === true,
          appointmentRequired: offer.appointmentRequired === true,
          homeSampling: offer.homeSampling === true,
        }];
      });

      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({
        ok: true,
        offers,
        hasMore,
        nextCursor: hasMore && page.length ? page[page.length - 1].id : null,
      });
    } catch (error) {
      logger.error("NEXA diagnostic public offers failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 503, "diagnostic-offers-unavailable", "Les offres des centres ne sont pas accessibles pour le moment.");
    }
  });

  return { nexaDiagnosticPublicOffers };
};
