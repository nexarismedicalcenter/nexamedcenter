import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { deleteApp, getApps } from "firebase-admin/app";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

process.env.NODE_ENV = "test";
process.env.FIREBASE_PROJECT_ID = "demo-nexaris";
process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||= "demo-api-key";
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = "demo-nexaris";
process.env.FIREBASE_STORAGE_BUCKET = "demo-nexaris.appspot.com";

const projectId = "demo-nexaris";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || "";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "";
const storageHost = process.env.STORAGE_EMULATOR_HOST || process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199";
const isLocal = (value) => value && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${value.replace(/^https?:\/\//, "")}`).hostname);
if (!isLocal(authHost) || !isLocal(firestoreHost) || !isLocal(storageHost)) throw new Error("Refusing patient result tests without local Auth, Firestore, and Storage emulators.");
process.env.STORAGE_EMULATOR_HOST = storageHost.startsWith("http") ? storageHost : `http://${storageHost}`;

let scannerVerdict = "CLEAN";
const scanner = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/scan") { response.writeHead(404).end(); return; }
  request.resume();
  request.on("end", () => response.writeHead(scannerVerdict === "UNAVAILABLE" ? 503 : 200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: scannerVerdict, scannerVersion: "emulator-test-scanner" })));
});

const [
  { getFirebaseAdminAuth, getFirebaseAdminDb, getFirebaseAdminStorage },
  { POST: submitPatientResult },
  { GET: listPatientResults },
  { GET: listProviderResults },
  { GET: getProviderResult },
  { GET: getProviderResultFile },
  { GET: getPatientResultFile },
  { POST: submitFollowUpAction },
  { GET: listPatientPrescriptions },
  { GET: listPatientClinicalRecords },
  { GET: getPatientClinicalRecord },
  { GET: cleanupExpiredResultUploads },
] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/patient/diagnostic-results/submit/route.ts"),
  import("../src/app/api/patient/diagnostic-results/route.ts"),
  import("../src/app/api/provider/patient-result-submissions/route.ts"),
  import("../src/app/api/provider/patient-result-submissions/[resultId]/route.ts"),
  import("../src/app/api/provider/patient-result-submissions/[resultId]/files/[fileId]/route.ts"),
  import("../src/app/api/patient/diagnostic-results/[resultId]/files/[fileId]/route.ts"),
  import("../src/app/api/provider/patient-result-submissions/[resultId]/actions/route.ts"),
  import("../src/app/api/patient/prescriptions/route.ts"),
  import("../src/app/api/patient/clinical-records/route.ts"),
  import("../src/app/api/patient/clinical-records/[recordId]/route.ts"),
  import("../src/app/api/cron/cleanup-diagnostic-result-uploads/route.ts"),
]);
const db = getFirebaseAdminDb();
const storage = getFirebaseAdminStorage();
const storageFilePrototype = Object.getPrototypeOf(storage.bucket().file("signature-test"));
const nativeGetSignedUrl = storageFilePrototype.getSignedUrl;
storageFilePrototype.getSignedUrl = async () => ["https://storage.googleapis.com/demo-nexaris.appspot.com/test-file?signature=emulator"];
const authBaseUrl = `http://${authHost}`;
let serial = 0;

async function clearFirestore() {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true, "Firestore emulator must be available and clearable.");
}

async function createUser(prefix) {
  serial += 1;
  const response = await fetch(`${authBaseUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(process.env.NEXT_PUBLIC_FIREBASE_API_KEY)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${prefix}.${Date.now()}.${serial}@example.test`, password: "NexaTestPassword-2026", returnSecureToken: true }),
  });
  const user = await response.json();
  assert.equal(response.ok, true, `Auth emulator account creation failed with HTTP ${response.status}.`);
  return { uid: user.localId, token: user.idToken };
}

