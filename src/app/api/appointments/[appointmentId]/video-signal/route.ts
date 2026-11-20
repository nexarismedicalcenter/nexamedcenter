import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { hasActiveConsultationClinicalAccess } from "@/lib/clinical-record/access";
import { createUserNotification } from "@/lib/notifications.server";
import {
  parseVideoCallAttempts,
  recordVideoCallAttempt,
  reconcileExpiredTeleconsultationCall,
  setVideoCallAttemptStatus,
  summarizeVideoCallAttempts,
  VIDEO_CALL_RING_TTL_MS,
} from "@/lib/teleconsultation/missed-calls.server";

type SignalStatus = "IDLE" | "RINGING" | "CONNECTING" | "ACTIVE" | "REFUSED" | "MISSED" | "ENDED";
type VideoSignal = { id: string; status: SignalStatus; by: "self" | "peer"; updatedAt: string };
type RouteContext = { params: Promise<{ appointmentId: string }> };

function response(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "video-signal-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "L’invitation vidéo est momentanément indisponible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA video signal failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function validAppointmentId(value: string) {
  return /^[A-Za-z0-9_-]{10,200}$/.test(value);
}

function timestamp(value: unknown): number {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return (value.toDate() as Date).getTime();
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(String(value || ""));
}

function publicSignal(value: unknown, uid: string): VideoSignal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const status = String(data.status || "").toUpperCase();
  if (!["RINGING", "CONNECTING", "ACTIVE", "REFUSED", "MISSED", "ENDED"].includes(status)) return null;
  const updatedAtMs = timestamp(data.updatedAt);
  if (!Number.isFinite(updatedAtMs)) return null;
  return {
    id: typeof data.id === "string" ? data.id.slice(0, 80) : "",
    status: status as Exclude<SignalStatus, "IDLE">,
    by: data.by === uid ? "self" : "peer",
    updatedAt: new Date(updatedAtMs).toISOString(),
  };
}

