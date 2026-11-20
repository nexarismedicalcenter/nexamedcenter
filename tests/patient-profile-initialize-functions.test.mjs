import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const projectId = "demo-nexaris";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || "";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "";
const functionsHost = process.env.NEXA_FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const localHost = (value) => value && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${value.replace(/^https?:\/\//, "")}`).hostname);
if (!localHost(authHost) || !localHost(firestoreHost) || !localHost(functionsHost)) {
  throw new Error("Refusing NMC Cloud Function tests without local Firebase emulators.");
}

const app = initializeApp({ projectId }, "patient-profile-initialize-function-tests");
const db = getFirestore(app);
const apiKey = "demo-api-key";

async function clearFirestoreEmulator() {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true, "Firestore Emulator must be available and clearable.");
}

async function createAuthUser() {
  const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `nmc.${randomUUID()}@example.test`, password: "NexaTestPassword-2026", returnSecureToken: true }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, `Auth Emulator account creation failed with HTTP ${response.status}.`);
  return { uid: result.localId, token: result.idToken };
}

async function createAnonymousUser() {
  const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, `Auth Emulator anonymous account creation failed with HTTP ${response.status}.`);
  const authRecord = await getAuth(app).getUser(result.localId);
  assert.equal(authRecord.email, undefined);
  assert.equal(authRecord.phoneNumber, undefined);
  assert.equal(authRecord.providerData.length, 0);
  return { uid: result.localId, token: result.idToken };
}

async function waitForPatientProfile(uid) {
  const patientRef = db.collection("patientProfiles").doc(uid);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const snapshot = await patientRef.get();
    if (snapshot.exists && /^NMC-\d{7}$/.test(String(snapshot.get("patientNumber") || ""))) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("Auth onCreate must assign a patient number without calling patientProfileInitialize.");
}

async function initialize(user, body = {}) {
  const response = await fetch(`http://${functionsHost}/${projectId}/us-east4/patientProfileInitialize`, {
    method: "POST",
    headers: {
      ...(user ? { Authorization: `Bearer ${user.token}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

beforeEach(clearFirestoreEmulator);
after(() => deleteApp(app));

test("Auth creation assigns an NMC number to email and phone accounts before profile initialization", async () => {
  const firstPatient = await createAuthUser();
  const firstProfile = await waitForPatientProfile(firstPatient.uid);
  assert.equal(firstProfile.get("patientNumber"), "NMC-0000001");
  assert.equal(firstProfile.get("role"), "patient");
  assert.equal(firstProfile.get("profileComplete"), false);

  const secondPatient = await createAuthUser();
  const secondProfile = await waitForPatientProfile(secondPatient.uid);
  assert.equal(secondProfile.get("patientNumber"), "NMC-0000002");
  assert.equal(secondProfile.get("profileComplete"), false);

  const firstAllocation = await initialize(firstPatient);
  assert.deepEqual(firstAllocation, {
    status: 200,
    body: { ok: true, patientNumber: "NMC-0000001", created: false, profileComplete: false },
  });

  const retry = await initialize(firstPatient);
  assert.deepEqual(retry, {
    status: 200,
    body: { ok: true, patientNumber: "NMC-0000001", created: false, profileComplete: false },
  });

  const completed = await initialize(firstPatient, {
    firstName: "Patiente", lastName: "Synthétique", birthDate: "1990-02-14", phone: "+509 3700 0000",
    sex: "Femme", addressLine: "Adresse de test", country: "Haïti", department: "Ouest",
    commune: "Port-au-Prince", emailMarketingConsent: false, termsAccepted: true,
  });
  assert.deepEqual(completed, {
    status: 200,
    body: { ok: true, patientNumber: "NMC-0000001", created: false, profileComplete: true },
  });

  const secondAllocation = await initialize(secondPatient);
  assert.equal(secondAllocation.status, 200);
  assert.equal(secondAllocation.body.patientNumber, "NMC-0000002");

  const phoneNumber = "+1555" + String(Math.floor(1_000_000 + Math.random() * 9_000_000));
  const phoneOnlyPatient = await getAuth(app).createUser({ phoneNumber });
  const phoneOnlyProfile = await waitForPatientProfile(phoneOnlyPatient.uid);
  assert.equal(phoneOnlyProfile.get("patientNumber"), "NMC-0000003");
  assert.equal(phoneOnlyProfile.get("profileComplete"), false);
  assert.equal(phoneOnlyProfile.get("email"), undefined);
  const phoneNumberIndex = await db.collection("patientNumberIndex").doc("NMC-0000003").get();
  assert.equal(phoneNumberIndex.get("uid"), phoneOnlyPatient.uid);

  const anonymousUser = await createAnonymousUser();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal((await db.collection("patientProfiles").doc(anonymousUser.uid).get()).exists, false);
  const anonymousInitialization = await initialize(anonymousUser);
  assert.equal(anonymousInitialization.status, 401);
  assert.equal(anonymousInitialization.body.code, "registered-account-required");

  assert.equal((await db.collection("patientNumberIndex").get()).size, 3);
  assert.equal((await db.collection("patientProfiles").doc(firstPatient.uid).get()).get("patientNumber"), "NMC-0000001");

  const unauthenticated = await initialize(null);
  assert.equal(unauthenticated.status, 401);
});

test("simultaneous signups receive distinct sequential patient numbers", async () => {
  const patients = await Promise.all(Array.from({ length: 8 }, () => createAuthUser()));
  await Promise.all(patients.map((patient) => waitForPatientProfile(patient.uid)));
  const responses = await Promise.all(patients.map((patient) => initialize(patient)));
  assert.ok(responses.every((response) => response.status === 200));
  const numbers = responses.map((response) => response.body.patientNumber).sort();
  assert.equal(new Set(numbers).size, patients.length);
  assert.deepEqual(numbers, Array.from({ length: 8 }, (_, index) => `NMC-${String(index + 1).padStart(7, "0")}`));
});

test("does not reuse a number already stored on a profile if its index is missing", async () => {
  await db.collection("systemCounters").doc("patientNumbers").set({ lastIssuedNumber: 0 });
  await db.collection("patientProfiles").doc("legacy-profile-without-index").set({
    uid: "legacy-profile-without-index",
    role: "patient",
    patientNumber: "NMC-0000001",
    profileComplete: false,
  });

  const patient = await createAuthUser();
  const profile = await waitForPatientProfile(patient.uid);

  const patientNumber = profile.get("patientNumber");
  assert.match(patientNumber, /^NMC-\d{7}$/);
  assert.notEqual(patientNumber, "NMC-0000001");
  assert.equal((await db.collection("patientNumberIndex").doc(patientNumber).get()).get("uid"), patient.uid);
  assert.equal((await db.collection("patientProfiles").where("patientNumber", "==", "NMC-0000001").get()).size, 1);
});

test("rejects recovery of an existing number if another profile already owns it", async () => {
  const patient = await createAuthUser();
  const profile = await waitForPatientProfile(patient.uid);
  const patientNumber = profile.get("patientNumber");

  await db.collection("patientNumberIndex").doc(patientNumber).delete();
  await db.collection("patientProfiles").doc("duplicate-profile-without-index").set({
    uid: "duplicate-profile-without-index",
    role: "patient",
    patientNumber,
    profileComplete: false,
  });

  const recovery = await initialize(patient);
  assert.equal(recovery.status, 503);
  assert.equal(recovery.body.code, "patient-number-unavailable");
  assert.equal((await db.collection("patientNumberIndex").doc(patientNumber).get()).exists, false);
  assert.equal((await db.collection("patientProfiles").where("patientNumber", "==", patientNumber).get()).size, 2);
});
