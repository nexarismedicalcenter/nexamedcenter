import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { createUserNotification } from "@/lib/notifications.server";
import { settlePaidPayment } from "@/lib/payments/settlement.server";
import { nexaOrderPaymentMatches } from "@/lib/payments/transaction-fees.server";

const PAYMENT_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
const PAYMENT_RESOURCE_TYPES: Record<string, string> = {
  pharmacy: "pharmacy-order",
  laboratory: "laboratory-order",
  imaging: "imaging-order",
};

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "wallet-order-payment-failed";
  const message = error instanceof ApiRequestError ? error.message : "Le paiement de cette commande par portefeuille NEXA n’a pas abouti.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA wallet order payment failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "pay-order-wallet", limit: 8, windowMs: 5 * 60_000 });
    const { orderId } = await params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(orderId)) throw new ApiRequestError(400, "invalid-order", "La référence de commande n’est pas valide.");

    const db = getFirebaseAdminDb();
    const orderRef = db.collection("nexaOrders").doc(orderId);
    const outcome = await db.runTransaction(async (transaction) => {
      const orderSnapshot = await transaction.get(orderRef);
      if (!orderSnapshot.exists || orderSnapshot.get("patientUid") !== user.uid) throw new ApiRequestError(404, "order-not-found", "Cette commande n’est pas accessible.");
      const order = orderSnapshot.data() || {};
      const paymentRef = typeof order.moncashPaymentRef === "string" ? order.moncashPaymentRef : "";
      const expectedResourceType = PAYMENT_RESOURCE_TYPES[String(order.kind || "")];
      if (!expectedResourceType || !PAYMENT_REFERENCE_PATTERN.test(paymentRef)) throw new ApiRequestError(409, "order-payment-invalid", "Le paiement de cette commande ne peut pas être vérifié.");

      const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
      const walletRef = db.collection("nexaPatientWallets").doc(user.uid);
      const profileRef = db.collection("patientProfiles").doc(user.uid);
      const ledgerId = createHash("sha256").update(`NEXA_WALLET_ORDER:${orderId}`).digest("hex");
      const ledgerRef = db.collection("nexaWalletLedger").doc(ledgerId);
      const feeLedgerRef = db.collection("nexaTransactionFeeLedger").doc(paymentRef);
      const eventRef = db.collection("nexaOrderEvents").doc();
      const [paymentSnapshot, walletSnapshot, profileSnapshot, ledgerSnapshot, feeLedgerSnapshot] = await Promise.all([
        transaction.get(paymentRefDoc), transaction.get(walletRef), transaction.get(profileRef), transaction.get(ledgerRef), transaction.get(feeLedgerRef),
      ]);
      if (!paymentSnapshot.exists) throw new ApiRequestError(409, "order-payment-invalid", "La référence de paiement n’existe plus.");
      const payment = paymentSnapshot.data() || {};
      const amount = Number(order.amount);
      const transactionFee = Number(order.transactionFee) || 0;
      const totalAmount = Number(order.totalAmount ?? amount + transactionFee);
      const serviceAmountMinor = Math.round(amount * 100);
      const transactionFeeMinor = Math.round(transactionFee * 100);
      const amountMinor = Math.round(totalAmount * 100);
      const paymentMatches = payment.uid === user.uid && payment.resourceType === expectedResourceType && payment.resourcePath === orderRef.path &&
        nexaOrderPaymentMatches(order, payment) && String(payment.currency || "").toUpperCase() === "HTG" && String(order.currency || "").toUpperCase() === "HTG";
      if (!paymentMatches || !Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(transactionFee) || transactionFee < 0 || !Number.isSafeInteger(totalAmount) || totalAmount > 10_000_000) throw new ApiRequestError(409, "order-payment-invalid", "Le montant de cette commande ne peut pas être vérifié.");
      const feeLedgerMatches = transactionFee === 0
        ? !feeLedgerSnapshot.exists
        : feeLedgerSnapshot.exists && feeLedgerSnapshot.get("paymentRef") === paymentRef && feeLedgerSnapshot.get("resourceType") === expectedResourceType &&
          feeLedgerSnapshot.get("resourceId") === orderId && Number(feeLedgerSnapshot.get("serviceAmountMinor")) === serviceAmountMinor &&
          Number(feeLedgerSnapshot.get("amountMinor")) === transactionFeeMinor && feeLedgerSnapshot.get("recipient") === "NEXARIS" &&
          feeLedgerSnapshot.get("paymentMethod") === "SMART_WALLET" && feeLedgerSnapshot.get("status") === "COMPLETED";
      if (feeLedgerSnapshot.exists && !feeLedgerMatches) throw new ApiRequestError(409, "transaction-fee-ledger-conflict", "Le registre des frais et le paiement de la commande ne concordent pas.");

      if (payment.status === "paid" && payment.paymentMethod === "MONCASH") {
        if (order.paymentStatus === "REFUNDED" || order.status === "REFUNDED") throw new ApiRequestError(409, "order-refunded", "Cette commande a déjà été remboursée.");
        return { paymentRef, ledgerId: "", amount, transactionFee, totalAmount, alreadyPaid: true, needsSettlement: order.settlementStatus !== "CONFIRMED", paymentMethod: "MONCASH" as const, patientUid: user.uid, providerUid: String(order.providerUid || ""), orderStatus: String(order.status || "") };
      }
      if (ledgerSnapshot.exists) {
        const existingLedger = ledgerSnapshot.data() || {};
        if (existingLedger.userUid !== user.uid || existingLedger.resourceType !== expectedResourceType || existingLedger.resourceId !== orderId || existingLedger.direction !== "DEBIT" || Number(existingLedger.amountMinor) !== amountMinor || Number(existingLedger.serviceAmountMinor) !== serviceAmountMinor || Number(existingLedger.transactionFeeMinor || 0) !== transactionFeeMinor || !feeLedgerMatches || payment.status !== "paid" || payment.paymentMethod !== "SMART_WALLET") {
          throw new ApiRequestError(409, "wallet-ledger-conflict", "Le registre du portefeuille et le paiement de la commande ne concordent pas.");
        }
        return { paymentRef, ledgerId, amount, transactionFee, totalAmount, alreadyPaid: true, needsSettlement: false, paymentMethod: "SMART_WALLET" as const, patientUid: user.uid, providerUid: String(order.providerUid || ""), orderStatus: String(order.status || "") };
      }

      if (!profileSnapshot.exists || profileSnapshot.get("role") !== "patient" || profileSnapshot.get("profileComplete") !== true) throw new ApiRequestError(403, "complete-patient-profile-required", "Un profil patient NEXA complet est requis.");
      if (order.status !== "PENDING_PAYMENT" || order.paymentStatus !== "PENDING" || order.settlementStatus !== "PENDING" || order.refundRequired === true) throw new ApiRequestError(409, "order-not-payable", "Cette commande n’accepte plus de paiement par portefeuille.");
      if (payment.status !== "created" || payment.paymentMethod !== "MONCASH") throw new ApiRequestError(409, "payment-method-already-started", "Un paiement externe a déjà été commencé. Terminez ou faites vérifier ce paiement avant de choisir le portefeuille.");
      const holdExpiresAt = Number(order.holdExpiresAt || 0);
      if (holdExpiresAt && holdExpiresAt <= Date.now()) throw new ApiRequestError(409, "order-hold-expired", "La retenue de cette commande a expiré. Préparez une nouvelle commande.");

      const wallet = walletSnapshot.data() || {};
      const availableMinor = Number(wallet.availableMinor || 0);
      const reservedMinor = Number(wallet.reservedMinor || 0);
      if (!walletSnapshot.exists || wallet.status !== "ACTIVE" || wallet.currency !== "HTG" || !Number.isSafeInteger(availableMinor) || availableMinor < amountMinor || !Number.isSafeInteger(reservedMinor) || reservedMinor < 0) {
        throw new ApiRequestError(409, "insufficient-wallet-balance", "Le portefeuille NEXA est suspendu ou son solde disponible est insuffisant.");
      }

      const now = FieldValue.serverTimestamp();
      transaction.update(walletRef, { availableMinor: availableMinor - amountMinor, updatedAt: now });
      transaction.create(ledgerRef, {
        userUid: user.uid,
        walletId: user.uid,
        type: `${String(order.kind).toUpperCase()}_ORDER_PAYMENT`,
        direction: "DEBIT",
        amountMinor,
        serviceAmountMinor,
        transactionFeeMinor,
        currency: "HTG",
        resourceType: expectedResourceType,
        resourceId: orderId,
        paymentRef,
        source: "NEXA",
        status: "COMPLETED",
        createdAt: now,
      });
      if (transactionFee > 0) transaction.create(feeLedgerRef, {
        paymentRef,
        resourceType: expectedResourceType,
        resourceId: orderId,
        serviceAmountMinor,
        amountMinor: transactionFeeMinor,
        currency: "HTG",
        recipient: "NEXARIS",
        transactionFeeRateBps: Number(order.transactionFeeRateBps) || 0,
        paymentMethod: "SMART_WALLET",
        status: "COMPLETED",
        createdAt: now,
      });
      transaction.set(paymentRefDoc, {
        status: "paid",
        paymentMethod: "SMART_WALLET",
        paymentProvider: "nexa-wallet",
        walletLedgerId: ledgerId,
        paidAt: now,
        updatedAt: now,
      }, { merge: true });
      transaction.set(orderRef, {
        status: "PAID",
        paymentStatus: "PAID",
        paymentMethod: "SMART_WALLET",
        settlementStatus: "CONFIRMED",
        paidAt: now,
        updatedAt: now,
      }, { merge: true });
      transaction.create(eventRef, {
        orderId,
        fromStatus: "PENDING_PAYMENT",
        toStatus: "PAID",
        action: "WALLET_SETTLED",
        actorUid: user.uid,
        createdAt: now,
      });
      return { paymentRef, ledgerId, amount, transactionFee, totalAmount, alreadyPaid: false, needsSettlement: false, paymentMethod: "SMART_WALLET" as const, patientUid: user.uid, providerUid: String(order.providerUid || ""), orderStatus: "PAID" };
    });

    if (outcome.paymentMethod === "MONCASH") {
      if (outcome.needsSettlement) await settlePaidPayment(outcome.paymentRef);
      return json(request, { ok: true, status: "paid", paymentMethod: "MONCASH", orderStatus: outcome.orderStatus, alreadyPaid: true });
    }
    if (!outcome.alreadyPaid) {
      const tasks = [createUserNotification({
        uid: outcome.patientUid,
        eventKey: `order:payment:${outcome.paymentRef}`,
        type: "order_payment_confirmed",
        title: "Paiement confirmé",
        body: "Votre commande est payée. Vous recevrez une notification lors de sa prise en charge.",
        url: "/espace#commandes",
      })];
      if (outcome.providerUid) tasks.push(createUserNotification({
        uid: outcome.providerUid,
        eventKey: `order:payment:${outcome.paymentRef}`,
        type: "order_payment_confirmed",
        title: "Nouvelle commande payée",
        body: "Une commande NEXA a été réglée. Consultez votre espace partenaire.",
        url: "/professionnels/espace#commandes",
      }));
      await Promise.all(tasks);
    }
    return json(request, { ok: true, status: "paid", paymentMethod: "SMART_WALLET", orderStatus: outcome.orderStatus, amount: outcome.amount, transactionFee: outcome.transactionFee, totalAmount: outcome.totalAmount, currency: "HTG", alreadyPaid: outcome.alreadyPaid });
  } catch (error) { return fail(request, error); }
}
