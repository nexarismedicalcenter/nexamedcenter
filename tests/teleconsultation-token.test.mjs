import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { deleteApp, getApps } from "firebase-admin/app";

process.env.NODE_ENV = "test";
process.env.FIREBASE_PROJECT_ID = "demo-nexaris";
process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||= "demo-api-key";
const testAgoraAppId = "0123456789abcdef0123456789abcdef";
const testAgoraCertificate = "abcdef0123456789abcdef0123456789";
process.env.AGORA_APP_ID = testAgoraAppId;
process.env.AGORA_APP_CERTIFICATE = testAgoraCertificate;

const projectId = "demo-nexaris";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || "";
const isLocalHost = (host) => host && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${host}`).hostname);
if (!isLocalHost(firestoreHost) || !isLocalHost(authHost)) {
  throw new Error("Refusing Agora token tests without local Auth and Firestore emulators.");
}

const [{ getFirebaseAdminDb }, { POST: issueAgoraToken }] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/teleconsultation/token/route.ts"),
]);
const db = getFirebaseAdminDb();
const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const authBaseUrl = `http://${authHost}`;

async function clearFirestoreEmulator() {
  const response = await fetch(
    `http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(response.ok, true, "Firestore emulator must be available and clearable.");
}

async function createAuthUser(prefix) {
  const email = `${prefix}-${randomUUID()}@example.test`;
  const response = await fetch(`${authBaseUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "NexaTestPassword-2026", returnSecureToken: true }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, `Auth emulator account creation failed with HTTP ${response.status}.`);
  return { uid: result.localId, token: result.idToken };
}

function requestToken(user, appointmentId, presenceAction = "join") {
  return issueAgoraToken(new Request("http://localhost:3000/api/teleconsultation/token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${user.token}`,
      Origin: "http://localhost:3000",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ appointmentId, presenceAction }),
  }));
}

function activeAppointment(patientUid, providerUid, overrides = {}) {
  const now = Date.now();
  return {
    patientUid,
    providerUid,
    providerType: "doctor",
    bookingType: "teleconsultation",
    status: "IN_PROGRESS",
    paymentStatus: "PAID",
    sessionStatus: "IN_PROGRESS",
    effectiveConsultationStartedAt: new Date(now - 1_000).toISOString(),
    videoConnectedParticipants: {
      [patientUid]: now - 1_000,
      [providerUid]: now - 1_000,
    },
    startsAt: new Date(now - 60_000).toISOString(),
    endsAt: new Date(now + 30 * 60_000).toISOString(),
    interactiveEndsAt: new Date(now + 10 * 60_000).toISOString(),
    consultationRights: { durationMinutes: 10 },
    ...overrides,
  };
}

let patient;
let provider;
let outsider;

before(async () => {
  await clearFirestoreEmulator();
  [patient, provider, outsider] = await Promise.all([
    createAuthUser("agora-patient"),
    createAuthUser("agora-provider"),
    createAuthUser("agora-outsider"),
  ]);
});

after(async () => {
  const adminApp = getApps().find((app) => app.name === "nexa-server");
  if (adminApp) await deleteApp(adminApp);
});

test("does not record participant presence when server Agora credentials are missing", async () => {
  const appointmentId = "agora-token-unconfigured-001";
  const appointmentRef = db.collection("appointments").doc(appointmentId);
  await appointmentRef.set(activeAppointment(patient.uid, provider.uid));
  process.env.AGORA_APP_ID = "";
  process.env.AGORA_APP_CERTIFICATE = "";

  let result;
  try {
    const response = await requestToken(patient, appointmentId);
    result = { status: response.status, body: await response.json() };
  } finally {
    process.env.AGORA_APP_ID = testAgoraAppId;
    process.env.AGORA_APP_CERTIFICATE = testAgoraCertificate;
  }

  assert.equal(result.status, 503);
  assert.equal(result.body.code, "video-not-configured");
  const appointment = await appointmentRef.get();
  assert.equal(appointment.get("videoParticipants"), undefined);
  assert.equal(appointment.get("videoConsumedMilliseconds"), undefined);
});

test("issues an offline-generated Agora token capped by remaining video quota", async () => {
  const appointmentId = "agora-token-video-quota-001";
  const appointmentRef = db.collection("appointments").doc(appointmentId);
  await appointmentRef.set(activeAppointment(patient.uid, provider.uid, {
    consultationRights: { durationMinutes: 1 },
    videoConsumedMilliseconds: 45_000,
    videoConsumedSeconds: 45,
  }));
  const beforeSeconds = Math.floor(Date.now() / 1_000);

  const response = await requestToken(patient, appointmentId);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.appId, testAgoraAppId);
  assert.match(body.token, /^007/);
  assert.equal(body.videoRemainingSeconds, 15);
  assert.ok(body.expiresAt > beforeSeconds);
  assert.ok(body.expiresAt <= beforeSeconds + 16);
  assert.equal(body.uid > 0, true);
  assert.equal(body.channelName, `nexa_${appointmentId}`);
  assert.equal((await appointmentRef.get()).get("videoParticipants")[patient.uid].lastSeenAtMs > 0, true);
});

test("caps the Agora token at the appointment interaction deadline", async () => {
  const appointmentId = "agora-token-interactive-end-001";
  const appointmentRef = db.collection("appointments").doc(appointmentId);
  const interactiveEndsAtMs = Date.now() + 20_000;
  await appointmentRef.set(activeAppointment(patient.uid, provider.uid, {
    interactiveEndsAt: new Date(interactiveEndsAtMs).toISOString(),
  }));

  const response = await requestToken(patient, appointmentId);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.ok(body.expiresAt > Math.floor(Date.now() / 1_000));
  assert.ok(body.expiresAt <= Math.floor(interactiveEndsAtMs / 1_000));
  assert.ok(body.expiresAt <= Math.floor(Date.now() / 1_000) + 20);
});

test("denies an authenticated nonparticipant without recording video presence", async () => {
  const appointmentId = "agora-token-outsider-001";
  const appointmentRef = db.collection("appointments").doc(appointmentId);
  await appointmentRef.set(activeAppointment(patient.uid, provider.uid));

  const response = await requestToken(outsider, appointmentId);
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.code, "forbidden");
  assert.equal((await appointmentRef.get()).get("videoParticipants"), undefined);
});
