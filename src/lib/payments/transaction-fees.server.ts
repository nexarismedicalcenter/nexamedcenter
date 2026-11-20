import "server-only";

import { getFirebaseAdminDb } from "@/lib/firebase/admin";

export const TRANSACTION_FEE_SETTINGS_PATH = "nexaPaymentSettings/transactionFees";
export const DEFAULT_TRANSACTION_FEE = { active: true, rateBps: 350 } as const;

export type TransactionFeePolicy = { active: boolean; rateBps: number };
export type TransactionAmounts = { serviceAmount: number; feeAmount: number; totalAmount: number; feeRateBps: number; feeRecipient: "NEXARIS" };

export async function getTransactionFeePolicy(serviceType = "allServices"): Promise<TransactionFeePolicy> {
  const snapshot = await getFirebaseAdminDb().doc(TRANSACTION_FEE_SETTINGS_PATH).get();
  if (!snapshot.exists) return DEFAULT_TRANSACTION_FEE;
  const serviceOverrides = snapshot.get("serviceOverrides");
  const configuredOverride = serviceOverrides && typeof serviceOverrides === "object" && !Array.isArray(serviceOverrides)
    ? serviceOverrides[serviceType]
    : null;
  const legacyServiceOverride = serviceType !== "allServices" && serviceType !== "teleconsultation"
    ? snapshot.get(serviceType)
    : null;
  const entry = (serviceType !== "allServices" ? configuredOverride || legacyServiceOverride : null) || snapshot.get("allServices") || snapshot.get("teleconsultation");
  if (!entry) return DEFAULT_TRANSACTION_FEE;
  if (typeof entry !== "object" || Array.isArray(entry)) return DEFAULT_TRANSACTION_FEE;
  const value = entry as Record<string, unknown>;
  const rateBps = Number(value.rateBps);
  if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > 10_000) return DEFAULT_TRANSACTION_FEE;
  return { active: value.active === true, rateBps };
}

export function calculateTransactionAmounts(serviceAmount: number, policy: TransactionFeePolicy): TransactionAmounts {
  if (!Number.isSafeInteger(serviceAmount) || serviceAmount < 0 || serviceAmount > 10_000_000) throw new RangeError("Service amount is outside the supported range.");
  const feeRateBps = policy.active ? policy.rateBps : 0;
  const feeAmount = Math.round(serviceAmount * feeRateBps / 10_000);
  const totalAmount = serviceAmount + feeAmount;
  if (!Number.isSafeInteger(totalAmount) || totalAmount > 10_000_000) throw new RangeError("Transaction total is outside the supported range.");
  return { serviceAmount, feeAmount, totalAmount, feeRateBps, feeRecipient: "NEXARIS" };
}

export function appointmentPaymentMatches(appointment: Record<string, unknown>, payment: Record<string, unknown>) {
  const serviceAmount = Number(appointment.amount);
  const feeAmount = Number(appointment.transactionFee ?? 0);
  const totalAmount = Number(appointment.totalAmount ?? serviceAmount);
  const paymentAmount = Number(payment.amount);
  const paymentServiceAmount = Number(payment.serviceAmount ?? payment.resourceAmount ?? paymentAmount);
  const paymentFeeAmount = Number(payment.transactionFee ?? 0);
  return Number.isSafeInteger(serviceAmount) && serviceAmount > 0 && Number.isSafeInteger(feeAmount) && feeAmount >= 0 &&
    Number.isSafeInteger(totalAmount) && totalAmount === serviceAmount + feeAmount && paymentAmount === totalAmount &&
    paymentServiceAmount === serviceAmount && paymentFeeAmount === feeAmount;
}

export function nexaOrderPaymentMatches(order: Record<string, unknown>, payment: Record<string, unknown>) {
  const serviceAmount = Number(order.amount);
  const feeAmount = Number(order.transactionFee ?? 0);
  const totalAmount = Number(order.totalAmount ?? serviceAmount);
  const paymentAmount = Number(payment.amount);
  const paymentServiceAmount = Number(payment.serviceAmount ?? payment.resourceAmount ?? paymentAmount);
  const paymentFeeAmount = Number(payment.transactionFee ?? 0);
  return Number.isSafeInteger(serviceAmount) && serviceAmount >= 0 && Number.isSafeInteger(feeAmount) && feeAmount >= 0 &&
    Number.isSafeInteger(totalAmount) && totalAmount === serviceAmount + feeAmount && paymentAmount === totalAmount &&
    paymentServiceAmount === serviceAmount && paymentFeeAmount === feeAmount;
}
