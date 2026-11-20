"use client";

import { useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";
import { getFirebaseApp } from "@/lib/firebase/client";

type NotificationItem = { id: string; title: string; body: string; type: string; url: string; read: boolean; createdAt: string | null };

export default function NotificationInbox({ user }: { user: User }) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await appointmentRequest<{ notifications: NotificationItem[] }>(user, "/api/notifications");
      setItems(result.notifications || []);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Les notifications sont indisponibles."); }
    finally { setLoading(false); }
  }, [user]);

  const handleIncoming = useCallback(() => { void load(); }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    window.addEventListener("nexa-notification-refresh", handleIncoming);
    return () => window.removeEventListener("nexa-notification-refresh", handleIncoming);
  }, [handleIncoming]);

  async function open(item: NotificationItem) {
    if (busyId) return;
    setBusyId(item.id);
    try {
      if (!item.read) {
        await appointmentRequest(user, "/api/notifications", "POST", { id: item.id });
        setItems((current) => current.map((notification) => notification.id === item.id ? { ...notification, read: true } : notification));
      }
      const url = item.url.startsWith("/") && !item.url.startsWith("//") ? item.url : "/espace";
      window.location.assign(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "La notification ne peut pas être ouverte."); }
    finally { setBusyId(""); }
  }

  const unread = items.filter((item) => !item.read).length;
  return <section className="patient-appointments notification-inbox" aria-labelledby="notification-inbox-heading">
    <h2 id="notification-inbox-heading">Notifications{unread ? ` · ${unread} non lue(s)` : ""}</h2>
    <NotificationDeliverySettings user={user} onIncoming={handleIncoming} />
    {loading ? <p role="status">Chargement des notifications…</p> : error ? <div><p className="form-error" role="alert">{error}</p><button className="button button-outline" onClick={() => void load()} type="button">Réessayer</button></div> : items.length ? <ul>{items.map((item) => <li key={item.id} className={item.read ? "notification-item" : "notification-item is-unread"}><button className="notification-open" disabled={busyId === item.id} onClick={() => void open(item)} type="button"><strong>{item.title}</strong><span>{item.body}</span><small>{item.createdAt ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(new Date(item.createdAt)) : ""}</small></button></li>)}</ul> : <p>Aucune notification. Les mises à jour de rendez-vous apparaîtront ici.</p>}
  </section>;
}

type NotificationPreferences = { emailEnabled: boolean; pushEnabled: boolean; emailAvailable: boolean; pushAvailable: boolean };

function waitForFirebaseInstallationId(
  messaging: import("firebase/messaging").Messaging,
  options: import("firebase/messaging").RegisterOptions,
  sdk: typeof import("firebase/messaging"),
) {
  return new Promise<string>((resolve, reject) => {
    let unsubscribe: () => void = () => {};
    const timeout = window.setTimeout(() => {
      unsubscribe();
      reject(new Error("L’inscription push ne répond pas. Réessayez dans un instant."));
    }, 20_000);
    unsubscribe = sdk.onRegistered(messaging, (fid) => {
      window.clearTimeout(timeout);
      unsubscribe();
      resolve(fid);
    });
    void sdk.register(messaging, options).catch((cause: unknown) => {
      window.clearTimeout(timeout);
      unsubscribe();
      reject(cause);
    });
  });
}

