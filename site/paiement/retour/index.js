import { auth, firebaseAuthActions, initializePatientProfile, requestNexaFunction, NexaApiError } from "../../firebase-client.js";

const paymentRef = new URLSearchParams(window.location.search).get("paymentRef") || "";
const status = document.querySelector("#payment-status");
const error = document.querySelector("#payment-error");
const retry = document.querySelector("#retry-payment-status");
const patientLink = document.querySelector("#patient-space-link");
let currentUser = null;
let checking = false;

function showError(message) {
  error.textContent = message || "";
  error.hidden = !message;
}

function loginForPayment() {
  const next = new URL(window.location.href);
  const login = new URL("../../connexion.html", window.location.href);
  login.searchParams.set("next", next.href);
  window.location.replace(login.href);
}

function renderPayment(payload) {
  const labels = {
    paid: "Paiement confirmé. Votre service NEXA a été mis à jour dans votre espace patient.",
    pending: "MonCash traite encore le paiement. Ne lancez pas une seconde transaction; vous pouvez vérifier de nouveau dans quelques instants.",
    creating: "La préparation du paiement est toujours en cours. Vérifiez de nouveau dans quelques instants.",
    creation_uncertain: "La réponse de MonCash est en attente de rapprochement. Ne payez pas une seconde fois.",
    creation_failed: "Le paiement n’est pas confirmé. Vérifiez de nouveau ou contactez NEXA si votre compte MonCash a été débité.",
  };
  const paymentStatus = String(payload.status || "").toLowerCase();
  const appointmentStatus = String(payload.appointmentStatus || "");
  const settlementStatus = String(payload.settlementStatus || "");
  if (paymentStatus === "paid" && settlementStatus === "REVIEW_REQUIRED") {
    status.textContent = "MonCash confirme le paiement, mais NEXA doit rapprocher la commande. Ne payez pas de nouveau; l’administration vérifiera la transaction et le remboursement éventuel du prix du service.";
  } else if (paymentStatus === "paid" && appointmentStatus === "PAYMENT_CONFLICT_REFUND_REQUIRED") {
    status.textContent = "MonCash confirme le paiement, mais le créneau n’a plus pu être retenu. Ne payez pas de nouveau; NEXA doit rapprocher le paiement et suivre le remboursement.";
  } else if (paymentStatus === "paid" && ["CONFIRMED", "DOCTOR_ACCEPTED"].includes(appointmentStatus)) {
    status.textContent = "Paiement confirmé et rendez-vous réservé. Le rendez-vous est visible dans votre espace patient.";
  } else if (paymentStatus === "paid" && settlementStatus === "CONFIRMED") {
    status.textContent = "Paiement confirmé et commande d’examens transmise au centre. Consultez le suivi dans votre espace patient.";
  } else {
    status.textContent = labels[paymentStatus] || "Le statut du paiement n’a pas encore pu être confirmé. Vérifiez de nouveau avant toute nouvelle tentative.";
  }
  const paymentNeedsReview = paymentStatus === "creation_failed" || (paymentStatus === "paid" && (appointmentStatus === "PAYMENT_CONFLICT_REFUND_REQUIRED" || settlementStatus === "REVIEW_REQUIRED"));
  status.classList.toggle("nexa-auth-message--error", paymentNeedsReview);
  status.classList.toggle("nexa-auth-message--notice", !paymentNeedsReview);
  patientLink.hidden = paymentStatus !== "paid";
  retry.hidden = paymentStatus === "paid";
  return paymentStatus;
}

async function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function checkPayment({ automatic = false } = {}) {
  if (checking) return;
  if (!currentUser) {
    loginForPayment();
    return;
  }
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(paymentRef)) {
    showError("La référence de paiement est absente ou invalide. Ouvrez ce lien depuis votre parcours de réservation NEXA.");
    status.hidden = true;
    retry.hidden = true;
    return;
  }

  checking = true;
  retry.disabled = true;
  retry.textContent = "Vérification…";
  showError("");
  try {
    const profile = await initializePatientProfile(currentUser);
    if (!profile.profileComplete) {
      const registration = new URL("../../inscription.html", window.location.href);
      registration.searchParams.set("completer", "1");
      registration.searchParams.set("next", new URL(window.location.href).href);
      window.location.replace(registration.href);
      return;
    }
    for (let attempt = 0; attempt < (automatic ? 8 : 1); attempt += 1) {
      const result = await requestNexaFunction(currentUser, "appointmentMoncashStatus", "POST", { paymentRef });
      const paymentStatus = renderPayment(result);
      if (paymentStatus === "paid" || paymentStatus === "creation_failed") return;
      if (!automatic || attempt === 7) return;
      await wait(8_000);
    }
  } catch (cause) {
    showError(cause instanceof NexaApiError
      ? cause.message
      : "Le statut du paiement ne peut pas être vérifié pour le moment. Réessayez avant de payer de nouveau.");
  } finally {
    checking = false;
    retry.disabled = false;
    retry.textContent = "Vérifier de nouveau";
    if (!patientLink.hidden) retry.hidden = true;
  }
}

retry.addEventListener("click", () => { void checkPayment(); });
firebaseAuthActions.onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) void checkPayment({ automatic: true });
  else loginForPayment();
});
