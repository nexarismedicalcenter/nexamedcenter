"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

const REGION = "us-east4";
const HOLD_MINUTES = 30;
const PAYMENT_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function pharmacyDeliveryEnabled() {
  return process.env.NEXA_PHARMACY_DELIVERY_ENABLED === "true";
}

function clean(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

function bodyOf(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  if (!Buffer.isBuffer(req.rawBody)) return null;
  try {
    const value = JSON.parse(req.rawBody.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function normalized(value) {
  return clean(value, 500).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/\s+/g, " ").trim();
}

function normalizeAvailability(value) {
  return normalized(value).replace(/[^a-z0-9]+/g, " ").trim();
}

function localCalendarDate(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Port-au-Prince", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validDateOnly(value) {
  if (!DATE_ONLY_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function lotExpiryMillis(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (DATE_ONLY_PATTERN.test(text)) {
    if (!validDateOnly(text)) return null;
    const [year, month, day] = text.split("-").map(Number);
    return Date.UTC(year, month - 1, day) + 86_400_000 - 1;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeInteger(value, min = 0, max = 1_000_000) {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : 0;
}

function normalizedLots(product, now = Date.now()) {
  const today = localCalendarDate(now);
  return (Array.isArray(product.lots) ? product.lots : []).map((raw) => {
    const lot = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
    const expirationDate = typeof lot.expirationDate === "string" ? lot.expirationDate.trim() : "";
    const expired = DATE_ONLY_PATTERN.test(expirationDate)
      ? !validDateOnly(expirationDate) || expirationDate < today
      : lotExpiryMillis(expirationDate) === null || lotExpiryMillis(expirationDate) < now;
    if (String(lot.status || "ACTIVE").toUpperCase() === "ACTIVE" && expired) lot.status = "EXPIRED";
    lot.lotNumber = clean(lot.lotNumber, 80);
    lot.quantityAvailable = safeInteger(lot.quantityAvailable);
    lot.reservedQuantity = safeInteger(lot.reservedQuantity);
    return lot;
  });
}

function lotSellable(lot, now = Date.now()) {
  if (String(lot.status || "ACTIVE").toUpperCase() !== "ACTIVE") return 0;
  const expirationDate = typeof lot.expirationDate === "string" ? lot.expirationDate.trim() : "";
  if (DATE_ONLY_PATTERN.test(expirationDate)) {
    if (!validDateOnly(expirationDate) || expirationDate < localCalendarDate(now)) return 0;
  } else {
    const expires = lotExpiryMillis(expirationDate);
    if (expires === null || expires < now) return 0;
  }
  return safeInteger(lot.quantityAvailable);
}

function stockSummary(lots, now = Date.now()) {
  return {
    stock: lots.reduce((sum, lot) => sum + lotSellable(lot, now), 0),
    reservedStock: lots.reduce((sum, lot) => sum + safeInteger(lot.reservedQuantity), 0),
  };
}

function availableStock(lots, now = Date.now()) {
  return lots.reduce((sum, lot) => sum + Math.max(0, lotSellable(lot, now) - safeInteger(lot.reservedQuantity)), 0);
}

function reserveLots(product, quantity, now = Date.now()) {
  const lots = normalizedLots(product, now);
  const wanted = safeInteger(quantity, 1, 20);
  const available = lots.reduce((sum, lot) => sum + Math.max(0, lotSellable(lot, now) - safeInteger(lot.reservedQuantity)), 0);
  if (!wanted || available < wanted) throw new Error("insufficient-stock");
  const orderByExpiry = (a, b) => (lotExpiryMillis(a.expirationDate) ?? Number.MAX_SAFE_INTEGER) -
    (lotExpiryMillis(b.expirationDate) ?? Number.MAX_SAFE_INTEGER) || a.lotNumber.localeCompare(b.lotNumber);
  let remaining = wanted;
  const allocations = [];
  lots.filter((lot) => lotSellable(lot, now) > 0).sort(orderByExpiry).forEach((lot) => {
    if (!remaining) return;
    const reservable = Math.max(0, lotSellable(lot, now) - safeInteger(lot.reservedQuantity));
    const amount = Math.min(remaining, reservable);
    if (!amount) return;
    lot.reservedQuantity += amount;
    allocations.push({ lotNumber: lot.lotNumber, quantity: amount });
    remaining -= amount;
  });
  if (remaining) throw new Error("insufficient-stock");
  return { lots, allocations, ...stockSummary(lots, now) };
}

function checkReservation(lots, allocations, expectedQuantity, requireSellable = true) {
  if (!Array.isArray(allocations) || !allocations.length) return false;
  const total = allocations.reduce((sum, allocation) => sum + safeInteger(allocation?.quantity, 1, 1_000_000), 0);
  if (total !== expectedQuantity) return false;
  return allocations.every((allocation) => {
    const name = clean(allocation?.lotNumber, 80);
    const lot = lots.find((candidate) => candidate.lotNumber === name);
    return Boolean(name && lot && (!requireSellable || lotSellable(lot) > 0) && safeInteger(lot.reservedQuantity) >= safeInteger(allocation?.quantity, 1, 1_000_000));
  });
}

function releaseAllocations(lots, allocations) {
  const next = lots.map((lot) => ({ ...lot }));
  for (const allocation of allocations) {
    const lot = next.find((candidate) => candidate.lotNumber === clean(allocation?.lotNumber, 80));
    const quantity = safeInteger(allocation?.quantity, 1, 1_000_000);
    if (!lot || !quantity || safeInteger(lot.reservedQuantity) < quantity) return null;
    lot.reservedQuantity = safeInteger(lot.reservedQuantity) - quantity;
  }
  return next;
}

function createPharmacyLot(input) {
  const lotNumber = clean(input?.lotNumber, 80);
  const expirationDate = clean(input?.expirationDate, 20);
  const quantityReceived = safeInteger(input?.quantityReceived, 1, 1_000_000);
  if (!lotNumber || !/^[\p{L}\p{N}._/-]{1,80}$/u.test(lotNumber) || !validDateOnly(expirationDate) || expirationDate < localCalendarDate(Date.now()) || !quantityReceived) {
    throw new Error("invalid-pharmacy-lot");
  }
  return {
    lotNumber, expirationDate, quantityReceived, quantityAvailable: quantityReceived,
    reservedQuantity: 0, status: "ACTIVE", receivedAt: new Date().toISOString(),
  };
}

function pharmacyDeliveryConfiguration(input, coldChainRequired) {
  const rawMode = clean(input?.deliveryMode, 20).toLowerCase();
  const mode = ["pickup", "delivery", "both"].includes(rawMode) ? rawMode : rawMode ? "" : "pickup";
  if (!mode) throw new Error("invalid-delivery-mode");
  if (input?.deliveryZones !== undefined && !Array.isArray(input.deliveryZones)) throw new Error("invalid-delivery-zones");
  const rawZones = Array.isArray(input?.deliveryZones) ? input.deliveryZones : [];
  if (rawZones.length > 30) throw new Error("too-many-delivery-zones");
  const zones = rawZones.map((raw) => {
    const department = clean(raw?.department, 80);
    const commune = clean(raw?.commune, 80);
    const etaLabel = clean(raw?.etaLabel, 80);
    const feeHTG = raw?.feeHTG;
    if (!department || !commune || !etaLabel || !Number.isSafeInteger(feeHTG) || feeHTG < 0 || feeHTG > 100_000) throw new Error("invalid-delivery-zone");
    return { department, commune, etaLabel, feeHTG, active: raw?.active !== false };
  });
  const keys = zones.map((zone) => normalized(`${zone.department}|${zone.commune}`));
  if (new Set(keys).size !== keys.length) throw new Error("duplicate-delivery-zone");
  if (mode !== "pickup" && coldChainRequired) throw new Error("cold-chain-delivery-unavailable");
  if (mode !== "pickup" && !zones.some((zone) => zone.active)) throw new Error("active-delivery-zone-required");
  return { mode, zones };
}

function medicationLines(prescription) {
  return (Array.isArray(prescription?.medications) ? prescription.medications : []).slice(0, 100).map((raw, index) => {
    const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const label = clean(item.name || item.medication_text, 180);
    return label ? {
      id: `medication-${index + 1}`,
      label,
      dosage: clean(item.dosage, 100),
      form: clean(item.form || item.pharmaceuticalForm, 100),
      route: clean(item.route, 120),
      quantity: Number.isSafeInteger(item.quantity) && Number(item.quantity) > 0 ? Math.min(Number(item.quantity), 20) : 1,
    } : null;
  }).filter(Boolean);
}

function medicationMatches(line, product) {
  const wanted = normalized(line.label);
  if (!wanted || (wanted !== normalized(product.name) && wanted !== normalized(product.dci))) return false;
  if (!normalized(line.dosage) || normalized(line.dosage) !== normalized(product.dosage)) return false;
  const requestedRoute = normalized(line.route);
  const offeredRoute = normalized(product.route);
  if (!offeredRoute || (requestedRoute && requestedRoute !== offeredRoute)) return false;
  const requestedForm = normalizeAvailability(line.form);
  if (requestedForm) {
    const offeredForm = normalizeAvailability(product.pharmaceuticalForm || product.form);
    const tokens = requestedForm.split(/\s+/).filter((token) => token.length >= 2);
    if (!offeredForm || !tokens.length || tokens.some((token) => !offeredForm.split(/\s+/).includes(token))) return false;
  }
  return true;
}

function prescriptionExpired(value) {
  const expiry = value && typeof value.toMillis === "function" ? value.toMillis() : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(expiry) && expiry <= Date.now();
}

function orderPaymentMatches(order, payment) {
  const serviceAmount = Number(order.amount);
  const fee = Number(order.transactionFee || 0);
  const total = Number(order.totalAmount ?? serviceAmount + fee);
  return Number.isSafeInteger(serviceAmount) && serviceAmount > 0 && Number.isSafeInteger(fee) && fee >= 0 &&
    Number.isSafeInteger(total) && total === serviceAmount + fee && Number(payment.amount) === total &&
    Number(payment.serviceAmount ?? payment.resourceAmount ?? payment.amount) === serviceAmount && Number(payment.transactionFee || 0) === fee;
}

function iso(value) {
  if (value && typeof value.toDate === "function") return value.toDate().toISOString();
  return typeof value === "string" ? value : null;
}

module.exports = function createNexaPharmacyCommerceFunctions(dependencies) {
  const {
    db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger,
    getTransactionFeePolicy, calculateTransactionAmounts, createNexaNotification,
  } = dependencies;

  const nexaPharmacyPublicProducts = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") { res.set("Allow", "GET, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    const query = normalized(typeof req.query.q === "string" ? req.query.q : "");
    const pharmacyId = clean(req.query.pharmacyId, 128);
    const productId = clean(req.query.productId, 200);
    if (pharmacyId && !/^[A-Za-z0-9_-]{1,128}$/.test(pharmacyId)) return fail(res, 400, "invalid-pharmacy", "La pharmacie demandée n’est pas valide.");
    if (productId && (!/^[A-Za-z0-9_-]{10,200}$/.test(productId) || req.query.cursor)) return fail(res, 400, "invalid-product", "Le produit demandé n’est pas valide.");
    try {
      await requireAppCheckToken(req);
      let productDocs;
      if (productId) {
        const productSnapshot = await db.collection("pharmacyProducts").doc(productId).get();
        productDocs = productSnapshot.exists ? [productSnapshot] : [];
      } else {
        let productsQuery = db.collection("pharmacyProducts").where("publicationStatus", "==", "PUBLISHED");
        if (pharmacyId) productsQuery = productsQuery.where("providerUid", "==", pharmacyId);
        const snapshot = await productsQuery.limit(250).get();
        productDocs = snapshot.docs;
      }
      const providerIds = [...new Set(productDocs.map((doc) => clean(doc.get("providerUid"), 128)).filter((uid) => /^[A-Za-z0-9_-]{1,128}$/.test(uid)))];
      const providerSnapshots = providerIds.length
        ? await db.getAll(...providerIds.map((uid) => db.collection("providerProfiles").doc(uid)))
        : [];
      const providers = new Map(providerSnapshots
        .filter((provider) => provider.exists && provider.get("type") === "pharmacy" && provider.get("status") === "verified" && provider.get("publiclyListed") === true)
        .map((provider) => {
          const profile = provider.get("profile") && typeof provider.get("profile") === "object" ? provider.get("profile") : {};
          return [provider.id, { name: clean(profile.name || profile.displayName || provider.get("displayName"), 120) || "Pharmacie NEXA", commune: clean(profile.commune, 80), department: clean(profile.department, 80) }];
        }));
      const products = productDocs.flatMap((doc) => {
        const data = doc.data() || {};
        const providerUid = clean(data.providerUid, 128);
        const provider = providers.get(providerUid);
        if (pharmacyId && providerUid !== pharmacyId) return [];
        const price = Number(data.price);
        const stock = availableStock(normalizedLots(data));
        const product = {
          id: doc.id, providerUid, pharmacyName: provider?.name || "Pharmacie NEXA", commune: provider?.commune || "", department: provider?.department || "",
          name: clean(data.name, 180), dci: clean(data.dci, 180), dosage: clean(data.dosage, 120), route: clean(data.route, 120), pharmaceuticalForm: clean(data.pharmaceuticalForm, 100),
          description: clean(data.publicDescription, 700), manufacturer: clean(data.manufacturer, 120),
          price: Number.isSafeInteger(price) && price > 0 ? price : 0, stock: Math.max(0, stock), prescriptionRequired: data.prescriptionRequired === true || data.regulatoryCategory !== "OTC",
          deliveryMode: ["delivery", "both"].includes(String(data.deliveryMode)) ? data.deliveryMode : "pickup",
          coldChainRequired: data.coldChainRequired === true,
          deliveryZones: Array.isArray(data.deliveryZones) ? data.deliveryZones.slice(0, 30).flatMap((zone) => {
            if (!zone || typeof zone !== "object" || zone.active === false) return [];
            const department = clean(zone.department, 80);
            const commune = clean(zone.commune, 80);
            const feeHTG = Number(zone.feeHTG);
            return department && commune && Number.isSafeInteger(feeHTG) && feeHTG >= 0 && feeHTG <= 100_000
              ? [{ department, commune, feeHTG, etaLabel: clean(zone.etaLabel, 80) }]
              : [];
          }) : [],
        };
        const searchable = normalized([product.name, product.dci, product.dosage, product.route, product.pharmaceuticalForm, product.pharmacyName, product.commune, product.department].join(" "));
        return provider && data.publicationStatus === "PUBLISHED" && data.active === true && product.price > 0 && product.stock > 0 &&
          (productId || !query || searchable.includes(query)) ? [product] : [];
      }).sort((left, right) => left.name.localeCompare(right.name, "fr")).slice(0, 100);
      res.set("Cache-Control", productId ? "no-store, max-age=0" : "public, max-age=30, stale-while-revalidate=60");
      return res.status(200).json({ ok: true, deliveryEnabled: pharmacyDeliveryEnabled(), products });
    } catch (error) {
      logger.error("NEXA pharmacy public products failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 503, "pharmacy-catalog-unavailable", "Le catalogue des produits NEXA n’est pas accessible pour le moment.");
    }
  });

  const nexaPharmacyProviderProducts = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST", "DELETE"].includes(req.method)) { res.set("Allow", "GET, POST, DELETE, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if (req.method !== "GET" && ((Number(req.get("Content-Length")) || 0) > 16_384 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 16_384))) {
      return fail(res, 413, "request-too-large", "La demande produit est trop volumineuse.");
    }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      const providerRef = db.collection("providerProfiles").doc(user.uid);
      const providerSnapshot = await providerRef.get();
      if (!providerSnapshot.exists || providerSnapshot.get("type") !== "pharmacy" || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true) {
        throw new ApiError(403, "verified-pharmacy-required", "Cet espace est réservé aux pharmacies NEXA vérifiées et publiées.");
      }
      res.set("Cache-Control", "no-store, max-age=0");

      if (req.method === "GET") {
        await enforceUserRateLimit(user.uid, "pharmacy-products-read", 60, 60_000);
        const snapshot = await db.collection("pharmacyProducts").where("providerUid", "==", user.uid).limit(200).get();
        const products = snapshot.docs.map((doc) => {
          const data = doc.data() || {};
          const lots = normalizedLots(data);
          return {
            id: doc.id, name: clean(data.name, 180), dci: clean(data.dci, 180), dosage: clean(data.dosage, 120), route: clean(data.route, 120),
            pharmaceuticalForm: clean(data.pharmaceuticalForm, 100), therapeuticClass: clean(data.therapeuticClass, 120),
            regulatoryCategory: clean(data.regulatoryCategory, 40), prescriptionRequired: data.prescriptionRequired === true,
            publicDescription: clean(data.publicDescription, 700), manufacturer: clean(data.manufacturer, 120), price: safeInteger(data.price, 1, 10_000_000),
            deliveryMode: ["delivery", "both"].includes(String(data.deliveryMode)) ? data.deliveryMode : "pickup",
            deliveryZones: Array.isArray(data.deliveryZones) ? data.deliveryZones.slice(0, 30).map((zone) => ({
              department: clean(zone?.department, 80), commune: clean(zone?.commune, 80), feeHTG: safeInteger(zone?.feeHTG, 0, 100_000),
              etaLabel: clean(zone?.etaLabel, 80), active: zone?.active !== false,
            })) : [],
            coldChainRequired: data.coldChainRequired === true,
            stock: stockSummary(lots).stock, reservedStock: stockSummary(lots).reservedStock,
            availableStock: availableStock(lots),
            lots: lots.map((lot) => ({ lotNumber: lot.lotNumber, expirationDate: clean(lot.expirationDate, 30), quantityReceived: safeInteger(lot.quantityReceived), quantityAvailable: safeInteger(lot.quantityAvailable), reservedQuantity: safeInteger(lot.reservedQuantity), status: clean(lot.status, 30) })),
            publicationStatus: clean(data.publicationStatus, 40) || "PENDING_REVIEW", active: data.active === true, reviewReason: clean(data.reviewReason, 500),
          };
        }).sort((left, right) => left.name.localeCompare(right.name, "fr"));
        return res.status(200).json({ ok: true, products });
      }

      await enforceUserRateLimit(user.uid, "pharmacy-product-write", 30, 5 * 60_000);
      const input = bodyOf(req);
      if (!input) throw new ApiError(400, "invalid-request", "La demande produit n’est pas valide.");

      if (req.method === "DELETE") {
        const productId = clean(input.productId, 200);
        if (!/^[A-Za-z0-9_-]{10,200}$/.test(productId)) throw new ApiError(400, "invalid-product", "La référence du produit n’est pas valide.");
        const productRef = db.collection("pharmacyProducts").doc(productId);
        const auditRef = db.collection("adminAuditLogs").doc();
        await db.runTransaction(async (transaction) => {
          const [freshProvider, productSnapshot] = await Promise.all([transaction.get(providerRef), transaction.get(productRef)]);
          if (!freshProvider.exists || freshProvider.get("type") !== "pharmacy" || freshProvider.get("status") !== "verified" || freshProvider.get("publiclyListed") !== true) throw new ApiError(403, "provider-no-longer-authorized", "Le profil pharmacie n’est plus autorisé.");
          if (!productSnapshot.exists || productSnapshot.get("providerUid") !== user.uid) throw new ApiError(404, "product-not-found", "Ce produit n’appartient pas à votre pharmacie.");
          const inventory = stockSummary(normalizedLots(productSnapshot.data() || {}));
          if (inventory.reservedStock > 0) throw new ApiError(409, "product-stock-reserved", "Ce produit a des quantités réservées. Attendez leur résolution avant de l’archiver.");
          const now = FieldValue.serverTimestamp();
          transaction.set(productRef, { active: false, publicationStatus: "ARCHIVED", updatedAt: now }, { merge: true });
          transaction.create(auditRef, { actorUid: user.uid, action: "pharmacy_product_archived", resource: `pharmacyProducts/${productId}`, createdAt: now });
        });
        return res.status(200).json({ ok: true, productId, publicationStatus: "ARCHIVED" });
      }

      const productId = clean(input.productId, 200);
      if (productId && !/^[A-Za-z0-9_-]{10,200}$/.test(productId)) throw new ApiError(400, "invalid-product", "La référence du produit n’est pas valide.");
      const name = clean(input.name, 180);
      const dci = clean(input.dci, 180);
      const dosage = clean(input.dosage, 120);
      const route = clean(input.route, 120);
      const pharmaceuticalForm = clean(input.pharmaceuticalForm, 100);
      const therapeuticClass = clean(input.therapeuticClass, 120);
      const regulatoryCategory = clean(input.regulatoryCategory, 40).toUpperCase();
      const allowedCategories = ["OTC", "PRESCRIPTION", "CONTROLLED", "NARCOTIC", "SENSITIVE"];
      const price = input.price;
      const initialStock = input.stock;
      const prescriptionRequired = input.prescriptionRequired === true || ["PRESCRIPTION", "CONTROLLED", "NARCOTIC", "SENSITIVE"].includes(regulatoryCategory);
      const coldChainRequired = input.coldChainRequired === true;
      let delivery;
      try { delivery = pharmacyDeliveryConfiguration(input, coldChainRequired); }
      catch (error) {
        const code = error instanceof Error ? error.message : "invalid-delivery-zone";
        const messages = {
          "invalid-delivery-mode": "Choisissez retrait, livraison ou les deux modalités.",
          "invalid-delivery-zones": "Les zones de livraison ne sont pas valides.",
          "too-many-delivery-zones": "Une fiche peut contenir au maximum 30 zones de livraison.",
          "invalid-delivery-zone": "Chaque zone doit avoir un département, une commune, des frais entiers valides et un délai indicatif.",
          "duplicate-delivery-zone": "Une zone département/commune ne peut être déclarée qu’une seule fois.",
          "cold-chain-delivery-unavailable": "Un produit nécessitant la chaîne du froid est limité au retrait en pharmacie.",
          "active-delivery-zone-required": "Ajoutez au moins une zone active pour proposer la livraison.",
        };
        throw new ApiError(400, code, messages[code] || "La configuration de livraison est invalide.");
      }
      if (!name || !dci || !dosage || !route || !pharmaceuticalForm || !therapeuticClass || !allowedCategories.includes(regulatoryCategory) || !Number.isSafeInteger(price) || price < 1 || price > 10_000_000 || !Number.isSafeInteger(initialStock) || initialStock < 0 || initialStock > 1_000_000) {
        throw new ApiError(400, "invalid-product", "Vérifiez le nom, la DCI, le dosage/concentration, la voie d’administration, la forme, la catégorie, le prix et le stock initial.");
      }
      if (regulatoryCategory !== "OTC" && input.prescriptionRequired !== true) throw new ApiError(400, "prescription-flag-required", "Cette catégorie exige le marquage ordonnance obligatoire.");
      if (productId && (clean(input.lotNumber, 80) || clean(input.expirationDate, 20) || initialStock !== 0)) throw new ApiError(400, "lot-receipt-route-required", "Le stock d’un produit existant se reçoit depuis sa fiche produit.");
      if (!productId && initialStock > 0 && (!clean(input.lotNumber, 80) || !clean(input.expirationDate, 20))) throw new ApiError(400, "initial-lot-required", "Un numéro de lot et une date d’expiration sont obligatoires pour enregistrer le stock initial.");
      let initialLot = null;
      if (!productId && initialStock > 0) {
        try { initialLot = createPharmacyLot({ lotNumber: input.lotNumber, expirationDate: input.expirationDate, quantityReceived: initialStock }); }
        catch { throw new ApiError(400, "invalid-pharmacy-lot", "Vérifiez le numéro de lot, sa date d’expiration et la quantité reçue."); }
      }

      const productRef = productId ? db.collection("pharmacyProducts").doc(productId) : db.collection("pharmacyProducts").doc();
      const auditRef = db.collection("adminAuditLogs").doc();
      const initialMovementRef = db.collection("pharmacyStockMovements").doc(`${productRef.id}__initial_receipt`);
      const result = await db.runTransaction(async (transaction) => {
        const [freshProvider, productSnapshot] = await Promise.all([
          transaction.get(providerRef), ...(productId ? [transaction.get(productRef)] : []),
        ]);
        if (!freshProvider.exists || freshProvider.get("type") !== "pharmacy" || freshProvider.get("status") !== "verified" || freshProvider.get("publiclyListed") !== true) throw new ApiError(403, "provider-no-longer-authorized", "Le profil pharmacie n’est plus autorisé.");
        if (productId && (!productSnapshot?.exists || productSnapshot.get("providerUid") !== user.uid)) throw new ApiError(404, "product-not-found", "Ce produit n’appartient pas à votre pharmacie.");
        const prior = productSnapshot?.data() || {};
        const priorLots = normalizedLots(prior);
        const priorInventory = stockSummary(priorLots);
        if (productId && priorInventory.reservedStock > 0) throw new ApiError(409, "product-stock-reserved", "Une commande réserve encore ce produit. Modifiez sa fiche après la résolution de ces commandes.");
        if (productId && priorLots.length === 0 && safeInteger(prior.reservedStock) > 0) throw new ApiError(409, "legacy-reservation-review-required", "Des commandes existantes ont des réservations sans lot. Faites rapprocher ces commandes avant de modifier le produit.");
        const lots = productId ? priorLots : initialLot ? [initialLot] : [];
        const inventory = stockSummary(lots);
        const hadUntrackedStock = productId && priorLots.length === 0 && safeInteger(prior.stock) > 0;
        const now = FieldValue.serverTimestamp();
        const data = {
          providerUid: user.uid, name, dci, dosage, route, pharmaceuticalForm, therapeuticClass, regulatoryCategory,
          publicDescription: clean(input.publicDescription, 700), manufacturer: clean(input.manufacturer, 120),
          deliveryMode: delivery.mode, deliveryZones: delivery.zones, coldChainRequired, price,
          stock: inventory.stock, reservedStock: inventory.reservedStock, lots, prescriptionRequired,
          ...(hadUntrackedStock ? { legacyStockUnreconciled: safeInteger(prior.stock) } : {}),
          publicationStatus: "PENDING_REVIEW", active: false, reviewReason: "",
          createdAt: prior.createdAt || now, updatedAt: now,
        };
        if (productId) transaction.set(productRef, data, { merge: true });
        else transaction.create(productRef, data);
        transaction.create(auditRef, { actorUid: user.uid, action: productId ? "pharmacy_product_submitted_for_review" : "pharmacy_product_created_for_review", resource: productRef.path, createdAt: now });
        if (initialLot) {
          transaction.create(initialMovementRef, {
            productId: productRef.id, providerUid: user.uid, movementType: "RECEIPT", direction: "IN",
            quantity: initialLot.quantityReceived, lotAllocations: [{ lotNumber: initialLot.lotNumber, quantity: initialLot.quantityReceived }],
            actorUid: user.uid, reason: "INITIAL_STOCK", createdAt: now,
          });
        }
        return { id: productRef.id, publicationStatus: "PENDING_REVIEW" };
      });
      return res.status(200).json({ ok: true, product: result });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA pharmacy provider products failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "pharmacy-products-unavailable", "Les produits de la pharmacie ne sont pas accessibles.");
    }
  });

  const nexaPharmacyProviderLotReceive = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > 8_192 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 8_192)) return fail(res, 413, "request-too-large", "La demande de réception de lot est trop volumineuse.");
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "pharmacy-product-write", 30, 5 * 60_000);
      const input = bodyOf(req);
      const productId = clean(input?.productId, 200);
      if (!input || !/^[A-Za-z0-9_-]{10,200}$/.test(productId)) throw new ApiError(400, "invalid-product", "La référence du produit n’est pas valide.");
      let lot;
      try { lot = createPharmacyLot({ lotNumber: input.lotNumber, expirationDate: input.expirationDate, quantityReceived: input.quantityReceived }); }
      catch { throw new ApiError(400, "invalid-pharmacy-lot", "Vérifiez le numéro de lot, sa date d’expiration et la quantité reçue."); }
      const providerRef = db.collection("providerProfiles").doc(user.uid);
      const productRef = db.collection("pharmacyProducts").doc(productId);
      const lotKey = createHash("sha256").update(lot.lotNumber.normalize("NFKC").toLocaleLowerCase("fr")).digest("hex");
      const movementRef = db.collection("pharmacyStockMovements").doc(`${productId}__receipt__${lotKey}`);
      const auditRef = db.collection("adminAuditLogs").doc();
      const result = await db.runTransaction(async (transaction) => {
        const [providerSnapshot, productSnapshot, movementSnapshot] = await Promise.all([
          transaction.get(providerRef), transaction.get(productRef), transaction.get(movementRef),
        ]);
        if (!providerSnapshot.exists || providerSnapshot.get("type") !== "pharmacy" || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true) throw new ApiError(403, "verified-pharmacy-required", "Le profil pharmacie n’est plus autorisé.");
        if (!productSnapshot.exists || productSnapshot.get("providerUid") !== user.uid) throw new ApiError(404, "product-not-found", "Ce produit n’appartient pas à votre pharmacie.");
        if (movementSnapshot.exists) {
          const previous = movementSnapshot.data() || {};
          if (previous.providerUid === user.uid && previous.productId === productId && previous.lotNumber === lot.lotNumber && previous.quantity === lot.quantityReceived) return { productId, alreadyReceived: true };
          throw new ApiError(409, "lot-receipt-conflict", "Cette référence de lot a déjà été enregistrée avec d’autres données.");
        }
        const prior = productSnapshot.data() || {};
        const lots = normalizedLots(prior);
        if (lots.length === 0 && safeInteger(prior.reservedStock) > 0) throw new ApiError(409, "legacy-reservation-review-required", "Des commandes existantes ont des réservations sans lot. Faites rapprocher ces commandes avant de recevoir un lot.");
        if (lots.some((candidate) => normalized(candidate.lotNumber) === normalized(lot.lotNumber))) throw new ApiError(409, "duplicate-pharmacy-lot", "Ce numéro de lot existe déjà pour ce produit.");
        lots.push(lot);
        const inventory = stockSummary(lots);
        const now = FieldValue.serverTimestamp();
        transaction.set(productRef, { lots, stock: inventory.stock, reservedStock: inventory.reservedStock, updatedAt: now }, { merge: true });
        transaction.create(auditRef, { actorUid: user.uid, action: "pharmacy_product_lot_received", resource: productRef.path, metadata: { lotNumber: lot.lotNumber, expirationDate: lot.expirationDate, quantityReceived: lot.quantityReceived }, createdAt: now });
        transaction.create(movementRef, { productId, providerUid: user.uid, lotNumber: lot.lotNumber, movementType: "RECEIPT", direction: "IN", quantity: lot.quantityReceived, lotAllocations: [{ lotNumber: lot.lotNumber, quantity: lot.quantityReceived }], actorUid: user.uid, reason: "LOT_RECEIVED", createdAt: now });
        return { productId, stock: inventory.stock, reservedStock: inventory.reservedStock, alreadyReceived: false };
      });
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA pharmacy lot receipt failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "pharmacy-lot-receipt-failed", "Le lot n’a pas pu être enregistré.");
    }
  });

  const nexaPharmacyOrderCreate = onRequest({ region: REGION, maxInstances: 20 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > 16_384 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 16_384)) return fail(res, 413, "request-too-large", "La demande de commande est trop volumineuse.");
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "pharmacy-order-create", 8, 5 * 60_000);
      const input = bodyOf(req);
      if (!input) throw new ApiError(400, "invalid-request", "La demande de commande n’est pas valide.");
      const deliveryMethod = input.deliveryMethod === undefined || input.deliveryMethod === "pickup" ? "pickup" : input.deliveryMethod === "delivery" ? "delivery" : "";
      if (!deliveryMethod) throw new ApiError(400, "invalid-delivery-method", "Choisissez le retrait ou la livraison à domicile.");
      if (deliveryMethod === "delivery" && !pharmacyDeliveryEnabled()) throw new ApiError(409, "delivery-not-available", "La livraison à domicile n’est pas encore ouverte par NEXA. Choisissez le retrait en pharmacie.");
      let deliveryAddress = null;
      if (deliveryMethod === "delivery") {
        const rawAddress = input.deliveryAddress && typeof input.deliveryAddress === "object" && !Array.isArray(input.deliveryAddress) ? input.deliveryAddress : null;
        if (!rawAddress) throw new ApiError(400, "delivery-address-required", "Renseignez une adresse complète pour la livraison.");
        const phone = clean(rawAddress.phone, 32).replace(/\s+/g, " ");
        const phoneDigits = phone.replace(/\D/g, "");
        deliveryAddress = {
          recipientName: clean(rawAddress.recipientName, 120), phone,
          department: clean(rawAddress.department, 80), commune: clean(rawAddress.commune, 80),
          addressLine: clean(rawAddress.addressLine, 300), instructions: clean(rawAddress.instructions, 300),
        };
        if (!deliveryAddress.recipientName || !deliveryAddress.department || !deliveryAddress.commune || !deliveryAddress.addressLine || phoneDigits.length < 8 || phoneDigits.length > 15 || !/^\+?[0-9 ()-]{8,32}$/.test(phone)) {
          throw new ApiError(400, "invalid-delivery-address", "Vérifiez le nom du destinataire, le téléphone, le département, la commune et l’adresse détaillée.");
        }
      }
      if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 20) throw new ApiError(400, "invalid-order-items", "Choisissez entre 1 et 20 produits dans une seule commande.");
      const items = input.items.map((raw) => {
        const productId = clean(raw?.productId, 200);
        const quantity = Number(raw?.quantity);
        if (!/^[A-Za-z0-9_-]{10,200}$/.test(productId) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) throw new ApiError(400, "invalid-order-item", "Vérifiez les produits et les quantités du panier.");
        return { productId, quantity };
      });
      if (new Set(items.map((item) => item.productId)).size !== items.length) throw new ApiError(400, "duplicate-order-item", "Chaque produit doit apparaître une seule fois dans le panier.");
      const pharmacyUid = clean(input.pharmacyId, 128);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(pharmacyUid) || pharmacyUid === user.uid) throw new ApiError(400, "invalid-pharmacy", "Choisissez une pharmacie publiée dans le catalogue NEXA.");
      const prescriptionId = clean(input.prescriptionId, 200);
      if (prescriptionId && !/^[A-Za-z0-9_-]{10,200}$/.test(prescriptionId)) throw new ApiError(400, "invalid-prescription", "La référence d’ordonnance n’est pas valide.");
      const requestId = clean(input.orderRequestId, 64);
      if (!REQUEST_ID_PATTERN.test(requestId)) throw new ApiError(400, "invalid-order-request-id", "Rechargez le catalogue avant de préparer cette commande.");

      const patientRef = db.collection("patientProfiles").doc(user.uid);
      const providerRef = db.collection("providerProfiles").doc(pharmacyUid);
      const productRefs = items.map((item) => db.collection("pharmacyProducts").doc(item.productId));
      const prescriptionRef = prescriptionId ? db.collection("clinicalPrescriptions").doc(prescriptionId) : null;
      const orderRef = db.collection("nexaOrders").doc();
      const paymentRef = randomBytes(24).toString("base64url");
      if (!PAYMENT_REFERENCE_PATTERN.test(paymentRef)) throw new ApiError(500, "payment-reference-failed", "La commande ne peut pas être créée.");
      const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
      const requestRef = db.collection("pharmacyOrderRequests").doc(createHash("sha256").update(`${user.uid}|${requestId}`).digest("hex"));
      const auditRef = db.collection("adminAuditLogs").doc();
      const eventRef = db.collection("nexaOrderEvents").doc();
      const movementRefs = items.map((_, index) => db.collection("pharmacyStockMovements").doc(`${orderRef.id}__reservation__${index}`));
      const holdExpiresAt = Date.now() + HOLD_MINUTES * 60_000;
      const fingerprint = createHash("sha256").update(JSON.stringify({ pharmacyUid, items, prescriptionId, deliveryMethod, deliveryAddress })).digest("hex");
      const feePolicy = await getTransactionFeePolicy("pharmacy");

      const result = await db.runTransaction(async (transaction) => {
        const reads = await Promise.all([
          transaction.get(patientRef), transaction.get(providerRef), ...productRefs.map((ref) => transaction.get(ref)),
          ...(prescriptionRef ? [transaction.get(prescriptionRef)] : []), transaction.get(requestRef),
        ]);
        const patientSnapshot = reads[0];
        const providerSnapshot = reads[1];
        const productSnapshots = reads.slice(2, 2 + items.length);
        const prescriptionSnapshot = prescriptionRef ? reads[2 + items.length] : null;
        const prior = reads[reads.length - 1];
        if (prior.exists) {
          if (prior.get("uid") !== user.uid || prior.get("fingerprint") !== fingerprint) throw new ApiError(409, "order-request-conflict", "Cette référence a déjà servi pour une autre commande. Actualisez le catalogue.");
          const saved = prior.get("response");
          if (!saved || typeof saved !== "object") throw new ApiError(409, "order-request-incomplete", "La commande précédente est en cours de vérification. Consultez votre espace patient.");
          return saved;
        }
        if (!patientSnapshot.exists || patientSnapshot.get("role") !== "patient" || patientSnapshot.get("profileComplete") !== true || !/^NMC-\d{7}$/.test(String(patientSnapshot.get("patientNumber") || ""))) throw new ApiError(403, "complete-patient-profile-required", "Terminez votre profil patient avant de commander.");
        if (!providerSnapshot.exists || providerSnapshot.get("type") !== "pharmacy" || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true) throw new ApiError(409, "pharmacy-unavailable", "Cette pharmacie n’est plus disponible sur NEXA.");

        const prescription = prescriptionSnapshot?.exists ? prescriptionSnapshot.data() || {} : null;
        if (prescription && (prescription.patientUid !== user.uid || prescription.status !== "VALIDATED")) throw new ApiError(403, "valid-prescription-required", "Une ordonnance NEXA validée vous appartenant est requise.");
        if (prescription && prescriptionExpired(prescription.expiresAt)) throw new ApiError(409, "prescription-expired", "Cette ordonnance a expiré.");
        const prescribedLines = prescription ? medicationLines(prescription) : [];
        const usedLines = new Set();
        let subtotal = 0;
        let deliveryFee = 0;
        let requiresPrescription = false;
        const orderLines = [];
        const stockUpdates = [];

        for (let index = 0; index < items.length; index += 1) {
          const requested = items[index];
          const productSnapshot = productSnapshots[index];
          if (!productSnapshot.exists) throw new ApiError(404, "pharmacy-product-not-found", "Un produit du panier n’est plus disponible.");
          const product = productSnapshot.data() || {};
          if (product.providerUid !== pharmacyUid || product.publicationStatus !== "PUBLISHED" || product.active !== true) throw new ApiError(409, "product-unavailable", "Un produit du panier a été retiré ou suspendu.");
          let reservation;
          try { reservation = reserveLots(product, requested.quantity); }
          catch { throw new ApiError(409, "insufficient-stock", `Le stock de « ${clean(product.name, 100) || "ce produit"} » vient de changer. Actualisez le panier.`); }
          const price = Number(product.price);
          if (!Number.isSafeInteger(price) || price < 1) throw new ApiError(409, "product-price-invalid", "Le prix d’un produit du panier doit être corrigé par la pharmacie.");
          const lineTotal = price * requested.quantity;
          subtotal += lineTotal;
          if (!Number.isSafeInteger(subtotal) || subtotal > 10_000_000) throw new ApiError(400, "order-total-invalid", "Le total de la commande dépasse la limite autorisée.");

          if (deliveryMethod === "delivery") {
            const productMode = product.deliveryMode === "delivery" || product.deliveryMode === "both" ? product.deliveryMode : "pickup";
            if (productMode === "pickup" || product.coldChainRequired === true) throw new ApiError(409, "home-delivery-unavailable", `La livraison à domicile n’est pas disponible pour « ${clean(product.name, 100) || "ce produit"} ». Choisissez le retrait en pharmacie.`);
            const zones = Array.isArray(product.deliveryZones) ? product.deliveryZones : [];
            const zone = zones.find((candidate) => candidate && candidate.active !== false && normalized(candidate.department) === normalized(deliveryAddress.department) && normalized(candidate.commune) === normalized(deliveryAddress.commune));
            const zoneFee = Number(zone?.feeHTG);
            if (!zone || !Number.isSafeInteger(zoneFee) || zoneFee < 0 || zoneFee > 100_000 || !clean(zone.etaLabel, 80)) {
              throw new ApiError(409, "delivery-zone-unavailable", `La pharmacie ne livre pas « ${clean(deliveryAddress.commune, 80)} » pour « ${clean(product.name, 100) || "ce produit"} ». Vérifiez les zones ou choisissez le retrait.`);
            }
            deliveryFee = Math.max(deliveryFee, zoneFee);
          }

          const required = product.prescriptionRequired === true || product.regulatoryCategory !== "OTC";
          requiresPrescription ||= required;
          let prescriptionLineId = "";
          if (required) {
            if (!prescriptionSnapshot?.exists || prescription.patientUid !== user.uid || prescription.status !== "VALIDATED") throw new ApiError(403, "valid-prescription-required", "Une ordonnance NEXA validée vous appartenant est requise pour les produits sélectionnés.");
            const match = prescribedLines.find((line) => !usedLines.has(line.id) && medicationMatches(line, product));
            if (!match) throw new ApiError(409, "prescription-product-mismatch", `L’ordonnance ne contient pas « ${clean(product.name, 100) || "ce produit"} » avec le même dosage, la même voie d’administration et la même forme.`);
            if (requested.quantity > match.quantity) throw new ApiError(409, "prescribed-quantity-exceeded", "La quantité sélectionnée dépasse celle inscrite sur l’ordonnance.");
            usedLines.add(match.id);
            prescriptionLineId = match.id;
          }
          const line = {
            productId: requested.productId, name: clean(product.name, 180), dci: clean(product.dci, 180), dosage: clean(product.dosage, 120), route: clean(product.route, 120),
            pharmaceuticalForm: clean(product.pharmaceuticalForm, 100), quantity: requested.quantity, reservedLots: reservation.allocations,
            unitPrice: price, price, lineTotal, prescriptionRequired: required, ...(prescriptionLineId ? { prescriptionLineId } : {}),
          };
          orderLines.push(line);
          stockUpdates.push({ index, productRef: productRefs[index], ...reservation });
        }
        if (requiresPrescription && !prescriptionId) throw new ApiError(403, "valid-prescription-required", "Sélectionnez une ordonnance NEXA validée avant de commander ces médicaments.");
        if (!requiresPrescription && prescriptionId) throw new ApiError(400, "unexpected-prescription", "Retirez l’ordonnance ou choisissez un produit qui la requiert.");
        if (subtotal < 1) throw new ApiError(400, "order-total-invalid", "Le total de la commande n’est pas valide.");
        const amount = subtotal + deliveryFee;
        if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10_000_000) throw new ApiError(400, "order-total-invalid", "Le total de la commande dépasse la limite autorisée.");
        const amounts = calculateTransactionAmounts(amount, feePolicy);
        const profile = providerSnapshot.get("profile") && typeof providerSnapshot.get("profile") === "object" ? providerSnapshot.get("profile") : {};
        const providerName = clean(profile.name || profile.displayName || providerSnapshot.get("displayName"), 120) || "Pharmacie NEXA";
        const orderNumber = `NMC-PH-${orderRef.id.slice(-8).toUpperCase()}`;
        const now = FieldValue.serverTimestamp();
        transaction.create(orderRef, {
          kind: "pharmacy", workflowVersion: "pharmacy-commerce-v1", orderNumber,
          patientUid: user.uid, patientNumber: patientSnapshot.get("patientNumber"), providerUid: pharmacyUid, providerType: "pharmacy", providerName,
          items: orderLines, ...(prescriptionId ? { prescriptionId } : {}), subtotal, deliveryFee, deliveryMethod, ...(deliveryAddress ? { deliveryAddress } : {}), amount,
          transactionFee: amounts.feeAmount, transactionFeeRateBps: amounts.feeRateBps, transactionFeeRecipient: "NEXARIS", totalAmount: amounts.totalAmount,
          currency: "HTG", paymentMethod: "MONCASH", paymentStatus: "PENDING", status: "PENDING_PAYMENT", settlementStatus: "PENDING",
          holdExpiresAt, moncashPaymentRef: paymentRef, createdAt: now, updatedAt: now,
        });
        transaction.create(paymentRefDoc, {
          uid: user.uid, paymentMethod: "MONCASH", resourceType: "pharmacy-order", resourcePath: orderRef.path,
          amount: amounts.totalAmount, serviceAmount: amount, transactionFee: amounts.feeAmount, transactionFeeRateBps: amounts.feeRateBps,
          feeRecipient: "NEXARIS", currency: "HTG", status: "created", createdAt: now, updatedAt: now,
        });
        stockUpdates.forEach(({ index, lots, stock, reservedStock, productRef }) => transaction.set(productRef, { lots, stock, reservedStock, updatedAt: now }, { merge: true }));
        stockUpdates.forEach(({ index }) => transaction.create(movementRefs[index], {
          productId: items[index].productId, providerUid: pharmacyUid, orderId: orderRef.id, movementType: "RESERVATION", direction: "HOLD",
          quantity: items[index].quantity, lotAllocations: orderLines[index].reservedLots, actorUid: user.uid, reason: "ORDER_PAYMENT_HOLD", createdAt: now,
        }));
        transaction.create(eventRef, { orderId: orderRef.id, fromStatus: null, toStatus: "PENDING_PAYMENT", action: "PHARMACY_ORDER_CREATED", actorUid: user.uid, createdAt: now });
        transaction.create(auditRef, { actorUid: user.uid, action: "pharmacy_order_created", resource: orderRef.path, createdAt: now });
        const response = {
          orderId: orderRef.id, orderNumber, providerName, providerUid: pharmacyUid, subtotal, deliveryFee, amount, transactionFee: amounts.feeAmount,
          totalAmount: amounts.totalAmount, transactionFeeRateBps: amounts.feeRateBps, feeRecipient: "NEXARIS", currency: "HTG",
          paymentRequired: true, paymentRef, holdExpiresAt,
        };
        transaction.create(requestRef, { uid: user.uid, fingerprint, response, orderId: orderRef.id, createdAt: now });
        return response;
      });
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA pharmacy order create failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "pharmacy-order-create-failed", "La commande pharmacie ne peut pas être préparée pour le moment.");
    }
  });

  const nexaPharmacyOrderWalletPay = onRequest({ region: REGION, maxInstances: 20 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > 4096 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 4096)) return fail(res, 413, "request-too-large", "La demande de paiement est trop volumineuse.");
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "pay-pharmacy-order-wallet", 8, 5 * 60_000);
      const orderId = clean(bodyOf(req)?.orderId, 200);
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(orderId)) throw new ApiError(400, "invalid-order", "La référence de commande n’est pas valide.");
      const orderRef = db.collection("nexaOrders").doc(orderId);
      const outcome = await db.runTransaction(async (transaction) => {
        const orderSnapshot = await transaction.get(orderRef);
        if (!orderSnapshot.exists || orderSnapshot.get("patientUid") !== user.uid || orderSnapshot.get("kind") !== "pharmacy") throw new ApiError(404, "order-not-found", "Cette commande n’est pas accessible.");
        const order = orderSnapshot.data() || {};
        const paymentRef = clean(order.moncashPaymentRef, 64);
        if (!PAYMENT_REFERENCE_PATTERN.test(paymentRef)) throw new ApiError(409, "order-payment-invalid", "Le paiement de cette commande ne peut pas être vérifié.");
        const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
        const walletRef = db.collection("nexaPatientWallets").doc(user.uid);
        const profileRef = db.collection("patientProfiles").doc(user.uid);
        const ledgerId = createHash("sha256").update(`NEXA_WALLET_ORDER:${orderId}`).digest("hex");
        const ledgerRef = db.collection("nexaWalletLedger").doc(ledgerId);
        const feeLedgerRef = db.collection("nexaTransactionFeeLedger").doc(paymentRef);
        const eventRef = db.collection("nexaOrderEvents").doc();
        const lines = Array.isArray(order.items) ? order.items : [];
        const productRefs = lines.map((line) => db.collection("pharmacyProducts").doc(clean(line?.productId, 200) || "_"));
        const reads = await Promise.all([
          transaction.get(paymentRefDoc), transaction.get(walletRef), transaction.get(profileRef), transaction.get(ledgerRef), transaction.get(feeLedgerRef),
          ...productRefs.map((ref) => transaction.get(ref)),
        ]);
        const [paymentSnapshot, walletSnapshot, profileSnapshot, ledgerSnapshot, feeSnapshot] = reads;
        const productSnapshots = reads.slice(5);
        const payment = paymentSnapshot.data() || {};
        const amount = Number(order.amount);
        const fee = Number(order.transactionFee || 0);
        const total = Number(order.totalAmount ?? amount + fee);
        const serviceMinor = amount * 100;
        const feeMinor = fee * 100;
        const totalMinor = total * 100;
        if (!paymentSnapshot.exists || payment.uid !== user.uid || payment.resourceType !== "pharmacy-order" || payment.resourcePath !== orderRef.path ||
          !orderPaymentMatches(order, payment) || payment.currency !== "HTG" || order.currency !== "HTG" || !Number.isSafeInteger(totalMinor) || total > 10_000_000) {
          throw new ApiError(409, "order-payment-invalid", "Le montant de cette commande ne peut pas être vérifié.");
        }
        const feeLedgerMatches = fee === 0 ? !feeSnapshot.exists : feeSnapshot.exists && feeSnapshot.get("paymentRef") === paymentRef &&
          feeSnapshot.get("resourceType") === "pharmacy-order" && feeSnapshot.get("resourceId") === orderId && Number(feeSnapshot.get("serviceAmountMinor")) === serviceMinor &&
          Number(feeSnapshot.get("amountMinor")) === feeMinor && feeSnapshot.get("recipient") === "NEXARIS" && feeSnapshot.get("paymentMethod") === "SMART_WALLET" && feeSnapshot.get("status") === "COMPLETED";
        if (feeSnapshot.exists && !feeLedgerMatches) throw new ApiError(409, "transaction-fee-ledger-conflict", "Le registre des frais ne concorde pas avec ce paiement.");
        if (payment.status === "paid" && payment.paymentMethod === "MONCASH") return { paymentRef, alreadyPaid: true, needsSettlement: order.settlementStatus !== "CONFIRMED", orderStatus: clean(order.status, 50), paymentMethod: "MONCASH" };
        if (ledgerSnapshot.exists) {
          const ledger = ledgerSnapshot.data() || {};
          if (ledger.userUid !== user.uid || ledger.resourceId !== orderId || ledger.resourceType !== "pharmacy-order" || ledger.direction !== "DEBIT" ||
            Number(ledger.amountMinor) !== totalMinor || Number(ledger.serviceAmountMinor) !== serviceMinor || Number(ledger.transactionFeeMinor || 0) !== feeMinor ||
            payment.status !== "paid" || payment.paymentMethod !== "SMART_WALLET" || !feeLedgerMatches) throw new ApiError(409, "wallet-ledger-conflict", "Le registre du portefeuille et le paiement ne concordent pas.");
          return { paymentRef, alreadyPaid: true, needsSettlement: false, orderStatus: clean(order.status, 50), paymentMethod: "SMART_WALLET" };
        }
        if (!profileSnapshot.exists || profileSnapshot.get("role") !== "patient" || profileSnapshot.get("profileComplete") !== true) throw new ApiError(403, "complete-patient-profile-required", "Un profil patient complet est requis.");
        if (order.status !== "PENDING_PAYMENT" || order.paymentStatus !== "PENDING" || order.settlementStatus !== "PENDING" || order.refundRequired === true) throw new ApiError(409, "order-not-payable", "Cette commande n’accepte plus de paiement Wallet.");
        if (payment.status !== "created" || payment.paymentMethod !== "MONCASH") throw new ApiError(409, "payment-method-already-started", "Le paiement a déjà commencé. Terminez-le ou demandez une vérification avant de choisir Wallet.");
        if (Number(order.holdExpiresAt || 0) <= Date.now()) throw new ApiError(409, "order-hold-expired", "La retenue de cette commande a expiré. Préparez une nouvelle commande.");
        if (lines.length !== productSnapshots.length || lines.some((line, index) => !productSnapshots[index].exists ||
          !checkReservation(normalizedLots(productSnapshots[index].data() || {}), line.reservedLots, Number(line.quantity)))) {
          throw new ApiError(409, "order-stock-reservation-invalid", "La réservation du stock doit être vérifiée par NEXA avant le paiement.");
        }
        const wallet = walletSnapshot.data() || {};
        const available = Number(wallet.availableMinor || 0);
        const reserved = Number(wallet.reservedMinor || 0);
        if (!walletSnapshot.exists || wallet.status !== "ACTIVE" || wallet.currency !== "HTG" || !Number.isSafeInteger(available) || available < totalMinor || !Number.isSafeInteger(reserved) || reserved < 0) throw new ApiError(409, "insufficient-wallet-balance", "Le Wallet est suspendu ou son solde ne couvre pas le total et les frais.");
        const now = FieldValue.serverTimestamp();
        transaction.update(walletRef, { availableMinor: available - totalMinor, updatedAt: now });
        transaction.create(ledgerRef, {
          userUid: user.uid, walletId: user.uid, type: "PHARMACY_ORDER_PAYMENT", direction: "DEBIT", amountMinor: totalMinor,
          serviceAmountMinor: serviceMinor, transactionFeeMinor: feeMinor, currency: "HTG", resourceType: "pharmacy-order", resourceId: orderId,
          paymentRef, source: "NEXA", status: "COMPLETED", createdAt: now,
        });
        if (feeMinor > 0) transaction.create(feeLedgerRef, {
          paymentRef, resourceType: "pharmacy-order", resourceId: orderId, serviceAmountMinor: serviceMinor, amountMinor: feeMinor,
          currency: "HTG", recipient: "NEXARIS", transactionFeeRateBps: Number(order.transactionFeeRateBps) || 0,
          paymentMethod: "SMART_WALLET", status: "COMPLETED", createdAt: now,
        });
        transaction.set(paymentRefDoc, { status: "paid", paymentMethod: "SMART_WALLET", paymentProvider: "nexa-wallet", walletLedgerId: ledgerId, paidAt: now, updatedAt: now }, { merge: true });
        transaction.set(orderRef, { status: "PAID", paymentStatus: "PAID", paymentMethod: "SMART_WALLET", settlementStatus: "CONFIRMED", paidAt: now, updatedAt: now }, { merge: true });
        transaction.create(eventRef, { orderId, fromStatus: "PENDING_PAYMENT", toStatus: "PAID", action: "WALLET_SETTLED", actorUid: user.uid, createdAt: now });
        return { paymentRef, alreadyPaid: false, needsSettlement: false, paymentMethod: "SMART_WALLET", orderStatus: "PAID", providerUid: clean(order.providerUid, 200) };
      });
      if (outcome.paymentMethod === "MONCASH") {
        if (outcome.needsSettlement) await settlePaidPharmacyOrderPayment(outcome.paymentRef);
        res.set("Cache-Control", "no-store, max-age=0");
        return res.status(200).json({ ok: true, status: "paid", paymentMethod: "MONCASH", orderStatus: outcome.orderStatus, alreadyPaid: true });
      }
      if (!outcome.alreadyPaid) {
        const tasks = [createNexaNotification(user.uid, `pharmacy-order:payment:${outcome.paymentRef}`, {
          type: "pharmacy_order_payment_confirmed", title: "Paiement confirmé", body: "Votre commande Nexa - Pharma est payée. Elle attend la prise en charge de la pharmacie.", url: "/espace-patient.html#commandes",
        })];
        if (outcome.providerUid) tasks.push(createNexaNotification(outcome.providerUid, `pharmacy-order:payment:${outcome.paymentRef}`, {
          type: "pharmacy_order_received", title: "Nouvelle commande payée", body: "Une commande Nexa - Pharma est réglée. Consultez votre espace partenaire.", url: "/espace-professionnel.html",
        }));
        await Promise.all(tasks);
      }
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, status: "paid", paymentMethod: "SMART_WALLET", orderStatus: outcome.orderStatus, alreadyPaid: outcome.alreadyPaid });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA pharmacy Wallet payment failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "wallet-order-payment-failed", "Le paiement Wallet de la commande n’a pas abouti.");
    }
  });

  const nexaPharmacyProviderOrders = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) { res.set("Allow", "GET, POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if (req.method === "POST" && ((Number(req.get("Content-Length")) || 0) > 8_192 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 8_192))) {
      return fail(res, 413, "request-too-large", "La demande de commande est trop volumineuse.");
    }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      const providerRef = db.collection("providerProfiles").doc(user.uid);
      const providerSnapshot = await providerRef.get();
      if (!providerSnapshot.exists || providerSnapshot.get("type") !== "pharmacy" || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true) {
        throw new ApiError(403, "verified-pharmacy-required", "La gestion des commandes est réservée aux pharmacies NEXA vérifiées.");
      }
      await enforceUserRateLimit(user.uid, req.method === "GET" ? "pharmacy-orders-read" : "pharmacy-order-update", req.method === "GET" ? 60 : 30, 60_000);
      res.set("Cache-Control", "no-store, max-age=0");

      if (req.method === "GET") {
        const snapshot = await db.collection("nexaOrders")
          .where("providerUid", "==", user.uid)
          .where("kind", "==", "pharmacy")
          .where("paymentStatus", "==", "PAID")
          .where("settlementStatus", "==", "CONFIRMED")
          .orderBy("createdAt", "desc")
          .limit(100)
          .get();
        const orders = snapshot.docs.map((doc) => {
          const order = doc.data() || {};
          const items = (Array.isArray(order.items) ? order.items : []).slice(0, 20).flatMap((raw) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
            const quantity = safeInteger(raw.quantity, 1, 20);
            const unitPrice = safeInteger(raw.unitPrice ?? raw.price, 0, 10_000_000);
            return [{
              name: clean(raw.name, 180) || "Produit pharmacie",
              dci: clean(raw.dci, 180),
              dosage: clean(raw.dosage, 120),
              route: clean(raw.route, 120),
              pharmaceuticalForm: clean(raw.pharmaceuticalForm, 100),
              quantity,
              unitPrice,
              lineTotal: safeInteger(raw.lineTotal, 0, 10_000_000) || unitPrice * quantity,
              prescriptionRequired: raw.prescriptionRequired === true,
            }];
          });
          const orderNumber = clean(order.orderNumber, 80) || `NMC-PH-${doc.id.slice(-8).toUpperCase()}`;
          return {
            id: doc.id,
            orderNumber,
            items,
            subtotal: safeInteger(order.subtotal ?? order.amount, 0, 100_000_000),
            transactionFee: safeInteger(order.transactionFee, 0, 100_000_000),
            totalAmount: safeInteger(order.totalAmount, 0, 100_000_000),
            currency: clean(order.currency, 8) || "HTG",
            paymentMethod: clean(order.paymentMethod, 30),
            paymentStatus: clean(order.paymentStatus, 30),
            status: clean(order.status, 50) || "UNKNOWN",
            deliveryMethod: order.deliveryMethod === "delivery" ? "delivery" : order.deliveryMethod === "pickup" ? "pickup" : "unknown",
            deliveryFee: safeInteger(order.deliveryFee, 0, 100_000),
            ...(order.deliveryMethod === "delivery" && order.deliveryAddress && typeof order.deliveryAddress === "object" ? { deliveryAddress: {
              recipientName: clean(order.deliveryAddress.recipientName, 120), phone: clean(order.deliveryAddress.phone, 32),
              department: clean(order.deliveryAddress.department, 80), commune: clean(order.deliveryAddress.commune, 80),
              addressLine: clean(order.deliveryAddress.addressLine, 300), instructions: clean(order.deliveryAddress.instructions, 300),
            } } : {}),
            requiresPrescription: Boolean(order.prescriptionId),
            createdAt: iso(order.createdAt),
          };
        });
        return res.status(200).json({ ok: true, providerName: clean(providerSnapshot.get("profile")?.name || providerSnapshot.get("profile")?.displayName || providerSnapshot.get("displayName"), 120) || "Pharmacie NEXA", orders });
      }

      const input = bodyOf(req);
      const orderId = clean(input?.orderId, 200);
      const action = clean(input?.action, 30);
      const reason = clean(input?.reason, 500);
      if (!input || !/^[A-Za-z0-9_-]{10,200}$/.test(orderId) || !["accept", "prepare", "ready", "refuse", "complete"].includes(action)) {
        throw new ApiError(400, "invalid-pharmacy-order-action", "La commande ou l’action n’est pas valide.");
      }
      if (action === "refuse" && reason.length < 5) throw new ApiError(400, "refusal-reason-required", "Indiquez un motif d’au moins cinq caractères.");

      const orderRef = db.collection("nexaOrders").doc(orderId);
      const alertRef = db.collection("paymentSettlementAlerts").doc(`pharmacy_refusal_${orderId}`);
      const auditRef = db.collection("adminAuditLogs").doc();
      const eventRef = db.collection("nexaOrderEvents").doc();
      const result = await db.runTransaction(async (transaction) => {
        const [freshProvider, orderSnapshot, alertSnapshot] = await Promise.all([
          transaction.get(providerRef), transaction.get(orderRef), transaction.get(alertRef),
        ]);
        if (!freshProvider.exists || freshProvider.get("type") !== "pharmacy" || freshProvider.get("status") !== "verified" || freshProvider.get("publiclyListed") !== true) {
          throw new ApiError(403, "provider-no-longer-authorized", "Le profil pharmacie n’est plus autorisé à traiter des commandes.");
        }
        if (!orderSnapshot.exists || orderSnapshot.get("providerUid") !== user.uid || orderSnapshot.get("kind") !== "pharmacy") {
          throw new ApiError(404, "pharmacy-order-not-found", "Cette commande n’est pas accessible à votre pharmacie.");
        }
        const order = orderSnapshot.data() || {};
        if (order.paymentStatus !== "PAID" || order.settlementStatus !== "CONFIRMED") {
          throw new ApiError(409, "pharmacy-order-not-settled", "Le règlement doit être confirmé par NEXA avant le traitement de cette commande.");
        }
        const lines = Array.isArray(order.items) ? order.items : [];
        if (!lines.length || lines.length > 20) throw new ApiError(409, "order-stock-reservation-invalid", "Les lignes de cette commande doivent être vérifiées par NEXA.");
        const stockAction = action === "refuse" || action === "complete";
        const productRefs = stockAction ? lines.map((line) => db.collection("pharmacyProducts").doc(clean(line?.productId, 200) || "_")) : [];
        const productSnapshots = stockAction ? await Promise.all(productRefs.map((ref) => transaction.get(ref))) : [];
        const stockUpdates = [];
        let nextStatus = "";
        if (action === "accept") {
          if (order.status !== "PAID") throw new ApiError(409, "order-transition-invalid", "Seule une commande payée peut être acceptée.");
          nextStatus = "ACCEPTED";
        } else if (action === "prepare") {
          if (order.status !== "ACCEPTED") throw new ApiError(409, "order-transition-invalid", "Seule une commande acceptée peut passer en préparation.");
          nextStatus = "PREPARING";
        } else if (action === "ready") {
          if (order.status !== "PREPARING") throw new ApiError(409, "order-transition-invalid", "Seule une commande en préparation peut être déclarée prête.");
          nextStatus = "READY";
        } else if (action === "refuse") {
          if (!["PAID", "ACCEPTED", "PREPARING"].includes(String(order.status))) throw new ApiError(409, "order-transition-invalid", "Cette commande ne peut plus être refusée à cette étape.");
          nextStatus = "PROVIDER_REFUSED";
        } else {
          if (order.status !== "READY" || !["pickup", "delivery"].includes(String(order.deliveryMethod))) throw new ApiError(409, "order-transition-invalid", "Seule une commande prête à être remise peut être terminée ici.");
          nextStatus = "COMPLETED";
        }

        if (stockAction) {
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            const productSnapshot = productSnapshots[index];
            const quantity = safeInteger(line?.quantity, 1, 20);
            const allocations = Array.isArray(line?.reservedLots) ? line.reservedLots : [];
            if (!productSnapshot?.exists || productSnapshot.get("providerUid") !== user.uid) {
              throw new ApiError(409, "order-stock-reservation-invalid", "La réservation de stock doit être rapprochée par NEXA avant de traiter cette commande.");
            }
            const product = productSnapshot.data() || {};
            const lots = normalizedLots(product);
            if (!quantity || !checkReservation(lots, allocations, quantity, action === "complete")) {
              throw new ApiError(409, "order-stock-reservation-invalid", "La réservation par lot ne correspond plus au stock. Faites vérifier cette commande par NEXA.");
            }
            let updatedLots;
            if (action === "refuse") {
              updatedLots = releaseAllocations(lots, allocations);
            } else {
              updatedLots = lots.map((lot) => ({ ...lot }));
              for (const allocation of allocations) {
                const lot = updatedLots.find((candidate) => candidate.lotNumber === clean(allocation?.lotNumber, 80));
                const allocatedQuantity = safeInteger(allocation?.quantity, 1, 1_000_000);
                if (!lot || !allocatedQuantity || safeInteger(lot.reservedQuantity) < allocatedQuantity || safeInteger(lot.quantityAvailable) < allocatedQuantity) {
                  throw new ApiError(409, "order-stock-reservation-invalid", "La réservation par lot ne correspond plus au stock. Faites vérifier cette commande par NEXA.");
                }
                lot.reservedQuantity -= allocatedQuantity;
                lot.quantityAvailable -= allocatedQuantity;
                if (!lot.quantityAvailable) lot.status = "EXHAUSTED";
              }
            }
            if (!updatedLots) throw new ApiError(409, "order-stock-reservation-invalid", "La réservation de stock doit être rapprochée par NEXA.");
            stockUpdates.push({ index, productRef: productRefs[index], lots: updatedLots, ...stockSummary(updatedLots) });
          }
        }

        const now = FieldValue.serverTimestamp();
        stockUpdates.forEach(({ productRef, lots, stock, reservedStock }) => transaction.set(productRef, { lots, stock, reservedStock, updatedAt: now }, { merge: true }));
        if (action === "refuse" && !alertSnapshot.exists) transaction.create(alertRef, {
          resourceType: "pharmacy-order", resourceId: orderId, patientUid: clean(order.patientUid, 128) || null,
          reason: "PHARMACY_REFUSED_AFTER_PAYMENT", status: "open", createdAt: now,
        });
        stockUpdates.forEach(({ index }) => {
          const line = lines[index];
          transaction.create(db.collection("pharmacyStockMovements").doc(`${orderId}__${action}__${index}`), {
            productId: clean(line.productId, 200), providerUid: user.uid, orderId,
            movementType: action === "refuse" ? "RELEASE" : "SALE",
            direction: action === "refuse" ? "RELEASE" : "OUT",
            quantity: safeInteger(line.quantity, 1, 20), lotAllocations: line.reservedLots,
            actorUid: user.uid, reason: action === "refuse" ? "PROVIDER_REFUSED_PAID_ORDER" : "ORDER_FULFILLED", createdAt: now,
          });
        });
        transaction.set(orderRef, {
          status: nextStatus,
          ...(action === "refuse" ? { refundRequired: true, refundStatus: "PENDING_REVIEW", refusalReason: reason } : {}),
          ...(action === "complete" ? { fulfilledAt: now, stockConsumedAt: now } : {}),
          updatedAt: now,
        }, { merge: true });
        transaction.create(eventRef, {
          orderId, fromStatus: order.status, toStatus: nextStatus, action: action.toUpperCase(), actorUid: user.uid,
          ...(action === "refuse" ? { reason } : {}), createdAt: now,
        });
        transaction.create(auditRef, { actorUid: user.uid, action: `pharmacy_order_${action}`, resource: `nexaOrders/${orderId}`, createdAt: now });
        return { patientUid: clean(order.patientUid, 128), status: nextStatus, deliveryMethod: order.deliveryMethod === "delivery" ? "delivery" : "pickup" };
      });

      if (result.patientUid) {
        const messages = {
          ACCEPTED: { type: "pharmacy_order_status", title: "Commande acceptée", body: "La pharmacie a accepté votre commande." },
          PREPARING: { type: "pharmacy_order_status", title: "Commande en préparation", body: "La pharmacie prépare votre commande." },
          READY: { type: "pharmacy_order_status", title: "Commande prête", body: result.deliveryMethod === "delivery" ? "Votre commande est prête pour la livraison." : "Votre commande est prête à être retirée à la pharmacie." },
          COMPLETED: { type: "pharmacy_order_status", title: "Commande terminée", body: result.deliveryMethod === "delivery" ? "La pharmacie a confirmé la livraison de votre commande." : "Le retrait de votre commande a été confirmé." },
          PROVIDER_REFUSED: { type: "pharmacy_order_refund_review", title: "Commande refusée", body: "La pharmacie a refusé la commande payée. NEXA doit vérifier le remboursement; ne payez pas à nouveau." },
        };
        const message = messages[result.status];
        if (message && typeof createNexaNotification === "function") {
          await createNexaNotification(result.patientUid, `pharmacy-order:${orderId}:${result.status}`, {
            type: message.type, title: message.title, body: message.body, url: "/espace-patient.html#commandes",
          }).catch((error) => logger.warn("NEXA pharmacy order notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
        }
      }
      return res.status(200).json({ ok: true, orderId, status: result.status });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA pharmacy provider orders failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "pharmacy-provider-orders-failed", "Les commandes pharmacie ne peuvent pas être traitées pour le moment.");
    }
  });

  async function settlePaidPharmacyOrderPayment(paymentRef) {
    const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
    const preview = await paymentRefDoc.get();
    if (!preview.exists || preview.get("status") !== "paid" || preview.get("paymentMethod") !== "MONCASH" || preview.get("resourceType") !== "pharmacy-order") return null;
    const resourcePath = clean(preview.get("resourcePath"), 240);
    const match = resourcePath.match(/^nexaOrders\/([A-Za-z0-9_-]{1,200})$/);
    if (!match) return null;
    const orderRef = db.collection("nexaOrders").doc(match[1]);
    const alertRef = db.collection("paymentSettlementAlerts").doc(`order_${paymentRef}`);
    const feeLedgerRef = db.collection("nexaTransactionFeeLedger").doc(paymentRef);
    const eventRef = db.collection("nexaOrderEvents").doc();
    const outcome = await db.runTransaction(async (transaction) => {
      const [paymentSnapshot, orderSnapshot, alertSnapshot, feeSnapshot] = await Promise.all([
        transaction.get(paymentRefDoc), transaction.get(orderRef), transaction.get(alertRef), transaction.get(feeLedgerRef),
      ]);
      if (!paymentSnapshot.exists || paymentSnapshot.get("status") !== "paid" || paymentSnapshot.get("resourcePath") !== resourcePath || !orderSnapshot.exists) return null;
      const order = orderSnapshot.data() || {};
      const payment = paymentSnapshot.data() || {};
      const lines = Array.isArray(order.items) ? order.items : [];
      const productRefs = lines.map((line) => db.collection("pharmacyProducts").doc(clean(line?.productId, 200) || "_"));
      const productSnapshots = await Promise.all(productRefs.map((ref) => transaction.get(ref)));
      const fee = Number(order.transactionFee || 0);
      const feeMatches = fee === 0 ? !feeSnapshot.exists : feeSnapshot.exists && feeSnapshot.get("paymentRef") === paymentRef &&
        feeSnapshot.get("resourceType") === "pharmacy-order" && feeSnapshot.get("resourceId") === orderRef.id &&
        Number(feeSnapshot.get("serviceAmountMinor")) === Number(order.amount) * 100 && Number(feeSnapshot.get("amountMinor")) === fee * 100 &&
        feeSnapshot.get("recipient") === "NEXARIS" && feeSnapshot.get("paymentMethod") === "MONCASH" && feeSnapshot.get("status") === "COMPLETED";
      const matches = order.kind === "pharmacy" && order.patientUid === payment.uid && order.moncashPaymentRef === paymentRef &&
        orderPaymentMatches(order, payment) && order.currency === "HTG" && payment.currency === "HTG";
      const reservationHeld = lines.length > 0 && lines.length === productSnapshots.length && lines.every((line, index) => productSnapshots[index].exists &&
        checkReservation(normalizedLots(productSnapshots[index].data() || {}), line.reservedLots, Number(line.quantity), false));
      const reservationValid = lines.length > 0 && lines.length === productSnapshots.length && lines.every((line, index) => productSnapshots[index].exists &&
        checkReservation(normalizedLots(productSnapshots[index].data() || {}), line.reservedLots, Number(line.quantity)));
      const holdActive = Number(order.holdExpiresAt || 0) > Date.now();
      const alreadyPaid = order.status === "PAID" && order.paymentStatus === "PAID" && order.settlementStatus === "CONFIRMED";
      const feeConflict = fee === 0 ? feeSnapshot.exists : feeSnapshot.exists && !feeMatches;
      const sameOrder = order.kind === "pharmacy" && order.patientUid === payment.uid && order.moncashPaymentRef === paymentRef;
      if (alreadyPaid && !feeConflict) {
        if (fee > 0 && !feeSnapshot.exists) transaction.create(feeLedgerRef, {
          paymentRef, resourceType: "pharmacy-order", resourceId: orderRef.id, serviceAmountMinor: Number(order.amount) * 100,
          amountMinor: fee * 100, currency: "HTG", recipient: "NEXARIS", transactionFeeRateBps: Number(order.transactionFeeRateBps) || 0,
          paymentMethod: "MONCASH", status: "COMPLETED", createdAt: FieldValue.serverTimestamp(),
        });
        return null;
      }
      const valid = matches && !feeConflict && order.status === "PENDING_PAYMENT" && order.paymentStatus === "PENDING" && order.settlementStatus === "PENDING" &&
        holdActive && reservationValid;
      const now = FieldValue.serverTimestamp();
      if (!valid) {
        let released = false;
        const updates = [];
        if (sameOrder && order.status === "PENDING_PAYMENT" && reservationHeld) {
          for (let index = 0; index < lines.length; index += 1) {
            const product = productSnapshots[index].data() || {};
            const lots = releaseAllocations(normalizedLots(product), lines[index].reservedLots);
            if (!lots) break;
            updates.push({ index, lots, ...stockSummary(lots) });
          }
          released = updates.length === lines.length;
        }
        if (released) updates.forEach(({ index, lots, stock, reservedStock }) => transaction.set(productRefs[index], { lots, stock, reservedStock, updatedAt: now }, { merge: true }));
        if (!alertSnapshot.exists) transaction.create(alertRef, {
          paymentRef, resourceType: "pharmacy-order", resourceId: orderRef.id,
          reason: !matches ? "ORDER_PAYMENT_MISMATCH" : feeConflict ? "TRANSACTION_FEE_LEDGER_MISMATCH" : !holdActive ? "ORDER_HOLD_EXPIRED" : "ORDER_STOCK_RESERVATION_INVALID",
          status: "open", createdAt: now,
        });
        if (sameOrder) transaction.set(orderRef, {
          status: "PAYMENT_REVIEW_REQUIRED", paymentStatus: "PAID", settlementStatus: "REVIEW_REQUIRED", refundRequired: true,
          ...(released ? { stockReleasedAt: now } : {}), paidAt: order.paidAt || now, updatedAt: now,
        }, { merge: true });
        if (released) updates.forEach(({ index }) => transaction.create(db.collection("pharmacyStockMovements").doc(`${orderRef.id}__release__${index}`), {
          productId: lines[index].productId, providerUid: order.providerUid, orderId: orderRef.id, movementType: "RESERVATION_RELEASE",
          direction: "RELEASE", quantity: lines[index].quantity, lotAllocations: lines[index].reservedLots, actorUid: "system:moncash",
          reason: "PAID_AFTER_HOLD_OR_ORDER_REVIEW", createdAt: now,
        }));
        if (matches && !feeConflict && fee > 0 && !feeSnapshot.exists) transaction.create(feeLedgerRef, {
          paymentRef, resourceType: "pharmacy-order", resourceId: orderRef.id, serviceAmountMinor: Number(order.amount) * 100,
          amountMinor: fee * 100, currency: "HTG", recipient: "NEXARIS", transactionFeeRateBps: Number(order.transactionFeeRateBps) || 0,
          paymentMethod: "MONCASH", status: "COMPLETED", createdAt: now,
        });
        if (!alertSnapshot.exists) transaction.create(eventRef, { orderId: orderRef.id, fromStatus: String(order.status || "UNKNOWN"), toStatus: "PAYMENT_REVIEW_REQUIRED", action: "MONCASH_REQUIRES_REVIEW", actorUid: "system:moncash", createdAt: now });
        return { patientUid: clean(payment.uid, 128), confirmed: false };
      }
      if (fee > 0 && !feeSnapshot.exists) transaction.create(feeLedgerRef, {
        paymentRef, resourceType: "pharmacy-order", resourceId: orderRef.id, serviceAmountMinor: Number(order.amount) * 100,
        amountMinor: fee * 100, currency: "HTG", recipient: "NEXARIS", transactionFeeRateBps: Number(order.transactionFeeRateBps) || 0,
        paymentMethod: "MONCASH", status: "COMPLETED", createdAt: now,
      });
      transaction.set(orderRef, { status: "PAID", paymentStatus: "PAID", settlementStatus: "CONFIRMED", paidAt: order.paidAt || now, updatedAt: now }, { merge: true });
      transaction.create(eventRef, { orderId: orderRef.id, fromStatus: "PENDING_PAYMENT", toStatus: "PAID", action: "MONCASH_SETTLED", actorUid: "system:moncash", createdAt: now });
      return { patientUid: clean(payment.uid, 128), providerUid: clean(order.providerUid, 128), confirmed: true };
    });
    if (outcome?.patientUid) {
      await createNexaNotification(outcome.patientUid, `pharmacy-order:payment:${paymentRef}`, {
        type: outcome.confirmed ? "pharmacy_order_payment_confirmed" : "order_payment_reconciliation",
        title: outcome.confirmed ? "Paiement confirmé" : "Paiement à rapprocher",
        body: outcome.confirmed ? "Votre commande Nexa - Pharma est payée. Elle attend la prise en charge de la pharmacie." : "Le paiement a été reçu, mais NEXA doit vérifier la commande. Ne payez pas une seconde fois.",
        url: "/espace-patient.html#commandes",
      });
      if (outcome.confirmed && outcome.providerUid) await createNexaNotification(outcome.providerUid, `pharmacy-order:payment:${paymentRef}`, {
        type: "pharmacy_order_received", title: "Nouvelle commande payée", body: "Une commande Nexa - Pharma est réglée. Consultez votre espace partenaire.", url: "/espace-professionnel.html",
      });
    }
    return outcome;
  }

  async function expireOnePharmacyHold(orderId) {
    const orderRef = db.collection("nexaOrders").doc(orderId);
    const result = await db.runTransaction(async (transaction) => {
      const orderSnapshot = await transaction.get(orderRef);
      if (!orderSnapshot.exists || orderSnapshot.get("kind") !== "pharmacy" || orderSnapshot.get("status") !== "PENDING_PAYMENT" || Number(orderSnapshot.get("holdExpiresAt") || 0) > Date.now()) return null;
      const order = orderSnapshot.data() || {};
      const paymentRef = clean(order.moncashPaymentRef, 64);
      const paymentRefDoc = PAYMENT_REFERENCE_PATTERN.test(paymentRef) ? db.collection("paymentIntents").doc(paymentRef) : null;
      const paymentSnapshot = paymentRefDoc ? await transaction.get(paymentRefDoc) : null;
      if (paymentSnapshot?.exists && paymentSnapshot.get("status") === "paid") return { paymentRef, paid: true };
      const lines = Array.isArray(order.items) ? order.items : [];
      const productRefs = lines.map((line) => db.collection("pharmacyProducts").doc(clean(line?.productId, 200) || "_"));
      const productSnapshots = await Promise.all(productRefs.map((ref) => transaction.get(ref)));
      const reservationValid = lines.length > 0 && lines.length === productSnapshots.length && lines.every((line, index) => productSnapshots[index].exists &&
        checkReservation(normalizedLots(productSnapshots[index].data() || {}), line.reservedLots, Number(line.quantity), false));
      const now = FieldValue.serverTimestamp();
      if (!reservationValid) {
        const alertRef = db.collection("paymentSettlementAlerts").doc(`pharmacy_hold_${orderRef.id}`);
        const alertSnapshot = await transaction.get(alertRef);
        if (!alertSnapshot.exists) transaction.create(alertRef, { resourceType: "pharmacy-order", resourceId: orderRef.id, reason: "PHARMACY_HOLD_STOCK_MISMATCH", status: "open", createdAt: now });
        transaction.set(orderRef, { status: "PAYMENT_REVIEW_REQUIRED", settlementStatus: "REVIEW_REQUIRED", updatedAt: now }, { merge: true });
        return { paymentRef, paid: false, review: true };
      }
      const updates = [];
      for (let index = 0; index < lines.length; index += 1) {
        const lots = releaseAllocations(normalizedLots(productSnapshots[index].data() || {}), lines[index].reservedLots);
        if (!lots) return null;
        updates.push({ index, lots, ...stockSummary(lots) });
      }
      updates.forEach(({ index, lots, stock, reservedStock }) => transaction.set(productRefs[index], { lots, stock, reservedStock, updatedAt: now }, { merge: true }));
      transaction.set(orderRef, { status: "EXPIRED", paymentStatus: "EXPIRED", settlementStatus: "EXPIRED", stockReleasedAt: now, updatedAt: now }, { merge: true });
      if (paymentRefDoc && paymentSnapshot?.exists && paymentSnapshot.get("status") !== "paid") transaction.set(paymentRefDoc, { status: "expired", expiredAt: now, updatedAt: now }, { merge: true });
      updates.forEach(({ index }) => transaction.create(db.collection("pharmacyStockMovements").doc(`${orderRef.id}__release__${index}`), {
        productId: lines[index].productId, providerUid: order.providerUid, orderId: orderRef.id, movementType: "RESERVATION_RELEASE", direction: "RELEASE",
        quantity: lines[index].quantity, lotAllocations: lines[index].reservedLots, actorUid: "system:hold-expiry", reason: "PAYMENT_HOLD_EXPIRED", createdAt: now,
      }));
      transaction.create(db.collection("nexaOrderEvents").doc(), { orderId: orderRef.id, fromStatus: "PENDING_PAYMENT", toStatus: "EXPIRED", action: "PHARMACY_PAYMENT_HOLD_EXPIRED", actorUid: "system:hold-expiry", createdAt: now });
      return { paymentRef, paid: false, expired: true };
    });
    if (result?.paid && result.paymentRef) await settlePaidPharmacyOrderPayment(result.paymentRef);
    return result;
  }

  const nexaExpirePharmacyOrderHolds = onSchedule({
    schedule: "every 5 minutes", timeZone: "America/Port-au-Prince", region: REGION, maxInstances: 1,
  }, async () => {
    const snapshot = await db.collection("nexaOrders")
      .where("kind", "==", "pharmacy")
      .where("status", "==", "PENDING_PAYMENT")
      .where("holdExpiresAt", "<=", Date.now())
      .orderBy("holdExpiresAt", "asc")
      .limit(50)
      .get();
    for (const doc of snapshot.docs) {
      try { await expireOnePharmacyHold(doc.id); }
      catch (error) { logger.error("NEXA pharmacy payment hold expiry failed", { errorName: error instanceof Error ? error.name : "unknown-error", orderId: doc.id }); }
    }
  });

  return {
    nexaPharmacyPublicProducts, nexaPharmacyProviderProducts, nexaPharmacyProviderLotReceive,
    nexaPharmacyOrderCreate, nexaPharmacyOrderWalletPay, nexaPharmacyProviderOrders,
    nexaExpirePharmacyOrderHolds, settlePaidPharmacyOrderPayment,
  };
};
