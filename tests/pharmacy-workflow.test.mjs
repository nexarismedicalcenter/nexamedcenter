import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHmac } from "node:crypto";
import { deleteApp, getApps } from "firebase-admin/app";

process.env.NODE_ENV = "test";
process.env.FIREBASE_PROJECT_ID = "demo-nexaris";
process.env.NEXA_PHARMACY_DELIVERY_ENABLED = "true";
process.env.CRON_SECRET = "demo-pharmacy-expiry-cron-secret";
process.env.SMARTCUT_TO_NEXA_WEBHOOK_SECRET = "demo-moncash-callback-signing-secret";
process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||= "demo-api-key";

const projectId = "demo-nexaris";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || "";
const isLocalHost = (host) => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${host}`).hostname);
if (!firestoreHost || !authHost || !isLocalHost(firestoreHost) || !isLocalHost(authHost)) {
  throw new Error("Refusing pharmacy workflow tests without local Auth and Firestore emulators.");
}

const [
  { getFirebaseAdminDb },
  { POST: initializePatientProfile },
  { POST: createPharmacyOrder },
  { GET: getPatientOrders },
  { GET: getPatientWallet },
  { POST: payPatientOrderByWallet },
  { POST: payAppointmentWallet },
  { GET: getProviderOrders, POST: updateProviderOrder },
  { POST: receivePharmacyLot },
  { POST: adminReviewProduct },
  { GET: listAdminPharmacyStockMovements },
  { GET: expirePharmacyHolds },
  { POST: moncashCallback },
] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/patient-profile/initialize/route.ts"),
  import("../src/app/api/pharmacy/orders/route.ts"),
  import("../src/app/api/patient/orders/route.ts"),
  import("../src/app/api/patient/wallet/route.ts"),
  import("../src/app/api/patient/orders/[orderId]/pay-wallet/route.ts"),
  import("../src/app/api/appointments/[appointmentId]/pay-wallet/route.ts"),
  import("../src/app/api/provider/pharmacy-orders/route.ts"),
  import("../src/app/api/provider/pharmacy-products/receive-lot/route.ts"),
  import("../src/app/api/admin/pharmacy-products/route.ts"),
  import("../src/app/api/admin/pharmacy-stock-movements/route.ts"),
  import("../src/app/api/cron/expire-pharmacy-order-holds/route.ts"),
  import("../src/app/api/payments/moncash/callback/route.ts"),
]);
const db = getFirebaseAdminDb();
const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const authBaseUrl = `http://${authHost}`;

