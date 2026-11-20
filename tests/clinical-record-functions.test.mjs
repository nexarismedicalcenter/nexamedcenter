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
  throw new Error("Refusing NEXA clinical record tests without local Firebase emulators.");
}

const app = initializeApp({ projectId }, "clinical-record-function-tests");
const db = getFirestore(app);
const apiKey = "demo-api-key";

async function clearFirestoreEmulator() {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true, "Firestore Emulator must be available and clearable.");
}

async function createAuthUser(prefix) {
  const response = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${prefix}.${randomUUID()}@example.test`, password: "NexaTestPassword-2026", returnSecureToken: true }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, `Auth Emulator account creation failed with HTTP ${response.status}.`);
  return { uid: result.localId, token: result.idToken };
}

async function requestRecord(user, appointmentId, method = "GET", body = undefined) {
  const url = new URL(`http://${functionsHost}/${projectId}/us-east4/nexaClinicalRecord`);
  url.searchParams.set("appointmentId", appointmentId);
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${user.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function fixture({ startedAt = new Date(Date.now() - 60_000) } = {}) {
  const patient = await createAuthUser("clinical-patient");
  const doctor = await createAuthUser("clinical-doctor");
  const otherDoctor = await createAuthUser("clinical-other-doctor");
  const appointmentId = `clinical-${randomUUID().replaceAll("-", "")}`;
  await Promise.all([
    db.collection("providerProfiles").doc(doctor.uid).set({ type: "doctor", status: "verified", clinicalCredentialsVerified: true, profile: { name: "Dr NEXA Test", specialty: "Médecine générale" } }),
    db.collection("providerProfiles").doc(otherDoctor.uid).set({ type: "doctor", status: "verified", clinicalCredentialsVerified: true, profile: { name: "Autre médecin" } }),
    db.collection("patientProfiles").doc(patient.uid).set({ role: "patient", patientNumber: "NMC-0000123", profileComplete: true, firstName: "Patient", lastName: "Test" }),
    db.collection("appointments").doc(appointmentId).set({
      patientUid: patient.uid, providerUid: doctor.uid, providerType: "doctor", bookingType: "teleconsultation",
      paymentStatus: "PAID", status: "IN_PROGRESS", effectiveConsultationStartedAt: startedAt,
      reason: "Suivi de santé",
    }),
  ]);
  return { patient, doctor, otherDoctor, appointmentId };
}

beforeEach(clearFirestoreEmulator);
after(() => deleteApp(app));

test("doctor drafts, finalizes and corrects a consultation record while patient sees only the finalized version", async () => {
  const data = await fixture();
  const opened = await requestRecord(data.doctor, data.appointmentId);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.view, "provider");
  assert.equal(opened.body.record.status, "DRAFT");
  assert.equal(opened.body.record.clinicalContent.consultationReason, "Suivi de santé");

  const hiddenDraft = await requestRecord(data.patient, data.appointmentId);
  assert.equal(hiddenDraft.status, 200);
  assert.equal(hiddenDraft.body.record, null);

  const draftContent = {
    consultationReason: "Suivi de santé",
    clinicalObservations: "Observation clinique synthétique.",
    clinicalAssessment: "Évaluation de test.",
    carePlan: "Plan de suivi synthétique.",
  };
  const saved = await requestRecord(data.doctor, data.appointmentId, "POST", { action: "saveDraft", clinicalContent: draftContent });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.record.version, 2);
  assert.equal(saved.body.record.status, "DRAFT");

  const finalized = await requestRecord(data.doctor, data.appointmentId, "POST", { action: "finalize", clinicalContent: draftContent });
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
  assert.equal(finalized.body.record.version, 3);
  assert.equal(finalized.body.record.status, "FINALIZED");
  assert.equal(finalized.body.record.signature.name, "Dr NEXA Test");
  assert.match(finalized.body.record.documentHash, /^[a-f0-9]{64}$/);

  const patientRecord = await requestRecord(data.patient, data.appointmentId);
  assert.equal(patientRecord.status, 200, JSON.stringify(patientRecord.body));
  assert.equal(patientRecord.body.view, "patient");
  assert.equal(patientRecord.body.record.clinicalContent.clinicalAssessment, "Évaluation de test.");
  assert.equal("patientUid" in patientRecord.body.record, false);

  const immutable = await requestRecord(data.doctor, data.appointmentId, "POST", { action: "saveDraft", clinicalContent: draftContent });
  assert.equal(immutable.status, 409);

  const correction = await requestRecord(data.doctor, data.appointmentId, "POST", { action: "addendum", reason: "Correction de suivi", content: "Ajout clinique de test." });
  assert.equal(correction.status, 200, JSON.stringify(correction.body));
  assert.equal(correction.body.record.addendumCount, 1);
  const patientAfterCorrection = await requestRecord(data.patient, data.appointmentId);
  assert.equal(patientAfterCorrection.body.record.addenda[0].content, "Ajout clinique de test.");

  const versions = await db.collection("electronicPatientRecords").doc(data.appointmentId).collection("versions").orderBy("version").get();
  assert.deepEqual(versions.docs.map((doc) => doc.get("changeType")), ["INITIAL", "DRAFT_SAVED", "FINALIZED"]);
  const audits = await db.collection("clinicalAuditLogs").where("appointmentId", "==", data.appointmentId).get();
  assert.equal(audits.size >= 5, true);
});

test("clinical record access is limited to the assigned verified doctor and the active 24-hour window", async () => {
  const data = await fixture({ startedAt: new Date(Date.now() - 25 * 60 * 60_000) });
  await db.collection("appointments").doc(data.appointmentId).update({ status: "COMPLETED" });
  const expired = await requestRecord(data.doctor, data.appointmentId);
  assert.equal(expired.status, 403);

  await db.collection("appointments").doc(data.appointmentId).update({ status: "IN_PROGRESS", effectiveConsultationStartedAt: new Date(Date.now() - 60_000) });
  const other = await requestRecord(data.otherDoctor, data.appointmentId);
  assert.equal(other.status, 403);
  const owner = await requestRecord(data.patient, data.appointmentId);
  assert.equal(owner.status, 200);
  assert.equal(owner.body.record, null);
});

test("finalization requires clinical content and rejects invalid vital signs", async () => {
  const data = await fixture();
  const empty = await requestRecord(data.doctor, data.appointmentId, "POST", { action: "finalize", clinicalContent: {} });
  assert.equal(empty.status, 400);
  const invalid = await requestRecord(data.doctor, data.appointmentId, "POST", {
    action: "saveDraft", clinicalContent: { clinicalObservations: "Donnée synthétique", patientVitals: { systolic: "pas-un-nombre" } },
  });
  assert.equal(invalid.status, 400);
  const record = await db.collection("electronicPatientRecords").doc(data.appointmentId).get();
  assert.equal(record.get("status"), "DRAFT");
  assert.equal(record.get("version"), 1);
});
