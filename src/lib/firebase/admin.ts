import "server-only";

import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const PRODUCTION_PROJECT_ID = "nexaris-1339d";
const ADMIN_APP_NAME = "nexa-server";

function getProjectId(): string {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID is required.");

  if (
    process.env.NODE_ENV === "production" &&
    projectId !== PRODUCTION_PROJECT_ID
  ) {
    throw new Error("The production Firebase project does not match NEXA.");
  }

  const publicProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (publicProjectId && publicProjectId !== projectId) {
    throw new Error("Client and server Firebase project IDs do not match.");
  }

  return projectId;
}

function createAdminApp(): App {
  const existing = getApps().find((app) => app.name === ADMIN_APP_NAME);
  if (existing) return existing;

  const projectId = getProjectId();
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET || process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  const publicStorageBucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;
  if (storageBucket && publicStorageBucket && storageBucket !== publicStorageBucket) {
    throw new Error("Client and server Firebase storage buckets do not match.");
  }
  const emulatorMode =
    process.env.NODE_ENV !== "production" &&
    Boolean(
      process.env.FIREBASE_AUTH_EMULATOR_HOST &&
        process.env.FIRESTORE_EMULATOR_HOST,
    );

  if (process.env.NODE_ENV !== "production" && !emulatorMode) {
    throw new Error(
      "Local server code must use the Firebase Auth and Firestore emulators.",
    );
  }

  if (emulatorMode) {
    return initializeApp({ projectId, storageBucket }, ADMIN_APP_NAME);
  }

  const rawCredentials = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON;
  if (!rawCredentials) {
    throw new Error("FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON is required.");
  }

  let credentials: {
    project_id?: string;
    client_email?: string;
    private_key?: string;
  };
  try {
    credentials = JSON.parse(rawCredentials) as typeof credentials;
  } catch {
    throw new Error("Firebase Admin credentials are not valid JSON.");
  }

  if (
    credentials.project_id !== projectId ||
    !credentials.client_email ||
    !credentials.private_key
  ) {
    throw new Error("Firebase Admin credentials do not match the configured project.");
  }

  return initializeApp(
    {
      projectId,
      storageBucket,
      credential: cert({
        projectId,
        clientEmail: credentials.client_email,
        privateKey: credentials.private_key.replace(/\\n/g, "\n"),
      }),
    },
    ADMIN_APP_NAME,
  );
}

let adminApp: App | undefined;

export function getFirebaseAdminApp(): App {
  if (!adminApp) adminApp = createAdminApp();
  return adminApp;
}

export function getFirebaseAdminAuth() {
  return getAuth(getFirebaseAdminApp());
}

export function getFirebaseAdminDb() {
  return getFirestore(getFirebaseAdminApp());
}

export function getFirebaseAdminStorage() {
  return getStorage(getFirebaseAdminApp());
}
