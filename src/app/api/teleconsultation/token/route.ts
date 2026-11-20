import { createHash } from "node:crypto";
import AgoraToken from "agora-token";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import {
  getTeleconsultationVideoLimitSeconds,
  recordTeleconsultationPresence,
} from "@/lib/teleconsultation/presence.server";

const AGORA_CREDENTIAL_PATTERN = /^[0-9a-f]{32}$/i;
const { RtcRole, RtcTokenBuilder } = AgoraToken;
// Keep credentials short-lived so a completed or revoked session loses access quickly.
const AGORA_TOKEN_TTL_SECONDS = 60;

class TeleconsultationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "TeleconsultationError";
  }
}

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError || error instanceof TeleconsultationError ? error.status : 500;
  const code = error instanceof ApiRequestError || error instanceof TeleconsultationError ? error.code : "video-session-unavailable";
  const message = error instanceof ApiRequestError || error instanceof TeleconsultationError ? error.message : "La salle vidéo ne peut pas être ouverte pour le moment.";
  if (!(error instanceof ApiRequestError) && !(error instanceof TeleconsultationError)) {
    console.error("NEXA Agora token generation failed", error instanceof Error ? error.name : "unknown-error");
  }
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function timestamp(value: unknown): number {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return (value.toDate() as Date).getTime();
  }
  if (typeof value === "number") return value;
  return Date.parse(String(value || ""));
}

function agoraUid(firebaseUid: string): number {
  const hash = createHash("sha256").update(firebaseUid).digest();
  return (hash.readUInt32BE(0) % 2_000_000_000) + 1;
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    const body = await request.json().catch(() => null);
    const appointmentId = body && typeof body === "object" && !Array.isArray(body) && typeof body.appointmentId === "string"
      ? body.appointmentId.trim().slice(0, 200)
      : "";
    const presenceAction = body && typeof body === "object" && !Array.isArray(body) && body.presenceAction === "join"
      ? "join"
      : "heartbeat";
    if (!appointmentId || !/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) {
      throw new TeleconsultationError(400, "appointment-required", "Un rendez-vous valide est requis.");
    }

    const appointmentRef = getFirebaseAdminDb().collection("appointments").doc(appointmentId);
    const appointmentSnapshot = await appointmentRef.get();
    if (!appointmentSnapshot.exists) throw new TeleconsultationError(404, "appointment-not-found", "Consultation introuvable.");
    const appointment = appointmentSnapshot.data() || {};
    if (appointment.patientUid !== user.uid && appointment.providerUid !== user.uid) {
      throw new TeleconsultationError(403, "forbidden", "Vous ne participez pas à cette séance.");
    }
    if (String(appointment.providerType || "").toLowerCase() !== "doctor" || !["teleconsultation", "doctor_proposed_appointment"].includes(String(appointment.bookingType || ""))) {
      throw new TeleconsultationError(409, "video-not-available", "La vidéo est réservée aux consultations médecin.");
    }
    if (appointment.paymentStatus !== "PAID") {
      throw new TeleconsultationError(409, "appointment-not-paid", "Le paiement confirmé est requis pour ouvrir la séance vidéo.");
    }
    if (!["DOCTOR_ACCEPTED", "IN_PROGRESS"].includes(String(appointment.status || "").toUpperCase())) {
      throw new TeleconsultationError(409, "session-not-active", "La séance vidéo est accessible après acceptation du médecin et à l’heure prévue.");
    }
    const sessionStatus = String(appointment.sessionStatus || "").toUpperCase();
    if (["TERMINATED", "INTERACTIVE_TIME_EXPIRED"].includes(sessionStatus)) {
      throw new TeleconsultationError(409, "session-not-interactive", "La partie interactive de cette séance est terminée.");
    }

    const startsAt = timestamp(appointment.startsAt);
    if (!Number.isFinite(startsAt)) throw new TeleconsultationError(409, "invalid-consultation-slot", "Le créneau de consultation est invalide.");
    if (Date.now() < startsAt) throw new TeleconsultationError(403, "consultation-not-started", "La vidéo ne peut démarrer qu’à l’heure prévue.");

    const now = Date.now();
    const configuredInteractiveEnd = timestamp(appointment.interactiveEndsAt);
    const scheduledEnd = timestamp(appointment.endsAt);
    const interactiveEndsAt = Number.isFinite(configuredInteractiveEnd) && configuredInteractiveEnd > 0
      ? configuredInteractiveEnd
      : Number.isFinite(scheduledEnd) ? scheduledEnd + 15 * 60_000 : Number.NaN;
    if (Number.isFinite(interactiveEndsAt) && interactiveEndsAt > 0 && now >= interactiveEndsAt) {
      await appointmentRef.set({
        sessionStatus: "INTERACTIVE_TIME_EXPIRED",
        videoStatus: "ENDED",
        videoParticipants: {},
        videoActiveSinceMs: null,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      throw new TeleconsultationError(409, "interactive-time-expired", "La durée interactive de la séance est terminée.");
    }

    const appId = (process.env.AGORA_APP_ID || "").trim();
    const appCertificate = (process.env.AGORA_APP_CERTIFICATE || "").trim();
    if (!AGORA_CREDENTIAL_PATTERN.test(appId) || !AGORA_CREDENTIAL_PATTERN.test(appCertificate)) {
      throw new TeleconsultationError(503, "video-not-configured", "Le service vidéo n’est pas encore configuré sur le serveur.");
    }

    const presence = await recordTeleconsultationPresence(
      getFirebaseAdminDb(),
      { appointmentId, uid: user.uid, action: presenceAction },
    );
    if (presence.expired) {
      if (presence.sessionStatus === "INTERACTIVE_TIME_EXPIRED") {
        throw new TeleconsultationError(409, "video-quota-exhausted", "La durée vidéo incluse dans cette consultation est terminée.");
      }
      throw new TeleconsultationError(409, "session-not-active", "La séance vidéo est terminée.");
    }
    const videoLimitSeconds = getTeleconsultationVideoLimitSeconds(appointment);
    const videoConsumedSeconds = presence.videoConsumedSeconds;
    const videoRemainingSeconds = presence.videoRemainingSeconds;
    if (!videoRemainingSeconds) throw new TeleconsultationError(409, "video-quota-exhausted", "La durée vidéo incluse dans cette consultation est terminée.");

    const safeAppointmentId = appointmentId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
    const channelName = `nexa_${safeAppointmentId}`;
    const uid = agoraUid(user.uid);
    const interactiveSecondsRemaining = Number.isFinite(interactiveEndsAt) && interactiveEndsAt > 0
      ? Math.floor((interactiveEndsAt - Date.now()) / 1000)
      : AGORA_TOKEN_TTL_SECONDS;
    const ttlSeconds = Math.max(1, Math.floor(Math.min(
      AGORA_TOKEN_TTL_SECONDS,
      videoRemainingSeconds,
      interactiveSecondsRemaining,
    )));
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      uid,
      RtcRole.PUBLISHER,
      ttlSeconds,
      ttlSeconds,
    );
    if (!token) throw new TeleconsultationError(503, "video-token-generation-failed", "Impossible d’ouvrir la salle vidéo pour le moment.");

    return json(request, {
      ok: true,
      appId,
      token,
      channelName,
      uid,
      expiresAt,
      videoLimitSeconds,
      videoConsumedSeconds,
      videoRemainingSeconds,
      videoStatus: presence.videoStatus,
    });
  } catch (error) {
    return failure(request, error);
  }
}
