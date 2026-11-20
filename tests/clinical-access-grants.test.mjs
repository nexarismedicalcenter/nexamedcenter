import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createHash } from "node:crypto";
import { deleteApp, getApps } from "firebase-admin/app";

process.env.NODE_ENV = "test";
process.env.FIREBASE_PROJECT_ID = "demo-nexaris";
process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||= "demo-api-key";

const projectId = "demo-nexaris";
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || "";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "";
const isLocal = (value) => value && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${value.replace(/^https?:\/\//, "")}`).hostname);
if (!isLocal(authHost) || !isLocal(firestoreHost)) throw new Error("Refusing clinical grant tests without local Auth and Firestore emulators.");

const [
  { getFirebaseAdminDb },
  { GET: listPatientGrants, POST: issuePatientGrant, DELETE: revokePatientGrant },
  { GET: listProviderRecords, POST: createProviderRecord },
  { GET: readProviderRecord, POST: writeProviderRecord },
] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/patient/clinical-access/route.ts"),
  import("../src/app/api/provider/clinical-records/route.ts"),
  import("../src/app/api/provider/clinical-records/[recordId]/route.ts"),
]);
const db = getFirebaseAdminDb();
const authBaseUrl = `http://${authHost}`;
let sequence = 0;

async function clearFirestoreEmulator() {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true, "Firestore emulator must be available and clearable.");
}