function request(user, path, body) {
  return new Request(`http://localhost:3000${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Origin: "http://localhost:3000", Authorization: `Bearer ${user.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function responsePayload(response) { return { status: response.status, body: await response.json() }; }

async function fixture(prefix) {
  const patient = await createUser(`${prefix}-patient`);
  const doctor = await createUser(`${prefix}-doctor`);
  const anotherDoctor = await createUser(`${prefix}-other-doctor`);
  await Promise.all([
    db.collection("patientProfiles").doc(patient.uid).set({ role: "patient", profileComplete: true, patientNumber: "NMC-0000001", displayName: "Mila Pierre", firstName: "Mila", lastName: "Pierre", birthDate: "1990-01-01", sex: "Femme" }),
    db.collection("patientMedicalProfiles").doc(patient.uid).set({ languages: ["creole", "french"], allergies: { yes: true, details: "Pénicilline" }, diabetes: { diagnosed: false, sinceMonth: "" }, hypertension: { diagnosed: false, sinceMonth: "" }, tobacco: { yes: false, details: "" }, alcohol: { yes: false, details: "" }, coffee: { yes: false, details: "" }, tea: { yes: false, details: "" } }),
    db.collection("providerProfiles").doc(doctor.uid).set({ type: "doctor", status: "verified", clinicalCredentialsVerified: true, profile: { name: "Dr. Suivi", specialty: "Médecine générale" } }),
    db.collection("providerProfiles").doc(anotherDoctor.uid).set({ type: "doctor", status: "verified", clinicalCredentialsVerified: true, profile: { name: "Dr. Autre", specialty: "Médecine générale" } }),
  ]);
  const appointmentId = `patientResultEncounter${prefix}`;
  const prescriptionId = `patientResultPrescription${prefix}`;
  await Promise.all([
    db.collection("appointments").doc(appointmentId).set({ patientUid: patient.uid, providerUid: doctor.uid, providerType: "doctor", paymentStatus: "PAID", status: "COMPLETED", sessionStartedAt: Timestamp.fromMillis(Date.now() - 60 * 60_000) }),
    db.collection("clinicalPrescriptions").doc(prescriptionId).set({ patientUid: patient.uid, providerUid: doctor.uid, providerName: "Dr. Suivi", specialtyName: "Médecine générale", appointmentId, labExams: ["Numération formule sanguine"], imagingExams: ["Échographie abdominale"], status: "VALIDATED", validatedAt: FieldValue.serverTimestamp() }),
    db.collection("electronicPatientRecords").doc(`priorRecord${prefix}`).set({ recordType: "APPOINTMENT", patientUid: patient.uid, providerUid: anotherDoctor.uid, providerName: "Dr. Autre", specialtyName: "Médecine générale", recordNumber: "NEXA-2026-0000001", status: "FINALIZED", finalizedAt: Timestamp.fromMillis(Date.now() - 30 * 60_000), signature: { uid: anotherDoctor.uid, name: "Dr. Autre", specialty: "Médecine générale", signedAt: new Date(Date.now() - 30 * 60_000).toISOString() }, documentHash: "a".repeat(64), clinicalContent: { consultationReason: "Suivi antérieur vérifié", privatePath: "must-not-appear" } }),
  ]);
  const sessionRef = db.collection("patientResultUploadSessions").doc();
  const resultRef = db.collection("patientSubmittedResults").doc();
  const claimId = createHash("sha256").update(`${prescriptionId}:laboratory:0`).digest("hex");
  const fileId = randomBytes(12).toString("base64url");
  const storagePath = `nexa-patient-result-quarantine/${sessionRef.id}/${fileId}`;
  const fileBuffer = Buffer.from("%PDF-1.7\nLocal NEXA patient result\n%%EOF\n");
  const expiresAt = Timestamp.fromMillis(Date.now() + 15 * 60_000);
  await Promise.all([
    sessionRef.set({ patientUid: patient.uid, providerUid: doctor.uid, appointmentId, prescriptionId, examType: "laboratory", examIndex: 0, examName: "Numération formule sanguine", claimId, resultId: resultRef.id, files: [{ id: fileId, category: "LAB_RESULT", fileName: "laboratoire-1.pdf", contentType: "application/pdf", expectedSize: fileBuffer.length, storagePath }], status: "OPEN", expiresAt }),
    db.collection("patientResultClaims").doc(claimId).set({ patientUid: patient.uid, providerUid: doctor.uid, prescriptionId, examType: "laboratory", examIndex: 0, status: "OPEN", sessionId: sessionRef.id, resultId: resultRef.id, expiresAt }),
  ]);
  await storage.bucket().file(storagePath).save(fileBuffer, { metadata: { contentType: "application/pdf", metadata: { firebaseStorageDownloadTokens: "" } } });
  return { patient, doctor, anotherDoctor, appointmentId, prescriptionId, sessionId: sessionRef.id, claimId, resultId: resultRef.id, fileId, storagePath };
}

before(async () => {
  await new Promise((resolve, reject) => { scanner.once("error", reject); scanner.listen(0, "127.0.0.1", resolve); });
  const address = scanner.address();
  assert.ok(address && typeof address === "object");
  process.env.NEXA_MALWARE_SCANNER_URL = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => { scannerVerdict = "CLEAN"; await clearFirestore(); });
after(async () => {
  storageFilePrototype.getSignedUrl = nativeGetSignedUrl;
  scanner.closeAllConnections();
  if (scanner.listening) await new Promise((resolve, reject) => scanner.close((error) => error ? reject(error) : resolve()));
  const app = getApps().find((item) => item.name === "nexa-server");
  if (app) await deleteApp(app);
});

test("patient results are scanned, visible to their prescriber, and follow-up actions remain scoped", async () => {
  const data = await fixture("success");
  assert.equal((await getFirebaseAdminAuth().verifyIdToken(data.patient.token, true)).uid, data.patient.uid);
  const submitted = await responsePayload(await submitPatientResult(request(data.patient, "/api/patient/diagnostic-results/submit", { uploadSessionId: data.sessionId })));
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
  assert.equal(submitted.body.status, "AVAILABLE_TO_PRESCRIBER");

  const resultDoc = await db.collection("patientSubmittedResults").doc(data.resultId).get();
  assert.equal(resultDoc.get("status"), "AVAILABLE_TO_PRESCRIBER");
  assert.equal(resultDoc.get("files")[0].antivirusStatus, "CLEAN");
  assert.equal((await db.collection("patientResultFollowUpGrants").doc(data.resultId).get()).get("status"), "OPEN");
  assert.equal((await storage.bucket().file(data.storagePath).exists())[0], false);

  const doctorList = await responsePayload(await listProviderResults(request(data.doctor, "/api/provider/patient-result-submissions")));
  assert.equal(doctorList.status, 200, JSON.stringify(doctorList.body));
  assert.equal(doctorList.body.results[0].patient.patientNumber, "NMC-0000001");
  assert.equal(doctorList.body.results[0].patient.sex, "Femme");
  assert.equal(doctorList.body.results[0].patient.age, new Date().getUTCFullYear() - 1990);

  const detail = await responsePayload(await getProviderResult(request(data.doctor, `/api/provider/patient-result-submissions/${data.resultId}`), { params: Promise.resolve({ resultId: data.resultId }) }));
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.medicalProfile.allergies.details, "Pénicilline");
  assert.equal(detail.body.history.records[0].clinicalContent.consultationReason, "Suivi antérieur vérifié");
  assert.equal(JSON.stringify(detail.body).includes("privatePath"), false);
  assert.equal(JSON.stringify(detail.body).includes(data.patient.uid), false);
  const wrongDoctorDetail = await responsePayload(await getProviderResult(request(data.anotherDoctor, `/api/provider/patient-result-submissions/${data.resultId}`), { params: Promise.resolve({ resultId: data.resultId }) }));
  assert.equal(wrongDoctorDetail.status, 404);

  const providerFile = await responsePayload(await getProviderResultFile(request(data.doctor, "/file"), { params: Promise.resolve({ resultId: data.resultId, fileId: data.fileId }) }));
  assert.equal(providerFile.status, 200, JSON.stringify(providerFile.body));
  const note = await responsePayload(await submitFollowUpAction(request(data.doctor, "/action", { action: "note", note: "Le résultat a été revu par le médecin prescripteur." }), { params: Promise.resolve({ resultId: data.resultId }) }));
  assert.equal(note.status, 201, JSON.stringify(note.body));
  const patientRecords = await responsePayload(await listPatientClinicalRecords(request(data.patient, "/api/patient/clinical-records")));
  assert.equal(patientRecords.body.records.some((item) => item.recordId === note.body.recordId && item.recordType === "STANDALONE"), true);
  const clinicalNote = await responsePayload(await getPatientClinicalRecord(request(data.patient, "/record"), { params: Promise.resolve({ recordId: note.body.recordId }) }));
  assert.equal(clinicalNote.status, 200, JSON.stringify(clinicalNote.body));
  assert.equal(clinicalNote.body.record.clinicalContent.additionalNotes, "Le résultat a été revu par le médecin prescripteur.");
  assert.equal(clinicalNote.body.record.signature.name, "Dr. Suivi");
  const prescription = await responsePayload(await submitFollowUpAction(request(data.doctor, "/action", { action: "prescription", medication: { name: "Médicament de test", dosage: "10 mg", quantity: 1 } }), { params: Promise.resolve({ resultId: data.resultId }) }));
  assert.equal(prescription.status, 201, JSON.stringify(prescription.body));
  const patientPrescriptions = await responsePayload(await listPatientPrescriptions(request(data.patient, "/api/patient/prescriptions")));
  assert.equal(patientPrescriptions.body.prescriptions.some((item) => item.id === prescription.body.prescriptionId), true);

  const slotId = "a".repeat(32);
  const startsAt = Date.now() + 60 * 60_000;
  await db.collection("providerAvailabilitySlots").doc(slotId).set({ providerUid: data.doctor.uid, status: "available", startsAt: new Date(startsAt).toISOString(), endsAt: new Date(startsAt + 30 * 60_000).toISOString() });
  const proposal = await responsePayload(await submitFollowUpAction(request(data.doctor, "/action", { action: "appointment", slotId }), { params: Promise.resolve({ resultId: data.resultId }) }));
  assert.equal(proposal.status, 201, JSON.stringify(proposal.body));
  const patientList = await responsePayload(await listPatientResults(request(data.patient, "/api/patient/diagnostic-results")));
  const patientResult = patientList.body.results.find((item) => item.id === data.resultId);
  assert.equal(patientResult.followUpActions.some((item) => item.type === "NOTE"), true);
  assert.equal(patientResult.followUpActions.some((item) => item.type === "PRESCRIPTION"), true);
  assert.equal(patientResult.followUpActions.some((item) => item.type === "APPOINTMENT" && item.slotId === slotId), true);

  const closed = await responsePayload(await submitFollowUpAction(request(data.doctor, "/action", { action: "close" }), { params: Promise.resolve({ resultId: data.resultId }) }));
  assert.equal(closed.body.followUpStatus, "CLOSED");
  const providerAfterClose = await responsePayload(await listProviderResults(request(data.doctor, "/api/provider/patient-result-submissions")));
  assert.equal(providerAfterClose.body.results.some((item) => item.id === data.resultId), false);
  const deniedProviderFile = await responsePayload(await getProviderResultFile(request(data.doctor, "/file"), { params: Promise.resolve({ resultId: data.resultId, fileId: data.fileId }) }));
  assert.equal(deniedProviderFile.status, 404);
  const patientFile = await responsePayload(await getPatientResultFile(request(data.patient, "/file"), { params: Promise.resolve({ resultId: data.resultId, fileId: data.fileId }) }));
  assert.equal(patientFile.status, 200, JSON.stringify(patientFile.body));
});

test("infected patient files are rejected and cannot grant prescriber access", async () => {
  const data = await fixture("infected");
  scannerVerdict = "INFECTED";
  const submitted = await responsePayload(await submitPatientResult(request(data.patient, "/api/patient/diagnostic-results/submit", { uploadSessionId: data.sessionId })));
  assert.equal(submitted.status, 422);
  assert.equal(submitted.body.code, "malware-detected");
  assert.equal((await db.collection("patientSubmittedResults").doc(data.resultId).get()).exists, false);
  assert.equal((await db.collection("patientResultFollowUpGrants").doc(data.resultId).get()).exists, false);
  assert.equal((await db.collection("patientResultUploadSessions").doc(data.sessionId).get()).get("status"), "REJECTED");
  assert.equal((await storage.bucket().file(data.storagePath).exists())[0], false);
});

test("another patient cannot submit or read a patient's result session", async () => {
  const data = await fixture("ownership");
  const stranger = await createUser("result-stranger");
  const submit = await responsePayload(await submitPatientResult(request(stranger, "/api/patient/diagnostic-results/submit", { uploadSessionId: data.sessionId })));
  assert.equal(submit.status, 403);
  const read = await responsePayload(await getPatientResultFile(request(stranger, "/file"), { params: Promise.resolve({ resultId: data.resultId, fileId: data.fileId }) }));
  assert.equal(read.status, 404);
});

test("expired patient upload sessions clean quarantined files and restore an available claim", async () => {
  const data = await fixture("cleanup");
  await db.collection("patientResultUploadSessions").doc(data.sessionId).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1) });
  process.env.CRON_SECRET = "local-emulator-cron-secret";
  const request = new Request("http://localhost:3000/api/cron/cleanup-diagnostic-result-uploads", { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
  const cleanup = await responsePayload(await cleanupExpiredResultUploads(request));
  assert.equal(cleanup.status, 200, JSON.stringify(cleanup.body));
  assert.equal(cleanup.body.expiredSessions, 1);
  assert.equal(cleanup.body.deletedObjects, 1);
  assert.equal((await db.collection("patientResultUploadSessions").doc(data.sessionId).get()).get("status"), "EXPIRED");
  assert.equal((await db.collection("patientResultClaims").doc(data.claimId).get()).get("status"), "AVAILABLE");
  assert.equal((await storage.bucket().file(data.storagePath).exists())[0], false);
});
