import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from '@/lib/auth/server';
import { getFirebaseAdminDb } from '@/lib/firebase/admin';
import { getSmartCutMoncashPaymentStatus, MoncashGatewayError } from '@/lib/payments/smartcut-moncash.server';
import { settlePaidPayment } from '@/lib/payments/settlement.server';

const paymentRefPattern = /^[A-Za-z0-9_-]{20,64}$/;
const moncashHosts = new Set(['moncashbutton.digicelgroup.com']);

function safeCheckoutUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && moncashHosts.has(url.hostname) ? url : null;
  } catch { return null; }
}

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError || error instanceof MoncashGatewayError ? error.status : 500;
  const code = error instanceof ApiRequestError || error instanceof MoncashGatewayError ? error.code : 'payment-status-unavailable';
  const message = error instanceof ApiRequestError ? error.message : 'Le statut du paiement ne peut pas être vérifié pour le moment.';
  if (!(error instanceof ApiRequestError) && !(error instanceof MoncashGatewayError)) {
    console.error('NEXA MonCash status failed', error instanceof Error ? error.name : 'unknown-error');
  }
  const headers = new Headers({ 'Cache-Control': 'no-store, max-age=0' });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    const body = await request.json().catch(() => null);
    const paymentRef = body && typeof body === 'object' && !Array.isArray(body) && typeof body.paymentRef === 'string'
      ? body.paymentRef.trim()
      : '';
    if (!paymentRefPattern.test(paymentRef)) throw new ApiRequestError(400, 'invalid-payment-reference', 'La référence de paiement n’est pas valide.');

    const db = getFirebaseAdminDb();
    const paymentRefDoc = db.collection('paymentIntents').doc(paymentRef);
    const snapshot = await paymentRefDoc.get();
    if (!snapshot.exists || snapshot.get('uid') !== user.uid || String(snapshot.get('paymentMethod') || '').toUpperCase() !== 'MONCASH') {
      throw new ApiRequestError(404, 'payment-not-found', 'Le paiement n’a pas été trouvé.');
    }
    const intent = snapshot.data() || {};
    const amount = Number(intent.amount);
    const currency = String(intent.currency || '').toUpperCase();
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 10_000_000 || currency !== 'HTG') {
      throw new ApiRequestError(409, 'payment-intent-invalid', 'Le montant de ce paiement n’est pas valide.');
    }
    if (intent.status === 'paid') {
      await settlePaidPayment(paymentRef);
      return json(request, { ok: true, paymentRef, status: 'paid' });
    }

    const gateway = await getSmartCutMoncashPaymentStatus(paymentRef);
    const gatewayAmount = Number(gateway.amount);
    const gatewayStatus = String(gateway.status || '').toLowerCase();
    const safeGatewayCheckoutUrl = safeCheckoutUrl(gateway.checkoutUrl);
    if (
      gateway.paymentRef !== paymentRef ||
      gatewayAmount !== amount ||
      String(gateway.currency || '').toUpperCase() !== currency ||
      !['pending', 'paid', 'creating', 'creation_uncertain', 'creation_failed'].includes(gatewayStatus) ||
      (gateway.checkoutUrl && !safeGatewayCheckoutUrl) ||
      (gatewayStatus === 'paid' && !(typeof gateway.transactionId === 'string' && gateway.transactionId.trim()))
    ) {
      throw new MoncashGatewayError(502, 'payment-gateway-response-invalid');
    }

    let status = gatewayStatus;
    await db.runTransaction(async (transaction) => {
      const fresh = await transaction.get(paymentRefDoc);
      if (!fresh.exists || fresh.get('uid') !== user.uid || String(fresh.get('paymentMethod') || '').toUpperCase() !== 'MONCASH') {
        throw new ApiRequestError(404, 'payment-not-found', 'Le paiement n’a pas été trouvé.');
      }
      if (fresh.get('status') === 'paid') {
        status = 'paid';
        return;
      }
      const currentStatus = String(fresh.get('status') || '').toLowerCase();
      if (!['created', 'awaiting_payment', 'payment_pending', 'initializing', 'pending', 'creating', 'creation_uncertain', 'creation_failed', 'expired'].includes(currentStatus)) {
        throw new ApiRequestError(409, 'payment-transition-invalid', 'Le statut de ce paiement a changé.');
      }
      if (currentStatus === 'expired' && status !== 'paid') {
        status = 'creation_failed';
        return;
      }
      transaction.set(paymentRefDoc, {
        status,
        paymentProvider: 'moncash',
        ...(status === 'paid' && typeof gateway.transactionId === 'string'
          ? { providerTransactionId: gateway.transactionId.trim().slice(0, 120), paidAt: fresh.get('paidAt') || FieldValue.serverTimestamp() }
          : {}),
        ...(status === 'pending' && safeGatewayCheckoutUrl ? { checkoutUrl: safeGatewayCheckoutUrl.toString() } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    if (status === 'paid') await settlePaidPayment(paymentRef);
    return json(request, {
      ok: true,
      paymentRef,
      status,
      amount,
      currency,
      transactionId: typeof gateway.transactionId === 'string' ? gateway.transactionId.slice(0, 120) : null,
      ...(status === 'pending' && safeGatewayCheckoutUrl ? { checkoutUrl: safeGatewayCheckoutUrl.toString() } : {}),
    });
  } catch (error) {
    return fail(request, error);
  }
}
