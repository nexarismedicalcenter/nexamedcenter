"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const { FieldPath } = require("firebase-admin/firestore");

const REGION = "us-east4";
const AVAILABILITY_PAGE_SIZE = 100;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function cleanText(value, maximum = 180) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, maximum) : "";
}

function normalize(value, maximum = 500) {
  return cleanText(value, maximum).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeOrderText(value) {
  return cleanText(value, 500).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/\s+/g, " ");
}

function compatibleText(requested, candidate) {
  const wanted = new Set(normalize(requested).split(/\s+/).filter((token) => token.length >= 2));
  const available = new Set(normalize(candidate).split(/\s+/).filter(Boolean));
  return wanted.size > 0 && [...wanted].every((token) => available.has(token));
}

function patientLocation(value = {}) {
  return { department: cleanText(value.department, 80), commune: cleanText(value.commune, 80) };
}

function rankLocation(patient, provider) {
  const patientDepartment = normalize(patient.department);
  const patientCommune = normalize(patient.commune);
  const providerDepartment = normalize(provider.department);
  const providerCommune = normalize(provider.commune);
  if (patientCommune && providerCommune && patientCommune === providerCommune && patientDepartment === providerDepartment) return 0;
  if (patientDepartment && providerDepartment && patientDepartment === providerDepartment) return 1;
  return 2;
}

function localCalendarDate(now) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Port-au-Prince", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validDateOnly(value) {
  if (!DATE_ONLY.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function lotAvailable(lot, now) {
  if (String(lot.status || "ACTIVE").toUpperCase() !== "ACTIVE") return 0;
  const expires = typeof lot.expirationDate === "string" ? lot.expirationDate.trim() : "";
  if (DATE_ONLY.test(expires)) {
    if (!validDateOnly(expires) || expires < localCalendarDate(now)) return 0;
  } else {
    const expiresAt = Date.parse(expires);
    if (!Number.isFinite(expiresAt) || expiresAt < now) return 0;
  }
  const available = Number.isSafeInteger(lot.quantityAvailable) && lot.quantityAvailable >= 0 ? lot.quantityAvailable : 0;
  const reserved = Number.isSafeInteger(lot.reservedQuantity) && lot.reservedQuantity >= 0 ? lot.reservedQuantity : 0;
  return Math.max(0, available - reserved);
}

function sellableStock(product, now = Date.now()) {
  return Array.isArray(product.lots) ? product.lots.reduce((total, lot) => total + lotAvailable(lot && typeof lot === "object" ? lot : {}, now), 0) : 0;
}

function prescriptionLines(prescription) {
  const medications = Array.isArray(prescription.medications) ? prescription.medications : [];
  const labs = Array.isArray(prescription.labExams) ? prescription.labExams : [];
  const imaging = Array.isArray(prescription.imagingExams) ? prescription.imagingExams : [];
  return [
    ...medications.map((raw, index) => {
      const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      return { id: `medication-${index + 1}`, type: "medication", label: cleanText(item.name || item.medication_text, 180), dosage: cleanText(item.dosage, 100), form: cleanText(item.form || item.pharmaceuticalForm, 100), route: cleanText(item.route, 120), quantity: Number.isSafeInteger(item.quantity) && item.quantity > 0 ? Math.min(item.quantity, 20) : 1 };
    }),
    ...labs.map((raw, index) => {
      const item = typeof raw === "string" ? { name: raw } : raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      return { id: `laboratory-${index + 1}`, type: "laboratory", label: cleanText(item.name || item.label, 180) };
    }),
    ...imaging.map((raw, index) => {
      const item = typeof raw === "string" ? { name: raw } : raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      return { id: `imaging-${index + 1}`, type: "imaging", label: cleanText(item.name || item.label, 180) };
    }),
  ].filter((line) => line.label);
}

function medicationMatches(line, product) {
  const name = normalizeOrderText(line.label);
  if (!name || (name !== normalizeOrderText(product.name) && name !== normalizeOrderText(product.dci))) return false;
  const requestedDosage = normalizeOrderText(line.dosage);
  const offeredDosage = normalizeOrderText(product.dosage);
  if (!requestedDosage || !offeredDosage || requestedDosage !== offeredDosage) return false;
  const requestedRoute = normalize(line.route);
  const offeredRoute = normalize(product.route);
  if (!offeredRoute || (requestedRoute && requestedRoute !== offeredRoute)) return false;
  const requestedForm = normalize(line.form);
  const offeredForm = normalize(product.pharmaceuticalForm || product.form);
  return !requestedForm || Boolean(offeredForm && compatibleText(requestedForm, offeredForm));
}

function diagnosticMatches(line, offer) {
  return normalizeOrderText(line.label) === normalizeOrderText(offer.name);
}

function getExpiry(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value && typeof value.toMillis === "function") {
    const millis = Number(value.toMillis());
    return Number.isFinite(millis) ? millis : 0;
  }
  const millis = typeof value === "string" || value instanceof Date ? Date.parse(value) : Number.NaN;
  return Number.isFinite(millis) ? millis : 0;
}

