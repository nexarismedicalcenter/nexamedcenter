import "server-only";

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { getFirebaseAdminApp, getFirebaseAdminAuth, getFirebaseAdminDb } from "@/lib/firebase/admin";

export function userNotificationId(uid: string, eventKey: string): string {
  return createHash("sha256").update(`${uid}:${eventKey}`).digest("hex");
}

function safeNotificationUrl(value: string) {
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value.slice(0, 300) : "/espace";
}

async function deliverPushNotification(uid: string) {
  if (process.env.NODE_ENV !== "production" || !process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON) return;
  const db = getFirebaseAdminDb();
  const [preferences, registrations] = await Promise.all([
    db.collection("userNotificationPreferences").doc(uid).get(),
    db.collection("notificationPushRegistrations").where("uid", "==", uid).limit(100).get(),
  ]);
  if (preferences.get("pushEnabled") !== true || registrations.empty) return;
  const registrationDocs = registrations.docs.filter((doc) => typeof doc.get("fid") === "string");
  const fids = registrationDocs.map((doc) => String(doc.get("fid")));
  if (!fids.length) return;
  const response = await getMessaging(getFirebaseAdminApp()).sendEachForMulticast({
    fids,
    data: {
      title: "NEXA Medical Center",
      body: "Une nouvelle notification vous attend. Connectez-vous à votre espace NEXA pour la consulter.",
      url: "/espace",
    },
    webpush: { headers: { Urgency: "normal" } },
  });
  const staleCodes = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token"]);
  const staleDocs = response.responses.flatMap((result, index) => result.error && staleCodes.has(result.error.code) ? [registrationDocs[index].ref] : []);
  if (staleDocs.length) await Promise.all(staleDocs.map((ref) => ref.delete()));
}

async function deliverEmailNotification(uid: string, id: string) {
  const apiKey = process.env.RESEND_API_KEY || "";
  const from = process.env.NEXA_EMAIL_FROM?.trim() || "";
  if (!apiKey || !from || process.env.NODE_ENV !== "production") return;
  const senderAddress = from.match(/<([^<>]+)>/)?.[1] || from;
  if (/[\r\n]/.test(from) || !/^[^<>\s@]+@nexarishaiti\.com$/i.test(senderAddress)) return;

  const db = getFirebaseAdminDb();
  const preferences = await db.collection("userNotificationPreferences").doc(uid).get();
  if (preferences.get("emailEnabled") !== true) return;
  const user = await getFirebaseAdminAuth().getUser(uid);
  if (!user.email || !user.emailVerified) return;

  const siteUrl = "https://nexarishaiti.com/connexion";
  const text = `Une nouvelle notification vous attend dans votre espace NEXA Medical Center. Connectez-vous pour la consulter : ${siteUrl}`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": id,
    },
    body: JSON.stringify({
      from,
      to: [user.email],
      subject: "Une notification vous attend sur NEXA",
      text,
      html: `<p>Une nouvelle notification vous attend dans votre espace NEXA Medical Center.</p><p><a href="${siteUrl}">Connectez-vous pour la consulter.</a></p>`,
    }),
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`resend-http-${response.status}`);
}

export async function sendUserTransactionalEmail(input: { uid: string; eventKey: string; subject: string; text: string; html: string }): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY || "";
  const from = process.env.NEXA_EMAIL_FROM?.trim() || "";
  if (!apiKey || !from || process.env.NODE_ENV !== "production") return;
  const senderAddress = from.match(/<([^<>]+)>/)?.[1] || from;
  const subject = input.subject.replace(/[\r\n]/g, " ").slice(0, 140);
  if (/[\r\n]/.test(from) || !/^[^<>\s@]+@nexarishaiti\.com$/i.test(senderAddress) || !subject) return;
  const user = await getFirebaseAdminAuth().getUser(input.uid);
  if (!user.email || !user.emailVerified) return;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": input.eventKey.slice(0, 128) },
    body: JSON.stringify({ from, to: [user.email], subject, text: input.text.slice(0, 4000), html: input.html.slice(0, 8000) }),
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`resend-http-${response.status}`);
}

export async function createUserNotification(input: {
  uid: string;
  eventKey: string;
  type: string;
  title: string;
  body: string;
  url: string;
  appointmentId?: string;
}): Promise<void> {
  if (!input.uid || !input.eventKey) return;
  const db = getFirebaseAdminDb();
  const id = userNotificationId(input.uid, input.eventKey);
  const ref = db.collection("userNotifications").doc(id);
  try {
    const created = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (snapshot.exists) return false;
      transaction.create(ref, {
        uid: input.uid,
        type: input.type.slice(0, 80),
        title: input.title.slice(0, 180),
        body: input.body.slice(0, 500),
        url: safeNotificationUrl(input.url),
        ...(input.appointmentId ? { context: { appointmentId: input.appointmentId.slice(0, 200) } } : {}),
        read: false,
        readAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });
      return true;
    });
    if (created) {
      const deliveries = await Promise.allSettled([
        deliverPushNotification(input.uid),
        deliverEmailNotification(input.uid, id),
      ]);
      for (const delivery of deliveries) {
        if (delivery.status === "rejected") console.error("NEXA notification delivery failed", delivery.reason instanceof Error ? delivery.reason.name : "unknown-error");
      }
    }
  } catch (error) {
    // Notifications must not roll back the appointment action that triggered them.
    console.error("NEXA notification write failed", error instanceof Error ? error.name : "unknown-error");
  }
}
