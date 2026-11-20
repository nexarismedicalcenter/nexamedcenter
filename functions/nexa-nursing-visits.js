"use strict";

const { createHash, randomInt, timingSafeEqual } = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { FieldPath, Timestamp } = require("firebase-admin/firestore");

const REGION = "us-east4";
const TIME_ZONE = "America/Port-au-Prince";
const SERVICE_IDS = new Set([
  "vital_signs", "medication_administration", "wound_care", "sample_collection", "postoperative_care",
  "chronic_care", "elderly_assistance", "hygiene_comfort", "medical_devices", "therapeutic_education", "palliative_care",
]);
const COMPLETIONS = new Set(["COMPLETED", "PARTIAL", "NOT_COMPLETED"]);
const RATING_KEYS = ["quality", "professionalism", "punctuality", "courtesyRespect", "satisfaction"];
const PATIENT_NURSING_REPORT_PAGE_SIZE = 25;
const PROVIDER_NURSING_VISIT_PAGE_SIZE = 50;
const PATIENT_NURSING_VISIT_PAGE_SIZE = 25;
const ADMIN_NURSING_VISIT_REVIEW_PAGE_SIZE = 25;
const ADMIN_REASONS = new Set(["IDENTITY_MISMATCH", "SERVICE_PARTIAL", "SERVICE_NOT_COMPLETED", "PRESENCE_DISPUTED", "OTHER"]);
const NURSING_PHOTO_CONSENT_VERSION = "nexa-nursing-photo-v1";

function getBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  if (!Buffer.isBuffer(req.rawBody)) return null;
  try {
    const value = JSON.parse(req.rawBody.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function cleanText(value, maximum) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maximum) : "";
}

function cleanClinicalText(value, maximum) {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n").map((line) => line.replace(/\s+/g, " ").trim()).join("\n").trim().slice(0, maximum);
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function codeHash(visitId, code) { return hash(`NEXA_NURSING_VISIT:${visitId}:${code}`); }
function iso(value) { return value && typeof value.toDate === "function" ? value.toDate().toISOString() : typeof value === "string" ? value : null; }
function validRating(value) { return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null; }

function decodeNursingVisitReviewCursor(value, ApiError) {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApiError(400, "invalid-nursing-review-cursor", "Le repère de pagination des prestations infirmières n’est pas valide.");
  }
  let cursor;
  try { cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch {
    throw new ApiError(400, "invalid-nursing-review-cursor", "Le repère de pagination des prestations infirmières n’est pas valide.");
  }
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) ||
    Object.keys(cursor).sort().join(",") !== "id,nanoseconds,seconds" ||
    !Number.isSafeInteger(cursor.seconds) || !Number.isSafeInteger(cursor.nanoseconds) ||
    cursor.nanoseconds < 0 || cursor.nanoseconds >= 1_000_000_000 ||
    typeof cursor.id !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(cursor.id)) {
    throw new ApiError(400, "invalid-nursing-review-cursor", "Le repère de pagination des prestations infirmières n’est pas valide.");
  }
  return cursor;
}

function encodeNursingVisitReviewCursor(document) {
  const submittedAt = document.get("feedbackSummary.submittedAt");
  if (!submittedAt || !Number.isSafeInteger(submittedAt.seconds) || !Number.isSafeInteger(submittedAt.nanoseconds)) return null;
  return Buffer.from(JSON.stringify({
    seconds: submittedAt.seconds,
    nanoseconds: submittedAt.nanoseconds,
    id: document.id,
  }), "utf8").toString("base64url");
}

function validNursingPhotoPath(uid, value) {
  return typeof uid === "string" && typeof value === "string" &&
    /^nexa-nursing-profile-photos\/[A-Za-z0-9_-]{8,128}\/[a-f0-9]{32}\.jpg$/.test(value) &&
    value.startsWith(`nexa-nursing-profile-photos/${uid}/`);
}

