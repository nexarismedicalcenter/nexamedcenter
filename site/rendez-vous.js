import {
  auth,
  fetchNexaPublicFunction,
  firebaseAuthActions,
  initializePatientProfile,
  requestNexaFunction,
  NexaApiError,
} from "./firebase-client.js";
import { FUNCTIONS_BASE_URL } from "./firebase-config.js";

const parameters = new URLSearchParams(window.location.search);
const providerUid = parameters.get("providerUid") || "";
const followUpProposalId = parameters.get("proposalId") || "";
const servicePicker = document.querySelectorAll('input[name="service-type"]');
const status = document.querySelector("#availability-status");
const error = document.querySelector("#availability-error");
const retry = document.querySelector("#availability-retry");
const providerSummary = document.querySelector("#provider-summary");
const providerName = document.querySelector("#provider-name");
const providerDetails = document.querySelector("#provider-details");
const providerService = document.querySelector("#provider-service");
const providerPrice = document.querySelector("#provider-price");
const homeVisitOptions = document.querySelector("#home-visit-options");
const homeVisitService = document.querySelector("#home-visit-service");
const homeVisitZones = document.querySelector("#home-visit-zones");
const homeVisitAddress = document.querySelector("#home-visit-address");
const homeVisitZone = document.querySelector("#home-visit-zone");
const homeVisitAddressLine = document.querySelector("#home-visit-address-line");
const homeVisitPhone = document.querySelector("#home-visit-phone");
const slotsEmpty = document.querySelector("#slots-empty");
const slotsList = document.querySelector("#availability-slots");
const bookingPanel = document.querySelector("#booking-panel");
const bookingSelectedSlot = document.querySelector("#booking-selected-slot");
const bookingForm = document.querySelector("#booking-form");
const bookingError = document.querySelector("#booking-error");
const bookingStatus = document.querySelector("#booking-status");
const reserveButton = document.querySelector("#reserve-appointment");
const paymentConfirmation = document.querySelector("#payment-confirmation");
const paymentAmountSummary = document.querySelector("#payment-amount-summary");
const walletPaymentBalance = document.querySelector("#wallet-payment-balance");
const payWalletButton = document.querySelector("#pay-wallet");
const payMoncashButton = document.querySelector("#pay-moncash");
const walletAppointmentLink = document.querySelector("#wallet-appointment-link");
let latestProvider = null;
let currentUser = null;
let selectedSlot = null;
let pendingIntent = null;
let availableSlots = [];

const homeVisitServices = {
  CONSULTATION_EXAMINATION: "Consultation et examen",
  EVALUATION_ORIENTATION: "Évaluation et orientation",
  CHRONIC_DISEASE_FOLLOW_UP: "Suivi des maladies chroniques",
  GERIATRIC_CARE: "Soins gériatriques",
  PEDIATRIC_CARE: "Soins pédiatriques",
  PALLIATIVE_CARE: "Soins palliatifs",
  NON_LIFE_THREATENING_URGENT_CARE: "Urgence non vitale",
  PRESCRIPTION: "Prescription",
  PRESCRIPTION_RENEWAL: "Renouvellement d’ordonnance",
  CERTIFICATE: "Certificat médical",
  PREVENTION_COUNSELING: "Conseils de prévention",
};

function formatMoney(value) {
  return new Intl.NumberFormat("fr-HT", { maximumFractionDigits: 0 }).format(value) + " HTG";
}

function formatDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "Horaire à confirmer";
  return new Intl.DateTimeFormat("fr-HT", {
    timeZone: "America/Port-au-Prince",
    dateStyle: "full",
    timeStyle: "short",
  }).format(date);
}

function selectedServiceType() {
  return [...servicePicker].find((input) => input.checked)?.value || "TELECONSULTATION";
}

function showBookingError(message) {
  bookingError.textContent = message || "";
  bookingError.hidden = !message;
}

function showBookingStatus(message) {
  bookingStatus.textContent = message || "";
  bookingStatus.hidden = !message;
}

