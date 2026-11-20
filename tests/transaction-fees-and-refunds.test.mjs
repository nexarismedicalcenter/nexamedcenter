import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { deleteApp, getApps } from "firebase-admin/app";

process.env.NODE_ENV = "test";
process.env.FIREBASE_PROJECT_ID = "demo-nexaris";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||= "demo-api-key";

const projectId = "demo-nexaris";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || "";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "";
const isLocal = (value) => value && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${value.replace(/^https?:\/\//, "")}`).hostname);
if (!isLocal(authHost) || !isLocal(firestoreHost)) {
  throw new Error("Refusing transaction-fee and refund tests without local Auth and Firestore emulators.");
}

const [
  { getFirebaseAdminDb },
  { calculateTransactionAmounts, nexaOrderPaymentMatches },
  { POST: payAppointmentWithWallet },
  { POST: payOrderWithWallet },
  { POST: requestCashRefund },
  { GET: listAdminRefunds, POST: processWalletRefund },
  { GET: listSettlementAlerts, POST: resolveSettlementAlert },
  { settlePaidAppointmentPayment, settlePaidNexaOrderPayment },
] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/lib/payments/transaction-fees.server.ts"),
  import("../src/app/api/appointments/[appointmentId]/pay-wallet/route.ts"),
  import("../src/app/api/patient/orders/[orderId]/pay-wallet/route.ts"),
  import("../src/app/api/patient/refunds/cash/route.ts"),
  import("../src/app/api/admin/refunds/route.ts"),
  import("../src/app/api/admin/payment-settlement-alerts/route.ts"),
  import("../src/lib/payments/settlement.server.ts"),
]);
const db = getFirebaseAdminDb();
const authBaseUrl = new URL(authHost.includes("://") ? authHost : `http://${authHost}`).origin;
let userSequence = 0;

async function clearFirestoreEmulator() {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true, "Firestore emulator must be available and clearable.");
}

