"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { FieldPath } = require("firebase-admin/firestore");

const REGION = "us-east4";
const RATING_KEYS = ["punctuality", "professionalism", "listening", "explanations", "satisfaction"];
const COMPLETIONS = new Set(["COMPLETED", "PARTIAL", "NOT_COMPLETED"]);
const PATIENT_HOME_VISIT_REPORT_PAGE_SIZE = 25;
const ADMIN_HOME_VISIT_REVIEW_PAGE_SIZE = 50;

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

function validRating(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
}

function missionCodeHash(appointmentId, code) {
  return createHash("sha256").update(`NEXA_HOME_VISIT:${appointmentId}:${code}`).digest("hex");
}

function iso(value) {
  return value && typeof value.toDate === "function" ? value.toDate().toISOString() : typeof value === "string" ? value : null;
}

module.exports = function createNexaHomeVisitFunctions(dependencies) {
  const {
    db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit,
    setCors, fail, logger, createNexaNotification, appointmentPaymentMatches,
  } = dependencies;

  async function notify(uid, eventKey, notification, appointmentId) {
    if (typeof createNexaNotification !== "function" || !uid) return;
    try { await createNexaNotification(uid, eventKey, notification, appointmentId); }
    catch (error) { logger.warn("NEXA home visit notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }); }
  }

  async function creditNoShowWalletRefund(appointmentId, adminReview = null) {
    const adminUid = typeof adminReview?.adminUid === "string" ? adminReview.adminUid : "";
    const isAdminReview = Boolean(adminUid);
    const adminReason = typeof adminReview?.reason === "string" ? adminReview.reason : "";
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const reportRef = db.collection("homeVisitMissionReports").doc(appointmentId);
    const ledgerId = createHash("sha256").update(`NEXA_WALLET_REFUND:appointment:${appointmentId}`).digest("hex");
    const refundLedgerId = createHash("sha256").update(`NEXA_REFUND:appointment:${appointmentId}`).digest("hex");
    const walletLedgerRef = db.collection("nexaWalletLedger").doc(ledgerId);
    const refundRef = db.collection("nexaRefundLedger").doc(refundLedgerId);
    const alertRef = db.collection("paymentSettlementAlerts").doc(`appointment_no_show_${appointmentId}`);
    const auditRef = db.collection("paymentAuditLogs").doc();

    const result = await db.runTransaction(async (transaction) => {
      const appointmentSnapshot = await transaction.get(appointmentRef);
      const reportSnapshot = await transaction.get(reportRef);
      if (!appointmentSnapshot.exists || !reportSnapshot.exists) return { eligible: false };
      const source = appointmentSnapshot.data() || {};
      const report = reportSnapshot.data() || {};
      const alreadyRefunded = source.status === "REFUNDED" && source.paymentStatus === "REFUNDED" &&
        source.refundMethod === "NEXA_WALLET" && source.refundStatus === "COMPLETED" &&
        (!isAdminReview || source.homeVisitAdminDecision === "REFUND_WALLET");
      const pendingNoShowRefund = source.status === "PROVIDER_NO_SHOW_REFUND_REQUIRED" && source.paymentStatus === "PAID" &&
        source.refundRequired === true && source.refundStatus === "PENDING_AUTO_REFUND" &&
        source.homeVisitMissionStatus === "PROVIDER_ABSENT_REFUND_REQUIRED";
      const pendingAdminReviewRefund = source.status === "CONFIRMED" && source.paymentStatus === "PAID" &&
        source.homeVisitMissionStatus === "ADMIN_REVIEW_REQUIRED" && report.providerPresent === true &&
        !source.refundRequired && !source.refundStatus;
      const pendingRefund = isAdminReview ? pendingAdminReviewRefund : pendingNoShowRefund;
      if ((!alreadyRefunded && !pendingRefund) || source.bookingType !== "home_visit" ||
        report.patientUid !== source.patientUid || (isAdminReview ? report.providerPresent !== true : report.providerPresent !== false) ||
        source.requestedRefundMethod === "CASH_MANUAL" || source.refundStatus === "PENDING_MANUAL_CASH") return { eligible: false };

      const patientUid = typeof source.patientUid === "string" ? source.patientUid : "";
      const paymentRef = typeof source.moncashPaymentRef === "string" ? source.moncashPaymentRef : "";
      const amount = Number(source.amount);
      const amountMinor = amount * 100;
      const fee = Number(source.transactionFee || 0);
      if (!patientUid || !/^[A-Za-z0-9_-]{20,64}$/.test(paymentRef) || !Number.isSafeInteger(amount) || amount <= 0 ||
        amount > 10_000_000 || !Number.isSafeInteger(amountMinor) || !Number.isSafeInteger(fee) || fee < 0) {
        throw new ApiError(409, "refund-source-invalid", "Le remboursement NEXA ne peut pas être confirmé.");
      }

      const [walletSnapshot, profileSnapshot, paymentSnapshot, walletLedgerSnapshot, refundSnapshot, alertSnapshot, relatedAlerts] = await Promise.all([
        transaction.get(db.collection("nexaPatientWallets").doc(patientUid)),
        transaction.get(db.collection("patientProfiles").doc(patientUid)),
        transaction.get(db.collection("paymentIntents").doc(paymentRef)),
        transaction.get(walletLedgerRef),
        transaction.get(refundRef),
        transaction.get(alertRef),
        transaction.get(db.collection("paymentSettlementAlerts").where("resourceId", "==", appointmentId).limit(100)),
      ]);
      if (relatedAlerts.docs.some((alert) => ["manual_refund_confirmed", "manual_cash_refund_confirmed", "manual_moncash_refund_confirmed"].includes(String(alert.get("resolution") || "")))) {
        throw new ApiError(409, "external-refund-already-recorded", "Un remboursement externe est déjà enregistré pour cette visite.");
      }
      if (walletLedgerSnapshot.exists !== refundSnapshot.exists) throw new ApiError(409, "refund-ledger-conflict", "Les registres du remboursement ne concordent pas.");
      if (walletLedgerSnapshot.exists) {
        const ledger = walletLedgerSnapshot.data() || {};
        const refund = refundSnapshot.data() || {};
        if (ledger.userUid !== patientUid || ledger.resourceType !== "appointment" || ledger.resourceId !== appointmentId ||
          ledger.direction !== "CREDIT" || ledger.type !== "REFUND" || ledger.status !== "COMPLETED" || ledger.currency !== "HTG" ||
          ledger.paymentRef !== paymentRef || Number(ledger.amountMinor) !== amountMinor || refund.userUid !== patientUid ||
          refund.resourceType !== "appointment" || refund.resourceId !== appointmentId || refund.paymentRef !== paymentRef ||
          refund.currency !== "HTG" || refund.status !== "COMPLETED" || refund.refundMethod !== "NEXA_WALLET" ||
          Number(refund.amountMinor) !== amountMinor || refund.walletLedgerId !== ledgerId) {
          throw new ApiError(409, "refund-ledger-conflict", "Le registre contient un remboursement incompatible.");
        }
        return {
          eligible: true,
          alreadyProcessed: true,
          patientUid,
          providerUid: typeof source.providerUid === "string" ? source.providerUid : "",
          amount,
        };
      }
      if (alreadyRefunded) throw new ApiError(409, "refund-ledger-conflict", "La visite est marquée remboursée sans registre Wallet concordant.");

      const payment = paymentSnapshot.data() || {};
      if (!profileSnapshot.exists || profileSnapshot.get("role") !== "patient" || profileSnapshot.get("profileComplete") !== true ||
        !paymentSnapshot.exists || payment.status !== "paid" || payment.resourceType !== "appointment" ||
        payment.resourcePath !== `appointments/${appointmentId}` || payment.uid !== patientUid ||
        !["MONCASH", "SMART_WALLET", "NEXA_WALLET"].includes(String(payment.paymentMethod || "")) ||
        String(payment.currency || "").toUpperCase() !== "HTG" || String(source.currency || "").toUpperCase() !== "HTG" ||
        typeof appointmentPaymentMatches !== "function" || !appointmentPaymentMatches(source, payment)) {
        throw new ApiError(409, "refund-payment-mismatch", "Le paiement ne correspond pas au prix du service à rembourser.");
      }
      const wallet = walletSnapshot.data() || {};
      const availableMinor = wallet.availableMinor === undefined ? 0 : Number(wallet.availableMinor);
      const reservedMinor = wallet.reservedMinor === undefined ? 0 : Number(wallet.reservedMinor);
      if (!Number.isSafeInteger(availableMinor) || availableMinor < 0 || !Number.isSafeInteger(reservedMinor) || reservedMinor < 0 ||
        !Number.isSafeInteger(availableMinor + amountMinor) || (wallet.currency && wallet.currency !== "HTG") || (wallet.status && wallet.status !== "ACTIVE")) {
        throw new ApiError(409, "wallet-state-invalid", "Le portefeuille NEXA ne peut pas recevoir le remboursement actuellement.");
      }
      const now = FieldValue.serverTimestamp();
      transaction.set(db.collection("nexaPatientWallets").doc(patientUid), {
        userUid: patientUid, currency: "HTG", availableMinor: availableMinor + amountMinor,
        reservedMinor, status: wallet.status || "ACTIVE", updatedAt: now,
      }, { merge: true });
      transaction.create(walletLedgerRef, {
        userUid: patientUid, walletId: patientUid, type: "REFUND", direction: "CREDIT", amountMinor,
        currency: "HTG", resourceType: "appointment", resourceId: appointmentId, paymentRef,
        reason: isAdminReview ? "home-visit-admin-review" : "home-visit-provider-absence",
        source: isAdminReview ? "NEXA_ADMIN" : "NEXA_AUTOMATIC_REFUND", status: "COMPLETED",
        createdAt: now, createdByUid: adminUid || "system:nexa-home-visit-provider-absence",
      });
      transaction.create(refundRef, {
        userUid: patientUid, resourceType: "appointment", resourceId: appointmentId, paymentRef,
        amountMinor, currency: "HTG", refundMethod: "NEXA_WALLET", serviceAmountMinor: amountMinor,
        ...(fee > 0 ? { nonRefundableTransactionFeeMinor: fee * 100 } : {}),
        walletLedgerId: ledgerId, status: "COMPLETED", createdAt: now,
        createdByUid: adminUid || "system:nexa-home-visit-provider-absence",
      });
      transaction.set(appointmentRef, {
        status: "REFUNDED", paymentStatus: "REFUNDED", refundRequired: false, refundStatus: "COMPLETED",
        refundMethod: "NEXA_WALLET", refundedAmount: amount, refundedAmountMinor: amountMinor,
        ...(fee > 0 ? { nonRefundableTransactionFee: fee } : {}), refundedAt: now,
        refundedByUid: adminUid || "system:nexa-automatic-refund", refundLedgerId, walletLedgerId: ledgerId,
        ...(isAdminReview ? {
          homeVisitMissionStatus: "REFUNDED",
          homeVisitAdminDecision: "REFUND_WALLET",
          homeVisitAdminDecisionReason: adminReason,
          homeVisitAdminReviewedByUid: adminUid,
          homeVisitAdminReviewedAt: now,
        } : {}),
        updatedAt: now,
      }, { merge: true });
      transaction.set(alertRef, {
        resourceType: "appointment", resourceId: appointmentId, status: "resolved",
        resolution: "nexa_wallet_refund_credited", refundMethod: "NEXA_WALLET", amountMinor,
        createdAt: alertSnapshot.exists ? alertSnapshot.get("createdAt") : now, updatedAt: now,
      }, { merge: true });
      transaction.create(auditRef, {
        actorUid: adminUid || "system:nexa-home-visit-provider-absence",
        action: isAdminReview ? "admin_home_visit_wallet_refund_credited" : "home_visit_provider_absence_wallet_refund",
        resource: `appointments/${appointmentId}`, amountMinor, currency: "HTG", createdAt: now,
      });
      if (isAdminReview) {
        transaction.create(db.collection("adminAuditLogs").doc(), {
          actorUid: adminUid, action: "admin_home_visit_mission_refunded_to_wallet",
          resource: `appointments/${appointmentId}`, decisionReason: adminReason,
          amountMinor, currency: "HTG", createdAt: now,
        });
      }
      return {
        eligible: true,
        alreadyProcessed: false,
        patientUid,
        providerUid: typeof source.providerUid === "string" ? source.providerUid : "",
        amount,
      };
    });
    if (result.eligible && result.patientUid && !result.alreadyProcessed) {
      await notify(result.patientUid, `home-visit:${appointmentId}:${isAdminReview ? "admin-wallet-refund" : "absence-wallet-refund"}`, {
        type: "wallet_refund_credited", title: "Remboursement crédité au portefeuille",
        body: `${new Intl.NumberFormat("fr-HT").format(result.amount)} HTG correspondant au prix du service sont crédités à votre portefeuille NEXA. Les frais de transaction ne sont pas remboursés.`,
        url: "/espace-patient.html",
      }, appointmentId);
    }
    return result;
  }

  const nexaHomeVisitMissionStart = onRequest({ region: REGION }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > 1_024 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 1_024)) {
      return fail(res, 413, "request-too-large", "La demande de démarrage dépasse la taille autorisée.");
    }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "start-home-visit-mission", 20, 10 * 60_000);
      const body = getBody(req);
      const appointmentId = typeof body?.appointmentId === "string" ? body.appointmentId.trim() : "";
      if (!body || Object.keys(body).some((key) => key !== "appointmentId") || !/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) {
        throw new ApiError(400, "invalid-home-visit", "La référence de visite n’est pas valide.");
      }
      const appointmentRef = db.collection("appointments").doc(appointmentId);
      const providerRef = db.collection("providerProfiles").doc(user.uid);
      const auditRef = db.collection("paymentAuditLogs").doc();
      const outcome = await db.runTransaction(async (transaction) => {
        const [appointmentSnapshot, providerSnapshot] = await Promise.all([
          transaction.get(appointmentRef), transaction.get(providerRef),
        ]);
        if (!providerSnapshot.exists || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("clinicalCredentialsVerified") !== true) {
          throw new ApiError(403, "verified-doctor-required", "Le démarrage est réservé au médecin NEXA vérifié.");
        }
        if (!appointmentSnapshot.exists || appointmentSnapshot.get("providerUid") !== user.uid || appointmentSnapshot.get("bookingType") !== "home_visit") {
          throw new ApiError(404, "home-visit-not-found", "Cette visite n’est pas accessible.");
        }
        const appointment = appointmentSnapshot.data() || {};
        if (appointment.paymentStatus !== "PAID" || appointment.status !== "CONFIRMED" || appointment.homeVisitMissionStatus !== "SCHEDULED") {
          throw new ApiError(409, "home-visit-not-ready-to-start", "Seule une visite payée et confirmée peut être démarrée.");
        }
        const startsAt = Date.parse(String(appointment.startsAt || ""));
        if (!Number.isFinite(startsAt) || Date.now() < startsAt) {
          throw new ApiError(409, "home-visit-not-started-time", "La visite ne peut pas commencer avant l’heure réservée.");
        }
        if (appointment.effectiveConsultationStartedAt || appointment.homeVisitMissionStartedAt) {
          return { alreadyStarted: true, patientUid: appointment.patientUid };
        }
        const now = FieldValue.serverTimestamp();
        transaction.set(appointmentRef, {
          effectiveConsultationStartedAt: now,
          homeVisitMissionStartedAt: now,
          homeVisitMissionStartedByUid: user.uid,
          updatedAt: now,
        }, { merge: true });
        transaction.create(auditRef, {
          actorUid: user.uid, action: "home_visit_mission_started",
          resource: `appointments/${appointmentId}`, createdAt: now,
        });
        return { alreadyStarted: false, patientUid: appointment.patientUid };
      });
      if (!outcome.alreadyStarted) {
        await notify(outcome.patientUid, `home-visit:${appointmentId}:mission-started`, {
          type: "home_visit_mission_started", title: "Visite NEXA commencée",
          body: "Le médecin a indiqué le début de votre visite. Vos informations cliniques restent accessibles uniquement pendant la prise en charge autorisée.",
          url: "/espace-patient.html",
        }, appointmentId);
      }
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, started: true, alreadyStarted: outcome.alreadyStarted });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA home visit mission start failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "home-visit-start-failed", "La visite ne peut pas être démarrée pour le moment.");
    }
  });

  const nexaPatientHomeVisitFeedback = onRequest({ region: REGION }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > 8_192 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 8_192)) {
      return fail(res, 413, "request-too-large", "Le formulaire dépasse la taille autorisée.");
    }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "submit-home-visit-feedback", 4, 10 * 60_000);
      const body = getBody(req);
      const appointmentId = typeof body?.appointmentId === "string" ? body.appointmentId.trim() : "";
      if (!body || !/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) throw new ApiError(400, "invalid-appointment", "La référence de la visite n’est pas valide.");
      const input = { ...body };
      delete input.appointmentId;
      if (input.retryNoShowRefund === true && Object.keys(input).length === 1) {
        const appointment = await db.collection("appointments").doc(appointmentId).get();
        const report = await db.collection("homeVisitMissionReports").doc(appointmentId).get();
        if (!appointment.exists || appointment.get("patientUid") !== user.uid || appointment.get("bookingType") !== "home_visit" ||
          appointment.get("status") !== "PROVIDER_NO_SHOW_REFUND_REQUIRED" || appointment.get("refundStatus") !== "PENDING_AUTO_REFUND" ||
          appointment.get("homeVisitMissionStatus") !== "PROVIDER_ABSENT_REFUND_REQUIRED" || !report.exists ||
          report.get("patientUid") !== user.uid || report.get("providerPresent") !== false) {
          throw new ApiError(409, "home-visit-refund-not-retryable", "Aucun remboursement de visite en attente ne peut être repris.");
        }
        const refund = await creditNoShowWalletRefund(appointmentId);
        if (!refund.eligible) throw new ApiError(409, "home-visit-refund-not-eligible", "Le remboursement ne peut pas être repris pour cette visite.");
        return res.status(200).json({ ok: true, missionStatus: "REFUNDED", refundMethod: "NEXA_WALLET", refundedAmount: refund.amount, currency: "HTG" });
      }

      const allowed = new Set(["providerPresent", "identityMatched", "serviceCompletion", "examPerformed", "prescriptionProvided", "additionalExamsRecommended", "questionsAnswered", "visitStartedAt", "visitEndedAt", "ratings", "comment", "signatureName", "signerRole", "patientConfirmed", "signatureConsent", "refundMethod"]);
      if (Object.keys(input).some((key) => !allowed.has(key))) throw new ApiError(400, "unexpected-feedback-field", "Le formulaire contient un champ non pris en charge.");
      const present = input.providerPresent === true;
      const serviceCompletion = typeof input.serviceCompletion === "string" ? input.serviceCompletion : "";
      const signatureName = cleanText(input.signatureName, 160);
      const signerRole = input.signerRole === "REPRESENTATIVE" ? "REPRESENTATIVE" : input.signerRole === "PATIENT" ? "PATIENT" : "";
      const ratingsInput = input.ratings && typeof input.ratings === "object" && !Array.isArray(input.ratings) ? input.ratings : {};
      const ratings = Object.fromEntries(RATING_KEYS.map((key) => [key, validRating(ratingsInput[key]) ]));
      const startsAt = typeof input.visitStartedAt === "string" ? Date.parse(input.visitStartedAt) : Number.NaN;
      const endsAt = typeof input.visitEndedAt === "string" ? Date.parse(input.visitEndedAt) : Number.NaN;
      const refundMethod = input.refundMethod === undefined ? "NEXA_WALLET" : input.refundMethod;
      if (typeof input.providerPresent !== "boolean" || typeof input.identityMatched !== "boolean" || input.patientConfirmed !== true || input.signatureConsent !== true) {
        throw new ApiError(400, "feedback-confirmation-required", "Confirmez la présence, vos réponses et la signature électronique avant l’envoi.");
      }
      if (!COMPLETIONS.has(serviceCompletion) || !signatureName || !signerRole) throw new ApiError(400, "feedback-incomplete", "Indiquez l’état du service et le nom du patient ou de son représentant.");
      if (!(refundMethod === "NEXA_WALLET" || refundMethod === "CASH_MANUAL") || (present && refundMethod !== "NEXA_WALLET")) {
        throw new ApiError(400, "invalid-home-visit-refund-method", "Le remboursement en espèces est proposé uniquement si le médecin est absent.");
      }
      if (present && (RATING_KEYS.some((key) => ratings[key] === null) || !Number.isFinite(startsAt) || !Number.isFinite(endsAt) || startsAt >= endsAt || endsAt > Date.now())) {
        throw new ApiError(400, "visit-review-incomplete", "Pour une visite réalisée, indiquez les horaires et toutes les évaluations.");
      }
      if (!present && (input.identityMatched || serviceCompletion !== "NOT_COMPLETED")) throw new ApiError(400, "provider-absence-report-invalid", "Signalez une visite non réalisée si le médecin est absent.");

      const appointmentRef = db.collection("appointments").doc(appointmentId);
      const reportRef = db.collection("homeVisitMissionReports").doc(appointmentId);
      const patientRef = db.collection("patientProfiles").doc(user.uid);
      const auditRef = db.collection("paymentAuditLogs").doc();
      const alertRef = db.collection("paymentSettlementAlerts").doc();
      const adminAuditRef = db.collection("adminAuditLogs").doc();
      let providerUid = "";
      let manualCash = false;
      let missionStatus = "";
      await db.runTransaction(async (transaction) => {
        const [appointmentSnapshot, reportSnapshot, patientSnapshot] = await Promise.all([
          transaction.get(appointmentRef), transaction.get(reportRef), transaction.get(patientRef),
        ]);
        if (!patientSnapshot.exists || patientSnapshot.get("role") !== "patient" || patientSnapshot.get("profileComplete") !== true) {
          throw new ApiError(403, "complete-patient-profile-required", "Un compte patient NEXA complet est requis.");
        }
        if (!appointmentSnapshot.exists || appointmentSnapshot.get("patientUid") !== user.uid || appointmentSnapshot.get("bookingType") !== "home_visit") {
          throw new ApiError(404, "home-visit-not-found", "Cette visite n’est pas accessible.");
        }
        if (reportSnapshot.exists) throw new ApiError(409, "home-visit-feedback-already-submitted", "Le formulaire de cette visite a déjà été envoyé.");
        const appointment = appointmentSnapshot.data() || {};
        if (appointment.paymentStatus !== "PAID" || appointment.status !== "CONFIRMED" || appointment.homeVisitMissionStatus !== "SCHEDULED") {
          throw new ApiError(409, "home-visit-not-ready-for-feedback", "La visite doit être payée et confirmée avant l’envoi du formulaire.");
        }
        const scheduledEnd = Date.parse(String(appointment.endsAt || ""));
        if (!Number.isFinite(scheduledEnd) || Date.now() < scheduledEnd) throw new ApiError(409, "home-visit-not-finished", "Le formulaire devient disponible après l’heure prévue de fin de la visite.");
        providerUid = typeof appointment.providerUid === "string" ? appointment.providerUid : "";
        if (!providerUid) throw new ApiError(409, "home-visit-provider-unavailable", "Le professionnel associé à cette visite n’est pas disponible.");
        if (!present && refundMethod === "CASH_MANUAL") {
          const paymentRef = typeof appointment.moncashPaymentRef === "string" ? appointment.moncashPaymentRef : "";
          const paymentSnapshot = await transaction.get(db.collection("paymentIntents").doc(paymentRef));
          const payment = paymentSnapshot.data() || {};
          if (!/^[A-Za-z0-9_-]{20,64}$/.test(paymentRef) || !paymentSnapshot.exists || payment.status !== "paid" ||
            !["MONCASH", "SMART_WALLET", "NEXA_WALLET"].includes(String(payment.paymentMethod || "")) ||
            payment.resourceType !== "appointment" || payment.resourcePath !== `appointments/${appointmentId}` || payment.uid !== user.uid ||
            typeof appointmentPaymentMatches !== "function" || !appointmentPaymentMatches(appointment, payment) || String(payment.currency || "").toUpperCase() !== "HTG") {
            throw new ApiError(409, "refund-payment-mismatch", "Le paiement de cette visite ne correspond pas à la demande.");
          }
        }
        const now = FieldValue.serverTimestamp();
        transaction.create(reportRef, {
          appointmentId, patientUid: user.uid, providerUid, providerPresent: present,
          identityMatched: input.identityMatched, serviceCompletion,
          examPerformed: input.examPerformed === true, prescriptionProvided: input.prescriptionProvided === true,
          additionalExamsRecommended: input.additionalExamsRecommended === true, questionsAnswered: input.questionsAnswered === true,
          ...(present ? { visitStartedAt: new Date(startsAt).toISOString(), visitEndedAt: new Date(endsAt).toISOString(), ratings } : {}),
          comment: cleanText(input.comment, 500), patientConfirmed: true,
          signature: { name: signatureName, signerRole, consented: true, signedAt: now }, createdAt: now, updatedAt: now,
        });
        if (present && input.identityMatched === true && serviceCompletion !== "NOT_COMPLETED") {
          missionStatus = "AWAITING_PROVIDER_CODE";
          transaction.set(appointmentRef, {
            homeVisitMissionStatus: missionStatus, homeVisitPatientConfirmedAt: now,
            homeVisitProviderPresent: true, homeVisitIdentityMatched: true,
            homeVisitServiceCompletion: serviceCompletion, updatedAt: now,
          }, { merge: true });
        } else if (present) {
          missionStatus = "ADMIN_REVIEW_REQUIRED";
          transaction.set(appointmentRef, {
            homeVisitMissionStatus: missionStatus, homeVisitPatientConfirmedAt: now,
            homeVisitProviderPresent: true, homeVisitIdentityMatched: input.identityMatched === true,
            homeVisitServiceCompletion: serviceCompletion, updatedAt: now,
          }, { merge: true });
        } else {
          missionStatus = "PROVIDER_ABSENT_REFUND_REQUIRED";
          manualCash = refundMethod === "CASH_MANUAL";
          transaction.set(appointmentRef, {
            status: "PROVIDER_NO_SHOW_REFUND_REQUIRED", refundRequired: true,
            refundStatus: manualCash ? "PENDING_MANUAL_CASH" : "PENDING_AUTO_REFUND",
            ...(manualCash ? { requestedRefundMethod: "CASH_MANUAL", refundRequestStatus: "REQUESTED", refundRequestedAt: now } : {}),
            homeVisitMissionStatus: missionStatus, homeVisitProviderPresent: false,
            homeVisitServiceCompletion: "NOT_COMPLETED", homeVisitNoShowReportedAt: now, updatedAt: now,
          }, { merge: true });
          if (manualCash) {
            transaction.create(alertRef, {
              paymentRef: appointment.moncashPaymentRef, resourceType: "appointment", resourceId: appointmentId,
              reason: "PATIENT_REQUESTED_CASH_REFUND", requestedRefundMethod: "CASH_MANUAL",
              refundRequestedByUid: user.uid, refundRequestedAt: now, status: "open", createdAt: now,
            });
            transaction.create(adminAuditRef, {
              actorUid: user.uid, action: "patient_cash_refund_requested", resource: `appointments/${appointmentId}`,
              refundMethod: "CASH_MANUAL", amountMinor: Number(appointment.amount) * 100, currency: "HTG", createdAt: now,
            });
          }
        }
        transaction.create(auditRef, {
          actorUid: user.uid, action: present ? "home_visit_patient_feedback_submitted" : "home_visit_provider_absence_reported",
          resource: `appointments/${appointmentId}`, createdAt: now,
        });
      });

      if (missionStatus === "PROVIDER_ABSENT_REFUND_REQUIRED" && !manualCash) {
        const refund = await creditNoShowWalletRefund(appointmentId);
        if (!refund.eligible) throw new ApiError(503, "home-visit-refund-pending", "Le formulaire est enregistré. Le crédit Wallet reste en attente; réessayez depuis votre espace.");
        await notify(providerUid, `home-visit:${appointmentId}:absence-reported`, {
          type: "home_visit_provider_absence_reported", title: "Visite à domicile déclarée non assurée",
          body: "Le patient a signalé que la visite n’a pas eu lieu. NEXA a crédité le prix du service à son portefeuille; les frais ne sont pas remboursés.",
          url: "/espace-professionnel.html",
        }, appointmentId);
        return res.status(200).json({ ok: true, missionStatus: "REFUNDED", refundMethod: "NEXA_WALLET" });
      }
      if (manualCash) {
        await notify(providerUid, `home-visit:${appointmentId}:absence-reported`, {
          type: "home_visit_provider_absence_reported", title: "Visite à domicile déclarée non assurée",
          body: "Le patient a demandé un remboursement en espèces. L’administration NEXA doit traiter cette demande manuellement.",
          url: "/espace-professionnel.html",
        }, appointmentId);
      } else {
        await notify(providerUid, `home-visit:${appointmentId}:patient-feedback`, {
          type: "home_visit_patient_feedback_submitted",
          title: missionStatus === "ADMIN_REVIEW_REQUIRED" ? "Visite à vérifier par NEXA" : "Formulaire patient reçu",
          body: missionStatus === "ADMIN_REVIEW_REQUIRED"
            ? "Le patient a signalé un écart d’identité ou de réalisation. Une vérification NEXA est requise avant la clôture."
            : "Le patient a confirmé la visite. Saisissez le code remis par le patient dans votre espace professionnel.",
          url: "/espace-professionnel.html",
        }, appointmentId);
      }
      return res.status(200).json({ ok: true, missionStatus, refundStatus: manualCash ? "PENDING_MANUAL_CASH" : undefined });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA patient home visit feedback failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "home-visit-feedback-failed", "Le formulaire de visite ne peut pas être enregistré.");
    }
  });

  const nexaPatientHomeVisitReports = onRequest({ region: REGION, maxInstances: 15 }, async (req, res) => {
    res.set("Cache-Control", "no-store, max-age=0");
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") { res.set("Allow", "GET, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "patient-home-visit-report-library", 20, 5 * 60_000);

      const patientSnapshot = await db.collection("patientProfiles").doc(user.uid).get();
      if (!patientSnapshot.exists || patientSnapshot.get("role") !== "patient" ||
        patientSnapshot.get("profileComplete") !== true || !/^NMC-\d{7}$/.test(String(patientSnapshot.get("patientNumber") || ""))) {
        throw new ApiError(403, "complete-patient-profile-required", "Accès patient NEXA requis.");
      }

      const requestedCursor = req.query.cursor;
      if (requestedCursor !== undefined && (typeof requestedCursor !== "string" || requestedCursor.length > 200 || !/^[A-Za-z0-9_-]{10,200}$/.test(requestedCursor))) {
        throw new ApiError(400, "invalid-home-visit-report-cursor", "La pagination des comptes rendus n’est pas valide.");
      }
      let cursorSnapshot = null;
      const reportsCollection = db.collection("homeVisitMissionReports");
      if (requestedCursor) {
        cursorSnapshot = await reportsCollection.doc(requestedCursor).get();
        if (!cursorSnapshot.exists || cursorSnapshot.get("patientUid") !== user.uid) {
          throw new ApiError(400, "invalid-home-visit-report-cursor", "Actualisez la liste des comptes rendus avant de continuer.");
        }
      }

      let query = reportsCollection
        .where("patientUid", "==", user.uid)
        .orderBy("createdAt", "desc")
        .limit(PATIENT_HOME_VISIT_REPORT_PAGE_SIZE + 1);
      if (cursorSnapshot) query = query.startAfter(cursorSnapshot);
      const snapshot = await query.get();
      const pageDocuments = snapshot.docs.slice(0, PATIENT_HOME_VISIT_REPORT_PAGE_SIZE);
      const appointmentSnapshots = pageDocuments.length
        ? await db.getAll(...pageDocuments.map((document) => db.collection("appointments").doc(document.id)))
        : [];
      const reports = pageDocuments.flatMap((document, index) => {
        const report = document.data() || {};
        const appointmentSnapshot = appointmentSnapshots[index];
        if (report.patientUid !== user.uid || report.appointmentId !== document.id || !appointmentSnapshot?.exists ||
          appointmentSnapshot.get("patientUid") !== user.uid || appointmentSnapshot.get("bookingType") !== "home_visit") return [];
        const appointment = appointmentSnapshot.data() || {};
        const signature = report.signature && typeof report.signature === "object" && !Array.isArray(report.signature)
          ? report.signature
          : {};
        const ratings = report.ratings && typeof report.ratings === "object" && !Array.isArray(report.ratings)
          ? report.ratings
          : {};
        return [{
          appointmentId: document.id,
          providerName: cleanText(appointment.providerName, 120) || "Médecin NEXA",
          serviceId: cleanText(appointment.homeVisitServiceId, 64),
          appointmentStartsAt: typeof appointment.startsAt === "string" ? appointment.startsAt : "",
          missionStatus: cleanText(appointment.homeVisitMissionStatus, 64),
          providerPresent: typeof report.providerPresent === "boolean" ? report.providerPresent : null,
          identityMatched: typeof report.identityMatched === "boolean" ? report.identityMatched : null,
          serviceCompletion: COMPLETIONS.has(report.serviceCompletion) ? report.serviceCompletion : "UNKNOWN",
          examPerformed: typeof report.examPerformed === "boolean" ? report.examPerformed : null,
          prescriptionProvided: typeof report.prescriptionProvided === "boolean" ? report.prescriptionProvided : null,
          additionalExamsRecommended: typeof report.additionalExamsRecommended === "boolean" ? report.additionalExamsRecommended : null,
          questionsAnswered: typeof report.questionsAnswered === "boolean" ? report.questionsAnswered : null,
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
          submittedAt: iso(report.createdAt),
        }];
      });
      const hasMore = snapshot.docs.length > PATIENT_HOME_VISIT_REPORT_PAGE_SIZE;
      const nextCursor = hasMore && pageDocuments.length ? pageDocuments[pageDocuments.length - 1].id : null;
      await db.collection("clinicalAuditLogs").doc().create({
        actorUid: user.uid,
        action: "patient_home_visit_report_library_accessed",
        recordCount: reports.length,
        hasMore,
        createdAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ ok: true, reports, hasMore, nextCursor });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA patient home visit report history failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "patient-home-visit-reports-unavailable", "Vos comptes rendus de visite à domicile ne sont pas accessibles pour le moment.");
    }
  });

  const nexaHomeVisitMissionClose = onRequest({ region: REGION }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > 1_024 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 1_024)) {
      return fail(res, 413, "request-too-large", "La requête dépasse la taille autorisée.");
    }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "close-home-visit-mission", 30, 10 * 60_000);
      const providerSnapshot = await db.collection("providerProfiles").doc(user.uid).get();
      if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) {
        throw new ApiError(403, "verified-doctor-required", "La clôture est réservée aux médecins NEXA vérifiés.");
      }
      const body = getBody(req);
      const appointmentId = typeof body?.appointmentId === "string" ? body.appointmentId.trim() : "";
      const code = typeof body?.code === "string" ? body.code.trim() : "";
      if (!body || Object.keys(body).some((key) => !["appointmentId", "code"].includes(key)) ||
        !/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId) || !/^\d{8}$/.test(code)) {
        throw new ApiError(400, "invalid-mission-code", "Saisissez la référence de la visite et le code patient à huit chiffres.");
      }
      const appointmentRef = db.collection("appointments").doc(appointmentId);
      const reportRef = db.collection("homeVisitMissionReports").doc(appointmentId);
      const attemptsRef = db.collection("homeVisitCodeAttempts").doc(appointmentId);
      const auditRef = db.collection("paymentAuditLogs").doc();
      let patientUid = "";
      let outcome = "";
      await db.runTransaction(async (transaction) => {
        const [appointmentSnapshot, reportSnapshot, attemptsSnapshot] = await Promise.all([
          transaction.get(appointmentRef), transaction.get(reportRef), transaction.get(attemptsRef),
        ]);
        if (!appointmentSnapshot.exists || appointmentSnapshot.get("providerUid") !== user.uid || appointmentSnapshot.get("bookingType") !== "home_visit") {
          throw new ApiError(404, "home-visit-not-found", "Cette visite n’est pas accessible.");
        }
        const appointment = appointmentSnapshot.data() || {};
        if (appointment.paymentStatus !== "PAID" || appointment.status !== "CONFIRMED" || appointment.homeVisitMissionStatus !== "AWAITING_PROVIDER_CODE" || !reportSnapshot.exists) {
          throw new ApiError(409, "home-visit-not-ready-to-close", "Le formulaire patient doit être confirmé avant la clôture.");
        }
        const report = reportSnapshot.data() || {};
        const adminApproved = appointment.homeVisitCodeClosureAdminApproved === true &&
          appointment.homeVisitAdminDecision === "ALLOW_CODE_CLOSURE" &&
          typeof appointment.homeVisitAdminReviewedByUid === "string" &&
          appointment.homeVisitAdminReviewedByUid.length > 0;
        if (report.providerUid !== user.uid || report.providerPresent !== true || report.patientConfirmed !== true ||
          (!adminApproved && (report.identityMatched !== true || !["COMPLETED", "PARTIAL"].includes(String(report.serviceCompletion || ""))))) {
          throw new ApiError(409, "home-visit-report-review-required", "Le formulaire nécessite une vérification NEXA avant la clôture.");
        }
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
        const storedHash = typeof appointment.homeVisitMissionCodeHash === "string" ? appointment.homeVisitMissionCodeHash : "";
        const submittedHash = missionCodeHash(appointmentId, code);
        const storedBytes = /^[a-f0-9]{64}$/.test(storedHash) ? Buffer.from(storedHash, "hex") : Buffer.alloc(32);
        const submittedBytes = Buffer.from(submittedHash, "hex");
        if (!/^[a-f0-9]{64}$/.test(storedHash) || !timingSafeEqual(storedBytes, submittedBytes)) {
          const nextAttempts = attempts + 1;
          transaction.set(attemptsRef, {
            windowStartedAtMs: withinWindow ? Number(prior.windowStartedAtMs) : now,
            attempts: nextAttempts,
            blockedUntilMs: nextAttempts >= 5 ? now + 10 * 60_000 : 0,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          transaction.create(auditRef, {
            actorUid: user.uid, action: "home_visit_mission_code_attempt_failed",
            resource: `appointments/${appointmentId}`, attemptNumber: nextAttempts, createdAt: FieldValue.serverTimestamp(),
          });
          outcome = "invalid";
          return;
        }
        patientUid = typeof appointment.patientUid === "string" ? appointment.patientUid : "";
        if (!patientUid) throw new ApiError(409, "home-visit-patient-unavailable", "Le patient associé à cette visite n’est pas disponible.");
        const timestamp = FieldValue.serverTimestamp();
        transaction.set(appointmentRef, {
          status: "COMPLETED", homeVisitMissionStatus: "COMPLETED", homeVisitMissionClosedAt: timestamp,
          homeVisitMissionClosedByUid: user.uid, homeVisitMissionCodeHash: FieldValue.delete(),
          homeVisitMissionCode: FieldValue.delete(), updatedAt: timestamp,
        }, { merge: true });
        transaction.set(attemptsRef, { closedAt: timestamp, updatedAt: timestamp }, { merge: true });
        transaction.create(auditRef, {
          actorUid: user.uid, action: "home_visit_mission_closed_by_patient_code",
          resource: `appointments/${appointmentId}`, createdAt: timestamp,
        });
        outcome = "completed";
      });
      if (outcome === "locked") throw new ApiError(429, "mission-code-locked", "Trop de codes incorrects. Réessayez dans dix minutes.");
      if (outcome === "invalid") throw new ApiError(400, "mission-code-mismatch", "Le code remis par le patient ne correspond pas à cette visite.");
      if (outcome !== "completed") throw new ApiError(409, "home-visit-not-ready-to-close", "La visite ne peut pas être clôturée pour le moment.");
      await notify(patientUid, `home-visit:${appointmentId}:mission-closed`, {
        type: "home_visit_mission_closed", title: "Visite NEXA clôturée",
        body: "Le médecin a validé votre code et clôturé la mission. Le statut de votre visite est mis à jour dans votre espace NEXA.",
        url: "/espace-patient.html",
      }, appointmentId);
      return res.status(200).json({ ok: true, missionStatus: "COMPLETED" });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA home visit close failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "home-visit-close-failed", "La mission ne peut pas être clôturée pour le moment.");
    }
  });

  const nexaAdminHomeVisitMissions = onRequest({ region: REGION }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!new Set(["GET", "POST"]).has(req.method)) { res.set("Allow", "GET, POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > 2_048 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 2_048)) {
      return fail(res, 413, "request-too-large", "La demande de décision dépasse la taille autorisée.");
    }
    try {
      const admin = await requireUser(req);
      await requireAppCheckToken(req);
      const admins = new Set(String(process.env.NEXA_ADMIN_UIDS || "").split(",").map((value) => value.trim()).filter(Boolean));
      if (!admins.size) throw new ApiError(503, "admin-access-not-configured", "L’accès administrateur NEXA n’est pas configuré.");
      if (!admins.has(admin.uid)) throw new ApiError(403, "administrator-required", "Accès administrateur requis.");
      res.set("Cache-Control", "no-store, max-age=0");
      if (req.method === "POST") {
        const body = getBody(req);
        const appointmentId = typeof body?.appointmentId === "string" ? body.appointmentId.trim() : "";
        const action = typeof body?.action === "string" ? body.action : "";
        const reason = typeof body?.reason === "string" ? body.reason : "";
        const allowedKeys = new Set(["appointmentId", "action", "reason", "confirmNoExternalRefund"]);
        if (!body || Object.keys(body).some((key) => !allowedKeys.has(key)) ||
          !/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) {
          throw new ApiError(400, "invalid-home-visit-review", "La décision de mission n’est pas valide.");
        }
        const closureReasons = new Set(["IDENTITY_CONFIRMED", "SERVICE_ACCEPTED", "PARTIAL_SERVICE_ACCEPTED", "OTHER_REVIEWED"]);
        const refundReasons = new Set(["IDENTITY_DISCREPANCY", "SERVICE_INCOMPLETE", "SERVICE_NOT_PERFORMED", "OTHER_REVIEWED"]);
        if (action === "ALLOW_CODE_CLOSURE") {
          if (!closureReasons.has(reason) || body.confirmNoExternalRefund !== undefined) {
            throw new ApiError(400, "invalid-home-visit-review", "Indiquez une justification valide pour autoriser la clôture.");
          }
          await enforceUserRateLimit(admin.uid, "admin-home-visit-mission-decision", 10, 60_000);
          const appointmentRef = db.collection("appointments").doc(appointmentId);
          const reportRef = db.collection("homeVisitMissionReports").doc(appointmentId);
          const outcome = await db.runTransaction(async (transaction) => {
            const [appointmentSnapshot, reportSnapshot] = await Promise.all([
              transaction.get(appointmentRef), transaction.get(reportRef),
            ]);
            if (!appointmentSnapshot.exists || appointmentSnapshot.get("bookingType") !== "home_visit") {
              throw new ApiError(404, "home-visit-not-found", "Cette visite à domicile n’existe pas.");
            }
            const appointment = appointmentSnapshot.data() || {};
            const report = reportSnapshot.data() || {};
            if (appointment.homeVisitMissionStatus === "AWAITING_PROVIDER_CODE" &&
              appointment.homeVisitAdminDecision === "ALLOW_CODE_CLOSURE") {
              return { alreadyProcessed: true, patientUid: appointment.patientUid, providerUid: appointment.providerUid };
            }
            if (appointment.status !== "CONFIRMED" || appointment.paymentStatus !== "PAID" ||
              appointment.homeVisitMissionStatus !== "ADMIN_REVIEW_REQUIRED" || !reportSnapshot.exists ||
              report.patientUid !== appointment.patientUid || report.providerUid !== appointment.providerUid ||
              report.providerPresent !== true || report.patientConfirmed !== true ||
              appointment.requestedRefundMethod === "CASH_MANUAL" || appointment.refundStatus === "PENDING_MANUAL_CASH") {
              throw new ApiError(409, "home-visit-review-stale", "La mission ou le formulaire a changé; actualisez la file avant de décider.");
            }
            const now = FieldValue.serverTimestamp();
            transaction.set(appointmentRef, {
              homeVisitMissionStatus: "AWAITING_PROVIDER_CODE",
              homeVisitCodeClosureAdminApproved: true,
              homeVisitAdminDecision: "ALLOW_CODE_CLOSURE",
              homeVisitAdminDecisionReason: reason,
              homeVisitAdminReviewedByUid: admin.uid,
              homeVisitAdminReviewedAt: now,
              updatedAt: now,
            }, { merge: true });
            transaction.create(db.collection("adminAuditLogs").doc(), {
              actorUid: admin.uid, action: "admin_home_visit_code_closure_authorized",
              resource: `appointments/${appointmentId}`, decisionReason: reason, createdAt: now,
            });
            return {
              alreadyProcessed: false,
              patientUid: typeof appointment.patientUid === "string" ? appointment.patientUid : "",
              providerUid: typeof appointment.providerUid === "string" ? appointment.providerUid : "",
            };
          });
          if (!outcome.alreadyProcessed) {
            await Promise.all([
              notify(outcome.patientUid, `home-visit:${appointmentId}:admin-code-closure`, {
                type: "home_visit_code_closure_authorized", title: "Vérification de visite terminée",
                body: "NEXA a autorisé la clôture de la visite par le code patient. Donnez le code au médecin après validation de la mission.",
                url: "/espace-patient.html",
              }, appointmentId),
              notify(outcome.providerUid, `home-visit:${appointmentId}:admin-code-closure`, {
                type: "home_visit_code_closure_authorized", title: "Visite prête à être clôturée",
                body: "Après examen du signalement patient, NEXA a autorisé la clôture de cette mission par code.",
                url: "/espace-professionnel.html",
              }, appointmentId),
            ]);
          }
          return res.status(200).json({ ok: true, action, alreadyProcessed: outcome.alreadyProcessed });
        }
        if (action === "REFUND_WALLET") {
          if (!refundReasons.has(reason) || body.confirmNoExternalRefund !== true) {
            throw new ApiError(400, "invalid-home-visit-review", "Confirmez l’absence de remboursement externe et choisissez une justification valide.");
          }
          await enforceUserRateLimit(admin.uid, "admin-home-visit-mission-decision", 10, 60_000);
          const refund = await creditNoShowWalletRefund(appointmentId, { adminUid: admin.uid, reason });
          if (!refund.eligible) throw new ApiError(409, "home-visit-review-stale", "Cette mission ne peut plus être remboursée depuis la file de vérification.");
          if (!refund.alreadyProcessed) {
            await notify(refund.providerUid, `home-visit:${appointmentId}:admin-wallet-refund`, {
              type: "home_visit_admin_wallet_refund", title: "Décision NEXA sur une visite à domicile",
              body: "Après examen du signalement patient, NEXA a remboursé au Wallet le prix du service. Les frais de transaction ne sont pas remboursés.",
              url: "/espace-professionnel.html",
            }, appointmentId);
          }
          return res.status(200).json({ ok: true, action, amount: refund.amount, currency: "HTG", alreadyProcessed: refund.alreadyProcessed });
        }
        throw new ApiError(400, "invalid-home-visit-review-action", "Choisissez une décision de clôture ou de remboursement Wallet.");
      }

      const rawCursor = req.query.cursor;
      if (rawCursor !== undefined && (typeof rawCursor !== "string" || rawCursor.length > 200 || !/^[A-Za-z0-9_-]{10,200}$/.test(rawCursor))) {
        throw new ApiError(400, "invalid-home-visit-review-cursor", "La pagination de la file de visites n’est pas valide.");
      }
      await enforceUserRateLimit(admin.uid, "admin-home-visit-mission-review-list", 30, 60_000);
      const appointmentsCollection = db.collection("appointments");
      let query = appointmentsCollection
        .where("homeVisitMissionStatus", "==", "ADMIN_REVIEW_REQUIRED")
        .orderBy(FieldPath.documentId())
        .limit(ADMIN_HOME_VISIT_REVIEW_PAGE_SIZE + 1);
      if (rawCursor) query = query.startAfter(appointmentsCollection.doc(rawCursor));
      const snapshot = await query.get();
      const pageDocuments = snapshot.docs.slice(0, ADMIN_HOME_VISIT_REVIEW_PAGE_SIZE);
      const reportSnapshots = pageDocuments.length ? await db.getAll(...pageDocuments.map((doc) => db.collection("homeVisitMissionReports").doc(doc.id))) : [];
      const patientSnapshots = pageDocuments.length ? await db.getAll(...pageDocuments.map((doc) => db.collection("patientProfiles").doc(String(doc.get("patientUid") || "_")))) : [];
      const missions = pageDocuments.flatMap((doc, index) => {
        const data = doc.data() || {};
        if (!reportSnapshots[index]?.exists || !patientSnapshots[index]?.exists) return [];
        const report = reportSnapshots[index].data() || {};
        const patient = patientSnapshots[index].data() || {};
        if (report.appointmentId !== doc.id || report.patientUid !== data.patientUid || report.providerUid !== data.providerUid ||
          patient.role !== "patient" || patient.profileComplete !== true) return [];
        const ratings = report.ratings && typeof report.ratings === "object" ? report.ratings : {};
        return [{
          appointmentId: doc.id,
          patientName: cleanText(patient.displayName, 100) || "Patient NEXA",
          providerName: cleanText(data.providerName, 120) || "Médecin NEXA",
          serviceId: cleanText(data.homeVisitServiceId, 64),
          startsAt: typeof data.startsAt === "string" ? data.startsAt : "",
          serviceCompletion: typeof report.serviceCompletion === "string" ? report.serviceCompletion : "UNKNOWN",
          providerPresent: report.providerPresent === true,
          identityMatched: report.identityMatched === true,
          providerStartedAt: iso(data.effectiveConsultationStartedAt),
          visitStartedAt: iso(report.visitStartedAt), visitEndedAt: iso(report.visitEndedAt),
          ratings: Object.fromEntries(RATING_KEYS.map((key) => [key, validRating(ratings[key])])),
          submittedAt: iso(report.createdAt), paymentStatus: typeof data.paymentStatus === "string" ? data.paymentStatus : "UNKNOWN",
        }];
      });
      const hasMore = snapshot.docs.length > ADMIN_HOME_VISIT_REVIEW_PAGE_SIZE;
      const nextCursor = hasMore && pageDocuments.length ? pageDocuments[pageDocuments.length - 1].id : null;
      await db.collection("adminAuditLogs").doc().create({ actorUid: admin.uid, action: "admin_home_visit_mission_review_listed", resultCount: missions.length, hasMore, createdAt: FieldValue.serverTimestamp() });
      return res.status(200).json({ ok: true, missions, hasMore, nextCursor });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA admin home visit mission review failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "admin-home-visit-missions-unavailable", "Les visites à vérifier ne sont pas accessibles.");
    }
  });

  return { nexaHomeVisitMissionStart, nexaPatientHomeVisitFeedback, nexaPatientHomeVisitReports, nexaHomeVisitMissionClose, nexaAdminHomeVisitMissions };
};
