import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
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
const isLocal = (value) => value && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${value.replace(/^https?:\/\//, "")}`).hostname);
if (!isLocal(authHost) || !isLocal(firestoreHost) || !isLocal(storageHost)) {
  throw new Error("Refusing partner contract tests without local Auth, Firestore, and Storage emulators.");
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
  { GET: getContracts, POST: postContracts },
  { GET: cleanupUploads },
] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/admin/diagnostic-partner-contracts/route.ts"),
  import("../src/app/api/cron/cleanup-diagnostic-partner-contract-uploads/route.ts"),
]);
const db = getFirebaseAdminDb();
const storage = getFirebaseAdminStorage();
const authBaseUrl = new URL(authHost.includes("://") ? authHost : `http://${authHost}`).origin;
const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
let userSequence = 0;

async function clearFirestoreEmulator() {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true, "Firestore emulator must be available and clearable.");
}

async function createAuthUser(prefix) {
  userSequence += 1;
  const email = `${prefix}.${Date.now()}.${userSequence}@example.test`;
  const response = await fetch(`${authBaseUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "NexaTestPassword-2026", returnSecureToken: true }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, `Auth emulator account creation failed with HTTP ${response.status}.`);
  return { uid: result.localId, token: result.idToken };
}

function makeRequest(user, { method = "GET", query = "", body } = {}) {
  return new Request(`http://localhost:3000/api/admin/diagnostic-partner-contracts${query}`, {
    method,
    headers: {
      Origin: "http://localhost:3000",
      ...(user ? { Authorization: `Bearer ${user.token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function readResponse(response) {
  return { status: response.status, body: await response.json() };
}

async function seedProvider(type = "laboratory") {
  const user = await createAuthUser(`contract-${type}`);
  await db.collection("providerProfiles").doc(user.uid).set({
    type,
    status: "verified",
    profile: { name: `Partenaire ${type} synthétique` },
  });
  return user.uid;
}

async function seedUpload({ admin, providerUid, label, contentType = "application/pdf", metadata = {}, expiresAt = Date.now() + 15 * 60_000, status = "OPEN", final = false }) {
  const sessionId = randomBytes(18).toString("base64url");
  const documentId = final ? randomBytes(18).toString("base64url") : "";
  const quarantinePath = `nexa-diagnostic-partner-contract-quarantine/${providerUid}/${sessionId}`;
  const finalPath = documentId ? `nexa-diagnostic-partner-contracts/${providerUid}/${documentId}` : "";
  const fileBuffer = Buffer.from("%PDF-1.7\nNEXA synthetic contract fixture\n%%EOF\n");
  await db.collection("diagnosticPartnerContractUploadSessions").doc(sessionId).set({
    providerUid,
    createdByUid: admin.uid,
    fileName: `${label}.pdf`,
    contentType,
    expectedSize: fileBuffer.length,
    storagePath: quarantinePath,
    status,
    createdAt: Timestamp.now(),
    expiresAt: Timestamp.fromMillis(expiresAt),
    cleanupAfterAt: Timestamp.fromMillis(Date.now() - 1_000),
    ...(status === "SCANNING" ? { scanningStartedAt: Timestamp.fromMillis(Date.now() - 20 * 60_000) } : {}),
    ...(finalPath ? { finalStoragePath: finalPath, finalDocumentId: documentId } : {}),
  });
  const customMetadata = {
    "nexa-admin-uid": admin.uid,
    "nexa-provider-uid": providerUid,
    "nexa-upload-session-id": sessionId,
    firebaseStorageDownloadTokens: "",
    ...metadata,
  };
  await storage.bucket().file(quarantinePath).save(fileBuffer, {
    metadata: { contentType, metadata: customMetadata },
  });
  if (finalPath) await storage.bucket().file(finalPath).save(fileBuffer, { metadata: { contentType, metadata: { nexaAntivirusStatus: "CLEAN" } } });
  return { sessionId, quarantinePath, finalPath, documentId, fileBuffer };
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

beforeEach(async () => {
  process.env.NEXA_ADMIN_UIDS = "";
  process.env.CRON_SECRET = "local-contract-cleanup-secret";
  scannerVerdict = "CLEAN";
  scannerRequests = 0;
  await clearFirestoreEmulator();
});

after(async () => {
  scanner.closeAllConnections();
  if (scanner.listening) await new Promise((resolve, reject) => scanner.close((error) => error ? reject(error) : resolve()));
  const adminApp = getApps().find((app) => app.name === "nexa-server");
  if (adminApp) await deleteApp(adminApp);
});

test("contract APIs require an administrator and reject non-diagnostic providers and invalid uploads", async () => {
  const administrator = await createAuthUser("contract-admin");
  const regularUser = await createAuthUser("contract-user");
  process.env.NEXA_ADMIN_UIDS = administrator.uid;
  const pharmacyUid = await seedProvider("pharmacy");

  const anonymous = await readResponse(await getContracts(makeRequest(null, { query: `?providerUid=${pharmacyUid}` })));
  const denied = await readResponse(await getContracts(makeRequest(regularUser, { query: `?providerUid=${pharmacyUid}` })));
  const invalidUid = await readResponse(await getContracts(makeRequest(administrator, { query: "?providerUid=bad%2Fuid" })));
  const wrongType = await readResponse(await getContracts(makeRequest(administrator, { query: `?providerUid=${pharmacyUid}` })));
  const invalidType = await readResponse(await postContracts(makeRequest(administrator, { method: "POST", body: { action: "start", providerUid: pharmacyUid, fileName: "contrat.exe", contentType: "application/octet-stream", size: 12 } })));
  const invalidSize = await readResponse(await postContracts(makeRequest(administrator, { method: "POST", body: { action: "start", providerUid: pharmacyUid, fileName: "contrat.pdf", contentType: "application/pdf", size: 10 * 1024 * 1024 + 1 } })));

  assert.equal(anonymous.status, 401);
  assert.equal(denied.status, 403);
  assert.equal(invalidUid.status, 400);
  assert.equal(wrongType.status, 404);
  assert.equal(invalidType.status, 400);
  assert.equal(invalidSize.status, 400);
  assert.equal((await db.collection("adminAuditLogs").get()).size, 0);
});

test("clean uploads are scanned, moved to private storage, listed without storage internals, and finalized idempotently", async () => {
  const administrator = await createAuthUser("contract-clean-admin");
  process.env.NEXA_ADMIN_UIDS = administrator.uid;
  const providerUid = await seedProvider("laboratory");
  const fixture = await seedUpload({ admin: administrator, providerUid, label: "contrat-propre" });

  const finalized = await readResponse(await postContracts(makeRequest(administrator, { method: "POST", body: { action: "finalize", uploadId: fixture.sessionId } })));
  assert.equal(finalized.status, 201, JSON.stringify(finalized.body));
  assert.equal(finalized.body.document.antivirusStatus, "CLEAN");
  assert.equal(scannerRequests, 1);

  const session = await db.collection("diagnosticPartnerContractUploadSessions").doc(fixture.sessionId).get();
  const documentRef = db.collection("providerProfiles").doc(providerUid).collection("contractDocuments").doc(finalized.body.document.id);
  const document = await documentRef.get();
  assert.equal(session.get("status"), "SUBMITTED");
  assert.equal(document.get("storagePath"), `nexa-diagnostic-partner-contracts/${providerUid}/${finalized.body.document.id}`);
  assert.equal(document.get("antivirusStatus"), "CLEAN");
  assert.equal(document.get("scannerVersion"), "emulator-test-scanner");
  assert.equal(document.get("sha256Hash"), createHash("sha256").update(fixture.fileBuffer).digest("hex"));
  assert.equal((await storage.bucket().file(fixture.quarantinePath).exists())[0], false);
  assert.equal((await storage.bucket().file(document.get("storagePath")).exists())[0], true);
  assert.equal((await db.collection("providerProfiles").doc(providerUid).get()).get("contractDocumentCount"), 1);

  const list = await readResponse(await getContracts(makeRequest(administrator, { query: `?providerUid=${providerUid}` })));
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.documents.length, 1);
  assert.equal(list.body.documents[0].id, document.id);
  assert.equal(list.body.remainingSlots, 19);
  for (const privateValue of ["storagePath", "sha256Hash", "patientUid", "patientNumber", fixture.quarantinePath]) {
    assert.equal(JSON.stringify(list.body).includes(privateValue), false, `Contract listing must omit ${privateValue}.`);
  }

  const retry = await readResponse(await postContracts(makeRequest(administrator, { method: "POST", body: { action: "finalize", uploadId: fixture.sessionId } })));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.document.id, document.id);
  assert.equal(scannerRequests, 1, "An idempotent retry must not scan or store the document twice.");
  const audit = await db.collection("adminAuditLogs").where("actorUid", "==", administrator.uid).get();
  assert.equal(audit.docs.filter((entry) => entry.get("action") === "diagnostic_partner_contract_document_added").length, 1);
});

test("invalid metadata, infected files, and scanner outages fail closed and remove quarantined objects", async () => {
  const administrator = await createAuthUser("contract-failure-admin");
  process.env.NEXA_ADMIN_UIDS = administrator.uid;
  const providerUid = await seedProvider("imaging");

  const wrongOwner = await seedUpload({ admin: administrator, providerUid, label: "mauvais-proprietaire", metadata: { "nexa-admin-uid": "another-admin-uid" } });
  const wrongOwnerResult = await readResponse(await postContracts(makeRequest(administrator, { method: "POST", body: { action: "finalize", uploadId: wrongOwner.sessionId } })));
  assert.equal(wrongOwnerResult.status, 400);
  assert.equal((await db.collection("diagnosticPartnerContractUploadSessions").doc(wrongOwner.sessionId).get()).get("status"), "FAILED");
  assert.equal((await storage.bucket().file(wrongOwner.quarantinePath).exists())[0], false);

  scannerVerdict = "INFECTED";
  const infected = await seedUpload({ admin: administrator, providerUid, label: "infecte" });
  const infectedResult = await readResponse(await postContracts(makeRequest(administrator, { method: "POST", body: { action: "finalize", uploadId: infected.sessionId } })));
  assert.equal(infectedResult.status, 422);
  assert.equal(infectedResult.body.code, "malware-detected");
  assert.equal((await db.collection("diagnosticPartnerContractUploadSessions").doc(infected.sessionId).get()).get("status"), "REJECTED");
  assert.equal((await storage.bucket().file(infected.quarantinePath).exists())[0], false);

  scannerVerdict = "UNAVAILABLE";
  const unavailable = await seedUpload({ admin: administrator, providerUid, label: "scanner-indisponible" });
  const unavailableResult = await readResponse(await postContracts(makeRequest(administrator, { method: "POST", body: { action: "finalize", uploadId: unavailable.sessionId } })));
  assert.equal(unavailableResult.status, 503);
  assert.equal((await db.collection("diagnosticPartnerContractUploadSessions").doc(unavailable.sessionId).get()).get("status"), "FAILED");
  assert.equal((await storage.bucket().file(unavailable.quarantinePath).exists())[0], false);
  assert.equal((await db.collection("providerProfiles").doc(providerUid).collection("contractDocuments").get()).size, 0);
});

test("upload limit counts stored documents and does not trust the cached profile count", async () => {
  const administrator = await createAuthUser("contract-limit-admin");
  process.env.NEXA_ADMIN_UIDS = administrator.uid;
  const providerUid = await seedProvider("laboratory");
  const documents = db.collection("providerProfiles").doc(providerUid).collection("contractDocuments");
  assert.match(providerUid, /^[A-Za-z0-9_-]{10,128}$/);
  await Promise.all(Array.from({ length: 20 }, (_, index) => documents.doc(`contract_seed_${String(index).padStart(4, "0")}`).set({
    name: `Document ${index}`,
    contentType: "application/pdf",
    size: 100,
    uploadedAt: Timestamp.now(),
    contractDocumentCount: 0,
  })));

  const blocked = await readResponse(await postContracts(makeRequest(administrator, { method: "POST", body: { action: "start", providerUid, fileName: "contrat.pdf", contentType: "application/pdf", size: 100 } })));
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.equal(blocked.body.code, "contract-document-limit");
  assert.equal((await db.collection("diagnosticPartnerContractUploadSessions").get()).size, 0);
});

test("scheduled cleanup removes expired quarantine objects and abandoned final objects after a move interruption", async () => {
  const administrator = await createAuthUser("contract-cleanup-admin");
  const providerUid = await seedProvider("imaging");
  const expired = await seedUpload({ admin: administrator, providerUid, label: "expire", expiresAt: Date.now() - 60_000 });
  const interrupted = await seedUpload({ admin: administrator, providerUid, label: "interrupted", expiresAt: Date.now() - 60_000, status: "SCANNING", final: true });

  const unauthorized = await readResponse(await cleanupUploads(new Request("http://localhost:3000/api/cron/cleanup-diagnostic-partner-contract-uploads", { headers: { Authorization: "Bearer wrong" } })));
  assert.equal(unauthorized.status, 401);
  const unauthorizedWithoutSecret = await cleanupUploads(new Request("http://localhost:3000/api/cron/cleanup-diagnostic-partner-contract-uploads"));
  assert.equal(unauthorizedWithoutSecret.status, 401);
  const cleaned = await readResponse(await cleanupUploads(new Request("http://localhost:3000/api/cron/cleanup-diagnostic-partner-contract-uploads", { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } })));
  assert.equal(cleaned.status, 200, JSON.stringify(cleaned.body));
  assert.equal(cleaned.body.cleanedSessions, 2);
  assert.equal((await storage.bucket().file(expired.quarantinePath).exists())[0], false);
  assert.equal((await storage.bucket().file(interrupted.quarantinePath).exists())[0], false);
  assert.equal((await storage.bucket().file(interrupted.finalPath).exists())[0], false);
  assert.equal((await db.collection("diagnosticPartnerContractUploadSessions").doc(expired.sessionId).get()).get("status"), "EXPIRED");
  assert.equal((await db.collection("diagnosticPartnerContractUploadSessions").doc(interrupted.sessionId).get()).get("status"), "EXPIRED");
});
