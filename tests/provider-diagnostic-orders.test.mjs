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
  throw new Error("Refusing provider diagnostic order tests without local Auth and Firestore emulators.");
}

const [{ getFirebaseAdminDb }, { GET }, { GET: listProviderOffers }] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/provider/diagnostic-orders/route.ts"),
  import("../src/app/api/provider/diagnostic-offers/route.ts"),
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
  return new Request(`http://localhost:3000/api/provider/diagnostic-orders${query}`, {
    headers: { Origin: "http://localhost:3000", ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
  });
}

function makeOfferRequest(user) {
  return new Request("http://localhost:3000/api/provider/diagnostic-offers", {
    headers: { Origin: "http://localhost:3000", ...(user ? { Authorization: `Bearer ${user.token}` } : {}) },
  });
}

async function readResponse(response) {
  return { status: response.status, body: await response.json() };
}

async function createDiagnosticProvider(user, { verified = true } = {}) {
  await db.collection("providerProfiles").doc(user.uid).set({
    type: "laboratory",
    status: verified ? "verified" : "pending",
    publiclyListed: verified,
  });
}

beforeEach(async () => { await clearFirestoreEmulator(); });

after(async () => {
  const adminApp = getApps().find((app) => app.name === "nexa-server");
  if (adminApp) await deleteApp(adminApp);
});