function haitiParts(epoch) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(epoch));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function parseHaitiLocalDateTime(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const [dateText, timeText] = value.split("T");
  const [year, month, day] = dateText.split("-").map(Number);
  const [hour, minute] = timeText.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  if (!Number.isFinite(target) || hour > 23 || minute > 59) return null;
  for (let offsetMinutes = -720; offsetMinutes <= 840; offsetMinutes += 15) {
    const candidate = target - offsetMinutes * 60_000;
    const parts = haitiParts(candidate);
    if (`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}` === value) return candidate;
  }
  return null;
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validMonday(dateText) {
  if (typeof dateText !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateText)) return false;
  const date = new Date(`${dateText}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === dateText && date.getUTCDay() === 1;
}

function validPeriodRule(value) {
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.daysOfWeek) ||
    value.daysOfWeek.length < 1 || value.daysOfWeek.length > 7 ||
    value.daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6) ||
    new Set(value.daysOfWeek).size !== value.daysOfWeek.length || !timePattern.test(String(value.startTime || "")) ||
    !timePattern.test(String(value.endTime || "")) || !Number.isInteger(value.endDayOffset) || value.endDayOffset < 0 || value.endDayOffset > 2 ||
    (value.endDayOffset === 0 && value.endTime <= value.startTime)) return null;
  return value;
}

function scheduledInPeriod(scheduledAt, booking) {
  const monday = cleanText(booking.weekStart, 10);
  const rule = validPeriodRule(booking.periodRule);
  if (!validMonday(monday) || !rule) return false;
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const startDate = addDays(monday, dayIndex);
    const weekday = (dayIndex + 1) % 7;
    if (!rule.daysOfWeek.includes(weekday)) continue;
    const startAt = parseHaitiLocalDateTime(`${startDate}T${rule.startTime}`);
    const endDate = addDays(startDate, rule.endDayOffset);
    const endAt = parseHaitiLocalDateTime(`${endDate}T${rule.endTime}`);
    if (Number.isFinite(startAt) && Number.isFinite(endAt) && scheduledAt >= startAt && scheduledAt < endAt) return true;
  }
  return false;
}

function makeCode() { return String(randomInt(0, 100_000_000)).padStart(8, "0"); }

module.exports = function createNexaNursingVisitFunctions(dependencies) {
  const {
    db, FieldValue, storage, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit,
    setCors, fail, logger, createNexaNotification, sendNursingVisitCodeEmail,
  } = dependencies;
  const bucket = storage.bucket(process.env.NEXA_STORAGE_BUCKET || "nexaris-1339d.firebasestorage.app");

  async function notify(uid, key, notification) {
    if (!uid || typeof createNexaNotification !== "function") return;
    try { await createNexaNotification(uid, key, notification); }
    catch (error) { logger.warn("NEXA nursing visit notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }); }
  }

  async function verifiedNurse(uid) {
    const snapshot = await db.collection("providerProfiles").doc(uid).get();
    if (!snapshot.exists || snapshot.get("type") !== "nurse" || snapshot.get("status") !== "verified" || snapshot.get("nursingCredentialsVerified") !== true) {
      throw new ApiError(403, "verified-nurse-required", "Un profil infirmier vérifié est requis.");
    }
    return snapshot.data() || {};
  }

  async function requireAdmin(req, action) {
    const user = await requireUser(req);
    await requireAppCheckToken(req);
    const allowlist = new Set(String(process.env.NEXA_ADMIN_UIDS || "").split(",").map((value) => value.trim()).filter(Boolean));
    if (!allowlist.size) throw new ApiError(503, "admin-access-not-configured", "L’accès administrateur NEXA n’est pas configuré.");
    if (!allowlist.has(user.uid)) throw new ApiError(403, "administrator-required", "Accès administrateur requis.");
    await enforceUserRateLimit(user.uid, action, 20, 60_000);
    return user;
  }

  async function readOrderMap(visitDocs) {
    const ids = [...new Set(visitDocs.map((doc) => cleanText(doc.get("orderId"), 200)).filter((id) => /^[A-Za-z0-9_-]{10,200}$/.test(id)))];
    const snapshots = [];
    for (let index = 0; index < ids.length; index += 80) {
      snapshots.push(...await db.getAll(...ids.slice(index, index + 80).map((id) => db.collection("nexaOrders").doc(id))));
    }
    return new Map(snapshots.map((snapshot) => [snapshot.id, snapshot.exists ? snapshot.data() || {} : null]));
  }

  function effectiveVisitStatus(visit, order) {
    if (!order || order.kind !== "nursing") return cleanText(visit.status, 40);
    if (order.paymentStatus === "REFUNDED" || order.refundStatus === "COMPLETED") return "REFUNDED";
    if (order.refundRequired === true || order.settlementStatus === "REVIEW_REQUIRED") {
      return order.requestedRefundMethod === "CASH_MANUAL" || order.refundStatus === "PENDING_MANUAL_CASH"
        ? "CASH_REFUND_PENDING" : "REFUND_PENDING_ADMIN";
    }
    return cleanText(visit.status, 40);
  }

  const nexaNursingVisitPlan = onRequest({ region: REGION, maxInstances: 15 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!(["GET", "POST"].includes(req.method))) { res.set("Allow", "GET, POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      if (req.method === "GET") {
        await enforceUserRateLimit(user.uid, "nursing-provider-visits-read", 30, 5 * 60_000);
        await verifiedNurse(user.uid);
        const visitsRef = db.collection("nexaNursingVisits");
        const cursor = typeof req.query.cursor === "string" ? req.query.cursor.trim() : "";
        if ((req.query.cursor != null && !cursor) || (cursor && !/^[A-Za-z0-9_-]{10,200}$/.test(cursor))) {
          throw new ApiError(400, "invalid-nursing-visit-cursor", "La page de prestations demandée n’est pas valide.");
        }
        let visitQuery = visitsRef.where("providerUid", "==", user.uid).orderBy("scheduledAt", "asc");
        if (cursor) {
          const cursorSnapshot = await visitsRef.doc(cursor).get();
          if (!cursorSnapshot.exists || cursorSnapshot.get("providerUid") !== user.uid ||
            typeof cursorSnapshot.get("scheduledAt") !== "string" || !Number.isFinite(Date.parse(cursorSnapshot.get("scheduledAt")))) {
            throw new ApiError(400, "invalid-nursing-visit-cursor", "La page de prestations demandée n’est plus disponible.");
          }
          visitQuery = visitQuery.startAfter(cursorSnapshot);
        }
        const pageSnapshot = await visitQuery.limit(PROVIDER_NURSING_VISIT_PAGE_SIZE + 1).get();
        const hasMore = pageSnapshot.docs.length > PROVIDER_NURSING_VISIT_PAGE_SIZE;
        const visitDocs = pageSnapshot.docs.slice(0, PROVIDER_NURSING_VISIT_PAGE_SIZE);
        const ordersById = await readOrderMap(visitDocs);
        const visits = visitDocs.map((doc) => {
          const data = doc.data() || {};
          const status = effectiveVisitStatus(data, ordersById.get(cleanText(data.orderId, 200)));
          return {
            visitId: doc.id, orderId: cleanText(data.orderId, 200), orderNumber: cleanText(data.orderNumber, 80),
            patientNumber: cleanText(data.patientNumber, 20), patientName: cleanText(data.patientName, 160),
            patientPhone: cleanText(data.patientPhone, 30), addressLine: cleanText(data.addressLine, 220),
            commune: cleanText(data.commune, 80), department: cleanText(data.department, 80),
            weekStart: cleanText(data.weekStart, 10), periodLabel: cleanText(data.periodLabel, 40),
            bookingModeDescription: cleanText(data.bookingModeDescription, 200), serviceIds: Array.isArray(data.serviceIds) ? data.serviceIds.filter((id) => SERVICE_IDS.has(id)) : [],
            serviceLabels: Array.isArray(data.serviceLabels) ? data.serviceLabels.map((label) => cleanText(label, 120)).filter(Boolean) : [],
            scheduledAt: cleanText(data.scheduledAt, 40), status,
          };
        });
        res.set("Cache-Control", "no-store, max-age=0");
        return res.status(200).json({
          ok: true, visits, hasMore,
          nextCursor: hasMore && visitDocs.length ? visitDocs[visitDocs.length - 1].id : "",
        });
      }

      if ((Number(req.get("Content-Length")) || 0) > 8_192 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 8_192)) {
        return fail(res, 413, "request-too-large", "La demande de planification est trop volumineuse.");
      }
      await enforceUserRateLimit(user.uid, "nursing-visit-plan-create", 10, 10 * 60_000);
      const providerProfile = await verifiedNurse(user.uid);
      const body = getBody(req);
      const orderId = cleanText(body?.orderId, 200);
      const requestId = cleanText(body?.requestId, 64);
      const scheduledLocal = cleanText(body?.scheduledLocal, 16);
      const scheduledAt = parseHaitiLocalDateTime(scheduledLocal);
      const serviceIds = Array.isArray(body?.serviceIds) ? body.serviceIds : [];
      if (!body || Object.keys(body).some((key) => !["orderId", "requestId", "scheduledLocal", "serviceIds"].includes(key)) ||
        !/^[A-Za-z0-9_-]{10,200}$/.test(orderId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ||
        !Number.isFinite(scheduledAt) || scheduledAt <= Date.now() || serviceIds.length < 1 || serviceIds.length > SERVICE_IDS.size ||
        serviceIds.some((id) => typeof id !== "string" || !SERVICE_IDS.has(id)) || new Set(serviceIds).size !== serviceIds.length) {
        throw new ApiError(400, "invalid-nursing-visit-plan", "Vérifiez la date convenue et les soins de cette visite.");
      }
      const orderRef = db.collection("nexaOrders").doc(orderId);
      const visitRef = db.collection("nexaNursingVisits").doc();
      const requestRef = db.collection("nexaNursingVisitRequests").doc(hash(`${user.uid}|${orderId}|${requestId}`));
      const fingerprint = hash(JSON.stringify({ orderId, scheduledLocal, serviceIds: [...serviceIds].sort() }));
      const providerName = cleanText(providerProfile.profile?.name, 120) || "Infirmier·ère NEXA";
      const result = await db.runTransaction(async (transaction) => {
        const [requestSnapshot, orderSnapshot] = await Promise.all([transaction.get(requestRef), transaction.get(orderRef)]);
        if (requestSnapshot.exists) {
          const saved = requestSnapshot.data() || {};
          if (saved.uid !== user.uid || saved.fingerprint !== fingerprint || !saved.response) throw new ApiError(409, "nursing-visit-request-conflict", "Cette demande de planification a déjà servi avec d’autres informations.");
          return { ...saved.response, alreadyCreated: true, patientUid: saved.patientUid };
        }
        if (!orderSnapshot.exists || orderSnapshot.get("kind") !== "nursing" || orderSnapshot.get("providerUid") !== user.uid) {
          throw new ApiError(404, "nursing-order-not-found", "Cette réservation ne vous est pas attribuée.");
        }
        const order = orderSnapshot.data() || {};
        if (order.paymentStatus !== "PAID" || !["PAID", "IN_PROGRESS"].includes(String(order.status || "")) || order.refundRequired === true) {
          throw new ApiError(409, "nursing-order-not-active", "La réservation doit être payée et active avant de convenir d’une visite.");
        }
        const booking = order.nursingBooking && typeof order.nursingBooking === "object" ? order.nursingBooking : {};
        if (!scheduledInPeriod(scheduledAt, booking)) throw new ApiError(400, "nursing-visit-outside-period", "La date doit rester dans la période infirmière réservée, en heure d’Haïti.");
        const offered = new Map((Array.isArray(booking.services) ? booking.services : []).map((service) => [service?.id, cleanText(service?.label, 120)]));
        if (serviceIds.some((id) => !offered.has(id))) throw new ApiError(409, "nursing-visit-service-invalid", "Une prestation choisie ne figure pas dans cette réservation.");
        const mode = cleanText(booking.bookingMode, 40);
        if (!new Set(["ONE_VISIT", "MULTIPLE_VISITS", "COORDINATE_AFTER_BOOKING"]).has(mode)) throw new ApiError(409, "nursing-booking-mode-invalid", "La modalité de cette réservation ne peut pas être vérifiée.");
        const visitCount = Number.isSafeInteger(order.nursingVisitCount) && order.nursingVisitCount >= 0 ? order.nursingVisitCount : 0;
        if (mode === "ONE_VISIT" && visitCount >= 1) throw new ApiError(409, "nursing-one-visit-already-planned", "Une visite est déjà planifiée pour cette période.");
        const patientUid = cleanText(order.patientUid, 128);
        const visit = {
          orderId, orderNumber: cleanText(order.orderNumber, 80), patientUid,
          patientNumber: cleanText(order.patientNumber, 20), patientName: cleanText(order.patientName, 160),
          patientPhone: cleanText(booking.phone || order.patientPhone, 30), providerUid: user.uid, providerName,
          weekStart: cleanText(booking.weekStart, 10), period: cleanText(booking.period, 16),
          periodLabel: cleanText(booking.periodLabel, 40), bookingMode: mode,
          bookingModeDescription: cleanText(booking.bookingModeDescription, 200),
          department: cleanText(booking.department, 80), commune: cleanText(booking.commune, 80),
          addressLine: cleanText(booking.addressLine, 220), serviceIds: [...serviceIds],
          serviceLabels: serviceIds.map((id) => offered.get(id)), scheduledLocal, scheduledAt: new Date(scheduledAt).toISOString(),
          status: "SCHEDULED", createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        };
        const response = { visitId: visitRef.id, orderId, orderNumber: visit.orderNumber, scheduledAt: visit.scheduledAt, status: visit.status };
        transaction.create(visitRef, visit);
        transaction.set(orderRef, { nursingVisitCount: visitCount + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        transaction.create(requestRef, { uid: user.uid, patientUid, fingerprint, response, createdAt: FieldValue.serverTimestamp() });
        transaction.create(db.collection("nexaOrderEvents").doc(), {
          orderId, fromStatus: order.status, toStatus: order.status, action: "NURSING_VISIT_SCHEDULED",
          actorUid: user.uid, visitId: visitRef.id, createdAt: FieldValue.serverTimestamp(),
        });
        return { ...response, patientUid, alreadyCreated: false };
      });
      if (!result.alreadyCreated && result.patientUid) await notify(result.patientUid, `nursing-visit:${result.visitId}:scheduled`, {
        type: "nursing_visit_scheduled", title: "Visite infirmière planifiée",
        body: "Votre infirmier a enregistré l’horaire convenu pour une prestation de votre période réservée. Consultez votre espace patient.",
        url: "/espace-patient.html#commandes",
      });
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, ...result, patientUid: undefined });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA nursing visit plan failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "nursing-visit-plan-failed", "La visite infirmière ne peut pas être planifiée pour le moment.");
    }
  });

  const nexaPatientNursingVisits = onRequest({ region: REGION, maxInstances: 15 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") { res.set("Allow", "GET, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "patient-nursing-visits-read", 30, 5 * 60_000);
      const patient = await db.collection("patientProfiles").doc(user.uid).get();
      if (!patient.exists || patient.get("role") !== "patient" || patient.get("profileComplete") !== true) throw new ApiError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
      const requestedCursor = req.query.cursor;
      if (requestedCursor !== undefined &&
        (typeof requestedCursor !== "string" || requestedCursor.length > 200 || !/^[A-Za-z0-9_-]{10,200}$/.test(requestedCursor))) {
        throw new ApiError(400, "invalid-patient-nursing-visit-cursor", "La pagination des prestations infirmières n’est pas valide.");
      }
      const visitsRef = db.collection("nexaNursingVisits");
      let visitQuery = visitsRef.where("patientUid", "==", user.uid).orderBy("scheduledAt", "desc");
      if (requestedCursor) {
        const cursorSnapshot = await visitsRef.doc(requestedCursor).get();
        if (!cursorSnapshot.exists || cursorSnapshot.get("patientUid") !== user.uid ||
          typeof cursorSnapshot.get("scheduledAt") !== "string" || !Number.isFinite(Date.parse(cursorSnapshot.get("scheduledAt")))) {
          throw new ApiError(400, "invalid-patient-nursing-visit-cursor", "Actualisez la liste avant de continuer.");
        }
        visitQuery = visitQuery.startAfter(cursorSnapshot);
      }
      const pageSnapshot = await visitQuery.limit(PATIENT_NURSING_VISIT_PAGE_SIZE + 1).get();
      const hasMore = pageSnapshot.docs.length > PATIENT_NURSING_VISIT_PAGE_SIZE;
      const visitDocs = pageSnapshot.docs.slice(0, PATIENT_NURSING_VISIT_PAGE_SIZE);
      const ordersById = await readOrderMap(visitDocs);
      const providerUids = [...new Set(visitDocs.map((doc) => cleanText(doc.get("providerUid"), 128)).filter((uid) => /^[A-Za-z0-9_-]{8,128}$/.test(uid)))];
      const providerSnapshots = [];
      for (let index = 0; index < providerUids.length; index += 80) {
        providerSnapshots.push(...await db.getAll(...providerUids.slice(index, index + 80).map((uid) => db.collection("providerProfiles").doc(uid))));
      }
      const providersByUid = new Map(providerSnapshots.map((provider) => [provider.id, provider.exists ? provider.data() || {} : null]));
      const providerPhotoUrls = new Map();
      for (let index = 0; index < providerUids.length; index += 20) {
        const batch = await Promise.all(providerUids.slice(index, index + 20).map(async (providerUid) => {
          const provider = providersByUid.get(providerUid) || {};
          const photoPath = cleanText(provider.nursingProfilePhotoPath, 200);
          if (provider.type !== "nurse" || provider.status !== "verified" || provider.nursingCredentialsVerified !== true ||
            provider.nursingProfilePhotoStatus !== "APPROVED" || provider.nursingProfilePhotoConsentVersion !== NURSING_PHOTO_CONSENT_VERSION ||
            !validNursingPhotoPath(providerUid, photoPath)) return [providerUid, ""];
          try {
            const photoFile = bucket.file(photoPath);
            const [metadata] = await photoFile.getMetadata();
            if (metadata.contentType !== "image/jpeg" || metadata.metadata?.nexaScanStatus !== "CLEAN" ||
              metadata.metadata?.nexaOwnerUid !== providerUid || metadata.metadata?.nexaConsentVersion !== NURSING_PHOTO_CONSENT_VERSION) {
              return [providerUid, ""];
            }
            const [photoUrl] = await photoFile.getSignedUrl({ action: "read", expires: Date.now() + 5 * 60_000 });
            return [providerUid, photoUrl];
          } catch (error) {
            logger.warn("NEXA nursing visit photo unavailable", { errorName: error instanceof Error ? error.name : "unknown-error" });
            return [providerUid, ""];
          }
        }));
        for (const [providerUid, photoUrl] of batch) providerPhotoUrls.set(providerUid, photoUrl);
      }
      const visits = visitDocs.map((doc) => {
        const data = doc.data() || {};
        const status = effectiveVisitStatus(data, ordersById.get(cleanText(data.orderId, 200)));
        const providerUid = cleanText(data.providerUid, 128);
        return {
          visitId: doc.id, orderId: cleanText(data.orderId, 200), orderNumber: cleanText(data.orderNumber, 80),
          providerName: cleanText(data.providerName, 120), scheduledAt: cleanText(data.scheduledAt, 40),
          providerPhotoUrl: providerPhotoUrls.get(providerUid) || "",
          periodLabel: cleanText(data.periodLabel, 40), serviceLabels: Array.isArray(data.serviceLabels) ? data.serviceLabels.map((label) => cleanText(label, 120)).filter(Boolean) : [],
          status, patientCode: status === "AWAITING_PROVIDER_CODE" ? cleanText(data.patientCode, 8) : "",
        };
      });
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({
        ok: true, visits, hasMore,
        nextCursor: hasMore && visitDocs.length ? visitDocs[visitDocs.length - 1].id : "",
      });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA patient nursing visits read failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "patient-nursing-visits-unavailable", "Vos visites infirmières ne sont pas accessibles pour le moment.");
    }
  });

  const nexaPatientNursingVisitReports = onRequest({ region: REGION, maxInstances: 15 }, async (req, res) => {
    res.set("Cache-Control", "no-store, max-age=0");
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") { res.set("Allow", "GET, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "patient-nursing-report-library", 20, 5 * 60_000);
      const patient = await db.collection("patientProfiles").doc(user.uid).get();
      if (!patient.exists || patient.get("role") !== "patient" || patient.get("profileComplete") !== true ||
        !/^NMC-\d{7}$/.test(String(patient.get("patientNumber") || ""))) {
        throw new ApiError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
      }

      const requestedCursor = req.query.cursor;
      if (requestedCursor !== undefined && (typeof requestedCursor !== "string" || requestedCursor.length > 200 || !/^[A-Za-z0-9_-]{10,200}$/.test(requestedCursor))) {
        throw new ApiError(400, "invalid-nursing-report-cursor", "La pagination des comptes rendus infirmiers n’est pas valide.");
      }
      const reportsCollection = db.collection("nexaNursingVisitReports");
      let cursorSnapshot = null;
      if (requestedCursor) {
        cursorSnapshot = await reportsCollection.doc(requestedCursor).get();
        if (!cursorSnapshot.exists || cursorSnapshot.get("patientUid") !== user.uid) {
          throw new ApiError(400, "invalid-nursing-report-cursor", "Actualisez la liste des comptes rendus avant de continuer.");
        }
      }
      let query = reportsCollection
        .where("patientUid", "==", user.uid)
        .orderBy("createdAt", "desc")
        .limit(PATIENT_NURSING_REPORT_PAGE_SIZE + 1);
      if (cursorSnapshot) query = query.startAfter(cursorSnapshot);
      const snapshot = await query.get();
      const pageDocuments = snapshot.docs.slice(0, PATIENT_NURSING_REPORT_PAGE_SIZE);
      const visitSnapshots = pageDocuments.length
        ? await db.getAll(...pageDocuments.map((document) => db.collection("nexaNursingVisits").doc(document.id)))
        : [];
      const careSnapshots = pageDocuments.length
        ? await db.getAll(...pageDocuments.map((document) => db.collection("nexaNursingCareRecords").doc(document.id)))
        : [];
      const orderIds = [...new Set(visitSnapshots.map((visit) => cleanText(visit.get("orderId"), 200)).filter((id) => /^[A-Za-z0-9_-]{10,200}$/.test(id)))];
      const orderSnapshots = orderIds.length
        ? await db.getAll(...orderIds.map((id) => db.collection("nexaOrders").doc(id)))
        : [];
      const ordersById = new Map(orderSnapshots.map((order) => [order.id, order.exists ? order.data() || {} : null]));
      const reports = pageDocuments.flatMap((document, index) => {
        const report = document.data() || {};
        const visitSnapshot = visitSnapshots[index];
        const careSnapshot = careSnapshots[index];
        if (!visitSnapshot?.exists || report.patientUid !== user.uid || report.visitId !== document.id ||
          report.orderId !== visitSnapshot.get("orderId") || report.providerUid !== visitSnapshot.get("providerUid") ||
          visitSnapshot.get("patientUid") !== user.uid) return [];
        const visit = visitSnapshot.data() || {};
        const order = ordersById.get(cleanText(visit.orderId, 200));
        if (!order || order.kind !== "nursing" || order.patientUid !== user.uid || order.providerUid !== visit.providerUid) return [];
        const ratings = report.ratings && typeof report.ratings === "object" && !Array.isArray(report.ratings) ? report.ratings : {};
        const signature = report.signature && typeof report.signature === "object" && !Array.isArray(report.signature) ? report.signature : {};
        let nursingCareRecord = null;
        if (careSnapshot?.exists) {
          const careRecord = careSnapshot.data() || {};
          if (careRecord.visitId === document.id && careRecord.patientUid === user.uid &&
            careRecord.providerUid === visit.providerUid && careRecord.orderId === visit.orderId && visit.status === "COMPLETED") {
            const careSignature = careRecord.signature && typeof careRecord.signature === "object" && !Array.isArray(careRecord.signature)
              ? careRecord.signature
              : {};
            nursingCareRecord = {
              performedServiceLabels: Array.isArray(careRecord.performedServiceLabels)
                ? careRecord.performedServiceLabels.map((label) => cleanText(label, 120)).filter(Boolean)
                : [],
              summary: cleanClinicalText(careRecord.summary, 3_000),
              providerName: cleanText(careSignature.name, 120) || cleanText(visit.providerName, 120) || "Infirmier·ère NEXA",
              signedAt: iso(careSignature.signedAt),
            };
          }
        }
        return [{
          visitId: document.id,
          orderNumber: cleanText(visit.orderNumber, 80),
          providerName: cleanText(visit.providerName, 120) || "Infirmier·ère NEXA",
          scheduledAt: cleanText(visit.scheduledAt, 40),
          periodLabel: cleanText(visit.periodLabel, 40),
          serviceLabels: Array.isArray(visit.serviceLabels) ? visit.serviceLabels.map((label) => cleanText(label, 120)).filter(Boolean) : [],
          status: effectiveVisitStatus(visit, order),
          providerPresent: typeof report.providerPresent === "boolean" ? report.providerPresent : null,
          identityMatched: typeof report.identityMatched === "boolean" ? report.identityMatched : null,
          serviceCompletion: COMPLETIONS.has(report.serviceCompletion) ? report.serviceCompletion : "UNKNOWN",
          visitStartedAt: iso(report.visitStartedAt),
          visitEndedAt: iso(report.visitEndedAt),
          ratings: Object.fromEntries(RATING_KEYS.map((key) => [key, validRating(ratings[key])])),
          comment: cleanText(report.comment, 500),
          signature: {
            name: cleanText(signature.name, 160),
            signerRole: ["PATIENT", "REPRESENTATIVE"].includes(signature.signerRole) ? signature.signerRole : "",
            signedAt: iso(signature.signedAt),
            consented: signature.consented === true,
          },
          nursingCareRecord,
          submittedAt: iso(report.createdAt),
        }];
      });
      const hasMore = snapshot.docs.length > PATIENT_NURSING_REPORT_PAGE_SIZE;
      const nextCursor = hasMore && pageDocuments.length ? pageDocuments[pageDocuments.length - 1].id : null;
      await db.collection("clinicalAuditLogs").doc().create({
        actorUid: user.uid,
        action: "patient_nursing_visit_report_library_accessed",
        recordCount: reports.length,
        hasMore,
        createdAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ ok: true, reports, hasMore, nextCursor });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA patient nursing visit report history failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "patient-nursing-reports-unavailable", "Vos comptes rendus de soins infirmiers ne sont pas accessibles pour le moment.");
    }
  });

  const nexaPatientNursingVisitFeedback = onRequest({ region: REGION, maxInstances: 15 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > 8_192 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 8_192)) return fail(res, 413, "request-too-large", "Le formulaire dépasse la taille autorisée.");
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "submit-nursing-visit-feedback", 5, 10 * 60_000);
      const body = getBody(req);
      const allowed = new Set(["visitId", "providerPresent", "identityMatched", "serviceCompletion", "visitStartedLocal", "visitEndedLocal", "ratings", "comment", "signatureName", "signerRole", "patientConfirmed", "signatureConsent", "refundMethod"]);
      const visitId = cleanText(body?.visitId, 200);
      if (!body || Object.keys(body).some((key) => !allowed.has(key)) || !/^[A-Za-z0-9_-]{10,200}$/.test(visitId)) throw new ApiError(400, "invalid-nursing-feedback", "La référence ou les champs du formulaire ne sont pas valides.");
      const present = body.providerPresent === true;
      const identityMatched = body.identityMatched === true;
      const completion = cleanText(body.serviceCompletion, 32);
      const signatureName = cleanText(body.signatureName, 160);
      const signerRole = body.signerRole === "REPRESENTATIVE" ? "REPRESENTATIVE" : body.signerRole === "PATIENT" ? "PATIENT" : "";
      const refundMethod = body.refundMethod === "CASH_MANUAL" ? "CASH_MANUAL" : "NEXA_WALLET";
      const ratingsInput = body.ratings && typeof body.ratings === "object" && !Array.isArray(body.ratings) ? body.ratings : {};
      const ratings = Object.fromEntries(RATING_KEYS.map((key) => [key, validRating(ratingsInput[key])]));
      const startsAt = parseHaitiLocalDateTime(cleanText(body.visitStartedLocal, 16));
      const endsAt = parseHaitiLocalDateTime(cleanText(body.visitEndedLocal, 16));
      if (body.patientConfirmed !== true || body.signatureConsent !== true || !signatureName || !signerRole || !COMPLETIONS.has(completion)) {
        throw new ApiError(400, "nursing-feedback-incomplete", "Confirmez les réponses et la signature électronique, puis indiquez l’état des soins.");
      }
      if (!present && (identityMatched || completion !== "NOT_COMPLETED")) throw new ApiError(400, "nursing-absence-report-invalid", "Une absence doit être déclarée comme prestation non réalisée.");
      if (present && (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || startsAt >= endsAt || endsAt > Date.now() || RATING_KEYS.some((key) => ratings[key] === null))) {
        throw new ApiError(400, "nursing-feedback-times-invalid", "Pour une visite réalisée, indiquez les horaires et toutes les évaluations.");
      }
      const discrepancy = !present || !identityMatched || completion !== "COMPLETED";
      if (!discrepancy && refundMethod === "CASH_MANUAL") throw new ApiError(400, "cash-refund-not-needed", "Une demande de remboursement n’est pas disponible pour une prestation confirmée.");

      const visitRef = db.collection("nexaNursingVisits").doc(visitId);
      const reportRef = db.collection("nexaNursingVisitReports").doc(visitId);
      const reportAuditRef = db.collection("paymentAuditLogs").doc();
      const code = discrepancy ? "" : makeCode();
      let result = null;
      await db.runTransaction(async (transaction) => {
        const [visitSnapshot, reportSnapshot, patientSnapshot] = await Promise.all([
          transaction.get(visitRef), transaction.get(reportRef), transaction.get(db.collection("patientProfiles").doc(user.uid)),
        ]);
        if (!patientSnapshot.exists || patientSnapshot.get("role") !== "patient" || patientSnapshot.get("profileComplete") !== true) throw new ApiError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
        if (!visitSnapshot.exists || visitSnapshot.get("patientUid") !== user.uid) throw new ApiError(404, "nursing-visit-not-found", "Cette prestation n’est pas accessible.");
        if (reportSnapshot.exists) throw new ApiError(409, "nursing-feedback-already-submitted", "Le formulaire de cette prestation a déjà été envoyé.");
        const visit = visitSnapshot.data() || {};
        if (visit.status !== "SCHEDULED" || Date.now() < Date.parse(String(visit.scheduledAt || ""))) throw new ApiError(409, "nursing-visit-not-ready", "Le compte rendu devient disponible à partir de l’horaire convenu.");
        const orderRef = db.collection("nexaOrders").doc(cleanText(visit.orderId, 200));
        const cashAlertRef = db.collection("paymentSettlementAlerts").doc(`nursing_visit_cash_${visit.orderId}`);
        const [orderSnapshot, priorAlert] = await Promise.all([
          transaction.get(orderRef),
          refundMethod === "CASH_MANUAL" && discrepancy ? transaction.get(cashAlertRef) : Promise.resolve(null),
        ]);
        if (!orderSnapshot.exists || orderSnapshot.get("kind") !== "nursing" || orderSnapshot.get("patientUid") !== user.uid ||
          orderSnapshot.get("providerUid") !== visit.providerUid || orderSnapshot.get("paymentStatus") !== "PAID" || orderSnapshot.get("refundRequired") === true) {
          throw new ApiError(409, "nursing-order-not-active", "Le paiement de cette période ne permet plus de confirmer une prestation.");
        }
        const now = FieldValue.serverTimestamp();
        const nextStatus = !discrepancy ? "AWAITING_PROVIDER_CODE" : refundMethod === "CASH_MANUAL" ? "CASH_REFUND_PENDING" : "ADMIN_REVIEW_REQUIRED";
        transaction.create(reportRef, {
          visitId, orderId: visit.orderId, patientUid: user.uid, providerUid: visit.providerUid,
          providerPresent: present, identityMatched, serviceCompletion: completion,
          ...(present ? { visitStartedAt: new Date(startsAt).toISOString(), visitEndedAt: new Date(endsAt).toISOString(), ratings } : {}),
          comment: cleanText(body.comment, 500), patientConfirmed: true,
          signature: { name: signatureName, signerRole, consented: true, signedAt: now }, createdAt: now, updatedAt: now,
        });
        transaction.set(visitRef, {
          status: nextStatus, feedbackSummary: {
            providerPresent: present, identityMatched, serviceCompletion: completion,
            ...(present ? { visitStartedAt: new Date(startsAt).toISOString(), visitEndedAt: new Date(endsAt).toISOString(), ratings } : {}),
            patientConfirmed: true, submittedAt: now,
          },
          ...(code ? { patientCode: code, patientCodeHash: codeHash(visitId, code), codeIssuedAt: now } : {}),
          ...(nextStatus === "CASH_REFUND_PENDING" ? { requestedRefundMethod: "CASH_MANUAL" } : {}),
          updatedAt: now,
        }, { merge: true });
        if (nextStatus === "CASH_REFUND_PENDING") {
          if (priorAlert?.exists && ["manual_cash_refund_confirmed", "manual_moncash_refund_confirmed"].includes(String(priorAlert.get("resolution") || ""))) {
            throw new ApiError(409, "nursing-refund-already-recorded", "Un remboursement externe est déjà enregistré pour cette période.");
          }
          transaction.set(orderRef, {
            status: "PAYMENT_REVIEW_REQUIRED", settlementStatus: "REVIEW_REQUIRED", refundRequired: true,
            refundStatus: "PENDING_MANUAL_CASH", requestedRefundMethod: "CASH_MANUAL", refundRequestStatus: "REQUESTED",
            refundRequestedAt: now, refundReviewReason: "NURSING_PATIENT_REPORTED_VISIT", updatedAt: now,
            nursingReviewVisitId: visitId,
          }, { merge: true });
          transaction.set(cashAlertRef, {
            paymentRef: cleanText(orderSnapshot.get("moncashPaymentRef"), 64), resourceType: "nursing-order", resourceId: visit.orderId,
            reason: "NURSING_PATIENT_CASH_REFUND_REQUESTED", requestedRefundMethod: "CASH_MANUAL",
            refundRequestedByUid: user.uid, refundRequestedAt: now, status: "open",
            createdAt: priorAlert?.exists ? priorAlert.get("createdAt") : now,
          }, { merge: true });
        }
        transaction.create(reportAuditRef, {
          actorUid: user.uid, action: discrepancy ? "nursing_visit_patient_report_requires_review" : "nursing_visit_patient_report_submitted",
          resource: `nexaNursingVisits/${visitId}`, createdAt: now,
        });
        result = { status: nextStatus, providerUid: visit.providerUid, orderId: visit.orderId, visitId };
      });
      await notify(result.providerUid, `nursing-visit:${visitId}:patient-report`, {
        type: "nursing_visit_patient_report", title: result.status === "AWAITING_PROVIDER_CODE" ? "Compte rendu patient reçu" : "Prestation infirmière à suivre par NEXA",
        body: result.status === "AWAITING_PROVIDER_CODE"
          ? "Le patient a confirmé la prestation. Saisissez son code de clôture dans votre espace infirmier."
          : result.status === "CASH_REFUND_PENDING"
            ? "Le patient a signalé un écart et demandé un remboursement en espèces; l’administration NEXA traitera la demande manuellement."
            : "Le patient a signalé un écart de présence, d’identité ou de réalisation. NEXA examinera la prestation.",
        url: "/espace-professionnel-infirmier.html",
      });
      if (code) {
        await notify(user.uid, `nursing-visit:${visitId}:patient-code`, {
          type: "nursing_visit_code_issued", title: "Code de clôture de la prestation infirmière",
          body: "Consultez votre espace patient. Remettez le code à l’infirmier seulement après avoir vérifié son identité et confirmé le soin.",
          url: "/espace-patient.html#commandes",
        });
        if (typeof sendNursingVisitCodeEmail === "function") await sendNursingVisitCodeEmail(user.uid, visitId, code);
      }
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, visitStatus: result.status, ...(code ? { patientCode: code } : {}) });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA nursing visit feedback failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "nursing-feedback-failed", "Le compte rendu infirmier ne peut pas être enregistré.");
    }
  });

  const nexaNursingVisitClose = onRequest({ region: REGION, maxInstances: 15 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > 8_192 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 8_192)) return fail(res, 413, "request-too-large", "La requête dépasse la taille autorisée.");
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "close-nursing-visit", 30, 10 * 60_000);
      await verifiedNurse(user.uid);
      const body = getBody(req);
      const visitId = cleanText(body?.visitId, 200);
      const code = cleanText(body?.code, 8);
      const careServiceIds = Array.isArray(body?.careServiceIds) ? body.careServiceIds : [];
      const careSummary = cleanClinicalText(body?.careSummary, 3_000);
      if (!body || Object.keys(body).some((key) => !["visitId", "code", "careServiceIds", "careSummary"].includes(key)) ||
        !/^[A-Za-z0-9_-]{10,200}$/.test(visitId) || !/^\d{8}$/.test(code) ||
        !Array.isArray(body.careServiceIds) || careServiceIds.length > SERVICE_IDS.size ||
        careServiceIds.some((id) => typeof id !== "string" || !SERVICE_IDS.has(id)) || new Set(careServiceIds).size !== careServiceIds.length ||
        careSummary.length < 10 || careSummary.length > 3_000) {
        throw new ApiError(400, "invalid-nursing-visit-report", "Indiquez le code patient, les soins effectués et un compte rendu utile avant de clôturer.");
      }
      const visitRef = db.collection("nexaNursingVisits").doc(visitId);
      const reportRef = db.collection("nexaNursingVisitReports").doc(visitId);
      const careRecordRef = db.collection("nexaNursingCareRecords").doc(visitId);
      const attemptsRef = db.collection("nexaNursingVisitCodeAttempts").doc(visitId);
      const auditRef = db.collection("paymentAuditLogs").doc();
      const clinicalAuditRef = db.collection("clinicalAuditLogs").doc();
      let patientUid = "";
      let outcome = "";
      await db.runTransaction(async (transaction) => {
        const [visitSnapshot, reportSnapshot, attemptsSnapshot, careRecordSnapshot] = await Promise.all([
          transaction.get(visitRef), transaction.get(reportRef), transaction.get(attemptsRef), transaction.get(careRecordRef),
        ]);
        if (!visitSnapshot.exists || visitSnapshot.get("providerUid") !== user.uid) throw new ApiError(404, "nursing-visit-not-found", "Cette prestation ne vous est pas attribuée.");
        const visit = visitSnapshot.data() || {};
        if (visit.status !== "AWAITING_PROVIDER_CODE" || !reportSnapshot.exists) throw new ApiError(409, "nursing-visit-not-ready", "Le compte rendu patient doit être confirmé avant la clôture.");
        if (careRecordSnapshot.exists) throw new ApiError(409, "nursing-care-record-already-exists", "Un compte rendu infirmier est déjà enregistré pour cette prestation.");
        const report = reportSnapshot.data() || {};
        const adminApproved = visit.adminDecision === "ALLOW_CODE_CLOSURE" && typeof visit.adminReviewedByUid === "string" && Boolean(visit.adminReviewedByUid);
        if (report.providerUid !== user.uid || report.providerPresent !== true || report.patientConfirmed !== true ||
          (!adminApproved && (report.identityMatched !== true || report.serviceCompletion !== "COMPLETED"))) {
          throw new ApiError(409, "nursing-visit-review-required", "NEXA doit examiner le compte rendu avant la clôture.");
        }
        const plannedServiceIds = Array.isArray(visit.serviceIds) ? visit.serviceIds.filter((id) => SERVICE_IDS.has(id)) : [];
        if (careServiceIds.some((id) => !plannedServiceIds.includes(id)) ||
          (report.serviceCompletion === "COMPLETED" && careServiceIds.length === 0) ||
          (report.serviceCompletion === "NOT_COMPLETED" && careServiceIds.length > 0)) {
          throw new ApiError(400, "nursing-care-services-invalid", "Les soins consignés doivent correspondre aux services planifiés et à l’état confirmé par le patient.");
        }
        const orderRef = db.collection("nexaOrders").doc(cleanText(visit.orderId, 200));
        const orderSnapshot = await transaction.get(orderRef);
        if (!orderSnapshot.exists || orderSnapshot.get("paymentStatus") !== "PAID" || orderSnapshot.get("refundRequired") === true) throw new ApiError(409, "nursing-order-not-active", "La réservation infirmière n’est plus active.");
        const now = Date.now();
        const prior = attemptsSnapshot.data() || {};
        if (Number(prior.blockedUntilMs) > now) { outcome = "locked"; return; }
        const withinWindow = Number(prior.windowStartedAtMs) > 0 && now - Number(prior.windowStartedAtMs) < 10 * 60_000;
        const attempts = withinWindow ? Number(prior.attempts) || 0 : 0;
        if (attempts >= 5) {
          transaction.set(attemptsRef, { blockedUntilMs: now + 10 * 60_000, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
          outcome = "locked";
          return;
        }
        const storedHash = typeof visit.patientCodeHash === "string" ? visit.patientCodeHash : "";
        const submittedHash = codeHash(visitId, code);
        const storedBytes = /^[a-f0-9]{64}$/.test(storedHash) ? Buffer.from(storedHash, "hex") : Buffer.alloc(32);
        if (!timingSafeEqual(storedBytes, Buffer.from(submittedHash, "hex"))) {
          const nextAttempts = attempts + 1;
          transaction.set(attemptsRef, {
            windowStartedAtMs: withinWindow ? Number(prior.windowStartedAtMs) : now, attempts: nextAttempts,
            blockedUntilMs: nextAttempts >= 5 ? now + 10 * 60_000 : 0, updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          transaction.create(auditRef, { actorUid: user.uid, action: "nursing_visit_code_attempt_failed", resource: `nexaNursingVisits/${visitId}`, attemptNumber: nextAttempts, createdAt: FieldValue.serverTimestamp() });
          outcome = "invalid";
          return;
        }
        patientUid = cleanText(visit.patientUid, 128);
        if (!patientUid) throw new ApiError(409, "nursing-visit-patient-invalid", "Le patient associé à cette prestation ne peut pas être vérifié.");
        const timestamp = FieldValue.serverTimestamp();
        const plannedLabels = Array.isArray(visit.serviceLabels) ? visit.serviceLabels : [];
        const labelByServiceId = new Map(plannedServiceIds.map((id, index) => [id, cleanText(plannedLabels[index], 120) || id]));
        const performedServiceLabels = careServiceIds.map((id) => labelByServiceId.get(id)).filter(Boolean);
        transaction.set(visitRef, {
          status: "COMPLETED", completedAt: timestamp, completedByUid: user.uid,
          patientCode: FieldValue.delete(), patientCodeHash: FieldValue.delete(), updatedAt: timestamp,
        }, { merge: true });
        transaction.create(careRecordRef, {
          visitId, orderId: cleanText(visit.orderId, 200), patientUid, providerUid: user.uid,
          performedServiceIds: [...careServiceIds], performedServiceLabels,
          summary: careSummary,
          signature: { providerUid: user.uid, name: cleanText(visit.providerName, 120) || "Infirmier·ère NEXA", signedAt: timestamp },
          createdAt: timestamp,
        });
        transaction.set(orderRef, { nursingCompletedVisitCount: FieldValue.increment(1), updatedAt: timestamp }, { merge: true });
        transaction.set(attemptsRef, { closedAt: timestamp, updatedAt: timestamp }, { merge: true });
        transaction.create(auditRef, { actorUid: user.uid, action: "nursing_visit_closed_by_patient_code", resource: `nexaNursingVisits/${visitId}`, createdAt: timestamp });
        transaction.create(clinicalAuditRef, { actorUid: user.uid, action: "nursing_care_record_created", resource: `nexaNursingCareRecords/${visitId}`, providerType: "nurse", createdAt: timestamp });
        outcome = "completed";
      });
      if (outcome === "locked") throw new ApiError(429, "nursing-code-locked", "Trop de codes incorrects. Réessayez dans dix minutes.");
      if (outcome === "invalid") throw new ApiError(400, "nursing-code-mismatch", "Le code remis par le patient ne correspond pas à cette prestation.");
      if (outcome !== "completed") throw new ApiError(409, "nursing-visit-not-ready", "La prestation ne peut pas être clôturée pour le moment.");
      await notify(patientUid, `nursing-visit:${visitId}:closed`, {
        type: "nursing_visit_closed", title: "Prestation infirmière clôturée",
        body: "L’infirmier a validé votre code. Le statut est actualisé dans votre espace patient.", url: "/espace-patient.html#commandes",
      });
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, visitStatus: "COMPLETED" });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA nursing visit close failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "nursing-visit-close-failed", "La prestation ne peut pas être clôturée pour le moment.");
    }
  });

  const nexaNursingCareRecord = onRequest({ region: REGION, maxInstances: 15 }, async (req, res) => {
    res.set("Cache-Control", "no-store, max-age=0");
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") { res.set("Allow", "GET, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "nursing-care-record-read", 30, 5 * 60_000);
      await verifiedNurse(user.uid);
      const visitId = req.query.visitId;
      if (typeof visitId !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(visitId)) {
        throw new ApiError(400, "invalid-nursing-visit", "La référence de la prestation n’est pas valide.");
      }
      const visitRef = db.collection("nexaNursingVisits").doc(visitId);
      const careRecordRef = db.collection("nexaNursingCareRecords").doc(visitId);
      const [visitSnapshot, careRecordSnapshot] = await Promise.all([visitRef.get(), careRecordRef.get()]);
      if (!visitSnapshot.exists || visitSnapshot.get("providerUid") !== user.uid || visitSnapshot.get("status") !== "COMPLETED" ||
        !careRecordSnapshot.exists) {
        throw new ApiError(404, "nursing-care-record-not-found", "Ce compte rendu n’est pas accessible.");
      }
      const visit = visitSnapshot.data() || {};
      const careRecord = careRecordSnapshot.data() || {};
      if (careRecord.visitId !== visitId || careRecord.providerUid !== user.uid || careRecord.patientUid !== visit.patientUid ||
        careRecord.orderId !== visit.orderId || visit.completedByUid !== user.uid) {
        throw new ApiError(404, "nursing-care-record-not-found", "Ce compte rendu n’est pas accessible.");
      }
      const orderSnapshot = await db.collection("nexaOrders").doc(cleanText(visit.orderId, 200)).get();
      if (!orderSnapshot.exists || orderSnapshot.get("kind") !== "nursing" || orderSnapshot.get("patientUid") !== visit.patientUid ||
        orderSnapshot.get("providerUid") !== user.uid) {
        throw new ApiError(404, "nursing-care-record-not-found", "Ce compte rendu n’est pas accessible.");
      }
      const signature = careRecord.signature && typeof careRecord.signature === "object" && !Array.isArray(careRecord.signature)
        ? careRecord.signature
        : {};
      await db.collection("clinicalAuditLogs").doc().create({
        actorUid: user.uid, providerType: "nurse", action: "nursing_care_record_accessed",
        resource: `nexaNursingCareRecords/${visitId}`, createdAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({
        ok: true,
        record: {
          visitId, scheduledAt: cleanText(visit.scheduledAt, 40),
          performedServiceLabels: Array.isArray(careRecord.performedServiceLabels)
            ? careRecord.performedServiceLabels.map((label) => cleanText(label, 120)).filter(Boolean)
            : [],
          summary: cleanClinicalText(careRecord.summary, 3_000),
          providerName: cleanText(signature.name, 120) || "Infirmier·ère NEXA",
          signedAt: iso(signature.signedAt),
        },
      });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA nursing care record read failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "nursing-care-record-unavailable", "Le compte rendu de soins infirmiers n’est pas accessible pour le moment.");
    }
  });

  const nexaNursingAdminVisitReview = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) { res.set("Allow", "GET, POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    try {
      const admin = await requireAdmin(req, "admin-nursing-visit-review");
      if (req.method === "GET") {
        const cursor = decodeNursingVisitReviewCursor(req.query?.cursor, ApiError);
        const collection = db.collection("nexaNursingVisits");
        let query = collection.where("status", "==", "ADMIN_REVIEW_REQUIRED")
          .orderBy("feedbackSummary.submittedAt", "desc")
          .orderBy(FieldPath.documentId(), "asc");
        if (cursor) query = query.startAfter(
          new Timestamp(cursor.seconds, cursor.nanoseconds), collection.doc(cursor.id),
        );
        const snapshot = await query.limit(ADMIN_NURSING_VISIT_REVIEW_PAGE_SIZE + 1).get();
        const page = snapshot.docs.slice(0, ADMIN_NURSING_VISIT_REVIEW_PAGE_SIZE);
        const lastDocument = page[page.length - 1];
        const nextCursor = snapshot.docs.length > ADMIN_NURSING_VISIT_REVIEW_PAGE_SIZE && lastDocument
          ? encodeNursingVisitReviewCursor(lastDocument)
          : null;
        if (snapshot.docs.length > ADMIN_NURSING_VISIT_REVIEW_PAGE_SIZE && !nextCursor) {
          throw new ApiError(500, "nursing-review-cursor-unavailable", "La pagination de la file infirmière ne peut pas continuer.");
        }
        const orderSnapshots = page.length ? await db.getAll(...page.map((doc) => db.collection("nexaOrders").doc(cleanText(doc.get("orderId"), 200)))) : [];
        const visits = page.map((doc, index) => {
          const data = doc.data() || {};
          const order = orderSnapshots[index]?.data() || {};
          const summary = data.feedbackSummary && typeof data.feedbackSummary === "object" ? data.feedbackSummary : {};
          const ratings = summary.ratings && typeof summary.ratings === "object" ? summary.ratings : {};
          return {
            visitId: doc.id, orderId: cleanText(data.orderId, 200), orderNumber: cleanText(data.orderNumber, 80),
            patientNumber: cleanText(data.patientNumber, 20), patientName: cleanText(data.patientName, 120),
            providerName: cleanText(data.providerName, 120), weekStart: cleanText(data.weekStart, 10), periodLabel: cleanText(data.periodLabel, 40),
            serviceLabels: Array.isArray(data.serviceLabels) ? data.serviceLabels.map((label) => cleanText(label, 120)).filter(Boolean) : [],
            scheduledAt: cleanText(data.scheduledAt, 40), providerPresent: summary.providerPresent === true,
            identityMatched: summary.identityMatched === true, serviceCompletion: cleanText(summary.serviceCompletion, 32),
            visitStartedAt: cleanText(summary.visitStartedAt, 40), visitEndedAt: cleanText(summary.visitEndedAt, 40),
            ratings: Object.fromEntries(RATING_KEYS.map((key) => [key, validRating(ratings[key])])),
            submittedAt: iso(summary.submittedAt), amount: Number.isSafeInteger(order.amount) ? order.amount : 0,
            transactionFee: Number.isSafeInteger(order.transactionFee) ? order.transactionFee : 0,
          };
        });
        await db.collection("adminAuditLogs").doc().create({
          actorUid: admin.uid, action: "nexa_admin_nursing_visit_reviews_listed",
          resultCount: visits.length, hasMore: Boolean(nextCursor), createdAt: FieldValue.serverTimestamp(),
        });
        res.set("Cache-Control", "no-store, max-age=0");
        return res.status(200).json({ ok: true, visits, nextCursor });
      }

      if ((Number(req.get("Content-Length")) || 0) > 2_048 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 2_048)) return fail(res, 413, "request-too-large", "La décision dépasse la taille autorisée.");
      const body = getBody(req);
      const visitId = cleanText(body?.visitId, 200);
      const decision = cleanText(body?.decision, 40);
      const reason = cleanText(body?.reason, 40);
      if (!body || Object.keys(body).some((key) => !["visitId", "decision", "reason", "confirmNoExternalRefund"].includes(key)) ||
        !/^[A-Za-z0-9_-]{10,200}$/.test(visitId) || !["ALLOW_CODE_CLOSURE", "REFUND_WALLET"].includes(decision) || !ADMIN_REASONS.has(reason)) {
        throw new ApiError(400, "invalid-nursing-visit-review", "Choisissez une décision et une justification reconnues.");
      }
      if (decision === "REFUND_WALLET" && body.confirmNoExternalRefund !== true) throw new ApiError(400, "external-refund-confirmation-required", "Confirmez qu’aucun remboursement externe n’a déjà été effectué.");
      const visitRef = db.collection("nexaNursingVisits").doc(visitId);
      const reportRef = db.collection("nexaNursingVisitReports").doc(visitId);
      const auditRef = db.collection("adminAuditLogs").doc();
      const newCode = decision === "ALLOW_CODE_CLOSURE" ? makeCode() : "";
      const review = await db.runTransaction(async (transaction) => {
        const [visitSnapshot, reportSnapshot] = await Promise.all([transaction.get(visitRef), transaction.get(reportRef)]);
        if (!visitSnapshot.exists || !reportSnapshot.exists) throw new ApiError(404, "nursing-visit-review-not-found", "Cette prestation à vérifier n’existe plus.");
        const visit = visitSnapshot.data() || {};
        const report = reportSnapshot.data() || {};
        if (visit.status !== "ADMIN_REVIEW_REQUIRED") {
          if (visit.adminDecision === decision && visit.adminReviewReason === reason) return { alreadyReviewed: true, patientUid: visit.patientUid, status: visit.status };
          throw new ApiError(409, "nursing-visit-review-stale", "La prestation a déjà changé; actualisez la file avant de décider.");
        }
        if (report.patientUid !== visit.patientUid || report.providerUid !== visit.providerUid || !report.patientConfirmed || visit.paymentStatus === "REFUNDED") {
          throw new ApiError(409, "nursing-visit-report-invalid", "Le compte rendu ne correspond plus à cette réservation.");
        }
        if (decision === "ALLOW_CODE_CLOSURE" && report.providerPresent !== true) throw new ApiError(409, "nursing-provider-absence", "Une prestation signalée comme absente ne peut pas être clôturée par code.");
        const orderRef = db.collection("nexaOrders").doc(cleanText(visit.orderId, 200));
        const orderSnapshot = await transaction.get(orderRef);
        if (!orderSnapshot.exists || orderSnapshot.get("kind") !== "nursing" || orderSnapshot.get("providerUid") !== visit.providerUid ||
          orderSnapshot.get("patientUid") !== visit.patientUid || orderSnapshot.get("paymentStatus") !== "PAID") {
          throw new ApiError(409, "nursing-order-review-stale", "La réservation ou son paiement ne peut plus être vérifié.");
        }
        const now = FieldValue.serverTimestamp();
        if (decision === "ALLOW_CODE_CLOSURE") {
          transaction.set(visitRef, {
            status: "AWAITING_PROVIDER_CODE", adminDecision: decision, adminReviewReason: reason,
            adminReviewedByUid: admin.uid, adminReviewedAt: now,
            patientCode: newCode, patientCodeHash: codeHash(visitId, newCode), codeIssuedAt: now, updatedAt: now,
          }, { merge: true });
        } else {
          if (orderSnapshot.get("requestedRefundMethod") === "CASH_MANUAL" || orderSnapshot.get("refundStatus") === "PENDING_MANUAL_CASH") {
            throw new ApiError(409, "cash-refund-requested", "Le patient a demandé des espèces; traitez la demande dans les incidents de règlement.");
          }
          // This legacy field stores the opaque payment-intent ID for both MonCash and Wallet nursing orders.
          const paymentRef = cleanText(orderSnapshot.get("moncashPaymentRef"), 64);
          if (!/^[A-Za-z0-9_-]{20,64}$/.test(paymentRef)) throw new ApiError(409, "nursing-payment-reference-invalid", "La référence de paiement ne peut pas être vérifiée.");
          const alertRef = db.collection("paymentSettlementAlerts").doc(`nursing_visit_review_${visit.orderId}`);
          const alertSnapshot = await transaction.get(alertRef);
          if (alertSnapshot.exists && ["manual_refund_confirmed", "manual_cash_refund_confirmed", "manual_moncash_refund_confirmed"].includes(String(alertSnapshot.get("resolution") || ""))) {
            throw new ApiError(409, "nursing-refund-already-recorded", "Un remboursement externe est déjà enregistré pour cette période.");
          }
          transaction.set(visitRef, { status: "REFUND_PENDING_ADMIN", adminDecision: decision, adminReviewReason: reason, adminReviewedByUid: admin.uid, adminReviewedAt: now, updatedAt: now }, { merge: true });
          transaction.set(orderRef, {
            status: "PAYMENT_REVIEW_REQUIRED", settlementStatus: "REVIEW_REQUIRED", refundRequired: true,
            refundStatus: "PENDING_REVIEW", refundReviewReason: "NURSING_VISIT_REVIEW", nursingReviewVisitId: visitId,
            updatedAt: now,
          }, { merge: true });
          transaction.set(alertRef, {
            paymentRef, resourceType: "nursing-order", resourceId: visit.orderId,
            reason: "NURSING_VISIT_ADMIN_APPROVED_PERIOD_REFUND", status: "open",
            createdAt: alertSnapshot.exists ? alertSnapshot.get("createdAt") : now, updatedAt: now,
          }, { merge: true });
        }
        transaction.create(auditRef, {
          actorUid: admin.uid, action: decision === "ALLOW_CODE_CLOSURE" ? "nexa_admin_nursing_visit_code_authorized" : "nexa_admin_nursing_period_wallet_refund_approved",
          resource: `nexaNursingVisits/${visitId}`, reason, createdAt: now,
        });
        return { alreadyReviewed: false, patientUid: visit.patientUid, providerUid: visit.providerUid, orderId: visit.orderId, status: decision === "ALLOW_CODE_CLOSURE" ? "AWAITING_PROVIDER_CODE" : "REFUND_PENDING_ADMIN" };
      });
      if (!review.alreadyReviewed && decision === "ALLOW_CODE_CLOSURE" && review.patientUid) {
        await notify(review.patientUid, `nursing-visit:${visitId}:admin-code`, {
          type: "nursing_visit_code_authorized", title: "Prestation infirmière vérifiée par NEXA",
          body: "Après examen, NEXA autorise la clôture de cette prestation par votre code. Consultez votre espace patient.", url: "/espace-patient.html#commandes",
        });
        if (typeof sendNursingVisitCodeEmail === "function") await sendNursingVisitCodeEmail(review.patientUid, visitId, newCode);
      }
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, status: review.status, alreadyReviewed: review.alreadyReviewed });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA nursing admin visit review failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "nursing-admin-review-failed", "La revue de la prestation infirmière est indisponible.");
    }
  });

  return { nexaNursingVisitPlan, nexaPatientNursingVisits, nexaPatientNursingVisitReports, nexaPatientNursingVisitFeedback, nexaNursingVisitClose, nexaNursingCareRecord, nexaNursingAdminVisitReview };
};