function closeBookingPanel() {
  selectedSlot = null;
  pendingIntent = null;
  bookingPanel.hidden = true;
  paymentConfirmation.hidden = true;
  showBookingError("");
  showBookingStatus("");
}

function bookingReturnUrl(slotId) {
  const next = new URL("./rendez-vous.html", window.location.href);
  next.searchParams.set("providerUid", providerUid);
  next.searchParams.set("serviceType", selectedServiceType());
  next.searchParams.set("slotId", slotId);
  if (/^[a-f0-9]{32}$/.test(followUpProposalId)) next.searchParams.set("proposalId", followUpProposalId);
  if (selectedServiceType() === "HOME_VISIT" && homeVisitService.value) {
    next.searchParams.set("homeVisitServiceId", homeVisitService.value);
  }
  return next.href;
}

function goToSignIn(slotId) {
  const login = new URL("./connexion.html", window.location.href);
  login.searchParams.set("next", bookingReturnUrl(slotId));
  window.location.assign(login.href);
}

function renderProvider(provider) {
  latestProvider = provider;
  const teleconsultationChoice = [...servicePicker].find((input) => input.value === "TELECONSULTATION");
  const homeVisitChoice = [...servicePicker].find((input) => input.value === "HOME_VISIT");
  const homeVisitLabel = homeVisitChoice?.closest("label")?.querySelector("span");
  if (teleconsultationChoice) teleconsultationChoice.disabled = false;
  if (homeVisitChoice) homeVisitChoice.disabled = provider.homeVisitAvailable !== true;
  if (homeVisitLabel) {
    homeVisitLabel.textContent = provider.homeVisitAvailable === true
      ? "Visite médicale à domicile · 1 heure"
      : "Visite médicale à domicile · non proposée par ce médecin";
  }
  providerName.textContent = provider.name || "Professionnel NEXA";
  providerDetails.textContent = [provider.specialty, provider.commune, provider.department].filter(Boolean).join(" · ");
  providerService.textContent = provider.serviceType === "HOME_VISIT"
    ? "Visite médicale à domicile · 1 heure"
    : "Téléconsultation · " + (provider.consultationDurationMinutes || 25) + " minutes";

  const visit = provider.serviceType === "HOME_VISIT";
  homeVisitOptions.hidden = !visit;
  homeVisitAddress.hidden = !visit;
  homeVisitAddress.querySelectorAll("[required]").forEach((field) => { field.required = visit; });
  if (visit) {
    const tariffs = provider.homeVisitTariffs && typeof provider.homeVisitTariffs === "object" ? provider.homeVisitTariffs : {};
    const options = Object.entries(tariffs).filter(([id, amount]) => homeVisitServices[id] && Number.isSafeInteger(amount) && amount > 0)
      .map(([id, amount]) => {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = homeVisitServices[id] + " · " + formatMoney(amount);
        return option;
      });
    homeVisitService.replaceChildren(...options);
    const zones = Array.isArray(provider.homeVisitZones) ? provider.homeVisitZones : [];
    const zoneOptions = zones.map((zone, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = [zone.commune, zone.department].filter(Boolean).join(" · ");
      return option;
    });
    homeVisitZone.replaceChildren(...zoneOptions);
    homeVisitZones.textContent = zones.length
      ? "Zones desservies : " + zones.map((zone) => [zone.commune, zone.department].filter(Boolean).join(" · ")).join("; ")
      : "Aucune zone n’est affichée.";
  }
  updatePrice();
  providerSummary.hidden = false;
}

function updatePrice() {
  if (!latestProvider) return;
  const amount = latestProvider.serviceType === "HOME_VISIT"
    ? latestProvider.homeVisitTariffs?.[homeVisitService.value]
    : latestProvider.indicativeFee;
  providerPrice.textContent = Number.isSafeInteger(amount) && amount > 0
    ? "Tarif du service : " + formatMoney(amount) + " · les frais et le total exacts seront confirmés avant MonCash"
    : "Tarif en attente de configuration.";
}

