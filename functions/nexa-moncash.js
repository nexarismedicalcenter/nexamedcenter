"use strict";

const { createHmac, timingSafeEqual } = require("node:crypto");

const SIGNATURE_WINDOW_MS = 5 * 60 * 1_000;
const MAX_GATEWAY_RESPONSE_BYTES = 12_000;
const MAX_CALLBACK_BYTES = 12_000;
const CALLBACK_KEYS = new Set(["paymentRef", "status", "amount", "currency", "transactionId", "paidAt"]);
const REQUEST_PATHS = {
  SMARTCUT_MONCASH_CREATE_URL: "/nexaMoncashCreatePayment",
  SMARTCUT_MONCASH_STATUS_URL: "/nexaMoncashGetPaymentStatus",
};
const GATEWAY_RESPONSE_KEYS = {
  SMARTCUT_MONCASH_CREATE_URL: new Set(["ok", "paymentRef", "amount", "currency", "status", "checkoutUrl", "expiresAt"]),
  SMARTCUT_MONCASH_STATUS_URL: new Set(["ok", "paymentRef", "providerOrderId", "amount", "currency", "status", "transactionId", "paidAt", "callbackDeliveredAt", "checkoutUrl", "expiresAt"]),
};
const GATEWAY_ERROR_KEYS = new Set(["ok", "error"]);
const PAYMENT_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

function validateGatewayRequest(environmentKey, body) {
  const requiredKeys = environmentKey === "SMARTCUT_MONCASH_CREATE_URL"
    ? ["paymentRef", "amount", "currency"]
    : environmentKey === "SMARTCUT_MONCASH_STATUS_URL"
      ? ["paymentRef"]
      : null;
  if (!requiredKeys || !body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).sort().join(",") !== [...requiredKeys].sort().join(",") ||
    typeof body.paymentRef !== "string" || !PAYMENT_REFERENCE_PATTERN.test(body.paymentRef)) {
    throw new MoncashGatewayError(400, "payment-gateway-request-invalid");
  }
  if (environmentKey === "SMARTCUT_MONCASH_CREATE_URL" &&
    (!Number.isSafeInteger(body.amount) || body.amount < 1 || body.amount > 10_000_000 ||
      typeof body.currency !== "string" || !/^[A-Z]{3}$/.test(body.currency))) {
    throw new MoncashGatewayError(400, "payment-gateway-request-invalid");
  }
}

class MoncashGatewayError extends Error {
  constructor(status, code) {
    super("Le service de paiement est temporairement indisponible.");
    this.name = "MoncashGatewayError";
    this.status = status;
    this.code = code;
  }
}

function signature(timestamp, rawBody, secret) {
  return createHmac("sha256", secret)
    .update(String(timestamp))
    .update(".")
    .update(rawBody)
    .digest();
}

