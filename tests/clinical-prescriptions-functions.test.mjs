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
if (!isLocal(authHost) || !isLocal(firestoreHost) || !isLocal(functionsHost)) throw new Error("Refusing clinical prescription tests without local Firebase emulators.");

const app = initializeApp({ projectId }, "clinical-prescription-function-tests");
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

async function call(user, functionName, query, method = "GET", body = undefined) {
  const url = new URL(`http://${functionsHost}/${projectId}/us-east4/${functionName}`);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${user.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function fixture() {
  const patient = await createAuthUser("clinical-prescription-patient");
  const doctor = await createAuthUser("clinical-prescription-doctor");
  const otherDoctor = await createAuthUser("clinical-prescription-other-doctor");
  const appointmentId = `prescription-appointment-${randomUUID().replaceAll("-", "")}`;
  await Promise.all([
    db.collection("patientProfiles").doc(patient.uid).set({ role: "patient", profileComplete: true, patientNumber: "NMC-0000456", displayName: "Patient de test", department: "Ouest", commune: "Port-au-Prince" }),
    db.collection("providerProfiles").doc(doctor.uid).set({ type: "doctor", status: "verified", clinicalCredentialsVerified: true, profile: { name: "Dr NEXA Test", specialty: "Médecine générale" } }),
    db.collection("providerProfiles").doc(otherDoctor.uid).set({ type: "doctor", status: "verified", clinicalCredentialsVerified: true, profile: { name: "Autre médecin" } }),
    db.collection("appointments").doc(appointmentId).set({
      patientUid: patient.uid, providerUid: doctor.uid, providerType: "doctor", bookingType: "teleconsultation",
      paymentStatus: "PAID", status: "IN_PROGRESS", effectiveConsultationStartedAt: new Date(Date.now() - 60_000),
    }),
  ]);
  return { patient, doctor, otherDoctor, appointmentId };
}

beforeEach(clearFirestoreEmulator);
after(() => deleteApp(app));

test("doctor drafts, validates and corrects a prescription; the patient sees only the current validated version", async () => {
  const data = await fixture();
  const query = { appointmentId: data.appointmentId };
  const content = {
    medications: [{ name: "Amoxicilline", dosage: "500 mg", form: "Capsule", route: "Orale", quantity: 14, duration: "7 jours", instructions: "Matin et soir" }],
    labExams: ["Numération formule sanguine"], imagingExams: [], notes: "Boire de l’eau.",
  };
  const draft = await call(data.doctor, "nexaClinicalPrescriptions", query, "POST", { action: "createDraft", content });
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  assert.equal(draft.body.status, "DRAFT");
  const hidden = await call(data.patient, "nexaPatientPrescriptions", {});
  assert.equal(hidden.status, 200);
  assert.equal(hidden.body.prescriptions.length, 0);

  const saved = await call(data.doctor, "nexaClinicalPrescriptions", query, "POST", { action: "updateDraft", prescriptionId: draft.body.prescriptionId, content });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const validated = await call(data.doctor, "nexaClinicalPrescriptions", query, "POST", { action: "validate", prescriptionId: draft.body.prescriptionId });
  assert.equal(validated.status, 200, JSON.stringify(validated.body));
  assert.equal(validated.body.status, "VALIDATED");
  assert.equal(validated.body.version, 1);

  const correctedContent = { ...content, medications: [{ ...content.medications[0], dosage: "250 mg" }] };
  const corrected = await call(data.doctor, "nexaClinicalPrescriptions", query, "POST", { action: "correct", prescriptionId: draft.body.prescriptionId, content: correctedContent });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  assert.equal(corrected.body.version, 2);
  const patientList = await call(data.patient, "nexaPatientPrescriptions", {});
  assert.equal(patientList.status, 200, JSON.stringify(patientList.body));
  assert.equal(patientList.body.prescriptions.length, 1);
  assert.equal(patientList.body.prescriptions[0].id, corrected.body.prescriptionId);
  assert.equal(patientList.body.prescriptions[0].medications[0].dosage, "250 mg");
  assert.equal("patientUid" in patientList.body.prescriptions[0], false);
  const previous = await db.collection("clinicalPrescriptions").doc(draft.body.prescriptionId).get();
  assert.equal(previous.get("status"), "REPLACED");
  const notices = await db.collection("userNotifications").where("uid", "==", data.patient.uid).get();
  assert.equal(notices.size, 2);
});

test("only the assigned verified doctor with active clinical access can read prescriptions", async () => {
  const data = await fixture();
  const created = await call(data.doctor, "nexaClinicalPrescriptions", { appointmentId: data.appointmentId }, "POST", {
    action: "createDraft", content: { medications: [], labExams: [], imagingExams: [], notes: "" },
  });
  assert.equal(created.status, 200);
  const wrongDoctor = await call(data.otherDoctor, "nexaClinicalPrescriptions", { appointmentId: data.appointmentId });
  assert.equal(wrongDoctor.status, 403);
  await db.collection("appointments").doc(data.appointmentId).update({ effectiveConsultationStartedAt: new Date(Date.now() - 25 * 60 * 60_000), status: "COMPLETED" });
  const expired = await call(data.doctor, "nexaClinicalPrescriptions", { appointmentId: data.appointmentId });
  assert.equal(expired.status, 403);
});

test("availability returns only sellable offers from verified partners for the patient's prescription", async () => {
  const data = await fixture();
  const prescriptionId = `availability-prescription-${randomUUID().replaceAll("-", "")}`;
  await db.collection("clinicalPrescriptions").doc(prescriptionId).set({
    patientUid: data.patient.uid, providerUid: data.doctor.uid, appointmentId: data.appointmentId,
    status: "VALIDATED", expiresAt: "2030-01-01T00:00:00.000Z",
    medications: [{ name: "Amoxicilline", dosage: "500 mg", form: "Capsule", quantity: 14 }],
    labExams: ["Hémogramme complet"], imagingExams: [],
  });
  await Promise.all([
    db.collection("providerProfiles").doc("verified-pharmacy").set({ type: "pharmacy", status: "verified", publiclyListed: true, profile: { name: "Pharmacie locale", department: "Ouest", commune: "Port-au-Prince" } }),
    db.collection("providerProfiles").doc("hidden-pharmacy").set({ type: "pharmacy", status: "pending", publiclyListed: false, profile: { name: "Pharmacie non vérifiée" } }),
    db.collection("providerProfiles").doc("verified-lab").set({ type: "laboratory", status: "verified", publiclyListed: true, profile: { name: "Laboratoire local", department: "Ouest", commune: "Port-au-Prince" } }),
    db.collection("pharmacyProducts").doc("sellable-medicine").set({
      providerUid: "verified-pharmacy", publicationStatus: "PUBLISHED", active: true, name: "Amoxicilline", dosage: "500 mg", route: "Orale", pharmaceuticalForm: "Capsule", price: 450,
      regulatoryCategory: "PRESCRIPTION", lots: [{ status: "ACTIVE", expirationDate: "2030-01-01", quantityAvailable: 5, reservedQuantity: 2 }],
    }),
    db.collection("pharmacyProducts").doc("expired-medicine").set({
      providerUid: "verified-pharmacy", publicationStatus: "PUBLISHED", active: true, name: "Amoxicilline", dosage: "500 mg", route: "Orale", pharmaceuticalForm: "Capsule", price: 400,
      regulatoryCategory: "PRESCRIPTION", lots: [{ status: "ACTIVE", expirationDate: "2020-01-01", quantityAvailable: 8, reservedQuantity: 0 }],
    }),
    db.collection("pharmacyProducts").doc("unverified-medicine").set({
      providerUid: "hidden-pharmacy", publicationStatus: "PUBLISHED", active: true, name: "Amoxicilline", dosage: "500 mg", route: "Orale", pharmaceuticalForm: "Capsule", price: 300,
      regulatoryCategory: "PRESCRIPTION", lots: [{ status: "ACTIVE", expirationDate: "2030-01-01", quantityAvailable: 5, reservedQuantity: 0 }],
    }),
    db.collection("diagnosticOffers").doc("verified-lab-offer").set({ providerUid: "verified-lab", providerType: "laboratory", publicationStatus: "PUBLISHED", active: true, requestedAvailability: true, name: "Hémogramme complet", price: 850 }),
  ]);
  const found = await call(data.patient, "nexaPrescriptionAvailability", { prescriptionId });
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.deepEqual(found.body.lines.map((line) => line.status), ["DISPONIBLE", "DISPONIBLE"]);
  assert.equal(found.body.lines[0].offers.length, 1);
  assert.equal(found.body.lines[0].offers[0].stock, 3);
  assert.equal(found.body.lines[0].offers[0].id, "sellable-medicine");
  assert.equal(found.body.lines[1].offers[0].id, "verified-lab-offer");
  assert.equal(JSON.stringify(found.body).includes(data.patient.uid), false);

  const otherPatient = await createAuthUser("availability-other-patient");
  await db.collection("patientProfiles").doc(otherPatient.uid).set({ role: "patient", profileComplete: true });
  const denied = await call(otherPatient, "nexaPrescriptionAvailability", { prescriptionId });
  assert.equal(denied.status, 403);
});
