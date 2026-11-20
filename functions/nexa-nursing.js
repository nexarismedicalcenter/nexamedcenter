"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { FieldPath } = require("firebase-admin/firestore");

const REGION = "us-east4";
const NURSING_TIME_ZONE = "America/Port-au-Prince";
const NURSING_HOLD_MINUTES = 30;
const NURSING_CATALOG_PAGE_SIZE = 50;
const NURSING_PROVIDER_ORDER_PAGE_SIZE = 25;
const PAYMENT_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NURSING_SETTINGS_PATH = "nexaHomeCareSettings/nursing";
const NURSING_PERIODS = ["DAY", "NIGHT", "WEEKEND"];
const NURSING_BOOKING_MODES = new Set(["ONE_VISIT", "MULTIPLE_VISITS", "COORDINATE_AFTER_BOOKING"]);
const NURSING_BOOKING_MODE_TEXT = {
  ONE_VISIT: "Une visite pendant la période; son horaire sera coordonné avec l’infirmier après réservation.",
  MULTIPLE_VISITS: "Plusieurs visites pendant la période; leur calendrier sera coordonné avec l’infirmier après réservation.",
  COORDINATE_AFTER_BOOKING: "Les modalités des visites seront convenues avec l’infirmier après réservation.",
};
const NURSING_SERVICE_IDS = new Set([
  "vital_signs", "medication_administration", "wound_care", "sample_collection", "postoperative_care",
  "chronic_care", "elderly_assistance", "hygiene_comfort", "medical_devices", "therapeutic_education", "palliative_care",
]);
const NURSING_QUALIFICATIONS = new Set([
  "general_nursing", "intensive_care", "geriatrics", "pediatrics", "palliative_care", "community_health", "anesthesia", "instrumentation",
]);
const NURSING_SERVICE_LABELS = {
  vital_signs: "Prise des signes vitaux",
  medication_administration: "Administration de médicaments prescrits",
  wound_care: "Soins de plaies et pansements",
  sample_collection: "Prélèvements et collecte d’échantillons",
  postoperative_care: "Surveillance postopératoire",
  chronic_care: "Suivi de maladies chroniques",
  elderly_assistance: "Aide aux personnes âgées et mobilité",
  hygiene_comfort: "Soins d’hygiène et de confort",
  medical_devices: "Gestion d’équipements médicaux",
  therapeutic_education: "Éducation thérapeutique",
  palliative_care: "Accompagnement palliatif",
};
const NURSING_QUALIFICATION_LABELS = {
  general_nursing: "Infirmier·ère généraliste",
  intensive_care: "Soins intensifs",
  geriatrics: "Gériatrie",
  pediatrics: "Pédiatrie",
  palliative_care: "Soins palliatifs",
  community_health: "Santé communautaire",
  anesthesia: "Anesthésie",
  instrumentation: "Instrumentation",
};
const NURSING_PERIOD_LABELS = { DAY: "AM", NIGHT: "PM", WEEKEND: "Week-end" };
const WEEKDAY_LABELS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const DEFAULT_NURSING_PERIOD_RULES = {
  DAY: { daysOfWeek: [1, 2, 3, 4, 5], startTime: "08:00", endTime: "16:00", endDayOffset: 0 },
  NIGHT: { daysOfWeek: [1, 2, 3, 4, 5], startTime: "16:00", endTime: "08:00", endDayOffset: 1 },
  WEEKEND: { daysOfWeek: [6], startTime: "08:00", endTime: "08:00", endDayOffset: 2 },
};
const NURSING_LOCAL_DATE_TIME_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: NURSING_TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

function cleanText(value, maximum) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maximum) : "";
}

function normalizeTariff(value) {
  if (value === null || value === undefined || value === "") return null;
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 && amount <= 10_000_000 ? amount : null;
}

function normalizeZones(value) {
  if (!Array.isArray(value) || value.length > 200) return null;
  const ids = new Set();
  const zones = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const id = cleanText(raw.id, 40);
    const department = cleanText(raw.department, 80);
    const commune = cleanText(raw.commune, 80);
    const tariffs = raw.tariffs && typeof raw.tariffs === "object" && !Array.isArray(raw.tariffs) ? raw.tariffs : {};
    if (!/^[A-Za-z0-9-]{8,40}$/.test(id) || !department || !commune || ids.has(id)) return null;
    for (const period of NURSING_PERIODS) {
      if (tariffs[period] !== null && tariffs[period] !== undefined && tariffs[period] !== "" && normalizeTariff(tariffs[period]) === null) return null;
    }
    ids.add(id);
    zones.push({
      id,
      department,
      commune,
      active: raw.active !== false,
      tariffs: Object.fromEntries(NURSING_PERIODS.map((period) => [period, normalizeTariff(tariffs[period])])),
    });
  }
  return zones;
}

function normalizePeriodRules(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  const rules = {};
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
    rules[period] = {
      daysOfWeek: [...rule.daysOfWeek].sort((left, right) => left - right),
      startTime: rule.startTime,
      endTime: rule.endTime,
      endDayOffset: rule.endDayOffset,
    };
  }
  return rules;
}

function configuredZones(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.zones : [];
  return normalizeZones(source) || [];
}

function configuredPeriodRules(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.periodRules : null;
  return normalizePeriodRules(source) || DEFAULT_NURSING_PERIOD_RULES;
}

function validMonday(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && date.getUTCDay() === 1;
}

function normalizeProfile(value, currentYear = new Date().getUTCFullYear()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const year = Number(value.experienceStartYear);
  const serviceIds = Array.isArray(value.serviceIds) ? value.serviceIds : [];
  const zoneIds = Array.isArray(value.zoneIds) ? value.zoneIds : [];
  const rawWeeks = Array.isArray(value.weeklyAvailability) ? value.weeklyAvailability : [];
  if (!Number.isSafeInteger(year) || year < 1950 || year > currentYear || serviceIds.length < 1 || serviceIds.length > NURSING_SERVICE_IDS.size ||
    serviceIds.some((id) => typeof id !== "string" || !NURSING_SERVICE_IDS.has(id)) || new Set(serviceIds).size !== serviceIds.length ||
    zoneIds.length < 1 || zoneIds.length > 200 || zoneIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9-]{8,40}$/.test(id)) ||
    new Set(zoneIds).size !== zoneIds.length || rawWeeks.length < 1 || rawWeeks.length > 52) return null;

  const weeks = [];
  const weekStarts = new Set();
  for (const raw of rawWeeks) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !validMonday(raw.weekStart) ||
      !Array.isArray(raw.periods) || raw.periods.length < 1 || raw.periods.length > NURSING_PERIODS.length ||
      raw.periods.some((period) => !NURSING_PERIODS.includes(period)) || new Set(raw.periods).size !== raw.periods.length ||
      weekStarts.has(raw.weekStart)) return null;
    weekStarts.add(raw.weekStart);
    weeks.push({ weekStart: raw.weekStart, periods: [...raw.periods] });
  }
  weeks.sort((left, right) => left.weekStart.localeCompare(right.weekStart));
  return { experienceStartYear: year, serviceIds: [...serviceIds], zoneIds: [...zoneIds], weeklyAvailability: weeks };
}

function hasConfiguredTariffs(profile, zones) {
  const active = new Map(zones.filter((zone) => zone.active).map((zone) => [zone.id, zone]));
  return profile.zoneIds.every((id) => {
    const zone = active.get(id);
    return Boolean(zone && profile.weeklyAvailability.every((week) => week.periods.every((period) => zone.tariffs[period] !== null)));
  });
}

function getBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  if (!Buffer.isBuffer(req.rawBody)) return null;
  try {
    const body = JSON.parse(req.rawBody.toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch { return null; }
}

function haitiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Port-au-Prince", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseHaitiLocalDateTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return Number.NaN;
  const [dateText, timeText] = value.split("T");
  const [year, month, day] = dateText.split("-").map(Number);
  const [hour, minute] = timeText.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  if (!Number.isFinite(target) || hour > 23 || minute > 59) return Number.NaN;

  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(NURSING_LOCAL_DATE_TIME_FORMAT.formatToParts(new Date(candidate))
      .map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    if (`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` === value) return candidate;
    const correction = target - represented;
    if (!correction) break;
    candidate += correction;
  }
  return Number.NaN;
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nursingPeriodStart(weekStart, rule) {
  if (!validMonday(weekStart) || !rule || !Array.isArray(rule.daysOfWeek)) return Number.NaN;
  const firstWeekdayOffset = Math.min(...rule.daysOfWeek.map((weekday) => (weekday + 6) % 7));
  if (!Number.isInteger(firstWeekdayOffset)) return Number.NaN;
  const date = addDays(weekStart, firstWeekdayOffset);
  return date ? parseHaitiLocalDateTime(`${date}T${rule.startTime}`) : Number.NaN;
}

function startOfWeek(dateText) {
  const date = new Date(`${dateText}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function validNursingPhotoPath(uid, value) {
  return typeof value === "string" &&
    /^nexa-nursing-profile-photos\/[A-Za-z0-9_-]{8,128}\/[a-f0-9]{32}\.jpg$/.test(value) &&
    value.startsWith(`nexa-nursing-profile-photos/${uid}/`);
}

function describePeriodRule(rule) {
  const days = rule.daysOfWeek.map((day) => WEEKDAY_LABELS[day]);
  const dayText = days.length >= 5 && days[0] === "lundi" && days[days.length - 1] === "vendredi"
    ? "lundi–vendredi"
    : days.join(", ");
  const endNote = rule.endDayOffset === 1 ? " (le lendemain)" : rule.endDayOffset === 2 ? " (deux jours après)" : "";
  return `${dayText} · ${rule.startTime}–${rule.endTime}${endNote}`;
}

function normalizePublicQuery(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr");
}

function publicNursingProvider(providerUid, value, settings, currentWeek, unavailablePeriods = new Set(), nowMs = Date.now()) {
  if (!value || value.type !== "nurse" || value.status !== "verified" ||
    value.nursingCredentialsVerified !== true || value.serviceProfileStatus !== "APPROVED" ||
    value.nursingDirectoryListed !== true) return null;
  const rawProfile = value.profile && typeof value.profile === "object" && !Array.isArray(value.profile) ? value.profile : {};
  const photoPath = cleanText(value.nursingProfilePhotoPath, 200);
  if (!validNursingPhotoPath(providerUid, photoPath) || value.nursingProfilePhotoStatus !== "APPROVED" ||
    value.nursingProfilePhotoConsentVersion !== "nexa-nursing-photo-v1") return null;
  const name = cleanText(rawProfile.name, 120);
  const qualifications = Array.isArray(rawProfile.nursingQualifications)
    ? rawProfile.nursingQualifications.filter((item) => typeof item === "string" && NURSING_QUALIFICATIONS.has(item)).slice(0, 8)
    : [];
  const profile = normalizeProfile(value.nursingServiceProfile);
  const zones = configuredZones(settings);
  if (!name || !qualifications.length || !profile || !hasConfiguredTariffs(profile, zones)) return null;
  const periodRules = configuredPeriodRules(settings);
  const activeZones = new Map(zones.filter((zone) => zone.active).map((zone) => [zone.id, zone]));
  const weeklyAvailability = profile.weeklyAvailability
    .filter((week) => week.weekStart >= currentWeek)
    .map((week) => {
      const periods = week.periods.filter((id) => {
        const firstStart = nursingPeriodStart(week.weekStart, periodRules[id]);
        return Number.isFinite(firstStart) && firstStart > nowMs &&
          !unavailablePeriods.has(providerUid + "|" + week.weekStart + "|" + id);
      }).map((id) => ({ id, label: NURSING_PERIOD_LABELS[id], schedule: describePeriodRule(periodRules[id]) }));
      return { weekStart: week.weekStart, periods };
    })
    .filter((week) => week.periods.length > 0);
  if (!weeklyAvailability.length) return null;
  const offeredPeriods = new Set(weeklyAvailability.flatMap((week) => week.periods.map((period) => period.id)));
  const publicZones = profile.zoneIds.flatMap((id) => {
    const zone = activeZones.get(id);
    if (!zone) return [];
    const tariffs = Object.fromEntries([...offeredPeriods].map((period) => [period, zone.tariffs[period]]));
    return [{ id: zone.id, department: zone.department, commune: zone.commune, tariffs }];
  });
  if (!publicZones.length) return null;
  const experienceYears = new Date().getUTCFullYear() - profile.experienceStartYear;
  return {
    id: cleanText(providerUid, 128),
    name,
    photoPath,
    bio: cleanText(rawProfile.publicBio, 300) || undefined,
    qualifications: qualifications.map((id) => NURSING_QUALIFICATION_LABELS[id]),
    experienceYears,
    services: profile.serviceIds.map((id) => ({ id, label: NURSING_SERVICE_LABELS[id] })),
    bookingMode: NURSING_BOOKING_MODES.has(settings?.bookingMode) ? settings.bookingMode : "",
    bookingModeDescription: NURSING_BOOKING_MODE_TEXT[settings?.bookingMode] || "",
    zones: publicZones,
    weeklyAvailability,
  };
}

function nursingPaymentMatches(order, payment) {
  const amount = Number(order.amount);
  const fee = Number(order.transactionFee || 0);
  const total = Number(order.totalAmount ?? amount + fee);
  return Number.isSafeInteger(amount) && amount > 0 && Number.isSafeInteger(fee) && fee >= 0 &&
    Number.isSafeInteger(total) && total === amount + fee && Number(payment.amount) === total &&
    Number(payment.serviceAmount ?? payment.resourceAmount ?? payment.amount) === amount &&
    Number(payment.transactionFee || 0) === fee;
}

module.exports = function createNexaNursingFunctions(dependencies) {
  const {
    db, FieldValue, storage, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit,
    setCors, fail, logger, getTransactionFeePolicy, calculateTransactionAmounts, createNexaNotification,
  } = dependencies;
  const bucket = storage.bucket(process.env.NEXA_STORAGE_BUCKET || "nexaris-1339d.firebasestorage.app");

  const nexaNursingOrderCreate = onRequest({ region: REGION, maxInstances: 20 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > 12_288 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 12_288)) {
      return fail(res, 413, "request-too-large", "La demande de soins infirmiers est trop volumineuse.");
    }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "nursing-order-create", 6, 5 * 60_000);
      const body = getBody(req);
      if (!body) throw new ApiError(400, "invalid-request", "La demande de réservation n’est pas valide.");
      const providerUid = cleanText(body.providerUid, 128);
      const weekStart = cleanText(body.weekStart, 10);
      const period = cleanText(body.period, 16);
      const zoneId = cleanText(body.zoneId, 40);
      const requestId = cleanText(body.orderRequestId, 64);
      const serviceIds = Array.isArray(body.serviceIds) ? body.serviceIds : [];
      const visitDetails = body.visitDetails && typeof body.visitDetails === "object" && !Array.isArray(body.visitDetails) ? body.visitDetails : {};
      const department = cleanText(visitDetails.department, 80);
      const commune = cleanText(visitDetails.commune, 80);
      const addressLine = cleanText(visitDetails.addressLine, 220);
      const phone = cleanText(visitDetails.phone, 30);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(providerUid) || !validMonday(weekStart) || !NURSING_PERIODS.includes(period) ||
        !/^[A-Za-z0-9-]{8,40}$/.test(zoneId) || !REQUEST_ID_PATTERN.test(requestId) ||
        serviceIds.length < 1 || serviceIds.length > NURSING_SERVICE_IDS.size || serviceIds.some((id) => typeof id !== "string" || !NURSING_SERVICE_IDS.has(id)) ||
        new Set(serviceIds).size !== serviceIds.length) {
        throw new ApiError(400, "invalid-nursing-booking", "Choisissez un infirmier, une période, une semaine et au moins un service valide.");
      }
      if (!department || !commune || !addressLine || !/^\+?[0-9\s().-]{7,30}$/.test(phone)) {
        throw new ApiError(400, "nursing-visit-details-required", "Ajoutez le téléphone, le département, la commune et l’adresse où les soins seront réalisés.");
      }

      const patientRef = db.collection("patientProfiles").doc(user.uid);
      const providerRef = db.collection("providerProfiles").doc(providerUid);
      const settingsRef = db.doc(NURSING_SETTINGS_PATH);
      const slotId = createHash("sha256").update(providerUid + "|" + weekStart + "|" + period).digest("hex");
      const slotRef = db.collection("nexaNursingPeriodSlots").doc(slotId);
      const orderRef = db.collection("nexaOrders").doc();
      const paymentRef = randomBytes(24).toString("base64url");
      if (!PAYMENT_REFERENCE_PATTERN.test(paymentRef)) throw new ApiError(500, "payment-reference-failed", "La réservation ne peut pas être préparée.");
      const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
      const requestRef = db.collection("nexaNursingOrderRequests")
        .doc(createHash("sha256").update(user.uid + "|" + requestId).digest("hex"));
      const fingerprint = createHash("sha256").update(JSON.stringify({
        providerUid, weekStart, period, zoneId, serviceIds: [...serviceIds].sort(),
        department, commune, addressLine, phone,
      })).digest("hex");
      const feePolicy = await getTransactionFeePolicy("nursing_care");
      const result = await db.runTransaction(async (transaction) => {
        const [patientSnapshot, providerSnapshot, settingsSnapshot, slotSnapshot, priorSnapshot] = await Promise.all([
          transaction.get(patientRef), transaction.get(providerRef), transaction.get(settingsRef),
          transaction.get(slotRef), transaction.get(requestRef),
        ]);
        if (priorSnapshot.exists) {
          if (priorSnapshot.get("uid") !== user.uid || priorSnapshot.get("fingerprint") !== fingerprint) {
            throw new ApiError(409, "nursing-request-conflict", "Cette référence a déjà servi pour une autre réservation. Actualisez le répertoire.");
          }
          const priorResponse = priorSnapshot.get("response");
          if (!priorResponse || typeof priorResponse !== "object") throw new ApiError(409, "nursing-request-incomplete", "La réservation précédente est en cours de vérification. Consultez votre espace patient.");
          return priorResponse;
        }
        const patient = patientSnapshot.data() || {};
        if (!patientSnapshot.exists || patient.role !== "patient" || patient.profileComplete !== true ||
          !/^NMC-\d{7}$/.test(String(patient.patientNumber || ""))) {
          throw new ApiError(403, "complete-patient-profile-required", "Terminez votre profil patient avant de réserver.");
        }
        const nowMs = Date.now();
        const currentWeek = startOfWeek(haitiDate(new Date(nowMs)));
        if (weekStart < currentWeek) throw new ApiError(409, "nursing-week-past", "Cette semaine de soins est déjà passée.");
        const providerData = providerSnapshot.data() || {};
        const publicProvider = publicNursingProvider(providerUid, providerData, settingsSnapshot.data(), currentWeek, new Set(), nowMs);
        if (!publicProvider) throw new ApiError(409, "nursing-provider-unavailable", "Cet infirmier n’est plus disponible dans le répertoire NEXA.");
        const profile = normalizeProfile(providerData.nursingServiceProfile);
        const bookingMode = settingsSnapshot.get("bookingMode");
        if (!NURSING_BOOKING_MODES.has(bookingMode)) {
          throw new ApiError(409, "nursing-booking-mode-unconfigured", "NEXA doit d’abord choisir la modalité des interventions infirmières.");
        }
        const week = profile?.weeklyAvailability.find((entry) => entry.weekStart === weekStart);
        const publicWeek = publicProvider.weeklyAvailability.find((entry) => entry.weekStart === weekStart);
        if (!week || !week.periods.includes(period) || !publicWeek?.periods.some((entry) => entry.id === period)) {
          throw new ApiError(409, "nursing-period-unavailable", "Cette période n’est plus proposée ou a déjà commencé.");
        }
        const periodRule = configuredPeriodRules(settingsSnapshot.data())[period];
        const periodStartAt = nursingPeriodStart(weekStart, periodRule);
        if (!Number.isFinite(periodStartAt) || periodStartAt <= nowMs) {
          throw new ApiError(409, "nursing-period-started", "Cette période a déjà commencé ou ne peut plus être réservée.");
        }
        const holdExpiresAt = Math.min(nowMs + NURSING_HOLD_MINUTES * 60_000, periodStartAt);
        if (serviceIds.some((id) => !profile.serviceIds.includes(id))) throw new ApiError(409, "nursing-service-unavailable", "Un des services choisis n’est plus proposé par cet infirmier.");
        const zones = configuredZones(settingsSnapshot.data());
        const zone = zones.find((entry) => entry.id === zoneId && entry.active === true);
        if (!zone || !profile.zoneIds.includes(zoneId) ||
          normalizePublicQuery(zone.department) !== normalizePublicQuery(department) ||
          normalizePublicQuery(zone.commune) !== normalizePublicQuery(commune)) {
          throw new ApiError(409, "nursing-zone-unavailable", "La commune de visite ne correspond plus à une zone active de cet infirmier.");
        }
        const amount = zone.tariffs[period];
        if (!Number.isSafeInteger(amount) || amount <= 0) {
          throw new ApiError(409, "nursing-tariff-unavailable", "Le tarif de cette période n’est pas encore activé par NEXA.");
        }
        const amounts = calculateTransactionAmounts(amount, feePolicy);
        const profileData = providerData.profile && typeof providerData.profile === "object" ? providerData.profile : {};
        const providerName = cleanText(profileData.name || profileData.displayName || providerData.displayName, 120) || "Infirmier·ère NEXARIS";
        const patientName = [patient.firstName, patient.lastName].map((value) => cleanText(value, 80)).filter(Boolean).join(" ");
        const slot = slotSnapshot.data() || {};
        let expiredOrderRef = null;
        let expiredPaymentRef = null;
        let expiredOrderExists = false;
        if (slotSnapshot.exists && slot.status === "BOOKED") {
          throw new ApiError(409, "nursing-period-already-booked", "Cette période est déjà réservée par un autre patient.");
        }
        if (slotSnapshot.exists && slot.status === "HELD" && Number(slot.holdExpiresAt) > nowMs) {
          throw new ApiError(409, "nursing-period-checkout-in-progress", "Cette période est temporairement réservée pendant le paiement d’un autre patient.");
        }
        if (slotSnapshot.exists && slot.status === "HELD" && slot.orderId) {
          const expiredOrderId = cleanText(slot.orderId, 200);
          if (/^[A-Za-z0-9_-]{10,200}$/.test(expiredOrderId)) expiredOrderRef = db.collection("nexaOrders").doc(expiredOrderId);
          if (expiredOrderRef) {
            const expiredOrderSnapshot = await transaction.get(expiredOrderRef);
            expiredOrderExists = expiredOrderSnapshot.exists;
            const oldPaymentRef = expiredOrderSnapshot.get("moncashPaymentRef");
            expiredPaymentRef = typeof oldPaymentRef === "string" && PAYMENT_REFERENCE_PATTERN.test(oldPaymentRef)
              ? db.collection("paymentIntents").doc(oldPaymentRef) : null;
            if (expiredPaymentRef) await transaction.get(expiredPaymentRef);
          }
        }
        const now = FieldValue.serverTimestamp();
        if (expiredOrderRef && expiredOrderExists) transaction.set(expiredOrderRef, {
          status: "EXPIRED", paymentStatus: "EXPIRED", settlementStatus: "EXPIRED",
          expiredAt: now, updatedAt: now,
        }, { merge: true });
        if (expiredPaymentRef) transaction.set(expiredPaymentRef, { status: "expired", updatedAt: now }, { merge: true });
        const services = serviceIds.map((id) => ({ id, label: NURSING_SERVICE_LABELS[id] }));
        const periodLabel = NURSING_PERIOD_LABELS[period];
        const orderNumber = "NMC-NUR-" + orderRef.id.slice(-8).toUpperCase();
        transaction.create(orderRef, {
          kind: "nursing", workflowVersion: "nursing-period-commerce-v1", orderNumber,
          patientUid: user.uid, patientNumber: patient.patientNumber, patientName,
          patientPhone: phone, providerUid, providerType: "nurse", providerName,
          amount, subtotal: amount, transactionFee: amounts.feeAmount,
          transactionFeeRateBps: amounts.feeRateBps, transactionFeeRecipient: "NEXARIS",
          totalAmount: amounts.totalAmount, currency: "HTG", paymentMethod: "MONCASH",
          paymentStatus: "PENDING", status: "PENDING_PAYMENT", settlementStatus: "PENDING",
          moncashPaymentRef: paymentRef, holdExpiresAt, nursingSlotId: slotId,
          nursingBooking: {
            weekStart, period, periodLabel, periodSchedule: describePeriodRule(periodRule), periodRule,
            bookingMode, bookingModeDescription: NURSING_BOOKING_MODE_TEXT[bookingMode],
            zoneId, department: zone.department, commune: zone.commune, addressLine, phone,
            services, occupancy: "ONE_PATIENT_PER_NURSE_PERIOD_WEEK",
          },
          items: [{
            name: "Forfait soins infirmiers · " + periodLabel + " · semaine du " + weekStart,
            price: amount, lineTotal: amount,
          }],
          createdAt: now, updatedAt: now,
        });
        transaction.create(paymentRefDoc, {
          uid: user.uid, paymentMethod: "MONCASH", resourceType: "nursing-order",
          resourcePath: orderRef.path, amount: amounts.totalAmount, serviceAmount: amount,
          transactionFee: amounts.feeAmount, transactionFeeRateBps: amounts.feeRateBps,
          feeRecipient: "NEXARIS", currency: "HTG", status: "created", createdAt: now, updatedAt: now,
        });
        transaction.set(slotRef, {
          providerUid, weekStart, period, status: "HELD", orderId: orderRef.id, patientUid: user.uid,
          holdExpiresAt, updatedAt: now, createdAt: slotSnapshot.exists ? slot.createdAt || now : now,
        });
        transaction.create(db.collection("nexaOrderEvents").doc(), {
          orderId: orderRef.id, fromStatus: null, toStatus: "PENDING_PAYMENT",
          action: "NURSING_PERIOD_HELD", actorUid: user.uid, createdAt: now,
        });
        transaction.create(db.collection("adminAuditLogs").doc(), {
          actorUid: user.uid, action: "nursing_period_order_created", resource: orderRef.path, createdAt: now,
        });
        const response = {
          orderId: orderRef.id, orderNumber, providerUid, providerName, amount,
          transactionFee: amounts.feeAmount, totalAmount: amounts.totalAmount,
          transactionFeeRateBps: amounts.feeRateBps, feeRecipient: "NEXARIS", currency: "HTG",
          paymentRequired: true, paymentRef, holdExpiresAt, weekStart, period, periodLabel,
        };
        transaction.create(requestRef, { uid: user.uid, fingerprint, response, orderId: orderRef.id, createdAt: now });
        return response;
      });
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA nursing order create failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "nursing-order-create-failed", "La réservation infirmière ne peut pas être préparée pour le moment.");
    }
  });

  const nexaNursingOrderWalletPay = onRequest({ region: REGION, maxInstances: 20 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > 4096 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 4096)) {
      return fail(res, 413, "request-too-large", "La demande de paiement est trop volumineuse.");
    }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "pay-nursing-order-wallet", 8, 5 * 60_000);
      const orderId = cleanText(getBody(req)?.orderId, 200);
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(orderId)) throw new ApiError(400, "invalid-order", "La référence de réservation n’est pas valide.");
      const orderRef = db.collection("nexaOrders").doc(orderId);
      const outcome = await db.runTransaction(async (transaction) => {
        const orderSnapshot = await transaction.get(orderRef);
        if (!orderSnapshot.exists || orderSnapshot.get("patientUid") !== user.uid || orderSnapshot.get("kind") !== "nursing") {
          throw new ApiError(404, "nursing-order-not-found", "Cette réservation n’est pas accessible.");
        }
        const order = orderSnapshot.data() || {};
        const paymentRef = cleanText(order.moncashPaymentRef, 64);
        const slotId = cleanText(order.nursingSlotId, 64);
        if (!PAYMENT_REFERENCE_PATTERN.test(paymentRef) || !/^[a-f0-9]{64}$/.test(slotId)) {
          throw new ApiError(409, "nursing-order-payment-invalid", "Le paiement de cette réservation ne peut pas être vérifié.");
        }
        const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
        const walletRef = db.collection("nexaPatientWallets").doc(user.uid);
        const profileRef = db.collection("patientProfiles").doc(user.uid);
        const ledgerId = createHash("sha256").update("NEXA_WALLET_NURSING_ORDER:" + orderId).digest("hex");
        const ledgerRef = db.collection("nexaWalletLedger").doc(ledgerId);
        const feeLedgerRef = db.collection("nexaTransactionFeeLedger").doc(paymentRef);
        const slotRef = db.collection("nexaNursingPeriodSlots").doc(slotId);
        const eventRef = db.collection("nexaOrderEvents").doc();
        const [paymentSnapshot, walletSnapshot, profileSnapshot, ledgerSnapshot, feeSnapshot, slotSnapshot] = await Promise.all([
          transaction.get(paymentRefDoc), transaction.get(walletRef), transaction.get(profileRef),
          transaction.get(ledgerRef), transaction.get(feeLedgerRef), transaction.get(slotRef),
        ]);
        if (!paymentSnapshot.exists) throw new ApiError(409, "nursing-order-payment-invalid", "La référence de paiement n’existe plus.");
        const payment = paymentSnapshot.data() || {};
        const amount = Number(order.amount);
        const fee = Number(order.transactionFee || 0);
        const total = Number(order.totalAmount ?? amount + fee);
        const serviceMinor = amount * 100;
        const feeMinor = fee * 100;
        const totalMinor = total * 100;
        const paymentMatches = payment.uid === user.uid && payment.resourceType === "nursing-order" &&
          payment.resourcePath === orderRef.path && nursingPaymentMatches(order, payment) &&
          payment.currency === "HTG" && order.currency === "HTG";
        if (!paymentMatches || !Number.isSafeInteger(serviceMinor) || serviceMinor <= 0 ||
          !Number.isSafeInteger(feeMinor) || feeMinor < 0 || !Number.isSafeInteger(totalMinor) || totalMinor <= 0) {
          throw new ApiError(409, "nursing-order-payment-invalid", "Le montant de cette réservation ne peut pas être vérifié.");
        }
        const feeMethod = payment.paymentMethod === "MONCASH" ? "MONCASH" : "SMART_WALLET";
        const feeLedgerMatches = fee === 0 ? !feeSnapshot.exists : feeSnapshot.exists &&
          feeSnapshot.get("paymentRef") === paymentRef && feeSnapshot.get("resourceType") === "nursing-order" &&
          feeSnapshot.get("resourceId") === orderId && Number(feeSnapshot.get("serviceAmountMinor")) === serviceMinor &&
          Number(feeSnapshot.get("amountMinor")) === feeMinor && feeSnapshot.get("recipient") === "NEXARIS" &&
          feeSnapshot.get("paymentMethod") === feeMethod && feeSnapshot.get("status") === "COMPLETED";
        if (feeSnapshot.exists && !feeLedgerMatches) {
          throw new ApiError(409, "transaction-fee-ledger-conflict", "Le registre des frais ne concorde pas avec ce paiement.");
        }
        if (payment.status === "paid" && payment.paymentMethod === "MONCASH") {
          return { paymentRef, alreadyPaid: true, needsSettlement: order.settlementStatus !== "CONFIRMED", paymentMethod: "MONCASH", orderStatus: cleanText(order.status, 50) };
        }
        if (ledgerSnapshot.exists) {
          const ledger = ledgerSnapshot.data() || {};
          if (ledger.userUid !== user.uid || ledger.resourceId !== orderId || ledger.resourceType !== "nursing-order" ||
            ledger.direction !== "DEBIT" || Number(ledger.amountMinor) !== totalMinor ||
            Number(ledger.serviceAmountMinor) !== serviceMinor || Number(ledger.transactionFeeMinor || 0) !== feeMinor ||
            payment.status !== "paid" || payment.paymentMethod !== "SMART_WALLET" || !feeLedgerMatches ||
            order.status !== "PAID" || order.settlementStatus !== "CONFIRMED" ||
            !slotSnapshot.exists || slotSnapshot.get("status") !== "BOOKED" || slotSnapshot.get("orderId") !== orderId) {
            throw new ApiError(409, "wallet-ledger-conflict", "Le registre du portefeuille et la réservation ne concordent pas.");
          }
          return { paymentRef, alreadyPaid: true, needsSettlement: false, paymentMethod: "SMART_WALLET", orderStatus: cleanText(order.status, 50) };
        }
        if (!profileSnapshot.exists || profileSnapshot.get("role") !== "patient" || profileSnapshot.get("profileComplete") !== true) {
          throw new ApiError(403, "complete-patient-profile-required", "Un profil patient complet est requis.");
        }
        if (order.status !== "PENDING_PAYMENT" || order.paymentStatus !== "PENDING" || order.settlementStatus !== "PENDING") {
          throw new ApiError(409, "nursing-order-not-payable", "Cette réservation n’accepte plus de paiement Wallet.");
        }
        if (payment.status !== "created" || payment.paymentMethod !== "MONCASH") {
          throw new ApiError(409, "payment-method-already-started", "Un paiement MonCash a déjà commencé. Terminez-le ou demandez une vérification avant de choisir Wallet.");
        }
        if (Number(order.holdExpiresAt || 0) <= Date.now() || !slotSnapshot.exists ||
          slotSnapshot.get("status") !== "HELD" || slotSnapshot.get("orderId") !== orderId ||
          slotSnapshot.get("providerUid") !== order.providerUid || Number(slotSnapshot.get("holdExpiresAt")) <= Date.now()) {
          throw new ApiError(409, "nursing-period-hold-expired", "La réservation temporaire a expiré. Choisissez une nouvelle période.");
        }
        const wallet = walletSnapshot.data() || {};
        const available = Number(wallet.availableMinor || 0);
        const reserved = Number(wallet.reservedMinor || 0);
        if (!walletSnapshot.exists || wallet.status !== "ACTIVE" || wallet.currency !== "HTG" ||
          !Number.isSafeInteger(available) || available < totalMinor || !Number.isSafeInteger(reserved) || reserved < 0) {
          throw new ApiError(409, "insufficient-wallet-balance", "Le Wallet est suspendu ou son solde ne couvre pas le prix et les frais.");
        }
        const now = FieldValue.serverTimestamp();
        transaction.update(walletRef, { availableMinor: available - totalMinor, updatedAt: now });
        transaction.create(ledgerRef, {
          userUid: user.uid, walletId: user.uid, type: "NURSING_ORDER_PAYMENT", direction: "DEBIT",
          amountMinor: totalMinor, serviceAmountMinor: serviceMinor, transactionFeeMinor: feeMinor,
          currency: "HTG", resourceType: "nursing-order", resourceId: orderId,
          paymentRef, source: "NEXA", status: "COMPLETED", createdAt: now,
        });
        if (feeMinor > 0) transaction.create(feeLedgerRef, {
          paymentRef, resourceType: "nursing-order", resourceId: orderId,
          serviceAmountMinor: serviceMinor, amountMinor: feeMinor, currency: "HTG",
          recipient: "NEXARIS", transactionFeeRateBps: Number(order.transactionFeeRateBps) || 0,
          paymentMethod: "SMART_WALLET", status: "COMPLETED", createdAt: now,
        });
        transaction.set(paymentRefDoc, {
          status: "paid", paymentMethod: "SMART_WALLET", paymentProvider: "nexa-wallet",
          walletLedgerId: ledgerId, paidAt: now, updatedAt: now,
        }, { merge: true });
        transaction.set(orderRef, {
          status: "PAID", paymentStatus: "PAID", paymentMethod: "SMART_WALLET",
          settlementStatus: "CONFIRMED", paidAt: now, updatedAt: now,
        }, { merge: true });
        transaction.set(slotRef, { status: "BOOKED", holdExpiresAt: FieldValue.delete(), updatedAt: now }, { merge: true });
        transaction.create(eventRef, {
          orderId, fromStatus: "PENDING_PAYMENT", toStatus: "PAID",
          action: "NURSING_WALLET_SETTLED", actorUid: user.uid, createdAt: now,
        });
        return { paymentRef, alreadyPaid: false, needsSettlement: false, paymentMethod: "SMART_WALLET", orderStatus: "PAID", providerUid: order.providerUid };
      });
      if (outcome.paymentMethod === "MONCASH") {
        if (outcome.needsSettlement) await settlePaidNursingOrderPayment(outcome.paymentRef);
        res.set("Cache-Control", "no-store, max-age=0");
        return res.status(200).json({ ok: true, status: "paid", paymentMethod: "MONCASH", alreadyPaid: true });
      }
      if (!outcome.alreadyPaid) {
        await Promise.all([
          createNexaNotification(user.uid, "nursing-order:payment:" + outcome.paymentRef, {
            type: "order_payment_confirmed", title: "Réservation infirmière payée",
            body: "Votre période de soins infirmiers est réservée. Le professionnel peut consulter votre demande.",
            url: "/espace-patient.html#commandes",
          }),
          outcome.providerUid ? createNexaNotification(outcome.providerUid, "nursing-order:payment:" + outcome.paymentRef, {
            type: "nursing_order_received", title: "Nouvelle réservation infirmière",
            body: "Une période de soins infirmiers est réservée. Consultez votre espace professionnel.",
            url: "/espace-professionnel-infirmier.html",
          }) : Promise.resolve(),
        ]);
      }
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, status: "paid", paymentMethod: "SMART_WALLET", alreadyPaid: outcome.alreadyPaid });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA nursing Wallet payment failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "nursing-wallet-payment-failed", "Le paiement Wallet de la réservation n’a pas abouti.");
    }
  });

  async function settlePaidNursingOrderPayment(paymentRef) {
    const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
    const preview = await paymentRefDoc.get();
    if (!preview.exists || preview.get("resourceType") !== "nursing-order" ||
      preview.get("status") !== "paid" || preview.get("paymentMethod") !== "MONCASH") return null;
    const resourcePath = String(preview.get("resourcePath") || "");
    const orderMatch = resourcePath.match(/^nexaOrders\/([A-Za-z0-9_-]{1,200})$/);
    if (!orderMatch) return null;
    const orderRef = db.collection("nexaOrders").doc(orderMatch[1]);
    const orderPreview = await orderRef.get();
    const slotId = cleanText(orderPreview.get("nursingSlotId"), 64);
    const slotRef = /^[a-f0-9]{64}$/.test(slotId) ? db.collection("nexaNursingPeriodSlots").doc(slotId) : null;
    const alertRef = db.collection("paymentSettlementAlerts").doc("nursing_order_" + paymentRef);
    const feeLedgerRef = db.collection("nexaTransactionFeeLedger").doc(paymentRef);
    const eventRef = db.collection("nexaOrderEvents").doc();
    const outcome = await db.runTransaction(async (transaction) => {
      const refs = [paymentRefDoc, orderRef, alertRef, feeLedgerRef];
      if (slotRef) refs.push(slotRef);
      const snapshots = await Promise.all(refs.map((ref) => transaction.get(ref)));
      const [paymentSnapshot, orderSnapshot, alertSnapshot, feeSnapshot] = snapshots;
      const slotSnapshot = slotRef ? snapshots[4] : null;
      if (!paymentSnapshot.exists || paymentSnapshot.get("status") !== "paid" ||
        paymentSnapshot.get("paymentMethod") !== "MONCASH" || paymentSnapshot.get("resourcePath") !== resourcePath) return null;
      const payment = paymentSnapshot.data() || {};
      const order = orderSnapshot.data() || {};
      const patientUid = String(payment.uid || "");
      const fee = Number(order.transactionFee || 0);
      const amount = Number(order.amount);
      const feeMatches = fee === 0 ? !feeSnapshot.exists : !feeSnapshot.exists || (
        feeSnapshot.get("paymentRef") === paymentRef && feeSnapshot.get("resourceType") === "nursing-order" &&
        feeSnapshot.get("resourceId") === orderRef.id && Number(feeSnapshot.get("serviceAmountMinor")) === amount * 100 &&
        Number(feeSnapshot.get("amountMinor")) === fee * 100 && feeSnapshot.get("recipient") === "NEXARIS" &&
        feeSnapshot.get("paymentMethod") === "MONCASH" && feeSnapshot.get("status") === "COMPLETED");
      const slotMatches = slotSnapshot?.exists && slotSnapshot.get("orderId") === orderRef.id &&
        slotSnapshot.get("providerUid") === order.providerUid;
      const paymentMatches = orderSnapshot.exists && order.kind === "nursing" && order.patientUid === patientUid &&
        order.moncashPaymentRef === paymentRef && order.currency === "HTG" &&
        String(payment.currency || "").toUpperCase() === "HTG" && nursingPaymentMatches(order, payment);
      if (paymentMatches && feeMatches && slotMatches && order.status === "PAID" &&
        order.paymentStatus === "PAID" && order.settlementStatus === "CONFIRMED" && slotSnapshot.get("status") === "BOOKED") {
        if (fee > 0 && !feeSnapshot.exists) transaction.create(feeLedgerRef, {
          paymentRef, resourceType: "nursing-order", resourceId: orderRef.id,
          serviceAmountMinor: amount * 100, amountMinor: fee * 100, currency: "HTG",
          recipient: "NEXARIS", transactionFeeRateBps: Number(order.transactionFeeRateBps) || 0,
          paymentMethod: "MONCASH", status: "COMPLETED", createdAt: FieldValue.serverTimestamp(),
        });
        return null;
      }
      const holdActive = slotMatches && slotSnapshot.get("status") === "HELD" &&
        Number(slotSnapshot.get("holdExpiresAt")) > Date.now() && Number(order.holdExpiresAt) > Date.now();
      const refundEligible = paymentMatches && feeMatches && (!slotMatches || !holdActive) &&
        ((order.status === "PENDING_PAYMENT" && order.paymentStatus === "PENDING" && order.settlementStatus === "PENDING") ||
          (order.status === "PAYMENT_REVIEW_REQUIRED" && order.paymentStatus === "PAID" && order.settlementStatus === "REVIEW_REQUIRED" && order.refundRequired === true));
      if (!paymentMatches || !feeMatches || !holdActive ||
        order.status !== "PENDING_PAYMENT" || order.paymentStatus !== "PENDING" ||
        order.settlementStatus !== "PENDING") {
        if (paymentMatches && feeMatches && fee > 0 && !feeSnapshot.exists) transaction.create(feeLedgerRef, {
          paymentRef, resourceType: "nursing-order", resourceId: orderRef.id,
          serviceAmountMinor: amount * 100, amountMinor: fee * 100, currency: "HTG",
          recipient: "NEXARIS", transactionFeeRateBps: Number(order.transactionFeeRateBps) || 0,
          paymentMethod: "MONCASH", status: "COMPLETED", createdAt: FieldValue.serverTimestamp(),
        });
        if (!alertSnapshot.exists) transaction.create(alertRef, {
          paymentRef, resourceType: "nursing-order", resourceId: orderRef.id,
          reason: !paymentMatches ? "NURSING_ORDER_PAYMENT_MISMATCH" : !slotMatches || !holdActive
            ? "NURSING_PERIOD_NO_LONGER_HELD" : !feeMatches ? "TRANSACTION_FEE_LEDGER_MISMATCH" : "ORDER_NOT_PAYABLE_AT_SETTLEMENT",
          status: "open", createdAt: FieldValue.serverTimestamp(),
        });
        if (orderSnapshot.exists && order.patientUid === patientUid && order.moncashPaymentRef === paymentRef) {
          transaction.set(orderRef, {
            status: "PAYMENT_REVIEW_REQUIRED", paymentStatus: "PAID",
            settlementStatus: "REVIEW_REQUIRED", paidAt: order.paidAt || FieldValue.serverTimestamp(),
            ...(refundEligible ? { refundRequired: true, refundReviewReason: "NURSING_PERIOD_NO_LONGER_HELD" } : {}),
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        return { patientUid, providerUid: cleanText(order.providerUid, 128), confirmed: false };
      }
      if (fee > 0 && !feeSnapshot.exists) transaction.create(feeLedgerRef, {
        paymentRef, resourceType: "nursing-order", resourceId: orderRef.id,
        serviceAmountMinor: amount * 100, amountMinor: fee * 100,
        currency: "HTG", recipient: "NEXARIS",
        transactionFeeRateBps: Number(order.transactionFeeRateBps) || 0,
        paymentMethod: "MONCASH", status: "COMPLETED", createdAt: FieldValue.serverTimestamp(),
      });
      const now = FieldValue.serverTimestamp();
      transaction.set(orderRef, {
        status: "PAID", paymentStatus: "PAID", settlementStatus: "CONFIRMED",
        paidAt: order.paidAt || now, updatedAt: now,
      }, { merge: true });
      transaction.set(slotRef, { status: "BOOKED", holdExpiresAt: FieldValue.delete(), updatedAt: now }, { merge: true });
      transaction.create(eventRef, {
        orderId: orderRef.id, fromStatus: "PENDING_PAYMENT", toStatus: "PAID",
        action: "NURSING_MONCASH_SETTLED", actorUid: "system:moncash", createdAt: now,
      });
      return { patientUid, providerUid: cleanText(order.providerUid, 128), confirmed: true };
    });
    if (outcome?.patientUid) {
      await createNexaNotification(outcome.patientUid, "nursing-order:payment:" + paymentRef, {
        type: outcome.confirmed ? "order_payment_confirmed" : "order_payment_reconciliation",
        title: outcome.confirmed ? "Réservation infirmière confirmée" : "Paiement à rapprocher",
        body: outcome.confirmed
          ? "Votre période de soins infirmiers est réservée."
          : "Le paiement est reçu, mais NEXA doit vérifier la disponibilité de cette période. Ne payez pas une seconde fois.",
        url: "/espace-patient.html#commandes",
      });
      if (outcome.confirmed && outcome.providerUid) await createNexaNotification(outcome.providerUid, "nursing-order:payment:" + paymentRef, {
        type: "nursing_order_received", title: "Nouvelle réservation infirmière",
        body: "Une période de soins infirmiers est réservée. Consultez votre espace professionnel.",
        url: "/espace-professionnel-infirmier.html",
      });
    }
    return outcome;
  }

  const nexaNursingProviderOrders = onRequest({ region: REGION, maxInstances: 20 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") { res.set("Allow", "GET, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "nursing-provider-orders-read", 30, 5 * 60_000);
      const provider = await db.collection("providerProfiles").doc(user.uid).get();
      if (!provider.exists || provider.get("type") !== "nurse" || provider.get("status") !== "verified" ||
        provider.get("nursingCredentialsVerified") !== true) {
        throw new ApiError(403, "verified-nurse-required", "Un profil infirmier vérifié est requis.");
      }
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : "";
      if (cursor && (cursor.length > 200 || cursor.includes("/") || /[\u0000-\u001f\u007f]/.test(cursor))) {
        throw new ApiError(400, "invalid-nursing-order-cursor", "La pagination des réservations n’est pas valide.");
      }
      let cursorSnapshot = null;
      if (cursor) {
        cursorSnapshot = await db.collection("nexaOrders").doc(cursor).get();
        if (!cursorSnapshot.exists || cursorSnapshot.get("providerUid") !== user.uid || cursorSnapshot.get("kind") !== "nursing" ||
          !["PAID", "ACCEPTED", "IN_PROGRESS", "COMPLETED"].includes(String(cursorSnapshot.get("status"))) ||
          typeof cursorSnapshot.get("createdAt")?.toMillis !== "function") {
          throw new ApiError(400, "invalid-nursing-order-cursor", "Actualisez les réservations avant de continuer.");
        }
      }
      let ordersQuery = db.collection("nexaOrders").where("providerUid", "==", user.uid)
        .where("kind", "==", "nursing")
        .where("status", "in", ["PAID", "ACCEPTED", "IN_PROGRESS", "COMPLETED"])
        .orderBy("createdAt", "desc");
      if (cursorSnapshot) ordersQuery = ordersQuery.startAfter(cursorSnapshot);
      const snapshot = await ordersQuery.limit(NURSING_PROVIDER_ORDER_PAGE_SIZE + 1).get();
      const hasMore = snapshot.docs.length > NURSING_PROVIDER_ORDER_PAGE_SIZE;
      const page = snapshot.docs.slice(0, NURSING_PROVIDER_ORDER_PAGE_SIZE);
      const orders = page.map((doc) => {
          const data = doc.data() || {};
          const booking = data.nursingBooking && typeof data.nursingBooking === "object" ? data.nursingBooking : {};
          return {
            id: doc.id, orderNumber: cleanText(data.orderNumber, 80), status: cleanText(data.status, 50),
            paymentStatus: cleanText(data.paymentStatus, 30), patientNumber: cleanText(data.patientNumber, 20),
            patientName: cleanText(data.patientName, 160), patientPhone: cleanText(data.patientPhone, 30),
            booking: {
              weekStart: cleanText(booking.weekStart, 10), period: cleanText(booking.period, 16),
              periodLabel: cleanText(booking.periodLabel, 40), periodSchedule: cleanText(booking.periodSchedule, 100),
              bookingMode: cleanText(booking.bookingMode, 40),
              bookingModeDescription: cleanText(booking.bookingModeDescription, 200),
              department: cleanText(booking.department, 80), commune: cleanText(booking.commune, 80),
              addressLine: cleanText(booking.addressLine, 220), phone: cleanText(booking.phone, 30),
              services: Array.isArray(booking.services) ? booking.services.map((item) => ({
                id: cleanText(item?.id, 50), label: cleanText(item?.label, 120),
              })).filter((item) => item.id && item.label) : [],
            },
          };
        });
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, orders, hasMore, nextCursor: hasMore && page.length ? page[page.length - 1].id : null });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA nursing provider orders failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "nursing-orders-unavailable", "Les réservations infirmières ne sont pas accessibles pour le moment.");
    }
  });

  const nexaNursingPublicCatalog = onRequest({ region: "us-east4" }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") {
      res.set("Allow", "GET, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    const queryText = typeof req.query.q === "string" ? cleanText(req.query.q, 100) : "";
    const departmentText = typeof req.query.department === "string" ? cleanText(req.query.department, 80) : "";
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : "";
    if (cursor && (cursor.length > 128 || !/^[A-Za-z0-9_-]+$/.test(cursor))) {
      return fail(res, 400, "invalid-nursing-catalog-cursor", "Le repère du répertoire infirmier n’est pas valide.");
    }
    try {
      await requireAppCheckToken(req);
      const nowMs = Date.now();
      const currentWeek = startOfWeek(haitiDate(new Date(nowMs)));
      const lastWeek = new Date(currentWeek + "T12:00:00.000Z");
      lastWeek.setUTCDate(lastWeek.getUTCDate() + 26 * 7);
      const lastAvailableWeek = lastWeek.toISOString().slice(0, 10);
      let providersQuery = db.collection("providerProfiles")
        .where("type", "==", "nurse")
        .orderBy(FieldPath.documentId());
      if (cursor) providersQuery = providersQuery.startAfter(cursor);
      const [snapshot, settingsSnapshot] = await Promise.all([
        providersQuery.limit(NURSING_CATALOG_PAGE_SIZE + 1).get(),
        db.doc(NURSING_SETTINGS_PATH).get(),
      ]);
      const hasMore = snapshot.docs.length > NURSING_CATALOG_PAGE_SIZE;
      const page = snapshot.docs.slice(0, NURSING_CATALOG_PAGE_SIZE);
      const providerUids = page.map((doc) => doc.id).filter((uid) => /^[A-Za-z0-9_-]{1,128}$/.test(uid));
      const slotSnapshots = await Promise.all(Array.from({ length: Math.ceil(providerUids.length / 30) }, (_, batchIndex) => {
        const batch = providerUids.slice(batchIndex * 30, batchIndex * 30 + 30);
        return db.collection("nexaNursingPeriodSlots")
          .where("providerUid", "in", batch)
          .where("weekStart", ">=", currentWeek)
          .where("weekStart", "<=", lastAvailableWeek)
          .get();
      }));
      const slotDocs = slotSnapshots.flatMap((slotSnapshot) => slotSnapshot.docs);
      const unavailablePeriods = new Set(slotDocs.filter((doc) =>
        doc.get("status") === "BOOKED" ||
        (doc.get("status") === "HELD" && Number(doc.get("holdExpiresAt")) > nowMs),
      ).map((doc) => [doc.get("providerUid"), doc.get("weekStart"), doc.get("period")]
        .map((value) => cleanText(value, 128)).join("|")));
      const query = normalizePublicQuery(queryText);
      const department = normalizePublicQuery(departmentText);
      const publicEntries = page
        .map((doc) => publicNursingProvider(doc.id, doc.data(), settingsSnapshot.data(), currentWeek, unavailablePeriods, nowMs))
        .filter((item) => item !== null)
        .filter((item) => {
          const words = normalizePublicQuery([
            item.name,
            ...item.qualifications,
            ...item.services.map((service) => service.label),
            ...item.zones.flatMap((zone) => [zone.commune, zone.department]),
          ].join(" "));
          return (!query || words.includes(query)) &&
            (!department || item.zones.some((zone) => normalizePublicQuery(zone.department).includes(department)));
        });
      const results = (await Promise.all(publicEntries.map(async (item) => {
        try {
          const photoFile = bucket.file(item.photoPath);
          const [metadata] = await photoFile.getMetadata();
          if (metadata.contentType !== "image/jpeg" || metadata.metadata?.nexaScanStatus !== "CLEAN" ||
            metadata.metadata?.nexaOwnerUid !== item.id || metadata.metadata?.nexaConsentVersion !== "nexa-nursing-photo-v1") return null;
          const [photoUrl] = await photoFile.getSignedUrl({ action: "read", expires: Date.now() + 5 * 60_000 });
          const { photoPath, ...publicItem } = item;
          return { ...publicItem, photoUrl };
        } catch {
          return null;
        }
      }))).filter(Boolean);
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({
        ok: true,
        results,
        hasMore,
        nextCursor: hasMore && page.length ? page[page.length - 1].id : null,
      });
    } catch (error) {
      logger.error("NEXA nursing public catalog failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 503, "nursing-catalog-unavailable", "Le répertoire infirmier n’est pas disponible pour le moment.");
    }
  });

  const nexaNursingServiceProfile = onRequest({ region: "us-east4" }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) {
      res.set("Allow", "GET, POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if ((Number(req.get("Content-Length")) || 0) > 32_768 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 32_768)) {
      return fail(res, 413, "request-too-large", "Le profil infirmier dépasse la taille autorisée.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      const providerRef = db.collection("providerProfiles").doc(user.uid);
      const provider = await providerRef.get();
      if (!provider.exists || provider.get("type") !== "nurse" || provider.get("status") !== "verified" || provider.get("nursingCredentialsVerified") !== true) {
        throw new ApiError(403, "verified-nurse-required", "Seul un profil infirmier NEXA dont les qualifications ont été vérifiées peut compléter ces informations.");
      }
      res.set("Cache-Control", "no-store, max-age=0");

      if (req.method === "GET") {
        const settingsSnapshot = await db.doc(NURSING_SETTINGS_PATH).get();
        const profile = provider.get("nursingServiceProfile") || null;
        const year = new Date().getUTCFullYear();
        const startYear = Number(profile?.experienceStartYear);
        const qualifications = provider.get("profile.nursingQualifications");
        return res.status(200).json({
          ok: true,
          profile,
          zones: configuredZones(settingsSnapshot.data()).filter((zone) => zone.active),
          periodRules: configuredPeriodRules(settingsSnapshot.data()),
          serviceProfileStatus: String(provider.get("serviceProfileStatus") || "INCOMPLETE"),
          serviceProfileReviewReason: typeof provider.get("serviceProfileReviewReason") === "string" ? provider.get("serviceProfileReviewReason") : "",
          experienceYears: Number.isSafeInteger(startYear) ? Math.max(0, year - startYear) : null,
          currentYear: year,
          qualifications: Array.isArray(qualifications) ? qualifications.filter((item) => typeof item === "string" && NURSING_QUALIFICATIONS.has(item)).slice(0, 8) : [],
        });
      }

      await enforceUserRateLimit(user.uid, "save-nursing-service-profile", 12, 5 * 60_000);
      const body = getBody(req);
      const profile = normalizeProfile(body);
      if (!profile) throw new ApiError(400, "invalid-nursing-service-profile", "Complétez une année d’expérience, au moins un service, une zone et une disponibilité hebdomadaire valide.");

      const settingsSnapshot = await db.doc(NURSING_SETTINGS_PATH).get();
      const zones = configuredZones(settingsSnapshot.data());
      const activeZoneIds = new Set(zones.filter((zone) => zone.active).map((zone) => zone.id));
      if (profile.zoneIds.some((id) => !activeZoneIds.has(id))) {
        throw new ApiError(409, "nursing-zone-unavailable", "Une des zones sélectionnées n’est plus proposée par NEXA. Actualisez la page et choisissez une zone active.");
      }

      const currentWeek = startOfWeek(haitiDate());
      const lastWeek = new Date(`${currentWeek}T12:00:00.000Z`);
      lastWeek.setUTCDate(lastWeek.getUTCDate() + 26 * 7);
      if (profile.weeklyAvailability.some((week) => week.weekStart < currentWeek || week.weekStart > lastWeek.toISOString().slice(0, 10))) {
        throw new ApiError(400, "nursing-week-out-of-range", "Choisissez une semaine à partir de cette semaine et dans les six prochains mois.");
      }

      const serviceProfileStatus = hasConfiguredTariffs(profile, zones) ? "PENDING_REVIEW" : "INCOMPLETE";
      await db.runTransaction(async (transaction) => {
        const fresh = await transaction.get(providerRef);
        if (!fresh.exists || fresh.get("type") !== "nurse" || fresh.get("status") !== "verified" || fresh.get("nursingCredentialsVerified") !== true) {
          throw new ApiError(403, "verified-nurse-required", "Le statut de votre profil a changé. Contactez l’administration NEXA.");
        }
        transaction.set(providerRef, {
          nursingServiceProfile: profile,
          serviceProfileStatus,
          publiclyListed: false,
          nursingDirectoryListed: false,
          serviceProfileReviewReason: FieldValue.delete(),
          serviceProfileReviewedAt: FieldValue.delete(),
          serviceProfileReviewedBy: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      await db.collection("adminAuditLogs").add({
        actorUid: user.uid,
        action: "nursing_service_profile_saved",
        resource: `providerProfiles/${user.uid}`,
        status: serviceProfileStatus,
        createdAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({
        ok: true,
        profile,
        serviceProfileStatus,
        message: serviceProfileStatus === "PENDING_REVIEW"
          ? "Votre profil est transmis à NEXA pour vérification avant sa publication."
          : "Votre profil est enregistré. NEXA doit d’abord configurer les tarifs des périodes choisies; il restera invisible jusque-là.",
      });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA nursing service profile failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "nursing-profile-unavailable", "Le profil infirmier n’est pas accessible pour le moment.");
    }
  });

  const nexaNursingApplication = onRequest({ region: "us-east4" }, async (req, res) => {
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
      await enforceUserRateLimit(user.uid, req.method === "GET" ? "read-nursing-application-status" : "submit-nursing-application", req.method === "GET" ? 30 : 4, 10 * 60_000);
      res.set("Cache-Control", "no-store, max-age=0");
      if (req.method === "GET") {
        const applicationSnapshot = await db.collection("professionalApplications").doc(user.uid).get();
        if (!applicationSnapshot.exists) return res.status(200).json({ ok: true, status: "not_submitted" });
        const application = applicationSnapshot.data() || {};
        if (application.uid !== user.uid || application.providerType !== "nurse") {
          return res.status(200).json({ ok: true, status: "other_application" });
        }
        const savedProfile = application.profile && typeof application.profile === "object" && !Array.isArray(application.profile) ? application.profile : {};
        const submittedAt = application.submittedAt && typeof application.submittedAt.toDate === "function"
          ? application.submittedAt.toDate().toISOString()
          : null;
        const status = ["pending", "approved", "rejected"].includes(application.status) ? application.status : "unknown";
        return res.status(200).json({
          ok: true,
          status,
          reviewNote: status === "rejected" ? cleanText(application.reviewNote, 500) : "",
          submittedAt,
          ...(status === "rejected" ? {
            profile: {
              name: cleanText(savedProfile.name, 120),
              phone: cleanText(savedProfile.publicPhone, 30),
              department: cleanText(savedProfile.department, 80),
              commune: cleanText(savedProfile.commune, 80),
              publicBio: cleanText(savedProfile.publicBio, 300),
              nursingQualifications: Array.isArray(savedProfile.nursingQualifications)
                ? savedProfile.nursingQualifications.filter((item) => typeof item === "string" && NURSING_QUALIFICATIONS.has(item)).slice(0, 8)
                : [],
            },
          } : {}),
        });
      }
      if (!user.email) throw new ApiError(400, "email-required", "Une adresse e-mail est nécessaire pour déposer une candidature.");
      const body = getBody(req);
      if (!body) throw new ApiError(400, "invalid-request", "La requête est invalide.");

      const readRequiredText = (value, maximum) => {
        if (typeof value !== "string") return "";
        const text = value.trim();
        return text && text.length <= maximum ? text : "";
      };
      const name = readRequiredText(body.name, 120);
      const phone = readRequiredText(body.phone, 30);
      const department = readRequiredText(body.department, 80);
      const commune = readRequiredText(body.commune, 80);
      const publicBio = typeof body.publicBio === "string" ? body.publicBio.trim() : "";
      const qualifications = Array.isArray(body.nursingQualifications) ? body.nursingQualifications : [];
      if (!name || !phone || !department || !commune || publicBio.length > 300 ||
        !/^\+?[0-9\s().-]{7,30}$/.test(phone) || body.termsAccepted !== true) {
        throw new ApiError(400, "invalid-nursing-application", "Vérifiez les coordonnées, la présentation et l’acceptation des conditions.");
      }
      if (qualifications.length < 1 || qualifications.length > NURSING_QUALIFICATIONS.size ||
        qualifications.some((item) => typeof item !== "string" || !NURSING_QUALIFICATIONS.has(item)) ||
        new Set(qualifications).size !== qualifications.length) {
        throw new ApiError(400, "nursing-qualification-required", "Choisissez au moins une qualification infirmière valide.");
      }

      const applicationRef = db.collection("professionalApplications").doc(user.uid);
      const providerRef = db.collection("providerProfiles").doc(user.uid);
      const result = await db.runTransaction(async (transaction) => {
        const [applicationSnapshot, providerSnapshot] = await Promise.all([
          transaction.get(applicationRef),
          transaction.get(providerRef),
        ]);
        if (providerSnapshot.exists && providerSnapshot.get("status") === "verified") {
          throw new ApiError(409, "provider-already-verified", "Ce compte dispose déjà d’un profil professionnel vérifié.");
        }
        const previous = applicationSnapshot.data() || {};
        if (previous.status === "pending") {
          if (previous.providerType === "nurse") return { applicationId: applicationRef.id, alreadySubmitted: true };
          throw new ApiError(409, "other-application-pending", "Une autre candidature professionnelle est déjà en cours pour ce compte.");
        }
        if (previous.status === "approved") {
          throw new ApiError(409, "application-already-approved", "Cette candidature a déjà été approuvée. Connectez-vous à votre espace infirmier.");
        }
        if (providerSnapshot.exists && providerSnapshot.get("type") !== "nurse") {
          throw new ApiError(409, "provider-type-conflict", "Ce compte possède déjà un autre type de profil professionnel.");
        }

        transaction.set(applicationRef, {
          uid: user.uid,
          email: user.email,
          providerType: "nurse",
          profile: {
            name,
            publicBio,
            publicPhone: phone,
            department,
            commune,
            nursingQualifications: [...qualifications],
          },
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
          action: "nursing_affiliation_application_submitted",
          resource: `professionalApplications/${user.uid}`,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      return res.status(200).json({ ok: true, ...result, status: "pending" });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA nursing application failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "nursing-application-unavailable", "La candidature infirmière n’a pas pu être envoyée pour le moment.");
    }
  });

  return {
    nexaNursingOrderCreate,
    nexaNursingOrderWalletPay,
    nexaNursingProviderOrders,
    settlePaidNursingOrderPayment,
    nexaNursingPublicCatalog,
    nexaNursingServiceProfile,
    nexaNursingApplication,
  };
};
