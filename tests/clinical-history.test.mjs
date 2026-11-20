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
if (!isLocal(authHost) || !isLocal(firestoreHost)) throw new Error("Refusing clinical history tests without local Auth and Firestore emulators.");

const [
  { getFirebaseAdminDb },
  { GET: listClinicalHistory },
  { GET: listStandaloneClinicalHistory },
  { GET: listAdminClinicalAudit },
] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/appointments/[appointmentId]/clinical-history/route.ts"),
  import("../src/app/api/provider/clinical-records/[recordId]/history/route.ts"),
  import("../src/app/api/admin/clinical-audit-logs/route.ts"),
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
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${prefix}.${Date.now()}.${sequence}@example.test`, password: "NexaTestPassword-2026", returnSecureToken: true }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, `Auth emulator account creation failed with HTTP ${response.status}.`);
  return { uid: result.localId, token: result.idToken };
}

function request(user, path) {
  return new Request(`http://localhost:3000${path}`, { headers: { Origin: "http://localhost:3000", Authorization: `Bearer ${user.token}` } });
}

async function result(response) { return { status: response.status, body: await response.json() }; }

async function createVerifiedDoctor(user, name) {
  await db.collection("providerProfiles").doc(user.uid).set({
    type: "doctor", status: "verified", clinicalCredentialsVerified: true,
    profile: { name, specialty: "Médecine générale" },
  });
}

async function seedSignedRecord({ recordId, patientUid, providerUid, finalizedAt, status = "FINALIZED", content = {} }) {
  await db.collection("electronicPatientRecords").doc(recordId).set({
    recordType: recordId.includes("standalone") ? "STANDALONE" : "APPOINTMENT",
    patientUid, providerUid, providerName: `Docteur ${providerUid.slice(0, 5)}`, specialtyName: "Médecine générale",
    recordNumber: `NEXA-2026-${recordId.slice(-7)}`, status, createdAt: new Date(finalizedAt - 60_000), finalizedAt: new Date(finalizedAt),
    signature: { uid: providerUid, name: `Docteur ${providerUid.slice(0, 5)}`, specialty: "Médecine générale", signedAt: new Date(finalizedAt).toISOString() },
    documentHash: "a".repeat(64), clinicalContent: content,
    attachments: [{ storagePath: "private/should-not-be-returned.pdf", downloadToken: "do-not-return" }],
  });
}

beforeEach(async () => {
  process.env.NEXA_ADMIN_UIDS = "";
  await clearFirestoreEmulator();
});
after(async () => {
  const app = getApps().find((item) => item.name === "nexa-server");
  if (app) await deleteApp(app);
});

