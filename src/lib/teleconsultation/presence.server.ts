import "server-only";

import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { getTeleconsultationDurationMinutes } from "@/lib/teleconsultation/policy";

export type VideoPresenceAction = "join" | "heartbeat" | "leave";

export type TeleconsultationPresenceResult = {
  expired: boolean;
  videoLimitSeconds: number;
  videoConsumedSeconds: number;
  videoRemainingSeconds: number;
  videoStatus: string;
  sessionStatus: string;
};

export class TeleconsultationPresenceError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(
    status: number,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "TeleconsultationPresenceError";
    this.status = status;
    this.code = code;
  }
}

const PRESENCE_TIMEOUT_MS = 30_000;
const MAX_ACCOUNTED_INTERVAL_MS = 15_000;
const TERMINAL_SESSION_STATUSES = new Set(["TERMINATED", "INTERACTIVE_TIME_EXPIRED"]);

type ParticipantPresence = { lastSeenAtMs: number };

function timestamp(value: unknown): number {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return (value.toDate() as Date).getTime();
  }
  if (typeof value === "number") return value;
  return Date.parse(String(value || ""));
}

function parsePresence(value: unknown): Record<string, ParticipantPresence> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const presence: Record<string, ParticipantPresence> = {};
  for (const [uid, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const lastSeenAtMs = Number((entry as Record<string, unknown>).lastSeenAtMs);
    if (uid && Number.isFinite(lastSeenAtMs) && lastSeenAtMs > 0) {
      presence[uid] = { lastSeenAtMs };
    }
  }
  return presence;
}

function activeParticipants(
  presence: Record<string, ParticipantPresence>,
  nowMs: number,
): Record<string, ParticipantPresence> {
  return Object.fromEntries(
    Object.entries(presence).filter(([, participant]) =>
      participant.lastSeenAtMs <= nowMs && nowMs - participant.lastSeenAtMs < PRESENCE_TIMEOUT_MS,
    ),
  );
}

export function getTeleconsultationVideoLimitSeconds(appointment: Record<string, unknown>): number {
  return Math.max(60, Math.round(getTeleconsultationDurationMinutes(appointment) * 60));
}

function buildResult(input: {
  expired: boolean;
  videoLimitSeconds: number;
  videoConsumedMilliseconds: number;
  videoStatus: string;
  sessionStatus: string;
}): TeleconsultationPresenceResult {
  const videoConsumedSeconds = Math.min(
    input.videoLimitSeconds,
    Math.floor(Math.max(0, input.videoConsumedMilliseconds) / 1_000),
  );
  return {
    expired: input.expired,
    videoLimitSeconds: input.videoLimitSeconds,
    videoConsumedSeconds,
    videoRemainingSeconds: Math.max(0, input.videoLimitSeconds - videoConsumedSeconds),
    videoStatus: input.videoStatus,
    sessionStatus: input.sessionStatus,
  };
}

