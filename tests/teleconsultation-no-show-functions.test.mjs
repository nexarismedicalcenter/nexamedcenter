import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createRequire } from "node:module";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const projectId = "demo-nexaris";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "";
const isLocalHost = (host) => host && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${host}`).hostname);
if (!isLocalHost(firestoreHost)) throw new Error("Refusing no-show function tests without a local Firestore emulator.");

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const require = createRequire(import.meta.url);
const createNexaTeleconsultationFunctions = require("../functions/nexa-teleconsultation.js");
const app = initializeApp({ projectId }, "nexa-no-show-functions-tests");
const db = getFirestore(app);
const notifications = [];
let agoraRtcEventsActive = false;
const endpoints = createNexaTeleconsultationFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser: async (req) => ({ uid: req.authUid }),
  requireAppCheckToken: async () => {},
  enforceUserRateLimit: async () => {},
  setCors: (_req, res) => { res.set("Access-Control-Allow-Origin", "https://nexarishaiti.com"); return true; },
  fail: (res, status, code, message) => res.status(status).json({ ok: false, code, error: message }),
  logger: { error() {}, warn() {} },
  createNexaNotification: async (...args) => {
    const duplicate = notifications.some(([uid, eventKey]) => uid === args[0] && eventKey === args[1]);
    if (!duplicate) notifications.push(args);
  },
  agoraRtcEventsEnabled: () => agoraRtcEventsActive,
  appointmentPaymentMatches: (appointment, payment) => {
    const service = Number(appointment.amount);
    const fee = Number(appointment.transactionFee ?? 0);
    const total = Number(appointment.totalAmount ?? service);
    return Number.isSafeInteger(service) && Number.isSafeInteger(fee) && Number.isSafeInteger(total) &&
      total === service + fee && Number(payment.amount) === total &&
      Number(payment.serviceAmount ?? payment.resourceAmount ?? payment.amount) === service &&
      Number(payment.transactionFee ?? 0) === fee;
  },
});

async function clearFirestoreEmulator() {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true, "Firestore emulator must be available and clearable.");
}

const patientUid = "nexa-no-show-patient";
const providerUid = "nexa-no-show-doctor";
const paymentRef = "NEXATESTPAYMENTREF20261117";

function unpaidAttempt(role, startedAtMs) {
  const uid = role === "patient" ? patientUid : providerUid;
  return {
    signalId: `previous-${role}-call-001`,
    initiatedByUid: uid,
    initiatedByRole: role,
    attemptNumber: 1,
    status: "NO_ANSWER",
    startedAtMs,
    resolvedAtMs: startedAtMs + 90_000,
  };
}

function appointment(overrides = {}) {
  const now = Date.now();
  return {
    patientUid,
    providerUid,
    providerType: "doctor",
    bookingType: "teleconsultation",
    status: "DOCTOR_ACCEPTED",
    paymentStatus: "PAID",
    sessionStatus: "SCHEDULED",
    startsAt: new Date(now - 10 * 60_000).toISOString(),
    endsAt: new Date(now + 20 * 60_000).toISOString(),
    interactiveEndsAt: new Date(now + 35 * 60_000).toISOString(),
    amount: 5_000,
    transactionFee: 175,
    totalAmount: 5_175,
    currency: "HTG",
    moncashPaymentRef: paymentRef,
    videoCallAttempts: [unpaidAttempt("patient", now - 300_000)],
    videoSignal: {
      id: "current-patient-call-002",
      status: "RINGING",
      by: patientUid,
      updatedAt: new Date(now - 95_000).toISOString(),
    },
    ...overrides,
  };
}

async function createPaidAppointment(appointmentId, overrides = {}) {
  const source = appointment(overrides);
  await Promise.all([
    db.collection("appointments").doc(appointmentId).set(source),
    db.collection("patientProfiles").doc(patientUid).set({ role: "patient", profileComplete: true, patientNumber: "NMC-0000001" }),
    db.collection("paymentIntents").doc(paymentRef).set({
      uid: patientUid,
      amount: 5_175,
      serviceAmount: 5_000,
      transactionFee: 175,
      currency: "HTG",
      resourceType: "appointment",
      resourcePath: `appointments/${appointmentId}`,
      paymentMethod: "MONCASH",
      status: "paid",
    }),
    db.collection("nexaPatientWallets").doc(patientUid).set({
      userUid: patientUid, currency: "HTG", availableMinor: 12_300, reservedMinor: 500, status: "ACTIVE",
    }),
  ]);
  return db.collection("appointments").doc(appointmentId);
}

before(async () => {
  assert.ok(isLocalHost(firestoreHost));
});
beforeEach(async () => {
  notifications.length = 0;
  agoraRtcEventsActive = false;
  await clearFirestoreEmulator();
});
after(async () => { await deleteApp(app); });

test("two unanswered patient invitations refund only the service price to Wallet exactly once", async () => {
  const appointmentId = "no-show-patient-wallet-001";
  const ref = await createPaidAppointment(appointmentId);

  await endpoints.nexaReconcileTeleconsultationCalls.run();

  const pending = await ref.get();
  const pendingWallet = await db.collection("nexaPatientWallets").doc(patientUid).get();
  assert.equal(pending.get("status"), "PROVIDER_NO_SHOW_REFUND_REQUIRED");
  assert.equal(pending.get("refundStatus"), "PENDING_AUTO_REFUND");
  assert.equal(pendingWallet.get("availableMinor"), 12_300, "automatic refund waits until server Agora verification is configured");
  agoraRtcEventsActive = true;
  await endpoints.nexaReconcileTeleconsultationCalls.run();

  const final = await ref.get();
  const wallet = await db.collection("nexaPatientWallets").doc(patientUid).get();
  const ledgerId = (await db.collection("nexaWalletLedger").where("resourceId", "==", appointmentId).get()).docs[0]?.id;
  const refundLedger = await db.collection("nexaRefundLedger").where("resourceId", "==", appointmentId).get();
  assert.equal(final.get("status"), "REFUNDED");
  assert.equal(final.get("noShowOutcome"), "PROVIDER_UNRESPONSIVE");
  assert.equal(final.get("refundMethod"), "NEXA_WALLET");
  assert.equal(final.get("refundedAmount"), 5_000);
  assert.equal(final.get("nonRefundableTransactionFee"), 175);
  assert.equal(wallet.get("availableMinor"), 512_300);
  assert.equal(wallet.get("reservedMinor"), 500);
  assert.equal(refundLedger.size, 1);
  assert.ok(ledgerId);
  assert.equal(notifications.filter((item) => item[0] === patientUid).length, 1);
  assert.equal(notifications.filter((item) => item[0] === providerUid).length, 1);
});

test("two unanswered doctor invitations keep the service with NEXA and do not credit Wallet", async () => {
  const appointmentId = "no-show-patient-retained-001";
  const now = Date.now();
  const ref = await createPaidAppointment(appointmentId, {
    videoCallAttempts: [unpaidAttempt("doctor", now - 300_000)],
    videoSignal: { id: "current-doctor-call-002", status: "RINGING", by: providerUid, updatedAt: new Date(now - 95_000).toISOString() },
  });

  await endpoints.nexaReconcileTeleconsultationCalls.run();

  const final = await ref.get();
  const wallet = await db.collection("nexaPatientWallets").doc(patientUid).get();
  assert.equal(final.get("status"), "PATIENT_NO_SHOW_RETAINED");
  assert.equal(final.get("noShowOutcome"), "PATIENT_UNRESPONSIVE");
  assert.equal(final.get("settlementStatus"), "NEXA_RETAINED_NO_SHOW");
  assert.equal(final.get("refundRequired"), false);
  assert.equal(wallet.get("availableMinor"), 12_300);
  assert.equal((await db.collection("nexaWalletLedger").where("resourceId", "==", appointmentId).get()).size, 0);
  assert.equal(notifications.filter((item) => item[0] === providerUid).length, 1);
});

test("one unanswered call is recorded without prematurely deciding a financial outcome", async () => {
  const appointmentId = "no-show-first-call-only-001";
  const ref = await createPaidAppointment(appointmentId, { videoCallAttempts: [] });

  await endpoints.nexaReconcileTeleconsultationCalls.run();

  const final = await ref.get();
  assert.equal(final.get("status"), "DOCTOR_ACCEPTED");
  assert.equal(final.get("noShowOutcome"), undefined);
  assert.equal(final.get("videoCallAttempts").length, 1);
  assert.equal(final.get("videoCallAttempts")[0].status, "NO_ANSWER");
  assert.equal((await db.collection("nexaWalletLedger").get()).size, 0);
});

test("a teleconsultation that already started cannot be classified as a no-show", async () => {
  const appointmentId = "no-show-session-already-started-001";
  const now = Date.now();
  const ref = await createPaidAppointment(appointmentId, {
    status: "IN_PROGRESS",
    sessionStatus: "IN_PROGRESS",
    effectiveConsultationStartedAt: new Date(now - 60_000).toISOString(),
  });

  await endpoints.nexaReconcileTeleconsultationCalls.run();

  const final = await ref.get();
  assert.equal(final.get("status"), "IN_PROGRESS");
  assert.equal(final.get("noShowOutcome"), undefined);
  assert.equal(final.get("videoSignal").status, "RINGING");
  assert.equal((await db.collection("nexaWalletLedger").get()).size, 0);
});

test("a previously requested cash refund opens the admin queue and prevents a Wallet credit", async () => {
  const appointmentId = "no-show-manual-cash-001";
  const ref = await createPaidAppointment(appointmentId, { requestedRefundMethod: "CASH_MANUAL" });

  await endpoints.nexaReconcileTeleconsultationCalls.run();

  const final = await ref.get();
  const wallet = await db.collection("nexaPatientWallets").doc(patientUid).get();
  const alerts = await db.collection("paymentSettlementAlerts").where("resourceId", "==", appointmentId).get();
  assert.equal(final.get("status"), "PROVIDER_NO_SHOW_REFUND_REQUIRED");
  assert.equal(final.get("refundStatus"), "PENDING_MANUAL_CASH");
  assert.equal(final.get("noShowOutcome"), "PROVIDER_UNRESPONSIVE");
  assert.equal(wallet.get("availableMinor"), 12_300);
  assert.equal(alerts.size, 1);
  assert.equal(alerts.docs[0].get("requestedRefundMethod"), "CASH_MANUAL");
});
