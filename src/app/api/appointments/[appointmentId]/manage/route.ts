import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { createUserNotification } from "@/lib/notifications.server";

const HOLD_MINUTES = 20;

function json(request: Request, body: Record<string, unknown>) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "appointment-management-failed";
  const message = error instanceof ApiRequestError ? error.message : "Le rendez-vous ne peut pas être modifié pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA appointment management failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request, { params }: { params: Promise<{ appointmentId: string }> }) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "manage-appointments", limit: 12, windowMs: 5 * 60_000 });
    const { appointmentId } = await params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) throw new ApiRequestError(400, "invalid-appointment", "La référence du rendez-vous n’est pas valide.");
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande n’est pas valide.");
    const input = body as Record<string, unknown>;
    const action = input.action;
    if (action === "cancel") throw new ApiRequestError(409, "appointment-cancellation-disabled", "Les rendez-vous ne peuvent pas être annulés. Contactez NEXA en cas de difficulté.");
    if (action !== "reschedule" && action !== "dismiss-expired") throw new ApiRequestError(400, "invalid-appointment-action", "Choisissez une action valide.");
    const newSlotId = typeof input.slotId === "string" ? input.slotId.trim() : "";
    if (action === "reschedule" && !/^[a-f0-9]{32}$/.test(newSlotId)) throw new ApiRequestError(400, "invalid-slot", "Choisissez un autre créneau disponible.");

    const db = getFirebaseAdminDb();
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const preview = await appointmentRef.get();
    if (!preview.exists || preview.get("patientUid") !== user.uid) throw new ApiRequestError(404, "appointment-not-found", "Ce rendez-vous n’est pas accessible.");
    const previewSlotId = typeof preview.get("slotId") === "string" ? preview.get("slotId") as string : "";
    const oldSlotRef = previewSlotId ? db.collection("providerAvailabilitySlots").doc(previewSlotId) : null;
    const newSlotRef = action === "reschedule" ? db.collection("providerAvailabilitySlots").doc(newSlotId) : null;
    const auditRef = db.collection("adminAuditLogs").doc();
    const holdExpiresAt = Date.now() + HOLD_MINUTES * 60_000;
    let resultStatus = "";

    await db.runTransaction(async (transaction) => {
      const appointmentSnapshot = await transaction.get(appointmentRef);
      if (!appointmentSnapshot.exists || appointmentSnapshot.get("patientUid") !== user.uid) throw new ApiRequestError(404, "appointment-not-found", "Ce rendez-vous n’est pas accessible.");
      const appointment = appointmentSnapshot.data() || {};
      const status = String(appointment.status || "").toUpperCase();
      const paymentStatus = String(appointment.paymentStatus || "").toUpperCase();
      if (action === "reschedule" && appointment.bookingType === "home_visit") throw new ApiRequestError(409, "home-visit-reschedule-coordination-required", "Une visite à domicile doit être reprogrammée après accord entre le patient et le médecin, avec l’aide de NEXA.");
      if (action === "dismiss-expired") {
        if (appointment.dismissedByPatient === true) { resultStatus = "DISMISSED"; return; }
        const holdExpiresAt = Number(appointment.holdExpiresAt);
        const expired = (status === "PAYMENT_EXPIRED" && paymentStatus === "EXPIRED") ||
          (status === "PENDING_PAYMENT" && paymentStatus === "PENDING" && Number.isFinite(holdExpiresAt) && holdExpiresAt > 0 && holdExpiresAt <= Date.now());
        if (!expired) throw new ApiRequestError(409, "appointment-not-expired", "Seul un rendez-vous dont le paiement a expiré peut être masqué.");
        transaction.set(appointmentRef, {
          status: "PAYMENT_EXPIRED",
          paymentStatus: "EXPIRED",
          requiresNewSlot: true,
          dismissedByPatient: true,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.create(auditRef, { actorUid: user.uid, action: "patient_dismissed_expired_appointment", resource: `appointments/${appointmentId}`, createdAt: FieldValue.serverTimestamp() });
        resultStatus = "DISMISSED";
        return;
      }
      if (action === "reschedule" && appointment.slotId === newSlotId && status === "PENDING_PAYMENT" && paymentStatus === "PENDING") { resultStatus = status; return; }
      if (String(appointment.slotId || "") !== previewSlotId) throw new ApiRequestError(409, "appointment-changed", "Le rendez-vous vient de changer. Actualisez votre espace puis réessayez.");
      if (action === "reschedule" && status === "PENDING_PAYMENT" && paymentStatus === "PENDING") {
        if (!newSlotRef || newSlotId === appointment.slotId) throw new ApiRequestError(400, "same-slot", "Choisissez un créneau différent de celui réservé.");
        const [oldSlotSnapshot, newSlotSnapshot] = await Promise.all([
          oldSlotRef ? transaction.get(oldSlotRef) : Promise.resolve(null),
          transaction.get(newSlotRef),
        ]);
        if (!newSlotSnapshot?.exists || newSlotSnapshot.get("providerUid") !== appointment.providerUid) throw new ApiRequestError(404, "slot-not-found", "Ce créneau n’est plus disponible.");
        const newSlot = newSlotSnapshot.data() || {};
        const startsAtMs = Date.parse(String(newSlot.startsAt || ""));
        const endsAtMs = Date.parse(String(newSlot.endsAt || ""));
        const expiredHold = newSlot.status === "held" && Number(newSlot.holdExpiresAt) <= Date.now();
        if (!Number.isFinite(startsAtMs) || startsAtMs <= Date.now() || endsAtMs - startsAtMs !== 30 * 60_000 || (newSlot.status !== "available" && !expiredHold)) {
          throw new ApiRequestError(409, "slot-unavailable", "Ce créneau vient d’être réservé ou n’est plus valide.");
        }
        if (oldSlotRef && oldSlotSnapshot?.exists && oldSlotSnapshot.get("appointmentId") === appointmentId && oldSlotSnapshot.get("status") === "held") {
          transaction.set(oldSlotRef, {
            status: "available", appointmentId: null, patientUid: FieldValue.delete(),
            holdExpiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        transaction.set(newSlotRef, {
          status: "held", patientUid: user.uid, appointmentId,
          holdExpiresAt, updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.set(appointmentRef, {
          slotId: newSlotId,
          startsAt: new Date(startsAtMs).toISOString(),
          endsAt: new Date(endsAtMs).toISOString(),
          holdExpiresAt,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        resultStatus = "PENDING_PAYMENT";
        transaction.create(auditRef, { actorUid: user.uid, action: "appointment_rescheduled_before_payment", resource: `appointments/${appointmentId}`, createdAt: FieldValue.serverTimestamp() });
        return;
      }
      if (action === "reschedule") throw new ApiRequestError(409, "reschedule-not-allowed", "Seul un rendez-vous en attente de paiement peut changer d’horaire depuis cet espace.");
      throw new ApiRequestError(400, "invalid-appointment-action", "Choisissez une action valide.");
    });
    if (action === "dismiss-expired") return json(request, { ok: true, status: resultStatus });
    const providerUid = typeof preview.get("providerUid") === "string" ? preview.get("providerUid") as string : "";
    const eventKey = `appointment:${appointmentId}:reschedule:${newSlotId}`;
    const notices = [createUserNotification({
      uid: user.uid, eventKey, type: "appointment_rescheduled",
      title: "Horaire du rendez-vous modifié",
      body: "Votre nouveau créneau est réservé pendant 20 minutes pour le paiement.",
      url: "/espace", appointmentId,
    })];
    if (providerUid) notices.push(createUserNotification({
      uid: providerUid, eventKey, type: "appointment_rescheduled",
      title: "Horaire modifié",
      body: "Un patient a déplacé un rendez-vous en attente de paiement.",
      url: "/professionnels/espace", appointmentId,
    }));
    await Promise.all(notices);
    return json(request, { ok: true, status: resultStatus });
  } catch (error) { return failure(request, error); }
}
