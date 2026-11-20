import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { deleteApp, getApps } from "firebase-admin/app";

process.env.NODE_ENV = "test";
process.env.FIREBASE_PROJECT_ID = "demo-nexaris";
process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||= "demo-api-key";

const projectId = "demo-nexaris";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || "";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "";
const isLocal = (value) => value && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${value.replace(/^https?:\/\//, "")}`).hostname);
if (!isLocal(authHost) || !isLocal(firestoreHost)) throw new Error("Refusing patient medical profile tests without local Auth and Firestore emulators.");

const [
  { getFirebaseAdminDb },
  { GET: getPatientMedicalProfile, PUT: savePatientMedicalProfile },
  { GET: getConsultationRecord },
] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/patient/medical-profile/route.ts"),
  import("../src/app/api/appointments/[appointmentId]/clinical-record/route.ts"),
]);
const db = getFirebaseAdminDb();
const authBaseUrl = `http://${authHost}`;
let sequence = 0;

async function clearFirestoreEmulator() {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true, "Firestore emulator must be available and clearable.");
}

async function createUser(prefix) {
  sequence += 1;
  const response = await fetch(`${authBaseUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(process.env.NEXT_PUBLIC_FIREBASE_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${prefix}.${Date.now()}.${sequence}@example.test`, password: "NexaTestPassword-2026", returnSecureToken: true }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, `Auth emulator account creation failed with HTTP ${response.status}.`);
  return { uid: result.localId, token: result.idToken };
}

function request(user, path, method = "GET", body) {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { Origin: "http://localhost:3000", Authorization: `Bearer ${user.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function result(response) { return { status: response.status, body: await response.json() }; }

const validProfile = {
  languages: ["creole", "french"],
  allergies: { yes: true, details: "Pénicilline" },
  diabetes: { diagnosed: true, sinceMonth: "2024-03" },
  hypertension: { diagnosed: false, sinceMonth: "" },
  tobacco: { yes: false, details: "" },
  alcohol: { yes: true, details: "Occasionnel, environ une fois par mois" },
  coffee: { yes: true, details: "1 tasse par jour" },
  tea: { yes: false, details: "" },
};

async function createPatient(user, overrides = {}) {
  await db.collection("patientProfiles").doc(user.uid).set({
    uid: user.uid, role: "patient", patientNumber: "NMC-0000042", profileComplete: true,
    firstName: "Marie", lastName: "Jean", birthDate: "1990-02-14", sex: "Femme", ...overrides,
  });
}

beforeEach(clearFirestoreEmulator);
after(async () => {
  const app = getApps().find((item) => item.name === "nexa-server");
  if (app) await deleteApp(app);
});

test("patient owns and updates a separate medical profile with conditional fields validated", async () => {
  const patient = await createUser("medical-profile-patient");
  const otherPatient = await createUser("medical-profile-other");
  await Promise.all([createPatient(patient), createPatient(otherPatient, { patientNumber: "NMC-0000043", firstName: "Autre" })]);

  const initial = await result(await getPatientMedicalProfile(request(patient, "/api/patient/medical-profile")));
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal(initial.body.profile, null);
  assert.deepEqual(initial.body.identity, { firstName: "Marie", lastName: "Jean", birthDate: "1990-02-14", sex: "Femme" });

  const invalid = await result(await savePatientMedicalProfile(request(patient, "/api/patient/medical-profile", "PUT", { profile: { ...validProfile, diabetes: { diagnosed: true, sinceMonth: "2024-13" } } })));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "invalid-medical-profile");
  assert.equal((await db.collection("patientMedicalProfiles").doc(patient.uid).get()).exists, false);

  const saved = await result(await savePatientMedicalProfile(request(patient, "/api/patient/medical-profile", "PUT", { profile: validProfile })));
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const stored = await db.collection("patientMedicalProfiles").doc(patient.uid).get();
  assert.deepEqual(stored.get("allergies"), validProfile.allergies);
  assert.deepEqual(stored.get("diabetes"), validProfile.diabetes);
  assert.equal(stored.get("patientUid"), patient.uid);
  assert.equal((await db.collection("clinicalAuditLogs").where("action", "==", "patient_medical_profile_updated").get()).size, 1);

  const otherRead = await result(await getPatientMedicalProfile(request(otherPatient, "/api/patient/medical-profile")));
  assert.equal(otherRead.status, 200);
  assert.equal(otherRead.body.profile, null);
  assert.equal(otherRead.body.identity.firstName, "Autre");
});

test("only the verified doctor in an active paid consultation can read the patient medical profile", async () => {
  const patient = await createUser("medical-profile-consult-patient");
  const doctor = await createUser("medical-profile-consult-doctor");
  const otherDoctor = await createUser("medical-profile-other-doctor");
  await createPatient(patient);
  await db.collection("patientMedicalProfiles").doc(patient.uid).set(validProfile);
  for (const provider of [doctor, otherDoctor]) {
    await db.collection("providerProfiles").doc(provider.uid).set({
      type: "doctor", status: "verified", clinicalCredentialsVerified: true,
      profile: { name: "Médecin de test", specialty: "Médecine générale" },
    });
  }
  const appointmentId = "medProfileConsult0001";
  await db.collection("appointments").doc(appointmentId).set({
    patientUid: patient.uid, providerUid: doctor.uid, providerType: "doctor", providerName: "Médecin de test",
    paymentStatus: "PAID", status: "IN_PROGRESS", effectiveConsultationStartedAt: new Date(), reason: "Consultation de test",
  });

  const params = Promise.resolve({ appointmentId });
  const allowed = await result(await getConsultationRecord(request(doctor, `/api/appointments/${appointmentId}/clinical-record`), { params }));
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.deepEqual(allowed.body.patientIdentity, { firstName: "Marie", lastName: "Jean", birthDate: "1990-02-14", sex: "Femme" });
  assert.deepEqual(allowed.body.patientMedicalProfile.allergies, validProfile.allergies);
  assert.deepEqual(allowed.body.patientMedicalProfile.languages, ["creole", "french"]);
  assert.equal((await db.collection("clinicalAuditLogs").where("action", "==", "doctor_patient_medical_profile_accessed").get()).size, 1);
  const accessAudit = (await db.collection("clinicalAuditLogs").where("action", "==", "doctor_patient_medical_profile_accessed").get()).docs[0].data();
  assert.equal("allergies" in accessAudit, false);
  assert.equal("patientUid" in accessAudit, false);

  const wrongDoctor = await result(await getConsultationRecord(request(otherDoctor, `/api/appointments/${appointmentId}/clinical-record`), { params }));
  assert.equal(wrongDoctor.status, 403);

  const expiredAppointmentId = "medProfileConsultExpired01";
  await db.collection("appointments").doc(expiredAppointmentId).set({
    patientUid: patient.uid, providerUid: doctor.uid, providerType: "doctor", paymentStatus: "PAID", status: "IN_PROGRESS",
    effectiveConsultationStartedAt: new Date(Date.now() - 25 * 60 * 60_000),
  });
  const expiredParams = Promise.resolve({ appointmentId: expiredAppointmentId });
  const expired = await result(await getConsultationRecord(request(doctor, `/api/appointments/${expiredAppointmentId}/clinical-record`), { params: expiredParams }));
  assert.equal(expired.status, 403);
  assert.equal(expired.body.code, "clinical-access-expired");
});
