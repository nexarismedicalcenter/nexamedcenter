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
if (!isLocal(authHost) || !isLocal(firestoreHost)) throw new Error("Refusing clinical access tests without local Auth and Firestore emulators.");

const [
  { getFirebaseAdminDb },
  { GET: getClinicalRecord, POST: writeClinicalRecord },
  { GET: getClinicalVersions },
  { GET: getClinicalAttachment },
  { GET: getPrescriptions, POST: writePrescription },
  { POST: proposeFollowUp },
] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/appointments/[appointmentId]/clinical-record/route.ts"),
  import("../src/app/api/appointments/[appointmentId]/clinical-record/versions/route.ts"),
  import("../src/app/api/appointments/[appointmentId]/clinical-record/attachments/route.ts"),
  import("../src/app/api/appointments/[appointmentId]/prescriptions/route.ts"),
  import("../src/app/api/appointments/[appointmentId]/follow-up-proposals/route.ts"),
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

beforeEach(clearFirestoreEmulator);
after(async () => {
  const app = getApps().find((item) => item.name === "nexa-server");
  if (app) await deleteApp(app);
});

test("consultation clinical reads and writes stop at 24 hours while the patient's own record remains available", async () => {
  const doctor = await createUser("clinical-access-doctor");
  const patient = await createUser("clinical-access-patient");
  const appointmentId = "clinical-access-expired-001";
  const appointmentPath = `/api/appointments/${appointmentId}`;
  const sessionStartedAt = new Date(Date.now() - 25 * 60 * 60_000);
  await Promise.all([
    db.collection("providerProfiles").doc(doctor.uid).set({ type: "doctor", status: "verified", clinicalCredentialsVerified: true, profile: { name: "Médecin de test" } }),
    db.collection("patientProfiles").doc(patient.uid).set({ role: "patient", profileComplete: true, patientNumber: "NMC-0000001" }),
    db.collection("appointments").doc(appointmentId).set({
      patientUid: patient.uid,
      providerUid: doctor.uid,
      providerType: "doctor",
      status: "COMPLETED",
      paymentStatus: "PAID",
      sessionStartedAt,
    }),
    db.collection("electronicPatientRecords").doc(appointmentId).set({
      appointmentId,
      patientUid: patient.uid,
      providerUid: doctor.uid,
      providerName: "Médecin de test",
      recordNumber: "NEXA-2026-0000001",
      status: "FINALIZED",
      version: 1,
      clinicalContent: { diagnoses: "DONNEE_CLINIQUE_SYNTHETIQUE" },
      attachments: [{ id: "attachment_test_001", originalFileName: "resultat.pdf", contentType: "application/pdf", size: 100, storagePath: `nexa-clinical-records/${appointmentId}/attachment_test_001`, antivirusStatus: "CLEAN", sha256Hash: "a".repeat(64) }],
    }),
  ]);

  const patientRecord = await result(await getClinicalRecord(request(patient, `${appointmentPath}/clinical-record`), { params: Promise.resolve({ appointmentId }) }));
  const providerRecord = await result(await getClinicalRecord(request(doctor, `${appointmentPath}/clinical-record`), { params: Promise.resolve({ appointmentId }) }));
  const providerWrite = await result(await writeClinicalRecord(request(doctor, `${appointmentPath}/clinical-record`, "POST", { action: "addendum", content: "Nouvelle note", reason: "Correction" }), { params: Promise.resolve({ appointmentId }) }));
  const history = await result(await getClinicalVersions(request(doctor, `${appointmentPath}/clinical-record/versions`), { params: Promise.resolve({ appointmentId }) }));
  const attachment = await result(await getClinicalAttachment(request(doctor, `${appointmentPath}/clinical-record/attachments?attachmentId=attachment_test_001`), { params: Promise.resolve({ appointmentId }) }));
  const prescriptionRead = await result(await getPrescriptions(request(doctor, `${appointmentPath}/prescriptions`), { params: Promise.resolve({ appointmentId }) }));
  const prescriptionWrite = await result(await writePrescription(request(doctor, `${appointmentPath}/prescriptions`, "POST", { action: "createDraft", content: { medications: [], labExams: [], imagingExams: [], notes: "" } }), { params: Promise.resolve({ appointmentId }) }));
  const followUp = await result(await proposeFollowUp(request(doctor, `${appointmentPath}/follow-up-proposals`, "POST", { slotId: "a".repeat(32) }), { params: Promise.resolve({ appointmentId }) }));

  assert.equal(patientRecord.status, 200);
  assert.equal(patientRecord.body.record.clinicalContent.diagnoses, "DONNEE_CLINIQUE_SYNTHETIQUE");
  for (const denied of [providerRecord, providerWrite, history, attachment, prescriptionRead, prescriptionWrite, followUp]) {
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.code, "clinical-access-expired");
  }
  assert.equal((await db.collection("electronicPatientRecords").doc(appointmentId).get()).get("addendumCount") || 0, 0);
  assert.equal((await db.collection("clinicalPrescriptions").get()).size, 0);
  assert.equal((await db.collection("followUpProposals").get()).size, 0);
});
