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
const isLocal = (value) => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${value.replace(/^https?:\/\//, "")}`).hostname);
if (!authHost || !firestoreHost || !isLocal(authHost) || !isLocal(firestoreHost)) {
  throw new Error("Refusing lab support tests without local Auth and Firestore emulators.");
}

const [{ getFirebaseAdminDb }, { GET: listProviderTickets, POST: createProviderTicket }, { GET: adminTickets, POST: adminAction }] = await Promise.all([
  import("../src/lib/firebase/admin.ts"),
  import("../src/app/api/lab-support/tickets/route.ts"),
  import("../src/app/api/admin/lab-support/route.ts"),
]);
const db = getFirebaseAdminDb();
const authBaseUrl = `http://${authHost}`;
const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
let userSequence = 0;

async function clearFirestoreEmulator() {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true, "Firestore emulator must be available and clearable.");
}

async function createAuthUser(prefix = "lab-support") {
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

function makeRequest(user, path, method = "GET", body) {
  return new Request(`http://localhost:3000${path}`, {
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

async function verifyLaboratory(user) {
  await db.collection("providerProfiles").doc(user.uid).set({ type: "laboratory", status: "verified", publiclyListed: true });
}

async function createTicket(user, values = {}) {
  return readResponse(await createProviderTicket(makeRequest(user, "/api/lab-support/tickets", "POST", {
    category: "commande",
    subject: "Aide commande labo",
    description: "Question de test sur une référence de commande.",
    ...values,
  })));
}

beforeEach(async () => {
  process.env.NEXA_ADMIN_UIDS = "";
  await clearFirestoreEmulator();
});

after(async () => {
  const adminApp = getApps().find((app) => app.name === "nexa-server");
  if (adminApp) await deleteApp(adminApp);
});

test("verified laboratories create and list only their own support tickets", async () => {
  const requester = await createAuthUser();
  const otherProvider = await createAuthUser("other-lab");
  await verifyLaboratory(requester);
  await verifyLaboratory(otherProvider);

  const created = await createTicket(requester);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.status, "OPEN");

  const ownList = await readResponse(await listProviderTickets(makeRequest(requester, "/api/lab-support/tickets")));
  const otherList = await readResponse(await listProviderTickets(makeRequest(otherProvider, "/api/lab-support/tickets")));
  const stolenDetail = await readResponse(await listProviderTickets(makeRequest(otherProvider, `/api/lab-support/tickets?ticketId=${encodeURIComponent(created.body.ticketId)}`)));
  assert.equal(ownList.body.tickets.length, 1);
  assert.equal(ownList.body.tickets[0].requesterUid, requester.uid);
  assert.equal(otherList.body.tickets.length, 0);
  assert.equal(stolenDetail.status, 404);
  const logs = await db.collection("adminAuditLogs").get();
  assert.ok(logs.docs.some((doc) => doc.get("actorUid") === requester.uid && doc.get("action") === "lab_support_ticket_created"));
  assert.deepEqual(new Set(logs.docs.map((doc) => doc.get("action"))), new Set([
    "lab_support_ticket_created",
    "lab_support_tickets_listed",
  ]));
});

test("NEXA admins can reply and resolve a ticket, with partner-visible history and audit", async () => {
  const requester = await createAuthUser();
  const administrator = await createAuthUser("nexa-admin");
  await verifyLaboratory(requester);
  process.env.NEXA_ADMIN_UIDS = administrator.uid;
  const created = await createTicket(requester);

  const queue = await readResponse(await adminTickets(makeRequest(administrator, "/api/admin/lab-support")));
  assert.equal(queue.status, 200);
  assert.equal(queue.body.tickets.length, 1);

  const reply = await readResponse(await adminAction(makeRequest(administrator, "/api/admin/lab-support", "POST", {
    ticketId: created.body.ticketId,
    action: "REPLY",
    message: "Nous vérifions cette commande et vous répondrons sous peu.",
  })));
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.status, "IN_PROGRESS");

  const providerDetail = await readResponse(await listProviderTickets(makeRequest(requester, `/api/lab-support/tickets?ticketId=${encodeURIComponent(created.body.ticketId)}`)));
  assert.equal(providerDetail.body.ticket.messages.length, 1);
  assert.equal(providerDetail.body.ticket.messages[0].message, "Nous vérifions cette commande et vous répondrons sous peu.");

  const resolved = await readResponse(await adminAction(makeRequest(administrator, "/api/admin/lab-support", "POST", {
    ticketId: created.body.ticketId,
    action: "SET_STATUS",
    status: "RESOLVED",
  })));
  assert.equal(resolved.status, 200);
  const providerList = await readResponse(await listProviderTickets(makeRequest(requester, "/api/lab-support/tickets")));
  assert.equal(providerList.body.tickets[0].status, "RESOLVED");
  const logs = await db.collection("adminAuditLogs").get();
  assert.deepEqual(new Set(logs.docs.map((doc) => doc.get("action"))), new Set([
    "lab_support_ticket_created",
    "lab_support_ticket_viewed",
    "lab_support_tickets_listed",
    "lab_support_ticket_replied",
    "lab_support_ticket_status_changed",
  ]));
});

test("rejects unverified laboratories, non-admin replies, and invalid ticket categories", async () => {
  const unverified = await createAuthUser("unverified-lab");
  const regularLab = await createAuthUser("regular-lab");
  await verifyLaboratory(regularLab);

  const unverifiedResult = await createTicket(unverified);
  const invalidCategory = await createTicket(regularLab, { category: "medical-record" });
  const nonAdmin = await readResponse(await adminAction(makeRequest(regularLab, "/api/admin/lab-support", "POST", {
    ticketId: "ticket_unavailable_001",
    action: "REPLY",
    message: "Réponse sans autorisation.",
  })));

  assert.equal(unverifiedResult.status, 403);
  assert.equal(unverifiedResult.body.code, "verified-laboratory-required");
  assert.equal(invalidCategory.status, 400);
  assert.equal(invalidCategory.body.code, "invalid-ticket");
  assert.equal(nonAdmin.status, 503);
  assert.equal(nonAdmin.body.code, "admin-access-not-configured");
  assert.equal((await db.collection("labSupportTickets").get()).size, 0);
});
