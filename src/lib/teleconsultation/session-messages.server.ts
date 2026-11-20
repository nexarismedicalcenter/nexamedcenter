import "server-only";

import { ApiRequestError } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

export const SESSION_MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60_000;

export function isValidAppointmentId(value: string): boolean {
  return /^[A-Za-z0-9_-]{10,200}$/.test(value);
}

export async function loadSessionForParticipant(appointmentId: string, uid: string, sending: boolean) {
  const db = getFirebaseAdminDb();
  const snapshot = await db.collection("appointments").doc(appointmentId).get();
  if (!snapshot.exists) throw new ApiRequestError(404, "appointment-not-found", "Consultation introuvable.");
  const appointment = snapshot.data() || {};
  if (appointment.patientUid !== uid && appointment.providerUid !== uid) throw new ApiRequestError(403, "forbidden", "Vous ne participez pas à cette séance.");
  if (appointment.providerUid === uid) {
    const provider = await db.collection("providerProfiles").doc(uid).get();
    if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
      throw new ApiRequestError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à accéder à cette séance.");
    }
  }
  const status = String(appointment.status || "").toUpperCase();
  if (appointment.providerType !== "doctor" || !["IN_PROGRESS", "COMPLETED"].includes(status)) {
    throw new ApiRequestError(409, "session-not-active", "La messagerie est disponible pendant la séance et dans son historique récent.");
  }
  if (sending) {
    const interactiveEndsAt = Date.parse(String(appointment.interactiveEndsAt || ""));
    if (appointment.paymentStatus !== "PAID" || status !== "IN_PROGRESS" || ["TERMINATED", "INTERACTIVE_TIME_EXPIRED"].includes(String(appointment.sessionStatus || "").toUpperCase()) || !Number.isFinite(interactiveEndsAt) || Date.now() >= interactiveEndsAt) {
      throw new ApiRequestError(409, "session-not-interactive", "L’envoi de messages est fermé pour cette séance.");
    }
  }
  return appointment;
}
