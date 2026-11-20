import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { deleteApp, getApps } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";

process.env.NODE_ENV = "test";
process.env.FIREBASE_PROJECT_ID = "demo-nexaris";
process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||= "demo-api-key";
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = "demo-nexaris";
process.env.FIREBASE_STORAGE_BUCKET = "demo-nexaris.appspot.com";

const projectId = "demo-nexaris";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || "";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "";
const storageHost = process.env.STORAGE_EMULATOR_HOST || process.env.FIREBASE_STORAGE_EMULATOR_HOST || "127.0.0.1:9199";
const isLocal = (value) => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${value.replace(/^https?:\/\//, "")}`).hostname);
if (!authHost || !firestoreHost || !isLocal(authHost) || !isLocal(firestoreHost) || !isLocal(storageHost)) {
  throw new Error("Refusing clinical attachment tests without local Auth, Firestore, and Storage emulators.");
}
process.env.STORAGE_EMULATOR_HOST = storageHost.startsWith("http") ? storageHost : `http://${storageHost}`;

let scannerVerdict = "CLEAN";
let scannerRequests = 0;
const scanner = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/scan") {
    response.writeHead(404).end();
    return;
  }
  request.resume();
  request.on("end", () => {
    scannerRequests += 1;
    if (scannerVerdict === "UNAVAILABLE") {
      response.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "UNAVAILABLE" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: scannerVerdict, scannerVersion: "emulator-test-scanner" }));
  });
});

const [
  { getFirebaseAdminDb, getFirebaseAdminStorage },
  { GET: getClinicalAttachment, POST: updateClinicalAttachment },
] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/appointments/[appointmentId]/clinical-record/attachments/route.ts"),
]);
const db = getFirebaseAdminDb();
const storage = getFirebaseAdminStorage();
const authBaseUrl = `http://${authHost}`;
const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;

async function clearFirestoreEmulator() {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true, "Firestore emulator must be available and clearable.");
}

