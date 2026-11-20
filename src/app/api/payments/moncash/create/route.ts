import { FieldValue } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from '@/lib/auth/server';
import { getFirebaseAdminDb } from '@/lib/firebase/admin';
import { createSmartCutMoncashPayment, MoncashGatewayError } from '@/lib/payments/smartcut-moncash.server';
import { settlePaidPayment } from '@/lib/payments/settlement.server';
import { appointmentPaymentMatches, nexaOrderPaymentMatches } from '@/lib/payments/transaction-fees.server';

const paymentRefPattern = /^[A-Za-z0-9_-]{20,64}$/;
const moncashHosts = new Set(['moncashbutton.digicelgroup.com']);

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError || error instanceof MoncashGatewayError ? error.status : 500;
  const code = error instanceof ApiRequestError || error instanceof MoncashGatewayError ? error.code : 'payment-initialization-failed';
  const message = error instanceof ApiRequestError ? error.message : 'Le paiement ne peut pas être préparé pour le moment.';
  if (!(error instanceof ApiRequestError) && !(error instanceof MoncashGatewayError)) {
    console.error('NEXA MonCash initialization failed', error instanceof Error ? error.name : 'unknown-error');
  }
  const headers = new Headers({ 'Cache-Control': 'no-store, max-age=0' });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function safeCheckoutUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && moncashHosts.has(url.hostname) ? url.toString() : null;
  } catch { return null; }
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
    if (intent.resourceType === 'appointment') {
      const match = typeof intent.resourcePath === 'string' ? intent.resourcePath.match(/^appointments\/([A-Za-z0-9_-]{1,200})$/) : null;
      if (!match) throw new ApiRequestError(409, 'appointment-payment-invalid', 'Ce paiement n’est plus associé à un rendez-vous valide.');
      const appointment = await db.collection('appointments').doc(match[1]).get();
      const slotId = typeof appointment.get('slotId') === 'string' ? appointment.get('slotId') as string : '';
      const slot = slotId ? await db.collection('providerAvailabilitySlots').doc(slotId).get() : null;
      if (
        !appointment.exists || appointment.get('patientUid') !== user.uid || !appointmentPaymentMatches(appointment.data() || {}, intent) ||
        appointment.get('status') !== 'PENDING_PAYMENT' || !slot?.exists ||
        slot.get('appointmentId') !== appointment.id || slot.get('status') !== 'held' ||
        Number(slot.get('holdExpiresAt')) <= Date.now()
      ) {
        throw new ApiRequestError(409, 'appointment-hold-expired', 'La réservation temporaire a expiré. Choisissez un nouveau créneau avant de payer.');
      }
    } else {
      const resourceKinds: Record<string, string> = {
        'pharmacy-order': 'pharmacy',
        'laboratory-order': 'laboratory',
        'imaging-order': 'imaging',
      };
      const expectedKind = resourceKinds[String(intent.resourceType || '')];
      const match = typeof intent.resourcePath === 'string' ? intent.resourcePath.match(/^nexaOrders\/([A-Za-z0-9_-]{1,200})$/) : null;
      if (!expectedKind || !match) throw new ApiRequestError(409, 'payment-resource-invalid', 'Ce paiement n’est pas associé à une commande NEXA valide.');
      const order = await db.collection('nexaOrders').doc(match[1]).get();
      if (
        !order.exists || order.get('patientUid') !== user.uid || order.get('kind') !== expectedKind ||
        order.get('moncashPaymentRef') !== paymentRef || !nexaOrderPaymentMatches(order.data() || {}, intent) ||
        String(order.get('currency') || '').toUpperCase() !== currency ||
        order.get('status') !== 'PENDING_PAYMENT' || order.get('paymentStatus') !== 'PENDING' ||
        (Number(order.get('holdExpiresAt')) > 0 && Number(order.get('holdExpiresAt')) <= Date.now())
      ) throw new ApiRequestError(409, 'order-not-payable', 'Cette commande a expiré ou n’est plus disponible au paiement.');
    }
    let existingCheckoutUrl: string | null = null;
    let alreadyPaid = false;
    const createAttemptId = randomUUID();
    await db.runTransaction(async (transaction) => {
      const fresh = await transaction.get(paymentRefDoc);
      if (!fresh.exists || fresh.get('uid') !== user.uid || String(fresh.get('paymentMethod') || '').toUpperCase() !== 'MONCASH') {
        throw new ApiRequestError(404, 'payment-not-found', 'Le paiement n’a pas été trouvé.');
      }
      if (fresh.get('status') === 'paid') {
        alreadyPaid = true;
        return;
      }
      const currentStatus = String(fresh.get('status') || '').toLowerCase();
      if (currentStatus === 'pending' && fresh.get('checkoutUrl')) {
        existingCheckoutUrl = safeCheckoutUrl(fresh.get('checkoutUrl'));
        if (existingCheckoutUrl) return;
      }
      if (!['created', 'awaiting_payment', 'payment_pending', 'initializing', 'pending'].includes(currentStatus)) {
        throw new ApiRequestError(409, 'payment-intent-not-payable', 'Ce paiement n’est pas disponible.');
      }
      const startedAt = fresh.get('moncashCreateAttemptStartedAt');
      const startedAtMs = startedAt && typeof startedAt === 'object' && 'toMillis' in startedAt && typeof startedAt.toMillis === 'function'
        ? (startedAt.toMillis() as number)
        : 0;
      if (currentStatus === 'initializing' && fresh.get('moncashCreateAttemptId') && startedAtMs && Date.now() - startedAtMs < 60_000) {
        throw new ApiRequestError(409, 'payment-initializing', 'La préparation du paiement est en cours. Réessayez dans quelques instants.');
      }
      transaction.set(paymentRefDoc, {
        status: 'initializing',
        moncashCreateAttemptId: createAttemptId,
        moncashCreateAttemptStartedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    if (alreadyPaid) {
      await settlePaidPayment(paymentRef);
      return json(request, { ok: true, paymentRef, status: 'paid' });
    }
    if (existingCheckoutUrl) return json(request, { ok: true, paymentRef, status: 'pending', amount, currency, checkoutUrl: existingCheckoutUrl });

    const gateway = await createSmartCutMoncashPayment(paymentRef, amount, currency);
    const checkoutUrl = safeCheckoutUrl(gateway.checkoutUrl);
    const gatewayStatus = String(gateway.status || '').toLowerCase();
    if (
      gateway.paymentRef !== paymentRef ||
      Number(gateway.amount) !== amount ||
      String(gateway.currency || '').toUpperCase() !== currency ||
      !['pending', 'paid'].includes(gatewayStatus) ||
      (gatewayStatus === 'pending' && !checkoutUrl)
    ) {
      throw new MoncashGatewayError(502, 'payment-gateway-response-invalid');
    }

    let effectiveStatus = gatewayStatus;
    await db.runTransaction(async (transaction) => {
      const fresh = await transaction.get(paymentRefDoc);
      if (!fresh.exists || fresh.get('uid') !== user.uid || String(fresh.get('paymentMethod') || '').toUpperCase() !== 'MONCASH') {
        throw new ApiRequestError(404, 'payment-not-found', 'Le paiement n’a pas été trouvé.');
      }
      if (fresh.get('status') === 'paid') {
        if (String(fresh.get('paymentMethod') || '').toUpperCase() !== 'MONCASH') {
          throw new ApiRequestError(409, 'payment-method-changed', 'Le mode de paiement a changé. Actualisez l’état de la commande.');
        }
        effectiveStatus = 'paid';
        return;
      }
      if (fresh.get('moncashCreateAttemptId') !== createAttemptId) {
        throw new ApiRequestError(409, 'payment-initialization-changed', 'La préparation de ce paiement a changé. Vérifiez son état avant de réessayer.');
      }
      const currentStatus = String(fresh.get('status') || '').toLowerCase();
      if (!['created', 'awaiting_payment', 'payment_pending', 'initializing', 'pending'].includes(currentStatus)) {
        throw new ApiRequestError(409, 'payment-transition-invalid', 'Le statut de ce paiement a changé.');
      }
      effectiveStatus = gatewayStatus;
      transaction.set(paymentRefDoc, {
        status: effectiveStatus,
        ...(effectiveStatus === 'pending' ? { checkoutUrl } : {}),
        paymentProvider: 'moncash',
        gateway: 'smartcut-moncash',
        ...(effectiveStatus === 'paid' ? { paidAt: fresh.get('paidAt') || FieldValue.serverTimestamp() } : {}),
        moncashCreateAttemptId: FieldValue.delete(),
        moncashCreateAttemptStartedAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    if (effectiveStatus === 'paid') await settlePaidPayment(paymentRef);
    return json(request, {
      ok: true,
      paymentRef,
      amount,
      currency,
      status: effectiveStatus,
      ...(effectiveStatus === 'pending' ? { checkoutUrl } : {}),
    });
  } catch (error) {
    return fail(request, error);
  }
}
