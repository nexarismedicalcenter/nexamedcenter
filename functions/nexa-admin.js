"use strict";

const { createHash } = require("node:crypto");
const { FieldPath, Timestamp } = require("firebase-admin/firestore");
const { onRequest } = require("firebase-functions/v2/https");

const REFUNDABLE_TYPES = new Set(["appointment", "pharmacy-order", "laboratory-order", "imaging-order", "nursing-order"]);
const ORDER_KINDS = { "pharmacy-order": "pharmacy", "laboratory-order": "laboratory", "imaging-order": "imaging", "nursing-order": "nursing" };
const ORDER_RESOURCES = new Set(Object.keys(ORDER_KINDS));
const NURSING_SETTINGS_PATH = "nexaHomeCareSettings/nursing";
const TRANSACTION_FEE_SETTINGS_PATH = "nexaPaymentSettings/transactionFees";
const TRANSACTION_FEE_SERVICE_TYPES = ["teleconsultation", "home_visit", "nursing_care", "pharmacy", "laboratory", "imaging"];
const PROFESSIONAL_COMMISSION_SETTINGS_PATH = "nexaPaymentSettings/professionalCommissions";
const PROFESSIONAL_COMMISSION_SERVICE_TYPES = ["teleconsultation", "doctor_appointment", "home_visit", "nursing_care", "pharmacy", "laboratory", "imaging"];
const NURSING_PERIODS = ["DAY", "NIGHT", "WEEKEND"];
const ADMIN_REVIEW_PAGE_SIZE = 50;
const NURSING_BOOKING_MODES = new Set(["ONE_VISIT", "MULTIPLE_VISITS", "COORDINATE_AFTER_BOOKING"]);
const NURSING_PHOTO_CONSENT_VERSION = "nexa-nursing-photo-v1";
const DOCTOR_PHOTO_CONSENT_VERSION = "nexa-doctor-photo-v1";
const NURSING_SERVICE_IDS = new Set([
  "vital_signs", "medication_administration", "wound_care", "sample_collection", "postoperative_care",
  "chronic_care", "elderly_assistance", "hygiene_comfort", "medical_devices", "therapeutic_education", "palliative_care",
]);
const NURSING_QUALIFICATIONS = new Set([
  "general_nursing", "intensive_care", "geriatrics", "pediatrics", "palliative_care", "community_health", "anesthesia", "instrumentation",
]);
const DEFAULT_NURSING_PERIOD_RULES = {
  DAY: { daysOfWeek: [1, 2, 3, 4, 5], startTime: "08:00", endTime: "16:00", endDayOffset: 0 },
  NIGHT: { daysOfWeek: [1, 2, 3, 4, 5], startTime: "16:00", endTime: "08:00", endDayOffset: 1 },
  WEEKEND: { daysOfWeek: [6], startTime: "08:00", endTime: "08:00", endDayOffset: 2 },
};

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function refundLedgerId(resourceType, resourceId) {
  return hash("NEXA_REFUND:" + resourceType + ":" + resourceId);
}

function walletLedgerId(resourceType, resourceId) {
  return hash("NEXA_WALLET_REFUND:" + resourceType + ":" + resourceId);
}

function paymentMatches(source, payment) {
  const serviceAmount = Number(source.amount);
  const feeAmount = Number(source.transactionFee ?? 0);
  const totalAmount = Number(source.totalAmount ?? serviceAmount);
  const paymentAmount = Number(payment.amount);
  const paymentServiceAmount = Number(payment.serviceAmount ?? payment.resourceAmount ?? paymentAmount);
  const paymentFeeAmount = Number(payment.transactionFee ?? 0);
  return Number.isSafeInteger(serviceAmount) && serviceAmount >= 0 && Number.isSafeInteger(feeAmount) && feeAmount >= 0 &&
    Number.isSafeInteger(totalAmount) && totalAmount === serviceAmount + feeAmount && paymentAmount === totalAmount &&
    paymentServiceAmount === serviceAmount && paymentFeeAmount === feeAmount;
}

function dateIso(value) {
  return value && typeof value.toDate === "function" ? value.toDate().toISOString() : null;
}

function appointmentIso(value) {
  if (value && typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  return null;
}

function decodeAdminCursor(value) {
  if (!value) return null;
  if (typeof value !== "string" || value.length > 512) {
    throw new Error("invalid-admin-appointment-cursor");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Number.isSafeInteger(parsed.seconds) || !Number.isSafeInteger(parsed.nanoseconds) ||
      parsed.nanoseconds < 0 || parsed.nanoseconds >= 1_000_000_000 ||
      typeof parsed.id !== "string" || !parsed.id || parsed.id.includes("/") || parsed.id.length > 128) {
      throw new Error("invalid cursor");
    }
    return { seconds: parsed.seconds, nanoseconds: parsed.nanoseconds, id: parsed.id };
  } catch {
    throw new Error("invalid-admin-appointment-cursor");
  }
}

function encodeAdminCursor(timestamp, id) {
  return Buffer.from(JSON.stringify({ seconds: timestamp.seconds, nanoseconds: timestamp.nanoseconds, id }), "utf8").toString("base64url");
}

function cleanString(value, maximum) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function diagnosticProfileRevision(profile) {
  const source = profile && typeof profile === "object" && !Array.isArray(profile) ? profile : {};
  return hash(JSON.stringify({
    name: cleanString(source.name, 160),
    address: cleanString(source.address, 200),
    department: cleanString(source.department, 80),
    commune: cleanString(source.commune, 80),
    publicPhone: cleanString(source.publicPhone, 30),
    services: Array.isArray(source.services) ? source.services.map((service) => cleanString(service, 100)).filter(Boolean).slice(0, 12) : [],
    openingHours: cleanString(source.openingHours, 300),
  }));
}

function cleanNursingText(value, maximum) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maximum) : "";
}

function pharmacyLocalDate(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Port-au-Prince", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validPharmacyDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function pharmacyInventory(product, now = Date.now()) {
  const today = pharmacyLocalDate(now);
  const lots = (Array.isArray(product?.lots) ? product.lots : []).map((raw) => {
    const lot = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
    const expirationDate = typeof lot.expirationDate === "string" ? lot.expirationDate.trim() : "";
    let expired = false;
    if (/^\d{4}-\d{2}-\d{2}$/.test(expirationDate)) expired = !validPharmacyDate(expirationDate) || expirationDate < today;
    else {
      const expiry = Date.parse(expirationDate);
      expired = !Number.isFinite(expiry) || expiry < now;
    }
    if (String(lot.status || "ACTIVE").toUpperCase() === "ACTIVE" && expired) lot.status = "EXPIRED";
    lot.lotNumber = cleanNursingText(lot.lotNumber, 80);
    lot.quantityAvailable = Number.isSafeInteger(lot.quantityAvailable) && lot.quantityAvailable >= 0 && lot.quantityAvailable <= 1_000_000 ? lot.quantityAvailable : 0;
    lot.reservedQuantity = Number.isSafeInteger(lot.reservedQuantity) && lot.reservedQuantity >= 0 && lot.reservedQuantity <= 1_000_000 ? lot.reservedQuantity : 0;
    lot.quantityReceived = Number.isSafeInteger(lot.quantityReceived) && lot.quantityReceived > 0 && lot.quantityReceived <= 1_000_000 ? lot.quantityReceived : 0;
    return lot;
  });
  const stock = lots.reduce((sum, lot) => sum + (String(lot.status).toUpperCase() === "ACTIVE" ? lot.quantityAvailable : 0), 0);
  const reservedStock = lots.reduce((sum, lot) => sum + lot.reservedQuantity, 0);
  return { lots, stock, reservedStock, availableStock: lots.reduce((sum, lot) => sum + (String(lot.status).toUpperCase() === "ACTIVE" ? Math.max(0, lot.quantityAvailable - lot.reservedQuantity) : 0), 0) };
}

function normalizeTransactionFeePolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.active !== "boolean") return null;
  const rateBps = Number(value.rateBps);
  if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > 10_000) return null;
  return { active: value.active, rateBps };
}

function normalizeTransactionFeeInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.active !== "boolean") return null;
  if (typeof value.percentage !== "number" && !(typeof value.percentage === "string" && value.percentage.trim())) return null;
  const percentage = Number(value.percentage);
  const hundredths = Math.round(percentage * 100);
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100 || Math.abs(percentage * 100 - hundredths) > 1e-7) return null;
  return { active: value.active, rateBps: hundredths };
}

function normalizeProfessionalCommissionRate(value) {
  if (value === null || value === undefined || value === "") return null;
  const percentage = typeof value === "number" || (typeof value === "string" && value.trim()) ? Number(value) : NaN;
  const rateBps = Math.round(percentage * 100);
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100 || Math.abs(percentage * 100 - rateBps) > 1e-7) return undefined;
  return rateBps;
}

function professionalCommissionRateView(raw) {
  const rateBps = Number(raw?.rateBps);
  if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    return { configured: false, percentage: null, rateBps: null };
  }
  return { configured: true, percentage: rateBps / 100, rateBps };
}

function transactionFeeView(policy, configured) {
  return { ...policy, percentage: policy.rateBps / 100, recipient: "NEXARIS", configured };
}

function normalizeNursingTariff(value) {
  if (value === null || value === undefined || value === "") return null;
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 && amount <= 10_000_000 ? amount : null;
}

function normalizeNursingZones(value) {
  if (!Array.isArray(value) || value.length > 200) return null;
  const result = [];
  const ids = new Set();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const id = cleanNursingText(raw.id, 40);
    const department = cleanNursingText(raw.department, 80);
    const commune = cleanNursingText(raw.commune, 80);
    if (!/^[a-zA-Z0-9-]{8,40}$/.test(id) || !department || !commune || ids.has(id)) return null;
    const tariffs = raw.tariffs && typeof raw.tariffs === "object" && !Array.isArray(raw.tariffs) ? raw.tariffs : {};
    for (const period of NURSING_PERIODS) {
      const valueForPeriod = tariffs[period];
      if (valueForPeriod !== null && valueForPeriod !== undefined && valueForPeriod !== "" && normalizeNursingTariff(valueForPeriod) === null) return null;
    }
    ids.add(id);
    result.push({
      id,
      department,
      commune,
      active: raw.active !== false,
      tariffs: Object.fromEntries(NURSING_PERIODS.map((period) => [period, normalizeNursingTariff(tariffs[period])])),
    });
  }
  return result;
}

function normalizeNursingPeriodRules(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const result = {};
  for (const period of NURSING_PERIODS) {
    const rule = value[period];
    if (!rule || typeof rule !== "object" || Array.isArray(rule) || !Array.isArray(rule.daysOfWeek) ||
      rule.daysOfWeek.length < 1 || rule.daysOfWeek.length > 7 ||
      rule.daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
      new Set(rule.daysOfWeek).size !== rule.daysOfWeek.length ||
      typeof rule.startTime !== "string" || !timePattern.test(rule.startTime) ||
      typeof rule.endTime !== "string" || !timePattern.test(rule.endTime) ||
      !Number.isInteger(rule.endDayOffset) || rule.endDayOffset < 0 || rule.endDayOffset > 2 ||
      (rule.endDayOffset === 0 && rule.endTime <= rule.startTime)) return null;
    result[period] = {
      daysOfWeek: [...rule.daysOfWeek].sort((left, right) => left - right),
      startTime: rule.startTime,
      endTime: rule.endTime,
      endDayOffset: rule.endDayOffset,
    };
  }
  return result;
}

function configuredNursingSettings(raw) {
  const zones = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.zones : [];
  return normalizeNursingZones(zones) || [];
}

function configuredNursingPeriodRules(raw) {
  const rules = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.periodRules : null;
  return normalizeNursingPeriodRules(rules) || DEFAULT_NURSING_PERIOD_RULES;
}

function normalizeNursingServiceProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const year = Number(value.experienceStartYear);
  const serviceIds = Array.isArray(value.serviceIds) ? value.serviceIds : [];
  const zoneIds = Array.isArray(value.zoneIds) ? value.zoneIds : [];
  const weeks = Array.isArray(value.weeklyAvailability) ? value.weeklyAvailability : [];
  const currentYear = new Date().getUTCFullYear();
  if (!Number.isSafeInteger(year) || year < 1950 || year > currentYear || serviceIds.length < 1 || serviceIds.length > NURSING_SERVICE_IDS.size ||
    serviceIds.some((id) => typeof id !== "string" || !NURSING_SERVICE_IDS.has(id)) || new Set(serviceIds).size !== serviceIds.length ||
    zoneIds.length < 1 || zoneIds.length > 200 || zoneIds.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9-]{8,40}$/.test(id)) ||
    new Set(zoneIds).size !== zoneIds.length || weeks.length < 1 || weeks.length > 52) return null;
  const weekStarts = new Set();
  const weeklyAvailability = [];
  for (const week of weeks) {
    if (!week || typeof week !== "object" || Array.isArray(week) || typeof week.weekStart !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(week.weekStart) || !Array.isArray(week.periods) || week.periods.length < 1 || week.periods.length > 3) return null;
    const date = new Date(`${week.weekStart}T12:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== week.weekStart || date.getUTCDay() !== 1 ||
      weekStarts.has(week.weekStart) || week.periods.some((period) => !NURSING_PERIODS.includes(period)) || new Set(week.periods).size !== week.periods.length) return null;
    weekStarts.add(week.weekStart);
    weeklyAvailability.push({ weekStart: week.weekStart, periods: [...week.periods] });
  }
  weeklyAvailability.sort((left, right) => left.weekStart.localeCompare(right.weekStart));
  return { experienceStartYear: year, serviceIds: [...serviceIds], zoneIds: [...zoneIds], weeklyAvailability };
}

function nursingProfileIsPublishable(value, zones) {
  const profile = normalizeNursingServiceProfile(value);
  if (!profile) return false;
  const activeZones = new Map(zones.filter((zone) => zone.active).map((zone) => [zone.id, zone]));
  return profile.zoneIds.every((id) => {
    const zone = activeZones.get(id);
    return Boolean(zone && profile.weeklyAvailability.every((week) => week.periods.every((period) => zone.tariffs[period] !== null)));
  });
}

function validNursingProfilePhotoPath(uid, value) {
  return typeof value === "string" &&
    /^nexa-nursing-profile-photos\/[A-Za-z0-9_-]{8,128}\/[a-f0-9]{32}\.jpg$/.test(value) &&
    value.startsWith(`nexa-nursing-profile-photos/${uid}/`);
}

function validDoctorProfilePhotoPath(uid, value) {
  if (typeof uid !== "string" || typeof value !== "string") return false;
  const prefix = `nexa-doctor-profile-photos/${uid}/`;
  const fileName = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  return /^[a-f0-9]{32}\.jpg$/.test(fileName);
}

function getRequestBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from("{}");
  try {
    const body = JSON.parse(rawBody.toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

module.exports = function createNexaAdminFunctions(dependencies) {
  const {
    db,
    FieldValue,
    storage,
    ApiError,
    requireUser,
    requireAppCheckToken,
    enforceUserRateLimit,
    setCors,
    fail,
    logger,
    createNexaNotification,
    appointmentPaymentMatches,
    getTransactionFeePolicy,
  } = dependencies;
  const bucket = storage.bucket(process.env.NEXA_STORAGE_BUCKET || "nexaris-1339d.firebasestorage.app");

  async function requireAdmin(req, action, limit) {
    const user = await requireUser(req);
    await requireAppCheckToken(req);
    const admins = new Set(String(process.env.NEXA_ADMIN_UIDS || "").split(",").map((value) => value.trim()).filter(Boolean));
    if (!admins.size) throw new ApiError(503, "admin-access-not-configured", "L’accès administrateur NEXA n’est pas configuré.");
    if (!admins.has(user.uid)) throw new ApiError(403, "administrator-required", "Accès administrateur requis.");
    await enforceUserRateLimit(user.uid, action, limit, 60_000);
    return user;
  }

  function requestHandler({ methods, action, limit, maxBytes = 8_192 }, handler) {
    return onRequest({ region: "us-east4" }, async (req, res) => {
      if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
      if (req.method === "OPTIONS") return res.status(204).end();
      if (!methods.includes(req.method)) {
        res.set("Allow", [...methods, "OPTIONS"].join(", "));
        return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
      }
      if ((Number(req.get("Content-Length")) || 0) > maxBytes || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > maxBytes)) {
        return fail(res, 413, "request-too-large", "La requête est trop volumineuse.");
      }
      try {
        const admin = await requireAdmin(req, action, limit);
        res.set("Cache-Control", "no-store, max-age=0");
        return await handler(req, res, admin);
      } catch (error) {
        if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
        logger.error("NEXA admin request failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
        return fail(res, 500, "admin-operation-failed", "L’opération d’administration n’a pas abouti.");
      }
    });
  }

  async function readRefundable(resourceType, resourceId) {
    const collection = resourceType === "appointment" ? "appointments" : ORDER_RESOURCES.has(resourceType) ? "nexaOrders" : "";
    if (!collection) throw new ApiError(409, "refund-resource-unsupported", "Cette ressource ne peut pas être remboursée dans NEXA.");
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(resourceId)) throw new ApiError(400, "refund-resource-invalid", "La référence de la ressource n’est pas valide.");
    return { collection, ref: db.collection(collection).doc(resourceId) };
  }

  const WALLET_REFUNDS_PAGE_SIZE = 50;
  const WALLET_REFUNDS_CURSOR_MAX_LENGTH = 1024;

  function parseWalletRefundCursor(value) {
    if (value === undefined) {
      return {
        appointments: { after: null, done: false },
        orders: { after: null, done: false },
      };
    }
    if (typeof value !== "string" || value.length > WALLET_REFUNDS_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new ApiError(400, "invalid-refund-cursor", "Le repère de pagination des remboursements n’est pas valide.");
    }

    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    } catch {
      throw new ApiError(400, "invalid-refund-cursor", "Le repère de pagination des remboursements n’est pas valide.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "appointments,orders") {
      throw new ApiError(400, "invalid-refund-cursor", "Le repère de pagination des remboursements n’est pas valide.");
    }

    const parseStream = (stream) => {
      if (!stream || typeof stream !== "object" || Array.isArray(stream) ||
        Object.keys(stream).sort().join(",") !== "after,done" || typeof stream.done !== "boolean" ||
        (stream.after !== null && (typeof stream.after !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(stream.after)))) {
        throw new ApiError(400, "invalid-refund-cursor", "Le repère de pagination des remboursements n’est pas valide.");
      }
      return { after: stream.after, done: stream.done };
    };
    return { appointments: parseStream(parsed.appointments), orders: parseStream(parsed.orders) };
  }

  function encodeWalletRefundCursor(cursor) {
    if (cursor.appointments.done && cursor.orders.done) return null;
    return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  }

  async function fetchWalletRefundPage(collectionName, state) {
    if (state.done) return { docs: [], state };
    const collection = db.collection(collectionName);
    let query = collection.where("refundRequired", "==", true).orderBy(FieldPath.documentId(), "asc");
    if (state.after) query = query.startAfter(collection.doc(state.after));
    const snapshot = await query.limit(WALLET_REFUNDS_PAGE_SIZE + 1).get();
    const docs = snapshot.docs.slice(0, WALLET_REFUNDS_PAGE_SIZE);
    const lastDoc = docs[docs.length - 1];
    return {
      docs,
      state: {
        after: lastDoc ? lastDoc.id : state.after,
        done: snapshot.docs.length <= WALLET_REFUNDS_PAGE_SIZE,
      },
    };
  }

  async function listWalletRefunds(admin, cursor) {
    const [appointments, orders] = await Promise.all([
      fetchWalletRefundPage("appointments", cursor.appointments),
      fetchWalletRefundPage("nexaOrders", cursor.orders),
    ]);
    const refunds = [
      ...appointments.docs.flatMap((doc) => {
        const data = doc.data() || {};
        const paymentConflictNeedsReview = data.status === "PAYMENT_CONFLICT_REFUND_REQUIRED";
        const unacceptedTeleconsultationNeedsReview = data.status === "PROVIDER_NO_SHOW_REFUND_REQUIRED" &&
          data.providerType === "doctor" && data.bookingType === "teleconsultation" && data.refundStatus === "PENDING_REVIEW" &&
          data.settlementStatus === "REVIEW_REQUIRED" && data.noShowOutcome === "PROVIDER_UNRESPONSIVE" &&
          data.noShowTriggeredBy === "scheduler" && data.noShowReason === "PROVIDER_DID_NOT_ACCEPT";
        if ((!paymentConflictNeedsReview && !unacceptedTeleconsultationNeedsReview) || data.paymentStatus !== "PAID" || data.requestedRefundMethod === "CASH_MANUAL" ||
          ![undefined, "PENDING_REVIEW", "MANUAL_REVIEW_REQUIRED"].includes(data.refundStatus)) return [];
        return [{
          resourceType: "appointment",
          resourceId: doc.id,
          providerName: cleanString(data.providerName, 120) || "Professionnel NEXA",
          amount: Number.isSafeInteger(data.amount) && data.amount > 0 ? data.amount : 0,
          currency: cleanString(data.currency, 8) || "HTG",
          transactionFee: Number.isSafeInteger(data.transactionFee) && data.transactionFee > 0 ? data.transactionFee : 0,
          reason: unacceptedTeleconsultationNeedsReview
            ? "Téléconsultation payée non acceptée · examen NEXA requis"
            : cleanString(data.cancellationReason, 48) || "REFUND_REVIEW_REQUIRED",
          createdAt: dateIso(data.updatedAt || data.createdAt),
        }];
      }),
      ...orders.docs.flatMap((doc) => {
        const data = doc.data() || {};
        const resourceType = data.kind === "pharmacy" ? "pharmacy-order" : data.kind === "laboratory" ? "laboratory-order" : data.kind === "imaging" ? "imaging-order" : data.kind === "nursing" ? "nursing-order" : "";
        const providerRefused = data.status === "PROVIDER_REFUSED" && data.settlementStatus === "CONFIRMED";
        const paymentNeedsReview = data.status === "PAYMENT_REVIEW_REQUIRED" && data.settlementStatus === "REVIEW_REQUIRED";
        if (!resourceType || (!providerRefused && !paymentNeedsReview) || data.paymentStatus !== "PAID" || data.refundRequired !== true || data.requestedRefundMethod === "CASH_MANUAL" ||
          ![undefined, "PENDING_REVIEW"].includes(data.refundStatus)) return [];
        return [{
          resourceType,
          resourceId: doc.id,
          providerName: cleanString(data.providerName, 120) || (resourceType === "nursing-order" ? "Professionnel infirmier NEXA" : "Partenaire NEXA"),
          amount: Number.isSafeInteger(data.amount) && data.amount > 0 ? data.amount : 0,
          currency: cleanString(data.currency, 8) || "HTG",
          transactionFee: Number.isSafeInteger(data.transactionFee) && data.transactionFee > 0 ? data.transactionFee : 0,
          reason: paymentNeedsReview ? cleanString(data.refundReviewReason, 160) || "PAYMENT_REVIEW_REQUIRED" : cleanString(data.refusalReason, 160) || "PROVIDER_REFUSED",
          createdAt: dateIso(data.updatedAt || data.createdAt),
        }];
      }),
    ].filter((item) => item.amount > 0 && item.currency.toUpperCase() === "HTG")
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));

    const nextCursor = {
      appointments: appointments.state,
      orders: orders.state,
    };
    const hasMore = !(nextCursor.appointments.done && nextCursor.orders.done);
    await db.collection("adminAuditLogs").doc().create({
      actorUid: admin.uid,
      action: "admin_pending_wallet_refunds_listed",
      resultCount: refunds.length,
      hasMore,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { refunds, nextCursor: encodeWalletRefundCursor(nextCursor), hasMore };
  }

  const PAYMENT_ALERTS_PAGE_SIZE = 50;

  function parsePaymentAlertCursor(value) {
    if (value === undefined) return { after: null, done: false };
    if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
      throw new ApiError(400, "invalid-payment-alert-cursor", "Le repère de pagination des incidents n’est pas valide.");
    }
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    } catch {
      throw new ApiError(400, "invalid-payment-alert-cursor", "Le repère de pagination des incidents n’est pas valide.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(",") !== "after,done" || typeof parsed.done !== "boolean" ||
      (parsed.after !== null && (typeof parsed.after !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(parsed.after)))) {
      throw new ApiError(400, "invalid-payment-alert-cursor", "Le repère de pagination des incidents n’est pas valide.");
    }
    return { after: parsed.after, done: parsed.done };
  }

  function encodePaymentAlertCursor(cursor) {
    return cursor.done ? null : Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  }

  async function listPaymentSettlementAlerts(admin, cursor) {
    const collection = db.collection("paymentSettlementAlerts");
    let query = collection.where("status", "in", ["open", "in_review"]).orderBy(FieldPath.documentId(), "asc");
    if (cursor.after) query = query.startAfter(collection.doc(cursor.after));
    const snapshot = cursor.done ? null : await query.limit(PAYMENT_ALERTS_PAGE_SIZE + 1).get();
    const docs = snapshot ? snapshot.docs.slice(0, PAYMENT_ALERTS_PAGE_SIZE) : [];
    const lastDoc = docs[docs.length - 1];
    const nextCursor = {
      after: lastDoc ? lastDoc.id : cursor.after,
      done: !snapshot || snapshot.docs.length <= PAYMENT_ALERTS_PAGE_SIZE,
    };
    const alerts = await Promise.all(docs.map(async (doc) => {
      const resourceType = cleanString(doc.get("resourceType"), 40) || "unknown";
      const resourceId = cleanString(doc.get("resourceId"), 200);
      const resourceCollection = resourceType === "appointment" ? "appointments" : ORDER_RESOURCES.has(resourceType) ? "nexaOrders" : "";
      const resource = resourceCollection && /^[A-Za-z0-9_-]{10,200}$/.test(resourceId)
        ? await db.collection(resourceCollection).doc(resourceId).get()
        : null;
      const source = resource?.data() || {};
      return {
        alertId: doc.id,
        resourceType,
        resourceId,
        amount: Number.isSafeInteger(source.amount) && source.amount > 0 ? source.amount : 0,
        currency: cleanString(source.currency, 8) || "HTG",
        transactionFee: Number.isSafeInteger(source.transactionFee) && source.transactionFee > 0 ? source.transactionFee : 0,
        reason: cleanString(doc.get("reason"), 120) || "UNKNOWN",
        status: cleanString(doc.get("status"), 24) || "open",
        requestedRefundMethod: cleanString(doc.get("requestedRefundMethod"), 40),
        createdAt: dateIso(doc.get("createdAt")),
        reviewNote: cleanString(doc.get("reviewNote"), 500),
      };
    }));
    const hasMore = !nextCursor.done;
    await db.collection("adminAuditLogs").doc().create({
      actorUid: admin.uid,
      action: "admin_payment_alerts_listed",
      resultCount: alerts.length,
      hasMore,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { alerts, nextCursor: encodePaymentAlertCursor(nextCursor), hasMore };
  }

  async function creditWalletForRefund({ resourceType, resourceId, adminUid, confirmNoExternalRefund }) {
    if (!confirmNoExternalRefund) throw new ApiError(400, "external-refund-confirmation-required", "Confirmez qu’aucun remboursement externe n’a déjà été effectué.");
    if (!REFUNDABLE_TYPES.has(resourceType)) throw new ApiError(400, "invalid-refund-type", "Le type de remboursement n’est pas pris en charge.");
    const { collection, ref: sourceRef } = await readRefundable(resourceType, resourceId);
    const ledgerId = walletLedgerId(resourceType, resourceId);
    const refundId = refundLedgerId(resourceType, resourceId);
    const ledgerRef = db.collection("nexaWalletLedger").doc(ledgerId);
    const refundRef = db.collection("nexaRefundLedger").doc(refundId);
    const profileRef = db.collection("patientProfiles");
    const walletRefFor = (uid) => db.collection("nexaPatientWallets").doc(uid);
    const auditRef = db.collection("adminAuditLogs").doc();
    const relatedAlertsQuery = db.collection("paymentSettlementAlerts").where("resourceId", "==", resourceId).limit(100);

    const result = await db.runTransaction(async (transaction) => {
      const sourceSnapshot = await transaction.get(sourceRef);
      if (!sourceSnapshot.exists) throw new ApiError(404, "refund-resource-not-found", "Le rendez-vous ou la commande n’existe pas.");
      const source = sourceSnapshot.data() || {};
      const patientUid = typeof source.patientUid === "string" ? source.patientUid : "";
      const paymentRef = typeof source.moncashPaymentRef === "string" ? source.moncashPaymentRef : "";
      if (!patientUid || !/^[A-Za-z0-9_-]{20,64}$/.test(paymentRef)) throw new ApiError(409, "refund-source-invalid", "La ressource ne contient pas de paiement NEXA vérifiable.");
      if (source.requestedRefundMethod === "CASH_MANUAL" || source.refundStatus === "PENDING_MANUAL_CASH") {
        throw new ApiError(409, "cash-refund-requested", "Le patient a demandé des espèces. Traitez uniquement la remise manuelle dans les incidents de paiement.");
      }
      const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
      const walletRef = walletRefFor(patientUid);
      const [ledgerSnapshot, refundSnapshot, profileSnapshot, paymentSnapshot, walletSnapshot, alertsSnapshot] = await Promise.all([
        transaction.get(ledgerRef), transaction.get(refundRef), transaction.get(profileRef.doc(patientUid)),
        transaction.get(paymentRefDoc), transaction.get(walletRef), transaction.get(relatedAlertsQuery),
      ]);
      const relatedAlerts = alertsSnapshot.docs.filter((alert) => alert.get("resourceType") === resourceType);
      if (relatedAlerts.some((alert) => ["manual_refund_confirmed", "manual_cash_refund_confirmed", "manual_moncash_refund_confirmed"].includes(String(alert.get("resolution") || "")))) {
        throw new ApiError(409, "external-refund-already-recorded", "Un remboursement externe est déjà enregistré pour cette ressource.");
      }
      if (refundSnapshot.exists && refundSnapshot.get("refundMethod") !== "NEXA_WALLET") throw new ApiError(409, "external-refund-already-recorded", "Un remboursement externe est déjà enregistré pour cette ressource.");
      if (refundSnapshot.exists !== ledgerSnapshot.exists) throw new ApiError(409, "refund-ledger-conflict", "Les registres de remboursement et de portefeuille ne concordent pas.");

      if (ledgerSnapshot.exists) {
        const prior = ledgerSnapshot.data() || {};
        const priorAmountMinor = Number(prior.amountMinor);
        if (!refundSnapshot.exists || prior.userUid !== patientUid || prior.resourceType !== resourceType || prior.resourceId !== resourceId || prior.currency !== "HTG" || prior.status !== "COMPLETED" ||
          !Number.isSafeInteger(priorAmountMinor) || priorAmountMinor <= 0 || refundSnapshot.get("userUid") !== patientUid || refundSnapshot.get("resourceId") !== resourceId ||
          refundSnapshot.get("refundMethod") !== "NEXA_WALLET" || Number(refundSnapshot.get("amountMinor")) !== priorAmountMinor || refundSnapshot.get("walletLedgerId") !== ledgerId) {
          throw new ApiError(409, "refund-ledger-conflict", "Le registre contient une référence de remboursement incompatible.");
        }
        return { amount: priorAmountMinor / 100, userUid: patientUid, resourceType, alreadyProcessed: true, ledgerId, refundId };
      }

      const amount = Number(source.amount);
      const amountMinor = Math.round(amount * 100);
      const currency = String(source.currency || "").toUpperCase();
      const payment = paymentSnapshot.data() || {};
      const expectedKind = ORDER_KINDS[resourceType];
      const expectedResourcePath = `${collection}/${resourceId}`;
      const unacceptedTeleconsultationNeedsReview = source.status === "PROVIDER_NO_SHOW_REFUND_REQUIRED" &&
        source.providerType === "doctor" && source.bookingType === "teleconsultation" && source.refundStatus === "PENDING_REVIEW" &&
        source.settlementStatus === "REVIEW_REQUIRED" && source.refundRequired === true &&
        source.noShowOutcome === "PROVIDER_UNRESPONSIVE" && source.noShowTriggeredBy === "scheduler" &&
        source.noShowReason === "PROVIDER_DID_NOT_ACCEPT";
      const resourceReady = resourceType === "appointment"
        ? (source.status === "PAYMENT_CONFLICT_REFUND_REQUIRED" && source.refundRequired === true) || unacceptedTeleconsultationNeedsReview
        : source.kind === expectedKind && source.refundRequired === true && (
          (source.status === "PROVIDER_REFUSED" && source.settlementStatus === "CONFIRMED") ||
          (source.status === "PAYMENT_REVIEW_REQUIRED" && source.settlementStatus === "REVIEW_REQUIRED")
        );
      const paymentAmountMatches = resourceType === "appointment" ? appointmentPaymentMatches(source, payment) : paymentMatches(source, payment);
      const paymentReady = profileSnapshot.exists && profileSnapshot.get("role") === "patient" && source.paymentStatus === "PAID" && currency === "HTG" &&
        Number.isSafeInteger(amount) && amount > 0 && amount <= 10_000_000 && Number.isSafeInteger(amountMinor) && amountMinor > 0 &&
        payment.status === "paid" && payment.resourceType === resourceType && payment.resourcePath === expectedResourcePath && payment.uid === patientUid && paymentAmountMatches &&
        String(payment.currency || "").toUpperCase() === "HTG";
      if (!resourceReady || !paymentReady || ![undefined, "", "PENDING_REVIEW", "MANUAL_REVIEW_REQUIRED"].includes(source.refundStatus)) {
        throw new ApiError(409, "refund-not-eligible", "Le paiement ou l’état de la ressource ne permet pas ce crédit Wallet.");
      }
      const wallet = walletSnapshot.data() || {};
      const availableMinor = wallet.availableMinor === undefined ? 0 : Number(wallet.availableMinor);
      const reservedMinor = wallet.reservedMinor === undefined ? 0 : Number(wallet.reservedMinor);
      if (!Number.isSafeInteger(availableMinor) || availableMinor < 0 || !Number.isSafeInteger(reservedMinor) || reservedMinor < 0 ||
        !Number.isSafeInteger(availableMinor + amountMinor) || (wallet.currency && wallet.currency !== "HTG") || (wallet.status && wallet.status !== "ACTIVE")) {
        throw new ApiError(409, "wallet-state-invalid", "Le portefeuille NEXA ne peut pas recevoir ce crédit actuellement.");
      }

      const now = FieldValue.serverTimestamp();
      transaction.set(walletRef, { userUid: patientUid, currency: "HTG", availableMinor: availableMinor + amountMinor, reservedMinor, status: wallet.status || "ACTIVE", updatedAt: now }, { merge: true });
      transaction.create(ledgerRef, {
        userUid: patientUid, walletId: patientUid, type: "REFUND", direction: "CREDIT", amountMinor, currency: "HTG",
        resourceType, resourceId, paymentRef, reason: resourceType === "appointment"
          ? unacceptedTeleconsultationNeedsReview ? "unaccepted-teleconsultation-admin-review" : "appointment-refund-review-approved"
          : resourceType === "nursing-order" ? "nursing-payment-review-refund" : "provider-refused-order-refund",
        source: "NEXA_ADMIN", status: "COMPLETED", createdAt: now, createdByUid: adminUid,
      });
      transaction.create(refundRef, {
        userUid: patientUid, resourceType, resourceId, paymentRef, amountMinor, currency: "HTG", refundMethod: "NEXA_WALLET",
        serviceAmountMinor: amountMinor, ...(Number(source.transactionFee) > 0 ? { nonRefundableTransactionFeeMinor: Number(source.transactionFee) * 100 } : {}),
        walletLedgerId: ledgerId, status: "COMPLETED", createdAt: now, createdByUid: adminUid,
      });
      transaction.set(sourceRef, {
        status: "REFUNDED", paymentStatus: "REFUNDED", refundRequired: false, refundStatus: "COMPLETED", refundMethod: "NEXA_WALLET",
        ...(unacceptedTeleconsultationNeedsReview ? { settlementStatus: "REFUNDED_TO_NEXA_WALLET" } : {}),
        refundedAmount: amount, refundedAmountMinor: amountMinor, ...(Number(source.transactionFee) > 0 ? { nonRefundableTransactionFee: Number(source.transactionFee) } : {}),
        refundedAt: now, refundedByUid: adminUid, refundLedgerId: refundId, walletLedgerId: ledgerId, updatedAt: now,
      }, { merge: true });
      if (resourceType === "nursing-order" && /^[A-Za-z0-9_-]{10,200}$/.test(String(source.nursingReviewVisitId || ""))) {
        transaction.set(db.collection("nexaNursingVisits").doc(source.nursingReviewVisitId), {
          status: "REFUNDED", refundedAt: now, updatedAt: now,
        }, { merge: true });
      }
      for (const alert of relatedAlerts.filter((item) => ["open", "in_review"].includes(String(item.get("status"))))) {
        transaction.set(alert.ref, {
          status: "resolved", resolution: "nexa_wallet_credit", resolutionReference: ledgerId,
          reviewNote: "Crédit au portefeuille NEXA; aucun remboursement externe n’a été lancé.", resolvedBy: adminUid, resolvedAt: now,
        }, { merge: true });
      }
      transaction.create(auditRef, { actorUid: adminUid, action: "nexa_wallet_refund_credited", resource: `${collection}/${resourceId}`, amountMinor, currency: "HTG", createdAt: now });
      return { amount, userUid: patientUid, resourceType, alreadyProcessed: false, ledgerId, refundId };
    });

    if (!result.alreadyProcessed) await createNexaNotification(result.userUid, "wallet-refund:" + result.ledgerId, {
      type: "wallet_refund_credited",
      title: "Remboursement crédité",
      body: `Un montant de ${new Intl.NumberFormat("fr-HT").format(result.amount)} HTG, correspondant au ${result.resourceType === "nursing-order" ? "prix total de la période infirmière" : "prix du service"}, a été crédité dans votre portefeuille NEXA. Le frais de transaction initial, s’il y en avait un, n’est pas remboursé. Aucun remboursement externe n’a été lancé.`,
      url: "/espace-patient.html",
    });
    return result;
  }

  const nexaAdminWalletRefunds = requestHandler({ methods: ["GET", "POST"], action: "admin-wallet-refunds", limit: 30 }, async (req, res, admin) => {
    if (req.method === "GET") {
      const cursor = parseWalletRefundCursor(req.query.cursor);
      const result = await listWalletRefunds(admin, cursor);
      return res.status(200).json({ ok: true, ...result });
    }
    const body = getRequestBody(req);
    const resourceType = cleanString(body?.resourceType, 40);
    const resourceId = cleanString(body?.resourceId, 200);
    const confirmNoExternalRefund = body?.confirmNoExternalRefund === true;
    const result = await creditWalletForRefund({ resourceType, resourceId, adminUid: admin.uid, confirmNoExternalRefund });
    return res.status(200).json({ ok: true, amount: result.amount, currency: "HTG", ledgerId: result.ledgerId, refundLedgerId: result.refundId, alreadyProcessed: result.alreadyProcessed });
  });

  const nexaAdminPaymentSettlementAlerts = requestHandler({ methods: ["GET", "POST"], action: "admin-payment-settlement-alerts", limit: 30 }, async (req, res, admin) => {
    if (req.method === "GET") {
      const cursor = parsePaymentAlertCursor(req.query.cursor);
      const result = await listPaymentSettlementAlerts(admin, cursor);
      return res.status(200).json({ ok: true, ...result });
    }

    const body = getRequestBody(req);
    if (!body) throw new ApiError(400, "invalid-request", "La demande de suivi est invalide.");
    const alertId = cleanString(body.alertId, 128);
    const note = cleanString(body.note, 500);
    const refundReference = cleanString(body.refundReference, 120);
    const refundMethod = cleanString(body.refundMethod, 32).toUpperCase();
    const resolve = body.resolve === true;
    if (resolve && !["MONCASH_EXTERNAL", "CASH_MANUAL"].includes(refundMethod)) throw new ApiError(400, "invalid-refund-method", "Choisissez un remboursement MonCash déjà effectué ou des espèces remises manuellement.");
    if (!/^[A-Za-z0-9_-]{10,128}$/.test(alertId) || !note) throw new ApiError(400, "invalid-review", "L’incident et une note de suivi sont requis.");
    if (resolve && !refundReference) throw new ApiError(400, "refund-reference-required", "Une référence ou un reçu doit être enregistré après le remboursement manuel.");

    const alertRef = db.collection("paymentSettlementAlerts").doc(alertId);
    const auditRef = db.collection("adminAuditLogs").doc();
    const outcome = await db.runTransaction(async (transaction) => {
      const alertSnapshot = await transaction.get(alertRef);
      if (!alertSnapshot.exists) throw new ApiError(404, "alert-not-found", "Cet incident n’existe pas.");
      if (alertSnapshot.get("status") === "resolved") {
        if (resolve && alertSnapshot.get("resolutionReference") === refundReference && alertSnapshot.get("refundMethod") === refundMethod) {
          return { userUid: "", amount: 0, notifyPatient: false };
        }
        throw new ApiError(409, "alert-already-resolved", "Cet incident a déjà été clôturé.");
      }
      if (resolve && alertSnapshot.get("requestedRefundMethod") === "CASH_MANUAL" && refundMethod !== "CASH_MANUAL") {
        throw new ApiError(409, "cash-refund-method-mismatch", "Le patient a demandé des espèces. Enregistrez uniquement la remise manuelle avec son reçu.");
      }
      const resourceType = cleanString(alertSnapshot.get("resourceType"), 40);
      const resourceId = cleanString(alertSnapshot.get("resourceId"), 200);
      const collection = resourceType === "appointment" ? "appointments" : ORDER_RESOURCES.has(resourceType) ? "nexaOrders" : "";
      if (resolve && !collection) throw new ApiError(409, "refund-resource-unsupported", "Cette ressource ne peut pas être clôturée comme remboursement.");
      if (resolve && !/^[A-Za-z0-9_-]{10,200}$/.test(resourceId)) throw new ApiError(409, "refund-resource-invalid", "La ressource de remboursement n’est pas valide.");

      let resourceRef = null;
      let resourceSnapshot = null;
      let ledgerRef = null;
      let ledgerSnapshot = null;
      let relatedAlerts = [];
      let paymentSnapshot = null;
      let amount = 0;
      let alreadyRecorded = false;
      if (resolve) {
        resourceRef = db.collection(collection).doc(resourceId);
        const sourceRead = await transaction.get(resourceRef);
        resourceSnapshot = sourceRead;
        if (!sourceRead.exists) throw new ApiError(404, "refund-resource-not-found", "La ressource liée à cet incident n’existe plus.");
        const source = sourceRead.data() || {};
        if (refundMethod === "CASH_MANUAL" && source.requestedRefundMethod !== "CASH_MANUAL") throw new ApiError(409, "cash-refund-not-requested", "Le patient n’a pas demandé un remboursement en espèces.");
        amount = Number(source.amount);
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 10_000_000) throw new ApiError(409, "refund-amount-invalid", "Le montant du remboursement ne peut pas être confirmé.");
        const paymentRef = cleanString(source.moncashPaymentRef, 64);
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(paymentRef)) throw new ApiError(409, "refund-payment-invalid", "La référence du paiement NEXA est absente ou invalide.");
        const relatedAlertsQuery = db.collection("paymentSettlementAlerts").where("resourceId", "==", resourceId).limit(100);
        ledgerRef = db.collection("nexaRefundLedger").doc(refundLedgerId(resourceType, resourceId));
        const [relatedRead, ledgerRead, paymentRead] = await Promise.all([
          transaction.get(relatedAlertsQuery),
          transaction.get(ledgerRef),
          transaction.get(db.collection("paymentIntents").doc(paymentRef)),
        ]);
        relatedAlerts = relatedRead.docs.filter((item) => item.get("resourceType") === resourceType);
        ledgerSnapshot = ledgerRead;
        paymentSnapshot = paymentRead;
        const refundLedger = ledgerRead.data() || {};
        const recordedReference = refundMethod === "CASH_MANUAL" ? refundLedger.manualCashRefundReference : refundLedger.externalRefundReference;
        alreadyRecorded = ledgerRead.exists && refundLedger.refundMethod === refundMethod && recordedReference === refundReference && refundLedger.status === "COMPLETED";
        if (ledgerRead.exists && !alreadyRecorded) throw new ApiError(409, "refund-already-processed", "Un autre mode de remboursement est déjà enregistré pour cette ressource.");
        const sourceReference = refundMethod === "CASH_MANUAL" ? source.manualCashRefundReference : source.externalRefundReference;
        const alreadyMarked = source.refundMethod === refundMethod && sourceReference === refundReference && source.refundStatus === "COMPLETED";
        if (alreadyRecorded !== alreadyMarked) throw new ApiError(409, "refund-ledger-conflict", "Le registre de remboursement et la ressource ne concordent pas.");
        const resourceEligible = resourceType === "appointment"
          ? (source.status === "PAYMENT_CONFLICT_REFUND_REQUIRED" && source.refundRequired === true) ||
            (source.bookingType === "home_visit" && source.status === "PROVIDER_NO_SHOW_REFUND_REQUIRED" && source.refundRequired === true && source.homeVisitMissionStatus === "PROVIDER_ABSENT_REFUND_REQUIRED" && source.requestedRefundMethod === "CASH_MANUAL" && source.refundStatus === "PENDING_MANUAL_CASH") ||
            (["teleconsultation", "doctor_proposed_appointment"].includes(String(source.bookingType || "")) && source.status === "PROVIDER_NO_SHOW_REFUND_REQUIRED" &&
              source.refundRequired === true && source.refundStatus === "PENDING_MANUAL_CASH" && source.noShowOutcome === "PROVIDER_UNRESPONSIVE" &&
              source.noShowTriggeredBy === "patient" && source.requestedRefundMethod === "CASH_MANUAL" && source.effectiveConsultationStartedAt == null &&
              Array.isArray(source.videoCallAttempts) && source.videoCallAttempts.filter((attempt) => attempt && typeof attempt === "object" &&
                attempt.initiatedByRole === "patient" && attempt.status === "NO_ANSWER").length >= 2) ||
            (source.bookingType === "teleconsultation" && source.providerType === "doctor" &&
              source.status === "PROVIDER_NO_SHOW_REFUND_REQUIRED" && source.refundRequired === true &&
              source.refundStatus === "PENDING_MANUAL_CASH" && source.noShowOutcome === "PROVIDER_UNRESPONSIVE" &&
              source.noShowTriggeredBy === "scheduler" && source.noShowReason === "PROVIDER_DID_NOT_ACCEPT" &&
              source.requestedRefundMethod === "CASH_MANUAL" && source.effectiveConsultationStartedAt == null)
          : source.kind === ORDER_KINDS[resourceType] && (source.refundRequired === true || source.settlementStatus === "REVIEW_REQUIRED");
        if (!alreadyRecorded && (!resourceEligible || source.paymentStatus !== "PAID" || source.refundMethod === "NEXA_WALLET" || source.refundStatus === "COMPLETED")) {
          throw new ApiError(409, "refund-already-processed", "Cette ressource a déjà été remboursée ou son paiement n’est plus à rapprocher.");
        }
        const payment = paymentRead.data() || {};
        const matches = resourceType === "appointment" ? appointmentPaymentMatches(source, payment) : paymentMatches(source, payment);
        const methodMatches = refundMethod === "MONCASH_EXTERNAL" ? payment.paymentMethod === "MONCASH" : ["MONCASH", "SMART_WALLET", "NEXA_WALLET"].includes(String(payment.paymentMethod || ""));
        if (!paymentRead.exists || payment.status !== "paid" || !methodMatches || payment.resourceType !== resourceType || payment.resourcePath !== `${collection}/${resourceId}` ||
          payment.uid !== source.patientUid || !matches || String(payment.currency || "").toUpperCase() !== "HTG" || String(source.currency || "").toUpperCase() !== "HTG") {
          throw new ApiError(409, "refund-payment-mismatch", "Le paiement NEXA ne correspond pas à cette ressource.");
        }
      }

      const resolution = {
        status: resolve ? "resolved" : "in_review",
        reviewNote: note,
        reviewedBy: admin.uid,
        reviewedAt: FieldValue.serverTimestamp(),
        ...(resolve ? { resolution: refundMethod === "CASH_MANUAL" ? "manual_cash_refund_confirmed" : "manual_moncash_refund_confirmed", resolutionReference: refundReference, refundMethod, resolvedBy: admin.uid, resolvedAt: FieldValue.serverTimestamp() } : {}),
      };
      transaction.set(alertRef, resolution, { merge: true });
      if (resolve && resourceRef && resourceSnapshot && ledgerRef && !alreadyRecorded) {
        const source = resourceSnapshot.data() || {};
        const id = refundLedgerId(resourceType, resourceId);
        const now = FieldValue.serverTimestamp();
        transaction.create(ledgerRef, {
          userUid: source.patientUid, resourceType, resourceId, paymentRef: source.moncashPaymentRef, amountMinor: amount * 100,
          ...(Number(source.transactionFee) > 0 ? { nonRefundableTransactionFeeMinor: Number(source.transactionFee) * 100 } : {}),
          currency: "HTG", refundMethod,
          ...(refundMethod === "CASH_MANUAL" ? { manualCashRefundReference: refundReference } : { externalRefundReference: refundReference }),
          status: "COMPLETED", createdAt: now, createdByUid: admin.uid,
        });
        transaction.set(resourceRef, {
          status: "REFUNDED", paymentStatus: "REFUNDED", refundRequired: false, refundStatus: "COMPLETED", refundMethod,
          ...(refundMethod === "CASH_MANUAL" ? { manualCashRefundReference: refundReference } : { externalRefundReference: refundReference }),
          refundLedgerId: id, refundedAmount: amount, refundedAmountMinor: amount * 100,
          ...(Number(source.transactionFee) > 0 ? { nonRefundableTransactionFee: Number(source.transactionFee) } : {}),
          refundedAt: now, refundedByUid: admin.uid, updatedAt: now,
        }, { merge: true });
        if (resourceType === "nursing-order" && /^[A-Za-z0-9_-]{10,200}$/.test(String(source.nursingReviewVisitId || ""))) {
          transaction.set(db.collection("nexaNursingVisits").doc(source.nursingReviewVisitId), {
            status: "REFUNDED", refundedAt: now, updatedAt: now,
          }, { merge: true });
        }
      }
      if (resolve) relatedAlerts.forEach((relatedAlert) => transaction.set(relatedAlert.ref, resolution, { merge: true }));
      transaction.create(auditRef, {
        actorUid: admin.uid,
        action: resolve ? refundMethod === "CASH_MANUAL" ? "manual_cash_refund_recorded" : "manual_moncash_refund_recorded" : "payment_settlement_alert_reviewed",
        resource: `paymentSettlementAlerts/${alertId}`,
        ...(resolve ? { refundMethod, amountMinor: amount * 100 } : {}),
        createdAt: FieldValue.serverTimestamp(),
      });
      const source = resourceSnapshot?.data() || {};
      return { userUid: resolve && typeof source.patientUid === "string" && !alreadyRecorded ? source.patientUid : "", amount: resolve && resourceRef && !alreadyRecorded ? amount : 0, resourceType: resolve && resourceRef && !alreadyRecorded ? resourceType : "", notifyPatient: resolve && Boolean(resourceRef) && !alreadyRecorded };
    });

    if (outcome.notifyPatient && outcome.userUid) await createNexaNotification(outcome.userUid, `manual-refund:${alertId}:${refundMethod}:${refundReference}`, {
      type: refundMethod === "CASH_MANUAL" ? "manual_cash_refund_recorded" : "external_refund_recorded",
      title: refundMethod === "CASH_MANUAL" ? "Remboursement en espèces enregistré" : "Remboursement MonCash enregistré",
      body: `Un montant de ${new Intl.NumberFormat("fr-HT").format(outcome.amount)} HTG, correspondant au ${outcome.resourceType === "nursing-order" ? "prix total de la période infirmière" : "prix du service"}, a été enregistré comme remboursé. Les frais de transaction initiaux ne sont pas remboursés.`,
      url: "/espace-patient.html",
    });
    return res.status(200).json({ ok: true, alertId, status: resolve ? "resolved" : "in_review", ...(resolve ? { refundMethod } : {}) });
  });

  const nexaAdminTransactionFeeSettings = requestHandler({ methods: ["GET", "POST"], action: "admin-transaction-fee-settings", limit: 20 }, async (req, res, admin) => {
    const settingsRef = db.doc(TRANSACTION_FEE_SETTINGS_PATH);
    if (req.method === "GET") {
      const snapshot = await settingsRef.get();
      const storedDefault = normalizeTransactionFeePolicy(snapshot.get("allServices")) || normalizeTransactionFeePolicy(snapshot.get("teleconsultation"));
      const defaultPolicy = storedDefault || await getTransactionFeePolicy("allServices");
      const rawOverrides = snapshot.get("serviceOverrides");
      const services = {};
      for (const serviceType of TRANSACTION_FEE_SERVICE_TYPES) {
        const nested = rawOverrides && typeof rawOverrides === "object" && !Array.isArray(rawOverrides)
          ? normalizeTransactionFeePolicy(rawOverrides[serviceType])
          : null;
        const legacy = serviceType === "teleconsultation" ? null : normalizeTransactionFeePolicy(snapshot.get(serviceType));
        services[serviceType] = transactionFeeView(nested || legacy || defaultPolicy, Boolean(nested || legacy));
      }
      return res.status(200).json({
        ok: true,
        fees: {
          default: transactionFeeView(defaultPolicy, Boolean(storedDefault)),
          services,
        },
      });
    }

    const body = getRequestBody(req);
    const defaultPolicy = normalizeTransactionFeeInput(body && body.default);
    const rawOverrides = body && body.services;
    if (!defaultPolicy || !rawOverrides || typeof rawOverrides !== "object" || Array.isArray(rawOverrides) ||
      TRANSACTION_FEE_SERVICE_TYPES.some((serviceType) => !Object.prototype.hasOwnProperty.call(rawOverrides, serviceType)) ||
      Object.keys(rawOverrides).some((serviceType) => !TRANSACTION_FEE_SERVICE_TYPES.includes(serviceType))) {
      throw new ApiError(400, "invalid-transaction-fee-settings", "Vérifiez le taux général et les paramètres de chaque service.");
    }
    const normalizedOverrides = {};
    for (const serviceType of TRANSACTION_FEE_SERVICE_TYPES) {
      const raw = rawOverrides[serviceType];
      if (raw === null) normalizedOverrides[serviceType] = null;
      else {
        const policy = normalizeTransactionFeeInput(raw);
        if (!policy) throw new ApiError(400, "invalid-transaction-fee-rate", "Chaque taux doit être compris entre 0 et 100 %, avec au plus deux décimales.");
        normalizedOverrides[serviceType] = policy;
      }
    }

    const now = FieldValue.serverTimestamp();
    const auditRef = db.collection("adminAuditLogs").doc();
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(settingsRef);
      const updates = {
        allServices: { ...defaultPolicy, updatedBy: admin.uid, updatedAt: now },
        updatedBy: admin.uid,
        updatedAt: now,
      };
      for (const serviceType of TRANSACTION_FEE_SERVICE_TYPES) {
        updates[`serviceOverrides.${serviceType}`] = normalizedOverrides[serviceType]
          ? { ...normalizedOverrides[serviceType], updatedBy: admin.uid, updatedAt: now }
          : FieldValue.delete();
        // Remove the former top-level representation so an inherited rate
        // cannot be shadowed by a stale legacy override.
        updates[serviceType] = FieldValue.delete();
      }
      updates.teleconsultation = FieldValue.delete();
      if (snapshot.exists) transaction.update(settingsRef, updates);
      else {
        const serviceOverrides = Object.fromEntries(TRANSACTION_FEE_SERVICE_TYPES
          .filter((serviceType) => normalizedOverrides[serviceType])
          .map((serviceType) => [serviceType, { ...normalizedOverrides[serviceType], updatedBy: admin.uid, updatedAt: now }]));
        transaction.create(settingsRef, {
          allServices: updates.allServices,
          serviceOverrides,
          updatedBy: admin.uid,
          updatedAt: now,
        });
      }
      transaction.create(auditRef, {
        actorUid: admin.uid,
        action: "transaction_fee_policies_updated",
        defaultRateBps: defaultPolicy.rateBps,
        defaultActive: defaultPolicy.active,
        serviceOverrides: TRANSACTION_FEE_SERVICE_TYPES.filter((serviceType) => normalizedOverrides[serviceType] !== null),
        createdAt: now,
      });
    });

    const services = Object.fromEntries(TRANSACTION_FEE_SERVICE_TYPES.map((serviceType) => {
      const policy = normalizedOverrides[serviceType] || defaultPolicy;
      return [serviceType, transactionFeeView(policy, Boolean(normalizedOverrides[serviceType]))];
    }));
    return res.status(200).json({ ok: true, fees: { default: transactionFeeView(defaultPolicy, true), services } });
  });

  const nexaAdminProfessionalCommissionSettings = requestHandler({ methods: ["GET", "POST"], action: "admin-professional-commission-settings", limit: 20 }, async (req, res, admin) => {
    const settingsRef = db.doc(PROFESSIONAL_COMMISSION_SETTINGS_PATH);
    if (req.method === "GET") {
      const snapshot = await settingsRef.get();
      const rawRates = snapshot.get("serviceRates");
      const services = Object.fromEntries(PROFESSIONAL_COMMISSION_SERVICE_TYPES.map((serviceType) => [
        serviceType,
        professionalCommissionRateView(rawRates && typeof rawRates === "object" ? rawRates[serviceType] : null),
      ]));
      return res.status(200).json({ ok: true, services });
    }

    const body = getRequestBody(req);
    const rawServices = body && body.services;
    if (!rawServices || typeof rawServices !== "object" || Array.isArray(rawServices) ||
      PROFESSIONAL_COMMISSION_SERVICE_TYPES.some((serviceType) => !Object.prototype.hasOwnProperty.call(rawServices, serviceType)) ||
      Object.keys(rawServices).some((serviceType) => !PROFESSIONAL_COMMISSION_SERVICE_TYPES.includes(serviceType))) {
      throw new ApiError(400, "invalid-professional-commission-settings", "Vérifiez les taux de commission de chaque type de service.");
    }

    const normalizedRates = {};
    for (const serviceType of PROFESSIONAL_COMMISSION_SERVICE_TYPES) {
      const rateBps = normalizeProfessionalCommissionRate(rawServices[serviceType]);
      if (rateBps === undefined) throw new ApiError(400, "invalid-professional-commission-rate", "Chaque taux doit être compris entre 0 et 100 %, avec au plus deux décimales.");
      normalizedRates[serviceType] = rateBps;
    }

    const configuredRates = Object.fromEntries(Object.entries(normalizedRates)
      .filter(([, rateBps]) => rateBps !== null)
      .map(([serviceType, rateBps]) => [serviceType, { rateBps, updatedBy: admin.uid, updatedAt: FieldValue.serverTimestamp() }]));
    const now = FieldValue.serverTimestamp();
    const auditRef = db.collection("adminAuditLogs").doc();
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(settingsRef);
      const updates = {
        updatedBy: admin.uid,
        updatedAt: now,
      };
      for (const serviceType of PROFESSIONAL_COMMISSION_SERVICE_TYPES) {
        updates[`serviceRates.${serviceType}`] = normalizedRates[serviceType] === null
          ? FieldValue.delete()
          : { rateBps: normalizedRates[serviceType], updatedBy: admin.uid, updatedAt: now };
      }
      if (snapshot.exists) transaction.update(settingsRef, updates);
      else transaction.create(settingsRef, {
        serviceRates: configuredRates,
        updatedBy: admin.uid,
        updatedAt: now,
      });
      transaction.create(auditRef, {
        actorUid: admin.uid,
        action: "professional_commission_rates_configured",
        configuredServiceTypes: Object.keys(configuredRates),
        rateBpsByService: Object.fromEntries(Object.entries(normalizedRates).filter(([, rateBps]) => rateBps !== null)),
        createdAt: now,
      });
    });

    const services = Object.fromEntries(PROFESSIONAL_COMMISSION_SERVICE_TYPES.map((serviceType) => [
      serviceType,
      professionalCommissionRateView(configuredRates[serviceType] || null),
    ]));
    return res.status(200).json({ ok: true, services });
  });

  const nexaAdminNursingServiceSettings = requestHandler({ methods: ["GET", "POST"], action: "admin-nursing-service-settings", limit: 20, maxBytes: 64_000 }, async (req, res, admin) => {
    const settingsRef = db.doc(NURSING_SETTINGS_PATH);
    if (req.method === "GET") {
      const rawCursor = typeof req.query?.cursor === "string" ? req.query.cursor : "";
      if (rawCursor && (!/^[A-Za-z0-9_-]{10,200}$/.test(rawCursor) || rawCursor.includes("/"))) {
        throw new ApiError(400, "invalid-nursing-profile-cursor", "Le repère des profils infirmiers n’est pas valide.");
      }
      const nursesCollection = db.collection("providerProfiles");
      let nursesQuery = nursesCollection
        .where("type", "==", "nurse")
        .where("status", "==", "verified")
        .where("nursingCredentialsVerified", "==", true)
        .where("serviceProfileStatus", "==", "PENDING_REVIEW")
        .orderBy(FieldPath.documentId());
      if (rawCursor) nursesQuery = nursesQuery.startAfter(nursesCollection.doc(rawCursor));
      const [settingsSnapshot, nursesSnapshot] = await Promise.all([
        settingsRef.get(),
        nursesQuery.limit(ADMIN_REVIEW_PAGE_SIZE + 1).get(),
      ]);
      const settings = settingsSnapshot.data();
      const zones = configuredNursingSettings(settings);
      const periodRules = configuredNursingPeriodRules(settings);
      const bookingMode = NURSING_BOOKING_MODES.has(settings?.bookingMode) ? settings.bookingMode : "";
      const profilesHasMore = nursesSnapshot.docs.length > ADMIN_REVIEW_PAGE_SIZE;
      const profilesPage = nursesSnapshot.docs.slice(0, ADMIN_REVIEW_PAGE_SIZE);
      const pendingProfiles = await Promise.all(profilesPage
        .map(async (doc) => {
          const profile = doc.get("profile") && typeof doc.get("profile") === "object" ? doc.get("profile") : {};
          const serviceProfile = normalizeNursingServiceProfile(doc.get("nursingServiceProfile"));
          const photoPath = doc.get("nursingProfilePhotoPath");
          const photoConsent = doc.get("nursingProfilePhotoConsentVersion") === NURSING_PHOTO_CONSENT_VERSION;
          let photoUrl = "";
          if (photoConsent && validNursingProfilePhotoPath(doc.id, photoPath) &&
            ["PENDING_REVIEW", "APPROVED"].includes(String(doc.get("nursingProfilePhotoStatus") || ""))) {
            try {
              const file = bucket.file(photoPath);
              const [metadata] = await file.getMetadata();
              if (metadata.contentType === "image/jpeg" && metadata.metadata?.nexaScanStatus === "CLEAN" &&
                metadata.metadata?.nexaOwnerUid === doc.id && metadata.metadata?.nexaConsentVersion === NURSING_PHOTO_CONSENT_VERSION) {
                [photoUrl] = await file.getSignedUrl({ action: "read", expires: Date.now() + 5 * 60_000 });
              }
            } catch { /* Keep the photo unavailable to the admin if Storage cannot verify it. */ }
          }
          return {
            uid: doc.id,
            name: cleanNursingText(profile.name, 120),
            photoUrl,
            photoConsent,
            photoStatus: cleanString(doc.get("nursingProfilePhotoStatus"), 32),
            qualifications: Array.isArray(profile.nursingQualifications)
              ? profile.nursingQualifications.filter((value) => typeof value === "string" && NURSING_QUALIFICATIONS.has(value)).slice(0, 8)
              : [],
            serviceProfile,
          };
        }));
      await db.collection("adminAuditLogs").doc().create({
        actorUid: admin.uid,
        action: "nursing_service_settings_and_pending_profiles_listed",
        zoneCount: zones.length,
        pendingProfileCount: pendingProfiles.length,
        cursorUsed: Boolean(rawCursor),
        createdAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ ok: true, zones, periodRules, bookingMode, pendingProfiles,
        pendingProfilesHasMore: profilesHasMore,
        pendingProfilesNextCursor: profilesHasMore ? profilesPage[profilesPage.length - 1]?.id || null : null });
    }

    const body = getRequestBody(req);
    if (!body || typeof body.action !== "string") throw new ApiError(400, "invalid-nursing-action", "Action d’administration infirmière invalide.");
    if (body.action === "save-settings") {
      const zones = normalizeNursingZones(body.zones);
      const periodRules = normalizeNursingPeriodRules(body.periodRules);
      const bookingMode = body.bookingMode;
      if (!zones) throw new ApiError(400, "invalid-nursing-zones", "Vérifiez les communes, les identifiants de zone et les tarifs en HTG.");
      if (!periodRules) throw new ApiError(400, "invalid-nursing-period-rules", "Vérifiez les jours, les heures et le jour de fin de chaque période infirmière.");
      if (!NURSING_BOOKING_MODES.has(bookingMode)) throw new ApiError(400, "invalid-nursing-booking-mode", "Choisissez comment les interventions seront organisées pendant la période.");
      await settingsRef.set({ zones, periodRules, bookingMode, updatedBy: admin.uid, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await db.collection("adminAuditLogs").doc().create({
        actorUid: admin.uid,
        action: "nursing_period_rules_zones_tariffs_and_booking_mode_updated",
        zoneCount: zones.length,
        configuredPeriods: Object.keys(periodRules),
        bookingMode,
        createdAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ ok: true, zones, periodRules, bookingMode });
    }

    if (body.action !== "review-profile") throw new ApiError(400, "invalid-nursing-action", "Action d’administration infirmière invalide.");
    const uid = cleanString(body.uid, 128);
    const decision = body.decision;
    const reason = cleanNursingText(body.reason, 500);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(uid) || !["approve", "reject"].includes(String(decision))) {
      throw new ApiError(400, "invalid-nursing-review", "Sélectionnez un profil infirmier et une décision valides.");
    }
    if (decision === "approve" && body.scopeVerified !== true) {
      throw new ApiError(400, "nursing-scope-review-required", "Confirmez que les services choisis correspondent aux qualifications vérifiées avant l’approbation.");
    }
    if (decision === "reject" && !reason) throw new ApiError(400, "nursing-review-reason-required", "Ajoutez le motif qui sera transmis au profil infirmier.");

    const providerRef = db.collection("providerProfiles").doc(uid);
    let reviewPhotoPath = "";
    if (decision === "approve") {
      const preview = await providerRef.get();
      if (!preview.exists) throw new ApiError(404, "nursing-profile-not-found", "Ce profil infirmier n’existe plus.");
      reviewPhotoPath = preview.get("nursingProfilePhotoPath");
      if (!validNursingProfilePhotoPath(uid, reviewPhotoPath) ||
        !["PENDING_REVIEW", "APPROVED"].includes(String(preview.get("nursingProfilePhotoStatus") || "")) ||
        preview.get("nursingProfilePhotoConsentVersion") !== NURSING_PHOTO_CONSENT_VERSION) {
        throw new ApiError(409, "nursing-photo-required", "Une photo de profil consentie et vérifiée est requise avant la publication dans l’annuaire.");
      }
      try {
        const [metadata] = await bucket.file(reviewPhotoPath).getMetadata();
        if (metadata.contentType !== "image/jpeg" || metadata.metadata?.nexaScanStatus !== "CLEAN" ||
          metadata.metadata?.nexaOwnerUid !== uid || metadata.metadata?.nexaConsentVersion !== NURSING_PHOTO_CONSENT_VERSION) {
          throw new ApiError(409, "nursing-photo-not-clean", "La photo doit être re-téléversée et analysée avant sa publication.");
        }
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(409, "nursing-photo-unavailable", "La photo du profil ne peut pas être vérifiée actuellement.");
      }
    }
    await db.runTransaction(async (transaction) => {
      const [provider, settingsSnapshot] = await Promise.all([transaction.get(providerRef), transaction.get(settingsRef)]);
      if (!provider.exists || provider.get("type") !== "nurse" || provider.get("status") !== "verified" || provider.get("nursingCredentialsVerified") !== true || provider.get("serviceProfileStatus") !== "PENDING_REVIEW") {
        throw new ApiError(409, "nursing-profile-not-reviewable", "Ce profil n’est plus en attente de validation.");
      }
      if (decision === "approve" && !nursingProfileIsPublishable(provider.get("nursingServiceProfile"), configuredNursingSettings(settingsSnapshot.data()))) {
        throw new ApiError(409, "nursing-profile-incomplete", "Le profil ou un tarif de zone est incomplet. Demandez au professionnel de corriger son profil ou complétez les paramètres NEXA.");
      }
      if (decision === "approve" && (provider.get("nursingProfilePhotoPath") !== reviewPhotoPath ||
        !["PENDING_REVIEW", "APPROVED"].includes(String(provider.get("nursingProfilePhotoStatus") || "")) ||
        provider.get("nursingProfilePhotoConsentVersion") !== NURSING_PHOTO_CONSENT_VERSION)) {
        throw new ApiError(409, "nursing-photo-changed", "La photo a changé pendant la revue. Actualisez la file et vérifiez-la à nouveau.");
      }
      transaction.set(providerRef, {
        serviceProfileStatus: decision === "approve" ? "APPROVED" : "REJECTED",
        ...(decision === "approve" ? { nursingProfilePhotoStatus: "APPROVED" } : {}),
        publiclyListed: false,
        nursingDirectoryListed: decision === "approve",
        serviceProfileReviewReason: decision === "reject" ? reason : FieldValue.delete(),
        serviceProfileReviewedBy: admin.uid,
        serviceProfileReviewedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    await db.collection("adminAuditLogs").doc().create({
      actorUid: admin.uid,
      action: decision === "approve" ? "nursing_service_profile_approved" : "nursing_service_profile_rejected",
      resource: `providerProfiles/${uid}`,
      ...(decision === "reject" ? { reason } : {}),
      createdAt: FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ ok: true, uid, serviceProfileStatus: decision === "approve" ? "APPROVED" : "REJECTED" });
  });

  const nexaAdminNursingApplications = requestHandler({ methods: ["GET", "POST"], action: "admin-nursing-applications", limit: 20, maxBytes: 24_000 }, async (req, res, admin) => {
    if (req.method === "GET") {
      const rawCursor = typeof req.query?.cursor === "string" ? req.query.cursor : "";
      if (rawCursor && (!/^[A-Za-z0-9_-]{10,200}$/.test(rawCursor) || rawCursor.includes("/"))) {
        throw new ApiError(400, "invalid-nursing-application-cursor", "Le repère des candidatures infirmières n’est pas valide.");
      }
      const collection = db.collection("professionalApplications");
      let query = collection
        .where("providerType", "==", "nurse")
        .where("status", "==", "pending")
        .orderBy(FieldPath.documentId());
      if (rawCursor) query = query.startAfter(collection.doc(rawCursor));
      const snapshot = await query.limit(ADMIN_REVIEW_PAGE_SIZE + 1).get();
      const hasMore = snapshot.docs.length > ADMIN_REVIEW_PAGE_SIZE;
      const page = snapshot.docs.slice(0, ADMIN_REVIEW_PAGE_SIZE);
      const applications = page.map((doc) => {
        const source = doc.data();
        const profile = source.profile && typeof source.profile === "object" && !Array.isArray(source.profile) ? source.profile : {};
        return {
          uid: doc.id,
          name: cleanNursingText(profile.name, 120),
          email: cleanString(source.email, 254),
          phone: cleanNursingText(profile.publicPhone, 30),
          department: cleanNursingText(profile.department, 80),
          commune: cleanNursingText(profile.commune, 80),
          publicBio: cleanNursingText(profile.publicBio, 300),
          qualifications: Array.isArray(profile.nursingQualifications)
            ? profile.nursingQualifications.filter((value) => typeof value === "string" && NURSING_QUALIFICATIONS.has(value)).slice(0, 8)
            : [],
          submittedAt: dateIso(source.submittedAt),
        };
      });
      await db.collection("adminAuditLogs").doc().create({
        actorUid: admin.uid,
        action: "nursing_affiliation_applications_listed",
        resultCount: applications.length,
        cursorUsed: Boolean(rawCursor),
        createdAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ ok: true, applications, hasMore, nextCursor: hasMore ? page[page.length - 1]?.id || null : null });
    }

    const body = getRequestBody(req);
    const uid = cleanString(body?.uid, 128);
    const decision = body?.decision;
    const reviewNote = cleanNursingText(body?.reviewNote, 500);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(uid) || !["approved", "rejected"].includes(String(decision))) {
      throw new ApiError(400, "invalid-nursing-application-review", "Sélectionnez une candidature infirmière et une décision valides.");
    }
    if (decision === "approved" && body?.credentialsVerified !== true) {
      throw new ApiError(400, "nursing-credentials-review-required", "Confirmez la vérification de l’identité et des qualifications infirmières avant l’approbation.");
    }
    if (decision === "rejected" && !reviewNote) {
      throw new ApiError(400, "nursing-application-review-note-required", "Ajoutez le motif de refus communiqué au candidat.");
    }

    const applicationRef = db.collection("professionalApplications").doc(uid);
    const providerRef = db.collection("providerProfiles").doc(uid);
    const auditRef = db.collection("adminAuditLogs").doc();
    const outcome = await db.runTransaction(async (transaction) => {
      const [applicationSnapshot, providerSnapshot] = await Promise.all([
        transaction.get(applicationRef),
        transaction.get(providerRef),
      ]);
      if (!applicationSnapshot.exists) throw new ApiError(404, "nursing-application-not-found", "Cette candidature infirmière n’existe pas.");
      const application = applicationSnapshot.data() || {};
      const profile = application.profile && typeof application.profile === "object" && !Array.isArray(application.profile) ? application.profile : {};
      if (application.uid !== uid || application.providerType !== "nurse" || application.status !== "pending") {
        throw new ApiError(409, "nursing-application-not-reviewable", "Cette candidature n’est plus en attente ou son type doit être corrigé.");
      }
      const submittedQualifications = Array.isArray(profile.nursingQualifications) ? profile.nursingQualifications : [];
      if (!cleanNursingText(profile.name, 120) || !cleanNursingText(profile.publicPhone, 30) ||
        !cleanNursingText(profile.department, 80) || !cleanNursingText(profile.commune, 80) ||
        submittedQualifications.length < 1 || submittedQualifications.length > NURSING_QUALIFICATIONS.size ||
        submittedQualifications.some((value) => typeof value !== "string" || !NURSING_QUALIFICATIONS.has(value)) ||
        new Set(submittedQualifications).size !== submittedQualifications.length) {
        throw new ApiError(409, "nursing-application-incomplete", "Les renseignements ou qualifications de la candidature doivent être corrigés avant sa revue.");
      }
      if (providerSnapshot.exists && (providerSnapshot.get("status") === "verified" || providerSnapshot.get("type") !== "nurse")) {
        throw new ApiError(409, "provider-profile-conflict", "Un profil professionnel existant empêche cette activation.");
      }

      transaction.set(applicationRef, {
        status: decision,
        reviewNote: reviewNote || null,
        reviewedAt: FieldValue.serverTimestamp(),
        reviewedBy: admin.uid,
      }, { merge: true });
      if (decision === "approved") {
        transaction.set(providerRef, {
          uid,
          type: "nurse",
          status: "verified",
          nursingCredentialsVerified: true,
          serviceProfileStatus: "INCOMPLETE",
          publiclyListed: false,
          nursingDirectoryListed: false,
          profile: {
            name: cleanNursingText(profile.name, 120),
            publicBio: cleanNursingText(profile.publicBio, 300),
            publicPhone: cleanNursingText(profile.publicPhone, 30),
            department: cleanNursingText(profile.department, 80),
            commune: cleanNursingText(profile.commune, 80),
            nursingQualifications: [...submittedQualifications],
          },
          verifiedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      transaction.create(auditRef, {
        actorUid: admin.uid,
        action: decision === "approved" ? "nursing_affiliation_application_approved" : "nursing_affiliation_application_rejected",
        resource: `professionalApplications/${uid}`,
        ...(decision === "rejected" ? { reason: reviewNote } : {}),
        createdAt: FieldValue.serverTimestamp(),
      });
      return { status: decision, alreadyReviewed: false };
    });
    if (!outcome.alreadyReviewed) {
      try {
        await createNexaNotification(uid, `nursing-affiliation-review:${auditRef.id}`, {
          type: decision === "approved" ? "nursing_affiliation_approved" : "nursing_affiliation_correction_requested",
          title: decision === "approved" ? "Candidature infirmière approuvée" : "Correction demandée pour votre candidature",
          body: decision === "approved"
            ? "Votre affiliation infirmière est approuvée. Connectez-vous à NEXA pour compléter votre profil de services."
            : "NEXA a examiné votre candidature infirmière. Connectez-vous pour consulter le motif et corriger votre demande.",
          url: "/candidature-infirmier.html",
        });
      } catch (error) {
        logger.error("NEXA nursing affiliation notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      }
    }
    return res.status(200).json({ ok: true, uid, ...outcome });
  });

  const nexaAdminDoctorApplications = requestHandler({ methods: ["GET", "POST"], action: "admin-doctor-applications", limit: 20, maxBytes: 24_000 }, async (req, res, admin) => {
    if (req.method === "GET") {
      const applicationCursor = typeof req.query?.applicationsCursor === "string" ? req.query.applicationsCursor : "";
      const photoCursor = typeof req.query?.photosCursor === "string" ? req.query.photosCursor : "";
      for (const cursor of [applicationCursor, photoCursor]) {
        if (cursor && (!/^[A-Za-z0-9_-]{10,200}$/.test(cursor) || cursor.includes("/"))) {
          throw new ApiError(400, "invalid-doctor-review-cursor", "Le repère de la file médecins n’est pas valide.");
        }
      }
      const applicationsCollection = db.collection("professionalApplications");
      const photosCollection = db.collection("providerProfiles");
      let applicationsQuery = applicationsCollection
        .where("providerType", "==", "doctor")
        .where("status", "==", "pending")
        .orderBy(FieldPath.documentId());
      let photosQuery = photosCollection
        .where("type", "==", "doctor")
        .where("status", "==", "verified")
        .where("profilePhotoStatus", "==", "PENDING_REVIEW")
        .orderBy(FieldPath.documentId());
      if (applicationCursor) applicationsQuery = applicationsQuery.startAfter(applicationsCollection.doc(applicationCursor));
      if (photoCursor) photosQuery = photosQuery.startAfter(photosCollection.doc(photoCursor));
      const [snapshot, doctorSnapshot] = await Promise.all([
        applicationsQuery.limit(ADMIN_REVIEW_PAGE_SIZE + 1).get(),
        photosQuery.limit(ADMIN_REVIEW_PAGE_SIZE + 1).get(),
      ]);
      const applicationsHasMore = snapshot.docs.length > ADMIN_REVIEW_PAGE_SIZE;
      const applicationsPage = snapshot.docs.slice(0, ADMIN_REVIEW_PAGE_SIZE);
      const photosHasMore = doctorSnapshot.docs.length > ADMIN_REVIEW_PAGE_SIZE;
      const photosPage = doctorSnapshot.docs.slice(0, ADMIN_REVIEW_PAGE_SIZE);
      const applications = applicationsPage.map((doc) => {
        const source = doc.data();
        const profile = source.profile && typeof source.profile === "object" && !Array.isArray(source.profile) ? source.profile : {};
        return {
          uid: doc.id,
          name: cleanNursingText(profile.name, 120),
          specialty: cleanNursingText(profile.specialty, 100),
          indicativeFee: Number.isSafeInteger(profile.indicativeFee) ? profile.indicativeFee : null,
          email: cleanString(source.email, 254),
          phone: cleanNursingText(profile.publicPhone, 30),
          department: cleanNursingText(profile.department, 80),
          commune: cleanNursingText(profile.commune, 80),
          publicBio: cleanNursingText(profile.publicBio, 300),
          submittedAt: dateIso(source.submittedAt),
        };
      });
      const pendingPhotos = await Promise.all(photosPage
        .filter((doc) => doc.get("clinicalCredentialsVerified") === true && doc.get("profilePhotoConsentVersion") === DOCTOR_PHOTO_CONSENT_VERSION)
        .map(async (doc) => {
          const profile = doc.get("profile") && typeof doc.get("profile") === "object" ? doc.get("profile") : {};
          const photoPath = doc.get("profilePhotoPath");
          let photoUrl = "";
          if (validDoctorProfilePhotoPath(doc.id, photoPath)) {
            try {
              const file = bucket.file(photoPath);
              const [metadata] = await file.getMetadata();
              if (metadata.contentType === "image/jpeg" && metadata.metadata?.nexaScanStatus === "CLEAN" &&
                metadata.metadata?.nexaOwnerUid === doc.id && metadata.metadata?.nexaConsentVersion === DOCTOR_PHOTO_CONSENT_VERSION) {
                [photoUrl] = await file.getSignedUrl({ action: "read", expires: Date.now() + 5 * 60_000 });
              }
            } catch { /* Keep the photo unavailable if Storage cannot verify it. */ }
          }
          return {
            uid: doc.id,
            name: cleanNursingText(profile.name, 120),
            specialty: cleanNursingText(profile.specialty, 100),
            photoUrl,
            photoConsent: true,
            photoStatus: cleanString(doc.get("profilePhotoStatus"), 32),
          };
        }));
      await db.collection("adminAuditLogs").doc().create({
        actorUid: admin.uid,
        action: "doctor_affiliation_applications_and_photos_listed",
        resultCount: applications.length,
        pendingPhotoCount: pendingPhotos.length,
        applicationsCursorUsed: Boolean(applicationCursor),
        photosCursorUsed: Boolean(photoCursor),
        createdAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ ok: true, applications, pendingPhotos,
        applicationsHasMore, applicationsNextCursor: applicationsHasMore ? applicationsPage[applicationsPage.length - 1]?.id || null : null,
        photosHasMore, photosNextCursor: photosHasMore ? photosPage[photosPage.length - 1]?.id || null : null });
    }

    const body = getRequestBody(req);
    const uid = cleanString(body?.uid, 128);
    const decision = body?.decision;
    const reviewNote = cleanNursingText(body?.reviewNote, 500);
    if (["photo-approved", "photo-rejected"].includes(String(decision))) {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(uid)) throw new ApiError(400, "invalid-doctor-photo-review", "Sélectionnez un profil médecin valide.");
      if (decision === "photo-approved" && body?.reviewConfirmed !== true) throw new ApiError(400, "doctor-photo-review-confirmation-required", "Confirmez la revue de la photo et du consentement.");
      if (decision === "photo-rejected" && !reviewNote) throw new ApiError(400, "doctor-photo-review-note-required", "Ajoutez un motif de refus communiqué au médecin.");
      const providerRef = db.collection("providerProfiles").doc(uid);
      const preview = await providerRef.get();
      if (!preview.exists || preview.get("type") !== "doctor" || preview.get("status") !== "verified" || preview.get("clinicalCredentialsVerified") !== true) {
        throw new ApiError(404, "doctor-profile-not-found", "Ce profil médecin vérifié n’existe plus.");
      }
      const photoPath = preview.get("profilePhotoPath");
      if (!validDoctorProfilePhotoPath(uid, photoPath) || preview.get("profilePhotoStatus") !== "PENDING_REVIEW" ||
        preview.get("profilePhotoConsentVersion") !== DOCTOR_PHOTO_CONSENT_VERSION) {
        throw new ApiError(409, "doctor-photo-not-reviewable", "La photo ou le consentement n’est plus en attente de revue.");
      }
      if (decision === "photo-approved") {
        try {
          const [metadata] = await bucket.file(photoPath).getMetadata();
          if (metadata.contentType !== "image/jpeg" || metadata.metadata?.nexaScanStatus !== "CLEAN" ||
            metadata.metadata?.nexaOwnerUid !== uid || metadata.metadata?.nexaConsentVersion !== DOCTOR_PHOTO_CONSENT_VERSION) {
            throw new ApiError(409, "doctor-photo-not-clean", "La photo ne possède pas de verdict antivirus valide.");
          }
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw new ApiError(409, "doctor-photo-unavailable", "La photo médecin ne peut pas être vérifiée actuellement.");
        }
      }
      const auditRef = db.collection("adminAuditLogs").doc();
      await db.runTransaction(async (transaction) => {
        const current = await transaction.get(providerRef);
        if (!current.exists || current.get("type") !== "doctor" || current.get("status") !== "verified" ||
          current.get("clinicalCredentialsVerified") !== true || current.get("profilePhotoPath") !== photoPath ||
          current.get("profilePhotoStatus") !== "PENDING_REVIEW" || current.get("profilePhotoConsentVersion") !== DOCTOR_PHOTO_CONSENT_VERSION) {
          throw new ApiError(409, "doctor-photo-changed", "La photo ou le profil a changé pendant la revue. Actualisez la file.");
        }
        transaction.set(providerRef, {
          profilePhotoStatus: decision === "photo-approved" ? "APPROVED" : "REJECTED",
          publiclyListed: decision === "photo-approved",
          profilePhotoReviewedBy: admin.uid,
          profilePhotoReviewedAt: FieldValue.serverTimestamp(),
          profilePhotoReviewReason: decision === "photo-rejected" ? reviewNote : FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.create(auditRef, {
          actorUid: admin.uid,
          action: decision === "photo-approved" ? "doctor_profile_photo_approved" : "doctor_profile_photo_rejected",
          resource: `providerProfiles/${uid}`,
          createdAt: FieldValue.serverTimestamp(),
        });
      });
      try {
        await createNexaNotification(uid, `doctor-profile-photo-review:${auditRef.id}`, {
          type: decision === "photo-approved" ? "doctor_profile_photo_approved" : "doctor_profile_photo_correction_requested",
          title: decision === "photo-approved" ? "Photo du profil médecin approuvée" : "Correction demandée pour votre photo",
          body: decision === "photo-approved"
            ? "Votre photo est approuvée et votre profil apparaît dans le répertoire NEXA."
            : `Votre photo n’a pas été approuvée. ${reviewNote}`,
          url: "/espace-professionnel.html",
        });
      } catch (error) {
        logger.error("NEXA doctor photo review notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      }
      return res.status(200).json({ ok: true, uid, photoStatus: decision === "photo-approved" ? "APPROVED" : "REJECTED" });
    }
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(uid) || !["approved", "rejected"].includes(String(decision))) {
      throw new ApiError(400, "invalid-doctor-application-review", "Sélectionnez une candidature médecin et une décision valides.");
    }
    if (decision === "approved" && body?.credentialsVerified !== true) {
      throw new ApiError(400, "doctor-credentials-review-required", "Confirmez la vérification des qualifications médicales avant l’approbation.");
    }
    if (decision === "rejected" && !reviewNote) {
      throw new ApiError(400, "doctor-application-review-note-required", "Ajoutez le motif de refus communiqué au candidat.");
    }

    const applicationRef = db.collection("professionalApplications").doc(uid);
    const providerRef = db.collection("providerProfiles").doc(uid);
    const auditRef = db.collection("adminAuditLogs").doc();
    const outcome = await db.runTransaction(async (transaction) => {
      const [applicationSnapshot, providerSnapshot] = await Promise.all([
        transaction.get(applicationRef),
        transaction.get(providerRef),
      ]);
      if (!applicationSnapshot.exists) throw new ApiError(404, "doctor-application-not-found", "Cette candidature médecin n’existe pas.");
      const application = applicationSnapshot.data() || {};
      const profile = application.profile && typeof application.profile === "object" && !Array.isArray(application.profile) ? application.profile : {};
      if (application.uid !== uid || application.providerType !== "doctor") {
        throw new ApiError(409, "doctor-application-type-invalid", "Cette demande n’est pas une candidature médecin.");
      }
      if (application.status !== "pending") {
        if (application.status === decision) return { status: decision, alreadyReviewed: true };
        throw new ApiError(409, "doctor-application-not-reviewable", "Cette candidature n’est plus en attente ou a déjà reçu une autre décision.");
      }
      if (!cleanNursingText(profile.name, 120) || !cleanNursingText(profile.specialty, 100) ||
        !cleanNursingText(profile.publicPhone, 30) || !cleanNursingText(profile.department, 80) ||
        !cleanNursingText(profile.commune, 80) || !Number.isSafeInteger(profile.indicativeFee) ||
        profile.indicativeFee < 1 || profile.indicativeFee > 10_000_000) {
        throw new ApiError(409, "doctor-application-incomplete", "Les renseignements obligatoires ou le tarif doivent être corrigés avant la revue.");
      }
      if (providerSnapshot.exists && (providerSnapshot.get("status") === "verified" || (providerSnapshot.get("type") && providerSnapshot.get("type") !== "doctor"))) {
        throw new ApiError(409, "provider-profile-conflict", "Un profil professionnel existant empêche cette activation.");
      }
      const requestedFee = body.indicativeFee;
      const approvedFee = Number.isSafeInteger(requestedFee) ? requestedFee : profile.indicativeFee;
      if (decision === "approved" && (!Number.isSafeInteger(approvedFee) || approvedFee < 1 || approvedFee > 10_000_000)) {
        throw new ApiError(400, "consultation-fee-required", "Confirmez un tarif entier en HTG entre 1 et 10 000 000 avant d’approuver ce médecin.");
      }

      transaction.set(applicationRef, {
        status: decision,
        ...(decision === "approved" ? { profile: { ...profile, indicativeFee: approvedFee } } : {}),
        reviewNote: reviewNote || null,
        reviewedAt: FieldValue.serverTimestamp(),
        reviewedBy: admin.uid,
      }, { merge: true });
      if (decision === "approved") {
        transaction.set(providerRef, {
          uid,
          type: "doctor",
          status: "verified",
          clinicalCredentialsVerified: true,
          publiclyListed: false,
          profilePhotoPath: FieldValue.delete(),
          profilePhotoStatus: FieldValue.delete(),
          profilePhotoConsentVersion: FieldValue.delete(),
          profilePhotoConsentedAt: FieldValue.delete(),
          profile: {
            name: cleanNursingText(profile.name, 120),
            specialty: cleanNursingText(profile.specialty, 100),
            publicBio: cleanNursingText(profile.publicBio, 300),
            publicPhone: cleanNursingText(profile.publicPhone, 30),
            department: cleanNursingText(profile.department, 80),
            commune: cleanNursingText(profile.commune, 80),
            indicativeFee: approvedFee,
          },
          verifiedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      transaction.create(auditRef, {
        actorUid: admin.uid,
        action: decision === "approved" ? "doctor_affiliation_application_approved" : "doctor_affiliation_application_rejected",
        resource: `professionalApplications/${uid}`,
        ...(decision === "rejected" ? { reason: reviewNote } : {}),
        createdAt: FieldValue.serverTimestamp(),
      });
      return { status: decision, alreadyReviewed: false };
    });
    if (!outcome.alreadyReviewed) {
      try {
        await createNexaNotification(uid, `doctor-affiliation-review:${auditRef.id}`, {
          type: decision === "approved" ? "doctor_affiliation_approved" : "doctor_affiliation_correction_requested",
          title: decision === "approved" ? "Candidature médecin approuvée" : "Correction demandée pour votre candidature",
          body: decision === "approved"
            ? "Votre affiliation médecin est approuvée. Connectez-vous à votre espace pour téléverser une photo; le profil sera publié après sa revue NEXA."
            : "NEXA a examiné votre candidature médecin. Connectez-vous pour consulter le motif et corriger votre demande.",
          url: "/candidature-medecin.html",
        });
      } catch (error) {
        logger.error("NEXA doctor affiliation notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      }
    }
    return res.status(200).json({ ok: true, uid, ...outcome });
  });

  const nexaAdminPartnerApplications = requestHandler({ methods: ["GET", "POST"], action: "admin-partner-applications", limit: 20, maxBytes: 24_000 }, async (req, res, admin) => {
    const partnerTypes = new Set(["pharmacy", "laboratory", "imaging"]);
    if (req.method === "GET") {
      const rawCursor = typeof req.query?.cursor === "string" ? req.query.cursor : "";
      if (rawCursor && (!/^[A-Za-z0-9_-]{10,200}$/.test(rawCursor) || rawCursor.includes("/"))) {
        throw new ApiError(400, "invalid-partner-application-cursor", "Le repère des candidatures partenaires n’est pas valide.");
      }
      const collection = db.collection("professionalApplications");
      let query = collection
        .where("providerType", "in", [...partnerTypes])
        .where("status", "==", "pending")
        .orderBy(FieldPath.documentId());
      if (rawCursor) query = query.startAfter(collection.doc(rawCursor));
      const snapshot = await query.limit(ADMIN_REVIEW_PAGE_SIZE + 1).get();
      const hasMore = snapshot.docs.length > ADMIN_REVIEW_PAGE_SIZE;
      const page = snapshot.docs.slice(0, ADMIN_REVIEW_PAGE_SIZE);
      const applications = page.map((doc) => {
        const source = doc.data() || {};
        const profile = source.profile && typeof source.profile === "object" && !Array.isArray(source.profile) ? source.profile : {};
        return {
          uid: doc.id,
          providerType: partnerTypes.has(source.providerType) ? source.providerType : "",
          name: cleanNursingText(profile.name, 120),
          email: cleanString(source.email, 254),
          phone: cleanNursingText(profile.publicPhone, 30),
          department: cleanNursingText(profile.department, 80),
          commune: cleanNursingText(profile.commune, 80),
          publicBio: cleanNursingText(profile.publicBio, 300),
          submittedAt: dateIso(source.submittedAt),
        };
      });
      await db.collection("adminAuditLogs").doc().create({
        actorUid: admin.uid,
        action: "partner_affiliation_applications_listed",
        resultCount: applications.length,
        cursorUsed: Boolean(rawCursor),
        createdAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ ok: true, applications, hasMore, nextCursor: hasMore ? page[page.length - 1]?.id || null : null });
    }

    const body = getRequestBody(req);
    const uid = cleanString(body?.uid, 128);
    const decision = body?.decision;
    const reviewNote = cleanNursingText(body?.reviewNote, 500);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(uid) || !["approved", "rejected"].includes(String(decision))) {
      throw new ApiError(400, "invalid-partner-application-review", "Sélectionnez une candidature partenaire et une décision valides.");
    }
    if (decision === "rejected" && !reviewNote) {
      throw new ApiError(400, "partner-application-review-note-required", "Ajoutez le motif communiqué au partenaire.");
    }

    const applicationRef = db.collection("professionalApplications").doc(uid);
    const providerRef = db.collection("providerProfiles").doc(uid);
    const auditRef = db.collection("adminAuditLogs").doc();
    const outcome = await db.runTransaction(async (transaction) => {
      const [applicationSnapshot, providerSnapshot] = await Promise.all([transaction.get(applicationRef), transaction.get(providerRef)]);
      if (!applicationSnapshot.exists) throw new ApiError(404, "partner-application-not-found", "Cette candidature partenaire n’existe pas.");
      const application = applicationSnapshot.data() || {};
      const providerType = application.providerType;
      const profile = application.profile && typeof application.profile === "object" && !Array.isArray(application.profile) ? application.profile : {};
      if (application.uid !== uid || !partnerTypes.has(providerType)) {
        throw new ApiError(409, "partner-application-type-invalid", "Cette demande n’est pas une candidature pharmacie, laboratoire ou imagerie.");
      }
      if (application.status !== "pending") {
        if (application.status === decision) return { status: decision, alreadyReviewed: true };
        throw new ApiError(409, "partner-application-not-reviewable", "Cette candidature n’est plus en attente ou a déjà reçu une autre décision.");
      }
      if (!cleanNursingText(profile.name, 120) || !cleanNursingText(profile.publicPhone, 30) ||
        !cleanNursingText(profile.department, 80) || !cleanNursingText(profile.commune, 80)) {
        throw new ApiError(409, "partner-application-incomplete", "Les renseignements obligatoires doivent être corrigés avant la revue.");
      }
      if (providerSnapshot.exists && (providerSnapshot.get("status") === "verified" ||
        (providerSnapshot.get("type") && providerSnapshot.get("type") !== providerType))) {
        throw new ApiError(409, "provider-profile-conflict", "Un profil professionnel existant empêche cette activation.");
      }

      transaction.set(applicationRef, {
        status: decision,
        reviewNote: reviewNote || null,
        reviewedAt: FieldValue.serverTimestamp(),
        reviewedBy: admin.uid,
      }, { merge: true });
      if (decision === "approved") {
        transaction.set(providerRef, {
          uid,
          type: providerType,
          status: "verified",
          publiclyListed: true,
          profile: {
            name: cleanNursingText(profile.name, 120),
            publicBio: cleanNursingText(profile.publicBio, 300),
            publicPhone: cleanNursingText(profile.publicPhone, 30),
            department: cleanNursingText(profile.department, 80),
            commune: cleanNursingText(profile.commune, 80),
          },
          verifiedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      transaction.create(auditRef, {
        actorUid: admin.uid,
        action: `${providerType}_partner_application_${decision}`,
        resource: `professionalApplications/${uid}`,
        ...(decision === "rejected" ? { reason: reviewNote } : {}),
        createdAt: FieldValue.serverTimestamp(),
      });
      return { status: decision, alreadyReviewed: false };
    });
    if (!outcome.alreadyReviewed) {
      try {
        await createNexaNotification(uid, `partner-affiliation-review:${auditRef.id}`, {
          type: decision === "approved" ? "partner_affiliation_approved" : "partner_affiliation_correction_requested",
          title: decision === "approved" ? "Affiliation partenaire approuvée" : "Correction demandée pour votre candidature",
          body: decision === "approved"
            ? "Votre affiliation partenaire est approuvée. Connectez-vous à l’espace de votre établissement."
            : "NEXA a examiné votre candidature. Connectez-vous pour consulter le motif et corriger votre demande.",
          url: "/candidature-partenaire.html",
        });
      } catch (error) {
        logger.error("NEXA partner affiliation notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      }
    }
    return res.status(200).json({ ok: true, uid, ...outcome });
  });

  const nexaAdminAppointments = requestHandler({ methods: ["GET"], action: "admin-appointment-list", limit: 60 }, async (req, res, admin) => {
    const rawCursor = typeof req.query?.cursor === "string" ? req.query.cursor : "";
    let cursor;
    try {
      cursor = decodeAdminCursor(rawCursor);
    } catch {
      throw new ApiError(400, "invalid-appointment-cursor", "Le repère de pagination des rendez-vous n’est pas valide.");
    }

    let query = db.collection("appointments")
      .orderBy("createdAt", "desc")
      .orderBy(FieldPath.documentId(), "desc");
    if (cursor) query = query.startAfter(new Timestamp(cursor.seconds, cursor.nanoseconds), cursor.id);
    const snapshot = await query.limit(31).get();
    const hasMore = snapshot.docs.length > 30;
    const page = snapshot.docs.slice(0, 30);
    const appointments = page.map((document) => {
      const source = document.data();
      const bookingType = source.bookingType === "home_visit"
        ? "home_visit"
        : source.bookingType === "doctor_proposed_appointment"
          ? "doctor_proposed_appointment"
          : "teleconsultation";
      const safeAmount = Number.isSafeInteger(source.amount) && source.amount >= 0 ? source.amount : 0;
      const safeFee = Number.isSafeInteger(source.transactionFee) && source.transactionFee >= 0 ? source.transactionFee : 0;
      const calculatedTotal = safeAmount + safeFee;
      return {
        appointmentId: document.id,
        providerName: cleanNursingText(source.providerName, 160) || "Professionnel NEXA",
        startsAt: appointmentIso(source.startsAt),
        endsAt: appointmentIso(source.endsAt),
        createdAt: appointmentIso(source.createdAt),
        amount: safeAmount,
        transactionFee: safeFee,
        totalAmount: Number.isSafeInteger(source.totalAmount) && source.totalAmount >= 0
          ? source.totalAmount
          : Number.isSafeInteger(calculatedTotal) ? calculatedTotal : 0,
        currency: typeof source.currency === "string" ? source.currency.slice(0, 8) : "HTG",
        status: typeof source.status === "string" ? source.status.slice(0, 48) : "UNKNOWN",
        bookingType,
        ...(bookingType === "home_visit" && typeof source.homeVisitMissionStatus === "string"
          ? { homeVisitMissionStatus: source.homeVisitMissionStatus.slice(0, 48) }
          : {}),
        ...(bookingType === "home_visit" && typeof source.homeVisitServiceId === "string"
          ? { homeVisitServiceId: source.homeVisitServiceId.slice(0, 64) }
          : {}),
        paymentStatus: typeof source.paymentStatus === "string" ? source.paymentStatus.slice(0, 32) : "UNKNOWN",
        refundRequired: source.refundRequired === true,
        refundStatus: typeof source.refundStatus === "string" ? source.refundStatus.slice(0, 48) : "",
        refundMethod: typeof source.refundMethod === "string" ? source.refundMethod.slice(0, 32) : "",
        noShowOutcome: ["PROVIDER_UNRESPONSIVE", "PATIENT_UNRESPONSIVE"].includes(String(source.noShowOutcome || ""))
          ? String(source.noShowOutcome)
          : "",
        noShowReason: typeof source.noShowReason === "string" ? source.noShowReason.slice(0, 48) : "",
        sessionStatus: typeof source.sessionStatus === "string" ? source.sessionStatus.slice(0, 48) : "",
      };
    });
    await db.collection("adminAuditLogs").doc().create({
      actorUid: admin.uid,
      action: "admin_appointments_listed",
      resultCount: page.length,
      createdAt: FieldValue.serverTimestamp(),
    });
    const last = page[page.length - 1];
    const lastCreatedAt = last?.get("createdAt");
    const nextCursor = hasMore && last && lastCreatedAt instanceof Timestamp
      ? encodeAdminCursor(lastCreatedAt, last.id)
      : null;
    return res.status(200).json({ ok: true, appointments, nextCursor });
  });

  async function listAdminAuditEvents(req, res, admin, collectionName, actionName, projectEvent, auditRead) {
    const rawCursor = typeof req.query?.cursor === "string" ? req.query.cursor : "";
    let cursor;
    try {
      cursor = decodeAdminCursor(rawCursor);
    } catch {
      throw new ApiError(400, "invalid-audit-cursor", "Le repère de pagination du journal n’est pas valide.");
    }
    let query = db.collection(collectionName)
      .orderBy("createdAt", "desc")
      .orderBy(FieldPath.documentId(), "desc");
    if (cursor) query = query.startAfter(new Timestamp(cursor.seconds, cursor.nanoseconds), cursor.id);
    const snapshot = await query.limit(41).get();
    const hasMore = snapshot.docs.length > 40;
    const page = snapshot.docs.slice(0, 40);
    const events = page.map(projectEvent);
    if (auditRead) {
      await db.collection("adminAuditLogs").doc().create({
        actorUid: admin.uid,
        action: actionName,
        resultCount: page.length,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    const last = page[page.length - 1];
    const lastCreatedAt = last?.get("createdAt");
    const nextCursor = hasMore && last && lastCreatedAt instanceof Timestamp
      ? encodeAdminCursor(lastCreatedAt, last.id)
      : null;
    return res.status(200).json({ ok: true, events, nextCursor });
  }

  const nexaAdminAuditLogs = requestHandler({ methods: ["GET"], action: "admin-audit-list", limit: 60 }, async (req, res, admin) => {
    return listAdminAuditEvents(req, res, admin, "adminAuditLogs", "admin_audit_listed", (document) => {
      const source = document.data();
      return {
        id: document.id,
        actorUid: cleanString(source.actorUid, 128),
        action: cleanString(source.action, 120) || "Action inconnue",
        resource: cleanString(source.resource, 240),
        status: cleanString(source.status, 60),
        createdAt: appointmentIso(source.createdAt),
      };
    }, false);
  });

  const nexaAdminClinicalAuditLogs = requestHandler({ methods: ["GET"], action: "admin-clinical-audit-list", limit: 60 }, async (req, res, admin) => {
    return listAdminAuditEvents(req, res, admin, "clinicalAuditLogs", "admin_clinical_audit_listed", (document) => {
      const source = document.data();
      return {
        id: document.id,
        actorUid: cleanString(source.actorUid, 128),
        action: cleanString(source.action, 120) || "Action inconnue",
        appointmentId: cleanString(source.appointmentId, 200),
        recordId: cleanString(source.recordId, 200),
        prescriptionId: cleanString(source.prescriptionId, 200),
        orderId: cleanString(source.orderId, 200),
        version: Number.isSafeInteger(source.version) ? source.version : null,
        createdAt: appointmentIso(source.createdAt),
      };
    }, true);
  });

  const nexaAdminOverview = requestHandler({ methods: ["GET"], action: "admin-overview", limit: 60 }, async (_req, res) => {
    const collectionNames = [
      "patientProfiles",
      "providerProfiles",
      "professionalApplications",
      "appointments",
      "nexaOrders",
      "diagnosticOffers",
      "homeVisitRequests",
      "pharmacyProducts",
    ];
    const [counts, openAlertCount, pharmacyPendingProducts, pharmacyOrders] = await Promise.all([
      Promise.all(collectionNames.map(async (name) => {
        const count = await db.collection(name).count().get();
        return [name, count.data().count];
      })),
      db.collection("paymentSettlementAlerts")
        .where("status", "in", ["open", "in_review"])
        .count()
        .get(),
      db.collection("pharmacyProducts")
        .where("publicationStatus", "==", "PENDING_REVIEW")
        .count()
        .get(),
      db.collection("nexaOrders")
        .where("kind", "==", "pharmacy")
        .count()
        .get(),
    ]);
    return res.status(200).json({
      ok: true,
      counts: {
        ...Object.fromEntries(counts),
        pharmacyPendingProducts: pharmacyPendingProducts.data().count,
        pharmacyOrders: pharmacyOrders.data().count,
        paymentSettlementAlerts: openAlertCount.data().count,
      },
    });
  });

  const nexaAdminAccounts = requestHandler({ methods: ["GET"], action: "admin-account-list", limit: 60 }, async (req, res, admin) => {
    const type = typeof req.query?.type === "string" ? req.query.type : "patients";
    const rawCursor = typeof req.query?.cursor === "string" ? req.query.cursor : "";
    if (!["patients", "providers", "diagnostic-partners"].includes(type)) {
      throw new ApiError(400, "invalid-account-type", "Choisissez une catégorie de comptes valide.");
    }
    if (rawCursor.length > 128 || rawCursor.includes("/")) {
      throw new ApiError(400, "invalid-account-cursor", "Le repère de pagination des comptes n’est pas valide.");
    }
    let query = db.collection(type === "patients" ? "patientProfiles" : "providerProfiles");
    if (type === "diagnostic-partners") query = query.where("type", "in", ["laboratory", "imaging"]);
    query = query.orderBy(FieldPath.documentId());
    if (rawCursor) query = query.startAfter(rawCursor);
    const snapshot = await query.limit(31).get();
    const hasMore = snapshot.docs.length > 30;
    const page = snapshot.docs.slice(0, 30);
    const accounts = page.map((document) => {
      const source = document.data();
      if (type === "patients") {
        return {
          uid: document.id,
          type: "patient",
          name: cleanString(source.displayName, 160),
          email: cleanString(source.email, 254),
          phone: cleanString(source.phone, 30),
          patientNumber: cleanString(source.patientNumber, 24),
          profileComplete: source.profileComplete === true,
          createdAt: appointmentIso(source.createdAt),
        };
      }
      const profile = source.profile && typeof source.profile === "object" && !Array.isArray(source.profile)
        ? source.profile
        : {};
      return {
        uid: document.id,
        type: cleanString(source.type, 24) || "provider",
        name: cleanString(profile.name, 160),
        specialty: cleanString(profile.specialty, 100),
        phone: cleanString(profile.publicPhone, 30),
        status: cleanString(source.status, 24) || "unknown",
        publiclyListed: source.publiclyListed === true,
        department: cleanString(profile.department, 80),
        commune: cleanString(profile.commune, 80),
        ...(["laboratory", "imaging"].includes(source.type) ? {
          address: cleanString(profile.address, 200),
          openingHours: cleanString(profile.openingHours, 300),
          services: Array.isArray(profile.services)
            ? profile.services.map((service) => cleanString(service, 100)).filter(Boolean).slice(0, 12)
            : [],
          profileRevision: diagnosticProfileRevision(profile),
        } : {}),
        createdAt: appointmentIso(source.createdAt || source.verifiedAt),
      };
    });
    await db.collection("adminAuditLogs").doc().create({
      actorUid: admin.uid,
      action: "admin_account_listed",
      accountType: type,
      resultCount: page.length,
      createdAt: FieldValue.serverTimestamp(),
    });
    return res.status(200).json({
      ok: true,
      accounts,
      nextCursor: hasMore ? page[page.length - 1]?.id || null : null,
    });
  });

  return { nexaAdminWalletRefunds, nexaAdminPaymentSettlementAlerts, nexaAdminTransactionFeeSettings, nexaAdminProfessionalCommissionSettings, nexaAdminNursingServiceSettings, nexaAdminNursingApplications, nexaAdminDoctorApplications, nexaAdminPartnerApplications, nexaAdminAppointments, nexaAdminAuditLogs, nexaAdminClinicalAuditLogs, nexaAdminOverview, nexaAdminAccounts };
};
