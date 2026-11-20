"use strict";

importScripts("https://www.gstatic.com/firebasejs/13.2.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/13.2.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyC-f-9NRF6aIR4lMi2nhtl45SuYMq17QOo",
  authDomain: "nexaris-1339d.firebaseapp.com",
  projectId: "nexaris-1339d",
  storageBucket: "nexaris-1339d.firebasestorage.app",
  messagingSenderId: "150995776114",
  appId: "1:150995776114:web:a0818d137049a74d5a88eb",
});

firebase.messaging().onBackgroundMessage((payload) => {
  const data = payload && payload.data && typeof payload.data === "object" ? payload.data : {};
  const title = typeof data.title === "string" ? data.title : "NEXA Medical Center";
  const body = typeof data.body === "string"
    ? data.body
    : "Connectez-vous à votre espace pour consulter une mise à jour.";
  const path = typeof data.url === "string" && data.url.startsWith("/") &&
    !data.url.startsWith("//") && !data.url.includes("\\")
    ? data.url
    : "/espace-patient.html";
  return self.registration.showNotification(title, {
    body,
    icon: new URL("favicon.svg", self.registration.scope).toString(),
    data: { url: path },
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data && typeof event.notification.data.url === "string"
    ? event.notification.data.url
    : "/espace-patient.html";
  const safePath = path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")
    ? path
    : "/espace-patient.html";
  const target = new URL(safePath.slice(1), self.registration.scope).toString();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin && "navigate" in client) {
        return client.navigate(target).then(() => client.focus());
      }
    }
    return self.clients.openWindow(target);
  }));
});