function selectSlot(slot) {
  selectedSlot = slot;
  pendingIntent = null;
  bookingPanel.hidden = false;
  paymentConfirmation.hidden = true;
  showBookingError("");
  showBookingStatus("");
  bookingSelectedSlot.textContent = formatDate(slot.startsAt) + " · " + (latestProvider?.name || "Professionnel NEXA");
  const next = new URL(window.location.href);
  next.searchParams.set("slotId", slot.id);
  window.history.replaceState(null, "", next.toString());
  bookingPanel.scrollIntoView({ behavior: "smooth", block: "center" });
}

function renderSlots(slots) {
  if (followUpProposalId) {
    const proposedSlotId = parameters.get("slotId") || "";
    slots = slots.filter((slot) => slot.id === proposedSlotId && slot.serviceType === "TELECONSULTATION");
  }
  availableSlots = slots;
  const items = slots.map((slot) => {
    const item = document.createElement("li");
    const icon = document.createElement("i");
    icon.className = "fas fa-calendar-check";
    icon.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = formatDate(slot.startsAt);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nexa-availability__button nexa-availability__button--secondary";
    button.textContent = "Choisir";
    button.setAttribute("aria-label", "Choisir le créneau du " + formatDate(slot.startsAt));
    button.addEventListener("click", () => {
      if (!currentUser) {
        goToSignIn(slot.id);
        return;
      }
      selectSlot(slot);
    });
    item.append(icon, text, button);
    return item;
  });
  slotsList.replaceChildren(...items);
  const requestedSlot = parameters.get("slotId");
  if (requestedSlot) {
    const match = slots.find((slot) => slot.id === requestedSlot);
    if (match && currentUser) selectSlot(match);
    else if (currentUser) status.textContent = "Le créneau choisi n’est plus disponible. Sélectionnez une nouvelle heure.";
  }
}

async function loadAvailability() {
  closeBookingPanel();
  servicePicker.forEach((input) => { input.disabled = true; });
  status.hidden = false;
  status.textContent = "Chargement des disponibilités…";
  error.hidden = true;
  retry.hidden = true;
  slotsEmpty.hidden = true;
  slotsList.replaceChildren();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(providerUid)) {
    setFailure("Le profil demandé n’est pas disponible.");
    return;
  }
  const url = new URL(FUNCTIONS_BASE_URL + "/publicProviderAvailability");
  url.searchParams.set("providerUid", providerUid);
  url.searchParams.set("serviceType", selectedServiceType());
  try {
    const response = await fetchNexaPublicFunction(url, { headers: { Accept: "application/json" } });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true || !payload.provider || !Array.isArray(payload.slots)) {
      throw new Error(payload?.error || "Les disponibilités ne sont pas accessibles pour le moment.");
    }
    renderProvider(payload.provider);
    renderSlots(payload.slots);
    status.textContent = payload.slots.length === 1 ? "1 créneau publié" : payload.slots.length + " créneaux publiés";
    slotsEmpty.hidden = payload.slots.length !== 0;
  } catch (cause) {
    setFailure(cause instanceof Error ? cause.message : "Les disponibilités ne sont pas accessibles pour le moment.");
  }
}

function setFailure(message) {
  status.hidden = true;
  error.textContent = message;
  error.hidden = false;
  retry.hidden = false;
  providerSummary.hidden = true;
  slotsList.replaceChildren();
  slotsEmpty.hidden = true;
}

