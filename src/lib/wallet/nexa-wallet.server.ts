import "server-only";

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { ApiRequestError } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { createUserNotification } from "@/lib/notifications.server";
import { appointmentPaymentMatches, nexaOrderPaymentMatches } from "@/lib/payments/transaction-fees.server";

export type RefundableResourceType =
  | "appointment"
  | "pharmacy-order"
  | "laboratory-order"
  | "imaging-order";

type RefundActor =
  | { kind: "ADMIN"; adminUid: string; confirmNoExternalRefund: boolean }
  | { kind: "PROVIDER_REFUSAL"; providerUid: string }
  | { kind: "PROVIDER_NO_SHOW" }
  | { kind: "HOME_VISIT_PROVIDER_NO_SHOW" };

const ORDER_KINDS: Record<Exclude<RefundableResourceType, "appointment">, string> = {
  "pharmacy-order": "pharmacy",
  "laboratory-order": "laboratory",
  "imaging-order": "imaging",
};

function getResourceCollection(type: RefundableResourceType) {
  return type === "appointment" ? "appointments" : "nexaOrders";
}

function getWalletLedgerId(type: RefundableResourceType, resourceId: string) {
  return createHash("sha256").update(`NEXA_WALLET_REFUND:${type}:${resourceId}`).digest("hex");
}

export function getNexaRefundLedgerId(type: RefundableResourceType, resourceId: string) {
  return createHash("sha256").update(`NEXA_REFUND:${type}:${resourceId}`).digest("hex");
}

