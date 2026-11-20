import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { deleteApp, getApps } from "firebase-admin/app";

process.env.NODE_ENV = "test";
process.env.FIREBASE_PROJECT_ID = "demo-nexaris";
process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||= "demo-api-key";

const projectId = "demo-nexaris";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || "";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "";
const localHost = (value) => value && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${value.replace(/^https?:\/\//, "")}`).hostname);
if (!localHost(authHost) || !localHost(firestoreHost)) {
  throw new Error("Refusing appointment management tests without local Auth and Firestore emulators.");
}

const [
  { getFirebaseAdminDb },
  { POST: manageAppointment },
  { POST: manageProviderAppointment },
  { GET: listPatientAppointments },
] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/appointments/[appointmentId]/manage/route.ts"),
  import("../src/app/api/provider/appointments/route.ts"),
  import("../src/app/api/appointments/route.ts"),
]);
const db = getFirebaseAdminDb();
const authBaseUrl = `http://${authHost}`;
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

function request(user, path, method = "GET", body) {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { Origin: "http://localhost:3000", ...(user ? { Authorization: `Bearer ${user.token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function manage(user, appointmentId, action = "dismiss-expired") {
  return manageAppointment(request(user, `/api/appointments/${appointmentId}/manage`, "POST", { action }), { params: Promise.resolve({ appointmentId }) });
}

async function read(response) { return { status: response.status, body: await response.json() }; }

beforeEach(clearFirestoreEmulator);
after(async () => {
  const app = getApps().find((item) => item.name === "nexa-server");
  if (app) await deleteApp(app);
});

test("patients can dismiss only their expired unpaid appointment, without changing its financial record", async () => {
  const patient = await createAuthUser("expired-appointment-patient");
  const otherPatient = await createAuthUser("other-expired-appointment-patient");
  const expiredId = "expired-appointment-1";
  await db.collection("appointments").doc(expiredId).set({
    patientUid: patient.uid,
    providerUid: "synthetic-nexa-provider",
    status: "PAYMENT_EXPIRED",
    paymentStatus: "EXPIRED",
    amount: 5000,
    transactionFee: 175,
    totalAmount: 5175,
    refundRequired: false,
    createdAt: new Date(),
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const liveId = "still-pending-appointment";
  await db.collection("appointments").doc(liveId).set({
    patientUid: patient.uid,
    status: "PENDING_PAYMENT",
    paymentStatus: "PENDING",
    holdExpiresAt: Date.now() + 60_000,
    startsAt: new Date(Date.now() + 172_800_000).toISOString(),
  });

  const ownerResult = await read(await manage(patient, expiredId));
  assert.equal(ownerResult.status, 200);
  assert.equal(ownerResult.body.status, "DISMISSED");
  const stored = await db.collection("appointments").doc(expiredId).get();
  assert.equal(stored.get("dismissedByPatient"), true);
  assert.equal(stored.get("status"), "PAYMENT_EXPIRED");
  assert.equal(stored.get("paymentStatus"), "EXPIRED");
  assert.equal(stored.get("amount"), 5000);
  assert.equal(stored.get("transactionFee"), 175);
  assert.equal(stored.get("totalAmount"), 5175);
  assert.equal(stored.get("refundRequired"), false);

  const repeated = await read(await manage(patient, expiredId));
  assert.equal(repeated.status, 200);
  assert.equal((await db.collection("adminAuditLogs").where("action", "==", "patient_dismissed_expired_appointment").get()).size, 1);

  const list = await read(await listPatientAppointments(request(patient, "/api/appointments")));
  assert.equal(list.status, 200);
  assert.equal(list.body.appointments.some((appointment) => appointment.appointmentId === expiredId), false);
  assert.equal(list.body.appointments.some((appointment) => appointment.appointmentId === liveId), true);

  await db.collection("appointments").doc(expiredId).update({ status: "PAYMENT_CONFLICT_REFUND_REQUIRED", paymentStatus: "PAID", refundRequired: true });
  const latePaymentList = await read(await listPatientAppointments(request(patient, "/api/appointments")));
  assert.equal(latePaymentList.body.appointments.some((appointment) => appointment.appointmentId === expiredId), true, "a late payment requiring reconciliation must reappear in the patient space");

  const otherResult = await read(await manage(otherPatient, liveId));
  assert.equal(otherResult.status, 404);
  assert.equal((await db.collection("appointments").doc(liveId).get()).get("dismissedByPatient"), undefined);
  const stillPendingResult = await read(await manage(patient, liveId));
  assert.equal(stillPendingResult.status, 409);
  assert.equal((await db.collection("appointments").doc(liveId).get()).get("dismissedByPatient"), undefined);
});

test("patients cannot cancel appointments and doctors cannot refuse a physician-proposed appointment", async () => {
  const patient = await createAuthUser("no-cancel-patient");
  const doctor = await createAuthUser("no-cancel-doctor");
  const appointmentId = "appointment-no-cancel-001";
  await db.collection("providerProfiles").doc(doctor.uid).set({
    type: "doctor",
    status: "verified",
    clinicalCredentialsVerified: true,
  });
  await db.collection("appointments").doc(appointmentId).set({
    patientUid: patient.uid,
    providerUid: doctor.uid,
    providerType: "doctor",
    bookingType: "provider_proposed_appointment",
    status: "CONFIRMED",
    paymentStatus: "PAID",
    amount: 5000,
    transactionFee: 175,
    totalAmount: 5175,
  });

  const patientResult = await read(await manage(patient, appointmentId, "cancel"));
  assert.equal(patientResult.status, 409);
  assert.equal(patientResult.body.code, "appointment-cancellation-disabled");
  const providerRequest = request(doctor, "/api/provider/appointments", "POST", { appointmentId, action: "refuse" });
  const providerResult = await read(await manageProviderAppointment(providerRequest));
  assert.equal(providerResult.status, 409);
  assert.equal(providerResult.body.code, "appointment-refusal-not-allowed");

  const stored = await db.collection("appointments").doc(appointmentId).get();
  assert.equal(stored.get("status"), "CONFIRMED");
  assert.equal(stored.get("paymentStatus"), "PAID");
  assert.equal(stored.get("amount"), 5000);
  assert.equal(stored.get("transactionFee"), 175);
  assert.equal(stored.get("totalAmount"), 5175);
  assert.equal((await db.collection("paymentSettlementAlerts").get()).size, 0);
});

test("a doctor can refuse a paid teleconsultation and the service amount is credited to Wallet exactly once", async () => {
  const patient = await createAuthUser("refused-teleconsultation-patient");
  const doctor = await createAuthUser("refused-teleconsultation-doctor");
  await Promise.all([
    db.collection("patientProfiles").doc(patient.uid).set({ role: "patient", profileComplete: true }),
    db.collection("providerProfiles").doc(doctor.uid).set({ type: "doctor", status: "verified", clinicalCredentialsVerified: true }),
  ]);

  for (const paymentMethod of ["MONCASH", "SMART_WALLET"]) {
    const suffix = paymentMethod.toLowerCase();
    const appointmentId = `refused-teleconsult-${suffix}-001`;
    const paymentRef = `refused-payment-${suffix}-0001`;
    await Promise.all([
      db.collection("appointments").doc(appointmentId).set({
        patientUid: patient.uid,
        providerUid: doctor.uid,
        providerType: "doctor",
        bookingType: "teleconsultation",
        providerName: "Médecin synthétique",
        status: "CONFIRMED",
        paymentStatus: "PAID",
        paymentMethod,
        amount: 5000,
        transactionFee: 175,
        transactionFeeRateBps: 350,
        totalAmount: 5175,
        currency: "HTG",
        moncashPaymentRef: paymentRef,
      }),
      db.collection("paymentIntents").doc(paymentRef).set({
        uid: patient.uid,
        paymentMethod,
        resourceType: "appointment",
        resourcePath: `appointments/${appointmentId}`,
        amount: 5175,
        serviceAmount: 5000,
        transactionFee: 175,
        currency: "HTG",
        status: "paid",
      }),
    ]);

    const providerRequest = request(doctor, "/api/provider/appointments", "POST", { appointmentId, action: "refuse" });
    const response = await read(await manageProviderAppointment(providerRequest));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, "REFUNDED");
    assert.equal(response.body.refundMethod, "NEXA_WALLET");
    assert.equal(response.body.refundedAmount, 5000);

    const appointment = await db.collection("appointments").doc(appointmentId).get();
    assert.equal(appointment.get("status"), "REFUNDED");
    assert.equal(appointment.get("paymentStatus"), "REFUNDED");
    assert.equal(appointment.get("refundMethod"), "NEXA_WALLET");
    assert.equal(appointment.get("refundRequired"), false);
    assert.equal(appointment.get("refundedAmount"), 5000);
    assert.equal(appointment.get("nonRefundableTransactionFee"), 175);
    const wallet = await db.collection("nexaPatientWallets").doc(patient.uid).get();
    const expectedWalletBalance = paymentMethod === "MONCASH" ? 500_000 : 1_000_000;
    assert.equal(wallet.get("availableMinor"), expectedWalletBalance);
    const refundLedger = await db.collection("nexaRefundLedger").where("resourceId", "==", appointmentId).get();
    assert.equal(refundLedger.size, 1);
    assert.equal(refundLedger.docs[0].get("serviceAmountMinor"), 500_000);
    assert.equal(refundLedger.docs[0].get("nonRefundableTransactionFeeMinor"), 17_500);

    const retry = await read(await manageProviderAppointment(request(doctor, "/api/provider/appointments", "POST", { appointmentId, action: "refuse" })));
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.alreadyProcessed, true);
    assert.equal((await db.collection("nexaPatientWallets").doc(patient.uid).get()).get("availableMinor"), expectedWalletBalance);
    assert.equal((await db.collection("nexaRefundLedger").where("resourceId", "==", appointmentId).get()).size, 1);
  }
});
