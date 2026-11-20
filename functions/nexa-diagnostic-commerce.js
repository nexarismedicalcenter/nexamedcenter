"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");

const REGION = "us-east4";
const HOLD_MINUTES = 30;
const PATIENT_ORDER_PAGE_SIZE = 25;
const PAYMENT_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
const ORDER_RESOURCE_KINDS = { "laboratory-order": "laboratory", "imaging-order": "imaging" };
const RESULT_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"];
const RESULT_CATEGORIES = {
  laboratory: new Set(["LAB_RESULT", "SUPPLEMENTAL"]),
  imaging: new Set(["IMAGING", "RADIOLOGY_REPORT", "SUPPLEMENTAL"]),
};

function clean(value, maximum) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum) : "";
}

function bodyOf(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  if (!Buffer.isBuffer(req.rawBody)) return null;
  try {
    const value = JSON.parse(req.rawBody.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function normalizeRequirements(value, providerType, ApiError) {
  const defaults = {
    requiredCategories: [providerType === "laboratory" ? "LAB_RESULT" : "IMAGING"],
    allowSupplemental: true,
    allowMultiplePerCategory: true,
    maxFiles: 20,
    maxFileBytes: 15 * 1024 * 1024,
    allowedMimeTypes: RESULT_MIME_TYPES,
  };
  if (value === undefined || value === null) return defaults;
  const invalid = () => new ApiError(409, "invalid-result-requirements", "Les exigences de fichiers configurées pour cet examen ne sont pas valides.");
  if (typeof value !== "object" || Array.isArray(value)) throw invalid();
  const categories = [...new Set(Array.isArray(value.requiredCategories) ? value.requiredCategories.map((item) => clean(item, 40).toUpperCase()) : [])];
  const mimeTypes = [...new Set(Array.isArray(value.allowedMimeTypes) ? value.allowedMimeTypes.map((item) => clean(item, 100).toLowerCase()) : [])];
  const maxFiles = Number(value.maxFiles);
  const maxFileBytes = Number(value.maxFileBytes);
  const primary = providerType === "laboratory" ? categories.includes("LAB_RESULT") : categories.some((item) => ["IMAGING", "RADIOLOGY_REPORT"].includes(item));
  if (!categories.length || categories.some((item) => !RESULT_CATEGORIES[providerType].has(item)) || !primary ||
    typeof value.allowSupplemental !== "boolean" || typeof value.allowMultiplePerCategory !== "boolean" ||
    (!value.allowSupplemental && categories.includes("SUPPLEMENTAL")) || !mimeTypes.length || mimeTypes.some((item) => !RESULT_MIME_TYPES.includes(item)) ||
    !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 20 || !Number.isInteger(maxFileBytes) || maxFileBytes < 1024 * 1024 || maxFileBytes > 15 * 1024 * 1024) {
    throw invalid();
  }
  return { requiredCategories: categories, allowSupplemental: value.allowSupplemental, allowMultiplePerCategory: value.allowMultiplePerCategory, maxFiles, maxFileBytes, allowedMimeTypes: mimeTypes };
}

function prescriptionLines(prescription, type) {
  const list = type === "laboratory" ? prescription.labExams : prescription.imagingExams;
  return (Array.isArray(list) ? list : []).slice(0, 50).map((raw, index) => {
    const label = clean(typeof raw === "string" ? raw : raw && typeof raw === "object" ? raw.name || raw.label : "", 180);
    return label ? { id: `${type}-${index + 1}`, label } : null;
  }).filter(Boolean);
}

function normalizedExam(value) {
  return clean(value, 500).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/\s+/g, " ");
}

function prescriptionExpired(value) {
  const expiry = value && typeof value.toMillis === "function" ? value.toMillis() : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(expiry) && expiry <= Date.now();
}

function orderPaymentMatches(order, payment) {
  const serviceAmount = Number(order.amount);
  const feeAmount = Number(order.transactionFee || 0);
  const totalAmount = Number(order.totalAmount ?? serviceAmount + feeAmount);
  return Number.isSafeInteger(serviceAmount) && serviceAmount >= 0 && Number.isSafeInteger(feeAmount) && feeAmount >= 0 &&
    Number.isSafeInteger(totalAmount) && totalAmount === serviceAmount + feeAmount && Number(payment.amount) === totalAmount &&
    Number(payment.serviceAmount ?? payment.resourceAmount ?? payment.amount) === serviceAmount && Number(payment.transactionFee || 0) === feeAmount;
}

function iso(value) {
  if (value && typeof value.toDate === "function") return value.toDate().toISOString();
  return typeof value === "string" ? value : null;
}

module.exports = function createNexaDiagnosticCommerceFunctions(dependencies) {
  const {
    db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger,
    getTransactionFeePolicy, calculateTransactionAmounts, createNexaNotification,
  } = dependencies;

  const nexaDiagnosticOrderCreate = onRequest({ region: REGION, maxInstances: 20 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > 16_384 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 16_384)) return fail(res, 413, "request-too-large", "La demande de commande est trop volumineuse.");
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "diagnostic-order-create", 8, 5 * 60_000);
      const input = bodyOf(req);
      if (!input) throw new ApiError(400, "invalid-request", "La demande de commande n’est pas valide.");
      const offerIds = Array.isArray(input?.offerIds) ? input.offerIds.map((item) => clean(item, 200)) : [];
      if (offerIds.length < 1 || offerIds.length > 10 || offerIds.some((id) => !/^[A-Za-z0-9_-]{10,200}$/.test(id)) || new Set(offerIds).size !== offerIds.length) {
        throw new ApiError(400, "invalid-diagnostic-offers", "Choisissez entre 1 et 10 examens différents pour un seul centre.");
      }
      const prescriptionId = clean(input.prescriptionId, 200);
      if (prescriptionId && !/^[A-Za-z0-9_-]{10,200}$/.test(prescriptionId)) throw new ApiError(400, "invalid-prescription", "La référence d’ordonnance n’est pas valide.");
      const requestId = clean(input.orderRequestId, 64);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new ApiError(400, "invalid-order-request-id", "Rechargez la page avant de préparer cette commande.");
      if (input.prescriptionLineIds !== undefined && (!input.prescriptionLineIds || typeof input.prescriptionLineIds !== "object" || Array.isArray(input.prescriptionLineIds))) throw new ApiError(400, "invalid-prescription-line-links", "Les liens avec l’ordonnance ne sont pas valides.");
      const lineIds = input.prescriptionLineIds || {};
      const allowed = new Set(offerIds);
      const usedLines = new Set();
      const links = Object.create(null);
      for (const [offerId, rawLineId] of Object.entries(lineIds)) {
        const lineId = clean(rawLineId, 64);
        if (!allowed.has(offerId) || !/^(laboratory|imaging)-[1-9]\d{0,2}$/.test(lineId) || usedLines.has(lineId)) throw new ApiError(400, "invalid-prescription-line-links", "Un examen est relié à une ligne d’ordonnance invalide ou répétée.");
        links[offerId] = lineId;
        usedLines.add(lineId);
      }
      if (Object.keys(links).length && !prescriptionId) throw new ApiError(400, "prescription-required-for-line-link", "Sélectionnez une ordonnance avant de relier les examens.");

      const patientRef = db.collection("patientProfiles").doc(user.uid);
      const offerRefs = offerIds.map((id) => db.collection("diagnosticOffers").doc(id));
      const prescriptionRef = prescriptionId ? db.collection("clinicalPrescriptions").doc(prescriptionId) : null;
      const orderRef = db.collection("nexaOrders").doc();
      const paymentRef = randomBytes(24).toString("base64url");
      if (!PAYMENT_REFERENCE_PATTERN.test(paymentRef)) throw new ApiError(500, "payment-reference-failed", "La commande ne peut pas être créée.");
      const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
      const fingerprint = createHash("sha256").update(`${offerIds.join("|")}|${prescriptionId}|${JSON.stringify(Object.fromEntries(Object.entries(links).sort(([a], [b]) => a.localeCompare(b))))}`).digest("hex");
      const requestRef = db.collection("diagnosticOrderRequests").doc(createHash("sha256").update(`${user.uid}|${requestId}`).digest("hex"));
      const eventRef = db.collection("nexaOrderEvents").doc();
      const auditRef = db.collection("adminAuditLogs").doc();
      const holdExpiresAt = Date.now() + HOLD_MINUTES * 60_000;

      const result = await db.runTransaction(async (transaction) => {
        const snapshots = await Promise.all([
          transaction.get(patientRef), ...offerRefs.map((ref) => transaction.get(ref)),
          ...(prescriptionRef ? [transaction.get(prescriptionRef)] : []), transaction.get(requestRef),
        ]);
        const patient = snapshots[0];
        const offersSnapshots = snapshots.slice(1, 1 + offerRefs.length);
        const prescriptionSnapshot = prescriptionRef ? snapshots[1 + offerRefs.length] : null;
        const prior = snapshots[snapshots.length - 1];
        if (prior.exists) {
          if (prior.get("uid") !== user.uid || prior.get("fingerprint") !== fingerprint) throw new ApiError(409, "order-request-conflict", "Cette référence a déjà servi pour une autre commande. Rechargez le catalogue.");
          const response = prior.get("response");
          if (!response || typeof response !== "object") throw new ApiError(409, "order-request-incomplete", "La commande précédente est en cours de vérification. Consultez votre espace patient.");
          return response;
        }
        if (!patient.exists || patient.get("role") !== "patient" || patient.get("profileComplete") !== true || !/^NMC-\d{7}$/.test(String(patient.get("patientNumber") || ""))) throw new ApiError(403, "complete-patient-profile-required", "Terminez votre profil patient avant de commander.");

        const offers = offersSnapshots.map((snapshot) => {
          if (!snapshot.exists) throw new ApiError(404, "diagnostic-offer-not-found", "Une offre sélectionnée n’est plus disponible.");
          const offer = snapshot.data() || {};
          if (!["laboratory", "imaging"].includes(String(offer.providerType)) || offer.publicationStatus !== "PUBLISHED" || offer.active !== true || offer.requestedAvailability === false) throw new ApiError(409, "diagnostic-offer-unavailable", "Une offre n’est plus publiée ou disponible.");
          if (offer.appointmentRequired === true) throw new ApiError(409, "appointment-required", "Cette offre nécessite un rendez-vous. Appelez le centre pour convenir d’une heure.");
          return offer;
        });
        const providerType = String(offers[0].providerType);
        const providerUid = String(offers[0].providerUid || "");
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(providerUid)) throw new ApiError(409, "diagnostic-provider-unavailable", "Le centre associé à cette offre n’est pas valide.");
        if (offers.some((offer) => offer.providerType !== providerType || offer.providerUid !== providerUid)) throw new ApiError(400, "single-diagnostic-provider-required", "Un panier doit contenir des examens du même centre.");
        const providerRef = db.collection("providerProfiles").doc(providerUid);
        const providerSnapshot = await transaction.get(providerRef);
        if (!providerSnapshot.exists || providerSnapshot.get("type") !== providerType || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true) throw new ApiError(409, "diagnostic-provider-unavailable", "Ce centre n’est plus disponible sur NEXA.");
        const feePolicy = await getTransactionFeePolicy(providerType);
        const needsPrescription = offers.some((offer) => offer.requiresPrescription === true);
        const prescription = prescriptionSnapshot?.exists ? prescriptionSnapshot.data() || {} : null;
        if ((needsPrescription || prescriptionId) && (!prescription || prescription.patientUid !== user.uid || prescription.status !== "VALIDATED")) throw new ApiError(403, "valid-prescription-required", "Une ordonnance NEXA validée vous appartenant est requise.");
        if (prescription && prescriptionExpired(prescription.expiresAt)) throw new ApiError(409, "prescription-expired", "Cette ordonnance a expiré.");
        const availableLines = prescription ? prescriptionLines(prescription, providerType) : [];
        const usedPrescriptionLines = new Set();
        let subtotal = 0;
        const items = offers.map((offer, index) => {
          const name = clean(offer.name, 180);
          const price = typeof offer.price === "number" ? offer.price : Number.NaN;
          if (!name || !Number.isSafeInteger(price) || price < 0 || price > 10_000_000) throw new ApiError(409, "diagnostic-offer-invalid", "Le nom ou le prix d’une offre doit être corrigé par le centre.");
          const offerId = offersSnapshots[index].id;
          const requestedLine = links[offerId];
          let prescriptionLineId = "";
          if (requestedLine) {
            const line = availableLines.find((candidate) => candidate.id === requestedLine);
            if (!line || usedPrescriptionLines.has(requestedLine) || normalizedExam(line.label) !== normalizedExam(name)) throw new ApiError(409, "prescription-line-mismatch", "L’offre ne correspond pas à la ligne d’ordonnance sélectionnée.");
            prescriptionLineId = requestedLine;
          } else if (offer.requiresPrescription === true) {
            const line = availableLines.find((candidate) => !usedPrescriptionLines.has(candidate.id) && normalizedExam(candidate.label) === normalizedExam(name));
            if (!line) throw new ApiError(409, "prescription-exam-mismatch", `L’ordonnance ne contient pas l’examen « ${name} » sous ce nom.`);
            prescriptionLineId = line.id;
          }
          if (prescriptionLineId) usedPrescriptionLines.add(prescriptionLineId);
          subtotal += price;
          if (!Number.isSafeInteger(subtotal) || subtotal > 10_000_000) throw new ApiError(400, "diagnostic-order-total-invalid", "Le total dépasse la limite autorisée.");
          return {
            offerId, name, category: clean(offer.category, 120), price, lineTotal: price,
            specimenType: clean(offer.specimenType, 120), preparation: clean(offer.preparation, 1000),
            precautions: clean(offer.precautions, 1000), technique: clean(offer.technique, 180),
            resultDelay: clean(offer.resultDelay, 160), instructions: clean(offer.instructions, 1200),
            requiresPrescription: offer.requiresPrescription === true,
            ...(prescriptionLineId ? { prescriptionLineId } : {}),
            resultRequirements: normalizeRequirements(offer.resultRequirements, providerType, ApiError),
          };
        });
        const profile = providerSnapshot.get("profile") && typeof providerSnapshot.get("profile") === "object" ? providerSnapshot.get("profile") : {};
        const providerName = clean(profile.name || profile.displayName || providerSnapshot.get("displayName"), 120) || (providerType === "laboratory" ? "Laboratoire NEXA" : "Centre d’imagerie NEXA");
        const freeOrder = subtotal === 0;
        const amounts = calculateTransactionAmounts(subtotal, freeOrder ? { active: false, rateBps: 0 } : feePolicy);
        const orderNumber = `NMC-${providerType === "laboratory" ? "LAB" : "IMG"}-${orderRef.id.slice(-8).toUpperCase()}`;
        const now = FieldValue.serverTimestamp();
        transaction.create(orderRef, {
          kind: providerType, workflowVersion: `${providerType}-commerce-v1`, orderNumber,
          patientUid: user.uid, patientNumber: patient.get("patientNumber"), providerUid, providerType, providerName,
          providerAddress: clean(profile.address, 200), providerPhone: clean(profile.publicPhone, 30),
          providerDepartment: clean(profile.department, 80), providerCommune: clean(profile.commune, 80),
          items, ...(prescriptionId ? { prescriptionId } : {}), subtotal, amount: subtotal,
          transactionFee: amounts.feeAmount, transactionFeeRateBps: amounts.feeRateBps,
          transactionFeeRecipient: amounts.feeRecipient, totalAmount: amounts.totalAmount, currency: "HTG",
          paymentMethod: freeOrder ? "FREE" : "MONCASH", paymentStatus: freeOrder ? "FREE" : "PENDING",
          status: freeOrder ? "PAID" : "PENDING_PAYMENT", settlementStatus: freeOrder ? "CONFIRMED" : "PENDING",
          holdExpiresAt: freeOrder ? null : holdExpiresAt, ...(!freeOrder ? { moncashPaymentRef: paymentRef } : {}),
          createdAt: now, updatedAt: now,
        });
        if (!freeOrder) transaction.create(paymentRefDoc, {
          uid: user.uid, paymentMethod: "MONCASH", resourceType: providerType === "laboratory" ? "laboratory-order" : "imaging-order",
          resourcePath: orderRef.path, amount: amounts.totalAmount, serviceAmount: subtotal,
          transactionFee: amounts.feeAmount, transactionFeeRateBps: amounts.feeRateBps,
          feeRecipient: amounts.feeRecipient, currency: "HTG", status: "created", createdAt: now, updatedAt: now,
        });
        transaction.create(auditRef, { actorUid: user.uid, action: `${providerType}_order_created`, resource: orderRef.path, createdAt: now });
        transaction.create(eventRef, { orderId: orderRef.id, fromStatus: null, toStatus: freeOrder ? "PAID" : "PENDING_PAYMENT", action: freeOrder ? "FREE_ORDER_CREATED" : "ORDER_CREATED", actorUid: user.uid, createdAt: now });
        const response = {
          orderId: orderRef.id, orderNumber, providerName, providerUid, amount: subtotal,
          transactionFee: amounts.feeAmount, totalAmount: amounts.totalAmount,
          transactionFeeRateBps: amounts.feeRateBps, feeRecipient: amounts.feeRecipient, currency: "HTG",
          paymentRequired: !freeOrder, ...(!freeOrder ? { paymentRef, holdExpiresAt } : {}),
        };
        transaction.create(requestRef, { uid: user.uid, fingerprint, response, orderId: orderRef.id, createdAt: now });
        return response;
      });
      if (result.paymentRequired === false) {
        const notices = [createNexaNotification(user.uid, `diagnostic-order-free:${result.orderId}`, {
          type: "diagnostic_order_confirmed", title: "Commande d’examen confirmée", body: "Votre commande gratuite a été transmise au centre NEXA.", url: "/espace-patient.html#commandes",
        })];
        if (result.providerUid) notices.push(createNexaNotification(result.providerUid, `diagnostic-order-free:${result.orderId}`, {
          type: "diagnostic_order_received", title: "Nouvelle commande d’examen", body: "Une commande gratuite a été reçue. Consultez votre espace partenaire.", url: "/espace-centre.html",
        }));
        await Promise.all(notices);
      }
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA diagnostic order create failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "diagnostic-order-create-failed", "La commande d’examen ne peut pas être préparée pour le moment.");
    }
  });

  const nexaPatientOrders = onRequest({ region: REGION, maxInstances: 20 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") { res.set("Allow", "GET, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "patient-orders-read", 30, 5 * 60_000);
      const patient = await db.collection("patientProfiles").doc(user.uid).get();
      if (!patient.exists || patient.get("role") !== "patient" || patient.get("profileComplete") !== true) throw new ApiError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : "";
      if (cursor.length > 200 || cursor.includes("/") || /[\u0000-\u001f\u007f]/.test(cursor)) {
        throw new ApiError(400, "invalid-patient-order-cursor", "La pagination des commandes n’est pas valide.");
      }
      let cursorSnapshot = null;
      if (cursor) {
        cursorSnapshot = await db.collection("nexaOrders").doc(cursor).get();
        if (!cursorSnapshot.exists || cursorSnapshot.get("patientUid") !== user.uid ||
          !cursorSnapshot.get("createdAt") || typeof cursorSnapshot.get("createdAt").toMillis !== "function") {
          throw new ApiError(400, "invalid-patient-order-cursor", "Actualisez l’historique de commandes avant de continuer.");
        }
      }
      let ordersQuery = db.collection("nexaOrders")
        .where("patientUid", "==", user.uid)
        .where("kind", "in", ["laboratory", "imaging", "pharmacy", "nursing"])
        .orderBy("createdAt", "desc");
      if (cursorSnapshot) ordersQuery = ordersQuery.startAfter(cursorSnapshot);
      const snapshot = await ordersQuery.limit(PATIENT_ORDER_PAGE_SIZE + 1).get();
      const hasMore = snapshot.docs.length > PATIENT_ORDER_PAGE_SIZE;
      const page = snapshot.docs.slice(0, PATIENT_ORDER_PAGE_SIZE);
      const orders = page.filter((doc) => ["laboratory", "imaging", "pharmacy", "nursing"].includes(String(doc.get("kind")))).map((doc) => {
        const data = doc.data() || {};
        const savedStatus = clean(data.status, 50) || "UNKNOWN";
        const holdExpiresAt = Number(data.holdExpiresAt) || null;
        const nursingHoldExpired = data.kind === "nursing" && savedStatus === "PENDING_PAYMENT" &&
          Boolean(holdExpiresAt && holdExpiresAt <= Date.now());
        const nursingBooking = data.kind === "nursing" && data.nursingBooking && typeof data.nursingBooking === "object"
          ? data.nursingBooking
          : null;
        return {
          id: doc.id,
          orderNumber: clean(data.orderNumber, 80) || `NMC-${data.kind === "laboratory" ? "LAB" : data.kind === "imaging" ? "IMG" : "PH"}-${doc.id.slice(-8).toUpperCase()}`,
          kind: data.kind, providerName: clean(data.providerName, 120) || "Partenaire NEXA",
          items: Array.isArray(data.items) ? data.items.map((item) => ({
            name: clean(item?.name, 180), dci: clean(item?.dci, 180), dosage: clean(item?.dosage, 120),
            route: clean(item?.route, 120),
            pharmaceuticalForm: clean(item?.pharmaceuticalForm, 100), quantity: Number.isSafeInteger(item?.quantity) ? item.quantity : 1,
            price: Number.isSafeInteger(item?.price) ? item.price : Number.isSafeInteger(item?.unitPrice) ? item.unitPrice : 0,
            lineTotal: Number.isSafeInteger(item?.lineTotal) ? item.lineTotal : Number.isSafeInteger(item?.price) ? item.price * (Number(item?.quantity) || 1) : 0,
            preparation: clean(item?.preparation, 1000), instructions: clean(item?.instructions, 1200),
          })) : [],
          deliveryMethod: data.kind === "pharmacy" ? clean(data.deliveryMethod, 24) || "pickup" : null,
          subtotal: Number.isSafeInteger(data.subtotal) ? data.subtotal : Number(data.amount) || 0,
          deliveryFee: Number.isSafeInteger(data.deliveryFee) ? data.deliveryFee : 0,
          ...(data.kind === "pharmacy" && data.deliveryMethod === "delivery" && data.deliveryAddress && typeof data.deliveryAddress === "object" ? { deliveryAddress: {
            recipientName: clean(data.deliveryAddress.recipientName, 120), phone: clean(data.deliveryAddress.phone, 32),
            department: clean(data.deliveryAddress.department, 80), commune: clean(data.deliveryAddress.commune, 80),
            addressLine: clean(data.deliveryAddress.addressLine, 300), instructions: clean(data.deliveryAddress.instructions, 300),
          } } : {}),
          ...(nursingBooking ? { nursingBooking: {
            weekStart: clean(nursingBooking.weekStart, 10), period: clean(nursingBooking.period, 16),
            periodLabel: clean(nursingBooking.periodLabel, 40), periodSchedule: clean(nursingBooking.periodSchedule, 100),
            bookingMode: clean(nursingBooking.bookingMode, 40),
            bookingModeDescription: clean(nursingBooking.bookingModeDescription, 200),
            department: clean(nursingBooking.department, 80), commune: clean(nursingBooking.commune, 80),
            services: Array.isArray(nursingBooking.services) ? nursingBooking.services.map((service) => ({
              id: clean(service?.id, 50), label: clean(service?.label, 120),
            })).filter((service) => service.id && service.label) : [],
          } } : {}),
          amount: Number(data.amount) || 0, transactionFee: Number(data.transactionFee) || 0,
          totalAmount: Number.isSafeInteger(data.totalAmount) ? data.totalAmount : Number(data.amount || 0) + Number(data.transactionFee || 0),
          currency: data.currency === "HTG" ? "HTG" : "HTG",
          paymentStatus: nursingHoldExpired ? "EXPIRED" : clean(data.paymentStatus, 30),
          settlementStatus: nursingHoldExpired ? "EXPIRED" : clean(data.settlementStatus, 30),
          status: nursingHoldExpired ? "EXPIRED" : savedStatus,
          refundRequired: data.refundRequired === true, refundStatus: clean(data.refundStatus, 40),
          refundMethod: clean(data.refundMethod, 40), requestedRefundMethod: clean(data.requestedRefundMethod, 40),
          refundRequestStatus: clean(data.refundRequestStatus, 40),
          createdAt: iso(data.createdAt), holdExpiresAt,
          paymentRef: nursingHoldExpired ? null : typeof data.moncashPaymentRef === "string" ? data.moncashPaymentRef : null,
        };
      });
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, orders, hasMore, nextCursor: hasMore && page.length ? page[page.length - 1].id : null });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA patient orders read failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "patient-orders-unavailable", "Vos commandes ne sont pas accessibles pour le moment.");
    }
  });

  const nexaPatientRequestDiagnosticCashRefund = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > 4096 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 4096)) return fail(res, 413, "request-too-large", "La demande de remboursement est trop volumineuse.");
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "request-diagnostic-cash-refund", 6, 10 * 60_000);
      const input = bodyOf(req);
      const orderId = clean(input?.orderId, 200);
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(orderId)) throw new ApiError(400, "invalid-refund-resource", "La référence de commande n’est pas valide.");
      const orderRef = db.collection("nexaOrders").doc(orderId);
      const auditRef = db.collection("adminAuditLogs").doc();
      const outcome = await db.runTransaction(async (transaction) => {
        const orderSnapshot = await transaction.get(orderRef);
        if (!orderSnapshot.exists || orderSnapshot.get("patientUid") !== user.uid) throw new ApiError(404, "refund-resource-not-found", "Cette demande de remboursement n’est pas accessible.");
        const order = orderSnapshot.data() || {};
        const resourceType = order.kind === "laboratory" ? "laboratory-order" : order.kind === "imaging" ? "imaging-order" : order.kind === "pharmacy" ? "pharmacy-order" : order.kind === "nursing" ? "nursing-order" : "";
        const providerRefusedOrder = order.status === "PROVIDER_REFUSED" && order.settlementStatus === "CONFIRMED";
        const paymentReviewRefund = order.status === "PAYMENT_REVIEW_REQUIRED" && order.settlementStatus === "REVIEW_REQUIRED";
        if (!resourceType || (!providerRefusedOrder && !paymentReviewRefund) || order.paymentStatus !== "PAID" || order.refundRequired !== true || order.refundMethod === "NEXA_WALLET") {
          throw new ApiError(409, "refund-not-eligible", "Cette commande n’est pas encore admissible à une demande de remboursement en espèces.");
        }
        const amount = Number(order.amount);
        const paymentRef = clean(order.moncashPaymentRef, 64);
        if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 10_000_000 || order.currency !== "HTG" || !PAYMENT_REFERENCE_PATTERN.test(paymentRef)) throw new ApiError(409, "refund-payment-invalid", "Le montant ou le paiement de cette commande ne peut pas être vérifié.");
        const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
        const alertsQuery = db.collection("paymentSettlementAlerts").where("resourceId", "==", orderId).limit(100);
        const refundLedgerRef = db.collection("nexaRefundLedger").doc(createHash("sha256").update(`NEXA_REFUND:${resourceType}:${orderId}`).digest("hex"));
        const [paymentSnapshot, alertsSnapshot, refundSnapshot] = await Promise.all([
          transaction.get(paymentRefDoc), transaction.get(alertsQuery), transaction.get(refundLedgerRef),
        ]);
        if (refundSnapshot.exists || ["COMPLETED", "REFUNDED"].includes(String(order.refundStatus || "").toUpperCase())) throw new ApiError(409, "refund-already-processed", "Un remboursement a déjà été enregistré pour cette commande.");
        const payment = paymentSnapshot.data() || {};
        if (!paymentSnapshot.exists || payment.status !== "paid" || !["MONCASH", "SMART_WALLET", "NEXA_WALLET"].includes(String(payment.paymentMethod || "")) ||
          payment.resourceType !== resourceType || payment.resourcePath !== orderRef.path || payment.uid !== user.uid || !orderPaymentMatches(order, payment) || payment.currency !== "HTG") {
          throw new ApiError(409, "refund-payment-mismatch", "Le paiement ne correspond pas à cette commande.");
        }
        const matchingAlerts = alertsSnapshot.docs.filter((alert) => alert.get("resourceType") === resourceType);
        const activeAlerts = matchingAlerts.filter((alert) => ["open", "in_review"].includes(String(alert.get("status") || "")));
        const alertRef = activeAlerts[0]?.ref || db.collection("paymentSettlementAlerts").doc(`patient_cash_refund_${resourceType.replaceAll("-", "_")}_${orderId}`);
        const alreadyRequested = order.requestedRefundMethod === "CASH_MANUAL" && order.refundRequestStatus === "REQUESTED";
        const now = FieldValue.serverTimestamp();
        transaction.set(orderRef, { requestedRefundMethod: "CASH_MANUAL", refundRequestStatus: "REQUESTED", refundRequestedAt: now, refundStatus: "PENDING_MANUAL_CASH", updatedAt: now }, { merge: true });
        if (activeAlerts.length) {
          activeAlerts.forEach((alert) => transaction.set(alert.ref, { requestedRefundMethod: "CASH_MANUAL", refundRequestedByUid: user.uid, refundRequestedAt: now }, { merge: true }));
        } else if (!matchingAlerts.some((alert) => alert.id === alertRef.id)) {
          transaction.create(alertRef, { paymentRef, resourceType, resourceId: orderId, reason: "PATIENT_REQUESTED_CASH_REFUND", requestedRefundMethod: "CASH_MANUAL", refundRequestedByUid: user.uid, refundRequestedAt: now, status: "open", createdAt: now });
        }
        transaction.create(auditRef, { actorUid: user.uid, action: "patient_cash_refund_requested", resource: orderRef.path, refundMethod: "CASH_MANUAL", amountMinor: amount * 100, currency: "HTG", createdAt: now });
        return { alreadyRequested };
      });
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, requestedRefundMethod: "CASH_MANUAL", status: "REQUESTED", alreadyRequested: outcome.alreadyRequested });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA diagnostic cash refund request failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "cash-refund-request-failed", "La demande de remboursement en espèces n’a pas pu être enregistrée.");
    }
  });

  const nexaDiagnosticOrderWalletPay = onRequest({ region: REGION, maxInstances: 20 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > 4096 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 4096)) return fail(res, 413, "request-too-large", "La demande de paiement est trop volumineuse.");
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "pay-diagnostic-order-wallet", 8, 5 * 60_000);
      const orderId = clean(bodyOf(req)?.orderId, 200);
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(orderId)) throw new ApiError(400, "invalid-order", "La référence de commande n’est pas valide.");
      const orderRef = db.collection("nexaOrders").doc(orderId);
      const outcome = await db.runTransaction(async (transaction) => {
        const orderSnapshot = await transaction.get(orderRef);
        if (!orderSnapshot.exists || orderSnapshot.get("patientUid") !== user.uid) throw new ApiError(404, "order-not-found", "Cette commande n’est pas accessible.");
        const order = orderSnapshot.data() || {};
        const resourceType = order.kind === "laboratory" ? "laboratory-order" : order.kind === "imaging" ? "imaging-order" : "";
        const paymentRef = typeof order.moncashPaymentRef === "string" ? order.moncashPaymentRef : "";
        if (!resourceType || !PAYMENT_REFERENCE_PATTERN.test(paymentRef)) throw new ApiError(409, "order-payment-invalid", "Le paiement de cette commande ne peut pas être vérifié.");
        const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
        const walletRef = db.collection("nexaPatientWallets").doc(user.uid);
        const profileRef = db.collection("patientProfiles").doc(user.uid);
        const ledgerId = createHash("sha256").update(`NEXA_WALLET_ORDER:${orderId}`).digest("hex");
        const ledgerRef = db.collection("nexaWalletLedger").doc(ledgerId);
        const feeLedgerRef = db.collection("nexaTransactionFeeLedger").doc(paymentRef);
        const eventRef = db.collection("nexaOrderEvents").doc();
        const [paymentSnapshot, walletSnapshot, profileSnapshot, ledgerSnapshot, feeSnapshot] = await Promise.all([
          transaction.get(paymentRefDoc), transaction.get(walletRef), transaction.get(profileRef), transaction.get(ledgerRef), transaction.get(feeLedgerRef),
        ]);
        if (!paymentSnapshot.exists) throw new ApiError(409, "order-payment-invalid", "La référence de paiement n’existe plus.");
        const payment = paymentSnapshot.data() || {};
        const amount = Number(order.amount);
        const fee = Number(order.transactionFee || 0);
        const total = Number(order.totalAmount ?? amount + fee);
        const serviceMinor = amount * 100;
        const feeMinor = fee * 100;
        const totalMinor = total * 100;
        const paymentMatches = payment.uid === user.uid && payment.resourceType === resourceType && payment.resourcePath === orderRef.path &&
          orderPaymentMatches(order, payment) && payment.currency === "HTG" && order.currency === "HTG";
        if (!paymentMatches || !Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(fee) || fee < 0 || !Number.isSafeInteger(total) || total > 10_000_000 || !Number.isSafeInteger(totalMinor)) throw new ApiError(409, "order-payment-invalid", "Le montant de cette commande ne peut pas être vérifié.");
        const expectedFeeMethod = payment.paymentMethod === "MONCASH" ? "MONCASH" : "SMART_WALLET";
        const feeLedgerMatches = fee === 0 ? !feeSnapshot.exists : feeSnapshot.exists && feeSnapshot.get("paymentRef") === paymentRef &&
          feeSnapshot.get("resourceType") === resourceType && feeSnapshot.get("resourceId") === orderId && Number(feeSnapshot.get("serviceAmountMinor")) === serviceMinor &&
          Number(feeSnapshot.get("amountMinor")) === feeMinor && feeSnapshot.get("recipient") === "NEXARIS" && feeSnapshot.get("paymentMethod") === expectedFeeMethod && feeSnapshot.get("status") === "COMPLETED";
        if (feeSnapshot.exists && !feeLedgerMatches) throw new ApiError(409, "transaction-fee-ledger-conflict", "Le registre des frais ne concorde pas avec ce paiement.");
        if (payment.status === "paid" && payment.paymentMethod === "MONCASH") {
          return { paymentRef, alreadyPaid: true, needsSettlement: order.settlementStatus !== "CONFIRMED", paymentMethod: "MONCASH", orderStatus: clean(order.status, 50) };
        }
        if (ledgerSnapshot.exists) {
          const ledger = ledgerSnapshot.data() || {};
          if (ledger.userUid !== user.uid || ledger.resourceId !== orderId || ledger.resourceType !== resourceType || ledger.direction !== "DEBIT" ||
            Number(ledger.amountMinor) !== totalMinor || Number(ledger.serviceAmountMinor) !== serviceMinor || Number(ledger.transactionFeeMinor || 0) !== feeMinor ||
            payment.status !== "paid" || payment.paymentMethod !== "SMART_WALLET" || !feeLedgerMatches) throw new ApiError(409, "wallet-ledger-conflict", "Le registre du portefeuille et le paiement ne concordent pas.");
          return { paymentRef, alreadyPaid: true, needsSettlement: false, paymentMethod: "SMART_WALLET", orderStatus: clean(order.status, 50) };
        }
        if (!profileSnapshot.exists || profileSnapshot.get("role") !== "patient" || profileSnapshot.get("profileComplete") !== true) throw new ApiError(403, "complete-patient-profile-required", "Un profil patient complet est requis.");
        if (order.status !== "PENDING_PAYMENT" || order.paymentStatus !== "PENDING" || order.settlementStatus !== "PENDING" || order.refundRequired === true) throw new ApiError(409, "order-not-payable", "Cette commande n’accepte plus de paiement Wallet.");
        if (payment.status !== "created" || payment.paymentMethod !== "MONCASH") throw new ApiError(409, "payment-method-already-started", "Un paiement MonCash a déjà commencé. Terminez-le ou demandez une vérification avant de choisir Wallet.");
        if (Number(order.holdExpiresAt || 0) && Number(order.holdExpiresAt) <= Date.now()) throw new ApiError(409, "order-hold-expired", "La retenue de cette commande a expiré. Préparez une nouvelle commande.");
        const wallet = walletSnapshot.data() || {};
        const available = Number(wallet.availableMinor || 0);
        const reserved = Number(wallet.reservedMinor || 0);
        if (!walletSnapshot.exists || wallet.status !== "ACTIVE" || wallet.currency !== "HTG" || !Number.isSafeInteger(available) || available < totalMinor || !Number.isSafeInteger(reserved) || reserved < 0) throw new ApiError(409, "insufficient-wallet-balance", "Le Wallet est suspendu ou son solde ne couvre pas le total et les frais.");
        const now = FieldValue.serverTimestamp();
        transaction.update(walletRef, { availableMinor: available - totalMinor, updatedAt: now });
        transaction.create(ledgerRef, {
          userUid: user.uid, walletId: user.uid, type: `${String(order.kind).toUpperCase()}_ORDER_PAYMENT`, direction: "DEBIT",
          amountMinor: totalMinor, serviceAmountMinor: serviceMinor, transactionFeeMinor: feeMinor, currency: "HTG",
          resourceType, resourceId: orderId, paymentRef, source: "NEXA", status: "COMPLETED", createdAt: now,
        });
        if (feeMinor > 0) transaction.create(feeLedgerRef, {
          paymentRef, resourceType, resourceId: orderId, serviceAmountMinor: serviceMinor, amountMinor: feeMinor,
          currency: "HTG", recipient: "NEXARIS", transactionFeeRateBps: Number(order.transactionFeeRateBps) || 0,
          paymentMethod: "SMART_WALLET", status: "COMPLETED", createdAt: now,
        });
        transaction.set(paymentRefDoc, { status: "paid", paymentMethod: "SMART_WALLET", paymentProvider: "nexa-wallet", walletLedgerId: ledgerId, paidAt: now, updatedAt: now }, { merge: true });
        transaction.set(orderRef, { status: "PAID", paymentStatus: "PAID", paymentMethod: "SMART_WALLET", settlementStatus: "CONFIRMED", paidAt: now, updatedAt: now }, { merge: true });
        transaction.create(eventRef, { orderId, fromStatus: "PENDING_PAYMENT", toStatus: "PAID", action: "WALLET_SETTLED", actorUid: user.uid, createdAt: now });
        return { paymentRef, alreadyPaid: false, needsSettlement: false, paymentMethod: "SMART_WALLET", orderStatus: "PAID", providerUid: clean(order.providerUid, 200), patientUid: user.uid };
      });
      if (outcome.paymentMethod === "MONCASH") {
        if (outcome.needsSettlement) await settlePaidDiagnosticOrderPayment(outcome.paymentRef);
        res.set("Cache-Control", "no-store, max-age=0");
        return res.status(200).json({ ok: true, status: "paid", paymentMethod: "MONCASH", orderStatus: outcome.orderStatus, alreadyPaid: true });
      }
      if (!outcome.alreadyPaid) {
        const tasks = [createNexaNotification(user.uid, `order:payment:${outcome.paymentRef}`, {
          type: "order_payment_confirmed", title: "Paiement confirmé", body: "Votre commande est payée. Vous recevrez une notification lors de sa prise en charge.", url: "/espace-patient.html#commandes",
        })];
        if (outcome.providerUid) tasks.push(createNexaNotification(outcome.providerUid, `order:payment:${outcome.paymentRef}`, {
          type: "order_payment_confirmed", title: "Nouvelle commande payée", body: "Une commande NEXA a été réglée. Consultez votre espace centre.", url: "/espace-centre.html",
        }));
        await Promise.all(tasks);
      }
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, status: "paid", paymentMethod: "SMART_WALLET", orderStatus: outcome.orderStatus, alreadyPaid: outcome.alreadyPaid });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA diagnostic Wallet payment failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "wallet-order-payment-failed", "Le paiement Wallet de la commande n’a pas abouti.");
    }
  });

  async function settlePaidDiagnosticOrderPayment(paymentRef) {
    const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
    const preview = await paymentRefDoc.get();
    const resourceType = String(preview.get("resourceType") || "");
    const kind = ORDER_RESOURCE_KINDS[resourceType];
    if (!preview.exists || preview.get("status") !== "paid" || preview.get("paymentMethod") !== "MONCASH" || !kind) return null;
    const resourcePath = String(preview.get("resourcePath") || "");
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
      if (!paymentSnapshot.exists || paymentSnapshot.get("status") !== "paid" || paymentSnapshot.get("resourcePath") !== resourcePath) return null;
      const payment = paymentSnapshot.data() || {};
      const order = orderSnapshot.data() || {};
      const patientUid = String(payment.uid || "");
      const fee = Number(order.transactionFee || 0);
      const feeMatches = fee === 0 ? !feeSnapshot.exists : feeSnapshot.exists && feeSnapshot.get("paymentRef") === paymentRef &&
        feeSnapshot.get("resourceType") === resourceType && feeSnapshot.get("resourceId") === orderRef.id &&
        Number(feeSnapshot.get("serviceAmountMinor")) === Number(order.amount) * 100 && Number(feeSnapshot.get("amountMinor")) === fee * 100 &&
        feeSnapshot.get("recipient") === "NEXARIS" && feeSnapshot.get("paymentMethod") === "MONCASH" && feeSnapshot.get("status") === "COMPLETED";
      const matches = orderSnapshot.exists && order.kind === kind && order.patientUid === patientUid && order.moncashPaymentRef === paymentRef &&
        orderPaymentMatches(order, payment) && order.currency === "HTG" && payment.currency === "HTG";
      if (matches && order.status === "PAID" && order.paymentStatus === "PAID" && order.settlementStatus === "CONFIRMED") {
        if (!feeMatches) {
          if (!alertSnapshot.exists) transaction.create(alertRef, { paymentRef, resourceType, resourceId: orderRef.id, reason: "TRANSACTION_FEE_LEDGER_MISMATCH", status: "open", createdAt: FieldValue.serverTimestamp() });
          return { patientUid, providerUid: clean(order.providerUid, 200), orderId: orderRef.id, confirmed: false };
        }
        if (fee > 0 && !feeSnapshot.exists) transaction.create(feeLedgerRef, {
          paymentRef, resourceType, resourceId: orderRef.id, serviceAmountMinor: Number(order.amount) * 100, amountMinor: fee * 100,
          currency: "HTG", recipient: "NEXARIS", transactionFeeRateBps: Number(order.transactionFeeRateBps) || 0,
          paymentMethod: "MONCASH", status: "COMPLETED", createdAt: FieldValue.serverTimestamp(),
        });
        return null;
      }
      if (!matches || (feeSnapshot.exists && !feeMatches) || order.status !== "PENDING_PAYMENT" || order.paymentStatus !== "PENDING") {
        if (!alertSnapshot.exists) transaction.create(alertRef, {
          paymentRef, resourceType, resourceId: orderRef.id, reason: !matches ? "ORDER_PAYMENT_MISMATCH" : "ORDER_NOT_PAYABLE_AT_SETTLEMENT",
          status: "open", createdAt: FieldValue.serverTimestamp(),
        });
        if (orderSnapshot.exists && order.patientUid === patientUid && order.moncashPaymentRef === paymentRef) transaction.set(orderRef, {
          paymentStatus: "PAID", settlementStatus: "REVIEW_REQUIRED", paidAt: order.paidAt || FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return { patientUid, providerUid: clean(order.providerUid, 200), orderId: orderRef.id, confirmed: false };
      }
      if (fee > 0 && !feeSnapshot.exists) transaction.create(feeLedgerRef, {
        paymentRef, resourceType, resourceId: orderRef.id, serviceAmountMinor: Number(order.amount) * 100, amountMinor: fee * 100,
        currency: "HTG", recipient: "NEXARIS", transactionFeeRateBps: Number(order.transactionFeeRateBps) || 0,
        paymentMethod: "MONCASH", status: "COMPLETED", createdAt: FieldValue.serverTimestamp(),
      });
      transaction.set(orderRef, { paymentStatus: "PAID", status: "PAID", settlementStatus: "CONFIRMED", paidAt: order.paidAt || FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      transaction.create(eventRef, { orderId: orderRef.id, fromStatus: "PENDING_PAYMENT", toStatus: "PAID", action: "MONCASH_SETTLED", actorUid: "system:moncash", createdAt: FieldValue.serverTimestamp() });
      return { patientUid, providerUid: clean(order.providerUid, 200), orderId: orderRef.id, confirmed: true };
    });
    if (outcome?.patientUid) {
      await createNexaNotification(outcome.patientUid, `order:payment:${paymentRef}`, {
        type: outcome.confirmed ? "order_payment_confirmed" : "order_payment_reconciliation",
        title: outcome.confirmed ? "Paiement confirmé" : "Paiement à rapprocher",
        body: outcome.confirmed ? "Votre commande est payée. Vous recevrez une notification lors de sa prise en charge." : "Le paiement a été reçu, mais NEXA doit vérifier la commande. Ne payez pas une seconde fois.",
        url: "/espace-patient.html#commandes",
      });
      if (outcome.confirmed && outcome.providerUid) await createNexaNotification(outcome.providerUid, `order:payment:${paymentRef}`, {
        type: "order_payment_confirmed", title: "Nouvelle commande payée", body: "Une commande NEXA a été réglée. Consultez votre espace centre.", url: "/espace-centre.html",
      });
    }
    return outcome;
  }

  return { nexaDiagnosticOrderCreate, nexaPatientOrders, nexaDiagnosticOrderWalletPay, nexaPatientRequestDiagnosticCashRefund, settlePaidDiagnosticOrderPayment };
};
