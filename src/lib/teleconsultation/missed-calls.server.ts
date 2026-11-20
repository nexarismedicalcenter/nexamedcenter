import "server-only";

import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { ApiRequestError } from "@/lib/auth/server";
import { creditNexaWalletForRefund } from "@/lib/wallet/nexa-wallet.server";
import { createUserNotification } from "@/lib/notifications.server";

export const VIDEO_CALL_RING_TTL_MS = 90_000;
export const MAX_UNANSWERED_VIDEO_CALLS = 2;

export type VideoCallAttemptStatus = "RINGING" | "NO_ANSWER" | "REFUSED" | "ACCEPTED" | "CONNECTED" | "ENDED";
export type VideoCallAttempt = {
  signalId: string;
  initiatedByUid: string;
  initiatedByRole: "patient" | "doctor";
  attemptNumber: number;
  status: VideoCallAttemptStatus;
  startedAtMs: number;
  resolvedAtMs?: number;
};

export function parseVideoCallAttempts(value: unknown): VideoCallAttempt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const status = String(item.status || "").toUpperCase();
    const role: VideoCallAttempt["initiatedByRole"] | null = item.initiatedByRole === "patient" || item.initiatedByRole === "doctor" ? item.initiatedByRole : null;
    const startedAtMs = Number(item.startedAtMs);
    const attemptNumber = Number(item.attemptNumber);
    if (
      typeof item.signalId !== "string" || !item.signalId ||
      typeof item.initiatedByUid !== "string" || !item.initiatedByUid ||
      !role ||
      !["RINGING", "NO_ANSWER", "REFUSED", "ACCEPTED", "CONNECTED", "ENDED"].includes(status) ||
      !Number.isSafeInteger(startedAtMs) || startedAtMs <= 0 ||
      !Number.isSafeInteger(attemptNumber) || attemptNumber <= 0
    ) return [];
    const resolvedAtMs = Number(item.resolvedAtMs);
    return [{
      signalId: item.signalId,
      initiatedByUid: item.initiatedByUid,
      initiatedByRole: role,
      attemptNumber,
      status: status as VideoCallAttemptStatus,
      startedAtMs,
      ...(Number.isSafeInteger(resolvedAtMs) && resolvedAtMs > 0 ? { resolvedAtMs } : {}),
    }];
  }).slice(-100);
}

export function summarizeVideoCallAttempts(attempts: VideoCallAttempt[]) {
  return attempts.map((attempt) => ({
    initiatedBy: attempt.initiatedByRole,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    startedAt: new Date(attempt.startedAtMs).toISOString(),
    ...(attempt.resolvedAtMs ? { resolvedAt: new Date(attempt.resolvedAtMs).toISOString() } : {}),
  }));
}

function timestamp(value: unknown): number {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return (value.toDate() as Date).getTime();
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(String(value || ""));
}

function upsertAttempt(
  attempts: VideoCallAttempt[],
  input: { signalId: string; uid: string; role: "patient" | "doctor"; status: VideoCallAttemptStatus; nowMs: number; startedAtMs?: number },
): VideoCallAttempt[] {
  const existingIndex = attempts.findIndex((attempt) => attempt.signalId === input.signalId);
  if (existingIndex >= 0) {
    const next = [...attempts];
    const current = next[existingIndex];
    next[existingIndex] = {
      ...current,
      status: input.status,
      ...(input.status === "RINGING" ? {} : { resolvedAtMs: input.nowMs }),
    };
    return next;
  }
  const attemptNumber = attempts.filter((attempt) => attempt.initiatedByRole === input.role).length + 1;
  return [...attempts, {
    signalId: input.signalId,
    initiatedByUid: input.uid,
    initiatedByRole: input.role,
    attemptNumber,
    status: input.status,
    startedAtMs: input.startedAtMs ?? input.nowMs,
    ...(input.status === "RINGING" ? {} : { resolvedAtMs: input.nowMs }),
  }].slice(-100);
}

export function setVideoCallAttemptStatus(
  attempts: VideoCallAttempt[],
  signalId: string,
  status: VideoCallAttemptStatus,
  nowMs: number,
) {
  return attempts.map((attempt) => attempt.signalId === signalId
    ? ["NO_ANSWER", "REFUSED", "ENDED"].includes(attempt.status)
      ? attempt
      : { ...attempt, status, ...(status === "RINGING" ? {} : { resolvedAtMs: nowMs }) }
    : attempt);
}

function unansweredCount(attempts: VideoCallAttempt[], role: "patient" | "doctor") {
  return attempts.filter((attempt) => attempt.initiatedByRole === role && attempt.status === "NO_ANSWER").length;
}

