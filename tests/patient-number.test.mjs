import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  ensurePatientProfile,
  formatPatientNumber,
  PatientNumberCapacityError,
  PatientNumberIntegrityError,
} from "../src/lib/patients/ensure-patient-profile.ts";

const projectId = "demo-nexaris";
const app = initializeApp({ projectId }, "patient-number-tests");
const db = getFirestore(app);

async function clearFirestoreEmulator() {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  if (!emulatorHost) throw new Error("Refusing to clear Firestore without an emulator host.");
  const parsedHost = new URL(`http://${emulatorHost}`).hostname;
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsedHost)) {
    throw new Error("Refusing to clear a non-local Firestore target.");
  }
  const response = await fetch(
    `http://${emulatorHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(response.ok, true, "Firestore emulator must be available and clearable.");
}

function registration(firstName) {
  return {
    firstName,
    lastName: "Patient",
    birthDate: "1990-01-01",
    phone: "+509 3700 0000",
    sex: "Non communiqué",
    addressLine: "Rue de la Santé",
    country: "Haïti",
    department: "Ouest",
    commune: "Port-au-Prince",
    emailMarketingConsent: false,
    termsAccepted: true,
  };
}

before(clearFirestoreEmulator);
after(() => app.delete());

test("formats the patient number with a fixed NMC prefix and seven digits", () => {
  assert.equal(formatPatientNumber(1), "NMC-0000001");
  assert.equal(formatPatientNumber(42), "NMC-0000042");
  assert.equal(formatPatientNumber(9_999_999), "NMC-9999999");
  assert.throws(() => formatPatientNumber(0), RangeError);
  assert.throws(() => formatPatientNumber(10_000_000), RangeError);
});

test("assigns a number as soon as the account exists and completes the same profile idempotently", async () => {
  const firstAccount = await ensurePatientProfile(db, {
    uid: "patient-1",
    email: "patient1@example.test",
  });
  const first = await ensurePatientProfile(
    db,
    { uid: "patient-1", email: "patient1@example.test" },
    registration("First"),
  );
  const retry = await ensurePatientProfile(
    db,
    { uid: "patient-1", email: "patient1@example.test" },
    registration("First"),
  );
  const second = await ensurePatientProfile(
    db,
    { uid: "patient-2", email: "patient2@example.test" },
    registration("Second"),
  );

  assert.deepEqual(firstAccount, {
    patientNumber: "NMC-0000001",
    created: true,
    profileComplete: false,
  });
  assert.deepEqual(first, {
    patientNumber: "NMC-0000001",
    created: false,
    profileComplete: true,
  });
  assert.deepEqual(retry, {
    patientNumber: "NMC-0000001",
    created: false,
    profileComplete: true,
  });
  assert.deepEqual(second, {
    patientNumber: "NMC-0000002",
    created: true,
    profileComplete: true,
  });
  assert.equal((await db.collection("patientNumberIndex").get()).size, 2);
});

test("assigns unique sequential numbers during simultaneous account creation", async () => {
  const registrations = Array.from({ length: 12 }, (_, index) =>
    ensurePatientProfile(
      db,
      { uid: `parallel-${index}`, email: `parallel-${index}@example.test` },
      registration(`Parallel${index}`),
    ),
  );
  const results = await Promise.all(registrations);
  const numbers = results.map((result) => result.patientNumber);

  assert.equal(new Set(numbers).size, registrations.length);
  assert.deepEqual(
    numbers.sort(),
    Array.from({ length: 12 }, (_, index) => formatPatientNumber(index + 3)).sort(),
  );
});

test("reuses one patient number when the same account initializes concurrently", async () => {
  const identity = { uid: "parallel-same-account", email: "parallel-same@example.test" };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => ensurePatientProfile(db, identity)),
  );
  const numbers = results.map((result) => result.patientNumber);

  assert.equal(new Set(numbers).size, 1);
  assert.equal(results.filter((result) => result.created).length, 1);
  const profile = await db.collection("patientProfiles").doc(identity.uid).get();
  assert.equal(profile.get("patientNumber"), numbers[0]);
  const index = await db.collection("patientNumberIndex").where("uid", "==", identity.uid).get();
  assert.equal(index.size, 1);
  assert.equal(index.docs[0].id, numbers[0]);
});

test("fails closed if the seven-digit sequence is exhausted", async () => {
  await db.collection("systemCounters").doc("patientNumbers").set({
    lastIssuedNumber: 9_999_999,
  });
  await assert.rejects(
    ensurePatientProfile(
      db,
      { uid: "overflow", email: "overflow@example.test" },
      registration("Overflow"),
    ),
    PatientNumberCapacityError,
  );
  assert.equal((await db.collection("patientProfiles").doc("overflow").get()).exists, false);
});

test("fails closed when the patient number counter is malformed", async () => {
  await db.collection("systemCounters").doc("patientNumbers").set({
    lastIssuedNumber: "not-a-number",
  });
  await assert.rejects(
    ensurePatientProfile(
      db,
      { uid: "invalid-counter", email: "invalid-counter@example.test" },
      registration("Invalid"),
    ),
    PatientNumberIntegrityError,
  );
  assert.equal((await db.collection("patientProfiles").doc("invalid-counter").get()).exists, false);
});
