import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, beforeEach, test } from "node:test";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const projectId = "demo-nexaris";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || "";
const localHost = (value) => value && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(`http://${value.replace(/^https?:\/\//, "")}`).hostname);
if (!localHost(firestoreHost)) throw new Error("Refusing commission settings tests without the local Firestore Emulator.");

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const require = createRequire(import.meta.url);
const createNexaAdminFunctions = require("../functions/nexa-admin.js");
const app = initializeApp({ projectId }, "nexa-professional-commission-settings-tests");
const db = getFirestore(app);
const adminUid = "nexa-commission-settings-admin";
const endpoints = createNexaAdminFunctions({
  db,
  FieldValue,
  storage: { bucket: () => ({}) },
  ApiError,
  requireUser: async (req) => ({ uid: req.authUid }),
  requireAppCheckToken: async () => {},
  enforceUserRateLimit: async () => {},
  setCors: (_req, res) => { res.set("Access-Control-Allow-Origin", "https://nexarishaiti.com"); return true; },
  fail: (res, status, code, message) => res.status(status).json({ ok: false, code, error: message }),
  logger: { error() {}, warn() {} },
  createNexaNotification: async () => {},
  appointmentPaymentMatches: () => false,
  getTransactionFeePolicy: async () => null,
});

async function clearFirestoreEmulator() {
  const response = await fetch(`http://${firestoreHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: "DELETE" });
  assert.equal(response.ok, true, "Firestore Emulator must be available and clearable.");
}

function makeRequest({ method = "GET", uid = adminUid, body } = {}) {
  const rawBody = body === undefined ? Buffer.from("{}") : Buffer.from(JSON.stringify(body));
  return {
    method,
    authUid: uid,
    rawBody,
    get(name) { return name.toLowerCase() === "content-length" ? String(rawBody.length) : undefined; },
  };
}

function makeResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
  };
}

async function call(endpoint, options) {
  const response = makeResponse();
  await endpoint(makeRequest(options), response);
  return response;
}

beforeEach(async () => {
  process.env.NEXA_ADMIN_UIDS = adminUid;
  await clearFirestoreEmulator();
});

after(async () => { await deleteApp(app); });

test("commission settings start unset and do not create earnings or payout records", async () => {
  const response = await call(endpoints.nexaAdminProfessionalCommissionSettings);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.services, {
    teleconsultation: { configured: false, percentage: null, rateBps: null },
    doctor_appointment: { configured: false, percentage: null, rateBps: null },
    home_visit: { configured: false, percentage: null, rateBps: null },
    nursing_care: { configured: false, percentage: null, rateBps: null },
    pharmacy: { configured: false, percentage: null, rateBps: null },
    laboratory: { configured: false, percentage: null, rateBps: null },
    imaging: { configured: false, percentage: null, rateBps: null },
  });
  assert.equal((await db.collection("nexaPaymentSettings").get()).size, 0);
  assert.equal((await db.collection("nexaWalletLedger").get()).size, 0);
  assert.equal((await db.collection("nexaProfessionalPayouts").get()).size, 0);
});

test("only an allowlisted NEXA administrator may configure per-service rates", async () => {
  const denied = await call(endpoints.nexaAdminProfessionalCommissionSettings, {
    method: "POST",
    uid: "not-an-admin",
    body: { services: { teleconsultation: 5 } },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.code, "administrator-required");
  assert.equal((await db.doc("nexaPaymentSettings/professionalCommissions").get()).exists, false);

  process.env.NEXA_ADMIN_UIDS = "";
  const unconfigured = await call(endpoints.nexaAdminProfessionalCommissionSettings);
  assert.equal(unconfigured.statusCode, 503);
  assert.equal(unconfigured.body.code, "admin-access-not-configured");
});

test("rates are optional, service-specific configuration only and every save is audited", async () => {
  const saved = await call(endpoints.nexaAdminProfessionalCommissionSettings, {
    method: "POST",
    body: { services: {
      teleconsultation: 4.5,
      doctor_appointment: null,
      home_visit: 3,
      nursing_care: "",
      pharmacy: 0,
      laboratory: null,
      imaging: 7.25,
    } },
  });
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.services.teleconsultation.percentage, 4.5);
  assert.equal(saved.body.services.teleconsultation.rateBps, 450);
  assert.deepEqual(saved.body.services.doctor_appointment, { configured: false, percentage: null, rateBps: null });
  assert.equal(saved.body.services.home_visit.rateBps, 300);
  assert.deepEqual(saved.body.services.nursing_care, { configured: false, percentage: null, rateBps: null });
  assert.equal(saved.body.services.pharmacy.rateBps, 0);
  assert.equal(saved.body.services.imaging.rateBps, 725);

  const settings = await db.doc("nexaPaymentSettings/professionalCommissions").get();
  assert.equal(settings.get("serviceRates.teleconsultation.rateBps"), 450);
  assert.equal(settings.get("serviceRates.imaging.rateBps"), 725);
  assert.equal(settings.get("serviceRates.doctor_appointment"), undefined);

  const audit = await db.collection("adminAuditLogs").get();
  assert.equal(audit.size, 1);
  assert.equal(audit.docs[0].get("actorUid"), adminUid);
  assert.equal(audit.docs[0].get("action"), "professional_commission_rates_configured");
  assert.deepEqual(audit.docs[0].get("configuredServiceTypes").sort(), ["home_visit", "imaging", "pharmacy", "teleconsultation"]);

  assert.equal((await db.collection("nexaWalletLedger").get()).size, 0);
  assert.equal((await db.collection("nexaProfessionalPayouts").get()).size, 0);
});

test("invalid rates and unknown service types are rejected without writing", async () => {
  const invalidRate = await call(endpoints.nexaAdminProfessionalCommissionSettings, {
    method: "POST",
    body: { services: {
      teleconsultation: 101,
      doctor_appointment: null,
      home_visit: null,
      nursing_care: null,
      pharmacy: null,
      laboratory: null,
      imaging: null,
    } },
  });
  assert.equal(invalidRate.statusCode, 400);
  assert.equal(invalidRate.body.code, "invalid-professional-commission-rate");

  const unknownType = await call(endpoints.nexaAdminProfessionalCommissionSettings, {
    method: "POST",
    body: { services: {
      teleconsultation: null,
      doctor_appointment: null,
      home_visit: null,
      nursing_care: null,
      pharmacy: null,
      laboratory: null,
      imaging: null,
      withdrawal: 1,
    } },
  });
  assert.equal(unknownType.statusCode, 400);
  assert.equal(unknownType.body.code, "invalid-professional-commission-settings");
  assert.equal((await db.doc("nexaPaymentSettings/professionalCommissions").get()).exists, false);
  assert.equal((await db.collection("adminAuditLogs").get()).size, 0);
});
