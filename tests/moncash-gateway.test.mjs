import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, test } from "node:test";
import {
  createSmartCutMoncashPayment,
  getSmartCutMoncashPaymentStatus,
  MoncashGatewayError,
  readNexaMoncashCallback,
} from "../src/lib/payments/smartcut-moncash.server.ts";

const REQUEST_SECRET = "local-test-nexa-to-smartcut-secret";
const RESPONSE_SECRET = "local-test-smartcut-to-nexa-secret";
const PAYMENT_REF = "nexa_order_ref_12345678901234567890";
const savedEnvironment = new Map();
const originalFetch = globalThis.fetch;

function setEnvironment(name, value) {
  if (!savedEnvironment.has(name)) savedEnvironment.set(name, process.env[name]);
  process.env[name] = value;
}

function sign(timestamp, body, secret) {
  return createHmac("sha256", secret).update(timestamp).update(".").update(body).digest("hex");
}

function response(payload, secret = RESPONSE_SECRET, timestamp = String(Date.now())) {
  const body = JSON.stringify(payload);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Nexa-Timestamp": timestamp,
      "X-Nexa-Signature": sign(timestamp, body, secret),
    },
  });
}

function configureGateway() {
  setEnvironment("NEXA_TO_SMARTCUT_SIGNING_SECRET", REQUEST_SECRET);
  setEnvironment("SMARTCUT_TO_NEXA_WEBHOOK_SECRET", RESPONSE_SECRET);
  setEnvironment("SMARTCUT_MONCASH_REGION", "us-central1");
  setEnvironment("SMARTCUT_MONCASH_CREATE_URL", "https://us-central1-smartcutservices-9ce54.cloudfunctions.net/nexaMoncashCreatePayment");
  setEnvironment("SMARTCUT_MONCASH_STATUS_URL", "https://us-central1-smartcutservices-9ce54.cloudfunctions.net/nexaMoncashGetPaymentStatus");
  setEnvironment("NODE_ENV", "test");
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnvironment.clear();
});

test("MonCash creation signs only opaque reference, amount, and currency", async () => {
  configureGateway();
  let capturedBody = "";
  globalThis.fetch = async (_url, init) => {
    capturedBody = String(init.body);
    const timestamp = String(init.headers["X-Nexa-Timestamp"]);
    assert.equal(init.headers["X-Nexa-Signature"], sign(timestamp, capturedBody, REQUEST_SECRET));
    return response({
      ok: true,
      paymentRef: PAYMENT_REF,
      amount: 1250,
      currency: "HTG",
      status: "pending",
    });
  };

  const result = await createSmartCutMoncashPayment(PAYMENT_REF, 1250, "HTG");
  assert.deepEqual(JSON.parse(capturedBody), { paymentRef: PAYMENT_REF, amount: 1250, currency: "HTG" });
  assert.deepEqual(result, { ok: true, paymentRef: PAYMENT_REF, amount: 1250, currency: "HTG", status: "pending" });
});

test("MonCash URLs are restricted to the Smart Cut project and its exported functions", async () => {
  configureGateway();
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return response({ ok: true }); };

  setEnvironment("SMARTCUT_MONCASH_CREATE_URL", "https://us-central1-some-other-project.cloudfunctions.net/nexaMoncashCreatePayment");
  await assert.rejects(
    createSmartCutMoncashPayment(PAYMENT_REF, 1250, "HTG"),
    (error) => error instanceof MoncashGatewayError && error.status === 503 && error.code === "payment-gateway-url-invalid",
  );

  setEnvironment("SMARTCUT_MONCASH_CREATE_URL", "https://us-central1-smartcutservices-9ce54.cloudfunctions.net/otherFunction");
  await assert.rejects(
    createSmartCutMoncashPayment(PAYMENT_REF, 1250, "HTG"),
    (error) => error instanceof MoncashGatewayError && error.status === 503 && error.code === "payment-gateway-url-invalid",
  );

  setEnvironment("SMARTCUT_MONCASH_STATUS_URL", "https://us-central1-smartcutservices-9ce54.cloudfunctions.net/nexaMoncashCreatePayment");
  await assert.rejects(
    getSmartCutMoncashPaymentStatus(PAYMENT_REF),
    (error) => error instanceof MoncashGatewayError && error.status === 503 && error.code === "payment-gateway-url-invalid",
  );
  assert.equal(calls, 0);
});

test("MonCash responses with an expired signature fail closed", async () => {
  configureGateway();
  globalThis.fetch = async () => response(
    { ok: true, paymentRef: PAYMENT_REF, amount: 1250, currency: "HTG", status: "pending" },
    RESPONSE_SECRET,
    String(Date.now() - 6 * 60 * 1000),
  );

  await assert.rejects(
    createSmartCutMoncashPayment(PAYMENT_REF, 1250, "HTG"),
    (error) => error instanceof MoncashGatewayError && error.code === "payment-gateway-response-unverified",
  );
});

test("MonCash callbacks require a current HMAC signature", async () => {
  configureGateway();
  const body = JSON.stringify({ paymentRef: PAYMENT_REF, status: "paid", amount: 1250, currency: "HTG", transactionId: "simulated-transaction" });
  const timestamp = String(Date.now());
  const request = new Request("https://nexarishaiti.com/api/payments/moncash/callback", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Nexa-Timestamp": timestamp, "X-Nexa-Signature": sign(timestamp, body, RESPONSE_SECRET) },
    body,
  });
  assert.deepEqual(await readNexaMoncashCallback(request), JSON.parse(body));

  const invalidRequest = new Request("https://nexarishaiti.com/api/payments/moncash/callback", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Nexa-Timestamp": timestamp, "X-Nexa-Signature": "0".repeat(64) },
    body,
  });
  await assert.rejects(
    readNexaMoncashCallback(invalidRequest),
    (error) => error instanceof MoncashGatewayError && error.code === "callback-signature-invalid",
  );
});

test("MonCash callbacks are rejected before reading an oversized body", async () => {
  configureGateway();
  const request = new Request("https://nexarishaiti.com/api/payments/moncash/callback", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": "12001" },
    body: "{}",
  });
  await assert.rejects(
    readNexaMoncashCallback(request),
    (error) => error instanceof MoncashGatewayError && error.code === "callback-payload-too-large",
  );
});
