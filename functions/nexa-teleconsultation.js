"use strict";

const { createHash, createHmac, randomUUID, timingSafeEqual } = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const { RtcRole, RtcTokenBuilder } = require("agora-token");

const REGION = "us-east4";
const TOKEN_TTL_SECONDS = 60;
const PRESENCE_TIMEOUT_MS = 30_000;
const MAX_ACCOUNTED_INTERVAL_MS = 15_000;
const CALL_RING_TTL_MS = 90_000;
const MAX_UNANSWERED_CALLS = 2;
// Once the scheduled start passes, unresolved paid appointments enter admin review.
// No automatic refund is triggered for a doctor who never accepted the appointment.
const AGORA_APP_ID = defineSecret("AGORA_APP_ID");
const AGORA_APP_CERTIFICATE = defineSecret("AGORA_APP_CERTIFICATE");
const AGORA_RTC_NOTIFICATION_SECRET = defineSecret("AGORA_RTC_NOTIFICATION_SECRET");
const AGORA_RTC_EVENTS_ACTIVE = defineString("AGORA_RTC_EVENTS_ACTIVE", { default: "false" });
const AGORA_CREDENTIAL_PATTERN = /^[0-9a-f]{32}$/i;
const TERMINAL_SESSION_STATUSES = new Set(["TERMINATED", "INTERACTIVE_TIME_EXPIRED", "NO_SHOW"]);

function agoraRtcEventsEnabled() {
  try {
    return AGORA_RTC_EVENTS_ACTIVE.value().trim().toLowerCase() === "true" &&
      AGORA_RTC_NOTIFICATION_SECRET.value().trim().length > 0;
  } catch {
    return false;
  }
}

function normalizeAgoraClientSequence(value) {
  const sequence = typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,20}$/.test(sequence)) return "";
  return sequence.replace(/^0+(?=\d)/, "");
}

