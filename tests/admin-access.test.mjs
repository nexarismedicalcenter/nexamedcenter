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
const isLocal = (value) => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${value.replace(/^https?:\/\//, "")}`).hostname);
if (!authHost || !firestoreHost || !isLocal(authHost) || !isLocal(firestoreHost)) {
  throw new Error("Refusing admin access tests without local Auth and Firestore emulators.");
}

const [{ getFirebaseAdminDb }, { GET: listAdminAccounts }] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/admin/accounts/route.ts"),
]);
const db = getFirebaseAdminDb();
const authBaseUrl = `http://${authHost}`;
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
  return { uid: result.localId, token: result.idToken, email };
}

function makeRequest(user, query = "") {
  return new Request(`http://localhost:3000/api/admin/accounts${query}`, {
    headers: {
      Origin: "http://localhost:3000",
      ...(user ? { Authorization: `Bearer ${user.token}` } : {}),
    },
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

test("admin account APIs reject anonymous users and authenticated non-admins", async () => {
  const administrator = await createAuthUser("configured-admin");
  const regularUser = await createAuthUser("regular-user");
  process.env.NEXA_ADMIN_UIDS = administrator.uid;

  const anonymous = await readResponse(await listAdminAccounts(makeRequest(null)));
  const denied = await readResponse(await listAdminAccounts(makeRequest(regularUser)));

  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.code, "authentication-required");
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, "administrator-required");
  assert.equal((await db.collection("adminAuditLogs").get()).size, 0);
});

test("admin account APIs fail closed until an administrator UID is configured", async () => {
  const user = await createAuthUser("unconfigured-admin");

  const response = await readResponse(await listAdminAccounts(makeRequest(user)));

  assert.equal(response.status, 503);
  assert.equal(response.body.code, "admin-access-not-configured");
  assert.equal((await db.collection("adminAuditLogs").get()).size, 0);
});

test("configured administrators receive only the minimal account listing and an audit record", async () => {
  const administrator = await createAuthUser("nexa-admin");
  const patient = await createAuthUser("listed-patient");
  process.env.NEXA_ADMIN_UIDS = administrator.uid;
  await db.collection("patientProfiles").doc(patient.uid).set({
    displayName: "Patient de test",
    email: patient.email,
    phone: "+509-5555-0100",
    patientNumber: "NMC-0000001",
    profileComplete: true,
    clinicalNotes: "SYNTHETIC_PRIVATE_CLINICAL_NOTE",
    deliveryAddress: "SYNTHETIC_PRIVATE_ADDRESS",
    walletBalance: 999999,
  });

  const response = await readResponse(await listAdminAccounts(makeRequest(administrator, "?type=patients")));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.accounts.length, 1);
  assert.deepEqual(response.body.accounts[0], {
    uid: patient.uid,
    type: "patient",
    name: "Patient de test",
    email: patient.email,
    phone: "+509-5555-0100",
    patientNumber: "NMC-0000001",
    profileComplete: true,
    createdAt: null,
  });
  assert.equal(JSON.stringify(response.body).includes("SYNTHETIC_PRIVATE_CLINICAL_NOTE"), false);
  assert.equal(JSON.stringify(response.body).includes("SYNTHETIC_PRIVATE_ADDRESS"), false);
  assert.equal(JSON.stringify(response.body).includes("999999"), false);

  const invalidType = await readResponse(await listAdminAccounts(makeRequest(administrator, "?type=clinical-records")));
  const invalidCursor = await readResponse(await listAdminAccounts(makeRequest(administrator, "?cursor=patient/private")));
  assert.equal(invalidType.status, 400);
  assert.equal(invalidCursor.status, 400);

  const auditLogs = await db.collection("adminAuditLogs").get();
  assert.equal(auditLogs.size, 1);
  assert.equal(auditLogs.docs[0].get("actorUid"), administrator.uid);
  assert.equal(auditLogs.docs[0].get("action"), "admin_account_listed");
});
