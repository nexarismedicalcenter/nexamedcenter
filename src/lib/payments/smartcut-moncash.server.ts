import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;
const MAX_CALLBACK_BYTES = 12_000;

export class MoncashGatewayError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super('Le service de paiement est temporairement indisponible.');
    this.name = 'MoncashGatewayError';
    this.status = status;
    this.code = code;
  }
}

function getSecret(name: 'NEXA_TO_SMARTCUT_SIGNING_SECRET' | 'SMARTCUT_TO_NEXA_WEBHOOK_SECRET'): string {
  const secret = process.env[name]?.trim();
  if (!secret) throw new MoncashGatewayError(503, 'payment-gateway-not-configured');
  return secret;
}

function getFunctionUrl(name: 'SMARTCUT_MONCASH_CREATE_URL' | 'SMARTCUT_MONCASH_STATUS_URL'): URL {
  const configured = process.env[name];
  if (!configured) throw new MoncashGatewayError(503, 'payment-gateway-not-configured');
  let url: URL;
  try { url = new URL(configured); } catch { throw new MoncashGatewayError(503, 'payment-gateway-url-invalid'); }
  const localDevelopment = process.env.NODE_ENV !== 'production' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  const expectedPath = name === 'SMARTCUT_MONCASH_CREATE_URL'
    ? '/nexaMoncashCreatePayment'
    : '/nexaMoncashGetPaymentStatus';
  const region = process.env.SMARTCUT_MONCASH_REGION?.trim() || 'us-central1';
  const trustedProjectHost = /^[a-z]+-[a-z0-9-]+[0-9]$/.test(region) &&
    url.hostname === `${region}-smartcutservices-9ce54.cloudfunctions.net`;
  if (
    (!localDevelopment && (url.protocol !== 'https:' || !trustedProjectHost || url.port !== '')) ||
    url.pathname !== expectedPath || url.search || url.username || url.password || url.hash
  ) {
    throw new MoncashGatewayError(503, 'payment-gateway-url-invalid');
  }
  return url;
}

function signature(timestamp: string, rawBody: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(timestamp).update('.').update(rawBody).digest();
}

function validSignature(timestamp: string | null, suppliedSignature: string | null, rawBody: string, secret: string): boolean {
  if (!timestamp || !/^\d{13}$/.test(timestamp) || !suppliedSignature || !/^[a-f0-9]{64}$/i.test(suppliedSignature)) return false;
  const timestampValue = Number(timestamp);
  if (!Number.isSafeInteger(timestampValue) || Math.abs(Date.now() - timestampValue) > SIGNATURE_WINDOW_MS) return false;
  const expected = signature(timestamp, rawBody, secret);
  const supplied = Buffer.from(suppliedSignature, 'hex');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

async function callGateway(
  name: 'SMARTCUT_MONCASH_CREATE_URL' | 'SMARTCUT_MONCASH_STATUS_URL',
  body: Record<string, unknown>,
) {
  const requestSecret = getSecret('NEXA_TO_SMARTCUT_SIGNING_SECRET');
  const responseSecret = getSecret('SMARTCUT_TO_NEXA_WEBHOOK_SECRET');
  const rawBody = JSON.stringify(body);
  const timestamp = String(Date.now());
  const target = getFunctionUrl(name);
  let response: Response;
  try {
    response = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Nexa-Timestamp': timestamp,
        'X-Nexa-Signature': signature(timestamp, rawBody, requestSecret).toString('hex'),
      },
      body: rawBody,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new MoncashGatewayError(502, 'payment-gateway-unreachable');
  }

  const responseTimestamp = response.headers.get('x-nexa-timestamp');
  const responseSignature = response.headers.get('x-nexa-signature');
  const responseBody = await response.text();
  if (responseBody.length > 12_000 || !validSignature(responseTimestamp, responseSignature, responseBody, responseSecret)) {
    throw new MoncashGatewayError(502, 'payment-gateway-response-unverified');
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(responseBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid-response');
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new MoncashGatewayError(502, 'payment-gateway-response-invalid');
  }
  if (!response.ok || payload.ok !== true) {
    const errorCode = typeof payload.error === 'string' && /^[a-z0-9-]{1,80}$/.test(payload.error)
      ? payload.error
      : 'payment-gateway-request-failed';
    throw new MoncashGatewayError(response.status >= 400 && response.status < 500 ? response.status : 502, errorCode);
  }
  return payload;
}

export async function createSmartCutMoncashPayment(paymentRef: string, amount: number, currency: string) {
  return callGateway('SMARTCUT_MONCASH_CREATE_URL', { paymentRef, amount, currency });
}

export async function getSmartCutMoncashPaymentStatus(paymentRef: string) {
  return callGateway('SMARTCUT_MONCASH_STATUS_URL', { paymentRef });
}

export async function readNexaMoncashCallback(request: Request) {
  const secret = getSecret('SMARTCUT_TO_NEXA_WEBHOOK_SECRET');
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_CALLBACK_BYTES)) {
    throw new MoncashGatewayError(413, 'callback-payload-too-large');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new MoncashGatewayError(400, 'callback-body-invalid');
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_CALLBACK_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new MoncashGatewayError(413, 'callback-payload-too-large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let rawBody: string;
  try { rawBody = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new MoncashGatewayError(400, 'callback-body-invalid'); }
  if (!validSignature(
    request.headers.get('x-nexa-timestamp'),
    request.headers.get('x-nexa-signature'),
    rawBody,
    secret,
  )) {
    throw new MoncashGatewayError(401, 'callback-signature-invalid');
  }
  try {
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid-callback');
    return body;
  } catch {
    throw new MoncashGatewayError(400, 'callback-body-invalid');
  }
}
