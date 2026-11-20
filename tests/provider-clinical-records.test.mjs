import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { deleteApp, getApps } from "firebase-admin/app";

process.env.NODE_ENV = "test";
process.env.FIREBASE_PROJECT_ID = "demo-nexaris";
process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||= "demo-api-key";
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = "demo-nexaris";

const projectId = "demo-nexaris";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || "";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "";
const isLocal = (value) => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${value.replace(/^https?:\/\//, "")}`).hostname);
if (!authHost || !firestoreHost || !isLocal(authHost) || !isLocal(firestoreHost)) {
  throw new Error("Refusing clinical record library tests without local Auth and Firestore emulators.");
}

const [{ getFirebaseAdminDb }, { GET }] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/provider/clinical-records/route.ts"),
]);
const db = getFirebaseAdminDb();
const authBaseUrl = `http://${authHost}`;
const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
let userSequence = 0;

async function clearFirestoreEmulator() {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true, "Firestore emulator must be available and clearable.");
}

async function createAuthUser(prefix) {
  userSequence += 1;
  const email = `${prefix}.${Date.now()}.${userSequence}@example.test`;
  const response = await fetch(`${authBaseUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "NexaTestPassword-2026", returnSecureToken: true }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, `Auth emulator account creation failed with HTTP ${response.status}.`);
  return { uid: result.localId, token: result.idToken };
}

function makeRequest(user, query = "") {
  return new Request(`http://localhost:3000/api/provider/clinical-records${query}`, {
    headers: { Origin: "http://localhost:3000", ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
  });
}

async function readResponse(response) {
  return { status: response.status, body: await response.json() };
}

async function createDoctor(user, { verified = true } = {}) {
  await db.collection("providerProfiles").doc(user.uid).set({
    type: "doctor",
    status: verified ? "verified" : "pending",
    clinicalCredentialsVerified: verified,
  });
}

async function seedRecord({ appointmentId, doctorUid, patientUid, patientName, recordNumber }) {
  await db.collection("appointments").doc(appointmentId).set({
    providerUid: doctorUid, providerType: "doctor", patientUid, status: "COMPLETED", paymentStatus: "PAID",
    effectiveConsultationStartedAt: new Date(Date.now() - 60 * 60_000),
  });
  await db.collection("electronicPatientRecords").doc(appointmentId).set({
    appointmentId,
    providerUid: doctorUid,
    patientUid,
    patientName,
    patientNumber: "NMC-0000007",
    recordNumber,
    status: "FINALIZED",
    type: "TELECONSULTATION",
    specialtyName: "Médecine générale",
    createdAt: new Date("2026-11-07T12:00:00.000Z"),
    clinicalContent: { diagnoses: "SYNTHETIC_PRIVATE_CLINICAL_NOTE" },
  });
}

beforeEach(async () => { await clearFirestoreEmulator(); });

after(async () => {
  const adminApp = getApps().find((app) => app.name === "nexa-server");
  if (adminApp) await deleteApp(adminApp);
});

test("verified doctors see only their authored records and the list omits clinical content", async () => {
  const doctor = await createAuthUser("doctor-records");
  const otherDoctor = await createAuthUser("other-doctor-records");
  const patient = await createAuthUser("patient-records");
  await createDoctor(doctor);
  await createDoctor(otherDoctor);
  await seedRecord({ appointmentId: "appointment_doctor_a_001", doctorUid: doctor.uid, patientUid: patient.uid, patientName: "Patient synthétique", recordNumber: "DEP-A-001" });
  await seedRecord({ appointmentId: "appointment_doctor_b_001", doctorUid: otherDoctor.uid, patientUid: patient.uid, patientName: "Patient synthétique", recordNumber: "DEP-B-001" });

  const response = await readResponse(await GET(makeRequest(doctor)));

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.records.length, 1);
  assert.equal(response.body.records[0].appointmentId, "appointment_doctor_a_001");
  assert.equal(response.body.records[0].recordNumber, "DEP-A-001");
  assert.equal("patientUid" in response.body.records[0], false);
  assert.equal("clinicalContent" in response.body.records[0], false);
  assert.equal(JSON.stringify(response.body).includes("SYNTHETIC_PRIVATE_CLINICAL_NOTE"), false);
  const logs = await db.collection("clinicalAuditLogs").get();
  assert.equal(logs.size, 1);
  assert.equal(logs.docs[0].get("action"), "provider_clinical_record_library_accessed");
});

test("patient filter returns only that doctor’s matching records and validates the filter", async () => {
  const doctor = await createAuthUser("doctor-filter");
  const patientOne = await createAuthUser("patient-one");
  const patientTwo = await createAuthUser("patient-two");
  await createDoctor(doctor);
  await seedRecord({ appointmentId: "appointment_patient_one_001", doctorUid: doctor.uid, patientUid: patientOne.uid, patientName: "Premier patient", recordNumber: "DEP-P1-001" });
  await seedRecord({ appointmentId: "appointment_patient_two_001", doctorUid: doctor.uid, patientUid: patientTwo.uid, patientName: "Deuxième patient", recordNumber: "DEP-P2-001" });

  const filtered = await readResponse(await GET(makeRequest(doctor, `?patientUid=${encodeURIComponent(patientOne.uid)}`)));
  const invalid = await readResponse(await GET(makeRequest(doctor, "?patientUid=unsafe%2Ffilter")));

  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.records.map((record) => record.recordNumber), ["DEP-P1-001"]);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "invalid-patient-filter");
});

test("expired consultation records no longer appear in a doctor's clinical library", async () => {
  const doctor = await createAuthUser("doctor-expired-record");
  const patient = await createAuthUser("patient-expired-record");
  await createDoctor(doctor);
  const appointmentId = "appointment_expired_record_001";
  await seedRecord({ appointmentId, doctorUid: doctor.uid, patientUid: patient.uid, patientName: "Patient synthétique", recordNumber: "DEP-EXPIRED-001" });
  await db.collection("appointments").doc(appointmentId).update({ effectiveConsultationStartedAt: new Date(Date.now() - 25 * 60 * 60_000) });

  const response = await readResponse(await GET(makeRequest(doctor)));

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.records, []);
});

test("anonymous users and doctors without verified clinical credentials are denied", async () => {
  const pendingDoctor = await createAuthUser("pending-doctor");
  await createDoctor(pendingDoctor, { verified: false });

  const anonymous = await readResponse(await GET(makeRequest(null)));
  const pending = await readResponse(await GET(makeRequest(pendingDoctor)));

  assert.equal(anonymous.status, 401);
  assert.equal(pending.status, 403);
  assert.equal(pending.body.code, "verified-doctor-required");
  assert.equal((await db.collection("clinicalAuditLogs").get()).size, 0);
});
