import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const projectId = "demo-nexaris";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || "";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "";
const functionsHost = process.env.NEXA_FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const localHost = (value) => value && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${value.replace(/^https?:\/\//, "")}`).hostname);
if (!localHost(authHost) || !localHost(firestoreHost) || !localHost(functionsHost)) {
  throw new Error("Refusing home-visit booking tests without local Firebase emulators.");
}

const app = initializeApp({ projectId }, "home-visit-booking-boundary-tests");
const db = getFirestore(app);
const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Port-au-Prince", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

async function clearFirestoreEmulator() {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true, "Firestore Emulator must be available and clearable.");
}

async function createPatient() {
  const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `homevisit.${randomUUID()}@example.test`, password: "NexaTestPassword-2026", returnSecureToken: true }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, `Auth Emulator account creation failed with HTTP ${response.status}.`);
  const profileRef = db.collection("patientProfiles").doc(result.localId);
  let patientNumber = "";
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const snapshot = await profileRef.get();
    patientNumber = String(snapshot.get("patientNumber") || "");
    if (/^NMC-\d{7}$/.test(patientNumber)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(patientNumber, /^NMC-\d{7}$/, "Auth onCreate must assign the patient number in the emulator.");
  await profileRef.set({ uid: result.localId, email: result.email, role: "patient", patientNumber, profileComplete: true }, { merge: true });
  return { uid: result.localId, token: result.idToken };
}

function futureHaitiDayStart() {
  const now = new Date(Date.now() + 10 * 24 * 60 * 60_000);
  const local = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const target = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day));
  const atTarget = Object.fromEntries(formatter.formatToParts(new Date(target)).map((part) => [part.type, part.value]));
  const represented = Date.UTC(Number(atTarget.year), Number(atTarget.month) - 1, Number(atTarget.day), Number(atTarget.hour), Number(atTarget.minute), Number(atTarget.second));
  return target - (represented - target);
}

async function prepareBooking({ slotStartOffsetMinutes }) {
  const patient = await createPatient();
  const providerUid = `doctor_${randomUUID()}`;
  const providerRef = db.collection("providerProfiles").doc(providerUid);
  await providerRef.set({
    type: "doctor", status: "verified", publiclyListed: true, clinicalCredentialsVerified: true,
    profilePhotoStatus: "APPROVED", profilePhotoConsentVersion: "nexa-doctor-photo-v1",
    profilePhotoPath: `nexa-doctor-profile-photos/${providerUid}/${"a".repeat(32)}.jpg`,
    profile: {
      name: "Médecin de test", homeVisitEnabled: true,
      homeVisitTariffs: { CONSULTATION_EXAMINATION: 5000 },
      homeVisitZones: [{ department: "Ouest", commune: "Port-au-Prince" }],
    },
  });
  const dayStart = futureHaitiDayStart();
  await db.collection("appointments").doc(`previous_${randomUUID().replaceAll("-", "")}`).set({
    providerUid, patientUid: "prior-patient", bookingType: "home_visit", status: "COMPLETED", paymentStatus: "PAID",
    startsAt: new Date(dayStart - 60 * 60_000).toISOString(),
    endsAt: new Date(dayStart).toISOString(),
  });
  const slotId = randomUUID().replaceAll("-", "");
  const startsAt = dayStart + slotStartOffsetMinutes * 60_000;
  await db.collection("providerAvailabilitySlots").doc(slotId).set({
    providerUid, serviceType: "HOME_VISIT", status: "available",
    startsAt: new Date(startsAt).toISOString(), endsAt: new Date(startsAt + 60 * 60_000).toISOString(),
  });
  const response = await fetch(`http://${functionsHost}/${projectId}/us-east4/appointmentBooking`, {
    method: "POST",
    headers: {
      Origin: "https://nexarishaiti.com", Authorization: `Bearer ${patient.token}`, "Content-Type": "application/json",
    },
    body: JSON.stringify({
      slotId, bookingType: "home_visit", homeVisitServiceId: "CONSULTATION_EXAMINATION",
      homeVisitDetails: { department: "Ouest", commune: "Port-au-Prince", addressLine: "1 rue de test", contactPhone: "+50937000000" },
    }),
  });
  return { response, body: await response.json() };
}

beforeEach(clearFirestoreEmulator);
after(() => deleteApp(app));

test("rejects a home visit 30 minutes after midnight when the prior visit ended at midnight", async () => {
  const result = await prepareBooking({ slotStartOffsetMinutes: 30 });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.code, "home-visit-spacing-conflict");
});

test("allows a home visit exactly two hours after a prior visit ending at midnight", async () => {
  const result = await prepareBooking({ slotStartOffsetMinutes: 120 });
  assert.equal(result.response.status, 201);
  assert.equal(result.body.ok, true);
});
test("serializes adjacent-day home visit bookings that violate the two-hour gap", async () => {
  const patients = await Promise.all([createPatient(), createPatient()]);
  const providerUid = `doctor_${randomUUID()}`;
  await db.collection("providerProfiles").doc(providerUid).set({
    type: "doctor", status: "verified", publiclyListed: true, clinicalCredentialsVerified: true,
    profilePhotoStatus: "APPROVED", profilePhotoConsentVersion: "nexa-doctor-photo-v1",
    profilePhotoPath: `nexa-doctor-profile-photos/${providerUid}/${"a".repeat(32)}.jpg`,
    profile: {
      name: "Médecin de test", homeVisitEnabled: true,
      homeVisitTariffs: { CONSULTATION_EXAMINATION: 5000 },
      homeVisitZones: [{ department: "Ouest", commune: "Port-au-Prince" }],
    },
  });
  const dayStart = futureHaitiDayStart();
  const slotIds = [randomUUID().replaceAll("-", ""), randomUUID().replaceAll("-", "")];
  const slotStarts = [dayStart - 30 * 60_000, dayStart + 60 * 60_000];
  await Promise.all(slotIds.map((slotId, index) => db.collection("providerAvailabilitySlots").doc(slotId).set({
    providerUid, serviceType: "HOME_VISIT", status: "available",
    startsAt: new Date(slotStarts[index]).toISOString(),
    endsAt: new Date(slotStarts[index] + 60 * 60_000).toISOString(),
  })));
  const responses = await Promise.all(patients.map((patient, index) => fetch(
    `http://${functionsHost}/${projectId}/us-east4/appointmentBooking`,
    {
      method: "POST",
      headers: {
        Origin: "https://nexarishaiti.com", Authorization: `Bearer ${patient.token}`, "Content-Type": "application/json",
      },
      body: JSON.stringify({
        slotId: slotIds[index], bookingType: "home_visit", homeVisitServiceId: "CONSULTATION_EXAMINATION",
        homeVisitDetails: { department: "Ouest", commune: "Port-au-Prince", addressLine: "1 rue de test", contactPhone: "+50937000000" },
      }),
    },
  ).then(async (response) => ({ status: response.status, body: await response.json() }))));
  assert.equal(responses.filter((result) => result.status === 201).length, 1);
  const rejected = responses.find((result) => result.status === 409);
  assert.equal(rejected?.body.code, "home-visit-spacing-conflict");
});
