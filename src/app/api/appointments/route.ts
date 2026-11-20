import { randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { appointmentPaymentMatches, calculateTransactionAmounts, getTransactionFeePolicy } from "@/lib/payments/transaction-fees.server";
import { normalizeTeleconsultationSharePolicy, TELECONSULTATION_SHARE_SETTINGS_PATH } from "@/lib/payments/teleconsultation-share.server";
import { getTeleconsultationDurationMinutes, NEXA_TELECONSULTATION_DURATION_MINUTES } from "@/lib/teleconsultation/policy";
import { HOME_VISIT_SERVICES } from "@/lib/home-visits";

const HOLD_MINUTES = 20;
const PAYMENT_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
const MAX_PAYMENT_AMOUNT_HTG = 10_000_000;
const HOME_VISIT_DURATION_MINUTES = 60;
const HOME_VISIT_MIN_GAP_MINUTES = 120;
const HOME_VISIT_DAILY_LIMIT = 5;
const ACTIVE_HOME_VISIT_STATUSES = new Set(["PENDING_PAYMENT", "CONFIRMED", "DOCTOR_ACCEPTED", "IN_PROGRESS", "MISSION_AWAITING_PATIENT", "MISSION_AWAITING_PROVIDER"]);

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function normalizePlace(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr-HT").trim();
}

function haitiDayRange(value: number): { start: string; end: string } {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Port-au-Prince", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const nextDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1));
  const nextDay = `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, "0")}-${String(nextDate.getUTCDate()).padStart(2, "0")}`;
  const localMidnightUtc = (dateText: string) => {
    const [year, month, date] = dateText.split("-").map(Number);
    const target = Date.UTC(year, month - 1, date);
    const local = Object.fromEntries(formatter.formatToParts(new Date(target)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), Number(local.hour), Number(local.minute), Number(local.second));
    return new Date(target - (represented - target)).toISOString();
  };
  return { start: localMidnightUtc(day), end: localMidnightUtc(nextDay) };
}

function response(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "appointment-booking-failed";
  const message = error instanceof ApiRequestError ? error.message : "Le rendez-vous ne peut pas être réservé pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA appointment booking failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    const snapshot = await getFirebaseAdminDb().collection("appointments")
      .where("patientUid", "==", user.uid)
      .orderBy("startsAt", "desc")
      .limit(100)
      .get();
    const appointments = snapshot.docs.filter((doc) => !(doc.get("dismissedByPatient") === true && doc.get("status") === "PAYMENT_EXPIRED" && doc.get("paymentStatus") === "EXPIRED")).map((doc) => {
      const item = doc.data();
      const holdExpiresAt = typeof item.holdExpiresAt === "number" ? item.holdExpiresAt : null;
      const pendingPayment = item.status === "PENDING_PAYMENT" && item.paymentStatus === "PENDING" &&
        typeof item.moncashPaymentRef === "string" && (!holdExpiresAt || holdExpiresAt > Date.now());
      const holdExpired = item.status === "PENDING_PAYMENT" && item.paymentStatus === "PENDING" && Boolean(holdExpiresAt && holdExpiresAt <= Date.now());
      return {
        appointmentId: doc.id,
        ...(typeof item.bookingType === "string" ? { bookingType: item.bookingType } : {}),
        providerUid: typeof item.providerUid === "string" ? item.providerUid : "",
        providerName: typeof item.providerName === "string" ? item.providerName.slice(0, 120) : "Professionnel NEXA",
        startsAt: typeof item.startsAt === "string" ? item.startsAt : "",
        endsAt: typeof item.endsAt === "string" ? item.endsAt : "",
        durationMinutes: item.bookingType === "home_visit" ? HOME_VISIT_DURATION_MINUTES : getTeleconsultationDurationMinutes(item),
        ...(item.bookingType === "home_visit" && item.homeVisitDetails && typeof item.homeVisitDetails === "object" ? {
          homeVisitServiceId: typeof item.homeVisitServiceId === "string" ? item.homeVisitServiceId.slice(0, 64) : "",
          homeVisitDetails: {
            department: cleanText((item.homeVisitDetails as Record<string, unknown>).department, 80),
            commune: cleanText((item.homeVisitDetails as Record<string, unknown>).commune, 80),
            addressLine: cleanText((item.homeVisitDetails as Record<string, unknown>).addressLine, 220),
            contactPhone: cleanText((item.homeVisitDetails as Record<string, unknown>).contactPhone, 24),
          },
          homeVisitMissionStatus: typeof item.homeVisitMissionStatus === "string" ? item.homeVisitMissionStatus : "UNKNOWN",
          ...(item.paymentStatus === "PAID" && item.status === "CONFIRMED" && ["SCHEDULED", "AWAITING_PROVIDER_CODE"].includes(String(item.homeVisitMissionStatus || "")) && typeof item.homeVisitMissionCode === "string" ? { homeVisitMissionCode: item.homeVisitMissionCode.slice(0, 8) } : {}),
        } : {}),
        amount: Number.isSafeInteger(item.amount) ? item.amount : 0,
        currency: "HTG",
        status: holdExpired ? "PAYMENT_EXPIRED" : typeof item.status === "string" ? item.status : "UNKNOWN",
        paymentStatus: holdExpired ? "EXPIRED" : typeof item.paymentStatus === "string" ? item.paymentStatus : "UNKNOWN",
        ...(typeof item.refundMethod === "string" ? { refundMethod: item.refundMethod } : {}),
        ...(typeof item.requestedRefundMethod === "string" ? { requestedRefundMethod: item.requestedRefundMethod } : {}),
        ...(typeof item.refundStatus === "string" ? { refundStatus: item.refundStatus } : {}),
        ...(typeof item.noShowOutcome === "string" ? { noShowOutcome: item.noShowOutcome } : {}),
        refundRequired: item.refundRequired === true,
        ...(pendingPayment ? { paymentRef: item.moncashPaymentRef as string } : {}),
      };
    });
    return response(request, { ok: true, appointments });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "book-appointment", limit: 8, windowMs: 5 * 60_000 });
    const body = await request.json().catch(() => null);
    const slotId = body && typeof body === "object" && !Array.isArray(body) && typeof body.slotId === "string"
      ? body.slotId.trim()
      : "";
    if (!/^[a-f0-9]{32}$/.test(slotId)) throw new ApiRequestError(400, "invalid-slot", "Choisissez un créneau disponible.");
    const requestedBookingType = body && typeof body === "object" && !Array.isArray(body) && typeof body.bookingType === "string"
      ? body.bookingType
      : "teleconsultation";
    const isHomeVisit = requestedBookingType === "home_visit";
    if (!isHomeVisit && requestedBookingType !== "teleconsultation") throw new ApiRequestError(400, "invalid-booking-type", "Choisissez un type de rendez-vous valide.");
    const homeVisitServiceId = body && typeof body === "object" && !Array.isArray(body) && typeof body.homeVisitServiceId === "string"
      ? body.homeVisitServiceId
      : "";
    if (isHomeVisit && !HOME_VISIT_SERVICES.some((service) => service.id === homeVisitServiceId)) throw new ApiRequestError(400, "invalid-home-visit-service", "Choisissez le type de soin à domicile.");
    const proposalId = body && typeof body === "object" && !Array.isArray(body) && typeof body.proposalId === "string"
      ? body.proposalId.trim()
      : "";
    if (proposalId && !/^[a-f0-9]{32}$/.test(proposalId)) throw new ApiRequestError(400, "invalid-follow-up-proposal", "La proposition du médecin n’est pas valide.");
    if (isHomeVisit && proposalId) throw new ApiRequestError(400, "home-visit-proposal-invalid", "Un rendez-vous proposé par un médecin ne peut pas être réservé comme visite à domicile.");
    const rawVisitDetails = body && typeof body === "object" && !Array.isArray(body) && body.homeVisitDetails && typeof body.homeVisitDetails === "object" && !Array.isArray(body.homeVisitDetails)
      ? body.homeVisitDetails as Record<string, unknown>
      : {};
    const homeVisitDetails = isHomeVisit ? {
      department: cleanText(rawVisitDetails.department, 80),
      commune: cleanText(rawVisitDetails.commune, 80),
      addressLine: cleanText(rawVisitDetails.addressLine, 220),
      contactPhone: cleanText(rawVisitDetails.contactPhone, 24),
    } : null;
    if (isHomeVisit && (!homeVisitDetails?.department || !homeVisitDetails.commune || !homeVisitDetails.addressLine || !/^\+?[0-9\s().-]{7,24}$/.test(homeVisitDetails.contactPhone))) {
      throw new ApiRequestError(400, "invalid-home-visit-details", "Renseignez l’adresse complète et un numéro de téléphone valide pour la visite.");
    }

    const db = getFirebaseAdminDb();
    const slotRef = db.collection("providerAvailabilitySlots").doc(slotId);
    const proposalRef = proposalId ? db.collection("followUpProposals").doc(proposalId) : null;
    const slotPreview = await slotRef.get();
    if (!slotPreview.exists) throw new ApiRequestError(404, "slot-not-found", "Ce créneau n’est plus disponible.");
    const providerUid = String(slotPreview.get("providerUid") || "");
    if (!providerUid || providerUid === user.uid) throw new ApiRequestError(409, "invalid-provider", "Ce rendez-vous ne peut pas être réservé.");

    const patientRef = db.collection("patientProfiles").doc(user.uid);
    const providerRef = db.collection("providerProfiles").doc(providerUid);
    const shareSettingsRef = db.doc(TELECONSULTATION_SHARE_SETTINGS_PATH);
    const patientSnapshot = await patientRef.get();
    const providerSnapshot = await providerRef.get();
    const patient = patientSnapshot.data() || {};
    const provider = providerSnapshot.data() || {};
    const profile = provider.profile && typeof provider.profile === "object" ? provider.profile as Record<string, unknown> : {};
    if (!patientSnapshot.exists || patient.role !== "patient" || patient.profileComplete !== true || typeof patient.patientNumber !== "string") {
      throw new ApiRequestError(403, "complete-patient-profile-required", "Terminez votre inscription patient avant de réserver un rendez-vous.");
    }
    if (!providerSnapshot.exists || provider.status !== "verified" || provider.type !== "doctor" || provider.publiclyListed !== true || provider.clinicalCredentialsVerified !== true) {
      throw new ApiRequestError(409, "provider-unavailable", "Ce médecin n’est plus disponible sur NEXA.");
    }
    const tariffs = profile.homeVisitTariffs && typeof profile.homeVisitTariffs === "object" && !Array.isArray(profile.homeVisitTariffs)
      ? profile.homeVisitTariffs as Record<string, unknown>
      : {};
    const homeVisitFee = Number(tariffs[homeVisitServiceId]);
    const homeVisitZones = Array.isArray(profile.homeVisitZones) ? profile.homeVisitZones as Array<Record<string, unknown>> : [];
      if (isHomeVisit && (profile.homeVisitEnabled !== true || !Number.isSafeInteger(homeVisitFee) || homeVisitFee <= 0 || !homeVisitZones.some((zone) => zone && typeof zone === "object" &&
      normalizePlace(cleanText(zone.commune, 80)) === normalizePlace(homeVisitDetails!.commune) && normalizePlace(cleanText(zone.department, 80)) === normalizePlace(homeVisitDetails!.department),
    ))) {
      throw new ApiRequestError(409, "home-visit-service-unavailable", "Ce médecin ne propose pas de visites dans cette commune. Choisissez un autre professionnel ou une autre zone.");
    }
    const amount = isHomeVisit ? homeVisitFee : profile.indicativeFee;
    if (!Number.isSafeInteger(amount) || Number(amount) <= 0 || Number(amount) > MAX_PAYMENT_AMOUNT_HTG) {
      throw new ApiRequestError(409, "provider-fee-unavailable", "Le tarif du service n’est pas encore configuré. Contactez NEXA avant de réserver.");
    }
    const feePolicy = await getTransactionFeePolicy(isHomeVisit ? "home_visit" : "teleconsultation");
    const paymentAmounts = calculateTransactionAmounts(Number(amount), feePolicy);
    if (!Number.isSafeInteger(paymentAmounts.totalAmount) || paymentAmounts.totalAmount <= 0 || paymentAmounts.totalAmount > MAX_PAYMENT_AMOUNT_HTG) {
      throw new ApiRequestError(409, "appointment-total-invalid", "Le total du rendez-vous dépasse le montant autorisé.");
    }

    const appointmentRef = db.collection("appointments").doc();
    const paymentRef = randomBytes(24).toString("base64url");
    if (!PAYMENT_REFERENCE_PATTERN.test(paymentRef)) throw new ApiRequestError(500, "payment-reference-failed", "Le paiement ne peut pas être préparé.");
    const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
    const holdExpiresAt = Date.now() + HOLD_MINUTES * 60_000;
    const outcome = await db.runTransaction(async (transaction) => {
      const [freshPatient, freshProvider, slotSnapshot, shareSettingsSnapshot] = await Promise.all([
        transaction.get(patientRef),
        transaction.get(providerRef),
        transaction.get(slotRef),
        transaction.get(shareSettingsRef),
      ]);
      if (!freshPatient.exists || freshPatient.get("profileComplete") !== true || freshPatient.get("role") !== "patient") {
        throw new ApiRequestError(403, "complete-patient-profile-required", "Terminez votre inscription patient avant de réserver un rendez-vous.");
      }
      if (!freshProvider.exists || freshProvider.get("status") !== "verified" || freshProvider.get("type") !== "doctor" || freshProvider.get("publiclyListed") !== true || freshProvider.get("clinicalCredentialsVerified") !== true) {
        throw new ApiRequestError(409, "provider-unavailable", "Ce médecin n’est plus disponible sur NEXA.");
      }
      if (!slotSnapshot.exists || slotSnapshot.get("providerUid") !== providerUid) {
        throw new ApiRequestError(404, "slot-not-found", "Ce créneau n’est plus disponible.");
      }
      let proposalSnapshot: FirebaseFirestore.DocumentSnapshot | null = null;
      if (proposalRef) {
        proposalSnapshot = await transaction.get(proposalRef);
        if (
          !proposalSnapshot.exists || proposalSnapshot.get("status") !== "PENDING" ||
          proposalSnapshot.get("patientUid") !== user.uid || proposalSnapshot.get("providerUid") !== providerUid ||
          proposalSnapshot.get("slotId") !== slotId
        ) throw new ApiRequestError(409, "follow-up-proposal-unavailable", "Cette proposition n’est plus disponible pour ce créneau.");
      }
      const slot = slotSnapshot.data() || {};
      const startsAt = Date.parse(String(slot.startsAt || ""));
      const endsAt = Date.parse(String(slot.endsAt || ""));
      const expectedDuration = isHomeVisit ? HOME_VISIT_DURATION_MINUTES : 30;
      const slotServiceType = String(slot.serviceType || "TELECONSULTATION");
      if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || startsAt <= Date.now() || endsAt - startsAt !== expectedDuration * 60_000 || slotServiceType !== (isHomeVisit ? "HOME_VISIT" : "TELECONSULTATION")) {
        throw new ApiRequestError(409, "slot-invalid", "Les horaires de ce créneau ne sont plus valides.");
      }
      if (isHomeVisit) {
        const currentProviderProfile = freshProvider.get("profile") && typeof freshProvider.get("profile") === "object"
          ? freshProvider.get("profile") as Record<string, unknown>
          : {};
        const currentZones = Array.isArray(currentProviderProfile.homeVisitZones) ? currentProviderProfile.homeVisitZones as Array<Record<string, unknown>> : [];
        const currentTariffs = currentProviderProfile.homeVisitTariffs && typeof currentProviderProfile.homeVisitTariffs === "object" && !Array.isArray(currentProviderProfile.homeVisitTariffs)
          ? currentProviderProfile.homeVisitTariffs as Record<string, unknown>
          : {};
        if (currentProviderProfile.homeVisitEnabled !== true || currentTariffs[homeVisitServiceId] !== amount || !currentZones.some((zone) => zone && typeof zone === "object" &&
          normalizePlace(cleanText(zone.commune, 80)) === normalizePlace(homeVisitDetails!.commune) && normalizePlace(cleanText(zone.department, 80)) === normalizePlace(homeVisitDetails!.department),
        )) throw new ApiRequestError(409, "home-visit-settings-changed", "Les paramètres de visite de ce médecin ont changé. Actualisez la page.");

        const dayRange = haitiDayRange(startsAt);
        const dayVisits = await transaction.get(db.collection("appointments")
          .where("providerUid", "==", providerUid)
          .where("bookingType", "==", "home_visit")
          .where("startsAt", ">=", dayRange.start)
          .where("startsAt", "<", dayRange.end)
          .limit(100));
        if (dayVisits.size >= 100) throw new ApiRequestError(409, "home-visit-daily-limit", "La disponibilité de ce médecin doit être vérifiée par NEXA avant une nouvelle réservation.");
        const ownPendingAppointmentId = slot.status === "held" && slot.patientUid === user.uid && typeof slot.appointmentId === "string" ? slot.appointmentId : "";
        const existingVisits = dayVisits.docs.filter((document) => document.id !== ownPendingAppointmentId).map((document) => document.data()).filter((item) => {
          if (item.bookingType !== "home_visit" || !ACTIVE_HOME_VISIT_STATUSES.has(String(item.status || ""))) return false;
          return !(item.status === "PENDING_PAYMENT" && Number(item.holdExpiresAt) <= Date.now());
        });
        if (existingVisits.length >= HOME_VISIT_DAILY_LIMIT) throw new ApiRequestError(409, "home-visit-daily-limit", "Ce médecin a déjà atteint cinq visites à domicile ce jour-là. Choisissez un autre créneau.");
        const minGapMs = HOME_VISIT_MIN_GAP_MINUTES * 60_000;
        if (existingVisits.some((item) => {
          const priorStart = Date.parse(String(item.startsAt || ""));
          const priorEnd = Date.parse(String(item.endsAt || ""));
          return Number.isFinite(priorStart) && Number.isFinite(priorEnd) && startsAt < priorEnd + minGapMs && startsAt + expectedDuration * 60_000 + minGapMs > priorStart;
        })) throw new ApiRequestError(409, "home-visit-spacing-conflict", "Un intervalle d’au moins deux heures entre les visites est requis. Choisissez un autre créneau.");
      }
      const isExpiredHold = slot.status === "held" && Number(slot.holdExpiresAt) <= Date.now();
      if (slot.status === "held" && !isExpiredHold && slot.patientUid === user.uid && typeof slot.appointmentId === "string") {
        const priorAppointmentRef = db.collection("appointments").doc(slot.appointmentId);
        const priorAppointmentSnapshot = await transaction.get(priorAppointmentRef);
        const priorAppointment = priorAppointmentSnapshot.data() || {};
        const priorPaymentRef = typeof priorAppointment.moncashPaymentRef === "string" ? priorAppointment.moncashPaymentRef : "";
        if (
          priorAppointmentSnapshot.exists && priorAppointment.patientUid === user.uid &&
          (proposalId ? priorAppointment.followUpProposalId === proposalId : isHomeVisit ? priorAppointment.bookingType === "home_visit" : priorAppointment.bookingType !== "doctor_proposed_appointment") &&
          priorAppointment.status === "PENDING_PAYMENT" && priorAppointment.paymentStatus === "PENDING" &&
          PAYMENT_REFERENCE_PATTERN.test(priorPaymentRef)
        ) {
          const priorIntentSnapshot = await transaction.get(db.collection("paymentIntents").doc(priorPaymentRef));
          if (
            priorIntentSnapshot.exists && priorIntentSnapshot.get("uid") === user.uid &&
            priorIntentSnapshot.get("resourcePath") === priorAppointmentRef.path &&
            appointmentPaymentMatches(priorAppointment, priorIntentSnapshot.data() || {}) &&
            priorIntentSnapshot.get("currency") === "HTG" && priorIntentSnapshot.get("paymentMethod") === "MONCASH"
          ) {
            return {
              appointmentId: priorAppointmentRef.id,
              paymentRef: priorPaymentRef,
              amount: Number(priorAppointment.amount),
              durationMinutes: isHomeVisit ? HOME_VISIT_DURATION_MINUTES : getTeleconsultationDurationMinutes(priorAppointment),
              transactionFee: Number(priorAppointment.transactionFee) || 0,
              totalAmount: Number(priorAppointment.totalAmount) || Number(priorAppointment.amount),
              feeRateBps: Number(priorAppointment.transactionFeeRateBps) || 0,
              holdExpiresAt: Number(slot.holdExpiresAt),
              reused: true,
            };
          }
        }
        throw new ApiRequestError(409, "slot-unavailable", "La réservation temporaire ne peut pas être reprise. Actualisez vos rendez-vous.");
      }
      if (slot.status !== "available" && !isExpiredHold) {
        throw new ApiRequestError(409, "slot-unavailable", "Ce créneau vient d’être réservé par une autre personne.");
      }

      if (isExpiredHold && typeof slot.appointmentId === "string") {
        const expiredAppointmentRef = db.collection("appointments").doc(slot.appointmentId);
        const expiredAppointmentSnapshot = await transaction.get(expiredAppointmentRef);
        if (expiredAppointmentSnapshot.exists) {
          transaction.set(expiredAppointmentRef, {
            status: "PAYMENT_EXPIRED",
            paymentStatus: "EXPIRED",
            requiresNewSlot: true,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }
      }
      const freshProfile = freshProvider.get("profile") && typeof freshProvider.get("profile") === "object"
        ? freshProvider.get("profile") as Record<string, unknown>
        : {};
      const configuredSharePolicy = isHomeVisit ? null : normalizeTeleconsultationSharePolicy(shareSettingsSnapshot.data());
      const sharePolicy = configuredSharePolicy ? { ...configuredSharePolicy, basisConfirmed: false as const } : null;
      if ((isHomeVisit ? freshProfile.homeVisitFeeHTG : freshProfile.indicativeFee) !== amount) {
        throw new ApiRequestError(409, "provider-fee-changed", "Le tarif du service vient de changer. Actualisez la page.");
      }
      transaction.set(slotRef, {
        status: "held",
        patientUid: user.uid,
        appointmentId: appointmentRef.id,
        holdExpiresAt,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.create(appointmentRef, {
        patientUid: user.uid,
        providerUid,
        providerName: typeof profile.name === "string" ? profile.name : null,
        providerType: "doctor",
        bookingType: isHomeVisit ? "home_visit" : proposalId ? "doctor_proposed_appointment" : "teleconsultation",
        ...(proposalId ? { followUpProposalId: proposalId } : {}),
        ...(isHomeVisit ? { homeVisitServiceId, homeVisitDetails, homeVisitMissionStatus: "AWAITING_PAYMENT" } : { consultationRights: { durationMinutes: NEXA_TELECONSULTATION_DURATION_MINUTES } }),
        slotId,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: new Date(endsAt).toISOString(),
        amount: Number(amount),
        transactionFee: paymentAmounts.feeAmount,
        transactionFeeRateBps: paymentAmounts.feeRateBps,
        totalAmount: paymentAmounts.totalAmount,
        transactionFeeRecipient: paymentAmounts.feeRecipient,
        ...(sharePolicy ? { teleconsultationSharePolicy: sharePolicy } : {}),
        currency: "HTG",
        status: "PENDING_PAYMENT",
        paymentStatus: "PENDING",
        holdExpiresAt,
        moncashPaymentRef: paymentRef,
        sessionStatus: null,
        requiresNewSlot: false,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (proposalRef) transaction.set(proposalRef, {
        pendingAppointmentId: appointmentRef.id,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.create(paymentRefDoc, {
        uid: user.uid,
        paymentMethod: "MONCASH",
        resourceType: "appointment",
        resourcePath: appointmentRef.path,
        amount: paymentAmounts.totalAmount,
        serviceAmount: Number(amount),
        transactionFee: paymentAmounts.feeAmount,
        transactionFeeRateBps: paymentAmounts.feeRateBps,
        feeRecipient: paymentAmounts.feeRecipient,
        ...(sharePolicy ? { teleconsultationSharePolicy: sharePolicy } : {}),
        currency: "HTG",
        status: "created",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { appointmentId: appointmentRef.id, paymentRef, amount: Number(amount), durationMinutes: isHomeVisit ? HOME_VISIT_DURATION_MINUTES : NEXA_TELECONSULTATION_DURATION_MINUTES, transactionFee: paymentAmounts.feeAmount, totalAmount: paymentAmounts.totalAmount, feeRateBps: paymentAmounts.feeRateBps, holdExpiresAt, reused: false };
    });

    return response(request, {
      ok: true,
      appointmentId: outcome.appointmentId,
      paymentRef: outcome.paymentRef,
      amount: outcome.amount,
      durationMinutes: outcome.durationMinutes,
      transactionFee: outcome.transactionFee,
      totalAmount: outcome.totalAmount,
      transactionFeeRate: outcome.feeRateBps / 100,
      feeRecipient: "NEXARIS",
      currency: "HTG",
      status: "PENDING_PAYMENT",
      holdExpiresAt: new Date(outcome.holdExpiresAt).toISOString(),
    }, outcome.reused ? 200 : 201);
  } catch (error) { return fail(request, error); }
}
