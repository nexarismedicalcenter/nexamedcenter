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
  throw new Error("Refusing session media tests without local Auth, Firestore, and Storage emulators.");
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
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: scannerVerdict, scannerVersion: "emulator-test-scanner", durationSeconds: 8 }));
  });
});

const [
  { getFirebaseAdminDb, getFirebaseAdminStorage },
  { POST: submitSessionMedia },
  { GET: getSessionMedia },
] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/appointments/[appointmentId]/messages/media/[uploadId]/route.ts"),
  import("../src/app/api/appointments/[appointmentId]/messages/[messageId]/media/route.ts"),
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

function makeRequest(user, appointmentId, uploadId) {
  return new Request(`http://localhost:3000/api/appointments/${appointmentId}/messages/media/${uploadId}`, {
    method: "POST",
    headers: { Origin: "http://localhost:3000", Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" },
    body: "{}",
  });
}

function makeReadRequest(user, appointmentId, messageId) {
  return new Request(`http://localhost:3000/api/appointments/${appointmentId}/messages/${messageId}/media`, {
    headers: { Origin: "http://localhost:3000", Authorization: `Bearer ${user.token}` },
  });
}

async function seedSessionMedia(label, { kind = "photo", verdict = "CLEAN", expired = false } = {}) {
  scannerVerdict = verdict;
  const patient = await createAuthUser(`patient.${label}@example.test`);
  const doctor = await createAuthUser(`doctor.${label}@example.test`);
  const outsider = await createAuthUser(`outsider.${label}@example.test`);
  const appointmentId = `session-media-${label}-001`;
  const uploadId = randomBytes(18).toString("base64url");
  const contentType = kind === "photo" ? "image/jpeg" : "audio/ogg";
  const fileBuffer = kind === "photo"
    ? Buffer.from([0xff, 0xd8, 0xff, 0xd9])
    : Buffer.from("OggS\u0000local-emulator-audio");
  const storagePath = `nexa-session-media-quarantine/${appointmentId}/${uploadId}`;
  const expiresAt = Timestamp.fromMillis(Date.now() + (expired ? -1000 : 10 * 60_000));
  await Promise.all([
    db.collection("providerProfiles").doc(doctor.uid).set({ type: "doctor", status: "verified", clinicalCredentialsVerified: true }),
    db.collection("appointments").doc(appointmentId).set({
      patientUid: patient.uid,
      providerUid: doctor.uid,
      providerType: "doctor",
      paymentStatus: "PAID",
      status: "IN_PROGRESS",
      sessionStatus: "ACTIVE",
      interactiveEndsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      consultationRights: { maxPhotos: 3, maxVoiceMessages: 2, maxVoiceSeconds: 60 },
    }),
    db.collection("sessionMessageMediaUploads").doc(uploadId).set({
      appointmentId,
      patientUid: patient.uid,
      providerUid: doctor.uid,
      ownerUid: patient.uid,
      kind,
      contentType,
      expectedSize: fileBuffer.length,
      durationSeconds: kind === "voice" ? 8 : null,
      fileName: kind === "photo" ? `photo-${label}.jpg` : `audio-${label}.ogg`,
      storagePath,
      status: "OPEN",
      createdAt: Timestamp.now(),
      expiresAt,
    }),
  ]);
  await storage.bucket().file(storagePath).save(fileBuffer, {
    metadata: {
      contentType,
      metadata: {
        firebaseStorageDownloadTokens: "",
        ...(kind === "voice" ? { durationSeconds: "8" } : {}),
      },
    },
  });
  return { patient, doctor, outsider, appointmentId, uploadId, storagePath, contentType, fileBuffer };
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

test("scans a session photo before exposing a private message to its participant", async () => {
  const fixture = await seedSessionMedia("clean-photo");

  const response = await readResponse(await submitSessionMedia(makeRequest(fixture.patient, fixture.appointmentId, fixture.uploadId), {
    params: Promise.resolve({ appointmentId: fixture.appointmentId, uploadId: fixture.uploadId }),
  }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.status, "CLEAN");

  const message = await db.collection("sessionMessages").doc(response.body.messageId).get();
  assert.equal(message.exists, true);
  assert.equal(message.get("antivirusStatus"), "CLEAN");
  assert.equal(message.get("antivirusScannerVersion"), "emulator-test-scanner");
  assert.equal(message.get("storagePath"), `nexa-session-media/${fixture.appointmentId}/${response.body.messageId}`);
  assert.equal((await db.collection("sessionMessageMediaUploads").doc(fixture.uploadId).get()).get("status"), "SUBMITTED");
  assert.equal((await storage.bucket().file(fixture.storagePath).exists())[0], false);
  const finalFile = storage.bucket().file(message.get("storagePath"));
  assert.equal((await finalFile.exists())[0], true);
  const [metadata] = await finalFile.getMetadata();
  assert.equal(metadata.metadata.nexaAntivirusStatus, "CLEAN");
  assert.equal(metadata.metadata.firebaseStorageDownloadTokens, "");

  const outsiderRead = await readResponse(await getSessionMedia(makeReadRequest(fixture.outsider, fixture.appointmentId, response.body.messageId), {
    params: Promise.resolve({ appointmentId: fixture.appointmentId, messageId: response.body.messageId }),
  }));
  assert.equal(outsiderRead.status, 403);
  assert.equal(scannerRequests, 1);
});

test("rejects infected files, scanner outages, expired uploads, and non-participants", async () => {
  scannerVerdict = "INFECTED";
  const infected = await seedSessionMedia("infected-photo", { verdict: "INFECTED" });
  const infectedResponse = await readResponse(await submitSessionMedia(makeRequest(infected.patient, infected.appointmentId, infected.uploadId), {
    params: Promise.resolve({ appointmentId: infected.appointmentId, uploadId: infected.uploadId }),
  }));
  assert.equal(infectedResponse.status, 422);
  assert.equal(infectedResponse.body.code, "malware-detected");
  assert.equal((await db.collection("sessionMessages").where("appointmentId", "==", infected.appointmentId).get()).empty, true);
  assert.equal((await db.collection("sessionMessageMediaUploads").doc(infected.uploadId).get()).get("status"), "REJECTED");
  assert.equal((await storage.bucket().file(infected.storagePath).exists())[0], false);

  scannerVerdict = "UNAVAILABLE";
  const unavailable = await seedSessionMedia("scanner-down", { verdict: "UNAVAILABLE" });
  const failedResponse = await readResponse(await submitSessionMedia(makeRequest(unavailable.patient, unavailable.appointmentId, unavailable.uploadId), {
    params: Promise.resolve({ appointmentId: unavailable.appointmentId, uploadId: unavailable.uploadId }),
  }));
  assert.equal(failedResponse.status, 503);
  assert.equal(failedResponse.body.code, "malware-scanner-unavailable");
  assert.equal((await db.collection("sessionMessages").where("appointmentId", "==", unavailable.appointmentId).get()).empty, true);
  assert.equal((await db.collection("sessionMessageMediaUploads").doc(unavailable.uploadId).get()).get("status"), "REJECTED");
  assert.equal((await storage.bucket().file(unavailable.storagePath).exists())[0], false);

  scannerVerdict = "CLEAN";
  const expired = await seedSessionMedia("expired", { expired: true });
  const expiredResponse = await readResponse(await submitSessionMedia(makeRequest(expired.patient, expired.appointmentId, expired.uploadId), {
    params: Promise.resolve({ appointmentId: expired.appointmentId, uploadId: expired.uploadId }),
  }));
  assert.equal(expiredResponse.status, 410);
  assert.equal((await storage.bucket().file(expired.storagePath).exists())[0], true);
  assert.equal((await db.collection("sessionMessageMediaUploads").doc(expired.uploadId).get()).get("status"), "OPEN");

  const outsiderResponse = await readResponse(await submitSessionMedia(makeRequest(expired.outsider, expired.appointmentId, expired.uploadId), {
    params: Promise.resolve({ appointmentId: expired.appointmentId, uploadId: expired.uploadId }),
  }));
  assert.equal(outsiderResponse.status, 404);
  assert.equal(scannerRequests, 3);
});

test("scans voice media and keeps a closed session upload in quarantine", async () => {
  const voice = await seedSessionMedia("voice", { kind: "voice" });
  const voiceResponse = await readResponse(await submitSessionMedia(makeRequest(voice.patient, voice.appointmentId, voice.uploadId), {
    params: Promise.resolve({ appointmentId: voice.appointmentId, uploadId: voice.uploadId }),
  }));
  assert.equal(voiceResponse.status, 200, JSON.stringify(voiceResponse.body));
  const voiceMessage = await db.collection("sessionMessages").doc(voiceResponse.body.messageId).get();
  assert.equal(voiceMessage.get("kind"), "voice");
  assert.equal(voiceMessage.get("durationSeconds"), 8);
  assert.equal(voiceMessage.get("antivirusStatus"), "CLEAN");
  assert.equal((await storage.bucket().file(voice.storagePath).exists())[0], false);
  assert.equal((await storage.bucket().file(voiceMessage.get("storagePath")).exists())[0], true);

  const closed = await seedSessionMedia("closed");
  await db.collection("appointments").doc(closed.appointmentId).update({ status: "COMPLETED" });
  const closedResponse = await readResponse(await submitSessionMedia(makeRequest(closed.patient, closed.appointmentId, closed.uploadId), {
    params: Promise.resolve({ appointmentId: closed.appointmentId, uploadId: closed.uploadId }),
  }));
  assert.equal(closedResponse.status, 409);
  assert.equal(closedResponse.body.code, "session-not-interactive");
  assert.equal((await storage.bucket().file(closed.storagePath).exists())[0], true);
  assert.equal(scannerRequests, 4);
});