/**
 * Mark an expired unanswered invitation and apply the NEXA no-show rule after
 * two unanswered attempts by the same caller. Safe to run repeatedly from a
 * participant poll or the scheduled reconciliation route.
 */
export async function reconcileExpiredTeleconsultationCall(
  db: Firestore,
  appointmentId: string,
  nowMs = Date.now(),
): Promise<{ processed: boolean; outcome?: "PROVIDER_UNRESPONSIVE" | "PATIENT_UNRESPONSIVE" }> {
  const appointmentRef = db.collection("appointments").doc(appointmentId);
  let patientUid = "";
  let shouldRefund = false;
  let noShowOutcome: "PROVIDER_UNRESPONSIVE" | "PATIENT_UNRESPONSIVE" | undefined;

  await db.runTransaction(async (transaction) => {
    patientUid = "";
    shouldRefund = false;
    noShowOutcome = undefined;
    const snapshot = await transaction.get(appointmentRef);
    if (!snapshot.exists) return;
    const appointment = snapshot.data() || {};
    patientUid = typeof appointment.patientUid === "string" ? appointment.patientUid : "";
    const serviceAmount = Number(appointment.amount);
    const serviceAmountMinor = Number.isSafeInteger(serviceAmount) && serviceAmount > 0 ? serviceAmount * 100 : 0;
    const transactionFee = Number(appointment.transactionFee);
    const transactionFeeMinor = Number.isSafeInteger(transactionFee) && transactionFee > 0 ? transactionFee * 100 : 0;

    // A prior classification can be retried if the wallet credit was interrupted.
    if (appointment.status === "PROVIDER_NO_SHOW_REFUND_REQUIRED" && appointment.refundStatus === "PENDING_AUTO_REFUND") {
      shouldRefund = true;
      noShowOutcome = "PROVIDER_UNRESPONSIVE";
      return;
    }
    if (
      !["DOCTOR_ACCEPTED", "IN_PROGRESS"].includes(String(appointment.status || "").toUpperCase()) ||
      String(appointment.providerType || "").toLowerCase() !== "doctor" ||
      !["teleconsultation", "doctor_proposed_appointment"].includes(String(appointment.bookingType || "")) ||
      timestamp(appointment.effectiveConsultationStartedAt) > 0
    ) return;

    const signal = appointment.videoSignal && typeof appointment.videoSignal === "object" && !Array.isArray(appointment.videoSignal)
      ? appointment.videoSignal as Record<string, unknown>
      : {};
    if (String(signal.status || "").toUpperCase() !== "RINGING") return;
    const signalId = typeof signal.id === "string" ? signal.id : "";
    const initiatedByUid = typeof signal.by === "string" ? signal.by : "";
    const patient = patientUid;
    const provider = typeof appointment.providerUid === "string" ? appointment.providerUid : "";
    const role = initiatedByUid === patient ? "patient" : initiatedByUid === provider ? "doctor" : null;
    const startedAtMs = timestamp(signal.updatedAt);
    if (!signalId || !role || !Number.isFinite(startedAtMs) || nowMs - startedAtMs < VIDEO_CALL_RING_TTL_MS) return;

    let attempts = parseVideoCallAttempts(appointment.videoCallAttempts);
    attempts = upsertAttempt(attempts, { signalId, uid: initiatedByUid, role, status: "NO_ANSWER", nowMs, startedAtMs });
    const count = unansweredCount(attempts, role);
    const attemptAuditRef = db.collection("paymentAuditLogs").doc();
    const nowIso = new Date(nowMs).toISOString();
    const commonUpdate = {
      videoCallAttempts: attempts,
      videoSignal: { ...signal, status: "MISSED", updatedAt: nowIso, resolvedAt: nowIso },
      videoCallAttemptsUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    transaction.create(attemptAuditRef, {
      actorUid: "system:nexa-call-timeout",
      action: "teleconsultation_unanswered_call_recorded",
      resource: `appointments/${appointmentId}`,
      initiatedByRole: role,
      attemptNumber: attempts.find((attempt) => attempt.signalId === signalId)?.attemptNumber || count,
      outcome: "NO_ANSWER",
      occurredAt: new Date(nowMs),
      createdAt: FieldValue.serverTimestamp(),
    });

    if (count < MAX_UNANSWERED_VIDEO_CALLS) {
      transaction.set(appointmentRef, commonUpdate, { merge: true });
      return;
    }

    noShowOutcome = role === "patient" ? "PROVIDER_UNRESPONSIVE" : "PATIENT_UNRESPONSIVE";
    if (noShowOutcome === "PROVIDER_UNRESPONSIVE") {
      shouldRefund = true;
      transaction.set(appointmentRef, {
        ...commonUpdate,
        status: "PROVIDER_NO_SHOW_REFUND_REQUIRED",
        sessionStatus: "NO_SHOW",
        videoStatus: "ENDED",
        videoParticipants: {},
        videoActiveSinceMs: null,
        interactiveEndsAt: nowIso,
        refundRequired: true,
        refundStatus: "PENDING_AUTO_REFUND",
        noShowOutcome,
        noShowTriggeredBy: role,
        noShowAt: FieldValue.serverTimestamp(),
        noShowSettlement: {
          serviceAmountMinor,
          patientRefundMinor: serviceAmountMinor,
          providerAmountMinor: 0,
          transactionFeeRefunded: false,
        },
      }, { merge: true });
    } else {
      transaction.set(appointmentRef, {
        ...commonUpdate,
        status: "PATIENT_NO_SHOW_RETAINED",
        sessionStatus: "NO_SHOW",
        videoStatus: "ENDED",
        videoParticipants: {},
        videoActiveSinceMs: null,
        interactiveEndsAt: nowIso,
        refundRequired: false,
        refundStatus: "NOT_APPLICABLE",
        noShowOutcome,
        noShowTriggeredBy: role,
        noShowAt: FieldValue.serverTimestamp(),
        settlementStatus: "NEXA_RETAINED_NO_SHOW",
        noShowSettlement: {
          serviceAmountMinor,
          nexaServiceAmountMinor: serviceAmountMinor,
          transactionFeeMinor,
          providerAmountMinor: 0,
        },
      }, { merge: true });
    }
    const outcomeAuditRef = db.collection("paymentAuditLogs").doc();
    transaction.create(outcomeAuditRef, {
      actorUid: "system:nexa-call-timeout",
      action: noShowOutcome === "PROVIDER_UNRESPONSIVE" ? "teleconsultation_provider_no_show_classified" : "teleconsultation_patient_no_show_classified",
      resource: `appointments/${appointmentId}`,
      initiatedByRole: role,
      unansweredAttemptCount: count,
      serviceAmountMinor,
      providerAmountMinor: 0,
      occurredAt: new Date(nowMs),
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  if (shouldRefund) {
    await creditNexaWalletForRefund({
      resourceType: "appointment",
      resourceId: appointmentId,
      actor: { kind: "PROVIDER_NO_SHOW" },
    });
  } else if (noShowOutcome === "PATIENT_UNRESPONSIVE" && patientUid) {
    await createUserNotification({
      uid: patientUid,
      eventKey: `appointment:${appointmentId}:patient-no-show-retained`,
      appointmentId,
      type: "appointment_patient_no_show",
      title: "Téléconsultation manquée",
      body: "Le médecin a enregistré deux appels restés sans réponse. Le montant du service est conservé par NEXA et aucun versement n’est dû au médecin.",
      url: "/espace",
    });
  }

  return { processed: Boolean(noShowOutcome), ...(noShowOutcome ? { outcome: noShowOutcome } : {}) };
}

export async function reconcileExpiredTeleconsultationCalls(
  db: Firestore,
  nowMs = Date.now(),
): Promise<{ checked: number; processed: number }> {
  const snapshot = await db.collection("appointments")
    .where("status", "in", ["DOCTOR_ACCEPTED", "IN_PROGRESS", "PROVIDER_NO_SHOW_REFUND_REQUIRED"])
    .limit(500)
    .get();
  let processed = 0;
  for (const candidate of snapshot.docs) {
    const result = await reconcileExpiredTeleconsultationCall(db, candidate.id, nowMs);
    if (result.processed) processed += 1;
  }
  return { checked: snapshot.size, processed };
}

export function recordVideoCallAttempt(
  appointment: Record<string, unknown>,
  input: { uid: string; nowMs: number; signalId: string },
) {
  const patientUid = typeof appointment.patientUid === "string" ? appointment.patientUid : "";
  const providerUid = typeof appointment.providerUid === "string" ? appointment.providerUid : "";
  const role = input.uid === patientUid ? "patient" : input.uid === providerUid ? "doctor" : null;
  if (!role) throw new ApiRequestError(403, "forbidden", "Vous ne participez pas à cette séance.");
  const attempts = upsertAttempt(parseVideoCallAttempts(appointment.videoCallAttempts), {
    signalId: input.signalId,
    uid: input.uid,
    role,
    status: "RINGING",
    nowMs: input.nowMs,
  });
  return attempts;
}
