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
  throw new Error("Refusing diagnostic result issue tests without local Auth and Firestore emulators.");
}

const [{ getFirebaseAdminDb }, { GET, POST }] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/admin/diagnostic-result-issues/route.ts"),
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

function makeRequest(user, { method = "GET", query = "", body } = {}) {
  return new Request(`http://localhost:3000/api/admin/diagnostic-result-issues${query}`, {
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

beforeEach(async () => {
  process.env.NEXA_ADMIN_UIDS = "";
  await clearFirestoreEmulator();
});

after(async () => {
  const adminApp = getApps().find((app) => app.name === "nexa-server");
  if (adminApp) await deleteApp(adminApp);
});

test("diagnostic result issue routes require an administrator and validate result links", async () => {
  const administrator = await createAuthUser("diagnostic-issue-admin");
  const regularUser = await createAuthUser("diagnostic-issue-user");
  process.env.NEXA_ADMIN_UIDS = administrator.uid;

  const anonymousList = await readResponse(await GET(makeRequest(null)));
  const deniedList = await readResponse(await GET(makeRequest(regularUser)));
  const invalidFilter = await readResponse(await GET(makeRequest(administrator, { query: "?status=OTHER" })));
  const anonymousCreate = await readResponse(await POST(makeRequest(null, { method: "POST", body: { action: "CREATE" } })));
  const deniedCreate = await readResponse(await POST(makeRequest(regularUser, { method: "POST", body: { action: "CREATE" } })));
  const missingResult = await readResponse(await POST(makeRequest(administrator, { method: "POST", body: { action: "CREATE", resultId: "missing_diagnostic_result_001", reason: "Écart de traitement" } })));

  assert.equal(anonymousList.status, 401);
  assert.equal(deniedList.status, 403);
  assert.equal(invalidFilter.status, 400);
  assert.equal(anonymousCreate.status, 401);
  assert.equal(deniedCreate.status, 403);
  assert.equal(missingResult.status, 404);

  const providerUid = "synthetic-laboratory-uid-001";
  const orderId = "issue_order_seed_000000001";
  const resultId = "issue_result_seed_000000001";
  const wrongLineResultId = "issue_result_wrong_line_001";
  const wrongPatientResultId = "issue_result_wrong_patient_001";
  const missingPatientResultId = "issue_result_missing_patient_001";
  await db.collection("providerProfiles").doc(providerUid).set({ type: "laboratory", status: "verified" });
  await db.collection("nexaOrders").doc(orderId).set({
    providerUid,
    kind: "laboratory",
    items: [{ offerId: "offer_issue_seed_0001" }],
    patientUid: "synthetic-private-patient-uid",
    patientNumber: "NMC-9999999",
  });
  await Promise.all([
    db.collection("diagnosticResults").doc(wrongLineResultId).set({ orderId, examLineId: "another_exam_line", providerUid, providerType: "laboratory", patientUid: "synthetic-private-patient-uid" }),
    db.collection("diagnosticResults").doc(wrongPatientResultId).set({ orderId, examLineId: "offer_issue_seed_0001", providerUid, providerType: "laboratory", patientUid: "different-private-patient-uid" }),
    db.collection("diagnosticResults").doc(missingPatientResultId).set({ orderId, examLineId: "offer_issue_seed_0001", providerUid, providerType: "laboratory" }),
  ]);
  const wrongLine = await readResponse(await POST(makeRequest(administrator, { method: "POST", body: { action: "CREATE", resultId: wrongLineResultId, reason: "Vérifier le mauvais lien" } })));
  const wrongPatient = await readResponse(await POST(makeRequest(administrator, { method: "POST", body: { action: "CREATE", resultId: wrongPatientResultId, reason: "Vérifier le patient lié" } })));
  const missingPatient = await readResponse(await POST(makeRequest(administrator, { method: "POST", body: { action: "CREATE", resultId: missingPatientResultId, reason: "Vérifier le patient lié" } })));
  assert.equal(wrongLine.status, 409);
  assert.equal(wrongPatient.status, 409);
  assert.equal(missingPatient.status, 409);
  await db.collection("diagnosticResults").doc(resultId).set({
    orderId,
    examLineId: "offer_issue_seed_0001",
    providerUid,
    providerType: "laboratory",
    status: "RESULT_AVAILABLE",
    patientUid: "synthetic-private-patient-uid",
    patientNumber: "NMC-9999999",
    comment: "PRIVATE_CLINICAL_NOTE",
  });

  const response = await readResponse(await POST(makeRequest(administrator, { method: "POST", body: { action: "CREATE", resultId, reason: "Vérifier le document transmis" } })));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.status, "OPEN");
  const storedIssue = await db.collection("diagnosticResultIssues").doc(response.body.issueId).get();
  assert.equal(storedIssue.get("resultId"), resultId);
  assert.equal(storedIssue.get("orderId"), orderId);
  assert.equal(storedIssue.get("status"), "OPEN");
  for (const privateValue of ["patientUid", "patientNumber", "comment", "PRIVATE_CLINICAL_NOTE", "NMC-9999999"]) {
    assert.equal(Object.hasOwn(storedIssue.data(), privateValue), false, `Issue must omit ${privateValue}.`);
  }
  assert.equal((await db.collection("diagnosticResults").doc(resultId).get()).get("status"), "RESULT_AVAILABLE", "Creating an issue must not modify the patient result.");
  const audit = await db.collection("adminAuditLogs").where("action", "==", "diagnostic_result_issue_reported").get();
  assert.equal(audit.size, 1);
  assert.equal(JSON.stringify(audit.docs[0].data()).includes("PRIVATE_CLINICAL_NOTE"), false);
});

test("diagnostic result issues paginate by filter and close once with an audited note", async () => {
  const administrator = await createAuthUser("diagnostic-issue-pages-admin");
  process.env.NEXA_ADMIN_UIDS = administrator.uid;
  const seed = Array.from({ length: 51 }, (_, index) => db.collection("diagnosticResultIssues").doc(`issue_seed_${String(index).padStart(4, "0")}`));
  await Promise.all(seed.map((ref, index) => ref.set({
    resultId: `diagnostic_result_seed_${String(index).padStart(4, "0")}`,
    orderId: `diagnostic_order_seed_${String(index).padStart(4, "0")}`,
    examLineId: `exam_line_${String(index).padStart(4, "0")}`,
    partnerUid: "synthetic-provider-uid",
    providerType: index % 2 ? "imaging" : "laboratory",
    actorUid: administrator.uid,
    issueReason: `Administrative issue ${index}`,
    status: "OPEN",
    patientUid: "PRIVATE_PATIENT_UID",
    patientNumber: "NMC-9999999",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
  })));

  const first = await readResponse(await GET(makeRequest(administrator)));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.issues.length, 50);
  assert.ok(first.body.nextCursor);
  const second = await readResponse(await GET(makeRequest(administrator, { query: `?status=OPEN&cursor=${encodeURIComponent(first.body.nextCursor)}` })));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.issues.length, 1);
  const ids = [...first.body.issues, ...second.body.issues].map((issue) => issue.id);
  assert.equal(new Set(ids).size, 51);
  assert.equal(JSON.stringify(first.body).includes("PRIVATE_PATIENT_UID"), false);
  assert.equal(JSON.stringify(first.body).includes("NMC-9999999"), false);

  const wrongFilterCursor = await readResponse(await GET(makeRequest(administrator, { query: `?status=RESOLVED&cursor=${encodeURIComponent(first.body.nextCursor)}` })));
  assert.equal(wrongFilterCursor.status, 400);
  const issueId = first.body.issues[0].id;
  const tooShortNote = await readResponse(await POST(makeRequest(administrator, { method: "POST", body: { action: "RESOLVE", issueId, reason: "ok" } })));
  assert.equal(tooShortNote.status, 400);
  const resolved = await readResponse(await POST(makeRequest(administrator, { method: "POST", body: { action: "RESOLVE", issueId, reason: "Document vérifié et écart corrigé" } })));
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.status, "RESOLVED");
  const duplicateResolve = await readResponse(await POST(makeRequest(administrator, { method: "POST", body: { action: "RESOLVE", issueId, reason: "Deuxième clôture" } })));
  assert.equal(duplicateResolve.status, 409);
  const resolvedList = await readResponse(await GET(makeRequest(administrator, { query: "?status=RESOLVED" })));
  assert.equal(resolvedList.status, 200, JSON.stringify(resolvedList.body));
  assert.equal(resolvedList.body.issues.length, 1);
  assert.equal(resolvedList.body.issues[0].resolutionReason, "Document vérifié et écart corrigé");
  const audit = await db.collection("adminAuditLogs").where("action", "==", "diagnostic_result_issue_resolved").get();
  assert.equal(audit.size, 1);
});