test("doctor receives only other physicians’ signed notes for the authorized patient with bounded pages", async () => {
  const patient = await createUser("history-patient");
  const currentDoctor = await createUser("history-current-doctor");
  const formerDoctor = await createUser("history-former-doctor");
  await Promise.all([
    db.collection("patientProfiles").doc(patient.uid).set({ role: "patient", profileComplete: true, patientNumber: "NMC-0000042", displayName: "Patient test" }),
    createVerifiedDoctor(currentDoctor, "Médecin actuel"), createVerifiedDoctor(formerDoctor, "Médecin antérieur"),
  ]);
  const appointmentId = "clinicalHistoryCurrent01";
  await db.collection("appointments").doc(appointmentId).set({
    patientUid: patient.uid, providerUid: currentDoctor.uid, providerType: "doctor", paymentStatus: "PAID",
    status: "IN_PROGRESS", effectiveConsultationStartedAt: new Date(),
  });

  for (let index = 0; index < 11; index += 1) {
    await seedSignedRecord({
      recordId: `clinical-history-prior-${String(index).padStart(3, "0")}`,
      patientUid: patient.uid, providerUid: formerDoctor.uid, finalizedAt: Date.now() - index * 60_000,
      status: index % 2 ? "SIGNED" : "FINALIZED",
      content: { consultationReason: `Note antérieure ${index}`, privateStoragePath: "should-not-appear" },
    });
  }
  await db.collection("electronicPatientRecords").doc("clinical-history-prior-000").collection("addenda").doc("authorized-correction-001").set({
    patientUid: patient.uid, providerUid: formerDoctor.uid, reason: "Correction de date", content: "La date de suivi était le 12 mars.",
    signatureName: "Médecin antérieur", createdAt: new Date(Date.now() + 10_000), privateStoragePath: "do-not-return",
  });
  await seedSignedRecord({ recordId: "clinical-history-own-record-001", patientUid: patient.uid, providerUid: currentDoctor.uid, finalizedAt: Date.now() + 60_000, content: { consultationReason: "Note du médecin actuel" } });
  await seedSignedRecord({ recordId: "clinical-history-other-patient-01", patientUid: "other-patient-uid", providerUid: formerDoctor.uid, finalizedAt: Date.now() + 120_000, content: { consultationReason: "Note d’un autre patient" } });
  await seedSignedRecord({ recordId: "clinical-history-draft-00001", patientUid: patient.uid, providerUid: formerDoctor.uid, finalizedAt: Date.now() + 180_000, status: "DRAFT", content: { consultationReason: "Brouillon" } });
  await db.collection("electronicPatientRecords").doc("clinical-history-unsigned-0001").set({
    patientUid: patient.uid, providerUid: formerDoctor.uid, status: "FINALIZED", finalizedAt: new Date(Date.now() + 240_000),
    clinicalContent: { consultationReason: "Sans signature" }, documentHash: "a".repeat(64),
  });

  const params = Promise.resolve({ appointmentId });
  const first = await result(await listClinicalHistory(request(currentDoctor, `/api/appointments/${appointmentId}/clinical-history`), { params }));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.records.length, 10);
  assert.equal(typeof first.body.nextCursor, "string");
  assert.deepEqual(first.body.records.map((item) => item.clinicalContent.consultationReason), Array.from({ length: 10 }, (_, index) => `Note antérieure ${index}`));
  assert.equal(first.body.records.some((item) => item.clinicalContent.consultationReason === "Note du médecin actuel"), false);
  assert.equal(first.body.records.some((item) => item.clinicalContent.consultationReason === "Note d’un autre patient"), false);
  assert.equal(first.body.records[0].attachments, undefined);
  assert.equal(first.body.records[0].addenda.length, 1);
  assert.equal(first.body.records[0].addenda[0].content, "La date de suivi était le 12 mars.");
  assert.equal("privateStoragePath" in first.body.records[0].addenda[0], false);
  assert.equal(first.body.records[0].patientUid, undefined);
  assert.equal(first.body.records[0].providerUid, undefined);
  assert.equal(JSON.stringify(first.body).includes("private/should-not-be-returned.pdf"), false);
  assert.equal(JSON.stringify(first.body).includes("do-not-return"), false);
  assert.equal(JSON.stringify(first.body).includes("privateStoragePath"), false);

  const second = await result(await listClinicalHistory(request(currentDoctor, `/api/appointments/${appointmentId}/clinical-history?cursor=${encodeURIComponent(first.body.nextCursor)}`), { params }));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.records.length, 1);
  assert.equal(second.body.nextCursor, null);
  assert.equal(second.body.records[0].clinicalContent.consultationReason, "Note antérieure 10");

  const badCursor = await result(await listClinicalHistory(request(currentDoctor, `/api/appointments/${appointmentId}/clinical-history?cursor=clinical-history-other-patient-01`), { params }));
  assert.equal(badCursor.status, 400);
  assert.equal(badCursor.body.code, "invalid-history-cursor");
  const audit = await db.collection("clinicalAuditLogs").where("action", "==", "prior_clinical_history_accessed").get();
  assert.equal(audit.size, 2);
  assert.equal("patientUid" in audit.docs[0].data(), false);
  assert.equal("consultationReason" in audit.docs[0].data(), false);
});

