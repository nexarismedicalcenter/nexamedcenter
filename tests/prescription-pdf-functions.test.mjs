import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const projectId = "demo-nexaris";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || "";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "";
const functionsHost = process.env.NEXA_FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const isLocal = (value) => value && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${value.replace(/^https?:\/\//, "")}`).hostname);
if (!isLocal(authHost) || !isLocal(firestoreHost) || !isLocal(functionsHost)) {
  throw new Error("Refusing prescription PDF tests without local Firebase emulators.");
}

const app = initializeApp({ projectId }, "prescription-pdf-function-tests");
const db = getFirestore(app);
const apiKey = "demo-api-key";

async function clearFirestoreEmulator() {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true, "Firestore Emulator must be available and clearable.");
}

async function createAuthUser(prefix) {
  const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${prefix}.${randomUUID()}@example.test`, password: "NexaTestPassword-2026", returnSecureToken: true }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, `Auth Emulator account creation failed with HTTP ${response.status}.`);
  return { uid: result.localId, token: result.idToken };
}

async function download(user, prescriptionId) {
  const url = new URL(`http://${functionsHost}/${projectId}/us-east4/nexaPrescriptionPdf`);
  url.searchParams.set("prescriptionId", prescriptionId);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${user.token}` } });
  return { status: response.status, contentType: response.headers.get("Content-Type") || "", body: Buffer.from(await response.arrayBuffer()) };
}

async function fixture({ startedAt = new Date(Date.now() - 60_000), status = "VALIDATED" } = {}) {
  const patient = await createAuthUser("prescription-pdf-patient");
  const doctor = await createAuthUser("prescription-pdf-doctor");
  const otherDoctor = await createAuthUser("prescription-pdf-other-doctor");
  const appointmentId = `pdf-appointment-${randomUUID().replaceAll("-", "")}`;
  const prescriptionId = `pdf-prescription-${randomUUID().replaceAll("-", "")}`;
  await Promise.all([
    db.collection("patientProfiles").doc(patient.uid).set({ role: "patient", profileComplete: true, displayName: "Patient NEXA de test", patientNumber: "NMC-0000123" }),
    db.collection("providerProfiles").doc(doctor.uid).set({ type: "doctor", status: "verified", clinicalCredentialsVerified: true, profile: { name: "Dr NEXA Test", specialty: "Médecine générale" } }),
    db.collection("providerProfiles").doc(otherDoctor.uid).set({ type: "doctor", status: "verified", clinicalCredentialsVerified: true, profile: { name: "Autre médecin" } }),
    db.collection("appointments").doc(appointmentId).set({
      patientUid: patient.uid, providerUid: doctor.uid, providerType: "doctor", bookingType: "teleconsultation",
      paymentStatus: "PAID", status: "IN_PROGRESS", effectiveConsultationStartedAt: startedAt,
    }),
    db.collection("clinicalPrescriptions").doc(prescriptionId).set({
      appointmentId, patientUid: patient.uid, providerUid: doctor.uid, providerName: "Dr NEXA Test", specialtyName: "Médecine générale",
      medications: [{ name: "Amoxicilline", dosage: "500 mg", form: "Capsule", route: "Orale", quantity: 14, duration: "7 jours", instructions: "Une gélule matin et soir" }],
      labExams: ["Numération formule sanguine"], imagingExams: ["Radiographie thoracique"], notes: "Prendre avec de l’eau.",
      status, version: 2, validatedAt: new Date(Date.now() - 60_000),
      signature: { uid: doctor.uid, name: "Dr NEXA Test", specialty: "Médecine générale", signedAt: new Date(Date.now() - 60_000).toISOString() },
    }),
  ]);
  return { patient, doctor, otherDoctor, appointmentId, prescriptionId };
}

beforeEach(clearFirestoreEmulator);
after(() => deleteApp(app));

test("the patient downloads only their validated prescription PDF and the access is audited", async () => {
  const data = await fixture();
  const response = await download(data.patient, data.prescriptionId);
  assert.equal(response.status, 200);
  assert.match(response.contentType, /application\/pdf/i);
  assert.equal(response.body.subarray(0, 8).toString("ascii"), "%PDF-1.4");
  const document = response.body.toString("latin1");
  assert.match(document, /Patient NEXA de test/);
  assert.match(document, /NMC-0000123/);
  assert.match(document, /Amoxicilline/);
  assert.match(document, /Num.ration formule sanguine/);
  assert.equal(document.includes(data.patient.uid), false);
  assert.equal(document.includes(data.appointmentId), false);
  const audit = await db.collection("clinicalAuditLogs").where("prescriptionId", "==", data.prescriptionId).get();
  assert.equal(audit.size, 1);
  assert.equal(audit.docs[0].get("action"), "clinical_prescription_pdf_downloaded");
});

test("the assigned doctor can download only during active clinical access", async () => {
  const data = await fixture();
  const authorized = await download(data.doctor, data.prescriptionId);
  assert.equal(authorized.status, 200);

  const otherDoctor = await download(data.otherDoctor, data.prescriptionId);
  assert.equal(otherDoctor.status, 403);

  await db.collection("appointments").doc(data.appointmentId).update({ effectiveConsultationStartedAt: new Date(Date.now() - 25 * 60 * 60_000), status: "COMPLETED" });
  const expired = await download(data.doctor, data.prescriptionId);
  assert.equal(expired.status, 403);
});

test("another patient and a draft cannot download an ordonnance PDF", async () => {
  const data = await fixture();
  const otherPatient = await createAuthUser("prescription-pdf-other-patient");
  await db.collection("patientProfiles").doc(otherPatient.uid).set({ role: "patient", profileComplete: true, patientNumber: "NMC-0000456" });
  const denied = await download(otherPatient, data.prescriptionId);
  assert.equal(denied.status, 403);

  await db.collection("clinicalPrescriptions").doc(data.prescriptionId).update({ signature: null });
  const unsigned = await download(data.patient, data.prescriptionId);
  assert.equal(unsigned.status, 409);

  const draft = await fixture({ status: "DRAFT" });
  const notReady = await download(draft.patient, draft.prescriptionId);
  assert.equal(notReady.status, 404);
});
