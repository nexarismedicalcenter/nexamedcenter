import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { deleteApp, getApps } from "firebase-admin/app";

process.env.NODE_ENV = "test";
process.env.FIREBASE_PROJECT_ID = "demo-nexaris";
process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||= "demo-api-key";
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = "demo-nexaris";

const projectId = "demo-nexaris";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || "";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "";
const isLocal = (value) => value && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${value.replace(/^https?:\/\//, "")}`).hostname);
if (!isLocal(authHost) || !isLocal(firestoreHost)) {
  throw new Error("Refusing provider activity-history tests without local Auth and Firestore emulators.");
}

const [{ getFirebaseAdminDb }, { GET }] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/provider/activity-history/route.ts"),
]);
const db = getFirebaseAdminDb();
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

function makeRequest(user, query = "") {
  return new Request(`http://localhost:3000/api/provider/activity-history${query}`, {
    headers: { Origin: "http://localhost:3000", ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
  });
}

async function readResponse(response) {
  return { status: response.status, body: await response.json() };
}

async function createDiagnosticProvider(user, { type = "laboratory", verified = true } = {}) {
  await db.collection("providerProfiles").doc(user.uid).set({
    type,
    status: verified ? "verified" : "pending",
    publiclyListed: verified,
  });
}

beforeEach(clearFirestoreEmulator);

after(async () => {
  const adminApp = getApps().find((app) => app.name === "nexa-server");
  if (adminApp) await deleteApp(adminApp);
});

test("verified diagnostic partners receive a merged private activity history without patient context", async () => {
  const provider = await createAuthUser("partner-activity-owner");
  const otherProvider = await createAuthUser("partner-activity-other");
  await createDiagnosticProvider(provider, { type: "imaging" });
  await createDiagnosticProvider(otherProvider);
  const base = Date.UTC(2026, 10, 8);

  await Promise.all([
    ...Array.from({ length: 45 }, (_, index) => db.collection("adminAuditLogs").doc(`activity-${String(index).padStart(3, "0")}`).set({
      actorUid: provider.uid,
      action: index % 2 ? "imaging_order_advance" : "diagnostic_offer_updated",
      resource: index % 2 ? `nexaOrders/order-${index}` : `diagnosticOffers/offer-${index}`,
      context: { patientUid: `PRIVATE_PATIENT_UID_${index}`, medicalNote: "PRIVATE_MEDICAL_NOTE" },
      createdAt: new Date(base + index * 1000),
    })),
    ...Array.from({ length: 47 }, (_, index) => db.collection("diagnosticResultAuditLogs").doc(`result-${String(index).padStart(3, "0")}`).set({
      actorUid: provider.uid,
      providerType: "imaging",
      action: index % 2 ? "diagnostic_result_correction_submitted" : "diagnostic_result_submitted",
      orderId: `order-${index}`,
      patientUid: `PRIVATE_RESULT_PATIENT_${index}`,
      createdAt: new Date(base + index * 1000),
    })),
    ...Array.from({ length: 3 }, (_, index) => db.collection("clinicalAuditLogs").doc(`clinical-${index}`).set({
      actorUid: provider.uid,
      providerType: "imaging",
      action: "diagnostic_prescription_viewed",
      resource: `clinicalPrescriptions/prescription-${index}`,
      orderId: `order-${index}`,
      patientUid: `PRIVATE_CLINICAL_PATIENT_${index}`,
      clinicalContext: "PRIVATE_PRESCRIPTION_CONTEXT",
      createdAt: new Date(base + index * 1000),
    })),
    db.collection("adminAuditLogs").doc("foreign-event").set({
      actorUid: otherProvider.uid,
      action: "imaging_order_advance",
      resource: "nexaOrders/foreign-order",
      createdAt: new Date(base + 100_000),
    }),
  ]);

  const pages = [];
  let cursor = "";
  do {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const response = await readResponse(await GET(makeRequest(provider, query)));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    pages.push(...response.body.events);
    cursor = response.body.nextCursor || "";
    assert.equal(response.body.hasMore, Boolean(cursor));
  } while (cursor);

  assert.equal(pages.length, 95);
  assert.equal(new Set(pages.map((event) => event.id)).size, 95);
  assert.equal(pages.some((event) => event.id === "adminAudit:foreign-event"), false);
  assert.equal(JSON.stringify(pages).includes("PRIVATE_PATIENT_UID"), false);
  assert.equal(JSON.stringify(pages).includes("PRIVATE_RESULT_PATIENT"), false);
  assert.equal(JSON.stringify(pages).includes("PRIVATE_CLINICAL_PATIENT"), false);
  assert.equal(JSON.stringify(pages).includes("PRIVATE_MEDICAL_NOTE"), false);
  assert.equal(JSON.stringify(pages).includes("PRIVATE_PRESCRIPTION_CONTEXT"), false);
  assert.ok(pages.every((event) => event.action && event.createdAt && !("context" in event) && !("patientUid" in event) && !("clinicalContext" in event)));
  assert.ok(pages.some((event) => event.action === "diagnostic_prescription_viewed" && event.resource === ""));
  assert.deepEqual(pages.slice(0, 4).map((event) => event.id), [
    "diagnosticResults:result-046",
    "diagnosticResults:result-045",
    "adminAudit:activity-044",
    "diagnosticResults:result-044",
  ]);
});

test("activity history requires a verified diagnostic provider and rejects malformed or borrowed cursors", async () => {
  const provider = await createAuthUser("partner-activity-cursor-owner");
  const otherProvider = await createAuthUser("partner-activity-cursor-other");
  const pending = await createAuthUser("partner-activity-pending");
  await createDiagnosticProvider(provider);
  await createDiagnosticProvider(otherProvider, { type: "imaging" });
  await createDiagnosticProvider(pending, { verified: false });
  await Promise.all(Array.from({ length: 45 }, (_, index) => db.collection("adminAuditLogs").doc(`cursor-event-${String(index).padStart(3, "0")}`).set({
    actorUid: provider.uid,
    action: "laboratory_order_accept",
    resource: `nexaOrders/cursor-order-${index}`,
    createdAt: new Date(Date.UTC(2026, 10, 8) + index * 1000),
  })));

  const first = await readResponse(await GET(makeRequest(provider)));
  assert.equal(first.status, 200);
  assert.equal(first.body.events.length, 40);
  assert.equal(first.body.hasMore, true);

  const malformed = await readResponse(await GET(makeRequest(provider, "?cursor=not-a-cursor")));
  const borrowed = await readResponse(await GET(makeRequest(otherProvider, `?cursor=${encodeURIComponent(first.body.nextCursor)}`)));
  const denied = await readResponse(await GET(makeRequest(pending)));
  const anonymous = await readResponse(await GET(makeRequest(null)));

  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "invalid-provider-activity-cursor");
  assert.equal(borrowed.status, 400);
  assert.equal(borrowed.body.code, "invalid-provider-activity-cursor");
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "verified-diagnostic-provider-required");
  assert.equal(anonymous.status, 401);
});