async function createUser(prefix) {
  sequence += 1;
  const response = await fetch(`${authBaseUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(process.env.NEXT_PUBLIC_FIREBASE_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: `${prefix}.${Date.now()}.${sequence}@example.test`, password: "NexaTestPassword-2026", returnSecureToken: true }),
  });
  const result = await response.json();
  assert.equal(response.ok, true, `Auth emulator account creation failed with HTTP ${response.status}.`);
  return { uid: result.localId, token: result.idToken };
}

function request(user, path, method = "GET", body) {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { Origin: "http://localhost:3000", Authorization: `Bearer ${user.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function result(response) { return { status: response.status, body: await response.json() }; }

async function prepareProfiles(patient, doctor, patientNumber = "NMC-0000042") {
  await Promise.all([
    db.collection("patientProfiles").doc(patient.uid).set({ role: "patient", profileComplete: true, patientNumber, displayName: "Patient synthétique" }),
    db.collection("patientNumberIndex").doc(patientNumber).set({ uid: patient.uid }),
    db.collection("providerProfiles").doc(doctor.uid).set({
      type: "doctor", status: "verified", publiclyListed: true, clinicalCredentialsVerified: true,
      profile: { name: "Médecin de test", specialty: "Médecine générale" },
    }),
  ]);
}

beforeEach(clearFirestoreEmulator);
after(async () => {
  const app = getApps().find((item) => item.name === "nexa-server");
  if (app) await deleteApp(app);
});

test("patient authorization code is bound to one doctor, grants a temporary record, and can be revoked", async () => {
  const patient = await createUser("grant-patient");
  const doctor = await createUser("grant-doctor");
  const otherDoctor = await createUser("grant-other-doctor");
  await prepareProfiles(patient, doctor);
  await db.collection("providerProfiles").doc(otherDoctor.uid).set({
    type: "doctor", status: "verified", publiclyListed: true, clinicalCredentialsVerified: true,
    profile: { name: "Autre médecin" },
  });

  const issued = await result(await issuePatientGrant(request(patient, "/api/patient/clinical-access", "POST", { providerUid: doctor.uid })));
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  assert.match(issued.body.accessCode, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(Date.parse(issued.body.expiresAt) > Date.now(), true);
  const codeHash = createHash("sha256").update(issued.body.accessCode).digest("hex");
  const codeIndexRef = db.collection("clinicalAccessCodeIndex").doc(codeHash);
  const codeIndex = await codeIndexRef.get();
  assert.equal(codeIndex.get("providerUid"), doctor.uid);
  assert.equal(JSON.stringify(codeIndex.data()).includes(issued.body.accessCode), false);

  const listedGrant = await result(await listPatientGrants(request(patient, "/api/patient/clinical-access")));
  assert.equal(listedGrant.status, 200, JSON.stringify(listedGrant.body));
  assert.equal(listedGrant.body.grants[0].status, "ISSUED");
  assert.equal("accessCode" in listedGrant.body.grants[0], false);

  const noConsent = await result(await createProviderRecord(request(doctor, "/api/provider/clinical-records", "POST", { patientNumber: "NMC-0000042" })));
  assert.equal(noConsent.status, 400);
  assert.equal(noConsent.body.code, "patient-authorization-required");
  const wrongDoctor = await result(await createProviderRecord(request(otherDoctor, "/api/provider/clinical-records", "POST", { patientNumber: "NMC-0000042", accessCode: issued.body.accessCode })));
  assert.equal(wrongDoctor.status, 404);

  const created = await result(await createProviderRecord(request(doctor, "/api/provider/clinical-records", "POST", { patientNumber: "NMC-0000042", accessCode: issued.body.accessCode })));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const recordId = created.body.recordId;
  assert.match(recordId, /^[A-Za-z0-9_-]{10,200}$/);
  assert.equal(Date.parse(created.body.accessExpiresAt) > Date.now() + 23 * 60 * 60_000, true);
  const recordRef = db.collection("electronicPatientRecords").doc(recordId);
  const record = await recordRef.get();
  assert.equal(record.get("patientUid"), patient.uid);
  assert.equal(record.get("accessGrantId"), issued.body.grantId);
  assert.equal(record.get("accessRevoked"), false);
  const creationAudit = await db.collection("clinicalAuditLogs").where("action", "==", "standalone_clinical_record_created").get();
  assert.equal(creationAudit.size, 1);
  assert.equal("patientNumber" in creationAudit.docs[0].data(), false);

  const params = Promise.resolve({ recordId });
  assert.equal((await result(await readProviderRecord(request(doctor, `/api/provider/clinical-records/${recordId}`), { params }))).status, 200);
  const retry = await result(await createProviderRecord(request(doctor, "/api/provider/clinical-records", "POST", { patientNumber: "NMC-0000042", accessCode: issued.body.accessCode })));
  assert.equal(retry.status, 201);
  assert.equal(retry.body.recordId, recordId);
  assert.equal((await db.collection("systemCounters").doc("clinicalRecordNumbers").get()).get("lastIssuedNumber"), 1);

  const revoked = await result(await revokePatientGrant(request(patient, "/api/patient/clinical-access", "DELETE", { grantId: issued.body.grantId })));
  assert.equal(revoked.status, 200);
  assert.equal((await recordRef.get()).get("accessRevoked"), true);
  const deniedRead = await result(await readProviderRecord(request(doctor, `/api/provider/clinical-records/${recordId}`), { params }));
  const deniedWrite = await result(await writeProviderRecord(request(doctor, `/api/provider/clinical-records/${recordId}`, "POST", { action: "saveDraft", clinicalContent: {} }), { params }));
  assert.equal(deniedRead.status, 403);
  assert.equal(deniedRead.body.code, "clinical-access-expired");
  assert.equal(deniedWrite.status, 403);
  assert.deepEqual((await result(await listProviderRecords(request(doctor, "/api/provider/clinical-records")))).body.records, []);
  assert.equal((await result(await listPatientGrants(request(patient, "/api/patient/clinical-access")))).body.grants[0].status, "REVOKED");
});

test("expired patient authorization codes cannot create a clinical record", async () => {
  const patient = await createUser("expired-grant-patient");
  const doctor = await createUser("expired-grant-doctor");
  await prepareProfiles(patient, doctor, "NMC-0000043");
  const issued = await result(await issuePatientGrant(request(patient, "/api/patient/clinical-access", "POST", { providerUid: doctor.uid })));
  assert.equal(issued.status, 201);
  const codeHash = createHash("sha256").update(issued.body.accessCode).digest("hex");
  await db.collection("clinicalAccessGrants").doc(issued.body.grantId).update({ expiresAt: new Date(Date.now() - 60_000) });

  const response = await result(await createProviderRecord(request(doctor, "/api/provider/clinical-records", "POST", { patientNumber: "NMC-0000043", accessCode: issued.body.accessCode })));
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "patient-authorization-expired");
  assert.equal((await db.collection("electronicPatientRecords").get()).size, 0);
  assert.equal((await db.collection("clinicalAccessCodeIndex").doc(codeHash).get()).get("status"), "ISSUED");
});