/** Credit one full, settled NEXA refund to the patient's NEXA-owned wallet. */
export async function creditNexaWalletForRefund(input: {
  resourceType: RefundableResourceType;
  resourceId: string;
  actor: RefundActor;
}): Promise<{ amount: number; currency: "HTG"; ledgerId: string; refundLedgerId: string; userUid: string; alreadyProcessed: boolean }> {
  const isProviderRefusal = input.actor.kind === "PROVIDER_REFUSAL";
  const isProviderNoShow = input.actor.kind === "PROVIDER_NO_SHOW";
  const isHomeVisitProviderNoShow = input.actor.kind === "HOME_VISIT_PROVIDER_NO_SHOW";
  const isAutomaticProviderRefund = isProviderRefusal || isProviderNoShow || isHomeVisitProviderNoShow;
  if (input.actor.kind === "ADMIN" && !input.actor.confirmNoExternalRefund) {
    throw new ApiRequestError(400, "external-refund-confirmation-required", "Confirmez qu’aucun remboursement externe n’a déjà été effectué.");
  }
  if (isProviderRefusal && input.resourceType !== "appointment") {
    throw new ApiRequestError(400, "invalid-refund-type", "Le refus automatique concerne uniquement une téléconsultation.");
  }
  if ((isProviderNoShow || isHomeVisitProviderNoShow) && input.resourceType !== "appointment") {
    throw new ApiRequestError(400, "invalid-refund-type", "L’absence du médecin concerne uniquement une téléconsultation.");
  }
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(input.resourceId)) {
    throw new ApiRequestError(400, "invalid-refund-resource", "La référence à rembourser n’est pas valide.");
  }

  const db = getFirebaseAdminDb();
  const collection = getResourceCollection(input.resourceType);
  const sourceRef = db.collection(collection).doc(input.resourceId);
  const ledgerId = getWalletLedgerId(input.resourceType, input.resourceId);
  const refundLedgerId = getNexaRefundLedgerId(input.resourceType, input.resourceId);
  const ledgerRef = db.collection("nexaWalletLedger").doc(ledgerId);
  const refundLedgerRef = db.collection("nexaRefundLedger").doc(refundLedgerId);
  const actorUid = input.actor.kind === "ADMIN" ? input.actor.adminUid : input.actor.kind === "PROVIDER_REFUSAL" ? input.actor.providerUid : isHomeVisitProviderNoShow ? "system:nexa-home-visit-no-show" : "system:nexa-provider-no-show";
  const auditRef = db.collection(input.actor.kind === "ADMIN" ? "adminAuditLogs" : "paymentAuditLogs").doc();
  const resourceAlertsQuery = db.collection("paymentSettlementAlerts")
    .where("resourceId", "==", input.resourceId)
    .limit(100);

  const result = await db.runTransaction(async (transaction) => {
    const sourceSnapshot = await transaction.get(sourceRef);
    if (!sourceSnapshot.exists) throw new ApiRequestError(404, "refund-resource-not-found", "La commande ou le rendez-vous n’existe pas.");
    const source = sourceSnapshot.data() || {};
    const patientUid = typeof source.patientUid === "string" ? source.patientUid : "";
    const paymentRef = typeof source.moncashPaymentRef === "string" ? source.moncashPaymentRef : "";
    if (!patientUid || !/^[A-Za-z0-9_-]{20,64}$/.test(paymentRef)) {
      throw new ApiRequestError(409, "refund-source-invalid", "La ressource ne contient pas de paiement NEXA vérifiable.");
    }

    const profileRef = db.collection("patientProfiles").doc(patientUid);
    const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
    const walletRef = db.collection("nexaPatientWallets").doc(patientUid);
    const [ledgerSnapshot, refundLedgerSnapshot, profileSnapshot, paymentSnapshot, walletSnapshot, alertsSnapshot] = await Promise.all([
      transaction.get(ledgerRef),
      transaction.get(refundLedgerRef),
      transaction.get(profileRef),
      transaction.get(paymentRefDoc),
      transaction.get(walletRef),
      transaction.get(resourceAlertsQuery),
    ]);

    const resourceAlerts = alertsSnapshot.docs.filter((alert) => alert.get("resourceType") === input.resourceType);
    if (resourceAlerts.some((alert) => [
      "manual_refund_confirmed",
      "manual_cash_refund_confirmed",
      "manual_moncash_refund_confirmed",
    ].includes(String(alert.get("resolution") || "")))) {
      throw new ApiRequestError(409, "external-refund-already-recorded", "Un remboursement externe est déjà enregistré pour cette ressource.");
    }

    if (refundLedgerSnapshot.exists && refundLedgerSnapshot.get("refundMethod") !== "NEXA_WALLET") {
      throw new ApiRequestError(409, "external-refund-already-recorded", "Un remboursement externe est déjà enregistré pour cette ressource.");
    }
    if (refundLedgerSnapshot.exists !== ledgerSnapshot.exists) {
      throw new ApiRequestError(409, "refund-ledger-conflict", "Le registre du remboursement et le mouvement du portefeuille ne concordent pas.");
    }

    if (ledgerSnapshot.exists) {
      const prior = ledgerSnapshot.data() || {};
      const priorAmountMinor = Number(prior.amountMinor);
      if (!refundLedgerSnapshot.exists || prior.userUid !== patientUid || prior.resourceType !== input.resourceType || prior.resourceId !== input.resourceId || prior.currency !== "HTG" || prior.status !== "COMPLETED" || !Number.isSafeInteger(priorAmountMinor) || priorAmountMinor <= 0 || refundLedgerSnapshot.get("userUid") !== patientUid || refundLedgerSnapshot.get("resourceId") !== input.resourceId || refundLedgerSnapshot.get("refundMethod") !== "NEXA_WALLET" || Number(refundLedgerSnapshot.get("amountMinor")) !== priorAmountMinor || refundLedgerSnapshot.get("walletLedgerId") !== ledgerId) {
        throw new ApiRequestError(409, "refund-ledger-conflict", "Le registre contient une référence de remboursement incompatible.");
      }
      return {
        amount: priorAmountMinor / 100,
        currency: "HTG" as const,
        ledgerId,
        refundLedgerId,
        userUid: patientUid,
        alreadyProcessed: true,
      };
    }

    const amount = Number(source.amount);
    const amountMinor = Math.round(amount * 100);
    const currency = String(source.currency || "").toUpperCase();
    const refundStatus = String(source.refundStatus || "").toUpperCase();
    const payment = paymentSnapshot.data() || {};
    const expectedResourceType = input.resourceType;
    const expectedResourcePath = `${collection}/${input.resourceId}`;
    const resourceReady = input.resourceType === "appointment"
      ? isProviderRefusal
        ? source.bookingType === "teleconsultation" && source.providerUid === actorUid && source.status === "PROVIDER_REFUSED" && source.refundRequired === true
        : isHomeVisitProviderNoShow
          ? source.bookingType === "home_visit" && source.status === "PROVIDER_NO_SHOW_REFUND_REQUIRED" && source.refundRequired === true && source.refundStatus === "PENDING_AUTO_REFUND" && source.homeVisitMissionStatus === "PROVIDER_ABSENT_REFUND_REQUIRED" && source.homeVisitProviderPresent === false && source.homeVisitServiceCompletion === "NOT_COMPLETED"
          : isProviderNoShow
            ? ["teleconsultation", "doctor_proposed_appointment"].includes(String(source.bookingType || "")) && source.status === "PROVIDER_NO_SHOW_REFUND_REQUIRED" && source.refundRequired === true && source.refundStatus === "PENDING_AUTO_REFUND" && source.noShowOutcome === "PROVIDER_UNRESPONSIVE" && source.noShowTriggeredBy === "patient" && source.effectiveConsultationStartedAt == null && Array.isArray(source.videoCallAttempts) && source.videoCallAttempts.filter((attempt: unknown) => attempt && typeof attempt === "object" && (attempt as Record<string, unknown>).initiatedByRole === "patient" && (attempt as Record<string, unknown>).status === "NO_ANSWER").length >= 2
            : source.status === "PAYMENT_CONFLICT_REFUND_REQUIRED" && source.refundRequired === true
      : source.kind === ORDER_KINDS[input.resourceType] && source.status === "PROVIDER_REFUSED" && source.refundRequired === true && source.settlementStatus === "CONFIRMED";
    const paymentAmountMatches = input.resourceType === "appointment"
      ? appointmentPaymentMatches(source, payment)
      : nexaOrderPaymentMatches(source, payment);
    const paymentReady = profileSnapshot.exists && profileSnapshot.get("role") === "patient" &&
      source.paymentStatus === "PAID" && currency === "HTG" && Number.isSafeInteger(amount) && amount > 0 && amount <= 10_000_000 &&
      payment.status === "paid" && payment.resourceType === expectedResourceType && payment.resourcePath === expectedResourcePath &&
      payment.uid === patientUid && paymentAmountMatches && String(payment.currency || "").toUpperCase() === "HTG";

    const refundStatusReady = isAutomaticProviderRefund
      ? refundStatus === "PENDING_AUTO_REFUND"
      : ["", "PENDING_REVIEW", "MANUAL_REVIEW_REQUIRED"].includes(refundStatus);
    if (!resourceReady || !paymentReady || !refundStatusReady) {
      if (["COMPLETED", "REFUNDED"].includes(refundStatus)) {
        throw new ApiRequestError(409, "refund-already-processed", "Cette ressource a déjà un remboursement enregistré.");
      }
      throw new ApiRequestError(409, "refund-not-eligible", "Le paiement ou l’état de la ressource ne permet pas ce crédit.");
    }

    const currentWallet = walletSnapshot.data() || {};
    const availableMinor = currentWallet.availableMinor === undefined ? 0 : Number(currentWallet.availableMinor);
    const reservedMinor = currentWallet.reservedMinor === undefined ? 0 : Number(currentWallet.reservedMinor);
    if (!Number.isSafeInteger(availableMinor) || availableMinor < 0 || !Number.isSafeInteger(reservedMinor) || reservedMinor < 0 || !Number.isSafeInteger(availableMinor + amountMinor) || (currentWallet.currency && currentWallet.currency !== "HTG") || (currentWallet.status && currentWallet.status !== "ACTIVE")) {
      throw new ApiRequestError(409, "wallet-state-invalid", "Le portefeuille NEXA ne peut pas recevoir ce crédit actuellement.");
    }

    const now = FieldValue.serverTimestamp();
    transaction.set(walletRef, {
      userUid: patientUid,
      currency: "HTG",
      availableMinor: availableMinor + amountMinor,
      reservedMinor,
      status: currentWallet.status || "ACTIVE",
      updatedAt: now,
    }, { merge: true });
    transaction.create(ledgerRef, {
      userUid: patientUid,
      walletId: patientUid,
      type: "REFUND",
      direction: "CREDIT",
      amountMinor,
      currency: "HTG",
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      paymentRef,
      reason: isProviderRefusal ? "teleconsultation-provider-refusal" : isHomeVisitProviderNoShow ? "home-visit-provider-no-show" : isProviderNoShow ? "teleconsultation-provider-no-show" : input.resourceType === "appointment" ? "appointment-refund-review-approved" : "provider-refused-order-refund",
      source: isAutomaticProviderRefund ? "NEXA_AUTOMATIC_REFUND" : "NEXA_ADMIN",
      status: "COMPLETED",
      createdAt: now,
      createdByUid: actorUid,
    });
    transaction.create(refundLedgerRef, {
      userUid: patientUid,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      paymentRef,
      amountMinor,
      currency: "HTG",
      refundMethod: "NEXA_WALLET",
      serviceAmountMinor: amountMinor,
      ...(Number(source.transactionFee) > 0 ? { nonRefundableTransactionFeeMinor: Number(source.transactionFee) * 100 } : {}),
      walletLedgerId: ledgerId,
      status: "COMPLETED",
      createdAt: now,
      createdByUid: actorUid,
    });
    transaction.set(sourceRef, {
      status: "REFUNDED",
      paymentStatus: "REFUNDED",
      refundRequired: false,
      refundStatus: "COMPLETED",
      refundMethod: "NEXA_WALLET",
      ...(isHomeVisitProviderNoShow ? { homeVisitMissionStatus: "REFUNDED" } : {}),
      refundedAmount: amount,
      refundedAmountMinor: amountMinor,
      ...(Number(source.transactionFee) > 0 ? { nonRefundableTransactionFee: Number(source.transactionFee) } : {}),
      refundedAt: now,
      refundedByUid: isAutomaticProviderRefund ? "system:nexa-automatic-refund" : actorUid,
      ...(isProviderRefusal ? { refundInitiatedByUid: actorUid } : {}),
      refundLedgerId,
      walletLedgerId: ledgerId,
      updatedAt: now,
    }, { merge: true });
    for (const alert of resourceAlerts.filter((item) => ["open", "in_review"].includes(String(item.get("status"))))) {
      transaction.set(alert.ref, {
        status: "resolved",
        resolution: "nexa_wallet_credit",
        resolutionReference: ledgerId,
        reviewNote: "Crédit au portefeuille NEXA; aucun remboursement externe n’a été lancé.",
        resolvedBy: actorUid,
        resolvedAt: now,
      }, { merge: true });
    }
    transaction.create(auditRef, {
      actorUid,
      action: isProviderRefusal ? "teleconsultation_provider_refusal_wallet_refund_credited" : isHomeVisitProviderNoShow ? "home_visit_provider_no_show_wallet_refund_credited" : isProviderNoShow ? "teleconsultation_provider_no_show_wallet_refund_credited" : "nexa_wallet_refund_credited",
      resource: `${collection}/${input.resourceId}`,
      amountMinor,
      currency: "HTG",
      createdAt: now,
    });
    return { amount, currency: "HTG" as const, ledgerId, refundLedgerId, userUid: patientUid, alreadyProcessed: false };
  });

  if (!result.alreadyProcessed && !isProviderRefusal) {
    await createUserNotification({
      uid: result.userUid,
      eventKey: `wallet-refund:${result.ledgerId}`,
      type: isHomeVisitProviderNoShow ? "home_visit_provider_no_show_refunded" : isProviderNoShow ? "appointment_provider_no_show_refunded" : "wallet_refund_credited",
      title: isHomeVisitProviderNoShow ? "Visite non assurée et remboursée" : isProviderNoShow ? "Téléconsultation non assurée et remboursée" : "Remboursement crédité",
      body: isHomeVisitProviderNoShow
        ? `${new Intl.NumberFormat("fr-HT").format(result.amount)} HTG correspondant au prix du service ont été crédités dans votre portefeuille NEXA après le signalement de l’absence du médecin. Les frais de transaction ne sont pas remboursés.`
        : isProviderNoShow
          ? `${new Intl.NumberFormat("fr-HT").format(result.amount)} HTG correspondant au service ont été crédités dans votre portefeuille NEXA après deux appels restés sans réponse. Les frais de transaction ne sont pas remboursés.`
        : `${new Intl.NumberFormat("fr-HT").format(result.amount)} HTG ont été ajoutés à votre portefeuille NEXA. Le frais de transaction initial, s’il y en avait un, n’est pas remboursé. Aucun remboursement externe n’a été lancé.`,
      url: "/espace",
    });
  }
  return result;
}
