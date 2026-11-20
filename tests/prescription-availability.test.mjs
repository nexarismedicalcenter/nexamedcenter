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
if (!isLocal(authHost) || !isLocal(firestoreHost)) throw new Error("Refusing prescription availability tests without local Auth and Firestore emulators.");

const [{ getFirebaseAdminDb }, { GET }, { POST: createDiagnosticOrder }] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/patient/prescriptions/[prescriptionId]/availability/route.ts"),
  import("../src/app/api/diagnostics/orders/route.ts"),
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
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "NexaTestPassword-2026", returnSecureToken: true }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, `Auth emulator account creation failed with HTTP ${response.status}.`);
  return { uid: result.localId, token: result.idToken };
}

function makeRequest(user, prescriptionId = "prescription_test_001") {
  return new Request(`http://localhost:3000/api/patient/prescriptions/${prescriptionId}/availability`, {
    headers: { Origin: "http://localhost:3000", ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
  });
}

async function responseBody(response) { return { status: response.status, body: await response.json() }; }

async function seedAvailability(user, { expired = false } = {}) {
  await db.collection("patientProfiles").doc(user.uid).set({ uid: user.uid, role: "patient", profileComplete: true, patientNumber: "NMC-0000001", department: "Ouest", commune: "Port-au-Prince" });
  await db.collection("clinicalPrescriptions").doc("prescription_test_001").set({
    patientUid: user.uid, status: "VALIDATED", expiresAt: expired ? "2020-01-01T00:00:00.000Z" : "2030-01-01T00:00:00.000Z",
    medications: [{ name: "Amoxicilline", dosage: "500 mg", form: "Capsule", quantity: 2 }],
    labExams: ["Hémogramme complet"], imagingExams: ["Radiographie thoracique"],
  });
  await db.collection("providerProfiles").doc("pharmacy_same_area_001").set({ type: "pharmacy", status: "verified", publiclyListed: true, profile: { name: "Pharmacie Locale", department: "Ouest", commune: "Port-au-Prince" } });
  await db.collection("pharmacyProducts").doc("medicine_test_0001").set({
    providerUid: "pharmacy_same_area_001", publicationStatus: "PUBLISHED", active: true, name: "Amoxicilline", dosage: "500 mg", pharmaceuticalForm: "Capsule", price: 450, stock: 4, reservedStock: 0,
    regulatoryCategory: "PRESCRIPTION", prescriptionRequired: true,
    lots: [{ lotNumber: "LOT-TEST-01", expirationDate: "2030-01-01", quantityReceived: 4, quantityAvailable: 4, reservedQuantity: 0, status: "ACTIVE" }],
  });
  await db.collection("providerProfiles").doc("lab_same_area_001").set({ type: "laboratory", status: "verified", publiclyListed: true, profile: { name: "Laboratoire Local", department: "Ouest", commune: "Port-au-Prince" } });
  await db.collection("diagnosticOffers").doc("lab_offer_test_001").set({ providerUid: "lab_same_area_001", providerType: "laboratory", publicationStatus: "PUBLISHED", active: true, requestedAvailability: true, name: "Hémogramme complet", price: 850 });
  await db.collection("providerProfiles").doc("imaging_same_area_001").set({ type: "imaging", status: "verified", publiclyListed: true, profile: { name: "Centre Imagerie Local", department: "Ouest", commune: "Port-au-Prince" } });
  await db.collection("diagnosticOffers").doc("imaging_offer_test_001").set({ providerUid: "imaging_same_area_001", providerType: "imaging", publicationStatus: "PUBLISHED", active: true, requestedAvailability: true, name: "Radiographie thoracique", price: 1200 });
  await db.collection("providerProfiles").doc("unverified_lab_001").set({ type: "laboratory", status: "pending", publiclyListed: false, profile: { name: "Non vérifié" } });
  await db.collection("diagnosticOffers").doc("lab_unverified_test_001").set({ providerUid: "unverified_lab_001", providerType: "laboratory", publicationStatus: "PUBLISHED", active: true, name: "Hémogramme complet", price: 1 });
}

beforeEach(clearFirestoreEmulator);
after(async () => { const adminApp = getApps().find((app) => app.name === "nexa-server"); if (adminApp) await deleteApp(adminApp); });

test("patient sees only matching in-stock products and verified diagnostic offers, ordered by location", async () => {
  const patient = await createAuthUser("prescription-availability");
  await seedAvailability(patient);
  const result = await responseBody(await GET(makeRequest(patient), { params: Promise.resolve({ prescriptionId: "prescription_test_001" }) }));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.lines.length, 3);
  assert.deepEqual(result.body.lines.map((line) => line.status), ["DISPONIBLE", "DISPONIBLE", "DISPONIBLE"], JSON.stringify(result.body));
  assert.equal(result.body.lines[0].offers[0].id, "medicine_test_0001");
  assert.equal(result.body.lines[1].offers[0].id, "lab_offer_test_001");
  assert.equal(result.body.lines[2].offers[0].id, "imaging_offer_test_001");
  assert.equal(result.body.lines[1].offers.some((offer) => offer.id === "lab_unverified_test_001"), false);
  assert.equal(result.body.lines[0].offers[0].stock, 4);
  const logs = await db.collection("adminAuditLogs").where("actorUid", "==", patient.uid).get();
  assert.equal(logs.size, 1);
  assert.equal(logs.docs[0].get("action"), "prescription_availability_checked");
  assert.equal(JSON.stringify(logs.docs[0].data()).includes("Amoxicilline"), false);
});