function NotificationDeliverySettings({ user, onIncoming }: { user: User; onIncoming: () => void }) {
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void appointmentRequest<{ preferences: Pick<NotificationPreferences, "emailEnabled" | "pushEnabled">; emailAvailable: boolean; pushAvailable: boolean }>(user, "/api/notifications/preferences")
      .then((result) => { if (active) setPreferences({ ...result.preferences, emailAvailable: result.emailAvailable, pushAvailable: result.pushAvailable }); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Les préférences de notification ne peuvent pas être chargées."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [user]);

  useEffect(() => {
    if (!preferences?.pushEnabled) return;
    let active = true;
    let unsubscribe: () => void = () => {};
    void import("firebase/messaging").then(async (sdk) => {
      if (!active || !(await sdk.isSupported())) return;
      unsubscribe = sdk.onMessage(sdk.getMessaging(getFirebaseApp()), onIncoming);
    }).catch(() => undefined);
    return () => { active = false; unsubscribe(); };
  }, [onIncoming, preferences?.pushEnabled]);

  async function setEmailEnabled(enabled: boolean) {
    setBusy(true); setError(""); setNotice("");
    try {
      await appointmentRequest(user, "/api/notifications/preferences", "POST", { emailEnabled: enabled });
      setPreferences((current) => current ? { ...current, emailEnabled: enabled } : current);
      setNotice(enabled ? "Les notifications e-mail sont activées." : "Les notifications e-mail sont désactivées.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "La préférence e-mail n’a pas été enregistrée."); }
    finally { setBusy(false); }
  }

  async function enablePush() {
    if (!preferences?.pushAvailable) return;
    setBusy(true); setError(""); setNotice("");
    let fid = "";
    try {
      if (!("Notification" in window) || !("serviceWorker" in navigator)) throw new Error("Ce navigateur ne prend pas en charge les notifications push.");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Autorisez les notifications NEXA dans les réglages du navigateur pour les activer.");
      const sdk = await import("firebase/messaging");
      if (!(await sdk.isSupported())) throw new Error("Les notifications push ne sont pas prises en charge par ce navigateur.");
      const serviceWorkerRegistration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
      const messaging = sdk.getMessaging(getFirebaseApp());
      fid = await waitForFirebaseInstallationId(messaging, {
        vapidKey: process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY || "",
        serviceWorkerRegistration,
      }, sdk);
      await appointmentRequest(user, "/api/notifications/push-registrations", "POST", { fid });
      try {
        await appointmentRequest(user, "/api/notifications/preferences", "POST", { pushEnabled: true });
      } catch (cause) {
        await appointmentRequest(user, "/api/notifications/push-registrations", "DELETE", { fid }).catch(() => undefined);
        throw cause;
      }
      setPreferences((current) => current ? { ...current, pushEnabled: true } : current);
      setNotice("Les notifications push NEXA sont activées pour votre compte.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Les notifications push n’ont pas pu être activées."); }
    finally { setBusy(false); }
  }

  async function disablePush() {
    setBusy(true); setError(""); setNotice("");
    try {
      await appointmentRequest(user, "/api/notifications/preferences", "POST", { pushEnabled: false });
      const sdk = await import("firebase/messaging").catch(() => null);
      if (sdk && await sdk.isSupported()) await sdk.unregister(sdk.getMessaging(getFirebaseApp())).catch(() => undefined);
      setPreferences((current) => current ? { ...current, pushEnabled: false } : current);
      setNotice("Les notifications push sont désactivées pour ce compte.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Les notifications push n’ont pas pu être désactivées."); }
    finally { setBusy(false); }
  }

  return <div className="notification-delivery-settings" aria-label="Préférences de notification">
    <p>Les alertes push et e-mail restent générales. Les détails s’affichent uniquement après connexion à votre espace NEXA.</p>
    {loading ? <p role="status">Chargement des préférences…</p> : preferences ? <>
      <label className="notification-email-setting"><input type="checkbox" checked={preferences.emailEnabled} disabled={busy || !preferences.emailAvailable} onChange={(event) => void setEmailEnabled(event.target.checked)} />Recevoir une alerte e-mail lorsqu’une notification NEXA est créée</label>
      {!preferences.emailAvailable ? <small>L’envoi d’e-mails sera activé après configuration du service NEXA.</small> : null}
      <div className="notification-push-setting"><button className="button button-outline" disabled={busy || (!preferences.pushAvailable && !preferences.pushEnabled)} onClick={() => void (preferences.pushEnabled ? disablePush() : enablePush())} type="button">{busy ? "Enregistrement…" : preferences.pushEnabled ? "Désactiver les notifications push" : "Activer les notifications push pour mon compte"}</button>{!preferences.pushAvailable ? <small>La configuration Web Push du projet NEXA est nécessaire pour activer cette option.</small> : null}</div>
    </> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}{notice ? <p className="form-notice" role="status">{notice}</p> : null}
  </div>;
}
