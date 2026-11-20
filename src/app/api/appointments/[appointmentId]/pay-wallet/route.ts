import { createHash, randomInt } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { createUserNotification, sendUserTransactionalEmail } from "@/lib/notifications.server";
import { settlePaidPayment } from "@/lib/payments/settlement.server";
import { appointmentPaymentMatches } from "@/lib/payments/transaction-fees.server";

const PAYMENT_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "wallet-appointment-payment-failed";
  const message = error instanceof ApiRequestError ? error.message : "Le paiement par portefeuille NEXA n’a pas abouti.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA wallet appointment payment failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request, { params }: { params: Promise<{ appointmentId: string }> }) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "pay-appointment-wallet", limit: 8, windowMs: 5 * 60_000 });
    const { appointmentId } = await params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) throw new ApiRequestError(400, "invalid-appointment", "La référence du rendez-vous n’est pas valide.");

    const db = getFirebaseAdminDb();
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const outcome = await db.runTransaction(async (transaction) => {
      const appointmentSnapshot = await transaction.get(appointmentRef);
      if (!appointmentSnapshot.exists || appointmentSnapshot.get("patientUid") !== user.uid) throw new ApiRequestError(404, "appointment-not-found", "Ce rendez-vous n’est pas accessible.");
      const appointment = appointmentSnapshot.data() || {};
      const paymentRef = typeof appointment.moncashPaymentRef === "string" ? appointment.moncashPaymentRef : "";
      const slotId = typeof appointment.slotId === "string" ? appointment.slotId : "";
      if (!PAYMENT_REFERENCE_PATTERN.test(paymentRef) || !/^[a-f0-9]{32}$/.test(slotId)) throw new ApiRequestError(409, "appointment-payment-invalid", "Le paiement ou le créneau de ce rendez-vous ne peut pas être vérifié.");

      const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
      const walletRef = db.collection("nexaPatientWallets").doc(user.uid);
      const profileRef = db.collection("patientProfiles").doc(user.uid);
      const slotRef = db.collection("providerAvailabilitySlots").doc(slotId);
      const ledgerId = createHash("sha256").update(`NEXA_WALLET_APPOINTMENT:${appointmentId}`).digest("hex");
      const ledgerRef = db.collection("nexaWalletLedger").doc(ledgerId);
      const feeLedgerRef = db.collection("nexaTransactionFeeLedger").doc(paymentRef);
      const followUpProposalId = appointment.bookingType === "doctor_proposed_appointment" && typeof appointment.followUpProposalId === "string"
        ? appointment.followUpProposalId
        : "";
      if (appointment.bookingType === "doctor_proposed_appointment" && !/^[a-f0-9]{32}$/.test(followUpProposalId)) {
        throw new ApiRequestError(409, "follow-up-proposal-invalid", "La proposition liée à ce rendez-vous n’est pas valide.");
      }
      const followUpProposalRef = followUpProposalId ? db.collection("followUpProposals").doc(followUpProposalId) : null;
      const [paymentSnapshot, walletSnapshot, profileSnapshot, slotSnapshot, ledgerSnapshot, feeLedgerSnapshot] = await Promise.all([
        transaction.get(paymentRefDoc), transaction.get(walletRef), transaction.get(profileRef), transaction.get(slotRef), transaction.get(ledgerRef), transaction.get(feeLedgerRef),
      ]);
      const followUpProposalSnapshot = followUpProposalRef ? await transaction.get(followUpProposalRef) : null;
      const pendingProposalMatches = appointment.bookingType !== "doctor_proposed_appointment" || Boolean(
        followUpProposalSnapshot?.exists && followUpProposalSnapshot.get("status") === "PENDING" &&
        followUpProposalSnapshot.get("patientUid") === user.uid && followUpProposalSnapshot.get("providerUid") === appointment.providerUid &&
        followUpProposalSnapshot.get("slotId") === slotId && followUpProposalSnapshot.get("pendingAppointmentId") === appointmentId,
      );
      const bookedProposalMatches = appointment.bookingType !== "doctor_proposed_appointment" || Boolean(
        followUpProposalSnapshot?.exists && followUpProposalSnapshot.get("status") === "BOOKED" &&
        followUpProposalSnapshot.get("patientUid") === user.uid && followUpProposalSnapshot.get("bookedAppointmentId") === appointmentId,
      );
      if (!paymentSnapshot.exists) throw new ApiRequestError(409, "appointment-payment-invalid", "La référence de paiement n’existe plus.");
      const payment = paymentSnapshot.data() || {};
      const amount = Number(appointment.amount);
      const transactionFee = Number(appointment.transactionFee) || 0;
      const totalAmount = Number(appointment.totalAmount ?? amount);
      const amountMinor = Math.round(totalAmount * 100);
      const paymentMatches = payment.uid === user.uid && payment.resourceType === "appointment" && payment.resourcePath === appointmentRef.path &&
        appointmentPaymentMatches(appointment, payment) && String(payment.currency || "").toUpperCase() === "HTG" && String(appointment.currency || "").toUpperCase() === "HTG";
      if (!paymentMatches || !Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(transactionFee) || transactionFee < 0 || !Number.isSafeInteger(totalAmount) || totalAmount !== amount + transactionFee || totalAmount > 10_000_000) throw new ApiRequestError(409, "appointment-payment-invalid", "Le montant de ce rendez-vous ne peut pas être vérifié.");

      if (payment.status === "paid" && payment.paymentMethod === "MONCASH") {
        if (appointment.status === "REFUNDED" || appointment.paymentStatus === "REFUNDED") throw new ApiRequestError(409, "appointment-refunded", "Ce rendez-vous a déjà été remboursé.");
        return { paymentRef, ledgerId: "", amount, transactionFee, totalAmount, alreadyPaid: true, needsSettlement: appointment.status === "PENDING_PAYMENT", paymentMethod: "MONCASH" as const, patientUid: user.uid, providerUid: String(appointment.providerUid || ""), appointmentStatus: String(appointment.status || ""), homeVisitCode: "" };
      }
      if (ledgerSnapshot.exists) {
        const existingLedger = ledgerSnapshot.data() || {};
        const feeLedgerMatches = transactionFee === 0 ? !feeLedgerSnapshot.exists : feeLedgerSnapshot.exists && feeLedgerSnapshot.get("paymentRef") === paymentRef && feeLedgerSnapshot.get("resourceId") === appointmentId && Number(feeLedgerSnapshot.get("amountMinor")) === transactionFee * 100 && feeLedgerSnapshot.get("recipient") === "NEXARIS" && feeLedgerSnapshot.get("paymentMethod") === "SMART_WALLET" && feeLedgerSnapshot.get("status") === "COMPLETED";
        if (existingLedger.userUid !== user.uid || existingLedger.resourceType !== "appointment" || existingLedger.resourceId !== appointmentId || existingLedger.direction !== "DEBIT" || Number(existingLedger.amountMinor) !== amountMinor || Number(existingLedger.serviceAmountMinor) !== amount * 100 || Number(existingLedger.transactionFeeMinor || 0) !== transactionFee * 100 || !feeLedgerMatches || !bookedProposalMatches || payment.status !== "paid" || payment.paymentMethod !== "SMART_WALLET") {
          throw new ApiRequestError(409, "wallet-ledger-conflict", "Le registre du portefeuille et le paiement du rendez-vous ne concordent pas.");
        }
        return { paymentRef, ledgerId, amount, transactionFee, totalAmount, alreadyPaid: true, needsSettlement: false, paymentMethod: "SMART_WALLET" as const, patientUid: user.uid, providerUid: String(appointment.providerUid || ""), appointmentStatus: String(appointment.status || ""), homeVisitCode: appointment.bookingType === "home_visit" && typeof appointment.homeVisitMissionCode === "string" ? appointment.homeVisitMissionCode : "" };
      }

      if (!profileSnapshot.exists || profileSnapshot.get("role") !== "patient" || profileSnapshot.get("profileComplete") !== true) throw new ApiRequestError(403, "complete-patient-profile-required", "Un profil patient NEXA complet est requis.");
      if (appointment.status !== "PENDING_PAYMENT" || appointment.paymentStatus !== "PENDING" || appointment.refundRequired === true) throw new ApiRequestError(409, "appointment-not-payable", "Ce rendez-vous n’accepte plus de paiement par portefeuille.");
      if (!pendingProposalMatches) throw new ApiRequestError(409, "follow-up-proposal-unavailable", "La proposition du médecin n’est plus valide pour ce paiement.");
      if (payment.status !== "created" || payment.paymentMethod !== "MONCASH") throw new ApiRequestError(409, "payment-method-already-started", "Un paiement externe a déjà été commencé. Terminez ou faites vérifier ce paiement avant de choisir le portefeuille.");
      const holdExpiresAt = Number(appointment.holdExpiresAt || 0);
      const slot = slotSnapshot.data() || {};
      if (!slotSnapshot.exists || slot.status !== "held" || slot.appointmentId !== appointmentId || slot.patientUid !== user.uid || holdExpiresAt <= Date.now() || Number(slot.holdExpiresAt) <= Date.now()) {
        throw new ApiRequestError(409, "appointment-hold-expired", "La retenue du créneau a expiré. Réservez un autre créneau.");
      }

      const wallet = walletSnapshot.data() || {};
      const availableMinor = Number(wallet.availableMinor || 0);
      const reservedMinor = Number(wallet.reservedMinor || 0);
      if (!walletSnapshot.exists || wallet.status !== "ACTIVE" || wallet.currency !== "HTG" || !Number.isSafeInteger(availableMinor) || availableMinor < amountMinor || !Number.isSafeInteger(reservedMinor) || reservedMinor < 0) {
        throw new ApiRequestError(409, "insufficient-wallet-balance", "Le portefeuille NEXA est suspendu ou son solde disponible est insuffisant.");
      }
      if (feeLedgerSnapshot.exists) {
        throw new ApiRequestError(409, "transaction-fee-ledger-conflict", "Le registre des frais de transaction ne concorde pas avec ce paiement.");
      }

      const now = FieldValue.serverTimestamp();
      transaction.update(walletRef, { availableMinor: availableMinor - amountMinor, updatedAt: now });
      transaction.create(ledgerRef, {
        userUid: user.uid,
        walletId: user.uid,
        type: "APPOINTMENT_PAYMENT",
        direction: "DEBIT",
        amountMinor,
        serviceAmountMinor: amount * 100,
        transactionFeeMinor: transactionFee * 100,
        currency: "HTG",
        resourceType: "appointment",
        resourceId: appointmentId,
        paymentRef,
        source: "NEXA",
        status: "COMPLETED",
        createdAt: now,
      });
      if (transactionFee > 0) {
        transaction.create(feeLedgerRef, {
          paymentRef,
          resourceType: "appointment",
          resourceId: appointmentId,
          serviceAmountMinor: amount * 100,
          amountMinor: transactionFee * 100,
          currency: "HTG",
          recipient: "NEXARIS",
          transactionFeeRateBps: Number(appointment.transactionFeeRateBps) || 0,
          paymentMethod: "SMART_WALLET",
          status: "COMPLETED",
          createdAt: now,
        });
      }
      transaction.set(paymentRefDoc, {
        status: "paid",
        paymentMethod: "SMART_WALLET",
        paymentProvider: "nexa-wallet",
        walletLedgerId: ledgerId,
        paidAt: now,
        updatedAt: now,
      }, { merge: true });
      const homeVisitCode = appointment.bookingType === "home_visit"
        ? typeof appointment.homeVisitMissionCode === "string" ? appointment.homeVisitMissionCode : String(randomInt(0, 100_000_000)).padStart(8, "0")
        : "";
      transaction.set(appointmentRef, {
        status: appointment.bookingType === "doctor_proposed_appointment" ? "DOCTOR_ACCEPTED" : "CONFIRMED",
        paymentStatus: "PAID",
        paymentMethod: "SMART_WALLET",
        sessionStatus: appointment.bookingType === "home_visit" ? null : "SCHEDULED",
        ...(appointment.bookingType === "home_visit" ? {
          homeVisitMissionStatus: "SCHEDULED",
          homeVisitMissionCode: homeVisitCode,
          homeVisitMissionCodeHash: createHash("sha256").update(`NEXA_HOME_VISIT:${appointmentId}:${homeVisitCode}`).digest("hex"),
          homeVisitMissionCodeIssuedAt: now,
        } : {}),
        refundRequired: false,
        paidAt: now,
        updatedAt: now,
      }, { merge: true });
      if (followUpProposalRef) transaction.set(followUpProposalRef, {
        status: "BOOKED",
        bookedAppointmentId: appointmentId,
        paidAt: now,
        updatedAt: now,
      }, { merge: true });
      transaction.set(slotRef, {
        status: "booked",
        holdExpiresAt: FieldValue.delete(),
        updatedAt: now,
      }, { merge: true });
      const appointmentStatus = appointment.bookingType === "doctor_proposed_appointment" ? "DOCTOR_ACCEPTED" : "CONFIRMED";
      return { paymentRef, ledgerId, amount, transactionFee, totalAmount, alreadyPaid: false, needsSettlement: false, paymentMethod: "SMART_WALLET" as const, patientUid: user.uid, providerUid: String(appointment.providerUid || ""), appointmentStatus, homeVisitCode };
    });

    if (outcome.paymentMethod === "MONCASH") {
      if (outcome.needsSettlement) await settlePaidPayment(outcome.paymentRef);
      return json(request, { ok: true, status: "paid", paymentMethod: "MONCASH", appointmentStatus: outcome.appointmentStatus, alreadyPaid: true });
    }
    if (outcome.patientUid) {
      const isHomeVisit = Boolean(outcome.homeVisitCode);
      const eventKey = `appointment:payment:${outcome.paymentRef}`;
      const tasks = [createUserNotification({
        uid: outcome.patientUid,
        eventKey,
        appointmentId,
        type: isHomeVisit ? "home_visit_payment_confirmed" : "appointment_payment_confirmed",
        title: isHomeVisit ? "Visite à domicile confirmée" : "Paiement confirmé",
        body: isHomeVisit ? `Votre visite est confirmée. Gardez votre code de clôture : ${outcome.homeVisitCode}. Remettez-le au médecin après la visite.` : "Votre rendez-vous est confirmé. NEXA vous avisera de la suite.",
        url: "/espace",
      })];
      if (outcome.providerUid) tasks.push(createUserNotification({
        uid: outcome.providerUid,
        eventKey,
        appointmentId,
        type: "appointment_payment_confirmed",
        title: "Nouveau rendez-vous payé",
        body: "Un patient a réservé et payé un créneau. Consultez votre espace professionnel.",
        url: "/professionnels/espace",
      }));
      await Promise.all(tasks);
      if (isHomeVisit) await sendUserTransactionalEmail({
        uid: outcome.patientUid,
        eventKey: `home-visit-mission-code:${appointmentId}:${outcome.paymentRef}`,
        subject: "Code de clôture de votre visite NEXA",
        text: `Votre visite médicale à domicile est confirmée. Votre code de clôture est ${outcome.homeVisitCode}. Remettez-le au médecin après la visite pour clôturer la mission. Ne le communiquez pas avant d’avoir vérifié sa présence. Consultez votre espace : https://nexarishaiti.com/espace`,
        html: `<p>Votre visite médicale à domicile est confirmée.</p><p>Votre code de clôture est <strong>${outcome.homeVisitCode}</strong>.</p><p>Remettez-le au médecin après la visite pour clôturer la mission. Ne le communiquez pas avant d’avoir vérifié sa présence.</p><p><a href="https://nexarishaiti.com/espace">Consulter mon espace NEXA</a></p>`,
      }).catch((error) => { console.error("NEXA home visit mission-code email failed", error instanceof Error ? error.name : "unknown-error"); });
    }
    return json(request, { ok: true, status: "paid", paymentMethod: "SMART_WALLET", appointmentStatus: outcome.appointmentStatus, amount: outcome.amount, transactionFee: outcome.transactionFee, totalAmount: outcome.totalAmount, currency: "HTG", alreadyPaid: outcome.alreadyPaid });
  } catch (error) { return fail(request, error); }
}