test("clinical history is denied to another doctor and after the consultation access window expires", async () => {
  const patient = await createUser("history-expiry-patient");
  const assignedDoctor = await createUser("history-expiry-assigned-doctor");
  const otherDoctor = await createUser("history-expiry-other-doctor");
  await Promise.all([
    db.collection("patientProfiles").doc(patient.uid).set({ role: "patient", patientNumber: "NMC-0000044", profileComplete: true }),
    createVerifiedDoctor(assignedDoctor, "Médecin associé"), createVerifiedDoctor(otherDoctor, "Autre médecin"),
  ]);
  const appointmentId = "clinicalHistoryExpired01";
  const appointmentRef = db.collection("appointments").doc(appointmentId);
  await appointmentRef.set({ patientUid: patient.uid, providerUid: assignedDoctor.uid, providerType: "doctor", paymentStatus: "PAID", status: "IN_PROGRESS", effectiveConsultationStartedAt: new Date() });
  const params = Promise.resolve({ appointmentId });

  const wrongDoctor = await result(await listClinicalHistory(request(otherDoctor, `/api/appointments/${appointmentId}/clinical-history`), { params }));
  assert.equal(wrongDoctor.status, 403);

  await appointmentRef.update({ effectiveConsultationStartedAt: new Date(Date.now() - 25 * 60 * 60_000) });
  const expired = await result(await listClinicalHistory(request(assignedDoctor, `/api/appointments/${appointmentId}/clinical-history`), { params }));
  assert.equal(expired.status, 403);
  assert.equal(expired.body.code, "clinical-access-expired");
});

test("a patient-authorized standalone case can read prior notes until its own grant expires or is revoked", async () => {
  const patient = await createUser("history-standalone-patient");
  const currentDoctor = await createUser("history-standalone-doctor");
  const formerDoctor = await createUser("history-standalone-former-doctor");
  await Promise.all([createVerifiedDoctor(currentDoctor, "Médecin autorisé"), createVerifiedDoctor(formerDoctor, "Médecin précédent")]);
  const recordId = "standaloneHistoryCurrent001";
  await db.collection("electronicPatientRecords").doc(recordId).set({
    recordType: "STANDALONE", patientUid: patient.uid, providerUid: currentDoctor.uid, status: "DRAFT",
    accessGrantedAt: new Date(Date.now() - 60_000), accessExpiresAt: new Date(Date.now() + 60 * 60_000), accessRevoked: false,
  });
  await seedSignedRecord({ recordId: "standalone-history-prior-0001", patientUid: patient.uid, providerUid: formerDoctor.uid, finalizedAt: Date.now(), content: { consultationReason: "Note précédente autorisée" } });
  const params = Promise.resolve({ recordId });
  const path = `/api/provider/clinical-records/${recordId}/history`;
  const allowed = await result(await listStandaloneClinicalHistory(request(currentDoctor, path), { params }));
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal(allowed.body.records.length, 1);
  assert.equal(allowed.body.records[0].clinicalContent.consultationReason, "Note précédente autorisée");

  await db.collection("electronicPatientRecords").doc(recordId).update({ accessRevoked: true });
  const revoked = await result(await listStandaloneClinicalHistory(request(currentDoctor, path), { params }));
  assert.equal(revoked.status, 403);
  assert.equal(revoked.body.code, "clinical-access-expired");
});

test("NEXA administrators can audit a history read by record ID without receiving clinical content", async () => {
  const administrator = await createUser("history-audit-admin");
  process.env.NEXA_ADMIN_UIDS = administrator.uid;
  await db.collection("clinicalAuditLogs").doc("prior-history-audit-entry").set({
    actorUid: "doctor-uid", action: "prior_clinical_history_accessed", recordId: "standaloneHistoryCurrent001",
    recordCount: 1, createdAt: new Date(),
  });
  const response = await result(await listAdminClinicalAudit(request(administrator, "/api/admin/clinical-audit-logs")));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const event = response.body.events.find((item) => item.id === "prior-history-audit-entry");
  assert.ok(event);
  assert.equal(event.recordId, "standaloneHistoryCurrent001");
  assert.equal("patientUid" in event, false);
  assert.equal("clinicalContent" in event, false);
  assert.equal("recordCount" in event, false);
  assert.equal("hasMore" in event, false);
});
