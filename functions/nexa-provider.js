"use strict";

const { createHash } = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");

const REGION = "us-east4";
const SLOT_MINUTES = 30;
const HOME_VISIT_MINUTES = 60;
const MAX_SLOTS_PER_REQUEST = 30;
const MAX_LOOKAHEAD_DAYS = 90;

function getBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  if (!Buffer.isBuffer(req.rawBody)) return null;
  try {
    const value = JSON.parse(req.rawBody.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function cleanText(value, maximum, fallback = "") {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maximum) : fallback;
}

function profileFor(snapshot) {
  const value = snapshot.get("profile");
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeSlot(document) {
  const item = document.data() || {};
  return {
    id: document.id,
    startsAt: typeof item.startsAt === "string" ? item.startsAt : "",
    endsAt: typeof item.endsAt === "string" ? item.endsAt : "",
    serviceType: item.serviceType === "HOME_VISIT" ? "HOME_VISIT" : "TELECONSULTATION",
    status: ["available", "held", "booked"].includes(String(item.status || "")) ? item.status : "UNKNOWN",
  };
}

function timestamp(value) {
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(String(value || ""));
}

function parseStartsAt(value, now) {
  if (typeof value !== "string" || value.length > 40 || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time) || time < now + 30 * 60_000 || time > now + MAX_LOOKAHEAD_DAYS * 24 * 60 * 60_000) return null;
  if (date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0 || date.getUTCMinutes() % SLOT_MINUTES !== 0) return null;
  return date.toISOString();
}

module.exports = function createNexaProviderFunctions(dependencies) {
  const { db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger, createNexaNotification, appointmentPaymentMatches } = dependencies;

  async function requireVerifiedDoctor(req) {
    const user = await requireUser(req);
    await requireAppCheckToken(req);
    const provider = await db.collection("providerProfiles").doc(user.uid).get();
    if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
      throw new ApiError(403, "verified-doctor-required", "Seuls les médecins NEXA vérifiés peuvent gérer leurs disponibilités.");
    }
    return { user, provider, profile: profileFor(provider) };
  }

  const nexaProviderAvailability = onRequest({ region: REGION }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST", "DELETE"].includes(req.method)) {
      res.set("Allow", "GET, POST, DELETE, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if (req.method !== "GET" && ((Number(req.get("Content-Length")) || 0) > 16_384 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 16_384))) {
      return fail(res, 413, "request-too-large", "La requête dépasse la taille autorisée.");
    }

    try {
      const { user, provider, profile } = await requireVerifiedDoctor(req);
      const rateAction = req.method === "GET" ? "doctor-availability-read" : req.method === "POST" ? "doctor-availability-publish" : "doctor-availability-delete";
      await enforceUserRateLimit(user.uid, rateAction, 30, 5 * 60_000);
      res.set("Cache-Control", "no-store, max-age=0");

      if (req.method === "GET") {
        const now = Date.now();
        const snapshot = await db.collection("providerAvailabilitySlots")
          .where("providerUid", "==", user.uid)
          .where("startsAt", ">=", new Date(now).toISOString())
          .where("startsAt", "<=", new Date(now + MAX_LOOKAHEAD_DAYS * 24 * 60 * 60_000).toISOString())
          .orderBy("startsAt")
          .limit(100)
          .get();
        const tariffs = profile.homeVisitTariffs && typeof profile.homeVisitTariffs === "object" && !Array.isArray(profile.homeVisitTariffs)
          ? Object.values(profile.homeVisitTariffs)
          : [];
        const homeVisitAvailable = profile.homeVisitEnabled === true && tariffs.some((amount) => Number.isSafeInteger(amount) && Number(amount) > 0) &&
          Array.isArray(profile.homeVisitZones) && profile.homeVisitZones.length > 0;
        return res.status(200).json({
          ok: true,
          provider: { name: cleanText(profile.name || profile.displayName, 120, "Médecin NEXA") },
          services: { teleconsultation: true, homeVisit: homeVisitAvailable },
          slots: snapshot.docs.map(safeSlot),
        });
      }

      if (req.method === "POST") {
        const body = getBody(req);
        if (!body || Object.keys(body).some((key) => !["startsAt", "serviceType"].includes(key)) || !Array.isArray(body.startsAt)) {
          throw new ApiError(400, "invalid-availability", "Choisissez une ou plusieurs heures de début valides.");
        }
        const serviceType = body.serviceType === undefined ? "TELECONSULTATION" : body.serviceType;
        if (!["TELECONSULTATION", "HOME_VISIT"].includes(serviceType)) {
          throw new ApiError(400, "invalid-availability-service", "Choisissez téléconsultation ou visite à domicile.");
        }
        if (body.startsAt.length < 1 || body.startsAt.length > MAX_SLOTS_PER_REQUEST) {
          throw new ApiError(400, "invalid-availability-count", "Ajoutez entre 1 et 30 créneaux à la fois.");
        }
        const now = Date.now();
        const starts = body.startsAt.map((value) => parseStartsAt(value, now));
        if (starts.some((value) => !value) || new Set(starts).size !== starts.length) {
          throw new ApiError(400, "invalid-availability-time", "Chaque créneau doit commencer dans au moins 30 minutes, sur une heure ou une demi-heure, et dans les 90 prochains jours.");
        }
        if (serviceType === "HOME_VISIT") {
          const tariffs = profile.homeVisitTariffs && typeof profile.homeVisitTariffs === "object" && !Array.isArray(profile.homeVisitTariffs)
            ? Object.values(profile.homeVisitTariffs)
            : [];
          if (profile.homeVisitEnabled !== true || !tariffs.some((amount) => Number.isSafeInteger(amount) && Number(amount) > 0) ||
            !Array.isArray(profile.homeVisitZones) || profile.homeVisitZones.length < 1) {
            throw new ApiError(409, "home-visit-service-not-configured", "NEXA doit d’abord activer votre tarif et vos zones de visite à domicile.");
          }
        }

        const slots = starts.map((start) => {
          const startMs = Date.parse(start);
          const idSource = serviceType === "HOME_VISIT" ? `${user.uid}:HOME_VISIT:${start}` : `${user.uid}:${start}`;
          const id = createHash("sha256").update(idSource).digest("hex").slice(0, 32);
          return {
            ref: db.collection("providerAvailabilitySlots").doc(id),
            startsAt: start,
            endsAt: new Date(startMs + (serviceType === "HOME_VISIT" ? HOME_VISIT_MINUTES : SLOT_MINUTES) * 60_000).toISOString(),
          };
        });
        const created = await db.runTransaction(async (transaction) => {
          const existing = await Promise.all(slots.map((slot) => transaction.get(slot.ref)));
          let count = 0;
          slots.forEach((slot, index) => {
            if (existing[index].exists) return;
            transaction.create(slot.ref, {
              providerUid: user.uid,
              providerType: "doctor",
              serviceType,
              startsAt: slot.startsAt,
              endsAt: slot.endsAt,
              status: "available",
              appointmentId: null,
              createdAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp(),
            });
            count += 1;
          });
          return count;
        });
        return res.status(200).json({ ok: true, created, duplicates: slots.length - created });
      }

      const body = getBody(req);
      const slotId = typeof body?.slotId === "string" ? body.slotId.trim() : "";
      if (!body || Object.keys(body).some((key) => key !== "slotId") || !/^[a-f0-9]{32}$/.test(slotId)) {
        throw new ApiError(400, "invalid-slot", "Le créneau sélectionné n’est pas valide.");
      }
      const slotRef = db.collection("providerAvailabilitySlots").doc(slotId);
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(slotRef);
        if (!snapshot.exists || snapshot.get("providerUid") !== user.uid) throw new ApiError(404, "slot-not-found", "Créneau introuvable.");
        if (snapshot.get("status") !== "available" || Date.parse(String(snapshot.get("startsAt") || "")) <= Date.now()) {
          throw new ApiError(409, "slot-already-reserved", "Un créneau réservé ou passé ne peut pas être supprimé.");
        }
        transaction.delete(slotRef);
      });
      return res.status(200).json({ ok: true, deleted: true });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA provider availability request failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "availability-unavailable", "Les disponibilités ne sont pas accessibles pour le moment.");
    }
  });

  const nexaProviderAppointments = onRequest({ region: REGION }, async (req, res) => {
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
      const { user } = await requireVerifiedDoctor(req);
      await enforceUserRateLimit(user.uid, req.method === "GET" ? "doctor-appointments-read" : "doctor-appointment-update", 30, 5 * 60_000);
      res.set("Cache-Control", "no-store, max-age=0");

      if (req.method === "GET") {
        const snapshot = await db.collection("appointments")
          .where("providerUid", "==", user.uid)
          .orderBy("startsAt", "desc")
          .limit(100)
          .get();
        const patientRefs = snapshot.docs.map((document) => {
          const patientUid = typeof document.get("patientUid") === "string" ? document.get("patientUid") : "";
          return db.collection("patientProfiles").doc(patientUid || "_missing_patient_");
        });
        const patientSnapshots = patientRefs.length ? await db.getAll(...patientRefs) : [];
        const patientNames = new Map(snapshot.docs.map((document, index) => {
          const patient = patientSnapshots[index];
          const displayName = patient?.exists && patient.get("role") === "patient" && patient.get("profileComplete") === true
            ? cleanText(patient.get("displayName"), 100)
            : "";
          return [document.id, displayName || "Patient NEXA"];
        }));
        const now = Date.now();
        const appointments = snapshot.docs.map((document) => {
          const item = document.data() || {};
          const bookingType = typeof item.bookingType === "string" ? item.bookingType : "legacy";
          const effectiveStart = timestamp(item.effectiveConsultationStartedAt);
          const status = typeof item.status === "string" ? item.status : "UNKNOWN";
          const clinicalAccessActive = item.paymentStatus === "PAID" && Number.isFinite(effectiveStart) && effectiveStart > 0 &&
            now >= effectiveStart && now < effectiveStart + 24 * 60 * 60_000 &&
            (bookingType === "home_visit" ? ["CONFIRMED", "COMPLETED"].includes(status) : ["IN_PROGRESS", "COMPLETED"].includes(status));
          const result = {
            appointmentId: document.id,
            bookingType,
            patientName: patientNames.get(document.id) || "Patient NEXA",
            startsAt: typeof item.startsAt === "string" ? item.startsAt : "",
            endsAt: typeof item.endsAt === "string" ? item.endsAt : "",
            durationMinutes: bookingType === "home_visit" ? HOME_VISIT_MINUTES : 25,
            amount: Number.isSafeInteger(item.amount) && item.amount >= 0 ? item.amount : 0,
            status,
            paymentStatus: typeof item.paymentStatus === "string" ? item.paymentStatus : "UNKNOWN",
            consultationStarted: effectiveStart > 0 || String(item.sessionStatus || "").toUpperCase() === "ACTIVE" || String(item.videoStatus || "").toUpperCase() === "ACTIVE",
            clinicalAccessActive,
            ...(clinicalAccessActive ? { clinicalAccessExpiresAt: new Date(effectiveStart + 24 * 60 * 60_000).toISOString() } : {}),
            ...(typeof item.noShowOutcome === "string" ? { noShowOutcome: item.noShowOutcome } : {}),
            ...(item.noShowReason === "PROVIDER_DID_NOT_ACCEPT" ? { noShowReason: item.noShowReason } : {}),
            ...(typeof item.refundStatus === "string" ? { refundStatus: item.refundStatus } : {}),
            ...(typeof item.refundMethod === "string" ? { refundMethod: item.refundMethod } : {}),
          };
          if (bookingType === "home_visit") {
            const details = item.homeVisitDetails && typeof item.homeVisitDetails === "object" && !Array.isArray(item.homeVisitDetails)
              ? item.homeVisitDetails
              : {};
            Object.assign(result, {
              homeVisitServiceId: cleanText(item.homeVisitServiceId, 64),
              homeVisitDetails: {
                department: cleanText(details.department, 80),
                commune: cleanText(details.commune, 80),
                addressLine: cleanText(details.addressLine, 220),
                contactPhone: cleanText(details.contactPhone, 24),
              },
              homeVisitMissionStatus: cleanText(item.homeVisitMissionStatus, 60) || "UNKNOWN",
            });
          }
          return result;
        });
        return res.status(200).json({ ok: true, appointments });
      }

      const body = getBody(req);
      const appointmentId = typeof body?.appointmentId === "string" ? body.appointmentId.trim() : "";
      const action = typeof body?.action === "string" ? body.action : "";
      if (!body || Object.keys(body).some((key) => !["appointmentId", "action"].includes(key)) || !/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) {
        throw new ApiError(400, "invalid-appointment-action", "Le rendez-vous ou l’action n’est pas valide.");
      }
      if (!["accept", "complete", "refuse"].includes(action)) {
        const code = ["cancel", "start"].includes(action) ? "appointment-action-not-available" : "invalid-appointment-action";
        throw new ApiError(code === "appointment-action-not-available" ? 409 : 400, code, "Cette action n’est pas disponible dans le portail médecin statique.");
      }

      const appointmentRef = db.collection("appointments").doc(appointmentId);
      const auditRef = db.collection("adminAuditLogs").doc();
      let patientUid = "";
      let status = "";
      let refundedAmount = 0;
      let alreadyProcessed = false;
      await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(appointmentRef);
        if (!snapshot.exists || snapshot.get("providerUid") !== user.uid || snapshot.get("providerType") !== "doctor") {
          throw new ApiError(404, "appointment-not-found", "Ce rendez-vous n’est pas accessible.");
        }
        const appointment = snapshot.data() || {};
        patientUid = typeof appointment.patientUid === "string" ? appointment.patientUid : "";
        if (!["teleconsultation", "doctor_proposed_appointment"].includes(String(appointment.bookingType || ""))) {
          throw new ApiError(409, "appointment-type-not-supported", "Cette action s’applique uniquement aux téléconsultations.");
        }
        if (action !== "refuse" && appointment.paymentStatus !== "PAID") {
          throw new ApiError(409, "appointment-not-paid", "Le paiement confirmé est requis avant de gérer ce rendez-vous.");
        }
        if (action === "refuse") {
          if (appointment.bookingType !== "teleconsultation") {
            throw new ApiError(409, "appointment-refusal-not-allowed", "Seule une téléconsultation demandée par le patient peut être refusée par le médecin.");
          }
          patientUid = typeof appointment.patientUid === "string" ? appointment.patientUid : "";
          const paymentRef = typeof appointment.moncashPaymentRef === "string" ? appointment.moncashPaymentRef : "";
          const amount = Number(appointment.amount);
          const amountMinor = amount * 100;
          const transactionFee = Number(appointment.transactionFee ?? 0);
          const ledgerId = createHash("sha256").update(`NEXA_WALLET_REFUND:appointment:${appointmentId}`).digest("hex");
          const refundId = createHash("sha256").update(`NEXA_REFUND:appointment:${appointmentId}`).digest("hex");
          const walletRef = db.collection("nexaPatientWallets").doc(patientUid || "_missing_patient_");
          const profileRef = db.collection("patientProfiles").doc(patientUid || "_missing_patient_");
          const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef || "_missing_payment_");
          const feeLedgerRef = db.collection("nexaTransactionFeeLedger").doc(paymentRef || "_missing_payment_");
          const ledgerRef = db.collection("nexaWalletLedger").doc(ledgerId);
          const refundRef = db.collection("nexaRefundLedger").doc(refundId);
          const alertsQuery = db.collection("paymentSettlementAlerts").where("resourceId", "==", appointmentId).limit(100);
          const [profileSnapshot, paymentSnapshot, walletSnapshot, feeLedgerSnapshot, ledgerSnapshot, refundSnapshot, alertsSnapshot] = await Promise.all([
            transaction.get(profileRef), transaction.get(paymentRefDoc), transaction.get(walletRef), transaction.get(feeLedgerRef),
            transaction.get(ledgerRef), transaction.get(refundRef), transaction.get(alertsQuery),
          ]);
          const alerts = alertsSnapshot.docs.filter((item) => item.get("resourceType") === "appointment");
          if (alerts.some((item) => ["manual_refund_confirmed", "manual_cash_refund_confirmed", "manual_moncash_refund_confirmed"].includes(String(item.get("resolution") || "")))) {
            throw new ApiError(409, "external-refund-already-recorded", "Un remboursement externe est déjà enregistré pour ce rendez-vous.");
          }
          if (!patientUid || !/^[A-Za-z0-9_-]{20,64}$/.test(paymentRef) || !Number.isSafeInteger(amount) || amount <= 0 ||
            amount > 10_000_000 || !Number.isSafeInteger(amountMinor) || !Number.isSafeInteger(transactionFee) || transactionFee < 0 ||
            typeof appointmentPaymentMatches !== "function") {
            throw new ApiError(409, "appointment-refund-source-invalid", "Le prix du service ou la référence du paiement ne permet pas ce remboursement.");
          }
          if (ledgerSnapshot.exists !== refundSnapshot.exists) {
            throw new ApiError(409, "refund-ledger-conflict", "Les registres du remboursement et du portefeuille ne concordent pas.");
          }
          if (ledgerSnapshot.exists) {
            const ledger = ledgerSnapshot.data() || {};
            const refund = refundSnapshot.data() || {};
            const completed = appointment.status === "PROVIDER_REFUSED" && appointment.paymentStatus === "REFUNDED" &&
              appointment.refundStatus === "COMPLETED" && appointment.refundMethod === "NEXA_WALLET";
            if (!completed || ledger.userUid !== patientUid || ledger.resourceType !== "appointment" || ledger.resourceId !== appointmentId ||
              ledger.direction !== "CREDIT" || ledger.type !== "REFUND" || ledger.status !== "COMPLETED" || ledger.currency !== "HTG" ||
              ledger.paymentRef !== paymentRef || Number(ledger.amountMinor) !== amountMinor || refund.userUid !== patientUid ||
              refund.resourceType !== "appointment" || refund.resourceId !== appointmentId || refund.paymentRef !== paymentRef ||
              refund.currency !== "HTG" || refund.status !== "COMPLETED" || refund.refundMethod !== "NEXA_WALLET" ||
              Number(refund.amountMinor) !== amountMinor || refund.walletLedgerId !== ledgerId) {
              throw new ApiError(409, "refund-ledger-conflict", "Le registre contient une référence de remboursement incompatible.");
            }
            status = "PROVIDER_REFUSED";
            refundedAmount = amount;
            alreadyProcessed = true;
            return;
          }
          if (appointment.status !== "CONFIRMED") {
            throw new ApiError(409, "appointment-transition-invalid", "Seule une téléconsultation payée et confirmée peut être refusée.");
          }
          if (appointment.paymentStatus !== "PAID") {
            throw new ApiError(409, "appointment-not-paid", "Le paiement confirmé est requis avant de refuser cette téléconsultation.");
          }
          const payment = paymentSnapshot.data() || {};
          if (!profileSnapshot.exists || profileSnapshot.get("role") !== "patient" || !paymentSnapshot.exists || payment.status !== "paid" ||
            !["MONCASH", "NEXA_WALLET"].includes(String(payment.paymentMethod || "")) || payment.resourceType !== "appointment" ||
            payment.resourcePath !== `appointments/${appointmentId}` || payment.uid !== patientUid ||
            String(payment.currency || "").toUpperCase() !== "HTG" || String(appointment.currency || "").toUpperCase() !== "HTG" ||
            !appointmentPaymentMatches(appointment, payment)) {
            throw new ApiError(409, "appointment-refund-payment-mismatch", "Le paiement ne correspond pas au prix du service à rembourser.");
          }
          const feeLedger = feeLedgerSnapshot.data() || {};
          const feeLedgerMatches = transactionFee === 0
            ? !feeLedgerSnapshot.exists
            : feeLedgerSnapshot.exists && feeLedger.paymentRef === paymentRef && feeLedger.resourceType === "appointment" &&
              feeLedger.resourceId === appointmentId && Number(feeLedger.serviceAmountMinor) === amountMinor &&
              Number(feeLedger.amountMinor) === transactionFee * 100 && feeLedger.currency === "HTG" &&
              feeLedger.recipient === "NEXARIS" && feeLedger.paymentMethod === payment.paymentMethod && feeLedger.status === "COMPLETED";
          if (!feeLedgerMatches) {
            throw new ApiError(409, "transaction-fee-ledger-mismatch", "Le registre des frais NEXARIS ne correspond pas à ce paiement.");
          }
          const wallet = walletSnapshot.data() || {};
          const availableMinor = wallet.availableMinor === undefined ? 0 : Number(wallet.availableMinor);
          const reservedMinor = wallet.reservedMinor === undefined ? 0 : Number(wallet.reservedMinor);
          if (!Number.isSafeInteger(availableMinor) || availableMinor < 0 || !Number.isSafeInteger(reservedMinor) || reservedMinor < 0 ||
            !Number.isSafeInteger(availableMinor + amountMinor) || (wallet.currency && wallet.currency !== "HTG") || (wallet.status && wallet.status !== "ACTIVE")) {
            throw new ApiError(409, "wallet-state-invalid", "Le portefeuille NEXA ne peut pas recevoir ce remboursement actuellement.");
          }
          const now = FieldValue.serverTimestamp();
          transaction.set(walletRef, {
            userUid: patientUid, currency: "HTG", availableMinor: availableMinor + amountMinor,
            reservedMinor, status: wallet.status || "ACTIVE", updatedAt: now,
          }, { merge: true });
          transaction.create(ledgerRef, {
            userUid: patientUid, walletId: patientUid, type: "REFUND", direction: "CREDIT", amountMinor,
            currency: "HTG", resourceType: "appointment", resourceId: appointmentId, paymentRef,
            reason: "teleconsultation-provider-refusal", source: "NEXA_PROVIDER_REFUSAL", status: "COMPLETED",
            createdAt: now, createdByUid: user.uid,
          });
          transaction.create(refundRef, {
            userUid: patientUid, resourceType: "appointment", resourceId: appointmentId, paymentRef,
            amountMinor, currency: "HTG", refundMethod: "NEXA_WALLET", serviceAmountMinor: amountMinor,
            ...(transactionFee > 0 ? { nonRefundableTransactionFeeMinor: transactionFee * 100 } : {}),
            walletLedgerId: ledgerId, status: "COMPLETED", createdAt: now, createdByUid: user.uid,
          });
          transaction.set(appointmentRef, {
            status: "PROVIDER_REFUSED", paymentStatus: "REFUNDED", refundRequired: false, refundStatus: "COMPLETED",
            refundMethod: "NEXA_WALLET", refundedAmount: amount, refundedAmountMinor: amountMinor,
            ...(transactionFee > 0 ? { nonRefundableTransactionFee: transactionFee } : {}),
            refundedAt: now, refundedByUid: user.uid, refundLedgerId: refundId, walletLedgerId: ledgerId, updatedAt: now,
          }, { merge: true });
          transaction.create(auditRef, {
            actorUid: user.uid, action: "teleconsultation_provider_refused_wallet_refund",
            resource: `appointments/${appointmentId}`, amountMinor, currency: "HTG", createdAt: now,
          });
          status = "PROVIDER_REFUSED";
          refundedAmount = amount;
          return;
        }
        if (action === "accept") {
          if (appointment.status === "DOCTOR_ACCEPTED" || appointment.status === "IN_PROGRESS") {
            status = appointment.status;
            return;
          }
          if (appointment.status !== "CONFIRMED") {
            throw new ApiError(409, "appointment-transition-invalid", "Seul un rendez-vous payé et confirmé peut être accepté.");
          }
          if (appointment.bookingType === "teleconsultation") {
            const startsAtMs = timestamp(appointment.startsAt);
            if (!Number.isFinite(startsAtMs) || startsAtMs <= 0) {
              throw new ApiError(409, "appointment-start-time-invalid", "L’heure de début de ce rendez-vous est invalide.");
            }
            if (Date.now() >= startsAtMs) {
              throw new ApiError(409, "appointment-acceptance-window-expired", "Le délai d’acceptation est dépassé. Ce rendez-vous doit être traité comme une absence par NEXA.");
            }
          }
          status = "DOCTOR_ACCEPTED";
          transaction.set(appointmentRef, {
            status,
            acceptedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          transaction.create(auditRef, {
            actorUid: user.uid,
            action: "appointment_accept",
            resource: `appointments/${appointmentId}`,
            createdAt: FieldValue.serverTimestamp(),
          });
          return;
        }

        if (appointment.status === "COMPLETED") { status = "COMPLETED"; return; }
        if (appointment.status !== "IN_PROGRESS" || !appointment.effectiveConsultationStartedAt) {
          throw new ApiError(409, "appointment-transition-invalid", "La séance ne peut être terminée qu’après la connexion des deux participants.");
        }
        status = "COMPLETED";
        transaction.set(appointmentRef, {
          status,
          sessionStatus: "TERMINATED",
          videoStatus: "ENDED",
          videoParticipants: {},
          videoActiveSinceMs: null,
          sessionEndedAt: FieldValue.serverTimestamp(),
          interactiveEndsAt: new Date().toISOString(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.create(auditRef, {
          actorUid: user.uid,
          action: "appointment_complete",
          resource: `appointments/${appointmentId}`,
          createdAt: FieldValue.serverTimestamp(),
        });
      });

      if (patientUid && typeof createNexaNotification === "function") {
        try {
          const notification = action === "refuse"
            ? { type: "wallet_refund_credited", title: "Téléconsultation refusée · remboursement crédité", body: `${new Intl.NumberFormat("fr-HT").format(refundedAmount)} HTG correspondant au prix du service ont été crédités dans votre Wallet NEXA. Les frais de transaction ne sont pas remboursés.` }
            : action === "accept"
              ? { type: "appointment_accepted", title: "Rendez-vous accepté", body: "Votre médecin a accepté le rendez-vous. Rejoignez la séance à l’heure prévue." }
              : { type: "appointment_completed", title: "Séance terminée", body: "Votre séance est terminée. Consultez l’état de votre dossier dans votre espace NEXA." };
          if (!(action === "refuse" && alreadyProcessed)) {
            await createNexaNotification(patientUid, `appointment:${appointmentId}:${action}`, {
              ...notification,
              url: "/espace-patient.html",
            }, appointmentId);
          }
        } catch (error) {
          logger.warn("NEXA provider appointment notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
        }
      }
      return res.status(200).json({ ok: true, appointmentId, status, ...(action === "refuse" ? { refundedAmount, currency: "HTG", alreadyProcessed } : {}) });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA provider appointments request failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "provider-appointments-unavailable", "Les rendez-vous ne sont pas accessibles pour le moment.");
    }
  });

  return { nexaProviderAvailability, nexaProviderAppointments };
};
