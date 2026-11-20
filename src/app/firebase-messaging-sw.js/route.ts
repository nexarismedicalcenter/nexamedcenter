import { NextResponse } from "next/server";

function configValue(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export async function GET(request: Request) {
  try {
    if (new URL(request.url).pathname !== "/firebase-messaging-sw.js") throw new Error("Invalid service worker path.");
    const config = {
      apiKey: configValue("NEXT_PUBLIC_FIREBASE_API_KEY"),
      authDomain: configValue("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN"),
      projectId: configValue("NEXT_PUBLIC_FIREBASE_PROJECT_ID"),
      storageBucket: configValue("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET"),
      messagingSenderId: configValue("NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID"),
      appId: configValue("NEXT_PUBLIC_FIREBASE_APP_ID"),
      ...(process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID ? { measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID } : {}),
    };
    if (process.env.NODE_ENV === "production" && config.projectId !== "nexaris-1339d") throw new Error("The push service worker must use the NEXA Firebase project.");
    const serializedConfig = JSON.stringify(config).replace(/</g, "\\u003c");
    const script = `
self.addEventListener("notificationclick", function(event) {
  event.notification.close();
  const path = event.notification.data && typeof event.notification.data.url === "string" ? event.notification.data.url : "/espace";
  const safePath = path.startsWith("/") && !path.startsWith("//") && !path.includes("\\\\") ? path : "/espace";
  const target = new URL(safePath, self.location.origin).toString();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function(windows) {
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin && "navigate" in client) {
        return client.navigate(target).then(function() { return client.focus(); });
      }
    }
    return self.clients.openWindow(target);
  }));
});
importScripts("https://www.gstatic.com/firebasejs/13.2.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/13.2.0/firebase-messaging-compat.js");
firebase.initializeApp(${serializedConfig});
firebase.messaging().onBackgroundMessage(function(payload) {
  const data = payload.data || {};
  const title = typeof data.title === "string" ? data.title : "NEXA Medical Center";
  const body = typeof data.body === "string" ? data.body : "Connectez-vous à votre espace pour consulter une mise à jour.";
  const path = typeof data.url === "string" && data.url.startsWith("/") && !data.url.startsWith("//") ? data.url : "/espace";
  return self.registration.showNotification(title, { body, icon: "/favicon.ico", data: { url: path } });
});
`;
    return new Response(script, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Content-Type": "application/javascript; charset=utf-8",
        "Service-Worker-Allowed": "/",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Les notifications push ne sont pas configurées." }, { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
