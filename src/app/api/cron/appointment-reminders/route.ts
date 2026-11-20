import { timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { userNotificationId } from "@/lib/notifications.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET || "";
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!secret || token.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(secret));
}

function reminderFor(startsAt: number, now: number): { key: string; label: string } | null {
  const minutes = (startsAt - now) / 60_000;
  if (minutes > 0 && minutes <= 10) return { key: "10m", label: "dans quelques minutes" };
  if (minutes > 50 && minutes <= 60) return { key: "1h", label: "dans environ une heure" };
  if (minutes > 23 * 60 + 50 && minutes <= 24 * 60) return { key: "24h", label: "demain" };
  return null;
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ ok: false, error: "Rappels non configurés." }, { status: 503 });
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "Accès refusé." }, { status: 401 });
  try {
    const db = getFirebaseAdminDb();
    const now = Date.now();
    const horizon = new Date(now + 24 * 60 * 60_000).toISOString();
    const snapshot = await db.collection("appointments")
      .where("startsAt", ">=", new Date(now).toISOString())
      .where("startsAt", "<=", horizon)
      .orderBy("startsAt")
      .limit(500)
      .get();
    let sent = 0;
    for (const candidate of snapshot.docs) {
      const appointment = candidate.data();
      const startsAt = Date.parse(String(appointment.startsAt || ""));
      const reminder = reminderFor(startsAt, now);
      if (!reminder || appointment.providerType !== "doctor" || appointment.paymentStatus !== "PAID" || !["CONFIRMED", "DOCTOR_ACCEPTED"].includes(String(appointment.status || ""))) continue;
      const patientUid = String(appointment.patientUid || "");
      const providerUid = String(appointment.providerUid || "");
      if (!patientUid || !providerUid) continue;
      let claimed = false;
      const marker = `reminder${reminder.key}SentAt`;
      const patientNotificationRef = db.collection("userNotifications").doc(userNotificationId(patientUid, `appointment:${candidate.id}:reminder:${reminder.key}`));
      const providerNotificationRef = db.collection("userNotifications").doc(userNotificationId(providerUid, `appointment:${candidate.id}:reminder:${reminder.key}`));
      await db.runTransaction(async (transaction) => {
        const [fresh, patientNotification, providerNotification] = await Promise.all([
          transaction.get(candidate.ref), transaction.get(patientNotificationRef), transaction.get(providerNotificationRef),
        ]);
        if (!fresh.exists || fresh.get(marker) || fresh.get("providerType") !== "doctor" || fresh.get("paymentStatus") !== "PAID" || !["CONFIRMED", "DOCTOR_ACCEPTED"].includes(String(fresh.get("status") || ""))) return;
        const notification = (uid: string, url: string) => ({
          uid,
          type: "appointment_reminder",
          title: "Rappel de rendez-vous",
          body: `Votre rendez-vous NEXA est prévu ${reminder.label}.`,
          url,
          context: { appointmentId: candidate.id },
          read: false,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
        });
        if (!patientNotification.exists) transaction.create(patientNotificationRef, notification(patientUid, "/espace"));
        if (!providerNotification.exists) transaction.create(providerNotificationRef, notification(providerUid, "/professionnels/espace"));
        transaction.update(candidate.ref, { [marker]: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
        claimed = true;
      });
      if (claimed) sent += 1;
    }
    return NextResponse.json({ ok: true, checked: snapshot.size, remindersProcessed: sent }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    console.error("NEXA appointment reminder job failed", error instanceof Error ? error.name : "unknown-error");
    return NextResponse.json({ ok: false, error: "Les rappels n’ont pas pu être traités." }, { status: 500, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