function compareAgoraClientSequences(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function verifyAgoraNotificationSignature(rawBody, secret, signature, algorithm, digestBytes) {
  if (!Buffer.isBuffer(rawBody) || !secret || typeof signature !== "string" || !/^[a-f0-9]+$/i.test(signature)) return false;
  const supplied = Buffer.from(signature, "hex");
  if (supplied.length !== digestBytes) return false;
  const expected = createHmac(algorithm, secret).update(rawBody).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function getBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  if (!Buffer.isBuffer(req.rawBody)) return null;
  try {
    const value = JSON.parse(req.rawBody.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function timestamp(value) {
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(String(value || ""));
}

function durationMinutes(appointment) {
  const rights = appointment.consultationRights && typeof appointment.consultationRights === "object" ? appointment.consultationRights : {};
  const requested = [Number(rights.durationMinutes), Number(rights.videoMinutes)].find((value) => Number.isFinite(value) && value > 0);
  if (requested) return Math.round(requested);
  const start = timestamp(appointment.startsAt);
  const end = timestamp(appointment.endsAt);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? Math.max(1, Math.round((end - start) / 60_000)) : 10;
}

function videoLimitSeconds(appointment) {
  return Math.max(60, Math.round(durationMinutes(appointment) * 60));
}

function agoraUid(firebaseUid) {
  const hash = createHash("sha256").update(firebaseUid).digest();
  return (hash.readUInt32BE(0) % 2_000_000_000) + 1;
}

function validVideoAppointment(appointment) {
  return String(appointment.providerType || "").toLowerCase() === "doctor" &&
    ["teleconsultation", "doctor_proposed_appointment"].includes(String(appointment.bookingType || "")) &&
    appointment.paymentStatus === "PAID" &&
    ["DOCTOR_ACCEPTED", "IN_PROGRESS"].includes(String(appointment.status || "").toUpperCase());
}

function parsePresence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([uid, entry]) => {
    if (!uid || !entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const lastSeenAtMs = Number(entry.lastSeenAtMs);
    return Number.isFinite(lastSeenAtMs) && lastSeenAtMs > 0 ? [[uid, { lastSeenAtMs }]] : [];
  }));
}

function activeParticipants(presence, nowMs) {
  return Object.fromEntries(Object.entries(presence).filter(([, participant]) =>
    participant.lastSeenAtMs <= nowMs && nowMs - participant.lastSeenAtMs < PRESENCE_TIMEOUT_MS));
}

function parseAgoraParticipants(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(["patient", "doctor"].flatMap((role) => {
    const participant = value[role];
    if (!participant || typeof participant !== "object" || Array.isArray(participant)) return [];
    const state = String(participant.state || "").toUpperCase();
    const eventAtMs = Number(participant.eventAtMs);
    const uid = Number(participant.uid);
    const clientSeq = normalizeAgoraClientSequence(participant.clientSeq);
    if (!Number.isSafeInteger(uid) || uid <= 0 || !["JOINED", "LEFT"].includes(state) ||
      !Number.isSafeInteger(eventAtMs) || eventAtMs <= 0 || !clientSeq) return [];
    const joinedAtMs = Number(participant.joinedAtMs);
    return [[role, {
      uid,
      state,
      eventAtMs,
      clientSeq,
      ...(Number.isSafeInteger(joinedAtMs) && joinedAtMs > 0 ? { joinedAtMs } : {}),
    }]];
  }));
}

function buildPresenceResult({ expired, limit, consumed, videoStatus, sessionStatus }) {
  const videoConsumedSeconds = Math.min(limit, Math.floor(Math.max(0, consumed) / 1_000));
  return {
    expired,
    videoLimitSeconds: limit,
    videoConsumedSeconds,
    videoRemainingSeconds: Math.max(0, limit - videoConsumedSeconds),
    videoStatus,
    sessionStatus,
  };
}

async function recordTeleconsultationPresence(db, FieldValue, ApiError, input) {
  const appointmentRef = db.collection("appointments").doc(input.appointmentId);
  const nowMs = input.nowMs || Date.now();
  let result = null;

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(appointmentRef);
    if (!snapshot.exists) throw new ApiError(404, "appointment-not-found", "Consultation introuvable.");
    const appointment = snapshot.data() || {};
    if (input.action !== "reconcile" && appointment.patientUid !== input.uid && appointment.providerUid !== input.uid) {
      throw new ApiError(403, "forbidden", "Vous ne participez pas à cette séance.");
    }
    if (String(appointment.providerType || "").toLowerCase() !== "doctor") {
      throw new ApiError(409, "video-not-available", "La vidéo est réservée aux consultations médecin.");
    }

    const status = String(appointment.status || "").toUpperCase();
    let sessionStatus = String(appointment.sessionStatus || "").toUpperCase();
    const limit = videoLimitSeconds(appointment);
    const limitMs = limit * 1_000;
    const rawConsumed = Number(appointment.videoConsumedMilliseconds);
    const priorConsumed = Number.isFinite(rawConsumed)
      ? Math.max(0, rawConsumed)
      : Math.max(0, Number(appointment.videoConsumedSeconds) || 0) * 1_000;
    const isActive = validVideoAppointment(appointment);

    if (input.action !== "leave") {
      if (!isActive || TERMINAL_SESSION_STATUSES.has(sessionStatus)) {
        throw new ApiError(409, "session-not-active", "La séance vidéo n’est pas ouverte par le professionnel.");
      }
      const startsAt = timestamp(appointment.startsAt);
      if (!Number.isFinite(startsAt)) throw new ApiError(409, "invalid-consultation-slot", "Le créneau de consultation est invalide.");
      if (nowMs < startsAt) throw new ApiError(403, "consultation-not-started", "La vidéo ne peut démarrer qu’à l’heure prévue.");
      const configuredEnd = timestamp(appointment.interactiveEndsAt);
      const scheduledEnd = timestamp(appointment.endsAt);
      const interactiveEnd = Number.isFinite(configuredEnd) && configuredEnd > 0
        ? configuredEnd
        : Number.isFinite(scheduledEnd) ? scheduledEnd + 15 * 60_000 : Number.NaN;
      if (Number.isFinite(interactiveEnd) && interactiveEnd > 0 && nowMs >= interactiveEnd) {
        sessionStatus = "INTERACTIVE_TIME_EXPIRED";
        transaction.set(appointmentRef, {
          sessionStatus,
          videoStatus: "ENDED",
          videoParticipants: {},
          videoActiveSinceMs: null,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        result = buildPresenceResult({ expired: true, limit, consumed: priorConsumed, videoStatus: "ENDED", sessionStatus });
        return;
      }
    }

    let presence = activeParticipants(parsePresence(appointment.videoParticipants), nowMs);
    let consumed = priorConsumed;
    const activeSince = Number(appointment.videoActiveSinceMs);
    const agoraParticipants = parseAgoraParticipants(appointment.videoAgoraParticipants);
    const participantsConnected = ["patient", "doctor"].every((role) => agoraParticipants[role]?.state === "JOINED");
    const effectiveStartExists = timestamp(appointment.effectiveConsultationStartedAt) > 0;
    if (isActive && effectiveStartExists && participantsConnected && Object.keys(presence).length >= 2 && Number.isFinite(activeSince)) {
      consumed = Math.min(limitMs, consumed + Math.max(0, Math.min(nowMs - activeSince, MAX_ACCOUNTED_INTERVAL_MS)));
    }

    if (input.action === "leave") delete presence[input.uid];
    else if (input.action !== "reconcile") presence[input.uid] = { lastSeenAtMs: nowMs };
    if (!isActive || TERMINAL_SESSION_STATUSES.has(sessionStatus)) presence = {};

    if (isActive && consumed >= limitMs) {
      sessionStatus = "INTERACTIVE_TIME_EXPIRED";
      presence = {};
      transaction.set(appointmentRef, {
        videoConsumedMilliseconds: limitMs,
        videoConsumedSeconds: limit,
        sessionStatus,
        videoStatus: "ENDED",
        videoParticipants: presence,
        videoActiveSinceMs: null,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      result = buildPresenceResult({ expired: true, limit, consumed: limitMs, videoStatus: "ENDED", sessionStatus });
      return;
    }

    const activeCount = Object.keys(presence).length;
    const videoActive = isActive && effectiveStartExists && participantsConnected && activeCount >= 2;
    const videoStatus = videoActive ? "ACTIVE" : activeCount ? "WAITING" : "ENDED";
    const nextSessionStatus = isActive ? sessionStatus || "IN_PROGRESS" : sessionStatus;
    transaction.set(appointmentRef, {
      videoConsumedMilliseconds: Math.min(limitMs, consumed),
      videoConsumedSeconds: Math.min(limit, Math.floor(consumed / 1_000)),
      videoParticipants: presence,
      videoActiveSinceMs: videoActive ? nowMs : null,
      videoStatus,
      sessionStatus: nextSessionStatus,
      videoPresenceUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    result = buildPresenceResult({ expired: false, limit, consumed, videoStatus, sessionStatus: nextSessionStatus });
  });
  if (!result) throw new Error("Teleconsultation presence transaction returned no result.");
  return result;
}

function parseCallAttempts(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const status = String(entry.status || "").toUpperCase();
    const role = entry.initiatedByRole === "patient" || entry.initiatedByRole === "doctor" ? entry.initiatedByRole : "";
    const startedAtMs = Number(entry.startedAtMs);
    const attemptNumber = Number(entry.attemptNumber);
    if (typeof entry.signalId !== "string" || !entry.signalId || typeof entry.initiatedByUid !== "string" || !entry.initiatedByUid ||
      !role || !["RINGING", "NO_ANSWER", "REFUSED", "ACCEPTED", "CONNECTED", "ENDED"].includes(status) ||
      !Number.isSafeInteger(startedAtMs) || startedAtMs <= 0 || !Number.isSafeInteger(attemptNumber) || attemptNumber <= 0) return [];
    const resolvedAtMs = Number(entry.resolvedAtMs);
    return [{
      signalId: entry.signalId,
      initiatedByUid: entry.initiatedByUid,
      initiatedByRole: role,
      attemptNumber,
      status,
      startedAtMs,
      ...(Number.isSafeInteger(resolvedAtMs) && resolvedAtMs > 0 ? { resolvedAtMs } : {}),
    }];
  }).slice(-100);
}

function upsertCallAttempt(attempts, { signalId, uid, role, status, nowMs, startedAtMs }) {
  const index = attempts.findIndex((attempt) => attempt.signalId === signalId);
  if (index >= 0) {
    const next = [...attempts];
    next[index] = { ...next[index], status, ...(status === "RINGING" ? {} : { resolvedAtMs: nowMs }) };
    return next;
  }
  const attemptNumber = attempts.filter((attempt) => attempt.initiatedByRole === role).length + 1;
  return [...attempts, {
    signalId,
    initiatedByUid: uid,
    initiatedByRole: role,
    attemptNumber,
    status,
    startedAtMs: startedAtMs || nowMs,
    ...(status === "RINGING" ? {} : { resolvedAtMs: nowMs }),
  }].slice(-100);
}

function setCallAttemptStatus(attempts, signalId, status, nowMs) {
  return attempts.map((attempt) => attempt.signalId !== signalId || ["NO_ANSWER", "REFUSED", "ENDED"].includes(attempt.status)
    ? attempt
    : { ...attempt, status, ...(status === "RINGING" ? {} : { resolvedAtMs: nowMs }) });
}

function unansweredCallCount(attempts, role) {
  return attempts.filter((attempt) => attempt.initiatedByRole === role && attempt.status === "NO_ANSWER").length;
}

function publicCallAttempts(attempts) {
  return attempts.map((attempt) => ({
    initiatedBy: attempt.initiatedByRole,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    startedAt: new Date(attempt.startedAtMs).toISOString(),
    ...(attempt.resolvedAtMs ? { resolvedAt: new Date(attempt.resolvedAtMs).toISOString() } : {}),
  }));
}

function publicSignal(value, uid) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = String(value.status || "").toUpperCase();
  const updatedAtMs = timestamp(value.updatedAt);
  if (!["RINGING", "CONNECTING", "ACTIVE", "REFUSED", "MISSED", "ENDED"].includes(status) || !Number.isFinite(updatedAtMs)) return null;
  return {
    id: typeof value.id === "string" ? value.id.slice(0, 80) : "",
    status,
    by: value.by === uid ? "self" : "peer",
    updatedAt: new Date(updatedAtMs).toISOString(),
  };
}

module.exports = function createNexaTeleconsultationFunctions(dependencies) {
  const { db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger, createNexaNotification, appointmentPaymentMatches } = dependencies;
  const isAgoraRtcEventsEnabled = typeof dependencies.agoraRtcEventsEnabled === "function"
    ? dependencies.agoraRtcEventsEnabled
    : agoraRtcEventsEnabled;

  async function creditProviderNoShowRefund(appointmentId) {
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const ledgerId = createHash("sha256").update(`NEXA_WALLET_REFUND:appointment:${appointmentId}`).digest("hex");
    const refundLedgerId = createHash("sha256").update(`NEXA_REFUND:appointment:${appointmentId}`).digest("hex");
    const ledgerRef = db.collection("nexaWalletLedger").doc(ledgerId);
    const refundRef = db.collection("nexaRefundLedger").doc(refundLedgerId);
    const alertRef = db.collection("paymentSettlementAlerts").doc(`appointment_no_show_${appointmentId}`);
    const auditRef = db.collection("paymentAuditLogs").doc();

    const result = await db.runTransaction(async (transaction) => {
      const sourceSnapshot = await transaction.get(appointmentRef);
      if (!sourceSnapshot.exists) return { eligible: false };
      const source = sourceSnapshot.data() || {};
      const alreadyRefunded = source.status === "REFUNDED" && source.paymentStatus === "REFUNDED" && source.refundMethod === "NEXA_WALLET" && source.refundStatus === "COMPLETED";
      const pendingRefund = source.status === "PROVIDER_NO_SHOW_REFUND_REQUIRED" && source.paymentStatus === "PAID" &&
        source.refundRequired === true && source.refundStatus === "PENDING_AUTO_REFUND";
      const twoUnansweredPatientCalls = source.noShowTriggeredBy === "patient" && Array.isArray(source.videoCallAttempts) &&
        unansweredCallCount(parseCallAttempts(source.videoCallAttempts), "patient") >= MAX_UNANSWERED_CALLS;
      if ((!alreadyRefunded && !pendingRefund) || source.noShowOutcome !== "PROVIDER_UNRESPONSIVE" ||
        !twoUnansweredPatientCalls ||
        timestamp(source.effectiveConsultationStartedAt) > 0 || timestamp(source.trustedAgoraRtcStartedAt) > 0) {
        return { eligible: false };
      }

      const patientUid = typeof source.patientUid === "string" ? source.patientUid : "";
      const paymentRef = typeof source.moncashPaymentRef === "string" ? source.moncashPaymentRef : "";
      const amount = Number(source.amount);
      const amountMinor = amount * 100;
      const fee = Number(source.transactionFee || 0);
      if (!patientUid || !/^[A-Za-z0-9_-]{20,64}$/.test(paymentRef) || !Number.isSafeInteger(amount) || amount <= 0 ||
        amount > 10_000_000 || !Number.isSafeInteger(amountMinor) || fee < 0 || !Number.isSafeInteger(fee)) {
        throw new ApiError(409, "refund-source-invalid", "Le remboursement NEXA ne peut pas être confirmé.");
      }

      const [walletSnapshot, profileSnapshot, paymentSnapshot, ledgerSnapshot, refundSnapshot, alertSnapshot, relatedAlerts] = await Promise.all([
        transaction.get(db.collection("nexaPatientWallets").doc(patientUid)),
        transaction.get(db.collection("patientProfiles").doc(patientUid)),
        transaction.get(db.collection("paymentIntents").doc(paymentRef)),
        transaction.get(ledgerRef),
        transaction.get(refundRef),
        transaction.get(alertRef),
        transaction.get(db.collection("paymentSettlementAlerts").where("resourceId", "==", appointmentId).limit(100)),
      ]);

      if (source.requestedRefundMethod === "CASH_MANUAL" || source.refundStatus === "PENDING_MANUAL_CASH") {
        if (ledgerSnapshot.exists || refundSnapshot.exists) throw new ApiError(409, "refund-ledger-conflict", "Le remboursement a déjà un mouvement Wallet enregistré.");
        transaction.set(appointmentRef, { refundStatus: "PENDING_MANUAL_CASH", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        transaction.set(alertRef, {
          resourceType: "appointment",
          resourceId: appointmentId,
          status: "open",
          reason: "PROVIDER_NO_SHOW_CASH_REFUND_REQUESTED",
          requestedRefundMethod: "CASH_MANUAL",
          createdAt: alertSnapshot.exists ? alertSnapshot.get("createdAt") : FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return { manualCash: true, userUid: patientUid, amount };
      }

      if (!isAgoraRtcEventsEnabled()) return { eligible: false, verificationUnavailable: true };

      const alerts = relatedAlerts.docs.filter((item) => item.get("resourceType") === "appointment");
      if (alerts.some((item) => ["manual_refund_confirmed", "manual_cash_refund_confirmed", "manual_moncash_refund_confirmed"].includes(String(item.get("resolution") || "")))) {
        throw new ApiError(409, "external-refund-already-recorded", "Un remboursement externe est déjà enregistré pour ce rendez-vous.");
      }
      if (ledgerSnapshot.exists !== refundSnapshot.exists) throw new ApiError(409, "refund-ledger-conflict", "Les registres du remboursement ne concordent pas.");
      if (ledgerSnapshot.exists) {
        const ledger = ledgerSnapshot.data() || {};
        const refund = refundSnapshot.data() || {};
        if (ledger.userUid !== patientUid || ledger.resourceType !== "appointment" || ledger.resourceId !== appointmentId ||
          ledger.direction !== "CREDIT" || ledger.type !== "REFUND" || ledger.status !== "COMPLETED" || ledger.currency !== "HTG" ||
          ledger.paymentRef !== paymentRef || Number(ledger.amountMinor) !== amountMinor || refund.userUid !== patientUid ||
          refund.resourceType !== "appointment" || refund.resourceId !== appointmentId || refund.paymentRef !== paymentRef ||
          refund.currency !== "HTG" || refund.status !== "COMPLETED" || refund.refundMethod !== "NEXA_WALLET" ||
          Number(refund.amountMinor) !== amountMinor || refund.walletLedgerId !== ledgerId) {
          throw new ApiError(409, "refund-ledger-conflict", "Le registre contient un remboursement incompatible.");
        }
        return { alreadyProcessed: true, userUid: patientUid, amount, ledgerId, refundLedgerId };
      }
      if (alreadyRefunded) throw new ApiError(409, "refund-ledger-conflict", "Le rendez-vous est marqué remboursé sans registre Wallet concordant.");

      const payment = paymentSnapshot.data() || {};
      if (!profileSnapshot.exists || profileSnapshot.get("role") !== "patient" || profileSnapshot.get("profileComplete") !== true ||
        !paymentSnapshot.exists || payment.status !== "paid" || payment.resourceType !== "appointment" ||
        payment.resourcePath !== `appointments/${appointmentId}` || payment.uid !== patientUid ||
        String(payment.currency || "").toUpperCase() !== "HTG" || String(source.currency || "").toUpperCase() !== "HTG" ||
        typeof appointmentPaymentMatches !== "function" || !appointmentPaymentMatches(source, payment)) {
        throw new ApiError(409, "refund-payment-mismatch", "Le paiement ne correspond pas au montant du service à rembourser.");
      }

      const wallet = walletSnapshot.data() || {};
      const availableMinor = wallet.availableMinor === undefined ? 0 : Number(wallet.availableMinor);
      const reservedMinor = wallet.reservedMinor === undefined ? 0 : Number(wallet.reservedMinor);
      if (!Number.isSafeInteger(availableMinor) || availableMinor < 0 || !Number.isSafeInteger(reservedMinor) || reservedMinor < 0 ||
        !Number.isSafeInteger(availableMinor + amountMinor) || (wallet.currency && wallet.currency !== "HTG") || (wallet.status && wallet.status !== "ACTIVE")) {
        throw new ApiError(409, "wallet-state-invalid", "Le portefeuille NEXA ne peut pas recevoir ce remboursement actuellement.");
      }

      const now = FieldValue.serverTimestamp();
      transaction.set(db.collection("nexaPatientWallets").doc(patientUid), {
        userUid: patientUid, currency: "HTG", availableMinor: availableMinor + amountMinor,
        reservedMinor, status: wallet.status || "ACTIVE", updatedAt: now,
      }, { merge: true });
      transaction.create(ledgerRef, {
        userUid: patientUid, walletId: patientUid, type: "REFUND", direction: "CREDIT", amountMinor,
        currency: "HTG", resourceType: "appointment", resourceId: appointmentId, paymentRef,
        reason: "teleconsultation-provider-no-show", source: "NEXA_AUTOMATIC_REFUND", status: "COMPLETED",
        createdAt: now, createdByUid: "system:nexa-provider-no-show",
      });
      transaction.create(refundRef, {
        userUid: patientUid, resourceType: "appointment", resourceId: appointmentId, paymentRef,
        amountMinor, currency: "HTG", refundMethod: "NEXA_WALLET", serviceAmountMinor: amountMinor,
        ...(fee > 0 ? { nonRefundableTransactionFeeMinor: fee * 100 } : {}),
        walletLedgerId: ledgerId, status: "COMPLETED", createdAt: now,
        createdByUid: "system:nexa-provider-no-show",
      });
      transaction.set(appointmentRef, {
        status: "REFUNDED", paymentStatus: "REFUNDED", refundRequired: false, refundStatus: "COMPLETED",
        refundMethod: "NEXA_WALLET", refundedAmount: amount, refundedAmountMinor: amountMinor,
        ...(fee > 0 ? { nonRefundableTransactionFee: fee } : {}), refundedAt: now,
        refundedByUid: "system:nexa-automatic-refund", refundLedgerId, walletLedgerId: ledgerId, updatedAt: now,
      }, { merge: true });
      transaction.create(auditRef, {
        actorUid: "system:nexa-provider-no-show", action: "teleconsultation_provider_no_show_wallet_refund",
        resource: `appointments/${appointmentId}`, amountMinor, currency: "HTG", createdAt: now,
      });
      return { alreadyProcessed: false, userUid: patientUid, amount, ledgerId, refundLedgerId };
    });

    if (result.userUid && result.manualCash && typeof createNexaNotification === "function") {
      await createNexaNotification(result.userUid, `appointment:${appointmentId}:provider-no-show-cash-review`, {
        type: "appointment_cash_refund_review", title: "Remboursement en espèces à traiter",
        body: "NEXA a transmis votre demande de remboursement en espèces à l’administration. Les frais de transaction ne sont pas remboursés.",
        url: "/espace-patient.html",
      }, appointmentId).catch((error) => logger.warn("NEXA no-show cash notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
    } else if (result.userUid && !result.alreadyProcessed && typeof createNexaNotification === "function") {
      await createNexaNotification(result.userUid, `appointment:${appointmentId}:provider-no-show-wallet-refund`, {
        type: "wallet_refund_credited", title: "Remboursement crédité au portefeuille",
        body: `${new Intl.NumberFormat("fr-HT").format(result.amount)} HTG correspondant au prix du service sont crédités à votre portefeuille NEXA. Les frais de transaction ne sont pas remboursés.`,
        url: "/espace-patient.html",
      }, appointmentId).catch((error) => logger.warn("NEXA no-show refund notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
    }
    return result;
  }

  async function reconcileExpiredTeleconsultationCall(appointmentId, nowMs = Date.now()) {
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const alertRef = db.collection("paymentSettlementAlerts").doc(`appointment_no_show_${appointmentId}`);
    const attemptAuditRef = db.collection("paymentAuditLogs").doc();
    const outcomeAuditRef = db.collection("paymentAuditLogs").doc();
    let patientUid = "";
    let providerUid = "";
    let outcome = "";
    let needsWalletRefund = false;

    await db.runTransaction(async (transaction) => {
      patientUid = "";
      providerUid = "";
      outcome = "";
      needsWalletRefund = false;
      const snapshot = await transaction.get(appointmentRef);
      if (!snapshot.exists) return;
      const appointment = snapshot.data() || {};
      patientUid = typeof appointment.patientUid === "string" ? appointment.patientUid : "";
      providerUid = typeof appointment.providerUid === "string" ? appointment.providerUid : "";

      if (appointment.status === "PROVIDER_NO_SHOW_REFUND_REQUIRED" && appointment.refundStatus === "PENDING_AUTO_REFUND" &&
        appointment.noShowOutcome === "PROVIDER_UNRESPONSIVE") {
        needsWalletRefund = true;
        outcome = "PROVIDER_UNRESPONSIVE";
        return;
      }
      if (![
        "DOCTOR_ACCEPTED", "IN_PROGRESS",
      ].includes(String(appointment.status || "").toUpperCase()) ||
        String(appointment.providerType || "").toLowerCase() !== "doctor" ||
        !["teleconsultation", "doctor_proposed_appointment"].includes(String(appointment.bookingType || "")) ||
        appointment.paymentStatus !== "PAID" || timestamp(appointment.effectiveConsultationStartedAt) > 0) return;

      const signal = appointment.videoSignal && typeof appointment.videoSignal === "object" && !Array.isArray(appointment.videoSignal)
        ? appointment.videoSignal
        : {};
      if (String(signal.status || "").toUpperCase() !== "RINGING") return;
      const signalId = typeof signal.id === "string" ? signal.id : "";
      const initiatorUid = typeof signal.by === "string" ? signal.by : "";
      const role = initiatorUid === patientUid ? "patient" : initiatorUid === providerUid ? "doctor" : "";
      const startedAtMs = timestamp(signal.updatedAt);
      if (!signalId || !role || !Number.isFinite(startedAtMs) || nowMs - startedAtMs < CALL_RING_TTL_MS) return;

      const attempts = upsertCallAttempt(parseCallAttempts(appointment.videoCallAttempts), {
        signalId, uid: initiatorUid, role, status: "NO_ANSWER", nowMs, startedAtMs,
      });
      const unanswered = unansweredCallCount(attempts, role);
      const nowIso = new Date(nowMs).toISOString();
      const commonUpdate = {
        videoCallAttempts: attempts,
        videoSignal: { ...signal, status: "MISSED", updatedAt: nowIso, resolvedAt: nowIso },
        videoCallAttemptsUpdatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      transaction.create(attemptAuditRef, {
        actorUid: "system:nexa-call-timeout", action: "teleconsultation_unanswered_call_recorded",
        resource: `appointments/${appointmentId}`, initiatedByRole: role,
        attemptNumber: attempts.find((attempt) => attempt.signalId === signalId)?.attemptNumber || unanswered,
        outcome: "NO_ANSWER", occurredAt: new Date(nowMs), createdAt: FieldValue.serverTimestamp(),
      });

      if (unanswered < MAX_UNANSWERED_CALLS) {
        transaction.set(appointmentRef, commonUpdate, { merge: true });
        return;
      }

      outcome = role === "patient" ? "PROVIDER_UNRESPONSIVE" : "PATIENT_UNRESPONSIVE";
      const serviceAmount = Number(appointment.amount);
      const feeAmount = Number(appointment.transactionFee || 0);
      const serviceAmountMinor = Number.isSafeInteger(serviceAmount) && serviceAmount > 0 ? serviceAmount * 100 : 0;
      const transactionFeeMinor = Number.isSafeInteger(feeAmount) && feeAmount >= 0 ? feeAmount * 100 : 0;
      const requestedCash = outcome === "PROVIDER_UNRESPONSIVE" && appointment.requestedRefundMethod === "CASH_MANUAL";
      const sessionUpdate = {
        ...commonUpdate,
        sessionStatus: "NO_SHOW", videoStatus: "ENDED", videoParticipants: {}, videoActiveSinceMs: null,
        interactiveEndsAt: nowIso,
        noShowOutcome: outcome, noShowTriggeredBy: role, noShowAt: FieldValue.serverTimestamp(),
      };
      if (outcome === "PROVIDER_UNRESPONSIVE") {
        needsWalletRefund = !requestedCash;
        transaction.set(appointmentRef, {
          ...sessionUpdate, status: "PROVIDER_NO_SHOW_REFUND_REQUIRED", refundRequired: true,
          refundStatus: requestedCash ? "PENDING_MANUAL_CASH" : "PENDING_AUTO_REFUND",
          ...(requestedCash ? {
            refundRequestStatus: "REQUESTED",
            refundRequestedAt: appointment.refundRequestedAt || FieldValue.serverTimestamp(),
          } : {}),
          noShowSettlement: { serviceAmountMinor, patientRefundMinor: serviceAmountMinor, providerAmountMinor: 0, transactionFeeRefunded: false },
        }, { merge: true });
        if (requestedCash) {
          transaction.set(alertRef, {
            paymentRef: appointment.moncashPaymentRef,
            resourceType: "appointment", resourceId: appointmentId, status: "open",
            reason: "PROVIDER_NO_SHOW_CASH_REFUND_REQUESTED", requestedRefundMethod: "CASH_MANUAL",
            refundRequestedByUid: patientUid,
            createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }
      } else {
        transaction.set(appointmentRef, {
          ...sessionUpdate, status: "PATIENT_NO_SHOW_RETAINED", refundRequired: false,
          refundStatus: "NOT_APPLICABLE", settlementStatus: "NEXA_RETAINED_NO_SHOW",
          noShowSettlement: { serviceAmountMinor, nexaServiceAmountMinor: serviceAmountMinor, transactionFeeMinor, providerAmountMinor: 0 },
        }, { merge: true });
      }
      transaction.create(outcomeAuditRef, {
        actorUid: "system:nexa-call-timeout",
        action: outcome === "PROVIDER_UNRESPONSIVE" ? "teleconsultation_provider_no_show_classified" : "teleconsultation_patient_no_show_classified",
        resource: `appointments/${appointmentId}`, initiatedByRole: role, unansweredAttemptCount: unanswered,
        serviceAmountMinor, transactionFeeMinor, providerAmountMinor: 0,
        occurredAt: new Date(nowMs), createdAt: FieldValue.serverTimestamp(),
      });
    });

    if (needsWalletRefund) {
      try {
        await creditProviderNoShowRefund(appointmentId);
      } catch (error) {
        logger.error("NEXA provider no-show refund requires reconciliation", { errorName: error instanceof Error ? error.name : "unknown-error" });
      }
    }
    if (outcome === "PATIENT_UNRESPONSIVE" && patientUid && typeof createNexaNotification === "function") {
      await createNexaNotification(patientUid, `appointment:${appointmentId}:patient-no-show-retained`, {
        type: "appointment_patient_no_show", title: "Téléconsultation manquée",
        body: "Après deux appels initiés par le médecin et restés sans réponse du patient, le montant du service est conservé par NEXA et aucun versement n’est dû au médecin.",
        url: "/espace-patient.html",
      }, appointmentId).catch((error) => logger.warn("NEXA patient no-show notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
      if (providerUid) await createNexaNotification(providerUid, `appointment:${appointmentId}:patient-no-show-retained-provider`, {
        type: "appointment_patient_no_show", title: "Téléconsultation manquée",
        body: "Deux appels initiés par le médecin sont restés sans réponse de votre part. La séance est clôturée et le montant du service est conservé par NEXA.",
        url: "/espace-professionnel.html",
      }, appointmentId).catch((error) => logger.warn("NEXA provider no-show notice failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
    } else if (outcome === "PROVIDER_UNRESPONSIVE" && needsWalletRefund && providerUid && typeof createNexaNotification === "function") {
      await createNexaNotification(providerUid, `appointment:${appointmentId}:provider-no-show`, {
        type: "appointment_provider_no_show", title: "Téléconsultation non réalisée",
        body: "Deux appels initiés par le patient sont restés sans réponse du médecin. Le prix du service est remboursé au patient; les frais de transaction ne sont pas remboursés.",
        url: "/espace-professionnel.html",
      }, appointmentId).catch((error) => logger.warn("NEXA provider no-show notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
    } else if (outcome === "PROVIDER_UNRESPONSIVE" && !needsWalletRefund && patientUid && typeof createNexaNotification === "function") {
      await createNexaNotification(patientUid, `appointment:${appointmentId}:provider-no-show-cash-review`, {
        type: "appointment_cash_refund_review", title: "Remboursement en espèces à traiter",
        body: "NEXA a transmis votre demande de remboursement en espèces à l’administration. Les frais de transaction ne sont pas remboursés.",
        url: "/espace-patient.html",
      }, appointmentId).catch((error) => logger.warn("NEXA no-show cash notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
    }
    return { outcome: outcome || undefined, needsWalletRefund };
  }

  async function reconcileUnacceptedTeleconsultation(appointmentId, nowMs = Date.now()) {
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const alertRef = db.collection("paymentSettlementAlerts").doc(`appointment_no_show_${appointmentId}`);
    const auditRef = db.collection("paymentAuditLogs").doc();
    let outcome = null;

    await db.runTransaction(async (transaction) => {
      const appointmentSnapshot = await transaction.get(appointmentRef);
      if (!appointmentSnapshot.exists) return;
      const appointment = appointmentSnapshot.data() || {};
      const startsAtMs = timestamp(appointment.startsAt);
      const activeSession = ["ACTIVE", "IN_PROGRESS"].includes(String(appointment.sessionStatus || "").toUpperCase()) ||
        String(appointment.videoStatus || "").toUpperCase() === "ACTIVE";
      if (appointment.status !== "CONFIRMED" || appointment.paymentStatus !== "PAID" ||
        appointment.providerType !== "doctor" || appointment.bookingType !== "teleconsultation" ||
        appointment.noShowOutcome || timestamp(appointment.effectiveConsultationStartedAt) > 0 ||
        timestamp(appointment.trustedAgoraRtcStartedAt) > 0 ||
        activeSession ||
        TERMINAL_SESSION_STATUSES.has(String(appointment.sessionStatus || "").toUpperCase()) ||
        !Number.isFinite(startsAtMs) || nowMs < startsAtMs) return;

      const patientUid = typeof appointment.patientUid === "string" ? appointment.patientUid : "";
      const providerUid = typeof appointment.providerUid === "string" ? appointment.providerUid : "";
      const paymentRef = typeof appointment.moncashPaymentRef === "string" ? appointment.moncashPaymentRef : "";
      const amount = Number(appointment.amount);
      const fee = Number(appointment.transactionFee || 0);
      if (!patientUid || !providerUid || !/^[A-Za-z0-9_-]{20,64}$/.test(paymentRef) ||
        !Number.isSafeInteger(amount) || amount <= 0 || amount > 10_000_000 ||
        !Number.isSafeInteger(fee) || fee < 0 ||
        !Number.isSafeInteger(amount * 100) || !Number.isSafeInteger(fee * 100)) {
        throw new ApiError(409, "unaccepted-appointment-payment-invalid", "Le paiement du rendez-vous ne peut pas être rapproché.");
      }
      const paymentSnapshot = await transaction.get(db.collection("paymentIntents").doc(paymentRef));
      const payment = paymentSnapshot.data() || {};
      if (!paymentSnapshot.exists || payment.status !== "paid" || payment.resourceType !== "appointment" ||
        payment.resourcePath !== `appointments/${appointmentId}` || payment.uid !== patientUid ||
        String(payment.currency || "").toUpperCase() !== "HTG" || String(appointment.currency || "").toUpperCase() !== "HTG" ||
        typeof appointmentPaymentMatches !== "function" || !appointmentPaymentMatches(appointment, payment)) {
        throw new ApiError(409, "unaccepted-appointment-payment-mismatch", "Le paiement du rendez-vous ne correspond plus à sa réservation.");
      }

      const nowIso = new Date(nowMs).toISOString();
      const requestedCash = appointment.requestedRefundMethod === "CASH_MANUAL";
      const serviceAmountMinor = amount * 100;
      const transactionFeeMinor = fee * 100;
      const update = {
        status: "PROVIDER_NO_SHOW_REFUND_REQUIRED",
        sessionStatus: "NO_SHOW",
        videoStatus: "ENDED",
        videoParticipants: {},
        videoActiveSinceMs: null,
        interactiveEndsAt: nowIso,
        noShowOutcome: "PROVIDER_UNRESPONSIVE",
        noShowTriggeredBy: "scheduler",
        noShowReason: "PROVIDER_DID_NOT_ACCEPT",
        noShowAt: FieldValue.serverTimestamp(),
        refundRequired: true,
        refundStatus: requestedCash ? "PENDING_MANUAL_CASH" : "PENDING_REVIEW",
        settlementStatus: "REVIEW_REQUIRED",
        noShowSettlement: {
          serviceAmountMinor,
          potentialPatientRefundMinor: serviceAmountMinor,
          transactionFeeMinor,
          transactionFeeRefunded: false,
          providerAmountMinor: 0,
        },
        updatedAt: FieldValue.serverTimestamp(),
      };
      transaction.set(appointmentRef, update, { merge: true });
      if (requestedCash) {
        transaction.set(alertRef, {
          paymentRef,
          resourceType: "appointment",
          resourceId: appointmentId,
          status: "open",
          reason: "PROVIDER_NO_SHOW_CASH_REFUND_REQUESTED",
          requestedRefundMethod: "CASH_MANUAL",
          refundRequestedByUid: patientUid,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      transaction.create(auditRef, {
        actorUid: "system:nexa-unaccepted-appointment-reconciler",
        action: "teleconsultation_provider_no_show_review_required",
        resource: `appointments/${appointmentId}`,
        serviceAmountMinor,
        transactionFeeMinor,
        providerAmountMinor: 0,
        occurredAt: new Date(nowMs),
        createdAt: FieldValue.serverTimestamp(),
      });
      outcome = { patientUid, providerUid, requestedCash, amount };
    });

    if (!outcome) return null;
    if (outcome.patientUid && typeof createNexaNotification === "function") {
      await createNexaNotification(outcome.patientUid, outcome.requestedCash
        ? `appointment:${appointmentId}:provider-no-show-cash-review`
        : `appointment:${appointmentId}:provider-no-show-admin-review`, {
        type: outcome.requestedCash ? "appointment_cash_refund_review" : "appointment_admin_review",
        title: outcome.requestedCash ? "Remboursement en espèces à traiter" : "Téléconsultation transmise à l’administration",
        body: outcome.requestedCash
          ? "Le médecin n’a pas accepté votre téléconsultation à l’heure prévue. NEXA a transmis votre demande de remboursement en espèces à l’administration. Les frais de transaction ne sont pas remboursés."
          : "Le médecin n’a pas accepté votre téléconsultation à l’heure prévue. Le dossier est en attente d’examen par l’administration NEXA. Aucun remboursement automatique n’a été effectué; les frais de transaction ne sont pas remboursables.",
        url: "/espace-patient.html",
      }, appointmentId).catch((error) => logger.warn("NEXA unaccepted appointment cash notice failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
    }
    if (outcome.providerUid && typeof createNexaNotification === "function") {
      await createNexaNotification(outcome.providerUid, `appointment:${appointmentId}:provider-did-not-accept`, {
        type: "appointment_provider_no_show",
        title: "Téléconsultation non acceptée",
        body: "Le rendez-vous payé n’a pas été accepté à l’heure prévue. La réservation attend l’examen de l’administration NEXA; aucun remboursement automatique n’a été effectué.",
        url: "/espace-professionnel.html",
      }, appointmentId).catch((error) => logger.warn("NEXA unaccepted appointment provider notice failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
    }
    return outcome;
  }

  async function requireAppointmentParticipant(req, appointmentId) {
    const user = await requireUser(req);
    await requireAppCheckToken(req);
    const appointment = await db.collection("appointments").doc(appointmentId).get();
    if (!appointment.exists || (appointment.get("patientUid") !== user.uid && appointment.get("providerUid") !== user.uid)) {
      throw new ApiError(404, "appointment-not-found", "Consultation introuvable.");
    }
    const data = appointment.data() || {};
    if (!validVideoAppointment(data) || TERMINAL_SESSION_STATUSES.has(String(data.sessionStatus || "").toUpperCase())) {
      throw new ApiError(409, "session-not-active", "L’appel vidéo est disponible après acceptation du médecin pour une consultation payée.");
    }
    const start = timestamp(data.startsAt);
    const scheduledEnd = timestamp(data.endsAt);
    const configuredEnd = timestamp(data.interactiveEndsAt);
    const interactiveEnd = Number.isFinite(configuredEnd) && configuredEnd > 0
      ? configuredEnd
      : Number.isFinite(scheduledEnd) ? scheduledEnd + 15 * 60_000 : Number.NaN;
    const now = Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(interactiveEnd)) throw new ApiError(409, "invalid-consultation-slot", "Le créneau de consultation est invalide.");
    if (now < start) throw new ApiError(403, "consultation-not-started", "La vidéo ne peut démarrer qu’à l’heure prévue.");
    if (now >= interactiveEnd) throw new ApiError(409, "session-not-interactive", "La fenêtre interactive de cette séance est terminée.");
    return { user, appointment: data };
  }

  const nexaPatientTeleconsultationCashRefundPreference = onRequest({ region: REGION }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      res.set("Allow", "POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if ((Number(req.get("Content-Length")) || 0) > 4_096 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 4_096)) {
      return fail(res, 413, "request-too-large", "La requête dépasse la taille autorisée.");
    }
    try {
      const body = getBody(req);
      if (!body || Object.keys(body).some((key) => !["appointmentId", "refundMethod"].includes(key))) {
        throw new ApiError(400, "invalid-request", "La demande de remboursement n’est pas valide.");
      }
      const appointmentId = typeof body.appointmentId === "string" ? body.appointmentId.trim() : "";
      const refundMethod = typeof body.refundMethod === "string" ? body.refundMethod : "";
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId) || !["CASH_MANUAL", "NEXA_WALLET"].includes(refundMethod)) {
        throw new ApiError(400, "invalid-refund-request", "Un rendez-vous et un mode de remboursement valides sont requis.");
      }

      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "teleconsultation-cash-refund-preference", 10, 60_000);

      const appointmentRef = db.collection("appointments").doc(appointmentId);
      const profileRef = db.collection("patientProfiles").doc(user.uid);
      const auditRef = db.collection("paymentAuditLogs").doc();
      const alertRef = db.collection("paymentSettlementAlerts").doc(`appointment_no_show_${appointmentId}`);
      let outcome = null;

      await db.runTransaction(async (transaction) => {
        const appointmentSnapshot = await transaction.get(appointmentRef);
        if (!appointmentSnapshot.exists || appointmentSnapshot.get("patientUid") !== user.uid) {
          throw new ApiError(404, "appointment-not-found", "Ce rendez-vous n’est pas accessible.");
        }
        const appointment = appointmentSnapshot.data() || {};
        const paymentRef = typeof appointment.moncashPaymentRef === "string" ? appointment.moncashPaymentRef : "";
        if (typeof appointment.providerType !== "string" || appointment.providerType.toLowerCase() !== "doctor" ||
          !["teleconsultation", "doctor_proposed_appointment"].includes(String(appointment.bookingType || "")) ||
          appointment.paymentStatus !== "PAID" || !/^[A-Za-z0-9_-]{20,64}$/.test(paymentRef) ||
          !["HTG", "htg"].includes(String(appointment.currency || ""))) {
          throw new ApiError(409, "refund-not-available", "Cette demande est disponible pour une téléconsultation médecin déjà payée.");
        }

        const consultationHasStarted = timestamp(appointment.effectiveConsultationStartedAt) > 0 ||
          timestamp(appointment.trustedAgoraRtcStartedAt) > 0;
        const noShowAfterUnacceptedAppointment = appointment.noShowReason === "PROVIDER_DID_NOT_ACCEPT" &&
          appointment.noShowTriggeredBy === "scheduler";
        const noShowAfterUnansweredCalls = appointment.noShowTriggeredBy === "patient" &&
          unansweredCallCount(parseCallAttempts(appointment.videoCallAttempts), "patient") >= MAX_UNANSWERED_CALLS;
        const noShowPendingDecision = appointment.status === "PROVIDER_NO_SHOW_REFUND_REQUIRED" &&
          appointment.refundRequired === true && ["PENDING_AUTO_REFUND", "PENDING_REVIEW"].includes(appointment.refundStatus) &&
          appointment.noShowOutcome === "PROVIDER_UNRESPONSIVE" &&
          (noShowAfterUnacceptedAppointment || noShowAfterUnansweredCalls) &&
          !consultationHasStarted;
        const activeBeforeConsultation = validVideoAppointment(appointment) && !appointment.noShowOutcome &&
          !consultationHasStarted &&
          String(appointment.sessionStatus || "").toUpperCase() !== "ACTIVE" &&
          String(appointment.videoStatus || "").toUpperCase() !== "ACTIVE";
        const startsAtMs = timestamp(appointment.startsAt);
        const confirmedBeforeAcceptance = appointment.status === "CONFIRMED" &&
          appointment.providerType === "doctor" && appointment.bookingType === "teleconsultation" &&
          appointment.paymentStatus === "PAID" && !appointment.noShowOutcome &&
          Number.isFinite(startsAtMs) && Date.now() < startsAtMs &&
          !consultationHasStarted && String(appointment.sessionStatus || "").toUpperCase() !== "ACTIVE" &&
          String(appointment.videoStatus || "").toUpperCase() !== "ACTIVE";
        if (!noShowPendingDecision && !activeBeforeConsultation && !confirmedBeforeAcceptance) {
          if (appointment.requestedRefundMethod === "CASH_MANUAL" && appointment.refundStatus === "PENDING_MANUAL_CASH" && refundMethod === "CASH_MANUAL") {
            outcome = { requestedRefundMethod: "CASH_MANUAL", refundStatus: "PENDING_MANUAL_CASH", alreadyRequested: true };
            return;
          }
          throw new ApiError(409, "refund-preference-locked", "Le remboursement a commencé ou la séance n’est plus admissible; le mode ne peut pas être changé.");
        }
        if (refundMethod === "NEXA_WALLET" && appointment.requestedRefundMethod !== "CASH_MANUAL") {
          outcome = { requestedRefundMethod: "NEXA_WALLET", preferenceCleared: true, alreadyCleared: true };
          return;
        }

        const [profileSnapshot, paymentSnapshot, alertSnapshot] = await Promise.all([
          transaction.get(profileRef),
          transaction.get(db.collection("paymentIntents").doc(paymentRef)),
          transaction.get(alertRef),
        ]);
        const payment = paymentSnapshot.data() || {};
        if (!profileSnapshot.exists || profileSnapshot.get("role") !== "patient" || profileSnapshot.get("profileComplete") !== true ||
          !paymentSnapshot.exists || payment.status !== "paid" || payment.resourceType !== "appointment" ||
          payment.resourcePath !== `appointments/${appointmentId}` || payment.uid !== user.uid ||
          String(payment.currency || "").toUpperCase() !== "HTG" || typeof appointmentPaymentMatches !== "function" ||
          !appointmentPaymentMatches(appointment, payment)) {
          throw new ApiError(409, "refund-payment-mismatch", "Le paiement ne correspond pas à ce rendez-vous.");
        }
        if (alertSnapshot.exists && alertSnapshot.get("status") === "resolved" && noShowPendingDecision) {
          throw new ApiError(409, "refund-review-already-closed", "L’administration a déjà clôturé le suivi de ce remboursement.");
        }

        const requestedCash = refundMethod === "CASH_MANUAL";
        if (!requestedCash && noShowPendingDecision) {
          throw new ApiError(409, "cash-refund-request-locked", "Après le signalement de l’absence, la demande en espèces ne peut plus être annulée depuis cet espace.");
        }

        const now = FieldValue.serverTimestamp();
        if (requestedCash) {
          transaction.set(appointmentRef, {
            requestedRefundMethod: "CASH_MANUAL",
            refundRequestStatus: noShowPendingDecision ? "REQUESTED" : "PREFERENCE_RECORDED",
            ...(noShowPendingDecision ? { refundRequestedAt: now } : { refundPreferenceAt: now }),
            ...(noShowPendingDecision ? { refundStatus: "PENDING_MANUAL_CASH" } : {}),
            updatedAt: now,
          }, { merge: true });
          if (noShowPendingDecision) {
            transaction.set(alertRef, {
              paymentRef,
              resourceType: "appointment",
              resourceId: appointmentId,
              status: alertSnapshot.exists && alertSnapshot.get("status") === "in_review" ? "in_review" : "open",
              reason: "PROVIDER_NO_SHOW_CASH_REFUND_REQUESTED",
              requestedRefundMethod: "CASH_MANUAL",
              refundRequestedByUid: user.uid,
              createdAt: alertSnapshot.exists ? alertSnapshot.get("createdAt") : now,
              updatedAt: now,
            }, { merge: true });
          }
          outcome = {
            requestedRefundMethod: "CASH_MANUAL",
            refundStatus: noShowPendingDecision ? "PENDING_MANUAL_CASH" : "PREFERENCE_RECORDED",
            alreadyRequested: appointment.requestedRefundMethod === "CASH_MANUAL",
          };
        } else {
          transaction.update(appointmentRef, {
            requestedRefundMethod: FieldValue.delete(),
            refundRequestStatus: FieldValue.delete(),
            refundRequestedAt: FieldValue.delete(),
            refundPreferenceAt: FieldValue.delete(),
            updatedAt: now,
          });
          outcome = { requestedRefundMethod: "NEXA_WALLET", preferenceCleared: true };
        }
        transaction.create(auditRef, {
          actorUid: user.uid,
          action: requestedCash ? "teleconsultation_cash_refund_preference_recorded" : "teleconsultation_cash_refund_preference_cancelled",
          resource: `appointments/${appointmentId}`,
          requestedRefundMethod: requestedCash ? "CASH_MANUAL" : "NEXA_WALLET",
          ...(noShowPendingDecision && requestedCash ? { amountMinor: Number(appointment.amount) * 100, currency: "HTG" } : {}),
          createdAt: now,
        });
      });

      res.set("Cache-Control", "no-store, max-age=0");
      if (outcome?.refundStatus === "PENDING_MANUAL_CASH" && !outcome.alreadyRequested && typeof createNexaNotification === "function") {
        await createNexaNotification(user.uid, `appointment:${appointmentId}:provider-no-show-cash-review-late`, {
          type: "appointment_cash_refund_review",
          title: "Demande de remboursement en espèces transmise",
          body: "L’administration NEXA doit traiter manuellement votre demande. Les frais de transaction ne sont pas remboursés.",
          url: "/espace-patient.html",
        }, appointmentId).catch((error) => logger.warn("NEXA late cash refund notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
      }
      return res.status(200).json({ ok: true, ...outcome });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA teleconsultation refund preference failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "teleconsultation-refund-preference-failed", "La demande ne peut pas être enregistrée pour le moment.");
    }
  });

  const nexaTeleconsultationPresence = onRequest({ region: REGION }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      res.set("Allow", "POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if ((Number(req.get("Content-Length")) || 0) > 4_096 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 4_096)) {
      return fail(res, 413, "request-too-large", "La requête dépasse la taille autorisée.");
    }
    try {
      const body = getBody(req);
      const appointmentId = typeof body?.appointmentId === "string" ? body.appointmentId.trim() : "";
      const action = typeof body?.action === "string" ? body.action : "";
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) throw new ApiError(400, "appointment-required", "Un rendez-vous valide est requis.");
      if (!["join", "heartbeat", "leave"].includes(action)) throw new ApiError(400, "invalid-presence-action", "L’action de présence n’est pas valide.");
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "teleconsultation-presence", 60, 60_000);
      const presence = await recordTeleconsultationPresence(db, FieldValue, ApiError, { appointmentId, uid: user.uid, action });
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(presence.expired ? 409 : 200).json({
        ok: !presence.expired,
        ...presence,
        ...(presence.expired ? { code: "video-quota-exhausted", error: "La durée vidéo incluse dans cette consultation est terminée." } : {}),
      });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA teleconsultation presence failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "video-presence-unavailable", "Le suivi de la séance est momentanément indisponible.");
    }
  });

  const nexaAgoraToken = onRequest({ region: REGION, secrets: [AGORA_APP_ID, AGORA_APP_CERTIFICATE, AGORA_RTC_NOTIFICATION_SECRET] }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      res.set("Allow", "POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if ((Number(req.get("Content-Length")) || 0) > 4_096 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 4_096)) {
      return fail(res, 413, "request-too-large", "La requête dépasse la taille autorisée.");
    }
    try {
      const body = getBody(req);
      const appointmentId = typeof body?.appointmentId === "string" ? body.appointmentId.trim() : "";
      const presenceAction = body?.presenceAction === "join" ? "join" : body?.presenceAction === "heartbeat" ? "heartbeat" : "";
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId) || !presenceAction) {
        throw new ApiError(400, "appointment-required", "Un rendez-vous et une action vidéo valides sont requis.");
      }
      const { user, appointment } = await requireAppointmentParticipant(req, appointmentId);
      await enforceUserRateLimit(user.uid, "agora-token", 60, 60_000);
      if (!isAgoraRtcEventsEnabled()) throw new ApiError(503, "video-verification-not-configured", "La vérification serveur Agora n’est pas encore configurée.");
      const appId = String(AGORA_APP_ID.value() || "").trim();
      const appCertificate = String(AGORA_APP_CERTIFICATE.value() || "").trim();
      if (!AGORA_CREDENTIAL_PATTERN.test(appId) || !AGORA_CREDENTIAL_PATTERN.test(appCertificate)) {
        throw new ApiError(503, "video-not-configured", "Le service vidéo n’est pas encore configuré sur le serveur.");
      }

      const presence = await recordTeleconsultationPresence(db, FieldValue, ApiError, {
        appointmentId, uid: user.uid, action: presenceAction,
      });
      if (presence.expired) {
        const code = presence.sessionStatus === "INTERACTIVE_TIME_EXPIRED" ? "video-quota-exhausted" : "session-not-active";
        const message = presence.sessionStatus === "INTERACTIVE_TIME_EXPIRED"
          ? "La durée vidéo incluse dans cette consultation est terminée."
          : "La séance vidéo est terminée.";
        throw new ApiError(409, code, message);
      }
      if (!presence.videoRemainingSeconds) throw new ApiError(409, "video-quota-exhausted", "La durée vidéo incluse dans cette consultation est terminée.");

      const channelName = `nexa_${appointmentId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80)}`;
      const uid = agoraUid(user.uid);
      const scheduledEnd = timestamp(appointment.endsAt);
      const configuredEnd = timestamp(appointment.interactiveEndsAt);
      const interactiveEnd = Number.isFinite(configuredEnd) && configuredEnd > 0
        ? configuredEnd
        : Number.isFinite(scheduledEnd) ? scheduledEnd + 15 * 60_000 : Date.now() + TOKEN_TTL_SECONDS * 1_000;
      const ttlSeconds = Math.max(1, Math.floor(Math.min(
        TOKEN_TTL_SECONDS,
        presence.videoRemainingSeconds,
        (interactiveEnd - Date.now()) / 1_000,
      )));
      const token = RtcTokenBuilder.buildTokenWithUid(
        appId, appCertificate, channelName, uid, RtcRole.PUBLISHER, ttlSeconds, ttlSeconds,
      );
      if (!token) throw new ApiError(503, "video-token-generation-failed", "Impossible d’ouvrir la salle vidéo pour le moment.");
      await db.runTransaction(async (transaction) => {
        const appointmentRef = db.collection("appointments").doc(appointmentId);
        const currentSnapshot = await transaction.get(appointmentRef);
        if (!currentSnapshot.exists || (currentSnapshot.get("patientUid") !== user.uid && currentSnapshot.get("providerUid") !== user.uid)) {
          throw new ApiError(404, "appointment-not-found", "Consultation introuvable.");
        }
        const current = currentSnapshot.data() || {};
        if (!validVideoAppointment(current) || TERMINAL_SESSION_STATUSES.has(String(current.sessionStatus || "").toUpperCase())) {
          throw new ApiError(409, "session-not-active", "La salle vidéo n’est plus disponible pour cette séance.");
        }
        if (current.videoAgoraChannelName && current.videoAgoraChannelName !== channelName) {
          throw new ApiError(409, "video-channel-conflict", "Le canal vidéo de cette séance ne correspond pas.");
        }
        transaction.set(appointmentRef, { videoAgoraChannelName: channelName, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      });
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({
        ok: true,
        appId,
        token,
        channelName,
        uid,
        expiresAt: Math.floor(Date.now() / 1_000) + ttlSeconds,
        videoLimitSeconds: presence.videoLimitSeconds,
        videoConsumedSeconds: presence.videoConsumedSeconds,
        videoRemainingSeconds: presence.videoRemainingSeconds,
        videoStatus: presence.videoStatus,
      });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA Agora token generation failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "video-session-unavailable", "La salle vidéo ne peut pas être ouverte pour le moment.");
    }
  });

  const nexaVideoSignal = onRequest({ region: REGION, secrets: [AGORA_RTC_NOTIFICATION_SECRET] }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) {
      res.set("Allow", "GET, POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if (req.method === "POST" && ((Number(req.get("Content-Length")) || 0) > 4_096 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 4_096))) {
      return fail(res, 413, "request-too-large", "La requête dépasse la taille autorisée.");
    }
    try {
      const queryAppointmentId = typeof req.query.appointmentId === "string" ? req.query.appointmentId.trim() : "";
      const body = req.method === "POST" ? getBody(req) : null;
      const appointmentId = req.method === "GET" ? queryAppointmentId : typeof body?.appointmentId === "string" ? body.appointmentId.trim() : "";
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) throw new ApiError(400, "invalid-appointment", "Le rendez-vous n’est pas valide.");
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, req.method === "GET" ? "video-signal-read" : "video-signal-write", req.method === "GET" ? 60 : 12, 60_000);
      const appointmentRef = db.collection("appointments").doc(appointmentId);
      const snapshot = await appointmentRef.get();
      if (!snapshot.exists || (snapshot.get("patientUid") !== user.uid && snapshot.get("providerUid") !== user.uid)) {
        throw new ApiError(404, "appointment-not-found", "Consultation introuvable.");
      }
      const appointment = snapshot.data() || {};
      const action = req.method === "POST" && typeof body?.action === "string" ? body.action.toLowerCase() : "";
      const readOnlyPoll = req.method === "POST" && action === "timeout";
      const alreadyClosed = appointment.status === "COMPLETED" || TERMINAL_SESSION_STATUSES.has(String(appointment.sessionStatus || "").toUpperCase());
      if (readOnlyPoll && alreadyClosed) {
        if (appointment.status === "PROVIDER_NO_SHOW_REFUND_REQUIRED" && appointment.refundStatus === "PENDING_AUTO_REFUND") {
          try { await creditProviderNoShowRefund(appointmentId); }
          catch (error) { logger.error("NEXA pending provider no-show refund retry failed", { errorName: error instanceof Error ? error.name : "unknown-error" }); }
        }
        const latest = await appointmentRef.get();
        const latestData = latest.data() || appointment;
        res.set("Cache-Control", "no-store, max-age=0");
        return res.status(200).json({
          ok: true,
          videoSignal: publicSignal(latestData.videoSignal, user.uid),
          callAttempts: publicCallAttempts(parseCallAttempts(latestData.videoCallAttempts)),
          noShowOutcome: typeof latestData.noShowOutcome === "string" ? latestData.noShowOutcome : null,
          noShowReason: typeof latestData.noShowReason === "string" ? latestData.noShowReason : null,
          participantRole: user.uid === latestData.providerUid ? "doctor" : "patient",
          canComplete: false,
          startsAt: typeof latestData.startsAt === "string" ? latestData.startsAt : "",
          appointmentStatus: String(latestData.status || "UNKNOWN"),
          sessionStatus: String(latestData.sessionStatus || ""),
        });
      }
      if (!validVideoAppointment(appointment)) throw new ApiError(409, "session-not-active", "L’appel vidéo est disponible après acceptation du médecin pour une consultation payée.");
      const start = timestamp(appointment.startsAt);
      const scheduledEnd = timestamp(appointment.endsAt);
      const configuredEnd = timestamp(appointment.interactiveEndsAt);
      const interactiveEnd = Number.isFinite(configuredEnd) && configuredEnd > 0
        ? configuredEnd
        : Number.isFinite(scheduledEnd) ? scheduledEnd + 15 * 60_000 : Number.NaN;
      if (req.method === "POST" && action !== "timeout" && (!Number.isFinite(start) || !Number.isFinite(interactiveEnd) || Date.now() < start || Date.now() >= interactiveEnd)) {
        throw new ApiError(409, "session-not-interactive", "La fenêtre interactive de cette séance est terminée ou n’a pas commencé.");
      }
      if (req.method === "GET") {
        res.set("Cache-Control", "no-store, max-age=0");
        return res.status(200).json({
          ok: true,
          videoSignal: publicSignal(appointment.videoSignal, user.uid),
          callAttempts: publicCallAttempts(parseCallAttempts(appointment.videoCallAttempts)),
          noShowOutcome: typeof appointment.noShowOutcome === "string" ? appointment.noShowOutcome : null,
          noShowReason: typeof appointment.noShowReason === "string" ? appointment.noShowReason : null,
          participantRole: user.uid === appointment.providerUid ? "doctor" : "patient",
          canComplete: user.uid === appointment.providerUid && appointment.status === "IN_PROGRESS" && Boolean(appointment.effectiveConsultationStartedAt),
          startsAt: typeof appointment.startsAt === "string" ? appointment.startsAt : "",
        });
      }

      if (Object.keys(body || {}).some((key) => !["appointmentId", "action"].includes(key)) || !["invite", "accept", "refuse", "connected", "end", "timeout"].includes(action)) {
        throw new ApiError(400, "invalid-video-signal", "Action d’appel vidéo invalide.");
      }
      if (!isAgoraRtcEventsEnabled() && !["timeout", "end"].includes(action)) {
        throw new ApiError(503, "video-verification-not-configured", "La vérification serveur Agora n’est pas encore configurée.");
      }
      if (action !== "timeout") await reconcileExpiredTeleconsultationCall(appointmentId);
      if (TERMINAL_SESSION_STATUSES.has(String(appointment.sessionStatus || "").toUpperCase())) {
        throw new ApiError(409, "session-not-interactive", "La séance vidéo est terminée.");
      }
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const current = appointment.videoSignal && typeof appointment.videoSignal === "object" && !Array.isArray(appointment.videoSignal) ? appointment.videoSignal : {};
      const currentStatus = String(current.status || "").toUpperCase();
      const currentUpdated = timestamp(current.updatedAt);
      const currentFresh = Number.isFinite(currentUpdated) && now - currentUpdated <= CALL_RING_TTL_MS;
      const patientUid = String(appointment.patientUid || "");
      const providerUid = String(appointment.providerUid || "");
      const otherUid = user.uid === patientUid ? providerUid : patientUid;
      const role = user.uid === patientUid ? "patient" : "doctor";
      const priorAttempts = parseCallAttempts(appointment.videoCallAttempts);

      if (action === "timeout") {
        await reconcileExpiredTeleconsultationCall(appointmentId, now);
        const fresh = await appointmentRef.get();
        const data = fresh.data() || {};
        res.set("Cache-Control", "no-store, max-age=0");
        return res.status(200).json({
          ok: true,
          videoSignal: publicSignal(data.videoSignal, user.uid),
          callAttempts: publicCallAttempts(parseCallAttempts(data.videoCallAttempts)),
          noShowOutcome: data.noShowOutcome || null,
          noShowReason: typeof data.noShowReason === "string" ? data.noShowReason : null,
          participantRole: user.uid === data.providerUid ? "doctor" : "patient",
          canComplete: user.uid === data.providerUid && data.status === "IN_PROGRESS" && Boolean(data.effectiveConsultationStartedAt),
          startsAt: typeof data.startsAt === "string" ? data.startsAt : "",
          appointmentStatus: String(data.status || "UNKNOWN"),
          sessionStatus: String(data.sessionStatus || ""),
        });
      }

      let notification = null;
      let signalResult = null;
      let attemptsResult = priorAttempts;
      await db.runTransaction(async (transaction) => {
        notification = null;
        signalResult = null;
        attemptsResult = [];
        const fresh = await transaction.get(appointmentRef);
        if (!fresh.exists || (fresh.get("patientUid") !== user.uid && fresh.get("providerUid") !== user.uid)) {
          throw new ApiError(404, "appointment-not-found", "Consultation introuvable.");
        }
        const data = fresh.data() || {};
        if (!validVideoAppointment(data)) throw new ApiError(409, "session-not-active", "L’appel vidéo n’est plus disponible pour cette séance.");
        const signal = data.videoSignal && typeof data.videoSignal === "object" && !Array.isArray(data.videoSignal) ? data.videoSignal : {};
        const signalStatus = String(signal.status || "").toUpperCase();
        const signalUpdated = timestamp(signal.updatedAt);
        const freshSignal = Number.isFinite(signalUpdated) && now - signalUpdated <= CALL_RING_TTL_MS;
        const attempts = parseCallAttempts(data.videoCallAttempts);
        let next;
        if (action === "invite") {
          if (data.videoStatus === "ACTIVE") throw new ApiError(409, "video-call-already-active", "Un appel vidéo est déjà actif.");
          if (["RINGING", "CONNECTING"].includes(signalStatus) && freshSignal) {
            if (signalStatus === "RINGING" && signal.by === user.uid && typeof signal.id === "string") {
              signalResult = signal; attemptsResult = attempts; return;
            }
            throw new ApiError(409, "video-call-already-pending", "Un appel vidéo est déjà en attente ou en cours.");
          }
          next = { id: randomUUID(), status: "RINGING", by: user.uid, updatedAt: nowIso };
          attemptsResult = upsertCallAttempt(attempts, { signalId: next.id, uid: user.uid, role, status: "RINGING", nowMs: now });
          notification = { uid: otherUid, action: "incoming", title: "Appel vidéo entrant", body: "Un participant à votre séance vous invite à rejoindre l’appel vidéo." };
          transaction.set(appointmentRef, { videoSignal: next, videoCallAttempts: attemptsResult, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        } else if (action === "accept" || action === "refuse") {
          if (signalStatus !== "RINGING" || !freshSignal || signal.by === user.uid) throw new ApiError(409, "video-invitation-expired", "Cette invitation n’est plus disponible.");
          next = { ...signal, status: action === "accept" ? "CONNECTING" : "REFUSED", updatedAt: nowIso };
          attemptsResult = setCallAttemptStatus(attempts, String(signal.id || ""), action === "accept" ? "ACCEPTED" : "REFUSED", now);
          notification = { uid: otherUid, action: action === "accept" ? "accepted" : "refused", title: action === "accept" ? "Appel vidéo accepté" : "Appel vidéo refusé", body: action === "accept" ? "L’autre participant a accepté l’invitation vidéo." : "L’autre participant ne peut pas rejoindre l’appel pour le moment." };
          transaction.set(appointmentRef, { videoSignal: next, videoCallAttempts: attemptsResult, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        } else if (action === "connected") {
          const presence = activeParticipants(parsePresence(data.videoParticipants), now);
          if (![patientUid, providerUid].every((uid) => presence[uid])) throw new ApiError(409, "video-call-not-connected", "Les deux participants doivent rejoindre la salle vidéo avant de confirmer l’appel.");
          const agoraParticipants = parseAgoraParticipants(data.videoAgoraParticipants);
          const bothConnected = ["patient", "doctor"].every((participantRole) => agoraParticipants[participantRole]?.state === "JOINED");
          if (!bothConnected) throw new ApiError(409, "video-rtc-presence-unconfirmed", "Agora n’a pas encore confirmé la présence des deux participants.");
          next = { id: typeof signal.id === "string" ? signal.id : randomUUID(), status: bothConnected ? "ACTIVE" : "CONNECTING", by: typeof signal.by === "string" ? signal.by : user.uid, updatedAt: nowIso };
          attemptsResult = setCallAttemptStatus(attempts, String(signal.id || ""), "CONNECTED", now);
          transaction.set(appointmentRef, {
            videoSignal: next,
            videoCallAttempts: attemptsResult,
            videoStatus: bothConnected ? "ACTIVE" : "WAITING",
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        } else {
          next = { id: typeof signal.id === "string" ? signal.id : randomUUID(), status: "ENDED", by: typeof signal.by === "string" ? signal.by : user.uid, endedBy: user.uid, updatedAt: nowIso };
          attemptsResult = setCallAttemptStatus(attempts, String(signal.id || ""), "ENDED", now);
          transaction.set(appointmentRef, { videoSignal: next, videoCallAttempts: attemptsResult, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
          notification = { uid: otherUid, action: "ended", title: "Appel vidéo terminé", body: "L’autre participant a quitté l’appel vidéo." };
        }
        signalResult = next;
      });

      if (notification && typeof createNexaNotification === "function") {
        const signalId = typeof signalResult?.id === "string" ? signalResult.id : "unknown";
        await createNexaNotification(notification.uid, `video-call:${appointmentId}:${signalId}:${notification.action}`, {
          type: `video_call_${notification.action}`,
          title: notification.title,
          body: notification.body,
          url: `/teleconsultation.html?appointmentId=${encodeURIComponent(appointmentId)}`,
        }, appointmentId).catch((error) => logger.warn("NEXA video call notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
      }
      const latest = await appointmentRef.get();
      const latestData = latest.data() || {};
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({
        ok: true,
        videoSignal: publicSignal(signalResult, user.uid),
        callAttempts: publicCallAttempts(attemptsResult),
        noShowOutcome: typeof latestData.noShowOutcome === "string" ? latestData.noShowOutcome : null,
        noShowReason: typeof latestData.noShowReason === "string" ? latestData.noShowReason : null,
        participantRole: user.uid === latestData.providerUid ? "doctor" : "patient",
        canComplete: user.uid === latestData.providerUid && latestData.status === "IN_PROGRESS" && Boolean(latestData.effectiveConsultationStartedAt),
        startsAt: typeof latestData.startsAt === "string" ? latestData.startsAt : "",
        appointmentStatus: String(latestData.status || "UNKNOWN"),
        sessionStatus: String(latestData.sessionStatus || ""),
      });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA video signal failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "video-signal-unavailable", "L’invitation vidéo est momentanément indisponible.");
    }
  });

  const nexaAgoraRtcNotification = onRequest({ region: REGION, secrets: [AGORA_RTC_NOTIFICATION_SECRET] }, async (req, res) => {
    if (req.method !== "POST") {
      res.set("Allow", "POST");
      return res.status(405).json({ ok: false, error: "method-not-allowed" });
    }
    if ((Number(req.get("Content-Length")) || 0) > 16_384 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 16_384)) {
      return res.status(413).json({ ok: false, error: "request-too-large" });
    }
    if (!Buffer.isBuffer(req.rawBody)) return res.status(400).json({ ok: false, error: "raw-body-required" });

    const secret = AGORA_RTC_NOTIFICATION_SECRET.value().trim();
    const signatureValid = verifyAgoraNotificationSignature(req.rawBody, secret, req.get("Agora-Signature-V2"), "sha256", 32) ||
      verifyAgoraNotificationSignature(req.rawBody, secret, req.get("Agora-Signature"), "sha1", 20);
    if (!signatureValid) return res.status(401).json({ ok: false, error: "invalid-agora-signature" });

    let body;
    try {
      body = JSON.parse(req.rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({ ok: false, error: "invalid-json" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ ok: false, error: "invalid-notification" });
    const noticeId = typeof body.noticeId === "string" ? body.noticeId.trim() : "";
    const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload) ? body.payload : {};
    const eventType = Number(body.eventType);
    if (!noticeId || noticeId.length > 200) return res.status(400).json({ ok: false, error: "invalid-notification-id" });
    if (Number(body.productId) !== 1 || ![107, 108].includes(eventType)) return res.status(200).json({ ok: true, ignored: true });

    const channelName = typeof payload.channelName === "string" ? payload.channelName.trim() : "";
    if (channelName === "test_webhook") return res.status(200).json({ ok: true, ignored: true, healthCheck: true });
    if (!isAgoraRtcEventsEnabled()) return res.status(200).json({ ok: true, ignored: true, disabled: true });
    if (!/^nexa_[A-Za-z0-9_-]{10,80}$/.test(channelName)) return res.status(200).json({ ok: true, matched: false });
    const rtcUid = Number(payload.uid);
    const eventSeconds = Number(payload.ts);
    const eventAtMs = eventSeconds * 1_000;
    const rawClientSeq = req.rawBody.toString("utf8").match(/"clientSeq"\s*:\s*(\d{1,20})/)?.[1] ?? payload.clientSeq;
    const clientSeq = normalizeAgoraClientSequence(rawClientSeq);
    if (!Number.isSafeInteger(rtcUid) || rtcUid <= 0 || !clientSeq ||
      !Number.isSafeInteger(eventSeconds) || eventSeconds <= 0 || !Number.isSafeInteger(eventAtMs)) {
      return res.status(400).json({ ok: false, error: "invalid-rtc-event" });
    }

    try {
      const matches = await db.collection("appointments").where("videoAgoraChannelName", "==", channelName).limit(2).get();
      if (matches.size !== 1) return res.status(200).json({ ok: true, matched: false });

      const appointmentRef = matches.docs[0].ref;
      const noticeHash = createHash("sha256").update(noticeId).digest("hex");
      const notificationRef = db.collection("agoraRtcNotificationEvents").doc(noticeHash);
      let result = { processed: false, duplicate: false };
      await db.runTransaction(async (transaction) => {
        const [notificationSnapshot, appointmentSnapshot] = await Promise.all([
          transaction.get(notificationRef), transaction.get(appointmentRef),
        ]);
        if (notificationSnapshot.exists) {
          result = { processed: false, duplicate: true };
          return;
        }
        const appointment = appointmentSnapshot.data() || {};
        const patientUid = typeof appointment.patientUid === "string" ? appointment.patientUid : "";
        const providerUid = typeof appointment.providerUid === "string" ? appointment.providerUid : "";
        const role = rtcUid === agoraUid(patientUid) ? "patient" : rtcUid === agoraUid(providerUid) ? "doctor" : "";
        const nowMs = Date.now();
        const startMs = timestamp(appointment.startsAt);
        const scheduledEndMs = timestamp(appointment.endsAt);
        const configuredEndMs = timestamp(appointment.interactiveEndsAt);
        const interactiveEndMs = Number.isFinite(configuredEndMs) && configuredEndMs > 0
          ? configuredEndMs
          : Number.isFinite(scheduledEndMs) ? scheduledEndMs + 15 * 60_000 : Number.NaN;
        const insideWindow = Number.isFinite(startMs) && Number.isFinite(interactiveEndMs) && eventAtMs >= startMs &&
          eventAtMs < interactiveEndMs && eventAtMs <= nowMs + 60_000;

        let processingStatus = "IGNORED";
        let participantRole = "";
        if (appointment.videoAgoraChannelName === channelName && role && insideWindow && validVideoAppointment(appointment) &&
          !TERMINAL_SESSION_STATUSES.has(String(appointment.sessionStatus || "").toUpperCase())) {
          const participants = parseAgoraParticipants(appointment.videoAgoraParticipants);
          const previous = participants[role];
          if (!previous || compareAgoraClientSequences(clientSeq, previous.clientSeq) > 0) {
            const joined = eventType === 107;
            participants[role] = {
              uid: rtcUid,
              state: joined ? "JOINED" : "LEFT",
              eventAtMs,
              clientSeq,
              ...(joined
                ? { joinedAtMs: previous?.state === "JOINED" ? previous.joinedAtMs : eventAtMs }
                : previous?.joinedAtMs ? { joinedAtMs: previous.joinedAtMs } : {}),
            };
            const bothJoined = ["patient", "doctor"].every((participantRoleName) => participants[participantRoleName]?.state === "JOINED");
            const anyJoined = ["patient", "doctor"].some((participantRoleName) => participants[participantRoleName]?.state === "JOINED");
            const activePresence = activeParticipants(parsePresence(appointment.videoParticipants), nowMs);
            const priorActiveSinceMs = Number(appointment.videoActiveSinceMs);
            const patch = {
              videoAgoraParticipants: participants,
              videoStatus: bothJoined ? "ACTIVE" : anyJoined ? "WAITING" : "ENDED",
              videoActiveSinceMs: bothJoined && Object.keys(activePresence).length >= 2
                ? Number.isFinite(priorActiveSinceMs) ? priorActiveSinceMs : eventAtMs
                : null,
              updatedAt: FieldValue.serverTimestamp(),
            };
            if (bothJoined && !timestamp(appointment.trustedAgoraRtcStartedAt)) {
              const startedAtMs = Math.max(participants.patient.joinedAtMs, participants.doctor.joinedAtMs);
              patch.trustedAgoraRtcStartedAt = new Date(startedAtMs);
              patch.effectiveConsultationStartedAt = new Date(startedAtMs);
              patch.sessionStatus = "IN_PROGRESS";
              patch.requestedRefundMethod = FieldValue.delete();
              patch.refundRequestStatus = FieldValue.delete();
              patch.refundRequestedAt = FieldValue.delete();
              patch.refundPreferenceAt = FieldValue.delete();
              if (String(appointment.status || "").toUpperCase() === "DOCTOR_ACCEPTED") patch.status = "IN_PROGRESS";
            }
            transaction.set(appointmentRef, patch, { merge: true });
            processingStatus = bothJoined ? "RTC_BOTH_JOINED" : joined ? "RTC_PARTICIPANT_JOINED" : "RTC_PARTICIPANT_LEFT";
            participantRole = role;
          } else {
            processingStatus = "IGNORED_DUPLICATE_OR_OUT_OF_ORDER";
            participantRole = role;
          }
        }
        transaction.create(notificationRef, {
          noticeHash,
          appointmentId: appointmentSnapshot.id,
          channelHash: createHash("sha256").update(channelName).digest("hex").slice(0, 32),
          eventType,
          participantRole,
          processingStatus,
          occurredAt: new Date(eventAtMs),
          receivedAt: FieldValue.serverTimestamp(),
        });
        result = { processed: processingStatus.startsWith("RTC_"), duplicate: false };
      });
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      logger.error("NEXA Agora RTC notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return res.status(500).json({ ok: false, error: "notification-processing-failed" });
    }
  });

  const nexaReconcileTeleconsultationCalls = onSchedule({
    region: REGION,
    schedule: "every 1 minutes",
    timeZone: "America/Port-au-Prince",
    secrets: [AGORA_RTC_NOTIFICATION_SECRET],
  }, async () => {
    for (const status of ["DOCTOR_ACCEPTED", "IN_PROGRESS", "PROVIDER_NO_SHOW_REFUND_REQUIRED"]) {
      const snapshot = await db.collection("appointments").where("status", "==", status).limit(500).get();
      for (const document of snapshot.docs) {
        try {
          if (status !== "PROVIDER_NO_SHOW_REFUND_REQUIRED") {
            await recordTeleconsultationPresence(db, FieldValue, ApiError, {
              appointmentId: document.id,
              uid: null,
              action: "reconcile",
            });
          }
        } catch (error) {
          if (!(error instanceof ApiError && [403, 409].includes(error.status))) {
            logger.warn("NEXA teleconsultation presence reconciliation skipped", {
              errorName: error instanceof Error ? error.name : "unknown-error",
            });
          }
        }
        try {
          await reconcileExpiredTeleconsultationCall(document.id);
        } catch (error) {
          logger.error("NEXA teleconsultation call reconciliation failed", {
            errorName: error instanceof Error ? error.name : "unknown-error",
          });
        }
      }
    }

    const unacceptedAppointments = await db.collection("appointments")
      .where("bookingType", "==", "teleconsultation")
      .where("paymentStatus", "==", "PAID")
      .where("status", "==", "CONFIRMED")
      .orderBy("startsAt", "asc")
      .limit(500)
      .get();
    for (const document of unacceptedAppointments.docs) {
      try {
        await reconcileUnacceptedTeleconsultation(document.id);
      } catch (error) {
        logger.error("NEXA unaccepted teleconsultation reconciliation failed", {
          errorName: error instanceof Error ? error.name : "unknown-error",
        });
      }
    }
  });

  return {
    nexaTeleconsultationPresence,
    nexaPatientTeleconsultationCashRefundPreference,
    nexaAgoraToken,
    nexaVideoSignal,
    nexaAgoraRtcNotification,
    nexaReconcileTeleconsultationCalls,
  };
};