export async function recordTeleconsultationPresence(
  db: Firestore,
  input: {
    appointmentId: string;
    uid: string;
    action: VideoPresenceAction;
    nowMs?: number;
  },
): Promise<TeleconsultationPresenceResult> {
  const appointmentRef = db.collection("appointments").doc(input.appointmentId);
  const nowMs = input.nowMs ?? Date.now();
  let result: TeleconsultationPresenceResult | undefined;

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(appointmentRef);
    if (!snapshot.exists) {
      throw new TeleconsultationPresenceError(404, "appointment-not-found", "Consultation introuvable.");
    }
    const appointment = snapshot.data() || {};
    if (appointment.patientUid !== input.uid && appointment.providerUid !== input.uid) {
      throw new TeleconsultationPresenceError(403, "forbidden", "Vous ne participez pas à cette séance.");
    }

    const providerType = String(appointment.providerType || "").toLowerCase();
    if (providerType !== "doctor") {
      throw new TeleconsultationPresenceError(409, "video-not-available", "La vidéo est réservée aux consultations médecin.");
    }

    const appointmentStatus = String(appointment.status || "").toUpperCase();
    let sessionStatus = String(appointment.sessionStatus || "").toUpperCase();
    const videoLimitSeconds = getTeleconsultationVideoLimitSeconds(appointment);
    const videoLimitMilliseconds = videoLimitSeconds * 1_000;
    const previousConsumedMilliseconds = Number.isFinite(Number(appointment.videoConsumedMilliseconds))
      ? Math.max(0, Number(appointment.videoConsumedMilliseconds))
      : Math.max(0, Number(appointment.videoConsumedSeconds) || 0) * 1_000;
    const isActiveAppointment = ["DOCTOR_ACCEPTED", "IN_PROGRESS"].includes(appointmentStatus) && appointment.paymentStatus === "PAID" && ["teleconsultation", "doctor_proposed_appointment"].includes(String(appointment.bookingType || ""));

    if (input.action !== "leave") {
      if (!isActiveAppointment) {
        if (!["DOCTOR_ACCEPTED", "IN_PROGRESS"].includes(appointmentStatus) || TERMINAL_SESSION_STATUSES.has(sessionStatus)) {
          sessionStatus = sessionStatus || "TERMINATED";
          transaction.set(appointmentRef, {
            sessionStatus,
            videoStatus: "ENDED",
            videoParticipants: {},
            videoActiveSinceMs: null,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
          result = buildResult({
            expired: true,
            videoLimitSeconds,
            videoConsumedMilliseconds: previousConsumedMilliseconds,
            videoStatus: "ENDED",
            sessionStatus,
          });
          return;
        }
        throw new TeleconsultationPresenceError(409, "session-not-active", "La séance vidéo n’est pas ouverte par le professionnel.");
      }
      const startsAt = timestamp(appointment.startsAt);
      if (!Number.isFinite(startsAt)) {
        throw new TeleconsultationPresenceError(409, "invalid-consultation-slot", "Le créneau de consultation est invalide.");
      }
      if (nowMs < startsAt) {
        throw new TeleconsultationPresenceError(403, "consultation-not-started", "La vidéo ne peut démarrer qu’à l’heure prévue.");
      }
      const configuredInteractiveEnd = timestamp(appointment.interactiveEndsAt);
      const scheduledEnd = timestamp(appointment.endsAt);
      const interactiveEndsAt = Number.isFinite(configuredInteractiveEnd) && configuredInteractiveEnd > 0
        ? configuredInteractiveEnd
        : Number.isFinite(scheduledEnd) ? scheduledEnd + 15 * 60_000 : Number.NaN;
      if (Number.isFinite(interactiveEndsAt) && interactiveEndsAt > 0 && nowMs >= interactiveEndsAt) {
        sessionStatus = "INTERACTIVE_TIME_EXPIRED";
        transaction.set(appointmentRef, {
          sessionStatus,
          videoStatus: "ENDED",
          videoParticipants: {},
          videoActiveSinceMs: null,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        result = buildResult({
          expired: true,
          videoLimitSeconds,
          videoConsumedMilliseconds: previousConsumedMilliseconds,
          videoStatus: "ENDED",
          sessionStatus,
        });
        return;
      }
    }

    let presence = activeParticipants(parsePresence(appointment.videoParticipants), nowMs);
    const activeSinceMs = Number(appointment.videoActiveSinceMs);
    let consumedMilliseconds = previousConsumedMilliseconds;
    const effectiveConsultationStarted = timestamp(appointment.effectiveConsultationStartedAt) > 0;
    const connectedParticipants = appointment.videoConnectedParticipants && typeof appointment.videoConnectedParticipants === "object" && !Array.isArray(appointment.videoConnectedParticipants)
      ? appointment.videoConnectedParticipants as Record<string, unknown>
      : {};
    const bothBrowsersConnected = [appointment.patientUid, appointment.providerUid].every((uid) => {
      if (typeof uid !== "string" || !uid) return false;
      const connectedAtMs = Number(connectedParticipants[uid]);
      return Number.isFinite(connectedAtMs) && connectedAtMs <= nowMs && nowMs - connectedAtMs < PRESENCE_TIMEOUT_MS;
    });
    if (isActiveAppointment && effectiveConsultationStarted && bothBrowsersConnected && Object.keys(presence).length >= 2 && Number.isFinite(activeSinceMs)) {
      const elapsedMilliseconds = Math.max(0, Math.min(nowMs - activeSinceMs, MAX_ACCOUNTED_INTERVAL_MS));
      consumedMilliseconds = Math.min(videoLimitMilliseconds, consumedMilliseconds + elapsedMilliseconds);
    }

    if (input.action === "leave") {
      delete presence[input.uid];
    } else {
      presence[input.uid] = { lastSeenAtMs: nowMs };
    }

    if (!isActiveAppointment) presence = {};

    if (isActiveAppointment && consumedMilliseconds >= videoLimitMilliseconds) {
      sessionStatus = "INTERACTIVE_TIME_EXPIRED";
      presence = {};
      transaction.set(appointmentRef, {
        videoConsumedMilliseconds: videoLimitMilliseconds,
        videoConsumedSeconds: videoLimitSeconds,
        sessionStatus,
        videoStatus: "ENDED",
        videoParticipants: presence,
        videoActiveSinceMs: null,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      result = buildResult({
        expired: true,
        videoLimitSeconds,
        videoConsumedMilliseconds: videoLimitMilliseconds,
        videoStatus: "ENDED",
        sessionStatus,
      });
      return;
    }

    const activeCount = Object.keys(presence).length;
    const videoActive = isActiveAppointment && effectiveConsultationStarted && bothBrowsersConnected && activeCount >= 2;
    const videoStatus = videoActive ? "ACTIVE" : activeCount > 0 ? "WAITING" : "ENDED";
    const nextSessionStatus = isActiveAppointment ? (sessionStatus || "IN_PROGRESS") : sessionStatus;
    transaction.set(appointmentRef, {
      videoConsumedMilliseconds: Math.min(videoLimitMilliseconds, consumedMilliseconds),
      videoConsumedSeconds: Math.min(videoLimitSeconds, Math.floor(consumedMilliseconds / 1_000)),
      videoParticipants: presence,
      videoActiveSinceMs: videoActive ? nowMs : null,
      videoStatus,
      sessionStatus: nextSessionStatus,
      videoPresenceUpdatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    result = buildResult({
      expired: false,
      videoLimitSeconds,
      videoConsumedMilliseconds: consumedMilliseconds,
      videoStatus,
      sessionStatus: nextSessionStatus,
    });
  });

  if (!result) throw new Error("Teleconsultation presence transaction returned no result.");
  return result;
}

export async function reconcileStaleTeleconsultationPresence(
  db: Firestore,
  nowMs = Date.now(),
): Promise<{ checked: number; reconciled: number }> {
  const snapshot = await db.collection("appointments")
    .where("status", "in", ["DOCTOR_ACCEPTED", "IN_PROGRESS"])
    .limit(500)
    .get();
  let reconciled = 0;

  for (const candidate of snapshot.docs) {
    let didReconcile = false;
    await db.runTransaction(async (transaction) => {
      const fresh = await transaction.get(candidate.ref);
      if (!fresh.exists || !["DOCTOR_ACCEPTED", "IN_PROGRESS"].includes(String(fresh.get("status") || "").toUpperCase())) return;
      if (!["teleconsultation", "doctor_proposed_appointment"].includes(String(fresh.get("bookingType") || ""))) return;
      const presence = parsePresence(fresh.get("videoParticipants"));
      const active = activeParticipants(presence, nowMs);
      const hadStaleEntries = Object.keys(presence).length !== Object.keys(active).length;
      const appointment = fresh.data() || {};
      const connectedParticipants = appointment.videoConnectedParticipants && typeof appointment.videoConnectedParticipants === "object" && !Array.isArray(appointment.videoConnectedParticipants)
        ? appointment.videoConnectedParticipants as Record<string, unknown>
        : {};
      const bothBrowsersConnected = [appointment.patientUid, appointment.providerUid].every((uid) => {
        if (typeof uid !== "string" || !uid) return false;
        const connectedAtMs = Number(connectedParticipants[uid]);
        return Number.isFinite(connectedAtMs) && connectedAtMs <= nowMs && nowMs - connectedAtMs < PRESENCE_TIMEOUT_MS;
      });
      const activeVideo = Object.keys(active).length >= 2 && timestamp(appointment.effectiveConsultationStartedAt) > 0 && bothBrowsersConnected;
      const storedStatus = String(fresh.get("videoStatus") || "").toUpperCase();
      const rawActiveTimer = fresh.get("videoActiveSinceMs");
      const hasActiveTimer = typeof rawActiveTimer === "number" && Number.isFinite(rawActiveTimer);
      const shouldCloseStatus = !activeVideo && (hasActiveTimer || storedStatus === "ACTIVE" || (storedStatus === "WAITING" && Object.keys(active).length === 0));
      if (!hadStaleEntries && !(activeVideo && !hasActiveTimer) && !shouldCloseStatus) return;

      transaction.set(candidate.ref, {
        videoParticipants: active,
        videoActiveSinceMs: activeVideo ? (hasActiveTimer ? rawActiveTimer : nowMs) : null,
        videoStatus: activeVideo ? "ACTIVE" : Object.keys(active).length ? "WAITING" : "ENDED",
        videoPresenceReconciledAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      didReconcile = true;
    });
    if (didReconcile) reconciled += 1;
  }

  return { checked: snapshot.size, reconciled };
}
