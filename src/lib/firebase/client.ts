"use client";

import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import {
  connectAuthEmulator,
  getAuth,
  type Auth,
} from "firebase/auth";
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
  type AppCheck,
} from "firebase/app-check";

let clientApp: FirebaseApp | undefined;
let clientAuth: Auth | undefined;
let clientAppCheck: AppCheck | undefined;
let authEmulatorConnected = false;

function requiredClientValue(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing public Firebase configuration: ${name}`);
  return value;
}

export function getFirebaseApp(): FirebaseApp {
  if (clientApp) return clientApp;

  const projectId = requiredClientValue(
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  );
  const useEmulators = process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATORS === "true";
  if (process.env.NODE_ENV === "production" && projectId !== "nexaris-1339d") {
    throw new Error("The production Firebase client must use the NEXA project.");
  }
  if (process.env.NODE_ENV !== "production" && (!useEmulators || !projectId.startsWith("demo-"))) {
    throw new Error("Local Firebase client code must use a demo project with emulators.");
  }

  const config = {
    apiKey: requiredClientValue(
      "NEXT_PUBLIC_FIREBASE_API_KEY",
      process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    ),
    authDomain: requiredClientValue(
      "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
      process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    ),
    projectId,
    storageBucket: requiredClientValue(
      "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    ),
    messagingSenderId: requiredClientValue(
      "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    ),
    appId: requiredClientValue(
      "NEXT_PUBLIC_FIREBASE_APP_ID",
      process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    ),
    measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID || undefined,
  };

  const existing = getApps().find((app) => app.name === "nexa-client");
  clientApp = existing || initializeApp(config, "nexa-client");
  return clientApp;
}

export function getFirebaseAuth(): Auth {
  if (clientAuth) return clientAuth;

  const app = getFirebaseApp();
  clientAuth = getAuth(app);

  if (
    typeof window !== "undefined" &&
    process.env.NEXT_PUBLIC_FIREBASE_USE_EMULATORS === "true" &&
    !authEmulatorConnected
  ) {
    connectAuthEmulator(clientAuth, "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
    authEmulatorConnected = true;
  }

  return clientAuth;
}

export function getFirebaseAppCheck(): AppCheck | null {
  const siteKey = process.env.NEXT_PUBLIC_FIREBASE_APPCHECK_SITE_KEY;
  if (!siteKey || typeof window === "undefined") return null;
  if (clientAppCheck) return clientAppCheck;

  clientAppCheck = initializeAppCheck(getFirebaseApp(), {
    provider: new ReCaptchaV3Provider(siteKey),
    isTokenAutoRefreshEnabled: true,
  });
  return clientAppCheck;
}
