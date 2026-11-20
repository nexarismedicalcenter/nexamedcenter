import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { deleteApp, getApps } from "firebase-admin/app";

process.env.NODE_ENV = "test";
process.env.FIREBASE_PROJECT_ID = "demo-nexaris";
process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||= "demo-api-key";

const projectId = "demo-nexaris";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || "";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "";
const isLocalHost = (value) => value && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${value}`).hostname);
if (!isLocalHost(authHost) || !isLocalHost(firestoreHost)) {
  throw new Error("Refusing appointment booking tests without local Auth and Firestore emulators.");
}

const [
  { getFirebaseAdminDb },
  { POST: createAppointment },
  { getTeleconsultationVideoLimitSeconds },
] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/appointments/route.ts"),
  import("../src/lib/teleconsultation/presence.server.ts"),
]);
const db = getFirebaseAdminDb();
const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const authBaseUrl = `http://${authHost}`;

async function clearFirestoreEmulator() {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true, "Firestore emulator must be available and clearable.");
}

async function createAuthUser() {
  const email = `appointment-${randomUUID()}@example.test`;
  const response = await fetch(`${authBaseUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "NexaTestPassword-2026", returnSecureToken: true }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, `Auth emulator account creation failed with HTTP ${response.status}.`);
  return { uid: result.localId, token: result.idToken };
}

function bookingRequest(user, slotId) {
  return new Request("http://localhost:3000/api/appointments", {
    method: "POST",
    headers: {
      Origin: "http://localhost:3000",
      Authorization: `Bearer ${user.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ slotId }),
  });
}

beforeEach(clearFirestoreEmulator);
after(async () => {
  const app = getApps().find((item) => item.name === "nexa-server");
  if (app) await deleteApp(app);
});

test("new teleconsultations store the fixed 25-minute plan and charge the service plus transaction fee", async () => {
  const patient = await createAuthUser();
  const providerUid = `doctor_${randomUUID().replaceAll("-", "")}`;
  const slotId = "a".repeat(32);
  const startsAtMs = Math.ceil((Date.now() + 2 * 60 * 60_000) / (30 * 60_000)) * (30 * 60_000);
  const startsAt = new Date(startsAtMs).toISOString();
  const endsAt = new Date(startsAtMs + 30 * 60_000).toISOString();

  await Promise.all([
    db.collection("patientProfiles").doc(patient.uid).set({
      role: "patient",
      patientNumber: "NMC-0000001",
      profileComplete: true,
    }),
    db.collection("providerProfiles").doc(providerUid).set({
      type: "doctor",
      status: "verified",
      publiclyListed: true,
      clinicalCredentialsVerified: true,
      profile: { name: "Médecin de test", indicativeFee: 5000 },
    }),
    db.collection("providerAvailabilitySlots").doc(slotId).set({
      providerUid,
      startsAt,
      endsAt,
      status: "available",
    }),
  ]);

  const response = await createAppointment(bookingRequest(patient, slotId));
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(body.durationMinutes, 25);
  assert.equal(body.amount, 5000);
  assert.equal(body.transactionFee, 175);
  assert.equal(body.totalAmount, 5175);

  const [appointmentSnapshot, paymentSnapshot, slotSnapshot] = await Promise.all([
    db.collection("appointments").doc(body.appointmentId).get(),
    db.collection("paymentIntents").doc(body.paymentRef).get(),
    db.collection("providerAvailabilitySlots").doc(slotId).get(),
  ]);
  const appointment = appointmentSnapshot.data();
  assert.equal(appointment.consultationRights.durationMinutes, 25);
  assert.equal(appointment.endsAt, endsAt, "the 30-minute booking window remains independent of the 25-minute video plan");
  assert.equal(getTeleconsultationVideoLimitSeconds(appointment), 25 * 60);
  assert.equal(paymentSnapshot.get("amount"), 5175);
  assert.equal(paymentSnapshot.get("serviceAmount"), 5000);
  assert.equal(paymentSnapshot.get("transactionFee"), 175);
  assert.equal(slotSnapshot.get("status"), "held");
});
