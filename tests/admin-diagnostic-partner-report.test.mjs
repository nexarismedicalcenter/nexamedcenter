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
  throw new Error("Refusing diagnostic partner report tests without local Auth and Firestore emulators.");
}

const [{ getFirebaseAdminDb }, { GET }] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/admin/diagnostic-partner-report/route.ts"),
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
  return new Request(`http://localhost:3000/api/admin/diagnostic-partner-report${query}`, {
    headers: { Origin: "http://localhost:3000", ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
  });
}

async function readResponse(response) {
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  process.env.NEXA_ADMIN_UIDS = "";
  await clearFirestoreEmulator();
});

after(async () => {
  const adminApp = getApps().find((app) => app.name === "nexa-server");
  if (adminApp) await deleteApp(adminApp);
});

test("partner activity reports require an administrator and a diagnostic provider", async () => {
  const administrator = await createAuthUser("partner-report-admin");
  const regularUser = await createAuthUser("partner-report-user");
  process.env.NEXA_ADMIN_UIDS = administrator.uid;

  const anonymous = await readResponse(await GET(makeRequest(null, "?providerUid=provider-001")));
  const denied = await readResponse(await GET(makeRequest(regularUser, "?providerUid=provider-001")));
  const invalidUid = await readResponse(await GET(makeRequest(administrator, "?providerUid=bad%2Fuid")));
  const missingProvider = await readResponse(await GET(makeRequest(administrator, "?providerUid=provider-001")));
  await db.collection("providerProfiles").doc("provider-pharmacy-001").set({ type: "pharmacy", profile: { name: "Pharmacie synthétique" } });
  const wrongProviderType = await readResponse(await GET(makeRequest(administrator, "?providerUid=provider-pharmacy-001")));

  assert.equal(anonymous.status, 401);
  assert.equal(denied.status, 403);
  assert.equal(invalidUid.status, 400);
  assert.equal(missingProvider.status, 404);
  assert.equal(wrongProviderType.status, 404);
  assert.equal((await db.collection("adminAuditLogs").get()).size, 0);
});

test("partner activity reports return isolated aggregate counts without patient or payout details", async () => {
  const administrator = await createAuthUser("partner-report-admin-counts");
  const provider = await createAuthUser("partner-report-lab");
  const otherProvider = await createAuthUser("partner-report-other-lab");
  process.env.NEXA_ADMIN_UIDS = administrator.uid;
  await Promise.all([
    db.collection("providerProfiles").doc(provider.uid).set({ type: "laboratory", status: "verified", profile: { name: "Laboratoire NEXA synthétique" } }),
    db.collection("providerProfiles").doc(otherProvider.uid).set({ type: "laboratory", status: "verified", profile: { name: "Autre laboratoire" } }),
    db.collection("nexaOrders").doc("report_order_own_001").set({ providerUid: provider.uid, kind: "laboratory", patientUid: "synthetic-patient-private-1", patientNumber: "NMC-0000001", amount: 999999, createdAt: new Date() }),
    db.collection("nexaOrders").doc("report_order_own_002").set({ providerUid: provider.uid, kind: "laboratory", patientUid: "synthetic-patient-private-2", patientNumber: "NMC-0000002", createdAt: new Date() }),
    db.collection("nexaOrders").doc("report_order_wrong_kind_001").set({ providerUid: provider.uid, kind: "imaging", patientUid: "synthetic-patient-private-3", createdAt: new Date() }),
    db.collection("nexaOrders").doc("report_order_other_provider_001").set({ providerUid: otherProvider.uid, kind: "laboratory", createdAt: new Date() }),
  ]);
  const statuses = ["RESULT_PENDING_REVIEW", "CORRECTION_REQUESTED", "VALIDATED", "RESULT_AVAILABLE", "NOT_PERFORMED", "SUPERSEDED"];
  await Promise.all(statuses.map((status, index) => db.collection("diagnosticResults").doc(`report_result_own_${String(index).padStart(3, "0")}`).set({
    providerUid: provider.uid,
    providerType: "laboratory",
    status,
    orderId: `report_order_own_00${index % 2 + 1}`,
    examLineId: `report_exam_${index}`,
    patientUid: `synthetic-patient-private-${index}`,
    patientNumber: `NMC-${String(index + 1).padStart(7, "0")}`,
    reviewReason: "SYNTHETIC_PRIVATE_REVIEW_REASON",
    partnerAmountSnapshot: 123456,
  })));
  await db.collection("diagnosticResults").doc("report_result_other_provider_001").set({ providerUid: otherProvider.uid, providerType: "laboratory", status: "CORRECTION_REQUESTED" });

  const response = await readResponse(await GET(makeRequest(administrator, `?providerUid=${encodeURIComponent(provider.uid)}`)));

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.report, {
    providerUid: provider.uid,
    providerName: "Laboratoire NEXA synthétique",
    providerType: "laboratory",
    providerStatus: "verified",
    ordersAssigned: 2,
    resultsPendingReview: 1,
    correctionsPending: 1,
    examsValidated: 1,
    resultsAvailable: 1,
    examsPerformed: 2,
    examsNotPerformed: 1,
  });
  for (const privateValue of ["synthetic-patient-private", "NMC-0000001", "SYNTHETIC_PRIVATE_REVIEW_REASON", "partnerAmountSnapshot", "123456", "999999"]) {
    assert.equal(JSON.stringify(response.body).includes(privateValue), false, `Report must omit ${privateValue}.`);
  }
  const audit = await db.collection("adminAuditLogs").where("actorUid", "==", administrator.uid).get();
  assert.equal(audit.size, 1);
  assert.equal(audit.docs[0].get("action"), "diagnostic_partner_report_viewed");
  assert.equal(audit.docs[0].get("resource"), `providerProfiles/${provider.uid}`);
  assert.equal(JSON.stringify(audit.docs[0].data()).includes("NMC-0000001"), false);
});