function parseAvailabilityCursor(value, prescriptionId, ApiError) {
  const empty = {
    prescriptionId,
    products: { after: null, done: false },
    offers: { after: null, done: false },
  };
  if (value === undefined || value === "") return empty;
  if (typeof value !== "string" || value.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApiError(400, "invalid-availability-cursor", "Le repère de recherche de l’ordonnance n’est pas valide.");
  }
  let cursor;
  try { cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch {
    throw new ApiError(400, "invalid-availability-cursor", "Le repère de recherche de l’ordonnance n’est pas valide.");
  }
  const validStream = (stream) => stream && typeof stream === "object" && !Array.isArray(stream) &&
    Object.keys(stream).sort().join(",") === "after,done" && typeof stream.done === "boolean" &&
    (stream.after === null || (typeof stream.after === "string" && /^[A-Za-z0-9_-]{10,200}$/.test(stream.after)));
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) ||
    Object.keys(cursor).sort().join(",") !== "offers,products,prescriptionId" ||
    cursor.prescriptionId !== prescriptionId || !validStream(cursor.products) || !validStream(cursor.offers)) {
    throw new ApiError(400, "invalid-availability-cursor", "Le repère de recherche ne correspond pas à cette ordonnance.");
  }
  return cursor;
}

function encodeAvailabilityCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

