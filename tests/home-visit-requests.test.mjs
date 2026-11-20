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
  throw new Error("Refusing home visit tests without local Auth and Firestore emulators.");
}

const [
  { getFirebaseAdminDb },
  { GET: listPatientRequests, POST: createPatientRequest },
  { GET: listAdminRequests, POST: updateAdminRequest },
  { GET: getAdminOverview },
] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/home-visit-requests/route.ts"),
  import("../src/app/api/admin/home-visit-requests/route.ts"),
  import("../src/app/api/admin/overview/route.ts"),
]);
const db = getFirebaseAdminDb();
const authBaseUrl = `http://${authHost}`;
const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
let userSequence = 0;

async function clearFirestoreEmulator() {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true, "Firestore emulator must be available and clearable.");
}

async function createAuthUser(prefix = "home-visit") {
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

function makeRequest(user, path, method = "GET", body) {
  return new Request(`http://localhost:3000${path}`, {
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

async function seedLegacyRequest({ requestId, patient, status = "PENDING_REVIEW" }) {
  await db.collection("homeVisitRequests").doc(requestId).set({
    patientUid: patient.uid,
    patientNumber: "NMC-0000421",
    patientName: "Test Patient NEXA",
    contactPhone: "+509 3700-0001",
    department: "Ouest",
    commune: "Port-au-Prince",
    addressLine: "12, rue des Fleurs, entrée principale",
    preferredDate: "2026-12-01",
    requestType: "HOME_VISIT",
    status,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

beforeEach(async () => {
  process.env.NEXA_ADMIN_UIDS = "";
  await clearFirestoreEmulator();
});

after(async () => {
  const adminApp = getApps().find((app) => app.name === "nexa-server");
  if (adminApp) await deleteApp(adminApp);
});

test("the replaced home visit submission endpoint returns 410 and does not create a legacy request", async () => {
  const patient = await createAuthUser();
  const retired = await readResponse(await createPatientRequest(makeRequest(patient, "/api/home-visit-requests", "POST", { serviceType: "home_visit" })));
  assert.equal(retired.status, 410);
  assert.equal(retired.body.code, "home-visit-flow-replaced");

  const anonymous = await readResponse(await createPatientRequest(makeRequest(null, "/api/home-visit-requests", "POST", { serviceType: "home_visit" })));
  assert.equal(anonymous.status, 401);
  assert.equal((await db.collection("homeVisitRequests").get()).size, 0);
  assert.equal((await db.collection("adminAuditLogs").get()).size, 0);
});

test("patients see only their own historical home visit requests", async () => {
  const patient = await createAuthUser();
  const otherPatient = await createAuthUser("other-home-visit");
  await seedLegacyRequest({ requestId: "legacy_home_visit_patient_0001", patient });
  await seedLegacyRequest({ requestId: "legacy_home_visit_other__0001", patient: otherPatient });

  const own = await readResponse(await listPatientRequests(makeRequest(patient, "/api/home-visit-requests")));
  const other = await readResponse(await listPatientRequests(makeRequest(otherPatient, "/api/home-visit-requests")));
  assert.equal(own.status, 200);
  assert.equal(own.body.requests.length, 1);
  assert.equal(own.body.requests[0].requestId, "legacy_home_visit_patient_0001");
  assert.equal(own.body.requests[0].addressLine, "12, rue des Fleurs, entrée principale");
  assert.equal(other.status, 200);
  assert.equal(other.body.requests.length, 1);
  assert.equal(other.body.requests[0].requestId, "legacy_home_visit_other__0001");
});

test("only NEXA administrators may review requests and statuses are one-way and audited", async () => {
  const patient = await createAuthUser();
  const administrator = await createAuthUser("nexa-admin");
  const requestId = "legacy_home_visit_admin__0001";
  await seedLegacyRequest({ requestId, patient });

  const denied = await readResponse(await listAdminRequests(makeRequest(patient, "/api/admin/home-visit-requests")));
  assert.equal(denied.status, 503, "the admin API fails closed until an admin UID is configured");

  process.env.NEXA_ADMIN_UIDS = "another-authorized-admin-uid";
  const nonAdministrator = await readResponse(await listAdminRequests(makeRequest(patient, "/api/admin/home-visit-requests")));
  assert.equal(nonAdministrator.status, 403);
  process.env.NEXA_ADMIN_UIDS = administrator.uid;
  const overview = await readResponse(await getAdminOverview(makeRequest(administrator, "/api/admin/overview")));
  assert.equal(overview.status, 200);
  assert.equal(overview.body.counts.homeVisitRequests, 1);
  const queue = await readResponse(await listAdminRequests(makeRequest(administrator, "/api/admin/home-visit-requests")));
  assert.equal(queue.status, 200);
  assert.equal(queue.body.requests.length, 1);
  assert.equal(queue.body.requests[0].addressLine, "12, rue des Fleurs, entrée principale");

  const contacted = await readResponse(await updateAdminRequest(makeRequest(administrator, "/api/admin/home-visit-requests", "POST", { requestId, status: "CONTACTED" })));
  assert.equal(contacted.status, 200, JSON.stringify(contacted.body));
  const confirmed = await readResponse(await updateAdminRequest(makeRequest(administrator, "/api/admin/home-visit-requests", "POST", { requestId, status: "CONFIRMED" })));
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.status, "CONFIRMED");
  assert.equal(confirmed.body.alreadyInStatus, false);
  const repeatedConfirmation = await readResponse(await updateAdminRequest(makeRequest(administrator, "/api/admin/home-visit-requests", "POST", { requestId, status: "CONFIRMED" })));
  assert.equal(repeatedConfirmation.body.alreadyInStatus, true);
  const conflictingClose = await readResponse(await updateAdminRequest(makeRequest(administrator, "/api/admin/home-visit-requests", "POST", { requestId, status: "UNAVAILABLE" })));
  assert.equal(conflictingClose.status, 409);

  const refreshed = await readResponse(await listPatientRequests(makeRequest(patient, "/api/home-visit-requests")));
  assert.equal(refreshed.body.requests[0].status, "CONFIRMED");
  const notices = await db.collection("userNotifications").where("uid", "==", patient.uid).get();
  assert.equal(notices.size, 2, "contact and confirmation updates create one inbox notice each");
  assert.equal(notices.docs.every((document) => !/12, rue|3700-0001|NMC-0000421/.test(`${document.get("title")} ${document.get("body")}`)), true);
  const logs = (await db.collection("adminAuditLogs").get()).docs;
  const reviewEvents = logs.filter((document) => String(document.get("action") || "").startsWith("home_visit_request_"));
  assert.deepEqual(new Set(reviewEvents.map((document) => document.get("action"))), new Set([
    "home_visit_request_contacted",
    "home_visit_request_confirmed",
  ]));
  assert.equal(reviewEvents.some((document) => document.get("addressLine") || document.get("contactPhone")), false);
});