test("patients cannot inspect another patient's prescription", async () => {
  const owner = await createAuthUser("prescription-availability-owner");
  const other = await createAuthUser("prescription-availability-other");
  await seedAvailability(owner);
  await db.collection("patientProfiles").doc(other.uid).set({ uid: other.uid, role: "patient", profileComplete: true, department: "Ouest", commune: "Port-au-Prince" });
  const result = await responseBody(await GET(makeRequest(other), { params: Promise.resolve({ prescriptionId: "prescription_test_001" }) }));
  assert.equal(result.status, 403);
  assert.equal(result.body.code, "prescription-not-available");
});

test("expired prescriptions are refused without applying an invented expiry to unexpired records", async () => {
  const patient = await createAuthUser("prescription-availability-expiry");
  await seedAvailability(patient, { expired: true });
  const result = await responseBody(await GET(makeRequest(patient), { params: Promise.resolve({ prescriptionId: "prescription_test_001" }) }));
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "prescription-expired");
  await db.collection("clinicalPrescriptions").doc("prescription_test_001").update({ expiresAt: null });
  const withoutExpiry = await responseBody(await GET(makeRequest(patient), { params: Promise.resolve({ prescriptionId: "prescription_test_001" }) }));
  assert.equal(withoutExpiry.status, 200, JSON.stringify(withoutExpiry.body));
});

test("diagnostic orders validate and persist the exact linked prescription line", async () => {
  const patient = await createAuthUser("prescription-diagnostic-order");
  await seedAvailability(patient);
  const createRequest = (prescriptionLineId) => new Request("http://localhost:3000/api/diagnostics/orders", {
    method: "POST",
    headers: { Origin: "http://localhost:3000", Authorization: `Bearer ${patient.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      offerIds: ["lab_offer_test_001"],
      prescriptionId: "prescription_test_001",
      prescriptionLineIds: { lab_offer_test_001: prescriptionLineId },
      orderRequestId: "ec050f57-bb39-4f8d-a64b-563644a7d013",
    }),
  });

  const wrongLine = await responseBody(await createDiagnosticOrder(createRequest("imaging-1")));
  assert.equal(wrongLine.status, 409);
  assert.equal(wrongLine.body.code, "prescription-line-mismatch");

  const created = await responseBody(await createDiagnosticOrder(createRequest("laboratory-1")));
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const order = await db.collection("nexaOrders").doc(created.body.orderId).get();
  assert.equal(order.get("prescriptionId"), "prescription_test_001");
  assert.equal(order.get("items")[0].prescriptionLineId, "laboratory-1");
});
