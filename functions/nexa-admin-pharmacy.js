"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const { FieldPath } = require("firebase-admin/firestore");
const { createHash } = require("node:crypto");

const REGION = "us-east4";
const ORDER_PAGE_SIZE = 25;
const PRODUCT_REVIEW_PAGE_SIZE = 50;
const MAX_ORDER_REQUEST_BYTES = 8_192;

function parseProductReviewCursor(value, ApiError) {
  if (value === undefined) return { after: null, done: false };
  if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApiError(400, "invalid-product-review-cursor", "Le repère de pagination des produits n’est pas valide.");
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch {
    throw new ApiError(400, "invalid-product-review-cursor", "Le repère de pagination des produits n’est pas valide.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !== "after,done" || typeof parsed.done !== "boolean" ||
    (parsed.after !== null && (typeof parsed.after !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(parsed.after)))) {
    throw new ApiError(400, "invalid-product-review-cursor", "Le repère de pagination des produits n’est pas valide.");
  }
  return { after: parsed.after, done: parsed.done };
}

function encodeProductReviewCursor(cursor) {
  return cursor.done ? null : Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function clean(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function getBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  if (!Buffer.isBuffer(req.rawBody)) return null;
  try {
    const body = JSON.parse(req.rawBody.toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch { return null; }
}

function localDate(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Port-au-Prince", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function daysUntilDate(expiration, now = Date.now()) {
  if (typeof expiration !== "string" || !expiration.trim()) return null;
  const value = expiration.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (!validDate(value)) return null;
    const [year, month, day] = value.split("-").map(Number);
    const [todayYear, todayMonth, todayDay] = localDate(now).split("-").map(Number);
    return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(todayYear, todayMonth - 1, todayDay)) / 86_400_000);
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.ceil((timestamp - now) / 86_400_000) : null;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function inventoryOf(product, now = Date.now()) {
  const lots = (Array.isArray(product?.lots) ? product.lots : []).map((raw) => {
    const lot = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
    const expiration = typeof lot.expirationDate === "string" ? lot.expirationDate.trim() : "";
    const expired = /^\d{4}-\d{2}-\d{2}$/.test(expiration)
      ? !validDate(expiration) || expiration < localDate(now)
      : !Number.isFinite(Date.parse(expiration)) || Date.parse(expiration) < now;
    lot.status = clean(lot.status, 30).toUpperCase() || "ACTIVE";
    if (lot.status === "ACTIVE" && expired) lot.status = "EXPIRED";
    lot.lotNumber = clean(lot.lotNumber, 80);
    lot.quantityAvailable = Number.isSafeInteger(lot.quantityAvailable) && lot.quantityAvailable >= 0 && lot.quantityAvailable <= 1_000_000 ? lot.quantityAvailable : 0;
    lot.reservedQuantity = Number.isSafeInteger(lot.reservedQuantity) && lot.reservedQuantity >= 0 && lot.reservedQuantity <= 1_000_000 ? lot.reservedQuantity : 0;
    lot.quantityReceived = Number.isSafeInteger(lot.quantityReceived) && lot.quantityReceived > 0 && lot.quantityReceived <= 1_000_000 ? lot.quantityReceived : 0;
    return lot;
  });
  const active = lots.filter((lot) => String(lot.status).toUpperCase() === "ACTIVE");
  return {
    lots,
    stock: active.reduce((sum, lot) => sum + lot.quantityAvailable, 0),
    reservedStock: lots.reduce((sum, lot) => sum + lot.reservedQuantity, 0),
    availableStock: active.reduce((sum, lot) => sum + Math.max(0, lot.quantityAvailable - lot.reservedQuantity), 0),
  };
}

function inventoryAlerts(productId, product, inventory, now = Date.now()) {
  const alerts = [];
  const name = clean(product?.name, 180) || "Produit pharmacie";
  const availableStock = inventory.availableStock;
  const isPublished = product?.publicationStatus === "PUBLISHED";
  const threshold = Number.isSafeInteger(product?.lowStockThreshold) && product.lowStockThreshold >= 1 && product.lowStockThreshold <= 100_000
    ? product.lowStockThreshold
    : 5;
  if (availableStock === 0) {
    alerts.push({ type: "OUT_OF_STOCK", severity: "ERROR", productId, productName: name, availableStock, threshold });
  } else if (isPublished && availableStock <= threshold) {
    alerts.push({ type: "LOW_STOCK", severity: "WARNING", productId, productName: name, availableStock, threshold });
  }
  if (isPublished && inventory.stock === 0) {
    alerts.push({ type: "PUBLISHED_WITHOUT_STOCK", severity: "CRITICAL", productId, productName: name, stock: inventory.stock });
  }
  if (Array.isArray(product?.lots) && product.stock !== inventory.stock) {
    alerts.push({
      type: "STOCK_MISMATCH",
      severity: "ERROR",
      productId,
      productName: name,
      storedStock: Number.isSafeInteger(product.stock) ? product.stock : null,
      calculatedStock: inventory.stock,
    });
  }

  const today = localDate(now);
  const configuredDays = Number.isSafeInteger(product?.expirationAlertDays) && product.expirationAlertDays >= 1 && product.expirationAlertDays <= 365
    ? product.expirationAlertDays
    : 90;
  for (const lot of inventory.lots) {
    const expirationDate = clean(lot.expirationDate, 30);
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(expirationDate) && validDate(expirationDate);
    const expired = lot.status === "EXPIRED" || (dateOnly && expirationDate < today);
    if (expired && lot.quantityAvailable > 0) {
      alerts.push({
        type: "EXPIRED_LOT", severity: "ERROR", productId, productName: name,
        lotNumber: lot.lotNumber, expirationDate, quantity: lot.quantityAvailable,
      });
    } else if (lot.status === "ACTIVE" && lot.quantityAvailable > 0) {
      const days = daysUntilDate(expirationDate, now);
      const level = days !== null && days >= 0 && days <= 30 ? 30
        : days !== null && days >= 0 && days <= 60 ? 60
          : days !== null && days >= 0 && days <= configuredDays ? configuredDays
            : 0;
      if (!level) continue;
      alerts.push({
        type: `EXPIRING_LOT_${level}`,
        severity: level === 30 ? "CRITICAL" : level === 60 ? "ERROR" : "WARNING",
        productId, productName: name, lotNumber: lot.lotNumber,
        expirationDate, quantity: lot.quantityAvailable, daysUntilExpiration: days, expiryLevel: level,
        configuredThreshold: configuredDays,
      });
    }
  }
  return alerts;
}

function inventoryAlertId(alert) {
  const identity = [
    clean(alert.productId, 200),
    clean(alert.type, 60),
    clean(alert.lotNumber, 80),
    clean(alert.expirationDate, 30),
  ].join("\u001f");
  return createHash("sha256").update(identity).digest("hex");
}

function isoDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return Number.NaN;
}

function safeAmount(value, maximum = 10_000_000) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : 0;
}

function timestampMillis(value) {
  if (value && typeof value.toDate === "function") {
    const date = value.toDate();
    return date instanceof Date && Number.isFinite(date.getTime()) ? date.getTime() : Number.NaN;
  }
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : Number.NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function pharmacyPrescriptionAudit(order, prescriptionSnapshot) {
  const requiredItems = (Array.isArray(order.items) ? order.items : []).filter((item) => item && item.prescriptionRequired === true);
  const currentStatus = ["DRAFT", "VALIDATED", "REPLACED"].includes(order.prescriptionStatus)
    ? order.prescriptionStatus
    : "UNKNOWN";
  const result = (assessment, matchedLineCount = 0, replacedAfterOrder = false, lineLinksChecked = false) => ({
    assessment,
    currentStatus,
    requiredLineCount: requiredItems.length,
    matchedLineCount,
    replacedAfterOrder,
    lineLinksChecked,
  });
  if (!requiredItems.length) return result("NOT_REQUIRED");
  const prescriptionId = clean(order.prescriptionId, 200);
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(prescriptionId)) return result("MISSING_LINK");
  if (!prescriptionSnapshot?.exists) return result("NOT_FOUND");
  const prescription = prescriptionSnapshot.data() || {};
  const status = ["DRAFT", "VALIDATED", "REPLACED"].includes(prescription.status) ? prescription.status : "UNKNOWN";
  if (!order.patientUid || prescription.patientUid !== order.patientUid) return { ...result("OWNER_MISMATCH"), currentStatus: "UNKNOWN" };

  const orderTime = timestampMillis(order.createdAt);
  const validatedAt = timestampMillis(prescription.validatedAt);
  const replacedAt = timestampMillis(prescription.updatedAt);
  if (!Number.isFinite(orderTime)) return { ...result("TIME_UNVERIFIABLE"), currentStatus: status };
  const validatedAtOrder = Number.isFinite(validatedAt) && validatedAt <= orderTime &&
    (status === "VALIDATED" || (status === "REPLACED" && Number.isFinite(replacedAt) && replacedAt > orderTime));
  if (!validatedAtOrder) return { ...result("NOT_VALIDATED_AT_ORDER"), currentStatus: status };
  const expiresAt = timestampMillis(prescription.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= orderTime) return { ...result("EXPIRED_AT_ORDER"), currentStatus: status, replacedAfterOrder: status === "REPLACED" };

  const medications = Array.isArray(prescription.medications) ? prescription.medications.slice(0, 50) : [];
  const usedLines = new Set();
  const orderedByLine = new Map();
  let matchedLineCount = 0;
  for (const item of requiredItems) {
    const lineId = clean(item.prescriptionLineId, 80);
    const match = /^medication-(\d{1,3})$/.exec(lineId);
    const lineIndex = match ? Number(match[1]) - 1 : -1;
    const medication = lineIndex >= 0 ? medications[lineIndex] : null;
    const medicationName = medication && typeof medication === "object" && !Array.isArray(medication)
      ? clean(medication.name || medication.medication_text, 180)
      : "";
    const quantity = Number.isSafeInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 20 ? item.quantity : 0;
    if (!medicationName || !quantity || usedLines.has(lineId)) return { ...result("LINE_LINK_MISMATCH", matchedLineCount, status === "REPLACED", true), currentStatus: status };
    usedLines.add(lineId);
    matchedLineCount += 1;
    orderedByLine.set(lineIndex, (orderedByLine.get(lineIndex) || 0) + quantity);
  }
  for (const [lineIndex, orderedQuantity] of orderedByLine) {
    const rawQuantity = Number(medications[lineIndex]?.quantity);
    const prescribedQuantity = Number.isSafeInteger(rawQuantity) && rawQuantity > 0 ? Math.min(rawQuantity, 20) : 1;
    if (orderedQuantity > prescribedQuantity) return { ...result("QUANTITY_EXCEEDED", matchedLineCount, status === "REPLACED", true), currentStatus: status };
  }
  return {
    ...result("MATCHED_AT_ORDER", matchedLineCount, status === "REPLACED", true),
    currentStatus: status,
  };
}

module.exports = function createNexaAdminPharmacyFunctions(dependencies) {
  const { db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger, createNexaNotification } = dependencies;

  async function requireNexaPharmacyAdmin(req, action, limit) {
    const admin = await requireUser(req);
    await requireAppCheckToken(req);
    const administrators = new Set(String(process.env.NEXA_ADMIN_UIDS || "").split(",").map((value) => value.trim()).filter(Boolean));
    if (!administrators.size) throw new ApiError(503, "admin-access-not-configured", "L’accès administrateur NEXA n’est pas configuré.");
    if (!administrators.has(admin.uid)) throw new ApiError(403, "administrator-required", "Accès administrateur requis.");
    await enforceUserRateLimit(admin.uid, action, limit, 60_000);
    return admin;
  }

  const nexaAdminPharmacyProducts = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) { res.set("Allow", "GET, POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if (req.method === "POST" && ((Number(req.get("Content-Length")) || 0) > 16_384 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 16_384))) return fail(res, 413, "request-too-large", "La demande de revue est trop volumineuse.");
    try {
      const admin = await requireUser(req);
      await requireAppCheckToken(req);
      const administrators = new Set(String(process.env.NEXA_ADMIN_UIDS || "").split(",").map((value) => value.trim()).filter(Boolean));
      if (!administrators.size) throw new ApiError(503, "admin-access-not-configured", "L’accès administrateur NEXA n’est pas configuré.");
      if (!administrators.has(admin.uid)) throw new ApiError(403, "administrator-required", "Accès administrateur requis.");
      await enforceUserRateLimit(admin.uid, req.method === "GET" ? "admin-pharmacy-products-read" : "admin-pharmacy-products-review", req.method === "GET" ? 60 : 30, 60_000);
      res.set("Cache-Control", "no-store, max-age=0");

      if (req.method === "GET") {
        const cursor = parseProductReviewCursor(req.query.cursor, ApiError);
        const collection = db.collection("pharmacyProducts");
        let query = collection.where("publicationStatus", "==", "PENDING_REVIEW").orderBy(FieldPath.documentId(), "asc");
        if (cursor.after) query = query.startAfter(collection.doc(cursor.after));
        const snapshot = cursor.done ? null : await query.limit(PRODUCT_REVIEW_PAGE_SIZE + 1).get();
        const docs = snapshot ? snapshot.docs.slice(0, PRODUCT_REVIEW_PAGE_SIZE) : [];
        const lastDoc = docs[docs.length - 1];
        const next = {
          after: lastDoc ? lastDoc.id : cursor.after,
          done: !snapshot || snapshot.docs.length <= PRODUCT_REVIEW_PAGE_SIZE,
        };
        const products = docs.map((doc) => {
          const data = doc.data() || {};
          const inventory = inventoryOf(data);
          return {
            id: doc.id, providerUid: clean(data.providerUid, 128), name: clean(data.name, 180), dci: clean(data.dci, 180),
            dosage: clean(data.dosage, 120), route: clean(data.route, 120), pharmaceuticalForm: clean(data.pharmaceuticalForm, 100), therapeuticClass: clean(data.therapeuticClass, 120),
            regulatoryCategory: clean(data.regulatoryCategory, 40), prescriptionRequired: data.prescriptionRequired === true,
            publicDescription: clean(data.publicDescription, 700), manufacturer: clean(data.manufacturer, 120),
            deliveryMode: ["delivery", "both"].includes(String(data.deliveryMode)) ? data.deliveryMode : "pickup",
            deliveryZones: Array.isArray(data.deliveryZones) ? data.deliveryZones.slice(0, 30).map((zone) => ({
              department: clean(zone?.department, 80), commune: clean(zone?.commune, 80),
              feeHTG: Number.isSafeInteger(zone?.feeHTG) && zone.feeHTG >= 0 ? zone.feeHTG : 0,
              etaLabel: clean(zone?.etaLabel, 80), active: zone?.active !== false,
            })) : [],
            coldChainRequired: data.coldChainRequired === true,
            price: Number.isSafeInteger(data.price) && data.price > 0 ? data.price : 0,
            stock: inventory.stock, reservedStock: inventory.reservedStock, availableStock: inventory.availableStock,
            lots: inventory.lots.map((lot) => ({ lotNumber: lot.lotNumber, expirationDate: clean(lot.expirationDate, 30), quantityAvailable: lot.quantityAvailable, reservedQuantity: lot.reservedQuantity, status: clean(lot.status, 30) || "ACTIVE" })),
            reviewReason: clean(data.reviewReason, 500),
          };
        });
        const hasMore = !next.done;
        await db.collection("adminAuditLogs").doc().create({ actorUid: admin.uid, action: "pharmacy_products_review_listed", resultCount: products.length, hasMore, createdAt: FieldValue.serverTimestamp() });
        return res.status(200).json({ ok: true, products, nextCursor: encodeProductReviewCursor(next), hasMore });
      }

      const body = getBody(req);
      const productId = clean(body?.productId, 200);
      const action = clean(body?.action, 40).toUpperCase();
      const reason = clean(body?.reason, 500);
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(productId) || !["PUBLISH", "REJECT", "SUSPEND", "REQUEST_CORRECTION", "ARCHIVE"].includes(action)) throw new ApiError(400, "invalid-product-review", "Le produit ou la décision de revue n’est pas valide.");
      if (action !== "PUBLISH" && reason.length < 5) throw new ApiError(400, "review-reason-required", "Indiquez un motif d’au moins cinq caractères.");

      const productRef = db.collection("pharmacyProducts").doc(productId);
      const auditRef = db.collection("adminAuditLogs").doc();
      const outcome = await db.runTransaction(async (transaction) => {
        const productSnapshot = await transaction.get(productRef);
        if (!productSnapshot.exists) throw new ApiError(404, "product-not-found", "Produit introuvable.");
        const product = productSnapshot.data() || {};
        const providerUid = clean(product.providerUid, 128);
        const providerRef = db.collection("providerProfiles").doc(providerUid || "_");
        const providerSnapshot = await transaction.get(providerRef);
        const inventory = inventoryOf(product);
        if (action === "PUBLISH") {
          if (!providerSnapshot.exists || providerSnapshot.get("type") !== "pharmacy" || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true) throw new ApiError(409, "pharmacy-not-publishable", "La pharmacie propriétaire n’est plus vérifiée et publiée.");
          const categories = ["OTC", "PRESCRIPTION", "CONTROLLED", "NARCOTIC", "SENSITIVE"];
          if (!product.name || !product.dci || !product.dosage || !product.route || !product.pharmaceuticalForm || !product.therapeuticClass || !categories.includes(String(product.regulatoryCategory || "")) ||
            !Number.isSafeInteger(product.price) || product.price < 1 || (product.regulatoryCategory !== "OTC" && product.prescriptionRequired !== true) || inventory.availableStock < 1) {
            throw new ApiError(409, "product-review-incomplete", "La fiche doit contenir le dosage, la voie d’administration, la forme, un prix valide, le marquage ordonnance requis et un stock non réservé dans un lot actif non expiré.");
          }
          const mode = String(product.deliveryMode || "pickup");
          if (!["pickup", "delivery", "both"].includes(mode)) throw new ApiError(409, "product-delivery-mode-invalid", "La modalité de livraison doit être corrigée avant publication.");
          if (["delivery", "both"].includes(mode)) {
            const activeZones = Array.isArray(product.deliveryZones) ? product.deliveryZones.filter((zone) => zone && zone.active !== false && clean(zone.department, 80) && clean(zone.commune, 80) && clean(zone.etaLabel, 80) && Number.isSafeInteger(zone.feeHTG) && zone.feeHTG >= 0) : [];
            if (product.coldChainRequired === true || !activeZones.length) throw new ApiError(409, "product-delivery-zones-incomplete", "Une livraison exige une zone active avec frais et délai valides; les produits de chaîne du froid restent au retrait.");
          }
        }
        const status = action === "PUBLISH" ? "PUBLISHED" : action === "REQUEST_CORRECTION" ? "NEEDS_CORRECTION" : action === "SUSPEND" ? "SUSPENDED" : action === "ARCHIVE" ? "ARCHIVED" : "REJECTED";
        const now = FieldValue.serverTimestamp();
        transaction.set(productRef, {
          lots: inventory.lots, stock: inventory.stock, reservedStock: inventory.reservedStock,
          publicationStatus: status, active: action === "PUBLISH", reviewReason: action === "PUBLISH" ? "" : reason,
          reviewedByUid: admin.uid, reviewedAt: now, updatedAt: now,
        }, { merge: true });
        transaction.create(auditRef, { actorUid: admin.uid, action: `pharmacy_product_${action.toLowerCase()}`, resource: productRef.path, createdAt: now });
        return { providerUid, status };
      });

      if (outcome.providerUid && typeof createNexaNotification === "function") {
        const messages = {
          PUBLISHED: { title: "Produit publié", body: "Votre produit est visible dans le catalogue NEXA." },
          NEEDS_CORRECTION: { title: "Correction demandée", body: reason },
          SUSPENDED: { title: "Produit suspendu", body: reason },
          ARCHIVED: { title: "Produit archivé", body: reason },
          REJECTED: { title: "Produit refusé", body: reason },
        };
        const message = messages[outcome.status];
        if (message) await createNexaNotification(outcome.providerUid, `pharmacy-product-review:${productId}:${auditRef.id}`, {
          type: "pharmacy_product_review", title: message.title, body: message.body, url: "/espace-pharmacie.html",
        }).catch((error) => logger.warn("NEXA pharmacy product review notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
      }
      return res.status(200).json({ ok: true, productId, publicationStatus: outcome.status });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA admin pharmacy products failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "admin-pharmacy-products-unavailable", "Les produits pharmacie ne sont pas accessibles.");
    }
  });

  const nexaAdminPharmacyInventory = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) { res.set("Allow", "GET, POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if (req.method === "POST" && ((Number(req.get("Content-Length")) || 0) > 16_384 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 16_384))) {
      return fail(res, 413, "request-too-large", "La demande de gestion du stock est trop volumineuse.");
    }
    try {
      const admin = await requireNexaPharmacyAdmin(req, req.method === "GET" ? "admin-pharmacy-inventory-read" : "admin-pharmacy-lot-review", req.method === "GET" ? 60 : 30);
      res.set("Cache-Control", "no-store, max-age=0");

      if (req.method === "GET") {
        const rawCursor = typeof req.query?.cursor === "string" ? req.query.cursor : "";
        if (rawCursor && (!/^[A-Za-z0-9_-]{10,200}$/.test(rawCursor) || rawCursor.includes("/"))) {
          throw new ApiError(400, "invalid-inventory-cursor", "Le repère d’inventaire n’est pas valide.");
        }
        const pageSize = 30;
        let query = db.collection("pharmacyProducts").orderBy(FieldPath.documentId());
        if (rawCursor) {
          const cursor = await db.collection("pharmacyProducts").doc(rawCursor).get();
          if (!cursor.exists) throw new ApiError(400, "invalid-inventory-cursor", "Le repère d’inventaire a expiré. Actualisez la liste.");
          query = query.startAfter(cursor);
        }
        const [snapshot, totalCount] = await Promise.all([
          query.limit(pageSize + 1).get(),
          db.collection("pharmacyProducts").count().get(),
        ]);
        const hasMore = snapshot.docs.length > pageSize;
        const page = snapshot.docs.slice(0, pageSize);
        const products = page.map((doc) => {
          const data = doc.data() || {};
          const inventory = inventoryOf(data);
          return {
            id: doc.id,
            providerUid: clean(data.providerUid, 128),
            name: clean(data.name, 180),
            dci: clean(data.dci, 180),
            dosage: clean(data.dosage, 120),
            route: clean(data.route, 120),
            pharmaceuticalForm: clean(data.pharmaceuticalForm, 100),
            publicationStatus: clean(data.publicationStatus, 32) || "UNKNOWN",
            stock: inventory.stock,
            reservedStock: inventory.reservedStock,
            availableStock: inventory.availableStock,
            lowStockThreshold: Number.isSafeInteger(data.lowStockThreshold) && data.lowStockThreshold >= 1 && data.lowStockThreshold <= 100_000 ? data.lowStockThreshold : 5,
            lots: inventory.lots.map((lot) => ({
              lotNumber: lot.lotNumber,
              expirationDate: clean(lot.expirationDate, 30),
              quantityReceived: lot.quantityReceived,
              quantityAvailable: lot.quantityAvailable,
              reservedQuantity: lot.reservedQuantity,
              status: clean(lot.status, 30) || "ACTIVE",
              adminStockReason: clean(lot.adminStockReason, 500),
            })),
          };
        });
        const alerts = page.flatMap((doc, index) => inventoryAlerts(doc.id, doc.data() || {}, inventoryOf(doc.data() || {}), Date.now()).map((alert) => ({ ...alert, providerUid: clean(doc.get("providerUid"), 128), productPageIndex: index + 1 })));
        await db.collection("adminAuditLogs").doc().create({
          actorUid: admin.uid,
          action: "pharmacy_inventory_and_alerts_listed",
          resultCount: products.length,
          alertCount: alerts.length,
          cursorUsed: Boolean(rawCursor),
          createdAt: FieldValue.serverTimestamp(),
        });
        return res.status(200).json({
          ok: true,
          products,
          alerts,
          totalProducts: totalCount.data().count,
          nextCursor: hasMore ? page[page.length - 1]?.id || null : null,
          hasMore,
        });
      }

      const body = getBody(req);
      if (!body || Object.keys(body).some((key) => !["productId", "lotNumber", "action", "reason"].includes(key))) {
        throw new ApiError(400, "invalid-stock-review", "La demande de revue de stock n’est pas valide.");
      }
      const productId = clean(body.productId, 200);
      const lotNumber = clean(body.lotNumber, 80);
      const action = clean(body.action, 24).toLowerCase();
      const reason = clean(body.reason, 500);
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(productId) || !lotNumber || !["quarantine", "restore"].includes(action) || reason.length < 5) {
        throw new ApiError(400, "invalid-stock-review", "Choisissez un lot, une décision et un motif d’au moins cinq caractères.");
      }
      const productRef = db.collection("pharmacyProducts").doc(productId);
      const auditRef = db.collection("adminAuditLogs").doc();
      const movementRef = db.collection("pharmacyStockMovements").doc();
      const outcome = await db.runTransaction(async (transaction) => {
        const productSnapshot = await transaction.get(productRef);
        if (!productSnapshot.exists) throw new ApiError(404, "pharmacy-product-not-found", "Le produit pharmacie n’existe plus.");
        const current = productSnapshot.data() || {};
        const providerUid = clean(current.providerUid, 128);
        const providerRef = db.collection("providerProfiles").doc(providerUid || "_");
        const providerSnapshot = await transaction.get(providerRef);
        if (!providerSnapshot.exists || providerSnapshot.get("type") !== "pharmacy") throw new ApiError(409, "pharmacy-provider-invalid", "La pharmacie propriétaire du produit n’est plus valide.");
        const inventory = inventoryOf(current);
        const normalizeLot = (value) => clean(value, 80).normalize("NFKC").toLocaleLowerCase("fr");
        const lotIndex = inventory.lots.findIndex((lot) => normalizeLot(lot.lotNumber) === normalizeLot(lotNumber));
        if (lotIndex < 0) throw new ApiError(404, "pharmacy-lot-not-found", "Ce lot n’existe pas dans la fiche produit.");
        const lots = inventory.lots;
        const lot = lots[lotIndex];
        const alreadyApplied = action === "quarantine" ? lot.status === "QUARANTINE" : lot.status === "ACTIVE";
        if (alreadyApplied) return { providerUid, lotNumber: lot.lotNumber, status: lot.status, alreadyApplied: true };
        if (lot.reservedQuantity > 0) throw new ApiError(409, "pharmacy-lot-reserved", "Ce lot contient du stock réservé. Traitez les commandes ouvertes avant de modifier son état.");
        if (action === "quarantine") {
          if (lot.status !== "ACTIVE") throw new ApiError(409, "pharmacy-lot-not-quarantinable", "Seul un lot actif peut être placé en quarantaine.");
          lot.status = "QUARANTINE";
          lot.adminStockReason = reason;
        } else {
          if (lot.status !== "QUARANTINE" && lot.status !== "BLOCKED") throw new ApiError(409, "pharmacy-lot-not-restorable", "Seul un lot en quarantaine ou bloqué peut être rétabli.");
          const expiration = clean(lot.expirationDate, 30);
          const stillValid = /^\d{4}-\d{2}-\d{2}$/.test(expiration)
            ? validDate(expiration) && expiration >= localDate()
            : Number.isFinite(Date.parse(expiration)) && Date.parse(expiration) >= Date.now();
          if (!stillValid || lot.quantityAvailable <= 0) throw new ApiError(409, "pharmacy-lot-expired-or-empty", "Un lot expiré, invalide ou sans quantité disponible ne peut pas être rétabli.");
          lot.status = "ACTIVE";
          delete lot.adminStockReason;
        }
        const nextInventory = inventoryOf({ ...current, lots });
        const now = FieldValue.serverTimestamp();
        transaction.update(productRef, { lots: nextInventory.lots, stock: nextInventory.stock, reservedStock: nextInventory.reservedStock, updatedAt: now });
        transaction.create(movementRef, {
          productId,
          providerUid,
          lotNumber: lot.lotNumber,
          movementType: action === "quarantine" ? "ADMIN_LOT_QUARANTINE" : "ADMIN_LOT_RESTORED",
          direction: "NONE",
          quantity: 0,
          actorUid: admin.uid,
          reason,
          createdAt: now,
        });
        transaction.create(auditRef, {
          actorUid: admin.uid,
          action: action === "quarantine" ? "pharmacy_lot_quarantined" : "pharmacy_lot_restored",
          resource: productRef.path,
          lotNumber: lot.lotNumber,
          reason,
          createdAt: now,
        });
        return { providerUid, lotNumber: lot.lotNumber, status: lot.status, alreadyApplied: false };
      });
      return res.status(200).json({ ok: true, productId, ...outcome });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA admin pharmacy inventory failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "admin-pharmacy-inventory-unavailable", "L’inventaire pharmacie n’est pas disponible.");
    }
  });

  const nexaAdminPharmacyInventoryAlerts = onRequest({ region: REGION, maxInstances: 5 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") { res.set("Allow", "GET, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    try {
      const admin = await requireNexaPharmacyAdmin(req, "admin-pharmacy-inventory-alerts", 60);
      res.set("Cache-Control", "no-store, max-age=0");
      const rawCursor = typeof req.query?.cursor === "string" ? req.query.cursor : "";
      if (rawCursor && (!/^[A-Za-z0-9_-]{10,200}$/.test(rawCursor) || rawCursor.includes("/"))) {
        throw new ApiError(400, "invalid-inventory-alert-cursor", "Le repère d’analyse de stock n’est pas valide.");
      }
      const pageSize = 100;
      let query = db.collection("pharmacyProducts").orderBy(FieldPath.documentId());
      if (rawCursor) {
        const cursor = await db.collection("pharmacyProducts").doc(rawCursor).get();
        if (!cursor.exists) throw new ApiError(400, "invalid-inventory-alert-cursor", "Le repère d’analyse a expiré. Relancez l’analyse.");
        query = query.startAfter(cursor);
      }
      const snapshot = await query.limit(pageSize + 1).get();
      const hasMore = snapshot.docs.length > pageSize;
      const page = snapshot.docs.slice(0, pageSize);
      const now = Date.now();
      const alertCounts = {};
      let totalAlertCount = 0;
      for (const doc of page) {
        const product = doc.data() || {};
        const alerts = inventoryAlerts(doc.id, product, inventoryOf(product, now), now);
        for (const alert of alerts) {
          alertCounts[alert.type] = (alertCounts[alert.type] || 0) + 1;
          totalAlertCount += 1;
        }
      }
      await db.collection("adminAuditLogs").doc().create({
        actorUid: admin.uid,
        action: "pharmacy_inventory_alerts_scanned",
        scannedProductCount: page.length,
        alertCount: totalAlertCount,
        cursorUsed: Boolean(rawCursor),
        createdAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({
        ok: true,
        alertCounts,
        totalAlertCount,
        scannedProducts: page.length,
        nextCursor: hasMore ? page[page.length - 1]?.id || null : null,
        hasMore,
      });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA admin pharmacy inventory alert scan failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "admin-pharmacy-alerts-unavailable", "L’analyse complète des alertes de stock n’est pas disponible.");
    }
  });

  const nexaAdminPharmacyAlerts = onRequest({ region: REGION, maxInstances: 5, timeoutSeconds: 120 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) { res.set("Allow", "GET, POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if (req.method === "POST" && ((Number(req.get("Content-Length")) || 0) > 8_192 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 8_192))) {
      return fail(res, 413, "request-too-large", "La demande d’alerte est trop volumineuse.");
    }

    try {
      const action = req.method === "POST" ? clean(getBody(req)?.action, 30).toUpperCase() : "LIST";
      const admin = await requireNexaPharmacyAdmin(req, action === "ACKNOWLEDGE" ? "admin-pharmacy-alert-acknowledge" : action === "SCAN_PAGE" ? "admin-pharmacy-alert-scan" : "admin-pharmacy-alerts-read", action === "ACKNOWLEDGE" ? 30 : 60);
      res.set("Cache-Control", "no-store, max-age=0");

      if (req.method === "GET") {
        const status = clean(req.query?.status, 30).toUpperCase() || "OPEN";
        if (!["OPEN", "ACKNOWLEDGED", "RESOLVED", "ALL"].includes(status)) {
          throw new ApiError(400, "invalid-pharmacy-alert-status", "Le filtre d’alertes n’est pas valide.");
        }
        const rawCursor = typeof req.query?.cursor === "string" ? req.query.cursor : "";
        if (rawCursor && !/^[a-f0-9]{64}$/.test(rawCursor)) {
          throw new ApiError(400, "invalid-pharmacy-alert-cursor", "Le repère d’alertes n’est pas valide.");
        }
        const alertsRef = db.collection("pharmacyInventoryAlerts");
        let query = status === "ALL" ? alertsRef : alertsRef.where("status", "==", status);
        if (rawCursor) {
          const cursor = await alertsRef.doc(rawCursor).get();
          if (!cursor.exists || (status !== "ALL" && cursor.get("status") !== status)) {
            throw new ApiError(400, "invalid-pharmacy-alert-cursor", "Le repère d’alertes a expiré. Actualisez la liste.");
          }
          query = query.startAfter(cursor);
        }
        const pageSize = 50;
        const snapshot = await query.limit(pageSize + 1).get();
        const hasMore = snapshot.docs.length > pageSize;
        const page = snapshot.docs.slice(0, pageSize);
        const alerts = page.map((doc) => {
          const data = doc.data() || {};
          const details = {};
          for (const key of ["availableStock", "threshold", "stock", "storedStock", "calculatedStock", "quantity", "daysUntilExpiration", "expiryLevel", "configuredThreshold"]) {
            if (Number.isSafeInteger(data[key])) details[key] = data[key];
          }
          for (const key of ["lotNumber", "expirationDate"]) {
            const value = clean(data[key], key === "lotNumber" ? 80 : 30);
            if (value) details[key] = value;
          }
          return {
            id: doc.id,
            type: clean(data.type, 60),
            severity: clean(data.severity, 20),
            status: clean(data.status, 20),
            productId: clean(data.productId, 200),
            productName: clean(data.productName, 180),
            details,
            createdAt: isoDate(data.createdAt),
            updatedAt: isoDate(data.updatedAt),
            acknowledgedAt: isoDate(data.acknowledgedAt),
            resolvedAt: isoDate(data.resolvedAt),
          };
        });
        await db.collection("adminAuditLogs").doc().create({
          actorUid: admin.uid,
          action: "pharmacy_inventory_alerts_listed",
          status,
          resultCount: alerts.length,
          cursorUsed: Boolean(rawCursor),
          createdAt: FieldValue.serverTimestamp(),
        });
        return res.status(200).json({ ok: true, status, alerts, nextCursor: hasMore ? page[page.length - 1]?.id || null : null, hasMore });
      }

      const body = getBody(req);
      if (!body || !["ACKNOWLEDGE", "SCAN_PAGE"].includes(action)) {
        throw new ApiError(400, "invalid-pharmacy-alert-action", "L’action sur les alertes n’est pas valide.");
      }

      if (action === "ACKNOWLEDGE") {
        const alertId = clean(body.alertId, 64);
        if (!/^[a-f0-9]{64}$/.test(alertId)) throw new ApiError(400, "invalid-pharmacy-alert-id", "L’identifiant de l’alerte n’est pas valide.");
        const ref = db.collection("pharmacyInventoryAlerts").doc(alertId);
        const auditRef = db.collection("adminAuditLogs").doc();
        const result = await db.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(ref);
          if (!snapshot.exists) throw new ApiError(404, "pharmacy-alert-not-found", "Alerte introuvable.");
          const currentStatus = clean(snapshot.get("status"), 20).toUpperCase();
          if (currentStatus === "ACKNOWLEDGED") return { alreadyAcknowledged: true };
          if (currentStatus !== "OPEN") throw new ApiError(409, "pharmacy-alert-not-open", "Seule une alerte active peut être acquittée.");
          transaction.update(ref, {
            status: "ACKNOWLEDGED",
            acknowledgedByUid: admin.uid,
            acknowledgedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          transaction.create(auditRef, {
            actorUid: admin.uid,
            action: "pharmacy_inventory_alert_acknowledged",
            alertId,
            createdAt: FieldValue.serverTimestamp(),
          });
          return { alreadyAcknowledged: false };
        });
        return res.status(200).json({ ok: true, alertId, status: "ACKNOWLEDGED", ...result });
      }

      const rawCursor = typeof body.cursor === "string" ? body.cursor : "";
      if (rawCursor && (!/^[A-Za-z0-9_-]{10,200}$/.test(rawCursor) || rawCursor.includes("/"))) {
        throw new ApiError(400, "invalid-inventory-alert-cursor", "Le repère d’analyse de stock n’est pas valide.");
      }
      const productPageSize = 100;
      let productQuery = db.collection("pharmacyProducts").orderBy(FieldPath.documentId());
      if (rawCursor) {
        const cursor = await db.collection("pharmacyProducts").doc(rawCursor).get();
        if (!cursor.exists) throw new ApiError(400, "invalid-inventory-alert-cursor", "Le repère d’analyse a expiré. Relancez l’analyse.");
        productQuery = productQuery.startAfter(cursor);
      }
      const snapshot = await productQuery.limit(productPageSize + 1).get();
      const hasMore = snapshot.docs.length > productPageSize;
      const page = snapshot.docs.slice(0, productPageSize);
      const now = Date.now();
      const alertCounts = {};
      let totalAlertCount = 0;
      let createdAlertCount = 0;
      let reopenedAlertCount = 0;
      let resolvedAlertCount = 0;

      async function syncProductAlerts(productDoc) {
        const product = productDoc.data() || {};
        const currentAlerts = inventoryAlerts(productDoc.id, product, inventoryOf(product, now), now);
        const alertsRef = db.collection("pharmacyInventoryAlerts");
        const existingSnapshot = await alertsRef.where("productId", "==", productDoc.id).get();
        const desiredById = new Map(currentAlerts.map((alert) => [inventoryAlertId(alert), alert]));
        const tasks = [];

        for (const [alertId, alert] of desiredById) {
          const ref = alertsRef.doc(alertId);
          tasks.push(async () => db.runTransaction(async (transaction) => {
            const existing = await transaction.get(ref);
            const previous = existing.data() || {};
            const lastUpdate = Math.max(timestampMillis(previous.lastSeenAt), timestampMillis(previous.updatedAt));
            if (existing.exists && lastUpdate > now) return "stale";
            const oldStatus = clean(previous.status, 20).toUpperCase();
            const reopening = existing.exists && oldStatus === "RESOLVED";
            const details = {
              ...alert,
              source: "INVENTORY",
              lastSeenAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            };
            if (!existing.exists || reopening || !["OPEN", "ACKNOWLEDGED"].includes(oldStatus)) {
              transaction.set(ref, {
                ...details,
                status: "OPEN",
                createdAt: FieldValue.serverTimestamp(),
                ...(reopening ? {
                  reopenedAt: FieldValue.serverTimestamp(),
                  acknowledgedAt: FieldValue.delete(),
                  acknowledgedByUid: FieldValue.delete(),
                  resolvedAt: FieldValue.delete(),
                } : {}),
              }, { merge: true });
              return reopening ? "reopened" : "created";
            }
            transaction.set(ref, details, { merge: true });
            return "updated";
          }));
        }

        for (const existing of existingSnapshot.docs) {
          if (desiredById.has(existing.id) || !["OPEN", "ACKNOWLEDGED"].includes(clean(existing.get("status"), 20).toUpperCase())) continue;
          tasks.push(async () => db.runTransaction(async (transaction) => {
            const latest = await transaction.get(existing.ref);
            if (!latest.exists || Math.max(timestampMillis(latest.get("lastSeenAt")), timestampMillis(latest.get("updatedAt"))) > now) return "unchanged";
            if (!["OPEN", "ACKNOWLEDGED"].includes(clean(latest.get("status"), 20).toUpperCase())) return "unchanged";
            transaction.update(existing.ref, {
              status: "RESOLVED",
              resolvedAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            });
            return "resolved";
          }));
        }

        for (let offset = 0; offset < tasks.length; offset += 25) {
          const outcomes = await Promise.all(tasks.slice(offset, offset + 25).map((task) => task()));
          for (const outcome of outcomes) {
            if (outcome === "created") createdAlertCount += 1;
            else if (outcome === "reopened") reopenedAlertCount += 1;
            else if (outcome === "resolved") resolvedAlertCount += 1;
          }
        }
        for (const alert of currentAlerts) {
          alertCounts[alert.type] = (alertCounts[alert.type] || 0) + 1;
          totalAlertCount += 1;
        }
      }

      for (let offset = 0; offset < page.length; offset += 10) {
        await Promise.all(page.slice(offset, offset + 10).map(syncProductAlerts));
      }

      await db.collection("adminAuditLogs").doc().create({
        actorUid: admin.uid,
        action: "pharmacy_inventory_alerts_reconciled",
        scannedProductCount: page.length,
        alertCount: totalAlertCount,
        createdAlertCount,
        reopenedAlertCount,
        resolvedAlertCount,
        cursorUsed: Boolean(rawCursor),
        createdAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({
        ok: true,
        alertCounts,
        totalAlertCount,
        scannedProducts: page.length,
        createdAlertCount,
        reopenedAlertCount,
        resolvedAlertCount,
        nextCursor: hasMore ? page[page.length - 1]?.id || null : null,
        hasMore,
      });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA admin pharmacy alert operation failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "admin-pharmacy-alerts-unavailable", "Les alertes de stock ne sont pas accessibles.");
    }
  });

  const nexaAdminPharmacyStockMovements = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") { res.set("Allow", "GET, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    try {
      const admin = await requireNexaPharmacyAdmin(req, "admin-pharmacy-stock-movements-read", 60);
      res.set("Cache-Control", "no-store, max-age=0");
      const rawCursor = typeof req.query?.cursor === "string" ? req.query.cursor : "";
      if (rawCursor && (!/^[A-Za-z0-9_-]{10,200}$/.test(rawCursor) || rawCursor.includes("/"))) throw new ApiError(400, "invalid-stock-movement-cursor", "Le repère des mouvements n’est pas valide.");
      let query = db.collection("pharmacyStockMovements").orderBy("createdAt", "desc");
      if (rawCursor) {
        const cursor = await db.collection("pharmacyStockMovements").doc(rawCursor).get();
        if (!cursor.exists) throw new ApiError(400, "invalid-stock-movement-cursor", "Le repère des mouvements a expiré. Actualisez la liste.");
        query = query.startAfter(cursor);
      }
      const pageSize = 30;
      const snapshot = await query.limit(pageSize + 1).get();
      const hasMore = snapshot.docs.length > pageSize;
      const page = snapshot.docs.slice(0, pageSize);
      const movements = page.map((doc) => {
        const data = doc.data() || {};
        return {
          id: doc.id,
          productId: clean(data.productId, 200),
          orderId: clean(data.orderId, 200),
          lotNumber: clean(data.lotNumber, 80),
          movementType: clean(data.movementType, 48),
          direction: clean(data.direction, 16),
          quantity: Number.isSafeInteger(data.quantity) ? data.quantity : 0,
          actorUid: clean(data.actorUid, 128),
          reason: clean(data.reason, 120),
          createdAt: isoDate(data.createdAt),
        };
      });
      await db.collection("adminAuditLogs").doc().create({ actorUid: admin.uid, action: "pharmacy_stock_movements_listed", resultCount: movements.length, cursorUsed: Boolean(rawCursor), createdAt: FieldValue.serverTimestamp() });
      return res.status(200).json({ ok: true, movements, nextCursor: hasMore ? page[page.length - 1]?.id || null : null, hasMore });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA admin pharmacy stock movements failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "admin-pharmacy-movements-unavailable", "Les mouvements de stock pharmacie ne sont pas accessibles.");
    }
  });

  const nexaAdminPharmacyOrders = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > MAX_ORDER_REQUEST_BYTES || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > MAX_ORDER_REQUEST_BYTES)) {
      return fail(res, 413, "request-too-large", "La demande de commande dépasse la taille autorisée.");
    }
    try {
      const admin = await requireNexaPharmacyAdmin(req, "admin-pharmacy-orders", 30);
      const body = getBody(req);
      if (!body || Object.keys(body).some((key) => !["action", "cursor", "orderId"].includes(key))) {
        throw new ApiError(400, "invalid-pharmacy-order-request", "La demande de commande n’est pas valide.");
      }
      const action = clean(body.action, 20).toUpperCase();
      if (!new Set(["LIST", "DETAIL"]).has(action)) throw new ApiError(400, "invalid-pharmacy-order-action", "L’action demandée n’est pas valide.");
      if ((action === "LIST" && body.orderId !== undefined) || (action === "DETAIL" && body.cursor !== undefined)) {
        throw new ApiError(400, "invalid-pharmacy-order-request", "Les champs ne correspondent pas à l’action demandée.");
      }
      res.set("Cache-Control", "no-store, max-age=0");

      if (action === "LIST") {
        const cursorId = clean(body.cursor, 200);
        if (body.cursor !== undefined && (!/^[A-Za-z0-9_-]{10,200}$/.test(cursorId) || cursorId.includes("/"))) {
          throw new ApiError(400, "invalid-pharmacy-order-cursor", "Le repère de pagination n’est pas valide.");
        }
        let query = db.collection("nexaOrders").where("kind", "==", "pharmacy").orderBy("createdAt", "desc");
        if (cursorId) {
          const cursor = await db.collection("nexaOrders").doc(cursorId).get();
          if (!cursor.exists || cursor.get("kind") !== "pharmacy" || !cursor.get("createdAt")) {
            throw new ApiError(400, "invalid-pharmacy-order-cursor", "Le repère ne correspond pas à cette file. Actualisez les commandes.");
          }
          query = query.startAfter(cursor);
        }
        const snapshot = await query.limit(ORDER_PAGE_SIZE + 1).get();
        const hasMore = snapshot.docs.length > ORDER_PAGE_SIZE;
        const page = snapshot.docs.slice(0, ORDER_PAGE_SIZE);
        const orders = page.map((document) => {
          const order = document.data() || {};
          const amount = safeAmount(order.amount);
          const transactionFee = safeAmount(order.transactionFee);
          return {
            id: document.id,
            orderNumber: clean(order.orderNumber, 80) || `NMC-PH-${document.id.slice(-8).toUpperCase()}`,
            providerName: clean(order.providerName, 120) || "Pharmacie NEXA",
            status: clean(order.status, 50) || "UNKNOWN",
            paymentStatus: clean(order.paymentStatus, 40) || "UNKNOWN",
            settlementStatus: clean(order.settlementStatus, 40) || "UNKNOWN",
            paymentMethod: clean(order.paymentMethod, 30) || "UNKNOWN",
            deliveryMethod: ["pickup", "delivery"].includes(order.deliveryMethod) ? order.deliveryMethod : "unknown",
            itemCount: Array.isArray(order.items) ? order.items.length : 0,
            requiresPrescription: Boolean(order.prescriptionId),
            amount,
            subtotal: safeAmount(order.subtotal ?? order.amount),
            transactionFee,
            totalAmount: safeAmount(order.totalAmount, 20_000_000) || amount + transactionFee,
            deliveryFee: safeAmount(order.deliveryFee, 100_000),
            currency: clean(order.currency, 8) || "HTG",
            refundRequired: order.refundRequired === true,
            refundStatus: clean(order.refundStatus, 40),
            refundMethod: clean(order.refundMethod, 40),
            requestedRefundMethod: clean(order.requestedRefundMethod, 40),
            createdAt: isoDate(order.createdAt),
          };
        });
        await db.collection("adminAuditLogs").doc().create({
          actorUid: admin.uid,
          action: "pharmacy_orders_listed",
          resultCount: orders.length,
          cursorUsed: Boolean(cursorId),
          createdAt: FieldValue.serverTimestamp(),
        });
        return res.status(200).json({ ok: true, orders, hasMore, nextCursor: hasMore && page.length ? page[page.length - 1].id : null });
      }

      const orderId = clean(body.orderId, 200);
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(orderId)) throw new ApiError(400, "invalid-pharmacy-order-id", "La référence de commande n’est pas valide.");
      const orderRef = db.collection("nexaOrders").doc(orderId);
      const orderSnapshot = await orderRef.get();
      if (!orderSnapshot.exists || orderSnapshot.get("kind") !== "pharmacy") throw new ApiError(404, "pharmacy-order-not-found", "La commande pharmacie est introuvable.");
      const order = orderSnapshot.data() || {};
      const linkedPrescriptionId = clean(order.prescriptionId, 200);
      const hasRequiredPrescriptionItems = Array.isArray(order.items) && order.items.some((item) => item && item.prescriptionRequired === true);
      const prescriptionRefValid = /^[A-Za-z0-9_-]{10,200}$/.test(linkedPrescriptionId);
      const prescriptionPromise = hasRequiredPrescriptionItems && prescriptionRefValid
        ? db.collection("clinicalPrescriptions").doc(linkedPrescriptionId).get()
        : Promise.resolve(null);
      const [historySnapshot, prescriptionSnapshot] = await Promise.all([
        db.collection("nexaOrderEvents")
          .where("orderId", "==", orderId)
          .orderBy("createdAt", "desc")
          .limit(50)
          .get(),
        prescriptionPromise,
      ]);
      const prescriptionAudit = pharmacyPrescriptionAudit({
        ...order,
        prescriptionStatus: prescriptionSnapshot?.exists ? clean(prescriptionSnapshot.get("status"), 24).toUpperCase() : "UNKNOWN",
      }, prescriptionSnapshot);
      const history = historySnapshot.docs.map((document) => {
        const event = document.data() || {};
        const actorUid = clean(event.actorUid, 128);
        return {
          id: document.id,
          action: clean(event.action, 60),
          fromStatus: clean(event.fromStatus, 50),
          toStatus: clean(event.toStatus, 50),
          actorType: actorUid.startsWith("system:") ? "NEXA" : actorUid && actorUid === clean(order.providerUid, 128) ? "Pharmacie" : actorUid && actorUid === clean(order.patientUid, 128) ? "Patient" : "Administration NEXA",
          createdAt: isoDate(event.createdAt),
        };
      }).sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt))).slice(-50);
      const amount = safeAmount(order.amount);
      const transactionFee = safeAmount(order.transactionFee);
      const items = (Array.isArray(order.items) ? order.items : []).slice(0, 20).flatMap((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const quantity = Number.isSafeInteger(raw.quantity) && raw.quantity >= 1 && raw.quantity <= 20 ? raw.quantity : 0;
        const unitPrice = safeAmount(raw.unitPrice ?? raw.price);
        return [{
          name: clean(raw.name, 180) || "Produit pharmacie",
          dci: clean(raw.dci, 180),
          dosage: clean(raw.dosage, 120),
          pharmaceuticalForm: clean(raw.pharmaceuticalForm, 100),
          quantity,
          unitPrice,
          lineTotal: safeAmount(raw.lineTotal) || unitPrice * quantity,
          prescriptionRequired: raw.prescriptionRequired === true,
        }];
      });
      await db.collection("adminAuditLogs").doc().create({
        actorUid: admin.uid,
        action: "pharmacy_order_detail_viewed",
        resource: orderRef.path,
        itemCount: items.length,
        historyCount: history.length,
        prescriptionAudit: prescriptionAudit.assessment,
        createdAt: FieldValue.serverTimestamp(),
      });
      if (prescriptionSnapshot?.exists) {
        await db.collection("clinicalAuditLogs").doc().create({
          actorUid: admin.uid,
          action: "admin_pharmacy_prescription_link_audited",
          appointmentId: clean(prescriptionSnapshot.get("appointmentId"), 200) || null,
          prescriptionId: linkedPrescriptionId,
          orderId,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      return res.status(200).json({
        ok: true,
        order: {
          id: orderSnapshot.id,
          orderNumber: clean(order.orderNumber, 80) || `NMC-PH-${orderSnapshot.id.slice(-8).toUpperCase()}`,
          providerName: clean(order.providerName, 120) || "Pharmacie NEXA",
          status: clean(order.status, 50) || "UNKNOWN",
          paymentStatus: clean(order.paymentStatus, 40) || "UNKNOWN",
          settlementStatus: clean(order.settlementStatus, 40) || "UNKNOWN",
          paymentMethod: clean(order.paymentMethod, 30) || "UNKNOWN",
          deliveryMethod: ["pickup", "delivery"].includes(order.deliveryMethod) ? order.deliveryMethod : "unknown",
          deliveryDepartment: clean(order.deliveryAddress?.department, 80),
          deliveryCommune: clean(order.deliveryAddress?.commune, 80),
          items,
          amount,
          subtotal: safeAmount(order.subtotal ?? order.amount),
          transactionFee,
          totalAmount: safeAmount(order.totalAmount, 20_000_000) || amount + transactionFee,
          deliveryFee: safeAmount(order.deliveryFee, 100_000),
          currency: clean(order.currency, 8) || "HTG",
          refundRequired: order.refundRequired === true,
          refundStatus: clean(order.refundStatus, 40),
          refundMethod: clean(order.refundMethod, 40),
          requestedRefundMethod: clean(order.requestedRefundMethod, 40),
          createdAt: isoDate(order.createdAt),
          updatedAt: isoDate(order.updatedAt),
        },
        prescriptionAudit,
        history,
      });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA admin pharmacy orders failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "admin-pharmacy-orders-unavailable", "Les commandes pharmacie ne sont pas accessibles.");
    }
  });

  const nexaAdminPharmacyReport = onRequest({ region: REGION, maxInstances: 5 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") { res.set("Allow", "GET, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    try {
      const admin = await requireNexaPharmacyAdmin(req, "admin-pharmacy-report", 20);
      const fromValue = typeof req.query?.from === "string" ? req.query.from : "";
      const toValue = typeof req.query?.to === "string" ? req.query.to : "";
      const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      const fromMs = Date.parse(fromValue);
      const toMs = Date.parse(toValue);
      const maxRangeMs = 31 * 24 * 60 * 60 * 1000;
      if (!isoUtc.test(fromValue) || !isoUtc.test(toValue) || !Number.isFinite(fromMs) || !Number.isFinite(toMs) ||
        toMs <= fromMs || toMs - fromMs > maxRangeMs) {
        throw new ApiError(400, "invalid-pharmacy-report-period", "Choisissez une période valide de 31 jours maximum.");
      }

      res.set("Cache-Control", "no-store, max-age=0");
      const snapshot = await db.collection("nexaOrders")
        .where("kind", "==", "pharmacy")
        .where("createdAt", ">=", new Date(fromMs))
        .where("createdAt", "<=", new Date(toMs))
        .orderBy("createdAt", "desc")
        .limit(2_001)
        .get();
      if (snapshot.docs.length > 2_000) {
        throw new ApiError(400, "pharmacy-report-period-too-large", "Cette période contient trop de commandes. Réduisez la plage de dates.");
      }

      const statusCounts = {};
      const paymentStatusCounts = {};
      const paymentMethodCounts = {};
      const deliveryMethodCounts = {};
      let confirmedPaymentCount = 0;
      let serviceAmountMinor = 0;
      let transactionFeeMinor = 0;
      let totalChargedMinor = 0;
      let refundedServiceAmountMinor = 0;
      const refundMethodCounts = {};
      for (const document of snapshot.docs) {
        const order = document.data() || {};
        const status = clean(order.status, 48).toUpperCase() || "UNKNOWN";
        const paymentStatus = clean(order.paymentStatus, 40).toUpperCase() || "UNKNOWN";
        const paymentMethod = clean(order.paymentMethod, 24).toUpperCase() || "UNKNOWN";
        const deliveryMethod = clean(order.deliveryMethod, 24).toLowerCase() || "UNKNOWN";
        statusCounts[status] = (statusCounts[status] || 0) + 1;
        paymentStatusCounts[paymentStatus] = (paymentStatusCounts[paymentStatus] || 0) + 1;
        paymentMethodCounts[paymentMethod] = (paymentMethodCounts[paymentMethod] || 0) + 1;
        deliveryMethodCounts[deliveryMethod] = (deliveryMethodCounts[deliveryMethod] || 0) + 1;
        if (["PAID", "REFUNDED"].includes(paymentStatus)) {
          const serviceAmount = Number.isSafeInteger(order.amount) && order.amount > 0 ? order.amount : 0;
          const fee = Number.isSafeInteger(order.transactionFee) && order.transactionFee >= 0 ? order.transactionFee : 0;
          const total = Number.isSafeInteger(order.totalAmount) && order.totalAmount >= serviceAmount + fee
            ? order.totalAmount
            : serviceAmount + fee;
          confirmedPaymentCount += 1;
          serviceAmountMinor += serviceAmount * 100;
          transactionFeeMinor += fee * 100;
          totalChargedMinor += total * 100;
          if (order.refundStatus === "COMPLETED") {
            const refundAmount = Number.isSafeInteger(order.refundedAmount) && order.refundedAmount > 0 ? order.refundedAmount : 0;
            const refundMethod = clean(order.refundMethod, 32).toUpperCase() || "UNSPECIFIED";
            refundedServiceAmountMinor += refundAmount * 100;
            refundMethodCounts[refundMethod] = (refundMethodCounts[refundMethod] || 0) + 1;
          }
        }
      }

      const report = {
        period: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
        orderCount: snapshot.size,
        confirmedPaymentCount,
        statusCounts,
        paymentStatusCounts,
        paymentMethodCounts,
        deliveryMethodCounts,
        refundMethodCounts,
        grossServiceAmount: Math.floor(serviceAmountMinor / 100),
        transactionFeesForNexaris: Math.floor(transactionFeeMinor / 100),
        grossTotalCharged: Math.floor(totalChargedMinor / 100),
        refundedServiceAmount: Math.floor(refundedServiceAmountMinor / 100),
        currency: "HTG",
        accountingNote: "Les paiements confirmés montrent les montants initiaux; les remboursements du prix du service sont affichés séparément. Les frais de transaction restent séparés. Aucune commission ni somme due aux partenaires n’est calculée.",
      };
      await db.collection("adminAuditLogs").doc().create({
        actorUid: admin.uid,
        action: "pharmacy_operational_report_viewed",
        periodFrom: new Date(fromMs),
        periodTo: new Date(toMs),
        orderCount: report.orderCount,
        createdAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ ok: true, report });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA admin pharmacy report failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "admin-pharmacy-report-unavailable", "Le rapport pharmacie n’est pas accessible.");
    }
  });

  return { nexaAdminPharmacyProducts, nexaAdminPharmacyInventory, nexaAdminPharmacyInventoryAlerts, nexaAdminPharmacyAlerts, nexaAdminPharmacyStockMovements, nexaAdminPharmacyOrders, nexaAdminPharmacyReport };
};