function validSignature(timestamp, suppliedSignature, rawBody, secret) {
  if (!/^\d{13}$/.test(String(timestamp || "")) || !/^[a-f0-9]{64}$/i.test(String(suppliedSignature || ""))) return false;
  const timestampValue = Number(timestamp);
  if (!Number.isSafeInteger(timestampValue) || Math.abs(Date.now() - timestampValue) > SIGNATURE_WINDOW_MS) return false;
  const expected = signature(timestamp, rawBody, secret);
  const supplied = Buffer.from(String(suppliedSignature), "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function getFunctionUrl(environmentKey) {
  const configured = String(process.env[environmentKey] || "").trim();
  if (!configured) throw new MoncashGatewayError(503, "payment-gateway-not-configured");
  let url;
  try { url = new URL(configured); } catch { throw new MoncashGatewayError(503, "payment-gateway-url-invalid"); }
  const path = REQUEST_PATHS[environmentKey];
  const region = String(process.env.SMARTCUT_MONCASH_REGION || "us-central1").trim();
  const trustedHost = /^[a-z]+-[a-z0-9-]+[0-9]$/.test(region) &&
    url.hostname === `${region}-smartcutservices-9ce54.cloudfunctions.net`;
  if (
    url.protocol !== "https:" || !trustedHost || url.port || url.pathname !== path ||
    url.search || url.username || url.password || url.hash
  ) throw new MoncashGatewayError(503, "payment-gateway-url-invalid");
  return url;
}

async function callSmartCut(environmentKey, body, requestSecret, responseSecret) {
  validateGatewayRequest(environmentKey, body);
  const requestKey = String(requestSecret || "").trim();
  const responseKey = String(responseSecret || "").trim();
  if (!requestKey || !responseKey) throw new MoncashGatewayError(503, "payment-gateway-not-configured");
  const rawBody = Buffer.from(JSON.stringify(body), "utf8");
  const timestamp = String(Date.now());
  const url = getFunctionUrl(environmentKey);
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Nexa-Timestamp": timestamp,
        "X-Nexa-Signature": signature(timestamp, rawBody, requestKey).toString("hex"),
      },
      body: rawBody,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new MoncashGatewayError(502, "payment-gateway-unreachable");
  }

  const responseTimestamp = response.headers.get("x-nexa-timestamp");
  const responseSignature = response.headers.get("x-nexa-signature");
  const responseBody = Buffer.from(await response.arrayBuffer());
  if (responseBody.length > MAX_GATEWAY_RESPONSE_BYTES || !validSignature(responseTimestamp, responseSignature, responseBody, responseKey)) {
    throw new MoncashGatewayError(502, "payment-gateway-response-unverified");
  }

  let payload;
  try {
    payload = JSON.parse(responseBody.toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid-response");
  } catch {
    throw new MoncashGatewayError(502, "payment-gateway-response-invalid");
  }
  const responseKeys = payload.ok === true ? GATEWAY_RESPONSE_KEYS[environmentKey] : GATEWAY_ERROR_KEYS;
  if (!responseKeys || Object.keys(payload).some((key) => !responseKeys.has(key))) {
    throw new MoncashGatewayError(502, "payment-gateway-response-invalid");
  }
  if (!response.ok || payload.ok !== true) {
    const code = typeof payload.error === "string" && /^[a-z0-9-]{1,80}$/.test(payload.error)
      ? payload.error
      : "payment-gateway-request-failed";
    throw new MoncashGatewayError(response.status >= 400 && response.status < 500 ? response.status : 502, code);
  }
  return payload;
}

function readSignedCallback(req, secret) {
  const key = String(secret || "").trim();
  if (!key) throw new MoncashGatewayError(503, "payment-gateway-not-configured");
  const declaredLength = req.get("Content-Length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_CALLBACK_BYTES)) {
    throw new MoncashGatewayError(413, "callback-payload-too-large");
  }
  const rawBody = Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : req.rawBody instanceof Uint8Array
      ? Buffer.from(req.rawBody)
      : null;
  if (!rawBody || rawBody.length > MAX_CALLBACK_BYTES) throw new MoncashGatewayError(413, "callback-payload-too-large");
  if (!validSignature(req.get("X-Nexa-Timestamp"), req.get("X-Nexa-Signature"), rawBody, key)) {
    throw new MoncashGatewayError(401, "callback-signature-invalid");
  }
  try {
    const payload = JSON.parse(rawBody.toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).some((key) => !CALLBACK_KEYS.has(key)) ||
      !Object.hasOwn(payload, "paymentRef") || !Object.hasOwn(payload, "status") ||
      !Object.hasOwn(payload, "amount") || !Object.hasOwn(payload, "currency") ||
      !Object.hasOwn(payload, "transactionId") || !Object.hasOwn(payload, "paidAt") ||
      typeof payload.paymentRef !== "string" || !PAYMENT_REFERENCE_PATTERN.test(payload.paymentRef) ||
      payload.status !== "paid" || !Number.isSafeInteger(payload.amount) || payload.amount < 1 || payload.amount > 10_000_000 ||
      payload.currency !== "HTG" || typeof payload.transactionId !== "string" ||
      !payload.transactionId.trim() || payload.transactionId.length > 120) {
      throw new Error("invalid-callback");
    }
    return payload;
  } catch {
    throw new MoncashGatewayError(400, "callback-body-invalid");
  }
}

module.exports = {
  MoncashGatewayError,
  callSmartCut,
  readSignedCallback,
};