async function handleBooking(event) {
  event.preventDefault();
  showBookingError("");
  showBookingStatus("");
  if (!selectedSlot) {
    showBookingError("Choisissez un créneau disponible.");
    return;
  }
  if (!currentUser) {
    goToSignIn(selectedSlot.id);
    return;
  }
  if (!bookingForm.reportValidity()) return;

  reserveButton.disabled = true;
  reserveButton.textContent = "Vérification du profil…";
  try {
    const profile = await initializePatientProfile(currentUser);
    if (!profile.profileComplete) {
      const next = bookingReturnUrl(selectedSlot.id);
      window.location.assign("./inscription.html?completer=1&next=" + encodeURIComponent(next));
      return;
    }
    reserveButton.textContent = "Réservation du créneau…";
    const zone = homeVisitZone.value === "" ? null : latestProvider?.homeVisitZones?.[Number(homeVisitZone.value)];
    const booking = await requestNexaFunction(currentUser, "appointmentBooking", "POST", {
      slotId: selectedSlot.id,
      bookingType: selectedServiceType() === "HOME_VISIT" ? "home_visit" : "teleconsultation",
      ...( /^[a-f0-9]{32}$/.test(followUpProposalId) ? { proposalId: followUpProposalId } : {}),
      ...(selectedServiceType() === "HOME_VISIT" ? {
        homeVisitServiceId: homeVisitService.value,
        homeVisitDetails: {
          department: zone?.department || "",
          commune: zone?.commune || "",
          addressLine: homeVisitAddressLine.value.trim(),
          contactPhone: homeVisitPhone.value.trim(),
        },
      } : {}),
    });
    pendingIntent = booking;
    const feeRate = Number(booking.transactionFeeRate);
    paymentAmountSummary.textContent = "Service " + formatMoney(booking.amount) + " + frais de transaction " + formatMoney(booking.transactionFee) +
      (Number.isFinite(feeRate) ? " (" + new Intl.NumberFormat("fr-HT", { maximumFractionDigits: 2 }).format(feeRate) + " %)" : "") +
      " = total à payer " + formatMoney(booking.totalAmount) + ". Les frais sont attribués à NEXARIS.";
    paymentConfirmation.hidden = false;
    walletAppointmentLink.hidden = true;
    reserveButton.hidden = true;
    showBookingStatus("Le créneau est réservé temporairement pendant 20 minutes. Vérifiez le total, puis choisissez votre moyen de paiement.");
    void loadWalletPaymentBalance();
  } catch (cause) {
    showBookingError(cause instanceof NexaApiError ? cause.message : "La réservation n’a pas abouti. Actualisez les disponibilités puis réessayez.");
  } finally {
    reserveButton.disabled = false;
    reserveButton.textContent = "Continuer vers le paiement";
  }
}

async function loadWalletPaymentBalance() {
  if (!currentUser) {
    walletPaymentBalance.textContent = "Connectez-vous pour consulter votre solde Wallet NEXA.";
    return;
  }
  try {
    const result = await requestNexaFunction(currentUser, "nexaPatientWallet");
    const wallet = result.wallet || {};
    walletPaymentBalance.textContent = "Solde disponible Wallet NEXA : " + formatMoney(Number(wallet.availableMinor || 0) / 100) + ". Les frais indiqués s’appliquent également au paiement Wallet.";
  } catch (cause) {
    walletPaymentBalance.textContent = cause instanceof NexaApiError
      ? cause.message
      : "Le solde Wallet NEXA n’est pas accessible actuellement.";
  }
}

async function startWalletPayment() {
  showBookingError("");
  showBookingStatus("");
  if (!currentUser || !pendingIntent?.paymentRef) {
    showBookingError("La réservation ou la session a expiré. Choisissez de nouveau un créneau.");
    return;
  }
  payWalletButton.disabled = true;
  payMoncashButton.disabled = true;
  payWalletButton.textContent = "Vérification du solde et paiement…";
  try {
    const payment = await requestNexaFunction(currentUser, "appointmentWalletPay", "POST", { paymentRef: pendingIntent.paymentRef });
    if (payment.status !== "paid") throw new Error("Le paiement Wallet n’a pas été confirmé.");
    paymentAmountSummary.textContent = "Paiement Wallet NEXA confirmé. Le prix du service et les frais de transaction ont été débités.";
    payWalletButton.textContent = "Paiement confirmé";
    payMoncashButton.disabled = true;
    payMoncashButton.textContent = "Paiement déjà effectué";
    walletAppointmentLink.hidden = false;
    showBookingStatus("Votre rendez-vous est confirmé. Le paiement a été débité une seule fois de votre Wallet NEXA.");
    void loadWalletPaymentBalance();
  } catch (cause) {
    showBookingError(cause instanceof NexaApiError ? cause.message : cause instanceof Error ? cause.message : "Le paiement Wallet ne peut pas être confirmé. Vérifiez votre espace patient avant de réessayer.");
    payWalletButton.disabled = false;
    payMoncashButton.disabled = false;
    payMoncashButton.textContent = "Payer avec MonCash";
    payWalletButton.textContent = "Réessayer avec Wallet NEXA";
  }
}

