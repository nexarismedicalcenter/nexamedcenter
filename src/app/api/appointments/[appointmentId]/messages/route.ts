import { Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { createUserNotification } from "@/lib/notifications.server";
import { isValidAppointmentId, loadSessionForParticipant, SESSION_MESSAGE_RETENTION_MS } from "@/lib/teleconsultation/session-messages.server";

function json(request: Request, body: Record<string, unknown>) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "session-messages-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "La messagerie de cette consultation n’est pas accessible pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA session messages request failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function iso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).toISOString();
  return typeof value === "string" ? value : null;
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request, { params }: { params: Promise<{ appointmentId: string }> }) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "session-message-read", limit: 30, windowMs: 60_000 });
    const { appointmentId } = await params;
    if (!isValidAppointmentId(appointmentId)) throw new ApiRequestError(400, "invalid-appointment", "La référence de consultation n’est pas valide.");
    const appointment = await loadSessionForParticipant(appointmentId, user.uid, false);
    const snapshot = await getFirebaseAdminDb().collection("sessionMessages")
      .where("appointmentId", "==", appointmentId)
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();
    const now = Date.now();
    const messages = snapshot.docs.map((doc) => {
      const item = doc.data();
      return {
        id: doc.id,
        senderUid: item.senderUid,
        kind: ["photo", "voice"].includes(String(item.kind)) && item.antivirusStatus === "CLEAN" ? item.kind : "text",
        text: typeof item.text === "string" ? item.text : "",
        ...(item.antivirusStatus === "CLEAN" && typeof item.fileName === "string" ? { fileName: item.fileName } : {}),
        ...(item.antivirusStatus === "CLEAN" && Number.isSafeInteger(item.durationSeconds) ? { durationSeconds: item.durationSeconds } : {}),
        createdAt: iso(item.createdAt),
      };
    }).filter((item) => {
      const stored = snapshot.docs.find((doc) => doc.id === item.id)?.get("expiresAt");
      const expiry = stored && typeof stored === "object" && "toMillis" in stored && typeof stored.toMillis === "function" ? (stored.toMillis() as number) : Number.POSITIVE_INFINITY;
      return expiry > now;
    }).reverse();
    const interactiveEndsAt = Date.parse(String(appointment.interactiveEndsAt || ""));
    const canSend = appointment.paymentStatus === "PAID" && String(appointment.status).toUpperCase() === "IN_PROGRESS" && !["TERMINATED", "INTERACTIVE_TIME_EXPIRED"].includes(String(appointment.sessionStatus || "").toUpperCase()) && Number.isFinite(interactiveEndsAt) && Date.now() < interactiveEndsAt;
    const patientMessages = await getFirebaseAdminDb().collection("sessionMessages").where("appointmentId", "==", appointmentId).where("senderUid", "==", appointment.patientUid).get();
    const activePatientMessages = patientMessages.docs.filter((doc) => {
      const expiry = doc.get("expiresAt");
      return !(expiry && typeof expiry === "object" && "toMillis" in expiry && typeof expiry.toMillis === "function") || (expiry.toMillis() as number) > now;
    });
    const rights = appointment.consultationRights && typeof appointment.consultationRights === "object" ? appointment.consultationRights as Record<string, unknown> : {};
    const isPatient = user.uid === appointment.patientUid;
    const boundedLimit = (value: unknown) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(20, Math.floor(Number(value)))) : 0;
    const mediaLimits = {
      maxPhotos: isPatient ? boundedLimit(rights.maxPhotos) : null,
      maxVoiceMessages: isPatient ? boundedLimit(rights.maxVoiceMessages) : null,
      maxVoiceSeconds: Math.max(1, Math.min(300, Math.floor(Number(rights.maxVoiceSeconds) || 60))),
      photosUsed: activePatientMessages.filter((doc) => doc.get("kind") === "photo" && doc.get("antivirusStatus") === "CLEAN").length,
      voiceMessagesUsed: activePatientMessages.filter((doc) => doc.get("kind") === "voice" && doc.get("antivirusStatus") === "CLEAN").length,
    };
    return json(request, { ok: true, messages, canSend, mediaLimits });
  } catch (error) { return failure(request, error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ appointmentId: string }> }) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    const { appointmentId } = await params;
    if (!isValidAppointmentId(appointmentId)) throw new ApiRequestError(400, "invalid-appointment", "La référence de consultation n’est pas valide.");
    await enforceUserRateLimit({ uid: user.uid, action: "session-text-message", limit: 40, windowMs: 5 * 60_000 });
    const body = await request.json().catch(() => null);
    const text = body && typeof body === "object" && !Array.isArray(body) && typeof body.text === "string"
      ? body.text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim().slice(0, 4000)
      : "";
    if (!text) throw new ApiRequestError(400, "message-required", "Écrivez un message avant de l’envoyer.");
    const appointment = await loadSessionForParticipant(appointmentId, user.uid, true);
    const recipientUid = user.uid === appointment.patientUid ? String(appointment.providerUid || "") : String(appointment.patientUid || "");
    if (!recipientUid) throw new ApiRequestError(409, "session-recipient-missing", "Le participant destinataire n’est pas disponible.");
    const db = getFirebaseAdminDb();
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const ref = db.collection("sessionMessages").doc();
    const createdAt = Timestamp.now();
    const expiresAt = Timestamp.fromMillis(createdAt.toMillis() + SESSION_MESSAGE_RETENTION_MS);
    await db.runTransaction(async (transaction) => {
      const providerRef = db.collection("providerProfiles").doc(String(appointment.providerUid || "_"));
      const [currentSnapshot, providerSnapshot] = await Promise.all([transaction.get(appointmentRef), transaction.get(providerRef)]);
      if (!currentSnapshot.exists) throw new ApiRequestError(404, "appointment-not-found", "Consultation introuvable.");
      const current = currentSnapshot.data() || {};
      const interactiveEndsAt = Date.parse(String(current.interactiveEndsAt || ""));
      if (current.providerUid === user.uid && (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true)) {
        throw new ApiRequestError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à accéder à cette séance.");
      }
      if ((current.patientUid !== user.uid && current.providerUid !== user.uid) || current.providerUid !== appointment.providerUid || current.patientUid !== appointment.patientUid || current.providerType !== "doctor" || current.paymentStatus !== "PAID" || current.status !== "IN_PROGRESS" || ["TERMINATED", "INTERACTIVE_TIME_EXPIRED"].includes(String(current.sessionStatus || "").toUpperCase()) || !Number.isFinite(interactiveEndsAt) || Date.now() >= interactiveEndsAt) {
        throw new ApiRequestError(409, "session-not-interactive", "L’envoi de messages est fermé pour cette séance.");
      }
      transaction.create(ref, {
        appointmentId,
        patientUid: current.patientUid,
        providerUid: current.providerUid,
        senderUid: user.uid,
        kind: "text",
        text,
        createdAt,
        expiresAt,
      });
    });
    await createUserNotification({
      uid: recipientUid,
      eventKey: `session-message:${ref.id}`,
      type: "session_message",
      title: "Nouveau message de consultation",
      body: "Un message vous attend dans votre séance NEXA.",
      url: `/teleconsultation?appointmentId=${encodeURIComponent(appointmentId)}`,
      appointmentId,
    });
    return json(request, { ok: true, message: { id: ref.id, senderUid: user.uid, text, createdAt: createdAt.toDate().toISOString() } });
  } catch (error) { return failure(request, error); }
}
