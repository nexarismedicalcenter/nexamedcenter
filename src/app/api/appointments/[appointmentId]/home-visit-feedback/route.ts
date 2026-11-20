import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { createUserNotification } from "@/lib/notifications.server";
import { appointmentPaymentMatches } from "@/lib/payments/transaction-fees.server";
import { creditNexaWalletForRefund } from "@/lib/wallet/nexa-wallet.server";

const COMPLETIONS = new Set(["COMPLETED", "PARTIAL", "NOT_COMPLETED"]);
const RATING_KEYS = ["punctuality", "professionalism", "listening", "explanations", "satisfaction"] as const;
const MAX_BODY_BYTES = 8 * 1024;

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "home-visit-feedback-failed";
  const message = error instanceof ApiRequestError ? error.message : "Le formulaire de visite ne peut pas être enregistré.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA home-visit feedback failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function clean(value: unknown, maximum: number) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maximum) : "";
}

function readRating(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 5 ? Number(value) : null;
}

async function readBody(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw new ApiRequestError(413, "request-too-large", "Le formulaire dépasse la taille autorisée.");
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw new ApiRequestError(413, "request-too-large", "Le formulaire dépasse la taille autorisée.");
  try { return JSON.parse(raw) as unknown; } catch { throw new ApiRequestError(400, "invalid-feedback", "Le formulaire de visite n’est pas valide."); }
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request, { params }: { params: Promise<{ appointmentId: string }> }) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "submit-home-visit-feedback", limit: 4, windowMs: 10 * 60_000 });
    const { appointmentId } = await params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) throw new ApiRequestError(400, "invalid-appointment", "La référence de la visite n’est pas valide.");
    const body = await readBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-feedback", "Le formulaire de visite n’est pas valide.");
    const input = body as Record<string, unknown>;
    if (input.retryNoShowRefund === true && Object.keys(input).length === 1) {
      const db = getFirebaseAdminDb();
      const appointmentRef = db.collection("appointments").doc(appointmentId);
      const reportRef = db.collection("homeVisitMissionReports").doc(appointmentId);
      let providerUid = "";
      await db.runTransaction(async (transaction) => {
        const [appointmentSnapshot, reportSnapshot] = await Promise.all([transaction.get(appointmentRef), transaction.get(reportRef)]);
        const appointment = appointmentSnapshot.data() || {};
        const report = reportSnapshot.data() || {};
        if (!appointmentSnapshot.exists || appointment.patientUid !== user.uid || appointment.bookingType !== "home_visit" ||
          appointment.status !== "PROVIDER_NO_SHOW_REFUND_REQUIRED" || appointment.refundStatus !== "PENDING_AUTO_REFUND" ||
          appointment.homeVisitMissionStatus !== "PROVIDER_ABSENT_REFUND_REQUIRED" || !reportSnapshot.exists || report.patientUid !== user.uid || report.providerPresent !== false) {
          throw new ApiRequestError(409, "home-visit-refund-not-retryable", "Aucun remboursement de visite en attente ne peut être repris.");
        }
        providerUid = typeof appointment.providerUid === "string" ? appointment.providerUid : "";
        transaction.create(db.collection("paymentAuditLogs").doc(), {
          actorUid: user.uid,
          action: "home_visit_no_show_refund_retry_requested",
          resource: `appointments/${appointmentId}`,
          createdAt: FieldValue.serverTimestamp(),
        });
      });
      const refund = await creditNexaWalletForRefund({ resourceType: "appointment", resourceId: appointmentId, actor: { kind: "HOME_VISIT_PROVIDER_NO_SHOW" } });
      if (providerUid) await createUserNotification({
        uid: providerUid,
        eventKey: `home-visit:${appointmentId}:absence-reported`,
        appointmentId,
        type: "home_visit_provider_absence_reported",
        title: "Visite à domicile déclarée non assurée",
        body: "Le patient a signalé que la visite n’a pas eu lieu. NEXA a traité le remboursement du prix du service.",
        url: "/professionnels/espace",
      });
      return json(request, { ok: true, missionStatus: "REFUNDED", refundMethod: "NEXA_WALLET", refundedAmount: refund.amount, currency: refund.currency });
    }
    const allowedKeys = new Set(["providerPresent", "identityMatched", "serviceCompletion", "examPerformed", "prescriptionProvided", "additionalExamsRecommended", "questionsAnswered", "visitStartedAt", "visitEndedAt", "ratings", "comment", "signatureName", "signerRole", "patientConfirmed", "signatureConsent", "refundMethod"]);
    if (Object.keys(input).some((key) => !allowedKeys.has(key))) throw new ApiRequestError(400, "unexpected-feedback-field", "Le formulaire contient un champ non pris en charge.");
    if (typeof input.providerPresent !== "boolean" || typeof input.identityMatched !== "boolean" || typeof input.patientConfirmed !== "boolean" || input.patientConfirmed !== true || input.signatureConsent !== true) {
      throw new ApiRequestError(400, "feedback-confirmation-required", "Confirmez la présence, votre réponse et la signature électronique avant l’envoi.");
    }
    const serviceCompletion = typeof input.serviceCompletion === "string" ? input.serviceCompletion : "";
    if (!COMPLETIONS.has(serviceCompletion)) throw new ApiRequestError(400, "invalid-service-completion", "Indiquez si le soin a été complet, partiel ou non réalisé.");
    const signatureName = clean(input.signatureName, 160);
    const signerRole = input.signerRole === "REPRESENTATIVE" ? "REPRESENTATIVE" : input.signerRole === "PATIENT" ? "PATIENT" : "";
    const ratings = input.ratings && typeof input.ratings === "object" && !Array.isArray(input.ratings) ? input.ratings as Record<string, unknown> : {};
    const normalizedRatings = Object.fromEntries(RATING_KEYS.map((key) => [key, readRating(ratings[key])])) as Record<(typeof RATING_KEYS)[number], number | null>;
    const visitStartedAt = typeof input.visitStartedAt === "string" ? input.visitStartedAt.trim() : "";
    const visitEndedAt = typeof input.visitEndedAt === "string" ? input.visitEndedAt.trim() : "";
    const startsMs = Date.parse(visitStartedAt);
    const endsMs = Date.parse(visitEndedAt);
    const comment = clean(input.comment, 500);
    const present = input.providerPresent === true;
    const refundMethod = input.refundMethod === undefined ? "NEXA_WALLET" : input.refundMethod;
    if (!(refundMethod === "NEXA_WALLET" || refundMethod === "CASH_MANUAL") || (present && refundMethod !== "NEXA_WALLET")) {
      throw new ApiRequestError(400, "invalid-home-visit-refund-method", "Choisissez le portefeuille NEXA ou une demande de remboursement manuel en espèces uniquement si le médecin est absent.");
    }
    if (!signatureName || !signerRole) throw new ApiRequestError(400, "signature-required", "Saisissez le nom du patient ou de son représentant et son rôle.");
    if (present && (RATING_KEYS.some((key) => normalizedRatings[key] === null) || !Number.isFinite(startsMs) || !Number.isFinite(endsMs) || startsMs >= endsMs || endsMs > Date.now())) {
      throw new ApiRequestError(400, "visit-review-incomplete", "Pour une visite réalisée, confirmez l’identité, les horaires, le niveau de soin et toutes les évaluations.");
    }
    if (!present && (input.identityMatched || serviceCompletion !== "NOT_COMPLETED")) throw new ApiRequestError(400, "provider-absence-report-invalid", "Une absence du médecin doit être signalée comme une visite non réalisée.");

    const db = getFirebaseAdminDb();
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const reportRef = db.collection("homeVisitMissionReports").doc(appointmentId);
    const auditRef = db.collection("paymentAuditLogs").doc();
    const cashRefundAuditRef = db.collection("adminAuditLogs").doc();
    const cashRefundAlertRef = db.collection("paymentSettlementAlerts").doc();
    let providerUid = "";
    let refundRequired = false;
    let manualCashRefundRequested = false;
    let missionStatus = "";
    await db.runTransaction(async (transaction) => {
      const [appointmentSnapshot, reportSnapshot] = await Promise.all([transaction.get(appointmentRef), transaction.get(reportRef)]);
      if (!appointmentSnapshot.exists || appointmentSnapshot.get("patientUid") !== user.uid || appointmentSnapshot.get("bookingType") !== "home_visit") {
        throw new ApiRequestError(404, "home-visit-not-found", "Cette visite n’est pas accessible.");
      }
      if (reportSnapshot.exists) throw new ApiRequestError(409, "home-visit-feedback-already-submitted", "Le formulaire de cette visite a déjà été envoyé.");
      const appointment = appointmentSnapshot.data() || {};
      if (appointment.paymentStatus !== "PAID" || appointment.status !== "CONFIRMED" || appointment.homeVisitMissionStatus !== "SCHEDULED") {
        throw new ApiRequestError(409, "home-visit-not-ready-for-feedback", "La visite doit être payée et confirmée avant l’envoi du formulaire.");
      }
      if (!present && refundMethod === "CASH_MANUAL") {
        const paymentRef = typeof appointment.moncashPaymentRef === "string" ? appointment.moncashPaymentRef : "";
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(paymentRef)) throw new ApiRequestError(409, "refund-payment-invalid", "Le paiement lié à cette visite ne peut pas être vérifié.");
        const paymentSnapshot = await transaction.get(db.collection("paymentIntents").doc(paymentRef));
        const payment = paymentSnapshot.data() || {};
        if (!paymentSnapshot.exists || payment.status !== "paid" || !["MONCASH", "SMART_WALLET"].includes(String(payment.paymentMethod || "")) || payment.resourceType !== "appointment" || payment.resourcePath !== `appointments/${appointmentId}` || payment.uid !== user.uid || !appointmentPaymentMatches(appointment, payment) || String(payment.currency || "").toUpperCase() !== "HTG") {
          throw new ApiRequestError(409, "refund-payment-mismatch", "Le paiement de cette visite ne correspond pas à la demande.");
        }
      }
      const scheduledEnd = Date.parse(String(appointment.endsAt || ""));
      if (!Number.isFinite(scheduledEnd) || Date.now() < scheduledEnd) throw new ApiRequestError(409, "home-visit-not-finished", "Le formulaire devient disponible après l’heure prévue de fin de la visite.");
      providerUid = typeof appointment.providerUid === "string" ? appointment.providerUid : "";
      if (!providerUid) throw new ApiRequestError(409, "home-visit-provider-unavailable", "Le professionnel associé à cette visite n’est pas disponible.");
      const now = FieldValue.serverTimestamp();
      const report = {
        appointmentId,
        patientUid: user.uid,
        providerUid,
        providerPresent: present,
        identityMatched: input.identityMatched,
        serviceCompletion,
        examPerformed: input.examPerformed === true,
        prescriptionProvided: input.prescriptionProvided === true,
        additionalExamsRecommended: input.additionalExamsRecommended === true,
        questionsAnswered: input.questionsAnswered === true,
        ...(present ? { visitStartedAt: new Date(startsMs).toISOString(), visitEndedAt: new Date(endsMs).toISOString(), ratings: normalizedRatings } : {}),
        comment,
        patientConfirmed: true,
        signature: { name: signatureName, signerRole, consented: true, signedAt: now },
        createdAt: now,
        updatedAt: now,
      };
      transaction.create(reportRef, report);
      if (present && input.identityMatched === true && serviceCompletion !== "NOT_COMPLETED") {
        missionStatus = "AWAITING_PROVIDER_CODE";
        transaction.set(appointmentRef, {
          homeVisitMissionStatus: missionStatus,
          homeVisitPatientConfirmedAt: now,
          homeVisitProviderPresent: true,
          homeVisitIdentityMatched: true,
          homeVisitServiceCompletion: serviceCompletion,
          updatedAt: now,
        }, { merge: true });
      } else if (present) {
        missionStatus = "ADMIN_REVIEW_REQUIRED";
        transaction.set(appointmentRef, {
          homeVisitMissionStatus: missionStatus,
          homeVisitPatientConfirmedAt: now,
          homeVisitProviderPresent: true,
          homeVisitIdentityMatched: input.identityMatched === true,
          homeVisitServiceCompletion: serviceCompletion,
          updatedAt: now,
        }, { merge: true });
      } else {
        missionStatus = "PROVIDER_ABSENT_REFUND_REQUIRED";
        refundRequired = true;
        manualCashRefundRequested = refundMethod === "CASH_MANUAL";
        transaction.set(appointmentRef, {
          status: "PROVIDER_NO_SHOW_REFUND_REQUIRED",
          refundRequired: true,
          refundStatus: manualCashRefundRequested ? "PENDING_MANUAL_CASH" : "PENDING_AUTO_REFUND",
          ...(manualCashRefundRequested ? {
            requestedRefundMethod: "CASH_MANUAL",
            refundRequestStatus: "REQUESTED",
            refundRequestedAt: now,
          } : {}),
          homeVisitMissionStatus: missionStatus,
          homeVisitProviderPresent: false,
          homeVisitServiceCompletion: "NOT_COMPLETED",
          homeVisitNoShowReportedAt: now,
          updatedAt: now,
        }, { merge: true });
        if (manualCashRefundRequested) {
          transaction.create(cashRefundAlertRef, {
            paymentRef: appointment.moncashPaymentRef,
            resourceType: "appointment",
            resourceId: appointmentId,
            reason: "PATIENT_REQUESTED_CASH_REFUND",
            requestedRefundMethod: "CASH_MANUAL",
            refundRequestedByUid: user.uid,
            refundRequestedAt: now,
            status: "open",
            createdAt: now,
          });
          transaction.create(cashRefundAuditRef, {
            actorUid: user.uid,
            action: "patient_cash_refund_requested",
            resource: `appointments/${appointmentId}`,
            refundMethod: "CASH_MANUAL",
            amountMinor: Number(appointment.amount) * 100,
            currency: "HTG",
            createdAt: now,
          });
        }
      }
      transaction.create(auditRef, {
        actorUid: user.uid,
        action: present ? "home_visit_patient_feedback_submitted" : "home_visit_provider_absence_reported",
        resource: `appointments/${appointmentId}`,
        createdAt: now,
      });
    });

    if (refundRequired) {
      if (manualCashRefundRequested) {
        await createUserNotification({
          uid: providerUid,
          eventKey: `home-visit:${appointmentId}:absence-reported`,
          appointmentId,
          type: "home_visit_provider_absence_reported",
          title: "Visite à domicile déclarée non assurée",
          body: "Le patient a signalé que la visite n’a pas eu lieu et demandé un remboursement en espèces. NEXA doit traiter cette demande manuellement.",
          url: "/professionnels/espace",
        });
        return json(request, { ok: true, missionStatus, refundStatus: "PENDING_MANUAL_CASH", requestedRefundMethod: "CASH_MANUAL" });
      }
      const refund = await creditNexaWalletForRefund({ resourceType: "appointment", resourceId: appointmentId, actor: { kind: "HOME_VISIT_PROVIDER_NO_SHOW" } });
      await createUserNotification({
        uid: providerUid,
        eventKey: `home-visit:${appointmentId}:absence-reported`,
        appointmentId,
        type: "home_visit_provider_absence_reported",
        title: "Visite à domicile déclarée non assurée",
        body: "Le patient a signalé que la visite n’a pas eu lieu. Le remboursement du prix du service a été crédité dans son portefeuille NEXA.",
        url: "/professionnels/espace",
      });
      return json(request, { ok: true, missionStatus: "REFUNDED", refundMethod: "NEXA_WALLET", refundedAmount: refund.amount, currency: refund.currency });
    }
    await createUserNotification({
      uid: providerUid,
      eventKey: `home-visit:${appointmentId}:patient-feedback`,
      appointmentId,
      type: "home_visit_patient_feedback_submitted",
      title: missionStatus === "ADMIN_REVIEW_REQUIRED" ? "Visite à vérifier par NEXA" : "Formulaire patient reçu",
      body: missionStatus === "ADMIN_REVIEW_REQUIRED" ? "Le patient a indiqué un écart concernant l’identité ou la réalisation du service. La clôture par code est suspendue en attendant une vérification NEXA." : "Le patient a confirmé la visite. Saisissez le code de clôture dans votre espace professionnel pour terminer la mission.",
      url: "/professionnels/espace",
    });
    return json(request, { ok: true, missionStatus });
  } catch (error) { return fail(request, error); }
}