async function startMoncashPayment() {
  showBookingError("");
  showBookingStatus("");
  if (!currentUser || !pendingIntent?.paymentRef) {
    showBookingError("La réservation ou la session a expiré. Choisissez de nouveau un créneau.");
    return;
  }
  payMoncashButton.disabled = true;
  payWalletButton.disabled = true;
  payMoncashButton.textContent = "Préparation de MonCash…";
  try {
    const payment = await requestNexaFunction(currentUser, "appointmentMoncashCreate", "POST", { paymentRef: pendingIntent.paymentRef });
    if (payment.status === "paid") {
      const returnPage = new URL("./paiement/retour/", window.location.href);
      returnPage.searchParams.set("paymentRef", pendingIntent.paymentRef);
      window.location.assign(returnPage.href);
      return;
    }
    const checkoutUrl = new URL(String(payment.checkoutUrl || ""));
    if (payment.status !== "pending" || checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "moncashbutton.digicelgroup.com") {
      throw new Error("Le lien de paiement MonCash n’a pas pu être validé.");
    }
    window.location.assign(checkoutUrl.href);
  } catch (cause) {
    showBookingError(cause instanceof NexaApiError ? cause.message : cause instanceof Error ? cause.message : "MonCash est momentanément indisponible. Vérifiez le statut avant de réessayer.");
    payMoncashButton.disabled = false;
    payWalletButton.disabled = false;
    payMoncashButton.textContent = "Réessayer avec MonCash";
  }
}

servicePicker.forEach((input) => {
  input.checked = input.value === (followUpProposalId ? "TELECONSULTATION" : parameters.get("serviceType") === "HOME_VISIT" ? "HOME_VISIT" : "TELECONSULTATION");
  if (followUpProposalId && input.value === "HOME_VISIT") input.disabled = true;
  input.addEventListener("change", () => {
    const next = new URLSearchParams(window.location.search);
    next.set("providerUid", providerUid);
    next.set("serviceType", selectedServiceType());
    next.delete("slotId");
    window.history.replaceState(null, "", "./rendez-vous.html?" + next.toString());
    void loadAvailability();
  });
});

if (/^[a-f0-9]{32}$/.test(followUpProposalId)) {
  const notice = document.createElement("p");
  notice.className = "nexa-availability__notice";
  notice.setAttribute("role", "status");
  notice.textContent = "Votre médecin vous a proposé ce créneau de suivi. Après confirmation, vérifiez le total incluant les frais avant de choisir MonCash ou Wallet NEXA.";
  document.querySelector(".nexa-availability__service-picker")?.after(notice);
}

homeVisitService.addEventListener("change", updatePrice);
retry.addEventListener("click", () => void loadAvailability());
bookingForm.addEventListener("submit", (event) => { void handleBooking(event); });
payWalletButton.addEventListener("click", () => { void startWalletPayment(); });
payMoncashButton.addEventListener("click", () => { void startMoncashPayment(); });
firebaseAuthActions.onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (user) void loadWalletPaymentBalance();
  else walletPaymentBalance.textContent = "Connectez-vous pour consulter votre solde Wallet NEXA.";
  if (user && availableSlots.length) {
    const requestedSlot = parameters.get("slotId");
    const match = availableSlots.find((slot) => slot.id === requestedSlot);
    if (match && bookingPanel.hidden) selectSlot(match);
    else if (requestedSlot && !match) status.textContent = "Le créneau choisi n’est plus disponible. Sélectionnez une nouvelle heure.";
  }
});
void loadAvailability();