async function createAuthUser(email) {
  const response = await fetch(`${authBaseUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "NexaTestPassword-2026", returnSecureToken: true }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, `Auth emulator account creation failed with HTTP ${response.status}.`);
  return { uid: result.localId, token: result.idToken };
}

function makeRequest(user, appointmentId, body, method = "POST") {
  return new Request(`http://localhost:3000/api/appointments/${appointmentId}/clinical-record/attachments`, {
    method,
    headers: { Origin: "http://localhost:3000", Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function makeReadRequest(user, appointmentId, attachmentId) {
  return new Request(`http://localhost:3000/api/appointments/${appointmentId}/clinical-record/attachments?attachmentId=${encodeURIComponent(attachmentId)}`, {
    headers: { Origin: "http://localhost:3000", Authorization: `Bearer ${user.token}` },
  });
}

async function seedAttachment(label) {
  const doctor = await createAuthUser(`doctor.${label}@example.test`);
  const patient = await createAuthUser(`patient.${label}@example.test`);
  const appointmentId = `clinical-appt-${label}-001`;
  const uploadId = randomBytes(18).toString("base64url");
  const storagePath = `nexa-clinical-record-quarantine/${appointmentId}/${uploadId}`;
  const fileBuffer = Buffer.from("%PDF-1.7\nNEXA local clinical attachment\n%%EOF\n");
  const now = Timestamp.now();
  await Promise.all([
    db.collection("providerProfiles").doc(doctor.uid).set({ type: "doctor", status: "verified", clinicalCredentialsVerified: true, profile: { name: `Médecin ${label}` } }),
    db.collection("patientProfiles").doc(patient.uid).set({ role: "patient" }),
    db.collection("appointments").doc(appointmentId).set({ patientUid: patient.uid, providerUid: doctor.uid, providerType: "doctor", paymentStatus: "PAID", status: "IN_PROGRESS", effectiveConsultationStartedAt: now }),
    db.collection("electronicPatientRecords").doc(appointmentId).set({ appointmentId, patientUid: patient.uid, providerUid: doctor.uid, status: "DRAFT", version: 1, clinicalContent: { consultationReason: "" }, attachments: [], updatedBy: doctor.uid, updatedAt: now }),
    db.collection("clinicalRecordUploadSessions").doc(uploadId).set({ appointmentId, patientUid: patient.uid, providerUid: doctor.uid, originalFileName: `dossier-${label}.pdf`, contentType: "application/pdf", expectedSize: fileBuffer.length, storagePath, status: "OPEN", expiresAt: Timestamp.fromMillis(Date.now() + 10 * 60_000) }),
  ]);
  await storage.bucket().file(storagePath).save(fileBuffer, { metadata: { contentType: "application/pdf", metadata: { firebaseStorageDownloadTokens: "" } } });
  return { doctor, patient, appointmentId, uploadId, storagePath, fileBuffer };
}

async function readResponse(response) {
  return { status: response.status, body: await response.json() };
}

before(async () => {
  await clearFirestoreEmulator();
  await new Promise((resolve, reject) => {
    scanner.once("error", reject);
    scanner.listen(0, "127.0.0.1", resolve);
  });
  const address = scanner.address();
  assert.ok(address && typeof address === "object");
  process.env.NEXA_MALWARE_SCANNER_URL = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  scanner.closeAllConnections();
  if (scanner.listening) await new Promise((resolve, reject) => scanner.close((error) => error ? reject(error) : resolve()));
  const adminApp = getApps().find((app) => app.name === "nexa-server");
  if (adminApp) await deleteApp(adminApp);
});

test("keeps clinical attachments quarantined until scan and records only a clean private file", async () => {
  scannerVerdict = "CLEAN";
  const fixture = await seedAttachment("clean");
  const attachmentLookup = "not-yet-uploaded-attachment";
  const beforeFinalize = await readResponse(await getClinicalAttachment(makeReadRequest(fixture.patient, fixture.appointmentId, attachmentLookup), { params: Promise.resolve({ appointmentId: fixture.appointmentId }) }));
  assert.equal(beforeFinalize.status, 404);

  const finalized = await readResponse(await updateClinicalAttachment(makeRequest(fixture.doctor, fixture.appointmentId, { action: "finalize", uploadId: fixture.uploadId }), { params: Promise.resolve({ appointmentId: fixture.appointmentId }) }));
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
  assert.equal("storagePath" in finalized.body.attachment, false);

  const record = await db.collection("electronicPatientRecords").doc(fixture.appointmentId).get();
  assert.equal(record.get("status"), "DRAFT");
  assert.equal(record.get("attachments").length, 1);
  assert.match(record.get("attachments")[0].sha256Hash, /^[a-f0-9]{64}$/);
  assert.equal(record.get("attachments")[0].scannerVersion, "emulator-test-scanner");
  assert.equal(record.get("version"), 2);
  const finalPath = record.get("attachments")[0].storagePath;
  assert.equal(finalPath.startsWith(`nexa-clinical-records/${fixture.appointmentId}/`), true);
  assert.equal((await storage.bucket().file(fixture.storagePath).exists())[0], false);
  assert.equal((await storage.bucket().file(finalPath).exists())[0], true);

  const patientRead = await readResponse(await getClinicalAttachment(makeReadRequest(fixture.patient, fixture.appointmentId, record.get("attachments")[0].id), { params: Promise.resolve({ appointmentId: fixture.appointmentId }) }));
  assert.equal(patientRead.status, 404);
  assert.equal(scannerRequests, 1);
});

test("rejects infected clinical files and removes quarantined bytes on scan failure", async () => {
  scannerVerdict = "INFECTED";
  const infected = await seedAttachment("infected");
  const denied = await readResponse(await updateClinicalAttachment(makeRequest(infected.doctor, infected.appointmentId, { action: "finalize", uploadId: infected.uploadId }), { params: Promise.resolve({ appointmentId: infected.appointmentId }) }));
  assert.equal(denied.status, 422);
  assert.equal(denied.body.code, "malware-detected");
  assert.equal((await db.collection("electronicPatientRecords").doc(infected.appointmentId).get()).get("attachments").length, 0);
  assert.equal((await db.collection("clinicalRecordUploadSessions").doc(infected.uploadId).get()).get("status"), "REJECTED");
  assert.equal((await storage.bucket().file(infected.storagePath).exists())[0], false);

  scannerVerdict = "UNAVAILABLE";
  const unavailable = await seedAttachment("unavailable");
  const failed = await readResponse(await updateClinicalAttachment(makeRequest(unavailable.doctor, unavailable.appointmentId, { action: "finalize", uploadId: unavailable.uploadId }), { params: Promise.resolve({ appointmentId: unavailable.appointmentId }) }));
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, "malware-scanner-unavailable");
  assert.equal((await db.collection("electronicPatientRecords").doc(unavailable.appointmentId).get()).get("attachments").length, 0);
  assert.equal((await db.collection("clinicalRecordUploadSessions").doc(unavailable.uploadId).get()).get("status"), "FAILED");
  assert.equal((await storage.bucket().file(unavailable.storagePath).exists())[0], false);
  assert.equal(scannerRequests, 3);
});
