"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { createHash } = require("node:crypto");

function getBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  if (!Buffer.isBuffer(req.rawBody)) return null;
  try {
    const value = JSON.parse(req.rawBody.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function isoDate(value) {
  if (value && typeof value.toDate === "function") return value.toDate().toISOString();
  return typeof value === "string" ? value : null;
}

function safeText(value, fallback, maximum) {
  return typeof value === "string" ? value.slice(0, maximum) : fallback;
}

function safePath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
    ? value.slice(0, 300)
    : "/espace-patient.html";
}

module.exports = function createNexaNotificationFunctions(dependencies) {
  const {
    db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit,
    setCors, fail, logger, adminAuth, messaging, RESEND_API_KEY,
  } = dependencies;
  const FUNCTION_REGION = "us-east4";

  function readResendKey() {
    try { return String(RESEND_API_KEY?.value() || "").trim(); } catch { return ""; }
  }

  function readVapidKey() {
    const value = typeof process.env.NEXA_WEB_PUSH_VAPID_KEY === "string"
      ? process.env.NEXA_WEB_PUSH_VAPID_KEY.trim()
      : "";
    return /^[A-Za-z0-9_-]{80,100}$/.test(value) ? value : "";
  }

  function emailSender() {
    const from = typeof process.env.NEXA_EMAIL_FROM === "string" ? process.env.NEXA_EMAIL_FROM.trim() : "";
    const address = from.match(/<([^<>]+)>/)?.[1] || from;
    return from && !/[\r\n]/.test(from) && /^[^<>\s@]+@nexarishaiti\.com$/i.test(address) ? from : "";
  }

  function reminderFor(startsAt, now) {
    const minutes = (startsAt - now) / 60_000;
    if (minutes > 0 && minutes <= 10) return { key: "10m", label: "dans quelques minutes" };
    if (minutes > 50 && minutes <= 60) return { key: "1h", label: "dans environ une heure" };
    if (minutes > 23 * 60 + 50 && minutes <= 24 * 60) return { key: "24h", label: "demain" };
    return null;
  }

  function reminderNotificationId(uid, appointmentId, reminderKey) {
    return createHash("sha256").update(uid + ":appointment:" + appointmentId + ":reminder:" + reminderKey).digest("hex");
  }

  const nexaUserNotifications = onRequest({ region: "us-east4" }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) {
      res.set("Allow", "GET, POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if (req.method === "POST" && ((Number(req.get("Content-Length")) || 0) > 4_096 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 4_096))) {
      return fail(res, 413, "request-too-large", "La requête de notification dépasse la taille autorisée.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      res.set("Cache-Control", "no-store, max-age=0");
      if (req.method === "GET") {
        await enforceUserRateLimit(user.uid, "read-nexa-notifications", 30, 5 * 60_000);
        const snapshot = await db.collection("userNotifications")
          .where("uid", "==", user.uid)
          .orderBy("createdAt", "desc")
          .limit(60)
          .get();
        const notifications = snapshot.docs.map((doc) => {
          const item = doc.data();
          return {
            id: doc.id,
            type: safeText(item.type, "information", 80),
            title: safeText(item.title, "Notification NEXA", 180),
            body: safeText(item.body, "", 500),
            url: safePath(item.url),
            read: item.read === true,
            createdAt: isoDate(item.createdAt),
          };
        });
        return res.status(200).json({ ok: true, notifications });
      }

      await enforceUserRateLimit(user.uid, "mark-nexa-notification-read", 60, 5 * 60_000);
      const body = getBody(req);
      const id = typeof body?.id === "string" ? body.id.trim() : "";
      if (!/^[a-f0-9]{64}$/.test(id)) throw new ApiError(400, "invalid-notification", "La notification n’est pas valide.");
      const notificationRef = db.collection("userNotifications").doc(id);
      await db.runTransaction(async (transaction) => {
        const notification = await transaction.get(notificationRef);
        if (!notification.exists || notification.get("uid") !== user.uid) {
          throw new ApiError(404, "notification-not-found", "La notification n’est pas accessible.");
        }
        if (notification.get("read") !== true) {
          transaction.update(notificationRef, { read: true, readAt: FieldValue.serverTimestamp() });
        }
      });
      return res.status(200).json({ ok: true, id, read: true });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA notifications request failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "notifications-unavailable", "Les notifications ne sont pas accessibles pour le moment.");
    }
  });

  const nexaNotificationPreferences = onRequest(
    { region: FUNCTION_REGION, secrets: [RESEND_API_KEY] },
    async (req, res) => {
      if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
      if (req.method === "OPTIONS") return res.status(204).end();
      if (!["GET", "POST"].includes(req.method)) {
        res.set("Allow", "GET, POST, OPTIONS");
        return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
      }
      if (req.method === "POST" && ((Number(req.get("Content-Length")) || 0) > 4_096 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 4_096))) {
        return fail(res, 413, "request-too-large", "La requête de préférences dépasse la taille autorisée.");
      }
      try {
        const user = await requireUser(req);
        await requireAppCheckToken(req);
        res.set("Cache-Control", "no-store, max-age=0");
        const preferencesRef = db.collection("userNotificationPreferences").doc(user.uid);
        if (req.method === "GET") {
          await enforceUserRateLimit(user.uid, "read-nexa-notification-preferences", 30, 5 * 60_000);
          const snapshot = await preferencesRef.get();
          const vapidKey = readVapidKey();
          return res.status(200).json({
            ok: true,
            preferences: {
              emailEnabled: snapshot.get("emailEnabled") === true,
              pushEnabled: snapshot.get("pushEnabled") === true,
            },
            emailAvailable: Boolean(readResendKey() && emailSender()),
            pushAvailable: Boolean(vapidKey),
            vapidKey,
          });
        }

        await enforceUserRateLimit(user.uid, "write-nexa-notification-preferences", 15, 60_000);
        const body = getBody(req);
        if (!body) throw new ApiError(400, "invalid-notification-preferences", "Les préférences envoyées ne sont pas valides.");
        const patch = {};
        if (typeof body.emailEnabled === "boolean") patch.emailEnabled = body.emailEnabled;
        if (typeof body.pushEnabled === "boolean") patch.pushEnabled = body.pushEnabled;
        if (!Object.keys(patch).length) throw new ApiError(400, "invalid-notification-preferences", "Choisissez une préférence à mettre à jour.");
        if (patch.emailEnabled === true) {
          if (!readResendKey() || !emailSender()) throw new ApiError(503, "email-notifications-unavailable", "Les alertes e-mail ne sont pas configurées.");
          const account = await adminAuth.getUser(user.uid);
          if (!account.email || account.emailVerified !== true) {
            throw new ApiError(403, "verified-email-required", "Confirmez votre adresse e-mail avant d’activer les alertes.");
          }
        }

        await db.runTransaction(async (transaction) => {
          const current = await transaction.get(preferencesRef);
          let registrations = null;
          if (patch.pushEnabled === true || patch.pushEnabled === false) {
            registrations = await transaction.get(
              db.collection("notificationPushRegistrations").where("uid", "==", user.uid).limit(100),
            );
          }
          if (patch.pushEnabled === true && (!readVapidKey() || registrations?.empty)) {
            throw new ApiError(409, "push-registration-required", "La configuration push et l’inscription de cet appareil sont nécessaires.");
          }
          if (patch.pushEnabled === false && registrations) {
            registrations.docs.forEach((registration) => transaction.delete(registration.ref));
          }
          transaction.set(preferencesRef, {
            emailEnabled: patch.emailEnabled ?? current.get("emailEnabled") === true,
            pushEnabled: patch.pushEnabled ?? current.get("pushEnabled") === true,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        });
        return res.status(200).json({ ok: true, preferences: patch });
      } catch (error) {
        if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
        logger.error("NEXA notification preferences request failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
        return fail(res, 500, "notification-preferences-unavailable", "Les préférences de notification ne sont pas disponibles.");
      }
    },
  );

  const nexaNotificationPushRegistrations = onRequest({ region: FUNCTION_REGION }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["POST", "DELETE"].includes(req.method)) {
      res.set("Allow", "POST, DELETE, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if ((Number(req.get("Content-Length")) || 0) > 4_096 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 4_096)) {
      return fail(res, 413, "request-too-large", "La requête d’inscription push dépasse la taille autorisée.");
    }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, req.method === "POST" ? "register-nexa-push-device" : "remove-nexa-push-device", 12, 60 * 60_000);
      res.set("Cache-Control", "no-store, max-age=0");
      const body = getBody(req);
      const fid = typeof body?.fid === "string" ? body.fid.trim() : "";
      if (fid && !/^[A-Za-z0-9_-]{16,256}$/.test(fid)) {
        throw new ApiError(400, "invalid-push-registration", "L’inscription du navigateur n’est pas valide.");
      }
      if (req.method === "POST") {
        if (!readVapidKey()) throw new ApiError(503, "push-notifications-unavailable", "Les notifications push ne sont pas configurées.");
        if (!fid) throw new ApiError(400, "invalid-push-registration", "L’inscription du navigateur n’est pas valide.");
        const id = createHash("sha256").update(fid).digest("hex");
        const ref = db.collection("notificationPushRegistrations").doc(id);
        await db.runTransaction(async (transaction) => {
          const existing = await transaction.get(ref);
          if (existing.exists && existing.get("uid") !== user.uid) {
            throw new ApiError(409, "push-registration-owner-conflict", "Cette inscription push appartient déjà à un autre compte.");
          }
          transaction.set(ref, {
            uid: user.uid,
            fid,
            platform: "web",
            createdAt: existing.get("createdAt") || FieldValue.serverTimestamp(),
            lastSeenAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        });
        return res.status(200).json({ ok: true, registered: true });
      }

      const registrations = db.collection("notificationPushRegistrations");
      let removed = 0;
      if (fid) {
        const id = createHash("sha256").update(fid).digest("hex");
        const ref = registrations.doc(id);
        await db.runTransaction(async (transaction) => {
          const existing = await transaction.get(ref);
          if (existing.exists && existing.get("uid") === user.uid) {
            transaction.delete(ref);
            removed = 1;
          }
        });
      } else {
        await db.runTransaction(async (transaction) => {
          const owned = await transaction.get(registrations.where("uid", "==", user.uid).limit(100));
          owned.docs.forEach((registration) => transaction.delete(registration.ref));
          removed = owned.size;
        });
      }
      return res.status(200).json({ ok: true, removed });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA push registration request failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "push-registration-unavailable", "Les notifications push ne sont pas disponibles.");
    }
  });

  const nexaUserNotificationDelivery = onDocumentCreated({
    region: FUNCTION_REGION,
    document: "userNotifications/{notificationId}",
    secrets: [RESEND_API_KEY],
    retry: true,
  }, async (event) => {
    const notification = event.data?.data();
    const uid = typeof notification?.uid === "string" ? notification.uid : "";
    const notificationId = typeof event.params?.notificationId === "string" ? event.params.notificationId : "";
    if (!uid || !/^[a-f0-9]{64}$/.test(notificationId)) return;
    const notificationUrl = safePath(notification?.url);
    try {
      const preferences = await db.collection("userNotificationPreferences").doc(uid).get();
      if (preferences.get("pushEnabled") !== true && preferences.get("emailEnabled") !== true) return;

      const deliveries = [];
      if (preferences.get("pushEnabled") === true) {
        deliveries.push((async () => {
          const registrations = await db.collection("notificationPushRegistrations")
            .where("uid", "==", uid)
            .limit(100)
            .get();
          const docs = registrations.docs.filter((registration) => typeof registration.get("fid") === "string");
          if (!docs.length) return;
          const response = await messaging.sendEachForMulticast({
            fids: docs.map((registration) => String(registration.get("fid"))),
            data: {
              title: "NEXA Medical Center",
              body: "Une nouvelle notification vous attend. Connectez-vous à votre espace NEXA pour la consulter.",
              url: notificationUrl,
            },
            webpush: { headers: { Urgency: "normal" } },
          });
          const staleCodes = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token"]);
          const staleRefs = response.responses.flatMap((result, index) =>
            result.error && staleCodes.has(result.error.code) ? [docs[index].ref] : []);
          if (staleRefs.length) await Promise.all(staleRefs.map((ref) => ref.delete()));
          if (response.failureCount > 0 && response.successCount === 0) throw new Error("push-delivery-failed");
        })());
      }
      if (preferences.get("emailEnabled") === true) {
        deliveries.push((async () => {
          const apiKey = readResendKey();
          const from = emailSender();
          if (!apiKey || !from) return;
          const account = await adminAuth.getUser(uid);
          if (!account.email || account.emailVerified !== true) return;
          const siteUrl = "https://nexarishaiti.com" + notificationUrl;
          const response = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + apiKey,
              "Content-Type": "application/json",
              "Idempotency-Key": notificationId,
            },
            body: JSON.stringify({
              from,
              to: [account.email],
              subject: "Une notification vous attend sur NEXA",
              text: "Une nouvelle notification vous attend dans votre espace NEXA Medical Center. Connectez-vous pour la consulter : " + siteUrl,
              html: "<p>Une nouvelle notification vous attend dans votre espace NEXA Medical Center.</p><p><a href=\"" + siteUrl + "\">Connectez-vous pour la consulter.</a></p>",
            }),
            signal: AbortSignal.timeout(8_000),
          });
          if (!response.ok) throw new Error("email-delivery-failed");
        })());
      }

      const results = await Promise.allSettled(deliveries);
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) {
        logger.warn("NEXA notification delivery was incomplete", { count: failures.length });
        throw new Error("notification-delivery-incomplete");
      }
    } catch (error) {
      logger.error("NEXA notification delivery failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      throw error;
    }
  });

  const nexaAppointmentReminders = onSchedule({
    region: FUNCTION_REGION,
    schedule: "every 5 minutes",
    timeZone: "America/Port-au-Prince",
    maxInstances: 1,
  }, async () => {
    const now = Date.now();
    const startText = new Date(now).toISOString();
    const horizonText = new Date(now + 24 * 60 * 60_000).toISOString();
    const candidates = await db.collection("appointments")
      .where("startsAt", ">=", startText)
      .where("startsAt", "<=", horizonText)
      .orderBy("startsAt")
      .limit(500)
      .get();
    let processed = 0;

    for (const candidate of candidates.docs) {
      const initial = candidate.data() || {};
      const initialStartsAt = Date.parse(String(initial.startsAt || ""));
      const reminder = reminderFor(initialStartsAt, now);
      const patientUid = typeof initial.patientUid === "string" ? initial.patientUid : "";
      const providerUid = typeof initial.providerUid === "string" ? initial.providerUid : "";
      if (!reminder || !patientUid || !providerUid || initial.providerType !== "doctor" ||
        initial.paymentStatus !== "PAID" || !["CONFIRMED", "DOCTOR_ACCEPTED"].includes(String(initial.status || ""))) continue;

      const marker = "reminder" + reminder.key + "SentAt";
      const patientNotificationRef = db.collection("userNotifications")
        .doc(reminderNotificationId(patientUid, candidate.id, reminder.key));
      const providerNotificationRef = db.collection("userNotifications")
        .doc(reminderNotificationId(providerUid, candidate.id, reminder.key));
      try {
        const created = await db.runTransaction(async (transaction) => {
          const [fresh, patientNotification, providerNotification] = await Promise.all([
            transaction.get(candidate.ref),
            transaction.get(patientNotificationRef),
            transaction.get(providerNotificationRef),
          ]);
          if (!fresh.exists || fresh.get(marker) || fresh.get("providerType") !== "doctor" ||
            fresh.get("paymentStatus") !== "PAID" ||
            !["CONFIRMED", "DOCTOR_ACCEPTED"].includes(String(fresh.get("status") || "")) ||
            fresh.get("patientUid") !== patientUid || fresh.get("providerUid") !== providerUid ||
            reminderFor(Date.parse(String(fresh.get("startsAt") || "")), Date.now())?.key !== reminder.key) return false;

          const makeNotification = (uid, url) => ({
            uid,
            type: "appointment_reminder",
            title: "Rappel de rendez-vous",
            body: "Votre rendez-vous NEXA est prévu " + reminder.label + ".",
            url,
            context: { appointmentId: candidate.id },
            read: false,
            readAt: null,
            createdAt: FieldValue.serverTimestamp(),
          });
          if (!patientNotification.exists) {
            transaction.create(patientNotificationRef, makeNotification(patientUid, "/espace-patient.html"));
          }
          if (!providerNotification.exists) {
            transaction.create(providerNotificationRef, makeNotification(providerUid, "/espace-professionnel.html"));
          }
          transaction.update(candidate.ref, {
            [marker]: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
          return true;
        });
        if (created) processed += 1;
      } catch (error) {
        logger.warn("NEXA appointment reminder was skipped", {
          errorName: error instanceof Error ? error.name : "unknown-error",
        });
      }
    }
    logger.info("NEXA appointment reminder sweep completed", { checked: candidates.size, processed });
  });

  return {
    nexaUserNotifications,
    nexaNotificationPreferences,
    nexaNotificationPushRegistrations,
    nexaUserNotificationDelivery,
    nexaAppointmentReminders,
  };
};
