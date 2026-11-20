import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
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
const localHost = (value) => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${value.replace(/^https?:\/\//, "")}`).hostname);
if (!authHost || !firestoreHost || !localHost(authHost) || !localHost(firestoreHost) || !localHost(storageHost)) {
  throw new Error("Refusing diagnostic result storage tests without local Auth, Firestore, and Storage emulators.");
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
  { POST: submitDiagnosticResult },
] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/provider/diagnostic-results/submit/route.ts"),
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

function makeRequest(user, uploadSessionId) {
  return new Request("http://localhost:3000/api/provider/diagnostic-results/submit", {
    method: "POST",
    headers: { Origin: "http://localhost:3000", Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ uploadSessionId }),
  });
}

async function seedUpload(label) {
  const user = await createAuthUser(`lab.${label}@example.test`);
  const orderId = `diagnostic-order-${label}-001`;
  const examLineId = `exam-line-${label}-001`;
  const orderRef = db.collection("nexaOrders").doc(orderId);
  const providerRef = db.collection("providerProfiles").doc(user.uid);
  const claimId = createHash("sha256").update(`${orderId}:${examLineId}`).digest("hex");
  const sessionRef = db.collection("diagnosticResultUploadSessions").doc();
  const resultRef = db.collection("diagnosticResults").doc();
  const fileId = randomBytes(12).toString("base64url");
  const storagePath = `nexa-result-quarantine/${sessionRef.id}/${fileId}`;
  const fileBuffer = Buffer.from("%PDF-1.7\nNEXA local emulator file\n%%EOF\n");
  const expiresAt = Timestamp.fromMillis(Date.now() + 15 * 60_000);
  await Promise.all([
    providerRef.set({ type: "laboratory", status: "verified", publiclyListed: true, profile: { name: `Laboratoire ${label}` } }),
    orderRef.set({
      providerUid: user.uid,
      patientUid: `patient-${label}`,
      patientNumber: "NMC-0000001",
      orderNumber: `NMC-LAB-${label}`,
      providerName: `Laboratoire ${label}`,
      kind: "laboratory",
      paymentStatus: "PAID",
      settlementStatus: "CONFIRMED",
      status: "EXAM_COMPLETED",
      items: [{ offerId: examLineId, name: "Analyse de test", resultStatus: "NONE" }],
    }),
    sessionRef.set({
      providerUid: user.uid,
      providerType: "laboratory",
      orderId,
      examLineId,
      patientUid: `patient-${label}`,
      claimId,
      resultId: resultRef.id,
      version: 1,
      files: [{ id: fileId, category: "LAB_RESULT", fileName: `lab-result-${label}.pdf`, contentType: "application/pdf", expectedSize: fileBuffer.length, storagePath }],
      status: "OPEN",
      expiresAt,
    }),
    db.collection("diagnosticResultClaims").doc(claimId).set({
      orderId,
      examLineId,
      providerUid: user.uid,
      providerType: "laboratory",
      sessionId: sessionRef.id,
      resultId: resultRef.id,
      status: "OPEN",
      expiresAt,
      updatedAt: Timestamp.now(),
    }),
  ]);
  await storage.bucket().file(storagePath).save(fileBuffer, {
    metadata: { contentType: "application/pdf", metadata: { firebaseStorageDownloadTokens: "" } },
  });
  return { user, orderId, claimId, sessionId: sessionRef.id, resultId: resultRef.id, storagePath, fileBuffer };
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

test("scans a quarantined diagnostic result before moving it to private storage", async () => {
  scannerVerdict = "CLEAN";
  const fixture = await seedUpload("clean");
  const response = await readResponse(await submitDiagnosticResult(makeRequest(fixture.user, fixture.sessionId)));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.status, "RESULT_PENDING_REVIEW");

  const result = await db.collection("diagnosticResults").doc(fixture.resultId).get();
  assert.equal(result.get("status"), "RESULT_PENDING_REVIEW");
  assert.equal(result.get("files")[0].antivirusStatus, "CLEAN");
  assert.equal(result.get("files")[0].antivirusScannerVersion, "emulator-test-scanner");
  assert.equal(result.get("files")[0].storagePath, `nexa-diagnostic-results/${fixture.orderId}/${fixture.resultId}/${result.get("files")[0].id}`);
  const [quarantineExists] = await storage.bucket().file(fixture.storagePath).exists();
  const [finalExists] = await storage.bucket().file(result.get("files")[0].storagePath).exists();
  assert.equal(quarantineExists, false);
  assert.equal(finalExists, true);
  assert.equal(scannerRequests, 1);
});

test("blocks infected files and scanner outages without creating patient-visible results", async () => {
  scannerVerdict = "INFECTED";
  const infected = await seedUpload("infected");
  const infectedResponse = await readResponse(await submitDiagnosticResult(makeRequest(infected.user, infected.sessionId)));
  assert.equal(infectedResponse.status, 422);
  assert.equal(infectedResponse.body.code, "malware-detected");
  assert.equal((await db.collection("diagnosticResults").doc(infected.resultId).get()).exists, false);
  assert.equal((await db.collection("diagnosticResultUploadSessions").doc(infected.sessionId).get()).get("status"), "REJECTED");
  assert.equal((await storage.bucket().file(infected.storagePath).exists())[0], false);

  scannerVerdict = "UNAVAILABLE";
  const unavailable = await seedUpload("unavailable");
  const unavailableResponse = await readResponse(await submitDiagnosticResult(makeRequest(unavailable.user, unavailable.sessionId)));
  assert.equal(unavailableResponse.status, 503);
  assert.equal(unavailableResponse.body.code, "malware-scanner-unavailable");
  assert.equal((await db.collection("diagnosticResults").doc(unavailable.resultId).get()).exists, false);
  assert.equal((await db.collection("diagnosticResultUploadSessions").doc(unavailable.sessionId).get()).get("status"), "SCAN_FAILED");
  assert.equal((await storage.bucket().file(unavailable.storagePath).exists())[0], false);
  assert.equal(scannerRequests, 3);
});
