import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';
import { getFirebaseAdminDb } from '@/lib/firebase/admin';
import { MoncashGatewayError, readNexaMoncashCallback } from '@/lib/payments/smartcut-moncash.server';
import { settlePaidPayment } from '@/lib/payments/settlement.server';

function json(payload: Record<string, unknown>, status = 200) {
  return NextResponse.json(payload, { status, headers: { 'Cache-Control': 'no-store, max-age=0' } });
}

export async function POST(request: Request) {
  try {
    const callback = await readNexaMoncashCallback(request);
    const paymentRef = typeof callback.paymentRef === 'string' ? callback.paymentRef.trim() : '';
    const amount = Number(callback.amount);
    const currency = String(callback.currency || '').toUpperCase();
    const transactionId = typeof callback.transactionId === 'string' ? callback.transactionId.trim().slice(0, 120) : '';
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(paymentRef) || callback.status !== 'paid' || !Number.isSafeInteger(amount) || amount <= 0 || amount > 10_000_000 || currency !== 'HTG' || !transactionId) {
      throw new MoncashGatewayError(400, 'callback-payload-invalid');
    }

    const paymentRefDoc = getFirebaseAdminDb().collection('paymentIntents').doc(paymentRef);
    const result = await getFirebaseAdminDb().runTransaction(async (transaction) => {
      const snapshot = await transaction.get(paymentRefDoc);
      if (!snapshot.exists || Number(snapshot.get('amount')) !== amount || String(snapshot.get('currency') || '').toUpperCase() !== currency || String(snapshot.get('paymentMethod') || '').toUpperCase() !== 'MONCASH') {
        throw new MoncashGatewayError(404, 'payment-not-found');
      }
      if (snapshot.get('status') === 'paid') {
        return { status: 'paid', alreadyPaid: true };
      }
      if (!['created', 'awaiting_payment', 'payment_pending', 'initializing', 'pending', 'expired'].includes(String(snapshot.get('status') || '').toLowerCase())) {
        throw new MoncashGatewayError(409, 'payment-transition-invalid');
      }
      transaction.set(paymentRefDoc, {
        status: 'paid',
        paymentProvider: 'moncash',
        providerTransactionId: transactionId,
        paidAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { status: 'paid', alreadyPaid: false };
    });
    await settlePaidPayment(paymentRef);
    return json({ ok: true, paymentRef, ...result });
  } catch (error) {
    const status = error instanceof MoncashGatewayError ? error.status : 500;
    const code = error instanceof MoncashGatewayError ? error.code : 'callback-processing-failed';
    if (!(error instanceof MoncashGatewayError)) console.error('NEXA MonCash callback failed', error instanceof Error ? error.name : 'unknown-error');
    return json({ ok: false, code }, status);
  }
}