async function createAuthUser(prefix) {
  userSequence += 1;
  const email = `${prefix}.${Date.now()}.${userSequence}@example.test`;
  const response = await fetch(`${authBaseUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(process.env.NEXT_PUBLIC_FIREBASE_API_KEY)}`, {
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
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function readResponse(response) {
  return { status: response.status, body: await response.json() };
}

async function createPaidAppointment({ patientUid, appointmentId, paymentRef, paymentMethod = "MONCASH" }) {
  const slotId = "a".repeat(32);
  const holdExpiresAt = Date.now() + 20 * 60_000;
  await db.collection("appointments").doc(appointmentId).set({
    patientUid,
    providerUid: "provider-synthetic-nexa",
    providerType: "doctor",
    providerName: "Professionnel synthétique",
    slotId,
    startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    endsAt: new Date(Date.now() + 90 * 60_000).toISOString(),
    status: "PENDING_PAYMENT",
    paymentStatus: paymentMethod === "SMART_WALLET" ? "PENDING" : "PAID",
    amount: 5000,
    transactionFee: 175,
    transactionFeeRateBps: 350,
    totalAmount: 5175,
    currency: "HTG",
    moncashPaymentRef: paymentRef,
    refundRequired: false,
    holdExpiresAt,
  });
  await db.collection("paymentIntents").doc(paymentRef).set({
    uid: patientUid,
    paymentMethod,
    resourceType: "appointment",
    resourcePath: `appointments/${appointmentId}`,
    amount: 5175,
    serviceAmount: 5000,
    transactionFee: 175,
    currency: "HTG",
    status: paymentMethod === "SMART_WALLET" ? "created" : "paid",
  });
  await db.collection("providerAvailabilitySlots").doc(slotId).set({
    providerUid: "provider-synthetic-nexa",
    patientUid,
    appointmentId,
    status: "held",
    holdExpiresAt,
    startsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    endsAt: new Date(Date.now() + 90 * 60_000).toISOString(),
  });
  return { slotId, holdExpiresAt };
}

async function createRefusedOrder({ patientUid, orderId, kind, paymentRef, amount, transactionFee = 0, paymentMethod = "MONCASH" }) {
  const resourceType = kind === "pharmacy" ? "pharmacy-order" : kind === "laboratory" ? "laboratory-order" : "imaging-order";
  const totalAmount = amount + transactionFee;
  await db.collection("nexaOrders").doc(orderId).set({
    patientUid,
    providerUid: `provider-${kind}-synthetic`,
    providerName: `Centre ${kind} synthétique`,
    kind,
    amount,
    transactionFee,
    transactionFeeRateBps: transactionFee ? 350 : 0,
    transactionFeeRecipient: "NEXARIS",
    totalAmount,
    currency: "HTG",
    status: "PROVIDER_REFUSED",
    paymentStatus: "PAID",
    paymentMethod,
    settlementStatus: "CONFIRMED",
    refundRequired: true,
    refundStatus: "PENDING_REVIEW",
    refusalReason: "ORDER_REFUSED_BY_PROVIDER",
    moncashPaymentRef: paymentRef,
  });
  await db.collection("paymentIntents").doc(paymentRef).set({
    uid: patientUid,
    paymentMethod,
    resourceType,
    resourcePath: `nexaOrders/${orderId}`,
    amount: totalAmount,
    serviceAmount: amount,
    transactionFee,
    transactionFeeRateBps: transactionFee ? 350 : 0,
    feeRecipient: "NEXARIS",
    currency: "HTG",
    status: "paid",
  });
  if (transactionFee > 0) await db.collection("nexaTransactionFeeLedger").doc(paymentRef).set({
    paymentRef,
    resourceType,
    resourceId: orderId,
    serviceAmountMinor: amount * 100,
    amountMinor: transactionFee * 100,
    currency: "HTG",
    recipient: "NEXARIS",
    transactionFeeRateBps: 350,
    paymentMethod: paymentMethod === "SMART_WALLET" ? "SMART_WALLET" : "MONCASH",
    status: "COMPLETED",
  });
  const alertId = `alert_refund_${kind}_${orderId}`;
  await db.collection("paymentSettlementAlerts").doc(alertId).set({
    resourceType,
    resourceId: orderId,
    paymentRef,
    reason: `${kind.toUpperCase()}_PROVIDER_REFUSED_AFTER_PAYMENT`,
    status: "open",
    createdAt: new Date(),
  });
  return { resourceType, orderId, paymentRef, alertId };
}

before(clearFirestoreEmulator);
beforeEach(async () => {
  await clearFirestoreEmulator();
  delete process.env.NEXA_ADMIN_UIDS;
});

after(async () => {
  const adminApp = getApps().find((app) => app.name === "nexa-server");
  if (adminApp) await deleteApp(adminApp);
});

test("the 3.5 percent transaction fee preserves the service base and checks each order payment total", () => {
  assert.deepEqual(calculateTransactionAmounts(5000, { active: true, rateBps: 350 }), {
    serviceAmount: 5000,
    feeAmount: 175,
    totalAmount: 5175,
    feeRateBps: 350,
    feeRecipient: "NEXARIS",
  });
  const order = { amount: 5000, transactionFee: 175, totalAmount: 5175 };
  assert.equal(nexaOrderPaymentMatches(order, {
    amount: 5175, serviceAmount: 5000, transactionFee: 175,
  }), true);
  assert.equal(nexaOrderPaymentMatches(order, {
    amount: 5000, serviceAmount: 5000, transactionFee: 0,
  }), false);
});

test("NEXA Wallet charges a pharmacy order total and records the separate NEXARIS fee", async () => {
  const patient = await createAuthUser("patient-wallet-order-fee");
  const orderId = "pharmacy_wallet_fee_order_0001";
  const paymentRef = "wallet-pharmacy-payment-ref-0001";
  await db.collection("patientProfiles").doc(patient.uid).set({ role: "patient", profileComplete: true });
  await db.collection("nexaPatientWallets").doc(patient.uid).set({ currency: "HTG", status: "ACTIVE", availableMinor: 700000, reservedMinor: 0 });
  await db.collection("nexaOrders").doc(orderId).set({
    kind: "pharmacy", patientUid: patient.uid, providerUid: "pharmacy-synthetic-nexa", amount: 5000,
    transactionFee: 175, transactionFeeRateBps: 350, transactionFeeRecipient: "NEXARIS", totalAmount: 5175,
    currency: "HTG", status: "PENDING_PAYMENT", paymentStatus: "PENDING", settlementStatus: "PENDING",
    holdExpiresAt: Date.now() + 20 * 60_000, moncashPaymentRef: paymentRef,
  });
  await db.collection("paymentIntents").doc(paymentRef).set({
    uid: patient.uid, paymentMethod: "MONCASH", resourceType: "pharmacy-order", resourcePath: `nexaOrders/${orderId}`,
    amount: 5175, serviceAmount: 5000, transactionFee: 175, transactionFeeRateBps: 350,
    feeRecipient: "NEXARIS", currency: "HTG", status: "created",
  });

  const response = await readResponse(await payOrderWithWallet(makeRequest(patient, `/api/patient/orders/${orderId}/pay-wallet`, "POST", {}), { params: Promise.resolve({ orderId }) }));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.amount, 5000);
  assert.equal(response.body.transactionFee, 175);
  assert.equal(response.body.totalAmount, 5175);
  assert.equal((await db.collection("nexaPatientWallets").doc(patient.uid).get()).get("availableMinor"), 182500);
  const feeLedger = await db.collection("nexaTransactionFeeLedger").doc(paymentRef).get();
  assert.equal(feeLedger.get("amountMinor"), 17500);
  assert.equal(feeLedger.get("serviceAmountMinor"), 500000);
  assert.equal(feeLedger.get("recipient"), "NEXARIS");
  assert.equal(feeLedger.get("paymentMethod"), "SMART_WALLET");
  const walletLedger = await db.collection("nexaWalletLedger").get();
  assert.equal(walletLedger.docs[0].get("amountMinor"), 517500);
  assert.equal(walletLedger.docs[0].get("transactionFeeMinor"), 17500);
});

test("MonCash settlement records the order transaction fee once", async () => {
  const patient = await createAuthUser("patient-moncash-order-fee");
  const orderId = "laboratory_moncash_fee_order_0001";
  const paymentRef = "moncash-laboratory-payment-ref-0001";
  await db.collection("nexaOrders").doc(orderId).set({
    kind: "laboratory", patientUid: patient.uid, providerUid: "laboratory-synthetic-nexa", amount: 5000,
    transactionFee: 175, transactionFeeRateBps: 350, transactionFeeRecipient: "NEXARIS", totalAmount: 5175,
    currency: "HTG", status: "PENDING_PAYMENT", paymentStatus: "PENDING", settlementStatus: "PENDING",
    holdExpiresAt: Date.now() + 20 * 60_000, moncashPaymentRef: paymentRef,
  });
  await db.collection("paymentIntents").doc(paymentRef).set({
    uid: patient.uid, paymentMethod: "MONCASH", resourceType: "laboratory-order", resourcePath: `nexaOrders/${orderId}`,
    amount: 5175, serviceAmount: 5000, transactionFee: 175, transactionFeeRateBps: 350,
    feeRecipient: "NEXARIS", currency: "HTG", status: "paid",
  });

  await settlePaidNexaOrderPayment(paymentRef);
  await settlePaidNexaOrderPayment(paymentRef);
  const feeLedger = await db.collection("nexaTransactionFeeLedger").doc(paymentRef).get();
  const order = await db.collection("nexaOrders").doc(orderId).get();
  assert.equal(feeLedger.get("amountMinor"), 17500);
  assert.equal(feeLedger.get("recipient"), "NEXARIS");
  assert.equal(feeLedger.get("paymentMethod"), "MONCASH");
  assert.equal(order.get("status"), "PAID");
  assert.equal(order.get("settlementStatus"), "CONFIRMED");
  assert.equal((await db.collection("nexaTransactionFeeLedger").get()).size, 1);
});

test("NEXA Wallet charges the total, then the default Wallet refund returns only the service amount", async () => {
  const patient = await createAuthUser("patient-wallet-fee");
  const admin = await createAuthUser("admin-wallet-refund");
  process.env.NEXA_ADMIN_UIDS = admin.uid;
  const appointmentId = "appointment_wallet_fee_0001";
  const paymentRef = "wallet-appointment-payment-ref-0001";
  await createPaidAppointment({ patientUid: patient.uid, appointmentId, paymentRef, paymentMethod: "SMART_WALLET" });
  await db.collection("patientProfiles").doc(patient.uid).set({ role: "patient", profileComplete: true });
  await db.collection("nexaPatientWallets").doc(patient.uid).set({ currency: "HTG", status: "ACTIVE", availableMinor: 700000, reservedMinor: 0 });
  await db.collection("paymentIntents").doc(paymentRef).set({ status: "created", paymentMethod: "MONCASH" }, { merge: true });

  const payment = await readResponse(await payAppointmentWithWallet(makeRequest(patient, `/api/appointments/${appointmentId}/pay-wallet`, "POST", {}), { params: Promise.resolve({ appointmentId }) }));
  assert.equal(payment.status, 200, JSON.stringify(payment.body));
  assert.equal(payment.body.amount, 5000);
  assert.equal(payment.body.transactionFee, 175);
  assert.equal(payment.body.totalAmount, 5175);
  assert.equal((await db.collection("nexaPatientWallets").doc(patient.uid).get()).get("availableMinor"), 182500);
  const feeLedger = await db.collection("nexaTransactionFeeLedger").doc(paymentRef).get();
  assert.equal(feeLedger.get("amountMinor"), 17500);
  assert.equal(feeLedger.get("recipient"), "NEXARIS");
  assert.equal(feeLedger.get("paymentMethod"), "SMART_WALLET");

  await db.collection("appointments").doc(appointmentId).set({
    status: "PAYMENT_CONFLICT_REFUND_REQUIRED",
    paymentStatus: "PAID",
    refundRequired: true,
    refundStatus: "MANUAL_REVIEW_REQUIRED",
  }, { merge: true });
  await db.collection("paymentSettlementAlerts").doc(`patient_cancel_${appointmentId}`).set({
    resourceType: "appointment", resourceId: appointmentId, reason: "PATIENT_CANCELLATION_REFUND_REVIEW_REQUIRED", status: "open",
  });

  const queue = await readResponse(await listAdminRefunds(makeRequest(admin, "/api/admin/refunds")));
  assert.equal(queue.status, 200, JSON.stringify(queue.body));
  assert.equal(queue.body.refunds[0].amount, 5000);
  const refund = await readResponse(await processWalletRefund(makeRequest(admin, "/api/admin/refunds", "POST", {
    resourceType: "appointment", resourceId: appointmentId, confirmNoExternalRefund: true,
  })));
  assert.equal(refund.status, 200, JSON.stringify(refund.body));
  const wallet = await db.collection("nexaPatientWallets").doc(patient.uid).get();
  assert.equal(wallet.get("availableMinor"), 682500);
  const refundLedgerId = refund.body.refundLedgerId;
  const refundLedger = await db.collection("nexaRefundLedger").doc(refundLedgerId).get();
  assert.equal(refundLedger.get("amountMinor"), 500000);
  assert.equal(refundLedger.get("nonRefundableTransactionFeeMinor"), 17500);
  assert.equal(refundLedger.get("refundMethod"), "NEXA_WALLET");
  assert.equal((await db.collection("nexaTransactionFeeLedger").doc(paymentRef).get()).get("amountMinor"), 17500);
});

test("pharmacy, laboratory, and imaging orders support Wallet or requested manual cash refunds", async () => {
  const patient = await createAuthUser("patient-diagnostic-refund");
  const admin = await createAuthUser("admin-diagnostic-refund");
  process.env.NEXA_ADMIN_UIDS = admin.uid;
  await db.collection("patientProfiles").doc(patient.uid).set({ role: "patient", profileComplete: true });
  await db.collection("nexaPatientWallets").doc(patient.uid).set({ currency: "HTG", status: "ACTIVE", availableMinor: 0, reservedMinor: 0 });

  const pharmacy = await createRefusedOrder({
    patientUid: patient.uid, orderId: "refund_pharmacy_order_0001", kind: "pharmacy", paymentRef: "refund-pharmacy-payment-ref-0001", amount: 1500, transactionFee: 53, paymentMethod: "SMART_WALLET",
  });
  const laboratory = await createRefusedOrder({
    patientUid: patient.uid, orderId: "refund_laboratory_order_0001", kind: "laboratory", paymentRef: "refund-laboratory-payment-ref-0001", amount: 2250, transactionFee: 79,
  });
  const laboratoryWallet = await createRefusedOrder({
    patientUid: patient.uid, orderId: "refund_laboratory_wallet_0001", kind: "laboratory", paymentRef: "refund-laboratory-wallet-ref-0001", amount: 2000, transactionFee: 70, paymentMethod: "SMART_WALLET",
  });
  const imaging = await createRefusedOrder({
    patientUid: patient.uid, orderId: "refund_imaging_order_0001", kind: "imaging", paymentRef: "refund-imaging-payment-ref-0001", amount: 3250, transactionFee: 114,
  });

  const initialQueue = await readResponse(await listAdminRefunds(makeRequest(admin, "/api/admin/refunds")));
  assert.equal(initialQueue.status, 200, JSON.stringify(initialQueue.body));
  assert.deepEqual(new Set(initialQueue.body.refunds.map((item) => item.resourceType)), new Set(["pharmacy-order", "laboratory-order", "imaging-order"]));

  for (const order of [pharmacy, laboratoryWallet, imaging]) {
    const result = await readResponse(await processWalletRefund(makeRequest(admin, "/api/admin/refunds", "POST", {
      resourceType: order.resourceType, resourceId: order.orderId, confirmNoExternalRefund: true,
    })));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const source = await db.collection("nexaOrders").doc(order.orderId).get();
    assert.equal(source.get("refundMethod"), "NEXA_WALLET");
    assert.equal(source.get("refundedAmount"), order === pharmacy ? 1500 : order === imaging ? 3250 : 2000);
    assert.equal(source.get("nonRefundableTransactionFee"), order === pharmacy ? 53 : order === imaging ? 114 : 70);
  }
  const pharmacyRefund = (await db.collection("nexaRefundLedger").get()).docs.find((doc) => doc.get("resourceId") === pharmacy.orderId);
  assert.equal(pharmacyRefund?.get("nonRefundableTransactionFeeMinor"), 5300);

  const cashRequest = await readResponse(await requestCashRefund(makeRequest(patient, "/api/patient/refunds/cash", "POST", {
    resourceType: laboratory.resourceType, resourceId: laboratory.orderId,
  })));
  assert.equal(cashRequest.status, 200, JSON.stringify(cashRequest.body));
  assert.equal(cashRequest.body.requestedRefundMethod, "CASH_MANUAL");
  const queueAfterCashRequest = await readResponse(await listAdminRefunds(makeRequest(admin, "/api/admin/refunds")));
  assert.equal(queueAfterCashRequest.body.refunds.some((item) => item.resourceId === laboratory.orderId), false);

  const resolved = await readResponse(await resolveSettlementAlert(makeRequest(admin, "/api/admin/payment-settlement-alerts", "POST", {
    alertId: laboratory.alertId, note: "Remboursement en espèces synthétique confirmé dans l’émulateur.", resolve: true, refundMethod: "CASH_MANUAL", refundReference: "RECU-LAB-TEST-0001",
  })));
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  const labOrder = await db.collection("nexaOrders").doc(laboratory.orderId).get();
  assert.equal(labOrder.get("refundMethod"), "CASH_MANUAL");
  assert.equal(labOrder.get("refundedAmount"), 2250);
  assert.equal(labOrder.get("nonRefundableTransactionFee"), 79);
  assert.equal((await db.collection("nexaPatientWallets").doc(patient.uid).get()).get("availableMinor"), 675000);
  const refundLedger = await db.collection("nexaRefundLedger").get();
  assert.equal(refundLedger.size, 4);
  assert.equal(refundLedger.docs.find((doc) => doc.get("resourceId") === laboratory.orderId)?.get("amountMinor"), 225000);
  assert.equal(refundLedger.docs.find((doc) => doc.get("resourceId") === laboratory.orderId)?.get("nonRefundableTransactionFeeMinor"), 7900);
});

test("a patient can request manual cash after MonCash settlement and the admin sees and records the exact amount", async () => {
  const patient = await createAuthUser("patient-cash-refund");
  const admin = await createAuthUser("admin-cash-refund");
  process.env.NEXA_ADMIN_UIDS = admin.uid;
  const appointmentId = "appointment_manual_cash_0001";
  const paymentRef = "moncash-appointment-cash-ref-0001";
  await createPaidAppointment({ patientUid: patient.uid, appointmentId, paymentRef });

  await settlePaidAppointmentPayment(paymentRef);
  const feeLedger = await db.collection("nexaTransactionFeeLedger").doc(paymentRef).get();
  assert.equal(feeLedger.get("amountMinor"), 17500);
  assert.equal(feeLedger.get("paymentMethod"), "MONCASH");
  await db.collection("appointments").doc(appointmentId).set({
    status: "PAYMENT_CONFLICT_REFUND_REQUIRED",
    paymentStatus: "PAID",
    refundRequired: true,
    refundStatus: "MANUAL_REVIEW_REQUIRED",
  }, { merge: true });
  const alertId = `patient_cancel_${appointmentId}`;
  await db.collection("paymentSettlementAlerts").doc(alertId).set({
    resourceType: "appointment", resourceId: appointmentId, reason: "PATIENT_CANCELLATION_REFUND_REVIEW_REQUIRED", status: "open",
  });

  const cashRequest = await readResponse(await requestCashRefund(makeRequest(patient, "/api/patient/refunds/cash", "POST", {
    resourceType: "appointment", resourceId: appointmentId,
  })));
  assert.equal(cashRequest.status, 200, JSON.stringify(cashRequest.body));
  assert.equal(cashRequest.body.requestedRefundMethod, "CASH_MANUAL");
  assert.equal((await db.collection("appointments").doc(appointmentId).get()).get("requestedRefundMethod"), "CASH_MANUAL");
  const walletQueue = await readResponse(await listAdminRefunds(makeRequest(admin, "/api/admin/refunds")));
  assert.equal(walletQueue.body.refunds.length, 0, "cash requests must not also be shown for Wallet credit");

  const alerts = await readResponse(await listSettlementAlerts(makeRequest(admin, "/api/admin/payment-settlement-alerts")));
  assert.equal(alerts.status, 200, JSON.stringify(alerts.body));
  const alert = alerts.body.alerts.find((item) => item.alertId === alertId);
  assert.equal(alert.amount, 5000);
  assert.equal(alert.transactionFee, 175);
  assert.equal(alert.requestedRefundMethod, "CASH_MANUAL");

  const resolved = await readResponse(await resolveSettlementAlert(makeRequest(admin, "/api/admin/payment-settlement-alerts", "POST", {
    alertId, note: "Remise synthétique confirmée dans le scénario émulateur.", resolve: true, refundMethod: "CASH_MANUAL", refundReference: "RECU-TEST-0001",
  })));
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  const source = await db.collection("appointments").doc(appointmentId).get();
  assert.equal(source.get("status"), "REFUNDED");
  assert.equal(source.get("refundedAmount"), 5000);
  assert.equal(source.get("nonRefundableTransactionFee"), 175);
  const refundLedger = await db.collection("nexaRefundLedger").get();
  assert.equal(refundLedger.size, 1);
  assert.equal(refundLedger.docs[0].get("amountMinor"), 500000);
  assert.equal(refundLedger.docs[0].get("refundMethod"), "CASH_MANUAL");
  assert.equal((await db.collection("nexaPatientWallets").doc(patient.uid).get()).exists, false);
});

test("patients cannot request cash for another patient’s appointment", async () => {
  const owner = await createAuthUser("cash-refund-owner");
  const attacker = await createAuthUser("cash-refund-attacker");
  const appointmentId = "appointment_owned_by_other_0001";
  const paymentRef = "owner-appointment-payment-ref-0001";
  await createPaidAppointment({ patientUid: owner.uid, appointmentId, paymentRef });
  await db.collection("appointments").doc(appointmentId).set({
    status: "PAYMENT_CONFLICT_REFUND_REQUIRED", paymentStatus: "PAID", refundRequired: true,
  }, { merge: true });

  const response = await readResponse(await requestCashRefund(makeRequest(attacker, "/api/patient/refunds/cash", "POST", {
    resourceType: "appointment", resourceId: appointmentId,
  })));
  assert.equal(response.status, 404);
  assert.equal((await db.collection("paymentSettlementAlerts").get()).size, 0);
  assert.equal((await db.collection("adminAuditLogs").get()).size, 0);
});