module.exports = function createNexaPrescriptionAvailabilityFunctions(dependencies) {
  const { db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger } = dependencies;

  const nexaPrescriptionAvailability = onRequest({ region: REGION }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") {
      res.set("Allow", "GET, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "prescription-availability", 24, 5 * 60_000);
      const prescriptionId = typeof req.query.prescriptionId === "string" ? req.query.prescriptionId.trim() : "";
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(prescriptionId)) throw new ApiError(400, "invalid-prescription", "La référence de l’ordonnance n’est pas valide.");
      const cursor = parseAvailabilityCursor(req.query.cursor, prescriptionId, ApiError);
      const [patientSnapshot, prescriptionSnapshot] = await Promise.all([
        db.collection("patientProfiles").doc(user.uid).get(),
        db.collection("clinicalPrescriptions").doc(prescriptionId).get(),
      ]);
      if (!patientSnapshot.exists || patientSnapshot.get("role") !== "patient" || patientSnapshot.get("profileComplete") !== true) throw new ApiError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
      const prescription = prescriptionSnapshot.data() || {};
      if (!prescriptionSnapshot.exists || prescription.patientUid !== user.uid || prescription.status !== "VALIDATED") {
        await db.collection("adminAuditLogs").add({ actorUid: user.uid, action: "prescription_availability_access_denied", resource: `clinicalPrescriptions/${prescriptionId}`, createdAt: FieldValue.serverTimestamp() }).catch(() => {});
        throw new ApiError(403, "prescription-not-available", "Cette ordonnance validée n’est pas accessible pour ce compte.");
      }
      const expiresAt = getExpiry(prescription.expiresAt);
      if (expiresAt !== null && expiresAt <= Date.now()) throw new ApiError(409, "prescription-expired", "Cette ordonnance a expiré et ne peut plus être utilisée.");

      const home = patientLocation(patientSnapshot.data() || {});
      const department = cleanText(req.query.department, 80);
      const commune = cleanText(req.query.commune, 80);
      const searchLocation = department || commune ? { department: department || home.department, commune: commune || home.commune } : home;
      const lines = prescriptionLines(prescription);
      const needsMedicine = lines.some((line) => line.type === "medication");
      const needsLab = lines.some((line) => line.type === "laboratory");
      const needsImaging = lines.some((line) => line.type === "imaging");
      const needsDiagnostic = needsLab || needsImaging;
      const productsCollection = db.collection("pharmacyProducts");
      const offersCollection = db.collection("diagnosticOffers");
      let productsQuery = productsCollection.where("publicationStatus", "==", "PUBLISHED").orderBy(FieldPath.documentId());
      let offersQuery = offersCollection.where("publicationStatus", "==", "PUBLISHED").where("active", "==", true).orderBy(FieldPath.documentId());
      if (cursor.products.after) productsQuery = productsQuery.startAfter(productsCollection.doc(cursor.products.after));
      if (cursor.offers.after) offersQuery = offersQuery.startAfter(offersCollection.doc(cursor.offers.after));
      const [productsSnapshot, offersSnapshot] = await Promise.all([
        needsMedicine && !cursor.products.done ? productsQuery.limit(AVAILABILITY_PAGE_SIZE + 1).get() : Promise.resolve(null),
        needsDiagnostic && !cursor.offers.done ? offersQuery.limit(AVAILABILITY_PAGE_SIZE + 1).get() : Promise.resolve(null),
      ]);
      const productHasMore = Boolean(productsSnapshot && productsSnapshot.docs.length > AVAILABILITY_PAGE_SIZE);
      const offerHasMore = Boolean(offersSnapshot && offersSnapshot.docs.length > AVAILABILITY_PAGE_SIZE);
      const productPage = productsSnapshot ? productsSnapshot.docs.slice(0, AVAILABILITY_PAGE_SIZE) : [];
      const offerPage = offersSnapshot ? offersSnapshot.docs.slice(0, AVAILABILITY_PAGE_SIZE) : [];
      const nextCursor = {
        prescriptionId,
        products: {
          after: productHasMore ? productPage[productPage.length - 1]?.id || cursor.products.after : productPage[productPage.length - 1]?.id || cursor.products.after,
          done: !productHasMore,
        },
        offers: {
          after: offerHasMore ? offerPage[offerPage.length - 1]?.id || cursor.offers.after : offerPage[offerPage.length - 1]?.id || cursor.offers.after,
          done: !offerHasMore,
        },
      };
      if (!needsMedicine) nextCursor.products = { after: null, done: true };
      if (!needsDiagnostic) nextCursor.offers = { after: null, done: true };
      const productDocs = productPage;
      const offerDocs = offerPage;
      const providerIds = [...new Set([...productDocs.map((doc) => String(doc.get("providerUid") || "")), ...offerDocs.map((doc) => String(doc.get("providerUid") || ""))].filter((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id)))];
      const providerSnapshots = [];
      for (let offset = 0; offset < providerIds.length; offset += 250) {
        providerSnapshots.push(...await db.getAll(...providerIds.slice(offset, offset + 250).map((id) => db.collection("providerProfiles").doc(id))));
      }
      const providers = new Map(providerSnapshots.filter((doc) => doc.exists && doc.get("status") === "verified" && doc.get("publiclyListed") === true).map((doc) => [doc.id, doc.data() || {}]));
      const products = productDocs.flatMap((doc) => {
        const product = doc.data() || {};
        const providerUid = String(product.providerUid || "");
        const provider = providers.get(providerUid);
        const stock = sellableStock(product);
        if (!provider || provider.type !== "pharmacy" || product.active !== true || !Number.isSafeInteger(product.price) || product.price < 1 || stock < 1) return [];
        const profile = provider.profile && typeof provider.profile === "object" ? provider.profile : {};
        const prescriptionRequired = product.prescriptionRequired === true || product.regulatoryCategory !== "OTC";
        return [{ id: doc.id, providerName: cleanText(profile.name || profile.displayName || provider.displayName, 120) || "Pharmacie NEXA", location: patientLocation(profile), name: cleanText(product.name, 180), dci: cleanText(product.dci, 180), dosage: cleanText(product.dosage, 100), form: cleanText(product.pharmaceuticalForm, 100), route: cleanText(product.route, 120), price: product.price, stock, prescriptionRequired }];
      });
      const offers = offerDocs.flatMap((doc) => {
        const offer = doc.data() || {};
        const providerUid = String(offer.providerUid || "");
        const provider = providers.get(providerUid);
        const type = offer.providerType;
        if (!provider || !["laboratory", "imaging"].includes(type) || provider.type !== type || (type === "laboratory" && !needsLab) || (type === "imaging" && !needsImaging) || offer.requestedAvailability === false) return [];
        const profile = provider.profile && typeof provider.profile === "object" ? provider.profile : {};
        return [{ id: doc.id, providerType: type, providerName: cleanText(profile.name || profile.displayName || provider.displayName, 120) || "Partenaire NEXA", location: patientLocation(profile), name: cleanText(offer.name, 180), price: Number.isSafeInteger(offer.price) && offer.price >= 0 ? offer.price : null, appointmentRequired: offer.appointmentRequired === true }];
      });

      const availableLines = lines.map((line) => {
        const matches = line.type === "medication"
          ? products.filter((product) => product.prescriptionRequired && medicationMatches(line, product)).map((product) => ({ ...product, type: line.type, catalogType: "pharmacies" }))
          : offers.filter((offer) => offer.providerType === line.type && diagnosticMatches(line, offer)).map((offer) => ({ ...offer, type: line.type, catalogType: line.type === "laboratory" ? "laboratories" : "imaging-centers" }));
        matches.sort((left, right) => rankLocation(searchLocation, left.location) - rankLocation(searchLocation, right.location) || (Number(left.price) || 0) - (Number(right.price) || 0));
        const searchComplete = line.type === "medication" ? nextCursor.products.done : nextCursor.offers.done;
        return { ...line, searchComplete, status: matches.length ? "DISPONIBLE" : searchComplete ? "NON_DISPONIBLE" : "SEARCH_INCOMPLETE",
          offers: matches.map(({ location, ...offer }) => ({ ...offer, department: location.department, commune: location.commune })) };
      });
      const hasMore = !nextCursor.products.done || !nextCursor.offers.done;
      await db.collection("adminAuditLogs").add({ actorUid: user.uid, action: "prescription_availability_checked", resource: `clinicalPrescriptions/${prescriptionId}`, context: { lineCount: availableLines.length, availableLineCount: availableLines.filter((line) => line.status === "DISPONIBLE").length, productPageCount: productDocs.length, offerPageCount: offerDocs.length, cursorUsed: req.query.cursor !== undefined }, createdAt: FieldValue.serverTimestamp() }).catch(() => {});
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, patientLocation: home, searchLocation, lines: availableLines,
        hasMore, nextCursor: hasMore ? encodeAvailabilityCursor(nextCursor) : null });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA prescription availability failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "prescription-availability-unavailable", "Les disponibilités de cette ordonnance ne sont pas accessibles pour le moment.");
    }
  });

  return { nexaPrescriptionAvailability };
};
