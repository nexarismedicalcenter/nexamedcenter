import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHash } from "node:crypto";
import { deleteApp, getApps } from "firebase-admin/app";

process.env.NODE_ENV = "test";
process.env.FIREBASE_PROJECT_ID = "demo-nexaris";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";

const projectId = "demo-nexaris";
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || "";
const emulatorHostname = emulatorHost ? new URL(`http://${emulatorHost}`).hostname : "";
if (!emulatorHost || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(emulatorHostname)) {
  throw new Error("Refusing to run settlement tests without a local Firestore emulator.");
}

const [{ getFirebaseAdminDb }, { createPaymentIntentForResource }, { settlePaidNexaOrderPayment }] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/lib/payments/intents.server.ts"),
  import("../src/lib/payments/settlement.server.ts"),
]);
const db = getFirebaseAdminDb();

async function clearFirestoreEmulator() {
  const response = await fetch(
    `http://${emulatorHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(response.ok, true, "Firestore emulator must be available and clearable.");
}

function orderDocument(paymentRef, overrides = {}) {
  return {
    patientUid: "patient-one",
    providerUid: "provider-one",
    kind: "pharmacy",
    status: "PENDING_PAYMENT",
    paymentStatus: "PENDING",
    amount: 1250,
    currency: "HTG",
    moncashPaymentRef: paymentRef,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

async function createPaidOrder({ orderId, paymentRef, order = {}, payment = {} }) {
  await db.collection("nexaOrders").doc(orderId).set(orderDocument(paymentRef, order));
  await db.collection("paymentIntents").doc(paymentRef).set({
    uid: "patient-one",
    paymentMethod: "MONCASH",
    resourceType: "pharmacy-order",
    resourcePath: `nexaOrders/${orderId}`,
    amount: 1250,
    currency: "HTG",
    status: "paid",
    ...payment,
  });
}

function notificationId(uid, eventKey) {
  return createHash("sha256").update(`${uid}:${eventKey}`).digest("hex");
}

before(clearFirestoreEmulator);
after(async () => {
  const adminApp = getApps().find((app) => app.name === "nexa-server");
  if (adminApp) await deleteApp(adminApp);
});

test("creates a MonCash intent idempotently for its verified owner", async () => {
  const resourceRef = db.collection("nexaOrders").doc("intent-order");
  await resourceRef.set({ patientUid: "patient-one", kind: "pharmacy", amount: 1250, currency: "HTG" });

  const first = await createPaymentIntentForResource({
    ownerUid: "patient-one",
    resourceType: "pharmacy-order",
    resourceRef,
    amount: 1250,
  });
  const retry = await createPaymentIntentForResource({
    ownerUid: "patient-one",
    resourceType: "pharmacy-order",
    resourceRef,
    amount: 1250,
  });

  assert.match(first.paymentRef, /^[A-Za-z0-9_-]{20,64}$/);
  assert.deepEqual(retry, first);
  assert.equal((await db.collection("paymentIntents").get()).size, 1);
  assert.equal((await resourceRef.get()).get("moncashPaymentRef"), first.paymentRef);
});

test("rejects an invalid amount and an owner mismatch before issuing an intent", async () => {
  const resourceRef = db.collection("nexaOrders").doc("protected-order");
  await resourceRef.set({ patientUid: "patient-one", kind: "pharmacy", amount: 1250, currency: "HTG" });

  await assert.rejects(
    createPaymentIntentForResource({ ownerUid: "patient-one", resourceType: "pharmacy-order", resourceRef, amount: 0 }),
    (error) => error.code === "invalid-amount",
  );
  await assert.rejects(
    createPaymentIntentForResource({ ownerUid: "patient-two", resourceType: "pharmacy-order", resourceRef, amount: 1250 }),
    (error) => error.code === "resource-owner-mismatch",
  );
  assert.equal((await db.collection("paymentIntents").where("resourcePath", "==", resourceRef.path).get()).size, 0);
});

test("settles a paid order once and creates one event and one notification per participant", async () => {
  const orderId = "settled-order";
  const paymentRef = "paid-order-reference-0000001";
  await createPaidOrder({ orderId, paymentRef });

  await settlePaidNexaOrderPayment(paymentRef);
  await settlePaidNexaOrderPayment(paymentRef);

  const order = await db.collection("nexaOrders").doc(orderId).get();
  const events = await db.collection("nexaOrderEvents").where("orderId", "==", orderId).get();
  assert.equal(order.get("status"), "PAID");
  assert.equal(order.get("paymentStatus"), "PAID");
  assert.equal(order.get("settlementStatus"), "CONFIRMED");
  assert.equal(events.size, 1);
  assert.equal((await db.collection("userNotifications").doc(notificationId("patient-one", `order:payment:${paymentRef}`)).get()).exists, true);
  assert.equal((await db.collection("userNotifications").doc(notificationId("provider-one", `order:payment:${paymentRef}`)).get()).exists, true);
  assert.equal((await db.collection("paymentSettlementAlerts").get()).size, 0);
});

test("holds an inconsistent paid order for reconciliation and keeps one alert across retries", async () => {
  const orderId = "mismatched-order";
  const paymentRef = "paid-order-reference-0000002";
  await createPaidOrder({ orderId, paymentRef, order: { amount: 1350 } });

  await settlePaidNexaOrderPayment(paymentRef);
  await settlePaidNexaOrderPayment(paymentRef);

  const order = await db.collection("nexaOrders").doc(orderId).get();
  const alert = await db.collection("paymentSettlementAlerts").doc(`order_${paymentRef}`).get();
  assert.equal(order.get("paymentStatus"), "PAID");
  assert.equal(order.get("settlementStatus"), "REVIEW_REQUIRED");
  assert.equal(order.get("status"), "PENDING_PAYMENT");
  assert.equal(alert.get("reason"), "ORDER_PAYMENT_MISMATCH");
  assert.equal(alert.get("status"), "open");
  assert.equal((await db.collection("paymentSettlementAlerts").get()).size, 1);
  assert.equal((await db.collection("nexaOrderEvents").where("orderId", "==", orderId).get()).size, 0);
});

test("does not settle an intent until the trusted payment state is paid", async () => {
  const orderId = "unpaid-order";
  const paymentRef = "pending-order-reference-000001";
  await createPaidOrder({ orderId, paymentRef, payment: { status: "pending" } });

  await settlePaidNexaOrderPayment(paymentRef);

  const order = await db.collection("nexaOrders").doc(orderId).get();
  assert.equal(order.get("status"), "PENDING_PAYMENT");
  assert.equal(order.get("paymentStatus"), "PENDING");
  assert.equal((await db.collection("paymentSettlementAlerts").doc(`order_${paymentRef}`).get()).exists, false);
  assert.equal((await db.collection("userNotifications").doc(notificationId("patient-one", `order:payment:${paymentRef}`)).get()).exists, false);
});