async function clearFirestoreEmulator() {
  const response = await fetch(
    `http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: "DELETE" },
  );
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
  assert.equal(typeof result.localId, "string");
  assert.equal(typeof result.idToken, "string");
  return { uid: result.localId, token: result.idToken };
}

async function initializePatientAccount(user, firstName) {
  const created = await initializeNewAccountNumber(user);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.profileComplete, false);

  const completed = await readResponse(await initializePatientProfile(makeRequest("/api/patient-profile/initialize", {
    method: "POST",
    token: user.token,
    body: {
      firstName,
      lastName: "Patient test",
      birthDate: "1990-01-01",
      phone: "+509 3700-0000",
      sex: "Non communiqué",
      addressLine: "Adresse fictive de test",
      country: "Haïti",
      department: "Ouest",
      commune: "Port-au-Prince",
      emailMarketingConsent: false,
      termsAccepted: true,
    },
  })));
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  return { created: created.body, completed: completed.body };
}

async function initializeNewAccountNumber(user) {
  return readResponse(await initializePatientProfile(makeRequest("/api/patient-profile/initialize", {
    method: "POST", token: user.token, body: {},
  })));
}

function makeRequest(path, { method = "GET", token = "", body, headers = {} } = {}) {
  const requestHeaders = new Headers({ Origin: "http://localhost:3000", ...headers });
  if (token) requestHeaders.set("Authorization", `Bearer ${token}`);
  if (body !== undefined) requestHeaders.set("Content-Type", "application/json");
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: requestHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function readResponse(response) {
  return { status: response.status, body: await response.json() };
}

async function createOrder(patient, productId, { quantity = 1, deliveryMethod = "pickup", deliveryAddress, prescriptionId, prescriptionLineId } = {}) {
  return readResponse(await createPharmacyOrder(makeRequest("/api/pharmacy/orders", {
    method: "POST",
    token: patient.token,
    body: {
      pharmacyId: pharmacy.uid,
      items: [{ productId, quantity, ...(prescriptionLineId ? { prescriptionLineId } : {}) }],
      ...(prescriptionId ? { prescriptionId } : {}),
      deliveryMethod,
      ...(deliveryAddress ? { deliveryAddress } : {}),
    },
  })));
}

async function payOrderWithWallet(orderId, actor = patient) {
  return readResponse(await payPatientOrderByWallet(makeRequest(`/api/patient/orders/${orderId}/pay-wallet`, {
    method: "POST", token: actor.token,
  }), { params: Promise.resolve({ orderId }) }));
}

async function seedAppointmentWalletPayment({ appointmentId, owner, paymentRef, slotId, amount = 1000 }) {
  const holdExpiresAt = Date.now() + 60_000;
  const appointmentRef = db.collection("appointments").doc(appointmentId);
  const walletRef = db.collection("nexaPatientWallets").doc(owner.uid);
  await Promise.all([
    appointmentRef.set({
      patientUid: owner.uid,
      providerUid: pharmacy.uid,
      slotId,
      moncashPaymentRef: paymentRef,
      amount,
      currency: "HTG",
      status: "PENDING_PAYMENT",
      paymentStatus: "PENDING",
      holdExpiresAt,
    }),
    db.collection("providerAvailabilitySlots").doc(slotId).set({
      providerUid: pharmacy.uid,
      patientUid: owner.uid,
      appointmentId,
      status: "held",
      holdExpiresAt,
    }),
    db.collection("paymentIntents").doc(paymentRef).set({
      uid: owner.uid,
      paymentMethod: "MONCASH",
      resourceType: "appointment",
      resourcePath: appointmentRef.path,
      amount,
      currency: "HTG",
      status: "created",
    }),
    walletRef.set({ status: "ACTIVE", currency: "HTG", availableMinor: 100_000, reservedMinor: 0 }),
  ]);
  return { appointmentRef, walletRef };
}

async function payAppointmentFromWallet(appointmentId, actor = patient) {
  return readResponse(await payAppointmentWallet(makeRequest(`/api/appointments/${appointmentId}/pay-wallet`, {
    method: "POST", token: actor.token, body: {},
  }), { params: Promise.resolve({ appointmentId }) }));
}

async function settleOrder(orderResult) {
  assert.equal(orderResult.status, 200, JSON.stringify(orderResult.body));
  const callback = {
    paymentRef: orderResult.body.paymentRef,
    amount: orderResult.body.totalAmount,
    currency: "HTG",
    status: "paid",
    transactionId: `test-txn-${orderResult.body.orderId}`,
  };
  const first = await readResponse(await moncashCallback(signedCallbackRequest(callback)));
  const duplicate = await readResponse(await moncashCallback(signedCallbackRequest(callback)));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.alreadyPaid, false);
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.alreadyPaid, true);
}

function signedCallbackRequest(body, signatureOverride) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Date.now());
  const signature = signatureOverride || createHmac("sha256", process.env.SMARTCUT_TO_NEXA_WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return new Request("http://localhost:3000/api/payments/moncash/callback", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Nexa-Timestamp": timestamp, "X-Nexa-Signature": signature },
    body: rawBody,
  });
}

async function providerAction(orderId, action, extra = {}, actor = pharmacy) {
  return readResponse(await updateProviderOrder(makeRequest("/api/provider/pharmacy-orders", {
    method: "POST", token: actor.token, body: { orderId, action, ...extra },
  })));
}

async function receiveLot(productId, { lotNumber = "LOT-RECEIVED-001", expirationDate = "2030-01-01", quantityReceived = 4 } = {}, actor = pharmacy) {
  return readResponse(await receivePharmacyLot(makeRequest("/api/provider/pharmacy-products/receive-lot", {
    method: "POST", token: actor.token, body: { productId, lotNumber, expirationDate, quantityReceived },
  })));
}

async function reviewProduct(productId, action = "PUBLISH", reason = "") {
  return readResponse(await adminReviewProduct(makeRequest("/api/admin/pharmacy-products", {
    method: "POST", token: administrator.token, body: { productId, action, reason },
  })));
}

async function productStock(productId) {
  const product = await db.collection("pharmacyProducts").doc(productId).get();
  return { stock: product.get("stock"), reservedStock: product.get("reservedStock") };
}

let patient;
let otherPatient;
let pharmacy;
let otherPharmacy;
let firstPatientInitialization;
let secondPatientInitialization;
let firstProfessionalInitialization;
let secondProfessionalInitialization;
let administrator;
let administratorInitialization;
const productIds = {
  prescription: "pharmacy-product-prescription",
  pickup: "pharmacy-product-pickup",
  pickupWorkflow: "pharmacy-product-pickup-flow",
  delivery: "pharmacy-product-delivery",
  coldChain: "pharmacy-product-cold-chain",
  race: "pharmacy-product-race",
  expiry: "pharmacy-product-expiry",
  callback: "pharmacy-product-callback",
  wallet: "pharmacy-product-wallet",
  walletLowBalance: "pharmacy-product-wallet-low",
  walletRace: "pharmacy-product-wallet-race",
  lots: "pharmacy-product-lots",
  expiring: "pharmacy-product-expiring",
  lotReceipt: "pharmacy-product-lot-receipt",
  reviewNoLots: "pharmacy-product-review-no-lots",
  reviewStaleStock: "pharmacy-product-review-stale-stock",
  reviewExpiredLots: "pharmacy-product-review-expired-lots",
};

function product({ price = 500, stock = 10, deliveryMode = "pickup", coldChainRequired = false, lots } = {}) {
  const inventoryLots = lots || (stock > 0 ? [{ lotNumber: "LOT-TEST-001", expirationDate: "2030-01-01", quantityReceived: stock, quantityAvailable: stock, reservedQuantity: 0, status: "ACTIVE" }] : []);
  return {
    providerUid: pharmacy.uid,
    publicationStatus: "PUBLISHED",
    active: true,
    name: "Produit de test OTC",
    dci: "Substance de test",
    dosage: "10 mg",
    pharmaceuticalForm: "Comprimé",
    therapeuticClass: "Classe thérapeutique de test",
    price,
    stock: inventoryLots.reduce((total, lot) => total + lot.quantityAvailable, 0),
    reservedStock: 0,
    lots: inventoryLots,
    regulatoryCategory: "OTC",
    prescriptionRequired: false,
    deliveryMode,
    coldChainRequired,
    deliveryZones: [{ department: "Ouest", commune: "Port-au-Prince", feeHTG: 125, etaLabel: "Le jour même" }],
  };
}

before(async () => {
  await clearFirestoreEmulator();
  [patient, otherPatient, pharmacy, otherPharmacy, administrator] = await Promise.all([
    createAuthUser("patient.one@example.test"),
    createAuthUser("patient.two@example.test"),
    createAuthUser("pharmacy.one@example.test"),
    createAuthUser("pharmacy.two@example.test"),
    createAuthUser("admin.one@example.test"),
  ]);
  firstPatientInitialization = await initializePatientAccount(patient, "Premier");
  secondPatientInitialization = await initializePatientAccount(otherPatient, "Deuxième");
  firstProfessionalInitialization = await initializeNewAccountNumber(pharmacy);
  secondProfessionalInitialization = await initializeNewAccountNumber(otherPharmacy);
  administratorInitialization = await initializeNewAccountNumber(administrator);
  const reviewNoLots = product({ stock: 0 });
  reviewNoLots.stock = 5;
  const reviewStaleStock = product({ stock: 4 });
  reviewStaleStock.stock = 0;
  const reviewExpiredLots = product({ stock: 4, lots: [
    { lotNumber: "LOT-REVIEW-EXPIRED", expirationDate: "2020-01-01", quantityReceived: 4, quantityAvailable: 4, reservedQuantity: 0, status: "ACTIVE" },
  ] });
  await Promise.all([
    db.collection("providerProfiles").doc(pharmacy.uid).set({ type: "pharmacy", status: "verified", publiclyListed: true, profile: { name: "Pharmacie de test", commune: "Port-au-Prince", department: "Ouest" } }),
    db.collection("providerProfiles").doc(otherPharmacy.uid).set({ type: "pharmacy", status: "verified", publiclyListed: true, profile: { name: "Autre pharmacie de test" } }),
    db.collection("pharmacyProducts").doc(productIds.pickup).set(product({ stock: 5 })),
    db.collection("pharmacyProducts").doc(productIds.prescription).set({ ...product({ stock: 5 }), name: "Amoxicilline", dci: "Amoxicilline", dosage: "500 mg", pharmaceuticalForm: "Capsule", regulatoryCategory: "PRESCRIPTION", prescriptionRequired: true }),
    db.collection("pharmacyProducts").doc(productIds.pickupWorkflow).set(product({ stock: 5 })),
    db.collection("pharmacyProducts").doc(productIds.delivery).set(product({ stock: 4, price: 600, deliveryMode: "both" })),
    db.collection("pharmacyProducts").doc(productIds.coldChain).set(product({ stock: 4, deliveryMode: "both", coldChainRequired: true })),
    db.collection("pharmacyProducts").doc(productIds.race).set(product({ stock: 5 })),
    db.collection("pharmacyProducts").doc(productIds.expiry).set(product({ stock: 3 })),
    db.collection("pharmacyProducts").doc(productIds.callback).set(product({ stock: 3 })),
    db.collection("pharmacyProducts").doc(productIds.wallet).set(product({ stock: 3 })),
    db.collection("pharmacyProducts").doc(productIds.walletLowBalance).set(product({ stock: 3 })),
    db.collection("pharmacyProducts").doc(productIds.walletRace).set(product({ stock: 3 })),
    db.collection("pharmacyProducts").doc(productIds.lots).set(product({ stock: 10, lots: [
      { lotNumber: "LOT-EXPIRED", expirationDate: "2020-01-01", quantityReceived: 8, quantityAvailable: 8, reservedQuantity: 0, status: "ACTIVE" },
      { lotNumber: "LOT-VALID", expirationDate: "2030-01-01", quantityReceived: 2, quantityAvailable: 2, reservedQuantity: 0, status: "ACTIVE" },
    ] })),
    db.collection("pharmacyProducts").doc(productIds.expiring).set(product({ stock: 2, lots: [
      { lotNumber: "LOT-SOON", expirationDate: new Date(Date.now() + 48 * 60 * 60_000).toISOString().slice(0, 10), quantityReceived: 2, quantityAvailable: 2, reservedQuantity: 0, status: "ACTIVE" },
    ] })),
    db.collection("pharmacyProducts").doc(productIds.lotReceipt).set(product({ stock: 5 })),
    db.collection("pharmacyProducts").doc(productIds.reviewNoLots).set(reviewNoLots),
    db.collection("pharmacyProducts").doc(productIds.reviewStaleStock).set(reviewStaleStock),
    db.collection("pharmacyProducts").doc(productIds.reviewExpiredLots).set(reviewExpiredLots),
  ]);
});

after(async () => {
  const adminApp = getApps().find((app) => app.name === "nexa-server");
  if (adminApp) await deleteApp(adminApp);
});

test("assigns an NMC patient number through the authenticated new-account API before profile completion", async () => {
  assert.deepEqual(firstPatientInitialization.created, { ok: true, patientNumber: "NMC-0000001", created: true, profileComplete: false });
  assert.deepEqual(firstPatientInitialization.completed, { ok: true, patientNumber: "NMC-0000001", created: false, profileComplete: true });
  assert.deepEqual(secondPatientInitialization.created, { ok: true, patientNumber: "NMC-0000002", created: true, profileComplete: false });
  assert.deepEqual(secondPatientInitialization.completed, { ok: true, patientNumber: "NMC-0000002", created: false, profileComplete: true });
  assert.deepEqual(firstProfessionalInitialization, { status: 200, body: { ok: true, patientNumber: "NMC-0000003", created: true, profileComplete: false } });
  assert.deepEqual(secondProfessionalInitialization, { status: 200, body: { ok: true, patientNumber: "NMC-0000004", created: true, profileComplete: false } });
  assert.deepEqual(administratorInitialization, { status: 200, body: { ok: true, patientNumber: "NMC-0000005", created: true, profileComplete: false } });
});

test("rejects anonymous checkout before creating any order", async () => {
  const result = await readResponse(await createPharmacyOrder(makeRequest("/api/pharmacy/orders", {
    method: "POST",
    body: { pharmacyId: pharmacy.uid, items: [{ productId: productIds.pickup, quantity: 1 }] },
  })));
  assert.equal(result.status, 401);
  assert.equal(result.body.code, "authentication-required");
  assert.equal((await db.collection("nexaOrders").get()).size, 0);
});

test("creates a pickup order with an atomic stock reservation and exact MonCash amount", async () => {
  const result = await createOrder(patient, productIds.pickup, { quantity: 2 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.subtotal, 1000);
  assert.equal(result.body.deliveryFee, 0);
  assert.equal(result.body.amount, 1000);
  assert.equal(result.body.transactionFee, 35);
  assert.equal(result.body.totalAmount, 1035);
  assert.equal((await productStock(productIds.pickup)).reservedStock, 2);

  const order = await db.collection("nexaOrders").doc(result.body.orderId).get();
  const payment = await db.collection("paymentIntents").doc(result.body.paymentRef).get();
  assert.equal(order.get("status"), "PENDING_PAYMENT");
  assert.deepEqual(order.get("items")[0].reservedLots, [{ lotNumber: "LOT-TEST-001", quantity: 2 }]);
  assert.equal(order.get("deliveryMethod"), "pickup");
  assert.equal(order.get("amount"), payment.get("serviceAmount"));
  assert.equal(order.get("transactionFee"), payment.get("transactionFee"));
  assert.equal(order.get("totalAmount"), payment.get("amount"));
  assert.equal(payment.get("resourcePath"), order.ref.path);
  assert.equal(payment.get("uid"), patient.uid);
  const movements = await db.collection("pharmacyStockMovements").where("orderId", "==", result.body.orderId).get();
  assert.equal(movements.size, 1);
  assert.equal(movements.docs[0].get("movementType"), "RESERVATION");
  assert.equal(movements.docs[0].get("quantity"), 2);
  assert.deepEqual(movements.docs[0].get("lotAllocations"), [{ lotNumber: "LOT-TEST-001", quantity: 2 }]);
  assert.equal(movements.docs[0].get("patientUid"), undefined);
});

test("pharmacy orders persist only an exact linked prescription medication line", async () => {
  const prescriptionPatient = await createAuthUser(`pharmacy.prescription.${Date.now()}@example.test`);
  await initializePatientAccount(prescriptionPatient, "Ordonnance");
  await db.collection("clinicalPrescriptions").doc("pharmacy_prescription_line_test").set({
    patientUid: prescriptionPatient.uid,
    status: "VALIDATED",
    expiresAt: "2030-01-01T00:00:00.000Z",
    medications: [{ name: "Amoxicilline", dosage: "500 mg", form: "Capsule", quantity: 2 }],
  });
  const wrongLine = await createOrder(prescriptionPatient, productIds.prescription, { prescriptionId: "pharmacy_prescription_line_test", prescriptionLineId: "medication-2" });
  assert.equal(wrongLine.status, 409);
  assert.equal(wrongLine.body.code, "prescription-line-mismatch");

  const created = await createOrder(prescriptionPatient, productIds.prescription, { prescriptionId: "pharmacy_prescription_line_test", prescriptionLineId: "medication-1" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const order = await db.collection("nexaOrders").doc(created.body.orderId).get();
  assert.equal(order.get("prescriptionId"), "pharmacy_prescription_line_test");
  assert.equal(order.get("items")[0].prescriptionLineId, "medication-1");
});

test("allocates checkout only from unexpired lots in FEFO order", async () => {
  const result = await createOrder(patient, productIds.lots, { quantity: 2 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const order = await db.collection("nexaOrders").doc(result.body.orderId).get();
  assert.deepEqual(order.get("items")[0].reservedLots, [{ lotNumber: "LOT-VALID", quantity: 2 }]);
  const inventory = await db.collection("pharmacyProducts").doc(productIds.lots).get();
  assert.equal(inventory.get("stock"), 2);
  assert.equal(inventory.get("reservedStock"), 2);
  assert.deepEqual(inventory.get("lots").map(({ lotNumber, reservedQuantity }) => ({ lotNumber, reservedQuantity })), [
    { lotNumber: "LOT-EXPIRED", reservedQuantity: 0 },
    { lotNumber: "LOT-VALID", reservedQuantity: 2 },
  ]);
});

test("pharmacy can receive a distinct lot without unpublishing its product", async () => {
  const first = await receiveLot(productIds.lotReceipt);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.stock, 9);
  assert.equal(first.body.lot.lotNumber, "LOT-RECEIVED-001");

  const productRef = db.collection("pharmacyProducts").doc(productIds.lotReceipt);
  const saved = await productRef.get();
  assert.equal(saved.get("publicationStatus"), "PUBLISHED");
  assert.equal(saved.get("active"), true);
  assert.equal(saved.get("lots").length, 2);
  const receipts = await db.collection("pharmacyStockMovements").where("productId", "==", productIds.lotReceipt).where("movementType", "==", "RECEIPT").get();
  assert.equal(receipts.size, 1);
  assert.equal(receipts.docs[0].get("quantity"), 4);
  assert.deepEqual(receipts.docs[0].get("lotAllocations"), [{ lotNumber: "LOT-RECEIVED-001", quantity: 4 }]);

  const duplicate = await receiveLot(productIds.lotReceipt);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, "duplicate-pharmacy-lot");
  const expired = await receiveLot(productIds.lotReceipt, { lotNumber: "LOT-EXPIRED-NEW", expirationDate: "2020-01-01", quantityReceived: 3 });
  assert.equal(expired.status, 400);
  const outsider = await receiveLot(productIds.lotReceipt, { lotNumber: "LOT-OUTSIDER", expirationDate: "2030-01-01", quantityReceived: 1 }, otherPharmacy);
  assert.equal(outsider.status, 404);
  assert.equal((await productRef.get()).get("lots").length, 2);
});

test("admin cannot publish stock without a sellable lot and recalculates stale totals", async () => {
  process.env.NEXA_ADMIN_UIDS = administrator.uid;
  const noLots = await reviewProduct(productIds.reviewNoLots);
  assert.equal(noLots.status, 409);
  assert.equal(noLots.body.code, "product-review-incomplete");

  const expiredLots = await reviewProduct(productIds.reviewExpiredLots);
  assert.equal(expiredLots.status, 409);
  assert.equal(expiredLots.body.code, "product-review-incomplete");

  const publish = await reviewProduct(productIds.reviewStaleStock);
  assert.equal(publish.status, 200, JSON.stringify(publish.body));
  const saved = await db.collection("pharmacyProducts").doc(productIds.reviewStaleStock).get();
  assert.equal(saved.get("publicationStatus"), "PUBLISHED");
  assert.equal(saved.get("active"), true);
  assert.equal(saved.get("stock"), 4);
  assert.equal(saved.get("reservedStock"), 0);

  const anonymous = await readResponse(await listAdminPharmacyStockMovements(makeRequest("/api/admin/pharmacy-stock-movements")));
  assert.equal(anonymous.status, 401);
  const denied = await readResponse(await listAdminPharmacyStockMovements(makeRequest("/api/admin/pharmacy-stock-movements", { token: patient.token })));
  assert.equal(denied.status, 403);
  const authorized = await readResponse(await listAdminPharmacyStockMovements(makeRequest("/api/admin/pharmacy-stock-movements", { token: administrator.token })));
  assert.equal(authorized.status, 200, JSON.stringify(authorized.body));
  assert.ok(authorized.body.movements.some((movement) => movement.productId === productIds.lotReceipt && movement.movementType === "RECEIPT"));
  assert.equal(authorized.body.movements.some((movement) => "patientUid" in movement), false);
});

test("rejects an invalid MonCash callback signature without marking the order paid", async () => {
  const result = await createOrder(patient, productIds.callback);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const callback = {
    paymentRef: result.body.paymentRef,
    amount: result.body.totalAmount,
    currency: "HTG",
    status: "paid",
    transactionId: `test-txn-${result.body.orderId}`,
  };
  const rejected = await readResponse(await moncashCallback(signedCallbackRequest(callback, "0".repeat(64))));
  assert.equal(rejected.status, 401);
  assert.equal(rejected.body.code, "callback-signature-invalid");
  assert.equal((await db.collection("paymentIntents").doc(result.body.paymentRef).get()).get("status"), "created");
  assert.equal((await db.collection("nexaOrders").doc(result.body.orderId).get()).get("status"), "PENDING_PAYMENT");
  assert.equal((await productStock(productIds.callback)).reservedStock, 1);
});

test("simulates paid pickup through provider workflow and consumes stock once", async () => {
  const result = await createOrder(patient, productIds.pickupWorkflow, { quantity: 2 });
  await settleOrder(result);

  for (const action of ["accept", "prepare", "ready"]) {
    const transition = await providerAction(result.body.orderId, action);
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
  }
  const wrongMode = await providerAction(result.body.orderId, "dispatch");
  assert.equal(wrongMode.status, 409);
  assert.equal((await productStock(productIds.pickupWorkflow)).stock, 5);
  assert.equal((await productStock(productIds.pickupWorkflow)).reservedStock, 2);

  const completed = await providerAction(result.body.orderId, "complete");
  assert.equal(completed.status, 200);
  const stock = await productStock(productIds.pickupWorkflow);
  assert.equal(stock.stock, 3);
  assert.equal(stock.reservedStock, 0);
  assert.equal((await db.collection("nexaOrders").doc(result.body.orderId).get()).get("status"), "COMPLETED");
  assert.equal((await db.collection("nexaOrderEvents").where("orderId", "==", result.body.orderId).get()).size, 5);
  const movements = await db.collection("pharmacyStockMovements").where("orderId", "==", result.body.orderId).get();
  assert.deepEqual(movements.docs.map((doc) => doc.get("movementType")).sort(), ["RESERVATION", "SALE"]);
  assert.equal(movements.docs.every((doc) => doc.get("patientUid") === undefined), true);
});

test("debits a wallet once when two requests pay the same order concurrently", async () => {
  const result = await createOrder(patient, productIds.wallet);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const walletRef = db.collection("nexaPatientWallets").doc(patient.uid);
  await walletRef.set({ status: "ACTIVE", currency: "HTG", availableMinor: 100_000, reservedMinor: 0 });

  const attempts = await Promise.all([
    payOrderWithWallet(result.body.orderId),
    payOrderWithWallet(result.body.orderId),
  ]);
  assert.deepEqual(attempts.map((attempt) => attempt.status), [200, 200]);
  assert.deepEqual(attempts.map((attempt) => attempt.body.alreadyPaid).sort(), [false, true]);

  const order = await db.collection("nexaOrders").doc(result.body.orderId).get();
  const payment = await db.collection("paymentIntents").doc(result.body.paymentRef).get();
  const ledger = await db.collection("nexaWalletLedger").where("resourceId", "==", result.body.orderId).get();
  assert.equal(order.get("status"), "PAID");
  assert.equal(order.get("paymentMethod"), "SMART_WALLET");
  assert.equal(payment.get("paymentMethod"), "SMART_WALLET");
  assert.equal(payment.get("walletLedgerId"), ledger.docs[0]?.id);
  assert.equal((await walletRef.get()).get("availableMinor"), 48_200);
  assert.equal(ledger.size, 1);
  assert.equal(ledger.docs[0].get("amountMinor"), 51_800);
  assert.equal(ledger.docs[0].get("transactionFeeMinor"), 1_800);

  const walletView = await readResponse(await getPatientWallet(makeRequest("/api/patient/wallet", { token: patient.token })));
  assert.equal(walletView.status, 200);
  assert.equal(walletView.body.wallet.available, 482);
  assert.equal(walletView.body.entries.length, 1);
  assert.equal(walletView.body.entries[0].amount, 518);
});

test("rejects a wallet payment below the exact balance without changing the order or ledger", async () => {
  const result = await createOrder(otherPatient, productIds.walletLowBalance);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const walletRef = db.collection("nexaPatientWallets").doc(otherPatient.uid);
  await walletRef.set({ status: "ACTIVE", currency: "HTG", availableMinor: 49_999, reservedMinor: 0 });

  const rejected = await payOrderWithWallet(result.body.orderId, otherPatient);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, "insufficient-wallet-balance");
  assert.equal((await walletRef.get()).get("availableMinor"), 49_999);
  assert.equal((await db.collection("nexaOrders").doc(result.body.orderId).get()).get("status"), "PENDING_PAYMENT");
  assert.equal((await db.collection("paymentIntents").doc(result.body.paymentRef).get()).get("status"), "created");
  assert.equal((await db.collection("nexaWalletLedger").where("resourceId", "==", result.body.orderId).get()).size, 0);
});

test("settles appointment wallet payments once and leaves insufficient payments untouched", async () => {
  const first = await seedAppointmentWalletPayment({
    appointmentId: "appointment-wallet-payment-001",
    owner: patient,
    paymentRef: "appointmentWalletPaymentRef0001",
    slotId: "a".repeat(32),
  });
  const denied = await payAppointmentFromWallet("appointment-wallet-payment-001", otherPatient);
  assert.equal(denied.status, 404);
  const attempts = await Promise.all([
    payAppointmentFromWallet("appointment-wallet-payment-001"),
    payAppointmentFromWallet("appointment-wallet-payment-001"),
  ]);
  assert.deepEqual(attempts.map((attempt) => attempt.status), [200, 200]);
  assert.deepEqual(attempts.map((attempt) => attempt.body.alreadyPaid).sort(), [false, true]);
  assert.equal((await first.walletRef.get()).get("availableMinor"), 0);
  assert.equal((await first.appointmentRef.get()).get("status"), "CONFIRMED");
  assert.equal((await db.collection("providerAvailabilitySlots").doc("a".repeat(32)).get()).get("status"), "booked");
  assert.equal((await db.collection("nexaWalletLedger").where("resourceId", "==", "appointment-wallet-payment-001").get()).size, 1);

  const second = await seedAppointmentWalletPayment({
    appointmentId: "appointment-wallet-payment-002",
    owner: otherPatient,
    paymentRef: "appointmentWalletPaymentRef0002",
    slotId: "b".repeat(32),
  });
  await second.walletRef.update({ availableMinor: 50_000 });
  const insufficient = await payAppointmentFromWallet("appointment-wallet-payment-002", otherPatient);
  assert.equal(insufficient.status, 409);
  assert.equal(insufficient.body.code, "insufficient-wallet-balance");
  assert.equal((await second.walletRef.get()).get("availableMinor"), 50_000);
  assert.equal((await second.appointmentRef.get()).get("status"), "PENDING_PAYMENT");
  assert.equal((await db.collection("paymentIntents").doc("appointmentWalletPaymentRef0002").get()).get("status"), "created");
  assert.equal((await db.collection("providerAvailabilitySlots").doc("b".repeat(32)).get()).get("status"), "held");
  assert.equal((await db.collection("nexaWalletLedger").where("resourceId", "==", "appointment-wallet-payment-002").get()).size, 0);
});

test("limits delivery addresses to the owning patient and assigned pharmacy", async () => {
  const deliveryAddress = {
    recipientName: "Patiente de test",
    phone: "+509 3700-0000",
    department: "Ouest",
    commune: "Port-au-Prince",
    addressLine: "Adresse fictive de test, Rue 1",
    instructions: "Appeler à l’arrivée",
  };
  const result = await createOrder(patient, productIds.delivery, { deliveryMethod: "delivery", deliveryAddress });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.subtotal, 600);
  assert.equal(result.body.deliveryFee, 125);
  assert.equal(result.body.amount, 725);
  assert.equal(result.body.transactionFee, 25);
  assert.equal(result.body.totalAmount, 750);
  await settleOrder(result);

  const patientView = await readResponse(await getPatientOrders(makeRequest("/api/patient/orders", { token: patient.token })));
  const ownOrder = patientView.body.orders.find((order) => order.id === result.body.orderId);
  assert.equal(patientView.status, 200);
  assert.equal(ownOrder.deliveryAddress.addressLine, deliveryAddress.addressLine);

  const otherPatientView = await readResponse(await getPatientOrders(makeRequest("/api/patient/orders", { token: otherPatient.token })));
  assert.equal(otherPatientView.status, 200);
  assert.equal(otherPatientView.body.orders.some((order) => order.id === result.body.orderId), false);

  const providerView = await readResponse(await getProviderOrders(makeRequest("/api/provider/pharmacy-orders", { token: pharmacy.token })));
  const pharmacyOrder = providerView.body.orders.find((order) => order.id === result.body.orderId);
  assert.equal(providerView.status, 200);
  assert.equal(pharmacyOrder.deliveryAddress.addressLine, deliveryAddress.addressLine);

  const otherProviderView = await readResponse(await getProviderOrders(makeRequest("/api/provider/pharmacy-orders", { token: otherPharmacy.token })));
  assert.equal(otherProviderView.status, 200);
  assert.equal(otherProviderView.body.orders.some((order) => order.id === result.body.orderId), false);
  const otherProviderAction = await providerAction(result.body.orderId, "accept", {}, otherPharmacy);
  assert.equal(otherProviderAction.status, 404);

  for (const action of ["accept", "prepare", "ready", "dispatch"]) {
    const transition = await providerAction(result.body.orderId, action);
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
  }
  const missingProof = await providerAction(result.body.orderId, "deliver");
  assert.equal(missingProof.status, 400);
  assert.equal(missingProof.body.code, "delivery-proof-required");
  assert.deepEqual(await productStock(productIds.delivery), { stock: 4, reservedStock: 1 });

  const delivered = await providerAction(result.body.orderId, "deliver", { deliveryProofReference: "receipt-test-001" });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  const finalOrder = await db.collection("nexaOrders").doc(result.body.orderId).get();
  assert.equal(finalOrder.get("status"), "DELIVERED");
  assert.equal(finalOrder.get("deliveryProofReference"), "receipt-test-001");
  assert.deepEqual(await productStock(productIds.delivery), { stock: 3, reservedStock: 0 });
  assert.equal((await db.collection("nexaOrderEvents").where("orderId", "==", result.body.orderId).get()).size, 6);
});

test("keeps pharmacy delivery closed by default and stores no address", async () => {
  const previousValue = process.env.NEXA_PHARMACY_DELIVERY_ENABLED;
  const deliveryTestUser = await createAuthUser("delivery-disabled@example.test");
  delete process.env.NEXA_PHARMACY_DELIVERY_ENABLED;
  const existingOrders = await db.collection("nexaOrders").get();
  const deliveryAddress = {
    recipientName: "Adresse test non persistée",
    phone: "+509 3700-0000",
    department: "Ouest",
    commune: "Port-au-Prince",
    addressLine: "Adresse fictive de test",
  };

  try {
    const result = await createOrder(deliveryTestUser, productIds.delivery, { deliveryMethod: "delivery", deliveryAddress });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "delivery-not-available");
    assert.equal((await db.collection("nexaOrders").get()).size, existingOrders.size);
    assert.equal((await productStock(productIds.delivery)).reservedStock, 0);
    assert.equal((await db.collection("nexaOrders").where("deliveryAddress.recipientName", "==", deliveryAddress.recipientName).get()).size, 0);
  } finally {
    if (previousValue === undefined) delete process.env.NEXA_PHARMACY_DELIVERY_ENABLED;
    else process.env.NEXA_PHARMACY_DELIVERY_ENABLED = previousValue;
  }
});

test("requires an active delivery zone and rejects cold-chain delivery without reserving stock", async () => {
  const zoneMismatch = await createOrder(patient, productIds.delivery, {
    deliveryMethod: "delivery",
    deliveryAddress: { recipientName: "Test", phone: "+509 3700-0000", department: "Nord", commune: "Cap-Haïtien", addressLine: "Rue fictive" },
  });
  assert.equal(zoneMismatch.status, 409);
  assert.equal(zoneMismatch.body.code, "delivery-zone-unavailable");

  const coldChain = await createOrder(patient, productIds.coldChain, {
    deliveryMethod: "delivery",
    deliveryAddress: { recipientName: "Test", phone: "+509 3700-0000", department: "Ouest", commune: "Port-au-Prince", addressLine: "Rue fictive" },
  });
  assert.equal(coldChain.status, 409);
  assert.equal(coldChain.body.code, "home-delivery-unavailable");
  assert.equal((await productStock(productIds.delivery)).reservedStock, 0);
  assert.equal((await productStock(productIds.coldChain)).reservedStock, 0);
});

test("rejects concurrent checkout that would oversell reserved stock", async () => {
  const attempts = await Promise.all([
    createOrder(otherPatient, productIds.race, { quantity: 4 }),
    createOrder(otherPatient, productIds.race, { quantity: 4 }),
  ]);
  assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [200, 409]);
  const successful = attempts.find((attempt) => attempt.status === 200);
  const rejected = attempts.find((attempt) => attempt.status === 409);
  assert.equal(rejected.body.code, "insufficient-stock");
  assert.equal((await productStock(productIds.race)).reservedStock, 4);
  assert.equal((await db.collection("nexaOrders").where("providerUid", "==", pharmacy.uid).get()).docs.filter((doc) => doc.get("items")?.[0]?.productId === productIds.race).length, 1);
  assert.ok(successful.body.orderId);
});

test("expires an unpaid hold once and releases its reserved stock", async () => {
  const result = await createOrder(otherPatient, productIds.expiry);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const expiryProduct = db.collection("pharmacyProducts").doc(productIds.expiry);
  const expirySnapshot = await expiryProduct.get();
  await expiryProduct.update({ lots: expirySnapshot.get("lots").map((lot) => ({ ...lot, expirationDate: "2020-01-01" })) });
  await db.collection("nexaOrders").doc(result.body.orderId).update({ holdExpiresAt: 0 });

  const request = () => new Request("http://localhost:3000/api/cron/expire-pharmacy-order-holds", {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  const first = await readResponse(await expirePharmacyHolds(request()));
  const second = await readResponse(await expirePharmacyHolds(request()));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.scanned, 1);
  assert.equal(first.body.released, 1);
  assert.equal(second.body.scanned, 0);

  const order = await db.collection("nexaOrders").doc(result.body.orderId).get();
  const payment = await db.collection("paymentIntents").doc(result.body.paymentRef).get();
  assert.equal(order.get("status"), "PAYMENT_EXPIRED");
  assert.equal(order.get("paymentStatus"), "EXPIRED");
  assert.equal(payment.get("status"), "expired");
  assert.deepEqual(await productStock(productIds.expiry), { stock: 0, reservedStock: 0 });
  const expiredLot = (await expiryProduct.get()).get("lots")[0];
  assert.equal(expiredLot.quantityAvailable, 3);
  assert.equal(expiredLot.reservedQuantity, 0);
  assert.equal((await db.collection("nexaOrderEvents").where("orderId", "==", result.body.orderId).get()).size, 1);
  const movements = await db.collection("pharmacyStockMovements").where("orderId", "==", result.body.orderId).get();
  assert.deepEqual(movements.docs.map((doc) => doc.get("movementType")).sort(), ["RELEASE", "RESERVATION"]);
});

test("blocks fulfillment when a reserved lot expires after checkout", async () => {
  const result = await createOrder(otherPatient, productIds.expiring);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  await settleOrder(result);
  for (const action of ["accept", "prepare", "ready"]) assert.equal((await providerAction(result.body.orderId, action)).status, 200);
  const expiringProduct = db.collection("pharmacyProducts").doc(productIds.expiring);
  const expiringSnapshot = await expiringProduct.get();
  await expiringProduct.update({ lots: expiringSnapshot.get("lots").map((lot) => ({ ...lot, expirationDate: "2020-01-01" })) });

  const blocked = await providerAction(result.body.orderId, "complete");
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "order-stock-reservation-invalid");
  assert.equal((await db.collection("nexaOrders").doc(result.body.orderId).get()).get("status"), "READY");
  assert.deepEqual(await productStock(productIds.expiring), { stock: 2, reservedStock: 1 });
});