test("diagnostic providers can paginate their own orders without gaps or duplicates", async () => {
  const provider = await createAuthUser("lab-orders-pagination");
  const otherProvider = await createAuthUser("other-lab-orders-pagination");
  await createDiagnosticProvider(provider);
  await createDiagnosticProvider(otherProvider);

  const createdAt = Date.UTC(2026, 10, 1);
  const batch = Array.from({ length: 52 }, (_, index) => db.collection("nexaOrders").doc(`diagnostic_order_${String(index).padStart(3, "0")}`).set({
    providerUid: provider.uid,
    kind: "laboratory",
    status: index % 2 ? "ANALYSIS_IN_PROGRESS" : "EXAM_COMPLETED",
    paymentStatus: "PAID",
    settlementStatus: "CONFIRMED",
    amount: 1000,
    currency: "HTG",
    orderNumber: `NMC-LAB-${String(index).padStart(4, "0")}`,
    patientNumber: `NMC-${String(index + 1).padStart(7, "0")}`,
    patientUid: `synthetic-patient-${index}`,
    items: [{ offerId: `offer-${index}`, name: `Examen ${index}`, price: 1000 }],
    createdAt: new Date(createdAt + index * 1000),
  }));
  await Promise.all(batch);
  await db.collection("nexaOrders").doc("diagnostic_order_foreign_001").set({
    providerUid: otherProvider.uid,
    kind: "laboratory",
    status: "EXAM_COMPLETED",
    paymentStatus: "PAID",
    settlementStatus: "CONFIRMED",
    amount: 1000,
    currency: "HTG",
    orderNumber: "NMC-LAB-FOREIGN",
    patientNumber: "NMC-9999999",
    items: [],
    createdAt: new Date(createdAt + 60_000),
  });

  const firstPage = await readResponse(await GET(makeRequest(provider)));
  assert.equal(firstPage.status, 200, JSON.stringify(firstPage.body));
  assert.equal(firstPage.body.orders.length, 50);
  assert.equal(firstPage.body.hasMore, true);
  assert.equal(firstPage.body.orders[0].orderNumber, "NMC-LAB-0051");
  assert.equal("patientUid" in firstPage.body.orders[0], false);

  const secondPage = await readResponse(await GET(makeRequest(provider, `?cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)));
  assert.equal(secondPage.status, 200, JSON.stringify(secondPage.body));
  assert.equal(secondPage.body.orders.length, 2);
  assert.equal(secondPage.body.hasMore, false);
  assert.equal(secondPage.body.nextCursor, null);
  assert.deepEqual([...firstPage.body.orders, ...secondPage.body.orders].map((order) => order.orderNumber), Array.from({ length: 52 }, (_, index) => `NMC-LAB-${String(51 - index).padStart(4, "0")}`));

  const byOrderNumber = await readResponse(await GET(makeRequest(provider, "?q=nmc-lab-0008")));
  assert.equal(byOrderNumber.status, 200, JSON.stringify(byOrderNumber.body));
  assert.deepEqual(byOrderNumber.body.orders.map((order) => order.orderNumber), ["NMC-LAB-0008"]);
  assert.equal("patientUid" in byOrderNumber.body.orders[0], false);

  const byPatientNumber = await readResponse(await GET(makeRequest(provider, "?q=nmc-0000009")));
  assert.equal(byPatientNumber.status, 200, JSON.stringify(byPatientNumber.body));
  assert.deepEqual(byPatientNumber.body.orders.map((order) => order.orderNumber), ["NMC-LAB-0008"]);

  const foreignOrder = await readResponse(await GET(makeRequest(provider, "?q=nmc-lab-foreign")));
  assert.equal(foreignOrder.status, 200, JSON.stringify(foreignOrder.body));
  assert.deepEqual(foreignOrder.body.orders, []);

  const invalidSearch = await readResponse(await GET(makeRequest(provider, "?q=unsafe%2Fquery")));
  assert.equal(invalidSearch.status, 400);
  assert.equal(invalidSearch.body.code, "invalid-diagnostic-order-search");

  const listAudit = await db.collection("adminAuditLogs").where("actorUid", "==", provider.uid).get();
  assert.equal(listAudit.size, 5);
  assert.ok(listAudit.docs.every((doc) => doc.get("action") === "laboratory_orders_listed"));
  assert.ok(listAudit.docs.some((doc) => doc.get("searchApplied") === true));
  assert.equal(JSON.stringify(listAudit.docs.map((doc) => doc.data())).toLowerCase().includes("nmc-0000009"), false);
});

test("diagnostic order cursors cannot be malformed or borrowed from another provider", async () => {
  const provider = await createAuthUser("lab-orders-cursor-owner");
  const otherProvider = await createAuthUser("lab-orders-cursor-other");
  await createDiagnosticProvider(provider);
  await createDiagnosticProvider(otherProvider);
  await db.collection("nexaOrders").doc("diagnostic_order_foreign_002").set({
    providerUid: otherProvider.uid,
    kind: "laboratory",
    paymentStatus: "PAID",
    settlementStatus: "CONFIRMED",
    createdAt: new Date(),
  });

  const malformed = await readResponse(await GET(makeRequest(provider, "?cursor=unsafe%2Fcursor")));
  const foreign = await readResponse(await GET(makeRequest(provider, "?cursor=diagnostic_order_foreign_002")));
  const anonymous = await readResponse(await GET(makeRequest(null)));

  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "invalid-diagnostic-order-cursor");
  assert.equal(foreign.status, 400);
  assert.equal(foreign.body.code, "invalid-diagnostic-order-cursor");
  assert.equal(anonymous.status, 401);
});

test("correction requests expose only the reason tied to the provider's own result", async () => {
  const provider = await createAuthUser("lab-result-correction-reason");
  const otherProvider = await createAuthUser("other-lab-result-correction-reason");
  await createDiagnosticProvider(provider);
  await createDiagnosticProvider(otherProvider);

  const ownOrderId = "diagnostic_order_review_reason_001";
  const ownResultId = "diagnostic_result_review_reason_001";
  const otherOrderId = "diagnostic_order_review_reason_002";
  const otherResultId = "diagnostic_result_review_reason_002";
  await Promise.all([
    db.collection("nexaOrders").doc(ownOrderId).set({
      providerUid: provider.uid,
      kind: "laboratory",
      status: "EXAM_COMPLETED",
      paymentStatus: "PAID",
      settlementStatus: "CONFIRMED",
      amount: 1000,
      currency: "HTG",
      orderNumber: "NMC-LAB-REVIEW-001",
      patientNumber: "NMC-1234567",
      patientUid: "synthetic-review-patient-1",
      items: [{ offerId: "offer-review-001", name: "Hémogramme", resultStatus: "CORRECTION_REQUESTED", resultId: ownResultId, correctionReason: "Motif falsifié dans la commande" }],
      createdAt: new Date(Date.UTC(2026, 10, 3)),
    }),
    db.collection("diagnosticResults").doc(ownResultId).set({
      providerUid: provider.uid,
      providerType: "laboratory",
      orderId: ownOrderId,
      examLineId: "offer-review-001",
      status: "CORRECTION_REQUESTED",
      reviewReason: "Ajouter la signature du biologiste sur le compte rendu.",
    }),
    db.collection("nexaOrders").doc(otherOrderId).set({
      providerUid: provider.uid,
      kind: "laboratory",
      status: "EXAM_COMPLETED",
      paymentStatus: "PAID",
      settlementStatus: "CONFIRMED",
      amount: 1000,
      currency: "HTG",
      orderNumber: "NMC-LAB-REVIEW-002",
      patientNumber: "NMC-7654321",
      patientUid: "synthetic-review-patient-2",
      items: [{ offerId: "offer-review-002", name: "Glycémie", resultStatus: "CORRECTION_REQUESTED", resultId: otherResultId, correctionReason: "Motif falsifié dans la commande" }],
      createdAt: new Date(Date.UTC(2026, 10, 3) + 1000),
    }),
    db.collection("diagnosticResults").doc(otherResultId).set({
      providerUid: otherProvider.uid,
      providerType: "laboratory",
      orderId: otherOrderId,
      examLineId: "offer-review-002",
      status: "CORRECTION_REQUESTED",
      reviewReason: "Ce motif appartient à un autre centre.",
    }),
  ]);

  const response = await readResponse(await GET(makeRequest(provider)));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const ownOrder = response.body.orders.find((order) => order.id === ownOrderId);
  const mismatchedResultOrder = response.body.orders.find((order) => order.id === otherOrderId);
  assert.equal(ownOrder.items[0].correctionReason, "Ajouter la signature du biologiste sur le compte rendu.");
  assert.equal("patientUid" in ownOrder, false);
  assert.equal("patientUid" in ownOrder.items[0], false);
  assert.equal("correctionReason" in mismatchedResultOrder.items[0], false);
});

test("diagnostic order search paginates exact patient numbers and binds its cursor to the search", async () => {
  const provider = await createAuthUser("lab-orders-search-pagination");
  await createDiagnosticProvider(provider);
  const createdAt = Date.UTC(2026, 10, 2);
  await Promise.all(Array.from({ length: 52 }, (_, index) => db.collection("nexaOrders").doc(`diagnostic_search_order_${String(index).padStart(3, "0")}`).set({
    providerUid: provider.uid,
    kind: "laboratory",
    status: "EXAM_COMPLETED",
    paymentStatus: "PAID",
    settlementStatus: "CONFIRMED",
    amount: 1000,
    currency: "HTG",
    orderNumber: `NMC-LAB-SEARCH-${String(index).padStart(4, "0")}`,
    patientNumber: "NMC-1234567",
    patientUid: `synthetic-search-patient-${index}`,
    items: [],
    createdAt: new Date(createdAt + index * 1000),
  })));

  const firstPage = await readResponse(await GET(makeRequest(provider, "?q=nmc-1234567")));
  assert.equal(firstPage.status, 200, JSON.stringify(firstPage.body));
  assert.equal(firstPage.body.orders.length, 50);
  assert.equal(firstPage.body.hasMore, true);
  assert.ok(firstPage.body.orders.every((order) => order.patientNumber === "NMC-1234567" && !("patientUid" in order)));

  const secondPage = await readResponse(await GET(makeRequest(provider, `?q=NMC-1234567&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)));
  assert.equal(secondPage.status, 200, JSON.stringify(secondPage.body));
  assert.equal(secondPage.body.orders.length, 2);
  assert.equal(secondPage.body.hasMore, false);
  assert.deepEqual([...firstPage.body.orders, ...secondPage.body.orders].map((order) => order.orderNumber), Array.from({ length: 52 }, (_, index) => `NMC-LAB-SEARCH-${String(51 - index).padStart(4, "0")}`));

  const borrowed = await readResponse(await GET(makeRequest(provider, `?q=NMC-7654321&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`)));
  assert.equal(borrowed.status, 400);
  assert.equal(borrowed.body.code, "invalid-diagnostic-order-cursor");
});

test("verified diagnostic providers can list only their offers and the read is audited without offer contents", async () => {
  const provider = await createAuthUser("provider-offer-audit");
  await createDiagnosticProvider(provider);
  await db.collection("diagnosticOffers").doc("provider_offer_audit_001").set({
    providerUid: provider.uid,
    providerType: "laboratory",
    name: "Examen synthétique",
    price: 1200,
    updatedAt: new Date(),
  });

  const response = await readResponse(await listProviderOffers(makeOfferRequest(provider)));

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.offers.length, 1);
  assert.equal(response.body.offers[0].name, "Examen synthétique");
  const logs = await db.collection("adminAuditLogs").where("actorUid", "==", provider.uid).get();
  assert.equal(logs.size, 1);
  assert.equal(logs.docs[0].get("action"), "diagnostic_offers_listed");
  assert.equal(logs.docs[0].get("resultCount"), 1);
  assert.equal(JSON.stringify(logs.docs[0].data()).includes("Examen synthétique"), false);
});
