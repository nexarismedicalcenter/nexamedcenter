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
  throw new Error("Refusing diagnostic offer tests without local Auth and Firestore emulators.");
}

const [{ getFirebaseAdminDb }, { GET, POST }] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/admin/diagnostic-offers/route.ts"),
]);
const db = getFirebaseAdminDb();
const authBaseUrl = `http://${authHost}`;
const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
let userSequence = 0;

async function clearFirestoreEmulator() {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true, "Firestore emulator must be available and clearable.");
}

async function createAuthUser() {
  userSequence += 1;
  const email = `diagnostic-admin.${Date.now()}.${userSequence}@example.test`;
  const response = await fetch(`${authBaseUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "NexaTestPassword-2026", returnSecureToken: true }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, `Auth emulator account creation failed with HTTP ${response.status}.`);
  return { uid: result.localId, token: result.idToken };
}

function makeRequest(user, method = "GET", body) {
  return new Request("http://localhost:3000/api/admin/diagnostic-offers", {
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

async function seedOffer(input = {}) {
  const offerId = input.id || "offer_live_000001";
  const providerUid = input.providerUid || "provider-test-uid";
  await db.collection("providerProfiles").doc(providerUid).set({ type: "laboratory", status: "verified", publiclyListed: true });
  await db.collection("diagnosticOffers").doc(offerId).set({
    providerUid,
    providerType: "laboratory",
    name: "Hémogramme",
    price: 500,
    requestedAvailability: true,
    active: input.status === "PUBLISHED",
    publicationStatus: input.status || "PUBLISHED",
    resultRequirements: {
      requiredCategories: ["LAB_RESULT"],
      allowSupplemental: true,
      allowMultiplePerCategory: true,
      maxFiles: 20,
      maxFileBytes: 15 * 1024 * 1024,
      allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"],
    },
  });
  return { offerId, providerUid };
}

const updatedRequirements = {
  requiredCategories: ["LAB_RESULT"],
  allowSupplemental: false,
  allowMultiplePerCategory: false,
  maxFiles: 1,
  maxFileBytes: 2 * 1024 * 1024,
  allowedMimeTypes: ["application/pdf"],
};

beforeEach(async () => {
  process.env.NEXA_ADMIN_UIDS = "";
  await clearFirestoreEmulator();
});

after(async () => {
  const adminApp = getApps().find((app) => app.name === "nexa-server");
  if (adminApp) await deleteApp(adminApp);
});

test("admin list returns pending and published diagnostic offers", async () => {
  const administrator = await createAuthUser();
  process.env.NEXA_ADMIN_UIDS = administrator.uid;
  await seedOffer({ id: "offer_live_000001", status: "PUBLISHED" });
  await seedOffer({ id: "offer_pending_0001", status: "PENDING_REVIEW" });

  const response = await readResponse(await GET(makeRequest(administrator)));

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(new Set(response.body.offers.map((offer) => offer.publicationStatus)), new Set(["PUBLISHED", "PENDING_REVIEW"]));
});

test("updating a published offer preserves its live state and existing order snapshot", async () => {
  const administrator = await createAuthUser();
  process.env.NEXA_ADMIN_UIDS = administrator.uid;
  const { offerId, providerUid } = await seedOffer({ status: "PUBLISHED" });
  const existingOrderRequirements = { ...updatedRequirements, maxFiles: 5 };
  await db.collection("nexaOrders").doc("order_existing_0001").set({
    providerUid,
    items: [{ offerId, resultRequirements: existingOrderRequirements }],
  });

  const response = await readResponse(await POST(makeRequest(administrator, "POST", {
    offerId,
    action: "UPDATE_REQUIREMENTS",
    resultRequirements: updatedRequirements,
  })));

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const savedOffer = await db.collection("diagnosticOffers").doc(offerId).get();
  assert.equal(savedOffer.get("publicationStatus"), "PUBLISHED");
  assert.equal(savedOffer.get("active"), true);
  assert.deepEqual(savedOffer.get("resultRequirements"), updatedRequirements);
  const savedOrder = await db.collection("nexaOrders").doc("order_existing_0001").get();
  assert.deepEqual(savedOrder.get("items")[0].resultRequirements, existingOrderRequirements);
  const logs = await db.collection("adminAuditLogs").get();
  assert.equal(logs.size, 1);
  assert.equal(logs.docs[0].get("action"), "diagnostic_offer_requirements_updated");
});

test("rejects updates to pending offers and invalid requirement policies", async () => {
  const administrator = await createAuthUser();
  process.env.NEXA_ADMIN_UIDS = administrator.uid;
  const { offerId } = await seedOffer({ status: "PENDING_REVIEW" });

  const wrongStatus = await readResponse(await POST(makeRequest(administrator, "POST", {
    offerId,
    action: "UPDATE_REQUIREMENTS",
    resultRequirements: updatedRequirements,
  })));
  assert.equal(wrongStatus.status, 409);
  assert.equal(wrongStatus.body.code, "diagnostic-offer-not-published");

  await db.collection("diagnosticOffers").doc(offerId).update({ publicationStatus: "PUBLISHED", active: true });
  const invalidPolicy = await readResponse(await POST(makeRequest(administrator, "POST", {
    offerId,
    action: "UPDATE_REQUIREMENTS",
    resultRequirements: { ...updatedRequirements, allowedMimeTypes: ["application/x-executable"] },
  })));
  assert.equal(invalidPolicy.status, 400);
  assert.equal(invalidPolicy.body.code, "invalid-result-requirements");
  assert.equal((await db.collection("adminAuditLogs").get()).size, 0);
});
