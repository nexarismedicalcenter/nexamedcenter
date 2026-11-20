import "server-only";

import { randomBytes } from "node:crypto";
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

const PAYMENT_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
const MAX_PAYMENT_AMOUNT_HTG = 10_000_000;

export type PaymentResourceType = "appointment" | "pharmacy-order" | "laboratory-order" | "imaging-order";

export class PaymentIntentError extends Error {
  readonly code: "invalid-amount" | "invalid-resource" | "resource-not-found" | "resource-owner-mismatch" | "payment-intent-conflict";

  constructor(code: PaymentIntentError["code"]) {
    super("L’intention de paiement ne peut pas être créée pour cette ressource.");
    this.code = code;
    this.name = "PaymentIntentError";
  }
}

export async function createPaymentIntentForResource(input: {
  ownerUid: string;
  resourceType: PaymentResourceType;
  resourceRef: DocumentReference;
  amount: number;
}) {
  const ownerUid = input.ownerUid.trim();
  const amount = input.amount;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_PAYMENT_AMOUNT_HTG) {
    throw new PaymentIntentError("invalid-amount");
  }
  if (!ownerUid || !input.resourceRef.id || !input.resourceRef.path) {
    throw new PaymentIntentError("invalid-resource");
  }

  const db = getFirebaseAdminDb();
  const intentCollection = db.collection("paymentIntents");
  return db.runTransaction(async (transaction) => {
    const resourceSnapshot = await transaction.get(input.resourceRef);
    if (!resourceSnapshot.exists) throw new PaymentIntentError("resource-not-found");
    const resource = resourceSnapshot.data() || {};
    const resourceOwner = String(resource.patientUid || resource.uid || "");
    if (resourceOwner !== ownerUid) throw new PaymentIntentError("resource-owner-mismatch");

    const priorPaymentRef = typeof resource.moncashPaymentRef === "string" ? resource.moncashPaymentRef : "";
    if (PAYMENT_REFERENCE_PATTERN.test(priorPaymentRef)) {
      const priorRef = intentCollection.doc(priorPaymentRef);
      const priorSnapshot = await transaction.get(priorRef);
      if (priorSnapshot.exists) {
        const prior = priorSnapshot.data() || {};
        if (
          prior.uid !== ownerUid ||
          prior.resourceType !== input.resourceType ||
          prior.resourcePath !== input.resourceRef.path ||
          prior.amount !== amount ||
          prior.currency !== "HTG" ||
          prior.paymentMethod !== "MONCASH"
        ) {
          throw new PaymentIntentError("payment-intent-conflict");
        }
        return {
          paymentRef: priorPaymentRef,
          status: String(prior.status || "created"),
          amount,
          currency: "HTG" as const,
        };
      }
    }

    const paymentRef = randomBytes(24).toString("base64url");
    if (!PAYMENT_REFERENCE_PATTERN.test(paymentRef)) throw new PaymentIntentError("invalid-resource");
    const intentRef = intentCollection.doc(paymentRef);
    transaction.create(intentRef, {
      uid: ownerUid,
      paymentMethod: "MONCASH",
      resourceType: input.resourceType,
      resourcePath: input.resourceRef.path,
      amount,
      currency: "HTG",
      status: "created",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    transaction.set(input.resourceRef, {
      moncashPaymentRef: paymentRef,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { paymentRef, status: "created", amount, currency: "HTG" as const };
  });
}