async function readAppointmentId(context: RouteContext) {
  const { appointmentId } = await context.params;
  if (!validAppointmentId(appointmentId)) throw new ApiRequestError(400, "invalid-appointment", "Le rendez-vous n’est pas valide.");
  return appointmentId;
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "teleconsultation-video-signal-read", limit: 60, windowMs: 60_000 });
    const appointmentId = await readAppointmentId(context);
    const db = getFirebaseAdminDb();
    const preview = await db.collection("appointments").doc(appointmentId).get();
    if (!preview.exists || (preview.get("patientUid") !== user.uid && preview.get("providerUid") !== user.uid)) {
      throw new ApiRequestError(404, "appointment-not-found", "Consultation introuvable.");
    }
    const appointment = await db.collection("appointments").doc(appointmentId).get();
    if (!appointment.exists) throw new ApiRequestError(404, "appointment-not-found", "Consultation introuvable.");
    const data = appointment.data() || {};
    if (data.patientUid !== user.uid && data.providerUid !== user.uid) throw new ApiRequestError(404, "appointment-not-found", "Consultation introuvable.");
    return response(request, {
      ok: true,
      videoSignal: publicSignal(data.videoSignal, user.uid),
      callAttempts: summarizeVideoCallAttempts(parseVideoCallAttempts(data.videoCallAttempts)),
      noShowOutcome: typeof data.noShowOutcome === "string" ? data.noShowOutcome : null,
      canProposeFollowUp: data.providerUid === user.uid && hasActiveConsultationClinicalAccess(data),
    });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "teleconsultation-video-signal-write", limit: 12, windowMs: 60_000 });
    const appointmentId = await readAppointmentId(context);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 4_096) throw new ApiRequestError(413, "request-too-large", "La demande est trop volumineuse.");
    let body: unknown;
    try { body = JSON.parse(raw); } catch { throw new ApiRequestError(400, "invalid-request", "La demande n’est pas valide."); }
    const action = body && typeof body === "object" && !Array.isArray(body)
      ? String((body as Record<string, unknown>).action || "").toLowerCase()
      : "";
    if (!["invite", "accept", "refuse", "connected", "end", "timeout"].includes(action)) throw new ApiRequestError(400, "invalid-video-signal", "Action d’appel vidéo invalide.");

    const db = getFirebaseAdminDb();
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const preview = await appointmentRef.get();
    if (!preview.exists || (preview.get("patientUid") !== user.uid && preview.get("providerUid") !== user.uid)) {
      throw new ApiRequestError(404, "appointment-not-found", "Consultation introuvable.");
    }
    if (action === "timeout") {
      await reconcileExpiredTeleconsultationCall(db, appointmentId);
      const fresh = await appointmentRef.get();
      const data = fresh.data() || {};
      return response(request, {
        ok: true,
        videoSignal: publicSignal(data.videoSignal, user.uid),
        callAttempts: summarizeVideoCallAttempts(parseVideoCallAttempts(data.videoCallAttempts)),
        noShowOutcome: typeof data.noShowOutcome === "string" ? data.noShowOutcome : null,
      });
    }
    await reconcileExpiredTeleconsultationCall(db, appointmentId);
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    type SignalOutcome = {
      signal: Record<string, unknown>;
      attempts: ReturnType<typeof parseVideoCallAttempts>;
      notification: { uid: string; action: string; title: string; body: string } | null;
    };
    const outcome = await db.runTransaction<SignalOutcome>(async (transaction) => {
      const snapshot = await transaction.get(appointmentRef);
      if (!snapshot.exists) throw new ApiRequestError(404, "appointment-not-found", "Consultation introuvable.");
      const appointment = snapshot.data() || {};
      const patientUid = typeof appointment.patientUid === "string" ? appointment.patientUid : "";
      const providerUid = typeof appointment.providerUid === "string" ? appointment.providerUid : "";
      if (!patientUid || !providerUid || (user.uid !== patientUid && user.uid !== providerUid)) {
        throw new ApiRequestError(404, "appointment-not-found", "Consultation introuvable.");
      }
      if (String(appointment.providerType || "").toLowerCase() !== "doctor" || !["teleconsultation", "doctor_proposed_appointment"].includes(String(appointment.bookingType || "")) || appointment.paymentStatus !== "PAID" || !["DOCTOR_ACCEPTED", "IN_PROGRESS"].includes(String(appointment.status || "").toUpperCase())) {
        throw new ApiRequestError(409, "session-not-active", "L’appel vidéo est disponible après acceptation du médecin pour une consultation payée.");
      }
      const configuredEndTime = timestamp(appointment.interactiveEndsAt);
      const scheduledEndTime = timestamp(appointment.endsAt);
      const endTime = Number.isFinite(configuredEndTime) && configuredEndTime > 0
        ? configuredEndTime
        : Number.isFinite(scheduledEndTime) ? scheduledEndTime + 15 * 60_000 : Number.NaN;
      const startTime = timestamp(appointment.startsAt);
      if (appointment.sessionStatus === "TERMINATED" || appointment.sessionStatus === "INTERACTIVE_TIME_EXPIRED" || !Number.isFinite(endTime) || now >= endTime || !Number.isFinite(startTime) || now < startTime) {
        throw new ApiRequestError(409, "session-not-interactive", "La fenêtre interactive de cette séance est terminée ou n’a pas commencé.");
      }

      const current = appointment.videoSignal && typeof appointment.videoSignal === "object"
        ? appointment.videoSignal as Record<string, unknown>
        : {};
      const currentStatus = String(current.status || "").toUpperCase();
      const currentUpdatedAt = timestamp(current.updatedAt);
      const currentIsFresh = Number.isFinite(currentUpdatedAt) && now - currentUpdatedAt <= VIDEO_CALL_RING_TTL_MS;
      const participantUid = user.uid === patientUid ? providerUid : patientUid;
      const attempts = parseVideoCallAttempts(appointment.videoCallAttempts);

      if (action === "invite") {
        if (appointment.videoStatus === "ACTIVE") throw new ApiRequestError(409, "video-call-already-active", "Un appel vidéo est déjà actif.");
        if (["RINGING", "CONNECTING"].includes(currentStatus) && currentIsFresh) {
          if (currentStatus === "RINGING" && current.by === user.uid && typeof current.id === "string") return { signal: current, attempts, notification: null };
          throw new ApiRequestError(409, "video-call-already-pending", "Un appel vidéo est déjà en attente ou en cours.");
        }
        const next = { id: randomUUID(), status: "RINGING", by: user.uid, updatedAt: nowIso };
        const nextAttempts = recordVideoCallAttempt(appointment, { uid: user.uid, nowMs: now, signalId: next.id });
        transaction.set(appointmentRef, { videoSignal: next, videoCallAttempts: nextAttempts, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return {
          signal: next,
          attempts: nextAttempts,
          notification: { uid: participantUid, action: "incoming", title: "Appel vidéo entrant", body: "Un participant à votre séance vous invite à rejoindre l’appel vidéo." },
        };
      }

      if (action === "accept" || action === "refuse") {
        if (currentStatus !== "RINGING" || !currentIsFresh || current.by === user.uid) {
          throw new ApiRequestError(409, "video-invitation-expired", "Cette invitation n’est plus disponible.");
        }
        const next = { ...current, status: action === "accept" ? "CONNECTING" : "REFUSED", updatedAt: nowIso };
        const nextAttempts = setVideoCallAttemptStatus(attempts, String(current.id || ""), action === "accept" ? "ACCEPTED" : "REFUSED", now);
        transaction.set(appointmentRef, { videoSignal: next, videoCallAttempts: nextAttempts, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return {
          signal: next,
          attempts: nextAttempts,
          notification: action === "refuse"
            ? { uid: participantUid, action: "refused", title: "Appel vidéo refusé", body: "L’autre participant ne peut pas rejoindre l’appel pour le moment." }
            : { uid: participantUid, action: "accepted", title: "Appel vidéo accepté", body: "L’autre participant a accepté l’invitation vidéo." },
        };
      }

      if (action === "connected") {
        const presence = appointment.videoParticipants && typeof appointment.videoParticipants === "object"
          ? appointment.videoParticipants as Record<string, unknown>
          : {};
        const hasBothParticipants = [patientUid, providerUid].every((uid) => {
          const entry = presence[uid];
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
          const lastSeenAtMs = Number((entry as Record<string, unknown>).lastSeenAtMs);
          return Number.isFinite(lastSeenAtMs) && lastSeenAtMs <= now && now - lastSeenAtMs < 30_000;
        });
        if (!hasBothParticipants) throw new ApiRequestError(409, "video-call-not-connected", "Les deux participants doivent rejoindre la salle vidéo avant de confirmer l’appel.");
        const connectedParticipants = appointment.videoConnectedParticipants && typeof appointment.videoConnectedParticipants === "object" && !Array.isArray(appointment.videoConnectedParticipants)
          ? { ...(appointment.videoConnectedParticipants as Record<string, unknown>) }
          : {};
        connectedParticipants[user.uid] = now;
        const bothConnected = [patientUid, providerUid].every((uid) => {
          const connectedAt = Number(connectedParticipants[uid]);
          return Number.isFinite(connectedAt) && connectedAt <= now && now - connectedAt < 30_000;
        });
        const next = {
          id: typeof current.id === "string" ? current.id : randomUUID(),
          status: bothConnected ? "ACTIVE" : "CONNECTING",
          by: typeof current.by === "string" ? current.by : user.uid,
          updatedAt: nowIso,
        };
        const nextAttempts = setVideoCallAttemptStatus(attempts, String(current.id || ""), "CONNECTED", now);
        transaction.set(appointmentRef, {
          videoSignal: next,
          videoConnectedParticipants: connectedParticipants,
          videoCallAttempts: nextAttempts,
          ...(bothConnected && appointment.status === "DOCTOR_ACCEPTED" ? { status: "IN_PROGRESS", sessionStatus: "IN_PROGRESS" } : {}),
          videoStatus: bothConnected ? "ACTIVE" : "WAITING",
          videoActiveSinceMs: bothConnected ? now : null,
          ...(bothConnected && !timestamp(appointment.effectiveConsultationStartedAt) ? { effectiveConsultationStartedAt: FieldValue.serverTimestamp() } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return { signal: next, attempts: nextAttempts, notification: null };
      }

      const next = {
        id: typeof current.id === "string" ? current.id : randomUUID(),
        status: "ENDED",
        by: typeof current.by === "string" ? current.by : user.uid,
        endedBy: user.uid,
        updatedAt: nowIso,
      };
      const nextAttempts = setVideoCallAttemptStatus(attempts, String(current.id || ""), "ENDED", now);
      transaction.set(appointmentRef, {
        videoSignal: next,
        videoCallAttempts: nextAttempts,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return {
        signal: next,
        attempts: nextAttempts,
        notification: { uid: participantUid, action: "ended", title: "Appel vidéo terminé", body: "L’autre participant a quitté l’appel vidéo." },
      };
    });

    if (outcome.notification) {
      const signalId = typeof outcome.signal.id === "string" ? outcome.signal.id : "unknown";
      await createUserNotification({
        uid: outcome.notification.uid,
        eventKey: `video-call:${appointmentId}:${signalId}:${outcome.notification.action}`,
        type: `video_call_${outcome.notification.action}`,
        title: outcome.notification.title,
        body: outcome.notification.body,
        url: `/teleconsultation?appointmentId=${encodeURIComponent(appointmentId)}`,
        appointmentId,
      }).catch((error) => console.error("NEXA video call notification failed", error instanceof Error ? error.name : "unknown-error"));
    }
    return response(request, {
      ok: true,
      videoSignal: publicSignal(outcome.signal, user.uid),
      callAttempts: summarizeVideoCallAttempts(outcome.attempts),
      noShowOutcome: (await appointmentRef.get()).get("noShowOutcome") || null,
    });
  } catch (error) { return fail(request, error); }
}
