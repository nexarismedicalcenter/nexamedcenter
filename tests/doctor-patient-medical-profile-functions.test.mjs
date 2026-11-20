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
  throw new Error("Refusing NEXA clinical profile function tests without local Firebase emulators.");
}

const app = initializeApp({ projectId }, "doctor-patient-medical-profile-function-tests");
const db = getFirestore(app);
const apiKey = "demo-api-key";
let accountSequence = 0;

async function clearFirestoreEmulator() {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true, "Firestore Emulator must be available and clearable.");
}

async function createAuthUser(prefix) {
  accountSequence += 1;
  const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${prefix}.${randomUUID()}@example.test`, password: "NexaTestPassword-2026", returnSecureToken: true }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, `Auth Emulator account creation failed with HTTP ${response.status}.`);
  return { uid: result.localId, token: result.idToken };
}

async function callFunction(user, appointmentId) {
  const url = new URL(`http://${functionsHost}/${projectId}/us-east4/doctorPatientMedicalProfile`);
  url.searchParams.set("appointmentId", appointmentId);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${user.token}` } });
  return { status: response.status, body: await response.json() };
}

beforeEach(clearFirestoreEmulator);
after(() => deleteApp(app));

test("medical profile is disclosed only to the assigned verified doctor during the paid 24-hour clinical window", async () => {
  const doctor = await createAuthUser("clinical-profile-doctor");
  const otherDoctor = await createAuthUser("clinical-profile-other-doctor");
  const patient = await createAuthUser("clinical-profile-patient");
  const appointmentId = "clinical-profile-appointment-001";
  const startedAt = new Date(Date.now() - 5 * 60_000);
  const appointmentRef = db.collection("appointments").doc(appointmentId);

  await Promise.all([
    db.collection("providerProfiles").doc(doctor.uid).set({
      type: "doctor", status: "verified", clinicalCredentialsVerified: true,
      profile: { name: "Médecin Synthétique", specialty: "Médecine générale" },
    }),
    db.collection("providerProfiles").doc(otherDoctor.uid).set({
      type: "doctor", status: "verified", clinicalCredentialsVerified: true,
    }),
    db.collection("patientProfiles").doc(patient.uid).set({
      role: "patient", patientNumber: "NMC-0000123", firstName: "Patiente", lastName: "Synthétique",
      birthDate: "1990-02-14", sex: "Femme", profileComplete: true,
    }),
    db.collection("patientMedicalProfiles").doc(patient.uid).set({
      patientUid: patient.uid,
      languages: ["creole", "french"],
      allergies: { yes: true, details: "ALLERGY_TEST_ONLY" },
      diabetes: { diagnosed: false, sinceMonth: "" },
      hypertension: { diagnosed: false, sinceMonth: "" },
      tobacco: { yes: false, details: "" },
      alcohol: { yes: false, details: "" },
      coffee: { yes: true, details: "COFFEE_TEST_ONLY" },
      tea: { yes: false, details: "" },
      updatedAt: new Date(),
    }),
    appointmentRef.set({
      patientUid: patient.uid, providerUid: doctor.uid, providerType: "doctor",
      paymentStatus: "PAID", status: "IN_PROGRESS", effectiveConsultationStartedAt: startedAt,
    }),
  ]);

  const allowed = await callFunction(doctor, appointmentId);
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal(allowed.body.view, "provider");
  assert.deepEqual(allowed.body.patientIdentity, {
    firstName: "Patiente", lastName: "Synthétique", birthDate: "1990-02-14", sex: "Femme",
  });
  assert.equal(allowed.body.patientMedicalProfile.allergies.details, "ALLERGY_TEST_ONLY");
  assert.equal(Date.parse(allowed.body.clinicalAccessExpiresAt), startedAt.getTime() + 24 * 60 * 60_000);

  const deniedOtherDoctor = await callFunction(otherDoctor, appointmentId);
  assert.equal(deniedOtherDoctor.status, 404);
  const deniedPatient = await callFunction(patient, appointmentId);
  assert.equal(deniedPatient.status, 404);

  await appointmentRef.update({ effectiveConsultationStartedAt: new Date(Date.now() - 25 * 60 * 60_000), status: "COMPLETED" });
  const expired = await callFunction(doctor, appointmentId);
  assert.equal(expired.status, 403);

  await appointmentRef.update({ effectiveConsultationStartedAt: new Date(), paymentStatus: "PENDING", status: "IN_PROGRESS" });
  const unpaid = await callFunction(doctor, appointmentId);
  assert.equal(unpaid.status, 403);

  const audit = await db.collection("clinicalAuditLogs").where("appointmentId", "==", appointmentId).get();
  assert.equal(audit.size, 1);
  const auditData = audit.docs[0].data();
  assert.equal(auditData.actorUid, doctor.uid);
  assert.equal(auditData.action, "doctor_patient_medical_profile_accessed");
  assert.equal("patientUid" in auditData, false);
  assert.equal("patientNumber" in auditData, false);
  assert.equal(JSON.stringify(auditData).includes("ALLERGY_TEST_ONLY"), false);
});
