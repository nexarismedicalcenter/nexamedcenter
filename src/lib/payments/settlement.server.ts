import "server-only";

import { createHash, randomInt } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { createUserNotification, sendUserTransactionalEmail } from "@/lib/notifications.server";
import { appointmentPaymentMatches, nexaOrderPaymentMatches } from "@/lib/payments/transaction-fees.server";

const APPOINTMENT_PATH = /^appointments\/([A-Za-z0-9_-]{1,200})$/;

function createHomeVisitCodeHash(appointmentId: string, code: string): string {
  return createHash("sha256").update(`NEXA_HOME_VISIT:${appointmentId}:${code}`).digest("hex");
}

/** Apply a verified MonCash payment to its NEXA appointment, idempotently. */
export async function settlePaidAppointmentPayment(paymentRef: string): Promise<void> {
  const db = getFirebaseAdminDb();
  const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
  const preview = await paymentRefDoc.get();
  if (!preview.exists || preview.get("status") !== "paid" || preview.get("paymentMethod") !== "MONCASH" || preview.get("resourceType") !== "appointment") return;

  const resourcePath = String(preview.get("resourcePath") || "");
  const match = resourcePath.match(APPOINTMENT_PATH);
  if (!match) {
    console.error("NEXA appointment payment has an invalid resource path", { paymentRef });
    return;
  }
  const appointmentRef = db.collection("appointments").doc(match[1]);
  const feeLedgerRef = db.collection("nexaTransactionFeeLedger").doc(paymentRef);
  const settledAppointment = await db.runTransaction(async (transaction): Promise<{ patientUid: string; providerUid: string; confirmed: boolean; homeVisitCode: string } | null> => {
    const paymentSnapshot = await transaction.get(paymentRefDoc);
    if (!paymentSnapshot.exists || paymentSnapshot.get("status") !== "paid" || paymentSnapshot.get("resourcePath") !== resourcePath) return null;
    const [appointmentSnapshot, feeLedgerSnapshot] = await Promise.all([transaction.get(appointmentRef), transaction.get(feeLedgerRef)]);
    if (!appointmentSnapshot.exists) {
      console.error("NEXA appointment payment points to a missing appointment", { paymentRef });
      return null;
    }
    const appointment = appointmentSnapshot.data() || {};
    const patientUid = String(appointment.patientUid || "");
    const providerUid = String(appointment.providerUid || "");
    if (
      patientUid !== paymentSnapshot.get("uid") ||
      appointment.moncashPaymentRef !== paymentRef ||
      !appointmentPaymentMatches(appointment, paymentSnapshot.data() || {}) ||
      String(appointment.currency || "").toUpperCase() !== "HTG"
    ) {
      console.error("NEXA appointment payment does not match its appointment", { paymentRef });
      return null;
    }
    const slotId = typeof appointment.slotId === "string" ? appointment.slotId : "";
    const slotRef = slotId ? db.collection("providerAvailabilitySlots").doc(slotId) : null;
    const slotSnapshot = slotRef ? await transaction.get(slotRef) : null;
    const slot = slotSnapshot?.data() || {};
    const proposalId = typeof appointment.followUpProposalId === "string" ? appointment.followUpProposalId : "";
    const proposalRef = appointment.bookingType === "doctor_proposed_appointment" && proposalId
      ? db.collection("followUpProposals").doc(proposalId)
      : null;
    const proposalSnapshot = proposalRef ? await transaction.get(proposalRef) : null;
    const proposalMatches = appointment.bookingType !== "doctor_proposed_appointment" || Boolean(
      proposalSnapshot?.exists && proposalSnapshot.get("patientUid") === patientUid &&
      proposalSnapshot.get("providerUid") === providerUid && proposalSnapshot.get("slotId") === slotId &&
      proposalSnapshot.get("pendingAppointmentId") === appointmentRef.id &&
      ["PENDING", "BOOKED"].includes(String(proposalSnapshot.get("status") || "")),
    );
    const feeAmount = Number(appointment.transactionFee) || 0;
    if (feeLedgerSnapshot.exists && (
      feeLedgerSnapshot.get("paymentRef") !== paymentRef || feeLedgerSnapshot.get("resourceType") !== "appointment" ||
      feeLedgerSnapshot.get("resourceId") !== appointmentRef.id || Number(feeLedgerSnapshot.get("amountMinor")) !== feeAmount * 100 ||
      feeLedgerSnapshot.get("recipient") !== "NEXARIS" || feeLedgerSnapshot.get("status") !== "COMPLETED"
    )) {
      console.error("NEXA appointment transaction-fee ledger mismatch", { paymentRef });
      return null;
    }
    if (appointment.paymentStatus === "PAID" && ["CONFIRMED", "DOCTOR_ACCEPTED", "PAYMENT_CONFLICT_REFUND_REQUIRED"].includes(String(appointment.status))) {
      if (feeAmount > 0 && !feeLedgerSnapshot.exists) transaction.create(feeLedgerRef, {
        paymentRef,
        resourceType: "appointment",
        resourceId: appointmentRef.id,
        serviceAmountMinor: Number(appointment.amount) * 100,
        amountMinor: feeAmount * 100,
        currency: "HTG",
        recipient: "NEXARIS",
        transactionFeeRateBps: Number(appointment.transactionFeeRateBps) || 0,
        paymentMethod: "MONCASH",
        status: "COMPLETED",
        createdAt: FieldValue.serverTimestamp(),
      });
      const code = appointment.bookingType === "home_visit" && appointment.status === "CONFIRMED" && typeof appointment.homeVisitMissionCode === "string"
        ? appointment.homeVisitMissionCode
        : "";
      return code ? { patientUid, providerUid, confirmed: true, homeVisitCode: code } : null;
    }

    const slotBelongsToAppointment = Boolean(
      slotSnapshot?.exists && slot.appointmentId === appointmentRef.id &&
      slot.providerUid === appointment.providerUid && ["held", "booked"].includes(String(slot.status)) && proposalMatches,
    );

    if (feeAmount > 0 && !feeLedgerSnapshot.exists) transaction.create(feeLedgerRef, {
      paymentRef,
      resourceType: "appointment",
      resourceId: appointmentRef.id,
      serviceAmountMinor: Number(appointment.amount) * 100,
      amountMinor: feeAmount * 100,
      currency: "HTG",
      recipient: "NEXARIS",
      transactionFeeRateBps: Number(appointment.transactionFeeRateBps) || 0,
      paymentMethod: "MONCASH",
      status: "COMPLETED",
      createdAt: FieldValue.serverTimestamp(),
    });

    const homeVisitCode = appointment.bookingType === "home_visit" && slotBelongsToAppointment
      ? typeof appointment.homeVisitMissionCode === "string" ? appointment.homeVisitMissionCode : String(randomInt(0, 100_000_000)).padStart(8, "0")
      : "";
    transaction.set(appointmentRef, {
      paymentStatus: "PAID",
      status: slotBelongsToAppointment ? appointment.bookingType === "doctor_proposed_appointment" ? "DOCTOR_ACCEPTED" : "CONFIRMED" : "PAYMENT_CONFLICT_REFUND_REQUIRED",
      sessionStatus: slotBelongsToAppointment && appointment.bookingType !== "home_visit" ? "SCHEDULED" : null,
      ...(appointment.bookingType === "home_visit" ? {
        homeVisitMissionStatus: slotBelongsToAppointment ? "SCHEDULED" : "PAYMENT_CONFLICT",
        ...(slotBelongsToAppointment ? {
          homeVisitMissionCode: homeVisitCode,
          homeVisitMissionCodeHash: createHomeVisitCodeHash(appointmentRef.id, homeVisitCode),
          homeVisitMissionCodeIssuedAt: FieldValue.serverTimestamp(),
        } : {}),
      } : {}),
      refundRequired: !slotBelongsToAppointment,
      paidAt: appointment.paidAt || FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    if (slotBelongsToAppointment && slotRef) {
      transaction.set(slotRef, {
        status: "booked",
        holdExpiresAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      if (proposalRef) transaction.set(proposalRef, {
        status: "BOOKED",
        bookedAppointmentId: appointmentRef.id,
        paidAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    } else {
      const alertRef = db.collection("paymentSettlementAlerts").doc();
      transaction.create(alertRef, {
        paymentRef,
        resourceType: "appointment",
        resourceId: appointmentRef.id,
        reason: "SLOT_NO_LONGER_HELD",
        status: "open",
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    return { patientUid, providerUid, confirmed: slotBelongsToAppointment, homeVisitCode };
  });
  if (settledAppointment?.patientUid) {
    const data = settledAppointment;
    const isHomeVisit = Boolean(data.confirmed && data.homeVisitCode);
    const notification = data.confirmed
      ? isHomeVisit
        ? { type: "home_visit_payment_confirmed", title: "Visite à domicile confirmée", body: `Votre visite est confirmée. Gardez ce code de clôture : ${data.homeVisitCode}. Vous le remettrez au médecin après la visite.`, url: "/espace" }
        : { type: "appointment_payment_confirmed", title: "Paiement confirmé", body: "Votre rendez-vous est confirmé. NEXA vous avisera de la suite.", url: "/espace" }
      : { type: "appointment_payment_reconciliation", title: "Paiement à rapprocher", body: "Le paiement a été reçu, mais le créneau doit être vérifié. Ne payez pas une seconde fois; NEXA examinera la transaction.", url: "/espace" };
    const tasks = [createUserNotification({
      uid: data.patientUid, eventKey: `appointment:payment:${paymentRef}`, appointmentId: match[1], ...notification,
    })];
    if (data.confirmed && data.providerUid) tasks.push(createUserNotification({
      uid: data.providerUid,
      eventKey: `appointment:payment:${paymentRef}`,
      type: "appointment_payment_confirmed",
      title: "Nouveau rendez-vous payé",
      body: "Un patient a réservé et payé un créneau. Consultez votre espace professionnel.",
      url: "/professionnels/espace",
      appointmentId: match[1],
    }));
    await Promise.all(tasks);
    if (isHomeVisit) await sendUserTransactionalEmail({
      uid: data.patientUid,
      eventKey: `home-visit-mission-code:${match[1]}:${paymentRef}`,
      subject: "Code de clôture de votre visite NEXA",
      text: `Votre visite médicale à domicile est confirmée. Votre code de clôture est ${data.homeVisitCode}. Remettez ce code au médecin après la visite pour clôturer la mission. Ne le communiquez pas avant d’avoir vérifié la présence du professionnel. Consultez votre espace : https://nexarishaiti.com/espace`,
      html: `<p>Votre visite médicale à domicile est confirmée.</p><p>Votre code de clôture est <strong>${data.homeVisitCode}</strong>.</p><p>Remettez ce code au médecin après la visite pour clôturer la mission. Ne le communiquez pas avant d’avoir vérifié la présence du professionnel.</p><p><a href="https://nexarishaiti.com/espace">Consulter mon espace NEXA</a></p>`,
    }).catch((error) => { console.error("NEXA home visit mission-code email failed", error instanceof Error ? error.name : "unknown-error"); });
  }
}

const ORDER_RESOURCE_KINDS: Record<string, string> = {
  "pharmacy-order": "pharmacy",
  "laboratory-order": "laboratory",
  "imaging-order": "imaging",
};
const NEXA_ORDER_PATH = /^nexaOrders\/([A-Za-z0-9_-]{1,200})$/;

/** Apply a signed MonCash settlement to an NEXA order without sending order data to Smart Cut. */
export async function settlePaidNexaOrderPayment(paymentRef: string): Promise<void> {
  const db = getFirebaseAdminDb();
  const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
  const preview = await paymentRefDoc.get();
  const resourceType = String(preview.get("resourceType") || "");
  const expectedKind = ORDER_RESOURCE_KINDS[resourceType];
  if (!preview.exists || preview.get("status") !== "paid" || preview.get("paymentMethod") !== "MONCASH" || !expectedKind) return;

  const resourcePath = String(preview.get("resourcePath") || "");
  const match = resourcePath.match(NEXA_ORDER_PATH);
  if (!match) {
    console.error("NEXA order payment has an invalid resource path", { paymentRef, resourceType });
    return;
  }
  const orderRef = db.collection("nexaOrders").doc(match[1]);
  const alertRef = db.collection("paymentSettlementAlerts").doc(`order_${paymentRef}`);
  const feeLedgerRef = db.collection("nexaTransactionFeeLedger").doc(paymentRef);
  const eventRef = db.collection("nexaOrderEvents").doc();
  const outcome = await db.runTransaction(async (transaction): Promise<{
    patientUid: string;
    providerUid: string;
    orderId: string;
    confirmed: boolean;
  } | null> => {
    const [paymentSnapshot, orderSnapshot, alertSnapshot, feeLedgerSnapshot] = await Promise.all([
      transaction.get(paymentRefDoc),
      transaction.get(orderRef),
      transaction.get(alertRef),
      transaction.get(feeLedgerRef),
    ]);
    if (!paymentSnapshot.exists || paymentSnapshot.get("status") !== "paid" || paymentSnapshot.get("resourcePath") !== resourcePath) return null;
    const payment = paymentSnapshot.data() || {};
    const order = orderSnapshot.data() || {};
    const patientUid = String(payment.uid || "");
    const providerUid = String(order.providerUid || "");
    const feeAmount = Number(order.transactionFee) || 0;
    const feeLedgerMatches = feeAmount === 0
      ? !feeLedgerSnapshot.exists
      : feeLedgerSnapshot.exists && feeLedgerSnapshot.get("paymentRef") === paymentRef &&
        feeLedgerSnapshot.get("resourceType") === resourceType && feeLedgerSnapshot.get("resourceId") === orderRef.id &&
        Number(feeLedgerSnapshot.get("serviceAmountMinor")) === Number(order.amount) * 100 &&
        Number(feeLedgerSnapshot.get("amountMinor")) === feeAmount * 100 && feeLedgerSnapshot.get("recipient") === "NEXARIS" &&
        feeLedgerSnapshot.get("paymentMethod") === "MONCASH" && feeLedgerSnapshot.get("status") === "COMPLETED";
    const orderMatchesPayment = orderSnapshot.exists &&
      order.kind === expectedKind &&
      order.patientUid === patientUid &&
      order.moncashPaymentRef === paymentRef &&
      nexaOrderPaymentMatches(order, payment) &&
      String(order.currency || "").toUpperCase() === "HTG" &&
      String(payment.currency || "").toUpperCase() === "HTG";

    if (orderMatchesPayment && order.status === "PAID" && order.paymentStatus === "PAID" && order.settlementStatus === "CONFIRMED") {
      if (feeAmount > 0 && !feeLedgerSnapshot.exists) transaction.create(feeLedgerRef, {
        paymentRef,
        resourceType,
        resourceId: orderRef.id,
        serviceAmountMinor: Number(order.amount) * 100,
        amountMinor: feeAmount * 100,
        currency: "HTG",
        recipient: "NEXARIS",
        transactionFeeRateBps: Number(order.transactionFeeRateBps) || 0,
        paymentMethod: "MONCASH",
        status: "COMPLETED",
        createdAt: FieldValue.serverTimestamp(),
      });
      else if (!feeLedgerMatches) {
        console.error("NEXA order transaction-fee ledger mismatch", { paymentRef, resourceType });
        return null;
      }
      return null;
    }

    if (!orderMatchesPayment || (feeLedgerSnapshot.exists && !feeLedgerMatches) || order.status !== "PENDING_PAYMENT" || order.paymentStatus !== "PENDING") {
      if (!alertSnapshot.exists) transaction.create(alertRef, {
        paymentRef,
        resourceType,
        resourceId: orderRef.id,
        reason: !orderMatchesPayment ? "ORDER_PAYMENT_MISMATCH" : "ORDER_NOT_PAYABLE_AT_SETTLEMENT",
        status: "open",
        createdAt: FieldValue.serverTimestamp(),
      });
      if (orderSnapshot.exists && order.patientUid === patientUid && order.moncashPaymentRef === paymentRef) {
        transaction.set(orderRef, {
          paymentStatus: "PAID",
          settlementStatus: "REVIEW_REQUIRED",
          paidAt: order.paidAt || FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      return { patientUid, providerUid, orderId: orderRef.id, confirmed: false };
    }

    if (feeAmount > 0 && !feeLedgerSnapshot.exists) transaction.create(feeLedgerRef, {
      paymentRef,
      resourceType,
      resourceId: orderRef.id,
      serviceAmountMinor: Number(order.amount) * 100,
      amountMinor: feeAmount * 100,
      currency: "HTG",
      recipient: "NEXARIS",
      transactionFeeRateBps: Number(order.transactionFeeRateBps) || 0,
      paymentMethod: "MONCASH",
      status: "COMPLETED",
      createdAt: FieldValue.serverTimestamp(),
    });

    transaction.set(orderRef, {
      paymentStatus: "PAID",
      status: "PAID",
      settlementStatus: "CONFIRMED",
      paidAt: order.paidAt || FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.create(eventRef, {
      orderId: orderRef.id,
      fromStatus: "PENDING_PAYMENT",
      toStatus: "PAID",
      action: "MONCASH_SETTLED",
      actorUid: "system:moncash",
      createdAt: FieldValue.serverTimestamp(),
    });
    return { patientUid, providerUid, orderId: orderRef.id, confirmed: true };
  });

  if (!outcome?.patientUid) return;
  await createUserNotification({
    uid: outcome.patientUid,
    eventKey: `order:payment:${paymentRef}`,
    type: outcome.confirmed ? "order_payment_confirmed" : "order_payment_reconciliation",
    title: outcome.confirmed ? "Paiement confirmé" : "Paiement à rapprocher",
    body: outcome.confirmed
      ? "Votre commande est payée. Vous recevrez une notification lors de sa prise en charge."
      : "Le paiement a été reçu, mais la commande doit être vérifiée par NEXA. Ne payez pas une seconde fois.",
    url: "/espace#commandes",
  });
  if (outcome.confirmed && outcome.providerUid) await createUserNotification({
    uid: outcome.providerUid,
    eventKey: `order:payment:${paymentRef}`,
    type: "order_payment_confirmed",
    title: "Nouvelle commande payée",
    body: "Une commande NEXA a été réglée. Consultez votre espace partenaire.",
    url: "/professionnels/espace#commandes",
  });
}

/** Dispatch a verified MonCash settlement to the resource-specific idempotent handler. */
export async function settlePaidPayment(paymentRef: string): Promise<void> {
  const snapshot = await getFirebaseAdminDb().collection("paymentIntents").doc(paymentRef).get();
  if (!snapshot.exists || snapshot.get("status") !== "paid" || snapshot.get("paymentMethod") !== "MONCASH") return;
  if (snapshot.get("resourceType") === "appointment") return settlePaidAppointmentPayment(paymentRef);
  return settlePaidNexaOrderPayment(paymentRef);
}
