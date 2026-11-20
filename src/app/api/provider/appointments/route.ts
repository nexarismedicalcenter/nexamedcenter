import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { createUserNotification } from "@/lib/notifications.server";
import { recordTeleconsultationPresence } from "@/lib/teleconsultation/presence.server";
import { getTeleconsultationDurationMinutes } from "@/lib/teleconsultation/policy";
import { getConsultationClinicalAccessWindow } from "@/lib/clinical-record/access";
import { creditNexaWalletForRefund } from "@/lib/wallet/nexa-wallet.server";

const START_GRACE_MINUTES = 15;

function response(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "provider-appointments-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les rendez-vous professionnels ne sont pas accessibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA provider appointments failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

async function requireVerifiedDoctor(request: Request) {
  const user = await requireFirebaseUser(request);
  await requireAppCheck(request);
  const provider = await getFirebaseAdminDb().collection("providerProfiles").doc(user.uid).get();
  if (
    !provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" ||
    provider.get("clinicalCredentialsVerified") !== true
  ) throw new ApiRequestError(403, "verified-doctor-required", "Cet espace est réservé aux médecins NEXA vérifiés.");
  return user;
}

export async function GET(request: Request) {
  try {
    const user = await requireVerifiedDoctor(request);
    const db = getFirebaseAdminDb();
    const snapshot = await db.collection("appointments")
      .where("providerUid", "==", user.uid)
      .orderBy("startsAt", "desc")
      .limit(100)
      .get();
    const patientRefs = snapshot.docs.map((doc) => db.collection("patientProfiles").doc(String(doc.get("patientUid") || "_")));
    const patientSnapshots = patientRefs.length ? await db.getAll(...patientRefs) : [];
    const patientNames = new Map(snapshot.docs.map((doc, index) => {
      const profile = patientSnapshots[index]?.data() || {};
      return [doc.id, typeof profile.displayName === "string" ? profile.displayName.slice(0, 100) : "Patient NEXA"] as const;
    }));
    const appointments = snapshot.docs.map((doc) => {
      const item = doc.data();
      const clinicalAccess = getConsultationClinicalAccessWindow(item);
      return {
        appointmentId: doc.id,
        bookingType: typeof item.bookingType === "string" ? item.bookingType : "legacy",
        patientName: patientNames.get(doc.id) || "Patient NEXA",
        startsAt: typeof doc.get("startsAt") === "string" ? doc.get("startsAt") : "",
        endsAt: typeof doc.get("endsAt") === "string" ? doc.get("endsAt") : "",
        durationMinutes: item.bookingType === "home_visit" ? 60 : getTeleconsultationDurationMinutes(item),
        ...(item.bookingType === "home_visit" && item.homeVisitDetails && typeof item.homeVisitDetails === "object" ? {
          homeVisitServiceId: typeof item.homeVisitServiceId === "string" ? item.homeVisitServiceId.slice(0, 64) : "",
          homeVisitDetails: {
            department: typeof item.homeVisitDetails.department === "string" ? item.homeVisitDetails.department.slice(0, 80) : "",
            commune: typeof item.homeVisitDetails.commune === "string" ? item.homeVisitDetails.commune.slice(0, 80) : "",
            addressLine: typeof item.homeVisitDetails.addressLine === "string" ? item.homeVisitDetails.addressLine.slice(0, 220) : "",
            contactPhone: typeof item.homeVisitDetails.contactPhone === "string" ? item.homeVisitDetails.contactPhone.slice(0, 24) : "",
          },
          homeVisitMissionStatus: typeof item.homeVisitMissionStatus === "string" ? item.homeVisitMissionStatus : "UNKNOWN",
        } : {}),
        clinicalAccessExpiresAt: clinicalAccess ? new Date(clinicalAccess.expiresAtMs).toISOString() : null,
        amount: Number.isSafeInteger(doc.get("amount")) ? doc.get("amount") : 0,
        status: typeof doc.get("status") === "string" ? doc.get("status") : "UNKNOWN",
        paymentStatus: typeof doc.get("paymentStatus") === "string" ? doc.get("paymentStatus") : "UNKNOWN",
        ...(typeof item.noShowOutcome === "string" ? { noShowOutcome: item.noShowOutcome } : {}),
        ...(item.noShowAt && typeof item.noShowAt.toDate === "function" ? { noShowAt: item.noShowAt.toDate().toISOString() } : {}),
      };
    });
    return response(request, { ok: true, appointments });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireVerifiedDoctor(request);
    const body = await request.json().catch(() => null);
    const appointmentId = body && typeof body === "object" && !Array.isArray(body) && typeof body.appointmentId === "string"
      ? body.appointmentId.trim().slice(0, 200)
      : "";
    const action = body && typeof body === "object" && !Array.isArray(body) ? body.action : "";
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId) || !["accept", "start", "complete", "refuse"].includes(String(action))) {
      throw new ApiRequestError(400, "invalid-appointment-action", "Le rendez-vous ou l’action n’est pas valide.");
    }

    const db = getFirebaseAdminDb();
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const auditRef = db.collection("adminAuditLogs").doc();
    let nextStatus = "";
    let patientUid = "";
    if (action === "complete") {
      const preview = await appointmentRef.get();
      if (
        preview.exists && preview.get("providerUid") === user.uid &&
        preview.get("status") === "IN_PROGRESS" && preview.get("paymentStatus") === "PAID"
      ) {
        await recordTeleconsultationPresence(db, {
          appointmentId,
          uid: user.uid,
          action: "leave",
        });
      }
    }
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(appointmentRef);
      if (!snapshot.exists || snapshot.get("providerUid") !== user.uid || snapshot.get("providerType") !== "doctor") {
        throw new ApiRequestError(404, "appointment-not-found", "Ce rendez-vous n’est pas accessible.");
      }
      const appointment = snapshot.data() || {};
      patientUid = typeof appointment.patientUid === "string" ? appointment.patientUid : "";
      if (appointment.bookingType === "home_visit") throw new ApiRequestError(409, "home-visit-mission-required", "Les actions de téléconsultation ne sont pas applicables à une visite à domicile.");
      if (action === "refuse" && appointment.bookingType === "teleconsultation" && appointment.status === "REFUNDED" && appointment.refundMethod === "NEXA_WALLET") {
        nextStatus = "REFUNDED";
        return;
      }
      if (appointment.paymentStatus !== "PAID") throw new ApiRequestError(409, "appointment-not-paid", "Le paiement confirmé est requis avant de gérer ce rendez-vous.");
      if (action === "refuse") {
        if (appointment.bookingType !== "teleconsultation") throw new ApiRequestError(409, "appointment-refusal-not-allowed", "Seule une téléconsultation demandée par le patient peut être refusée.");
        if (appointment.status === "PROVIDER_REFUSED" && appointment.refundStatus === "PENDING_AUTO_REFUND") {
          nextStatus = "PROVIDER_REFUSED";
          return;
        }
        if (appointment.status !== "CONFIRMED") throw new ApiRequestError(409, "appointment-refusal-not-allowed", "Une téléconsultation ne peut être refusée qu’avant son acceptation par le médecin.");
        nextStatus = "PROVIDER_REFUSED";
        transaction.set(appointmentRef, {
          status: nextStatus,
          sessionStatus: "REFUSED",
          refundRequired: true,
          refundStatus: "PENDING_AUTO_REFUND",
          refusalReason: "DOCTOR_REFUSED_TELECONSULTATION",
          refusalInitiatedByUid: user.uid,
          refusedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.create(auditRef, {
          actorUid: user.uid,
          action: "appointment_teleconsultation_refused",
          resource: `appointments/${appointmentId}`,
          createdAt: FieldValue.serverTimestamp(),
        });
        return;
      }
      if (action === "accept" && appointment.status === "DOCTOR_ACCEPTED") { nextStatus = "DOCTOR_ACCEPTED"; return; }
      if (action === "start" && appointment.status === "IN_PROGRESS") { nextStatus = "IN_PROGRESS"; return; }
      if (action === "complete" && appointment.status === "COMPLETED") { nextStatus = "COMPLETED"; return; }
      const now = Date.now();
      const startsAt = Date.parse(String(appointment.startsAt || ""));
      const endsAt = Date.parse(String(appointment.endsAt || ""));
      if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
        throw new ApiRequestError(409, "appointment-time-invalid", "Les horaires du rendez-vous sont invalides.");
      }
      let update: Record<string, unknown>;
      if (action === "accept") {
        if (appointment.status !== "CONFIRMED") throw new ApiRequestError(409, "appointment-transition-invalid", "Seul un rendez-vous confirmé peut être accepté.");
        nextStatus = "DOCTOR_ACCEPTED";
        update = { status: nextStatus, acceptedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
      } else if (action === "start") {
        const latestStart = endsAt + START_GRACE_MINUTES * 60_000;
        if (appointment.status !== "DOCTOR_ACCEPTED" || now < startsAt || now > latestStart) {
          throw new ApiRequestError(409, "appointment-cannot-start", "La séance ne peut démarrer qu’après l’acceptation et pendant la plage prévue, avec 15 minutes de tolérance.");
        }
        const interactiveEndsAt = Math.min(endsAt + START_GRACE_MINUTES * 60_000, now + (endsAt - startsAt));
        nextStatus = "IN_PROGRESS";
        update = {
          status: nextStatus,
          sessionStatus: "IN_PROGRESS",
          sessionOpenedAt: FieldValue.serverTimestamp(),
          interactiveEndsAt: new Date(interactiveEndsAt).toISOString(),
          updatedAt: FieldValue.serverTimestamp(),
        };
      } else {
        if (appointment.status !== "IN_PROGRESS") throw new ApiRequestError(409, "appointment-transition-invalid", "Seule une séance en cours peut être terminée.");
        if (!appointment.effectiveConsultationStartedAt) throw new ApiRequestError(409, "consultation-not-started", "La consultation ne peut être terminée avant que les deux participants aient rejoint la séance.");
        nextStatus = "COMPLETED";
        update = {
          status: nextStatus,
          sessionStatus: "TERMINATED",
          videoStatus: "ENDED",
          videoParticipants: {},
          videoActiveSinceMs: null,
          sessionEndedAt: FieldValue.serverTimestamp(),
          interactiveEndsAt: new Date(now).toISOString(),
          updatedAt: FieldValue.serverTimestamp(),
        };
      }
      transaction.set(appointmentRef, update, { merge: true });
      transaction.create(auditRef, {
        actorUid: user.uid,
        action: `appointment_${String(action)}`,
        resource: `appointments/${appointmentId}`,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    if (action === "refuse") {
      const refund = await creditNexaWalletForRefund({
        resourceType: "appointment",
        resourceId: appointmentId,
        actor: { kind: "PROVIDER_REFUSAL", providerUid: user.uid },
      });
      if (patientUid) await createUserNotification({
        uid: patientUid,
        eventKey: `appointment:${appointmentId}:doctor-refusal-wallet-refund`,
        appointmentId,
        type: "appointment_provider_refused_refunded",
        title: "Téléconsultation refusée et remboursée",
        body: `${new Intl.NumberFormat("fr-HT").format(refund.amount)} HTG correspondant au service ont été crédités dans votre portefeuille NEXA. Les frais de transaction ne sont pas remboursés.`,
        url: "/espace",
      });
      return response(request, { ok: true, appointmentId, status: "REFUNDED", refundMethod: "NEXA_WALLET", refundedAmount: refund.amount, currency: refund.currency, alreadyProcessed: refund.alreadyProcessed });
    }
    if (patientUid && ["accept", "start", "complete"].includes(String(action))) {
      const notification = action === "accept"
        ? { type: "appointment_accepted", title: "Rendez-vous accepté", body: "Votre médecin a accepté le rendez-vous. Rejoignez la séance à l’heure prévue.", url: "/espace" }
        : action === "start"
          ? { type: "appointment_started", title: "Séance ouverte", body: "Votre médecin a démarré la séance de consultation.", url: `/teleconsultation?appointmentId=${encodeURIComponent(appointmentId)}` }
          : { type: "appointment_completed", title: "Séance terminée", body: "Votre séance est terminée. Consultez l’état de votre dossier dans votre espace NEXA.", url: "/espace" };
      await createUserNotification({ uid: patientUid, eventKey: `appointment:${appointmentId}:${String(action)}`, appointmentId, ...notification });
    }
    return response(request, { ok: true, appointmentId, status: nextStatus });
  } catch (error) { return fail(request, error); }
}
