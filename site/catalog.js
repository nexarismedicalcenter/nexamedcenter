import { FUNCTIONS_BASE_URL } from "./firebase-config.js";
import { auth, fetchNexaPublicFunction, firebaseAuthActions, initializePatientProfile, requestNexaFunction, NexaApiError } from "./firebase-client.js";
const FUNCTION_URL = FUNCTIONS_BASE_URL + "/publicCatalog";
const NURSING_PUBLIC_CATALOG_URL = FUNCTIONS_BASE_URL + "/nexaNursingPublicCatalog";
const DIAGNOSTIC_OFFERS_URL = FUNCTIONS_BASE_URL + "/nexaDiagnosticPublicOffers";
const PHARMACY_PRODUCTS_URL = FUNCTIONS_BASE_URL + "/nexaPharmacyPublicProducts";
const catalogLabels = {
  doctors: { title: "Nexa - Care", description: "Trouvez un médecin et explorez les possibilités de soins NEXARIS.", icon: "fa-user-doctor" },
  nurses: { title: "Soins infirmiers à domicile", description: "Consultez les services, zones, tarifs et périodes de travail proposés par les infirmier·ères NEXARIS.", icon: "fa-user-nurse" },
  pharmacies: { title: "Nexa - Pharma", description: "Retrouvez les pharmacies et services pharmaceutiques partenaires.", icon: "fa-prescription-bottle-medical" },
  laboratories: { title: "Nexa - Lab", description: "Consultez les laboratoires et leurs services disponibles.", icon: "fa-flask" },
  "imaging-centers": { title: "Nexa - Imaging", description: "Parcourez les centres et services d’imagerie médicale.", icon: "fa-x-ray" },
};

const parameters = new URLSearchParams(window.location.search);
let activeSearch = new URLSearchParams(parameters);
const requestedPrescriptionId = /^[A-Za-z0-9_-]{10,200}$/.test(parameters.get("prescriptionId") || "")
  ? parameters.get("prescriptionId")
  : "";
const requestedPrescriptionOfferId = /^[A-Za-z0-9_-]{10,200}$/.test(parameters.get("offerId") || "")
  ? parameters.get("offerId")
  : "";
let prescriptionOfferLookupPending = Boolean(requestedPrescriptionId && requestedPrescriptionOfferId);
const type = parameters.get("type") || "";
const label = catalogLabels[type];
const title = document.querySelector("#catalog-title");
const description = document.querySelector("#catalog-description");
const catalogSeoDescriptions = {
  doctors: "Trouvez un médecin NEXARIS et consultez les services de soins disponibles.",
  nurses: "Consultez les services, zones, tarifs et périodes de travail proposés par les infirmier·ères NEXARIS.",
  pharmacies: "Retrouvez les pharmacies partenaires NEXARIS et leurs services pharmaceutiques.",
  laboratories: "Consultez les laboratoires partenaires NEXARIS et leurs services disponibles.",
  "imaging-centers": "Parcourez les centres partenaires NEXARIS et leurs services d’imagerie médicale.",
};
const form = document.querySelector("#catalog-search");
const queryInput = document.querySelector("#catalog-query");
const departmentInput = document.querySelector("#catalog-department");
const homeVisitFilter = document.querySelector("#home-visit-filter");
const homeVisitOnly = document.querySelector("#home-visit-only");
const nursingProviderMore = document.querySelector("#nursing-provider-more");
const status = document.querySelector("#catalog-status");
const results = document.querySelector("#catalog-results");
const pharmacyProductSection = document.querySelector("#pharmacy-product-section");
const pharmacyProductResults = document.querySelector("#pharmacy-product-results");
const pharmacyCartPanel = document.querySelector("#pharmacy-cart-panel");
const pharmacyCartCount = document.querySelector("#pharmacy-cart-count");
const pharmacyCartItems = document.querySelector("#pharmacy-cart-items");
const pharmacyCartSubtotal = document.querySelector("#pharmacy-cart-subtotal");
const pharmacyCartCheckout = document.querySelector("#pharmacy-cart-checkout");
const pharmacyCheckoutDialog = document.querySelector("#pharmacy-checkout-dialog");
const pharmacyCheckoutClose = document.querySelector("#pharmacy-checkout-close");
const pharmacyCheckoutPrescription = document.querySelector("#pharmacy-checkout-prescription");
const pharmacyPrescriptionOptional = document.querySelector("#pharmacy-prescription-optional");
const pharmacyDeliveryMethod = document.querySelector("#pharmacy-checkout-delivery-method");
const pharmacyDeliveryOption = document.querySelector("#pharmacy-checkout-delivery-option");
const pharmacyDeliveryFields = document.querySelector("#pharmacy-checkout-delivery-fields");
const pharmacyDeliveryRecipient = document.querySelector("#pharmacy-checkout-recipient");
const pharmacyDeliveryPhone = document.querySelector("#pharmacy-checkout-phone");
const pharmacyDeliveryZone = document.querySelector("#pharmacy-checkout-zone");
const pharmacyDeliveryAddress = document.querySelector("#pharmacy-checkout-address");
const pharmacyDeliveryInstructions = document.querySelector("#pharmacy-checkout-instructions");
const pharmacyDeliveryNote = document.querySelector("#pharmacy-checkout-delivery-note");
const pharmacyCheckoutError = document.querySelector("#pharmacy-checkout-error");
const pharmacyCheckoutStatus = document.querySelector("#pharmacy-checkout-status");
const pharmacyCheckoutCreate = document.querySelector("#pharmacy-checkout-create");
const diagnosticOfferSection = document.querySelector("#diagnostic-offer-section");
const diagnosticOfferResults = document.querySelector("#diagnostic-offer-results");
const diagnosticOfferMore = document.querySelector("#diagnostic-offer-more");
const diagnosticCartPanel = document.querySelector("#diagnostic-cart-panel");
const diagnosticCartCount = document.querySelector("#diagnostic-cart-count");
const diagnosticCartItems = document.querySelector("#diagnostic-cart-items");
const diagnosticCartSubtotal = document.querySelector("#diagnostic-cart-subtotal");
const diagnosticCartCheckout = document.querySelector("#diagnostic-cart-checkout");
const checkoutDialog = document.querySelector("#diagnostic-checkout-dialog");
const checkoutClose = document.querySelector("#diagnostic-checkout-close");
const checkoutPrescription = document.querySelector("#diagnostic-checkout-prescription");
const prescriptionOptional = document.querySelector("#diagnostic-prescription-optional");
const checkoutError = document.querySelector("#diagnostic-checkout-error");
const checkoutStatus = document.querySelector("#diagnostic-checkout-status");
const checkoutCreate = document.querySelector("#diagnostic-checkout-create");
const nursingBookingDialog = document.querySelector("#nursing-booking-dialog");
const nursingBookingForm = document.querySelector("#nursing-booking-form");
const nursingBookingClose = document.querySelector("#nursing-booking-close");
const nursingBookingProvider = document.querySelector("#nursing-booking-provider");
const nursingBookingModeDescription = document.querySelector("#nursing-booking-mode-description");
const nursingBookingZone = document.querySelector("#nursing-booking-zone");
const nursingBookingWeek = document.querySelector("#nursing-booking-week");
const nursingBookingPeriod = document.querySelector("#nursing-booking-period");
const nursingBookingSchedule = document.querySelector("#nursing-booking-schedule");
const nursingBookingPrice = document.querySelector("#nursing-booking-price");
const nursingBookingServices = document.querySelector("#nursing-booking-services");
const nursingBookingPhone = document.querySelector("#nursing-booking-phone");
const nursingBookingDepartment = document.querySelector("#nursing-booking-department");
const nursingBookingCommune = document.querySelector("#nursing-booking-commune");
const nursingBookingAddress = document.querySelector("#nursing-booking-address");
const nursingBookingError = document.querySelector("#nursing-booking-error");
const nursingBookingStatus = document.querySelector("#nursing-booking-status");
const nursingBookingSubmit = document.querySelector("#nursing-booking-submit");
let currentUser = null;
let authReady = false;
let authReadyResolve;
const authReadyPromise = new Promise((resolve) => { authReadyResolve = resolve; });
const CART_STORAGE_KEY = "nexa-diagnostic-cart-v1";
const ORDER_REQUEST_STORAGE_KEY = "nexa-diagnostic-order-request-id-v1";
const PHARMACY_CART_STORAGE_KEY = "nexa-pharmacy-cart-v1";
const PHARMACY_REQUEST_STORAGE_KEY = "nexa-pharmacy-order-request-id-v1";
let diagnosticCart = [];
let pharmacyCart = [];
let availableDiagnosticOffers = [];
let diagnosticOffersCursor = "";
let diagnosticOffersHasMore = false;
let diagnosticOffersLoading = false;
let catalogLoadGeneration = 0;
let diagnosticProviderCount = 0;
let nursingProvidersCursor = "";
let nursingProvidersHasMore = false;
let nursingProvidersLoading = false;
let nursingProvidersShown = 0;
let availablePharmacyProducts = [];
let pharmacyDeliveryEnabled = false;
let activeOrderRequestId = "";
let activePharmacyRequestId = "";
let activeNursingProvider = null;
let activeNursingRequestId = "";
try {
  const storedCart = JSON.parse(sessionStorage.getItem(CART_STORAGE_KEY) || "[]");
  if (Array.isArray(storedCart)) diagnosticCart = storedCart.filter((item) => item && typeof item.id === "string" && typeof item.providerUid === "string").slice(0, 10);
  activeOrderRequestId = sessionStorage.getItem(ORDER_REQUEST_STORAGE_KEY) || "";
} catch { diagnosticCart = []; }
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(activeOrderRequestId)) activeOrderRequestId = "";
try {
  const storedCart = JSON.parse(sessionStorage.getItem(PHARMACY_CART_STORAGE_KEY) || "[]");
  if (Array.isArray(storedCart)) pharmacyCart = storedCart.filter((item) => item && typeof item.id === "string" && typeof item.providerUid === "string" && Number.isSafeInteger(item.quantity) && item.quantity > 0).slice(0, 20);
  activePharmacyRequestId = sessionStorage.getItem(PHARMACY_REQUEST_STORAGE_KEY) || "";
} catch { pharmacyCart = []; }
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(activePharmacyRequestId)) activePharmacyRequestId = "";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function formatMoney(value) {
  return new Intl.NumberFormat("fr-HT", { maximumFractionDigits: 0 }).format(Number(value || 0)) + " HTG";
}

function updateCatalogMetadata(search) {
  const canonical = document.querySelector('link[rel="canonical"]');
  const robots = document.querySelector('meta[name="robots"]');
  const isHomeVisit = type === "doctors" && search.get("service") === "HOME_VISIT";
  if (!label) {
    document.title = "Répertoire indisponible | NEXARIS MEDICAL CENTER";
    robots?.setAttribute("content", "noindex,follow");
    canonical?.setAttribute("href", "https://nexarishaiti.com/catalog.html");
    return;
  }

  const pageTitle = isHomeVisit
    ? "Médecins à domicile | NEXARIS MEDICAL CENTER"
    : `${label.title} | NEXARIS MEDICAL CENTER`;
  const pageDescription = isHomeVisit
    ? "Trouvez un médecin NEXARIS proposant des visites médicales à domicile et consultez les disponibilités publiées."
    : catalogSeoDescriptions[type] || label.description;
  const canonicalUrl = new URL("https://nexarishaiti.com/catalog.html");
  canonicalUrl.searchParams.set("type", type);
  if (isHomeVisit) canonicalUrl.searchParams.set("service", "HOME_VISIT");

  document.title = pageTitle;
  document.querySelector('meta[name="description"]')?.setAttribute("content", pageDescription);
  document.querySelector('meta[property="og:title"]')?.setAttribute("content", pageTitle);
  document.querySelector('meta[property="og:description"]')?.setAttribute("content", pageDescription);
  document.querySelector('meta[property="og:url"]')?.setAttribute("content", canonicalUrl.href);
  robots?.setAttribute("content", "index,follow");
  canonical?.setAttribute("href", canonicalUrl.href);
}

function persistCart() {
  try { sessionStorage.setItem(CART_STORAGE_KEY, JSON.stringify(diagnosticCart)); } catch { /* cart remains available for this page */ }
}

function resetOrderRequestId() {
  activeOrderRequestId = diagnosticCart.length ? window.crypto.randomUUID() : "";
  try {
    if (activeOrderRequestId) sessionStorage.setItem(ORDER_REQUEST_STORAGE_KEY, activeOrderRequestId);
    else sessionStorage.removeItem(ORDER_REQUEST_STORAGE_KEY);
  } catch { /* idempotency remains active for this page */ }
}

function renderCart() {
  if (!diagnosticCartPanel) return;
  diagnosticCartPanel.hidden = diagnosticCart.length === 0;
  diagnosticCartCount.textContent = diagnosticCart.length + (diagnosticCart.length === 1 ? " examen" : " examens");
  diagnosticCartSubtotal.textContent = formatMoney(diagnosticCart.reduce((sum, item) => sum + (Number.isSafeInteger(item.price) ? item.price : 0), 0));
  diagnosticCartItems.replaceChildren();
  diagnosticCart.forEach((item) => {
    const row = element("li", "nexa-catalog-cart__item");
    const description = element("div");
    description.append(element("strong", "", item.name || "Examen"), element("span", "", (item.providerName || "Partenaire NEXA") + " · " + formatMoney(item.price)));
    const remove = element("button", "nexa-catalog-cart__remove", "Retirer");
    remove.type = "button";
    remove.setAttribute("aria-label", "Retirer " + (item.name || "cet examen") + " du panier");
    remove.addEventListener("click", () => {
      diagnosticCart = diagnosticCart.filter((selected) => selected.id !== item.id);
      persistCart();
      resetOrderRequestId();
      renderCart();
      loadCatalogOffersOnly();
    });
    row.append(description, remove);
    diagnosticCartItems.append(row);
  });
}

function persistPharmacyCart() {
  try { sessionStorage.setItem(PHARMACY_CART_STORAGE_KEY, JSON.stringify(pharmacyCart)); } catch { /* panier conservé pour cette page */ }
}

function resetPharmacyRequestId() {
  activePharmacyRequestId = pharmacyCart.length ? window.crypto.randomUUID() : "";
  try {
    if (activePharmacyRequestId) sessionStorage.setItem(PHARMACY_REQUEST_STORAGE_KEY, activePharmacyRequestId);
    else sessionStorage.removeItem(PHARMACY_REQUEST_STORAGE_KEY);
  } catch { /* clé d’idempotence conservée pour cette page */ }
}

function renderPharmacyCart() {
  if (!pharmacyCartPanel) return;
  pharmacyCartPanel.hidden = pharmacyCart.length === 0;
  const count = pharmacyCart.reduce((sum, item) => sum + item.quantity, 0);
  pharmacyCartCount.textContent = `${count} produit${count === 1 ? "" : "s"} · ${pharmacyCart[0]?.pharmacyName || ""}`;
  pharmacyCartSubtotal.textContent = formatMoney(pharmacyCart.reduce((sum, item) => sum + (Number.isSafeInteger(item.price) ? item.price * item.quantity : 0), 0));
  pharmacyCartItems.replaceChildren();
  pharmacyCart.forEach((item) => {
    const row = element("li", "nexa-catalog-cart__item nexa-pharmacy-cart-item");
    const description = element("div");
    description.append(
      element("strong", "", item.name || "Médicament"),
      element("span", "", `${item.pharmacyName || "Pharmacie NEXA"} · ${formatMoney(item.price)} l’unité · ${formatMoney(item.price * item.quantity)}`),
      element("span", "", [item.dci, item.dosage, item.route, item.pharmaceuticalForm].filter(Boolean).join(" · ")),
    );
    const controls = element("div", "nexa-pharmacy-cart-item__controls");
    const decrease = element("button", "nexa-catalog-cart__remove", "−");
    decrease.type = "button";
    decrease.setAttribute("aria-label", `Réduire la quantité de ${item.name || "ce produit"}`);
    decrease.addEventListener("click", () => updatePharmacyQuantity(item.id, item.quantity - 1));
    const quantity = element("span", "", `Qté ${item.quantity}`);
    const increase = element("button", "nexa-catalog-cart__remove", "+");
    increase.type = "button";
    increase.disabled = item.quantity >= Math.min(20, Number(item.stock) || 20);
    increase.setAttribute("aria-label", `Augmenter la quantité de ${item.name || "ce produit"}`);
    increase.addEventListener("click", () => updatePharmacyQuantity(item.id, item.quantity + 1));
    const remove = element("button", "nexa-catalog-cart__remove", "Retirer");
    remove.type = "button";
    remove.setAttribute("aria-label", `Retirer ${item.name || "ce produit"} du panier`);
    remove.addEventListener("click", () => updatePharmacyQuantity(item.id, 0));
    controls.append(decrease, quantity, increase, remove);
    row.append(description, controls);
    pharmacyCartItems.append(row);
  });
}

function updatePharmacyQuantity(productId, quantity) {
  const item = pharmacyCart.find((entry) => entry.id === productId);
  if (!item) return;
  const maximum = Math.min(20, Number(item.stock) || 20);
  const nextQuantity = Math.min(maximum, quantity);
  if (nextQuantity <= 0) pharmacyCart = pharmacyCart.filter((entry) => entry.id !== productId);
  else item.quantity = nextQuantity;
  persistPharmacyCart();
  resetPharmacyRequestId();
  renderPharmacyCart();
  updatePharmacyDeliveryForm();
  loadPharmacyProductsOnly();
}

function normalizedDeliveryLocation(value) {
  return normalized(value).replace(/\s+/g, " ").trim();
}

function pharmacyCartDeliveryZones() {
  if (!pharmacyDeliveryEnabled || !pharmacyCart.length || pharmacyCart.some((item) => !["delivery", "both"].includes(item.deliveryMode) || item.coldChainRequired)) return [];
  const firstZones = Array.isArray(pharmacyCart[0].deliveryZones) ? pharmacyCart[0].deliveryZones : [];
  return firstZones.filter((zone) => zone && zone.active !== false && zone.department && zone.commune).flatMap((zone) => {
    const key = JSON.stringify([normalizedDeliveryLocation(zone.department), normalizedDeliveryLocation(zone.commune)]);
    const matches = pharmacyCart.slice(1).map((item) => (Array.isArray(item.deliveryZones) ? item.deliveryZones : []).find((candidate) =>
      candidate && candidate.active !== false && JSON.stringify([normalizedDeliveryLocation(candidate.department), normalizedDeliveryLocation(candidate.commune)]) === key));
    if (matches.some((match) => !match)) return [];
    return [{
      department: zone.department, commune: zone.commune,
      feeHTG: Math.max(Number(zone.feeHTG) || 0, ...matches.map((match) => Number(match.feeHTG) || 0)),
      etaLabel: zone.etaLabel || "Délai à confirmer",
    }];
  });
}

function updatePharmacyDeliveryForm() {
  if (!pharmacyDeliveryMethod) return;
  const eligibleZones = pharmacyCartDeliveryZones();
  const canDeliver = eligibleZones.length > 0;
  pharmacyDeliveryOption.hidden = !canDeliver;
  pharmacyDeliveryOption.disabled = !canDeliver;
  if (!canDeliver && pharmacyDeliveryMethod.value === "delivery") pharmacyDeliveryMethod.value = "pickup";
  const isDelivery = canDeliver && pharmacyDeliveryMethod.value === "delivery";
  pharmacyDeliveryFields.hidden = !isDelivery;
  [pharmacyDeliveryRecipient, pharmacyDeliveryPhone, pharmacyDeliveryZone, pharmacyDeliveryAddress].forEach((field) => { field.required = isDelivery; });
  const previous = pharmacyDeliveryZone.value;
  pharmacyDeliveryZone.replaceChildren(new Option("Choisissez une commune", ""));
  eligibleZones.forEach((zone) => {
    const value = JSON.stringify([zone.department, zone.commune]);
    pharmacyDeliveryZone.append(new Option(`${zone.commune}, ${zone.department} · ${zone.etaLabel}`, value));
  });
  if (eligibleZones.some((zone) => JSON.stringify([zone.department, zone.commune]) === previous)) pharmacyDeliveryZone.value = previous;
  if (!pharmacyDeliveryEnabled) pharmacyDeliveryNote.textContent = "Retrait en pharmacie · Les frais de transaction s’appliquent également au Wallet NEXA.";
  else if (!canDeliver) pharmacyDeliveryNote.textContent = "Retrait en pharmacie · La livraison n’est pas disponible pour tous les produits ou toutes les communes de ce panier.";
  else if (isDelivery) {
    const selectedZone = eligibleZones.find((zone) => JSON.stringify([zone.department, zone.commune]) === pharmacyDeliveryZone.value);
    pharmacyDeliveryNote.textContent = selectedZone
      ? `Livraison ${selectedZone.commune} · ${formatMoney(selectedZone.feeHTG)} · Les frais de transaction s’appliquent au montant incluant la livraison et également au Wallet NEXA.`
      : "Choisissez une commune pour confirmer les frais de livraison. Les frais de transaction s’appliquent également au Wallet NEXA.";
  } else pharmacyDeliveryNote.textContent = "Retrait en pharmacie · Les frais de transaction s’appliquent également au Wallet NEXA.";
}

function addPharmacyProduct(product) {
  const existing = pharmacyCart.find((item) => item.id === product.id);
  if (existing) {
    if (existing.quantity >= Math.min(20, product.stock)) {
      status.textContent = `La quantité disponible pour « ${product.name} » est déjà dans le panier.`;
      return;
    }
    existing.quantity += 1;
  } else {
    if (pharmacyCart.length >= 20) {
      status.textContent = "Une commande peut contenir au maximum 20 produits différents.";
      return;
    }
    if (pharmacyCart.length && pharmacyCart[0].providerUid !== product.providerUid) {
      status.textContent = "Un panier doit contenir les produits d’une seule pharmacie. Terminez ou videz le panier avant de choisir une autre pharmacie.";
      return;
    }
    pharmacyCart.push({
      id: product.id, providerUid: product.providerUid, pharmacyName: product.pharmacyName, name: product.name,
      dci: product.dci, dosage: product.dosage, route: product.route, pharmaceuticalForm: product.pharmaceuticalForm,
      price: product.price, stock: product.stock, quantity: 1, requiresPrescription: product.prescriptionRequired === true,
      deliveryMode: product.deliveryMode, deliveryZones: product.deliveryZones, coldChainRequired: product.coldChainRequired === true,
    });
  }
  persistPharmacyCart();
  resetPharmacyRequestId();
  renderPharmacyCart();
  updatePharmacyDeliveryForm();
  loadPharmacyProductsOnly();
  status.textContent = "Produit ajouté au panier. Le stock sera réservé pendant 30 minutes après la création de la commande.";
}

function prescriptionMedicationMatches(line, product) {
  const lineName = normalizedExam(line?.name || line?.medication_text);
  if (!lineName || (lineName !== normalizedExam(product.name) && lineName !== normalizedExam(product.dci))) return false;
  if (!normalizedExam(line?.dosage) || normalizedExam(line.dosage) !== normalizedExam(product.dosage)) return false;
  const requestedRoute = normalizedExam(line?.route);
  const offeredRoute = normalizedExam(product.route);
  if (!offeredRoute || (requestedRoute && requestedRoute !== offeredRoute)) return false;
  const requestedForm = normalized(line?.form || line?.pharmaceuticalForm).replace(/[^a-z0-9]+/g, " ").trim();
  const offeredForm = normalized(product.pharmaceuticalForm).replace(/[^a-z0-9]+/g, " ").trim();
  return !requestedForm || Boolean(offeredForm && requestedForm.split(/\s+/).filter((token) => token.length >= 2).every((token) => offeredForm.split(/\s+/).includes(token)));
}

function prescriptionCoversPharmacyCart(prescription) {
  const lines = Array.isArray(prescription.medications) ? prescription.medications : [];
  const used = new Set();
  return pharmacyCart.filter((item) => item.requiresPrescription).every((product) => {
    const matchIndex = lines.findIndex((line, index) => !used.has(index) && prescriptionMedicationMatches(line, product));
    if (matchIndex < 0) return false;
    const line = lines[matchIndex];
    const prescribedQuantity = Number.isSafeInteger(line.quantity) && line.quantity > 0 ? Math.min(line.quantity, 20) : 1;
    if (product.quantity > prescribedQuantity) return false;
    used.add(matchIndex);
    return true;
  });
}

async function openPharmacyCheckout() {
  if (!pharmacyCart.length) return;
  await authReadyPromise;
  if (!currentUser) {
    const login = new URL("./connexion.html", window.location.href);
    login.searchParams.set("next", window.location.href);
    window.location.assign(login.href);
    return;
  }
  try {
    const profile = await initializePatientProfile(currentUser);
    if (!profile.profileComplete) {
      const registration = new URL("./inscription.html", window.location.href);
      registration.searchParams.set("completer", "1");
      registration.searchParams.set("next", window.location.href);
      window.location.assign(registration.href);
      return;
    }
  } catch (error) {
    pharmacyCheckoutError.textContent = error instanceof NexaApiError ? error.message : "Votre profil patient ne peut pas être vérifié pour le moment.";
    pharmacyCheckoutError.hidden = false;
    if (!pharmacyCheckoutDialog.open) pharmacyCheckoutDialog.showModal();
    return;
  }
  pharmacyCheckoutError.hidden = true;
  pharmacyCheckoutError.textContent = "";
  pharmacyCheckoutDialog.querySelectorAll("a.nexa-catalog-card__action").forEach((link) => link.remove());
  pharmacyCheckoutPrescription.replaceChildren(new Option("Aucune ordonnance", ""));
  pharmacyCheckoutPrescription.disabled = true;
  updatePharmacyDeliveryForm();
  pharmacyPrescriptionOptional.textContent = pharmacyCart.some((item) => item.requiresPrescription) ? "(obligatoire pour les médicaments sélectionnés)" : "(non requise pour cette commande)";
  pharmacyCheckoutStatus.textContent = "Vérification de votre profil et de vos ordonnances validées…";
  pharmacyCheckoutCreate.disabled = true;
  pharmacyCheckoutCreate.hidden = false;
  if (!activePharmacyRequestId) resetPharmacyRequestId();
  if (!pharmacyCheckoutDialog.open) pharmacyCheckoutDialog.showModal();
  try {
    const result = await requestNexaFunction(currentUser, "nexaPatientPrescriptions");
    const required = pharmacyCart.some((item) => item.requiresPrescription);
    const prescriptions = Array.isArray(result.prescriptions) ? result.prescriptions : [];
    const eligible = required ? prescriptions.filter((prescription) => prescriptionCoversPharmacyCart(prescription)) : [];
    eligible.forEach((prescription) => {
      const date = prescription.validatedAt ? new Intl.DateTimeFormat("fr-HT", { dateStyle: "medium" }).format(new Date(prescription.validatedAt)) : "date non précisée";
      pharmacyCheckoutPrescription.append(new Option(`Ordonnance de ${prescription.providerName || "votre médecin"} · ${date}`, prescription.id));
    });
    if (eligible.some((prescription) => prescription.id === requestedPrescriptionId)) {
      pharmacyCheckoutPrescription.value = requestedPrescriptionId;
    }
    pharmacyCheckoutPrescription.disabled = !required;
    pharmacyCheckoutStatus.textContent = required && eligible.length === 0
      ? "Aucune ordonnance validée contenant les médicaments, dosages, formes et quantités requis n’est disponible."
      : "Le montant, les frais et la disponibilité seront confirmés par NEXA avant le paiement.";
    pharmacyCheckoutCreate.disabled = required && eligible.length === 0;
  } catch (error) {
    pharmacyCheckoutStatus.textContent = "";
    pharmacyCheckoutError.textContent = error instanceof NexaApiError ? error.message : "Vos ordonnances ne sont pas accessibles pour le moment.";
    pharmacyCheckoutError.hidden = false;
    pharmacyCheckoutCreate.disabled = pharmacyCart.some((item) => item.requiresPrescription);
    pharmacyCheckoutPrescription.disabled = true;
  }
}

async function createPharmacyOrder() {
  if (!currentUser || !pharmacyCart.length) return;
  const required = pharmacyCart.some((item) => item.requiresPrescription);
  const prescriptionId = pharmacyCheckoutPrescription.value;
  if (required && !prescriptionId) {
    pharmacyCheckoutError.textContent = "Sélectionnez une ordonnance validée pour les médicaments qui l’exigent.";
    pharmacyCheckoutError.hidden = false;
    return;
  }
  const deliveryMethod = pharmacyDeliveryMethod.value === "delivery" ? "delivery" : "pickup";
  let deliveryAddress;
  if (deliveryMethod === "delivery") {
    let selectedZone;
    try { selectedZone = JSON.parse(pharmacyDeliveryZone.value); } catch { selectedZone = null; }
    const [department, commune] = Array.isArray(selectedZone) ? selectedZone : [];
    const phone = pharmacyDeliveryPhone.value.trim();
    const phoneDigits = phone.replace(/\D/g, "");
    if (!pharmacyDeliveryEnabled || !department || !commune || !pharmacyDeliveryRecipient.value.trim() || !pharmacyDeliveryAddress.value.trim() || phoneDigits.length < 8 || phoneDigits.length > 15 || !/^\+?[0-9 ()-]{8,32}$/.test(phone)) {
      pharmacyCheckoutError.textContent = "Vérifiez le nom, le téléphone, la commune et l’adresse détaillée de livraison.";
      pharmacyCheckoutError.hidden = false;
      return;
    }
    deliveryAddress = {
      recipientName: pharmacyDeliveryRecipient.value.trim(), phone, department, commune,
      addressLine: pharmacyDeliveryAddress.value.trim(), instructions: pharmacyDeliveryInstructions.value.trim(),
    };
  }
  pharmacyCheckoutError.hidden = true;
  pharmacyCheckoutStatus.textContent = "Vérification du stock et création de la commande…";
  pharmacyCheckoutCreate.disabled = true;
  try {
    const result = await requestNexaFunction(currentUser, "nexaPharmacyOrderCreate", "POST", {
      pharmacyId: pharmacyCart[0].providerUid,
      items: pharmacyCart.map((item) => ({ productId: item.id, quantity: item.quantity })),
      deliveryMethod,
      ...(deliveryAddress ? { deliveryAddress } : {}),
      ...(prescriptionId ? { prescriptionId } : {}),
      orderRequestId: activePharmacyRequestId || window.crypto.randomUUID(),
    });
    pharmacyCart = [];
    persistPharmacyCart();
    resetPharmacyRequestId();
    renderPharmacyCart();
    updatePharmacyDeliveryForm();
    pharmacyCheckoutCreate.hidden = true;
    const deliverySummary = Number(result.deliveryFee) > 0 ? ` · livraison : ${formatMoney(result.deliveryFee)}` : "";
    pharmacyCheckoutStatus.textContent = `Commande ${result.orderNumber} créée. Produits : ${formatMoney(result.subtotal)}${deliverySummary} · frais de transaction : ${formatMoney(result.transactionFee)} · total à payer : ${formatMoney(result.totalAmount)}. Les frais ne sont pas remboursables.`;
    const openOrders = element("a", "nexa-catalog-card__action", "Choisir Wallet ou MonCash");
    openOrders.href = "./espace-patient.html#commandes";
    pharmacyCheckoutStatus.after(openOrders);
    loadPharmacyProductsOnly();
  } catch (error) {
    pharmacyCheckoutStatus.textContent = "";
    pharmacyCheckoutError.textContent = error instanceof NexaApiError ? error.message : "La commande n’a pas pu être créée. Vérifiez le statut avant de recommencer.";
    pharmacyCheckoutError.hidden = false;
    pharmacyCheckoutCreate.disabled = false;
  }
}

function addDiagnosticOffer(offer) {
  if (diagnosticCart.some((item) => item.id === offer.id)) return true;
  if (diagnosticCart.length >= 10) {
    status.textContent = "Une commande peut contenir au maximum 10 examens.";
    return false;
  }
  if (diagnosticCart.length && diagnosticCart[0].providerUid !== offer.providerUid) {
    status.textContent = "Un panier doit contenir des examens du même centre. Terminez ou videz le panier avant de choisir un autre centre.";
    return false;
  }
  diagnosticCart.push({
    id: offer.id,
    providerUid: offer.providerUid,
    providerType: offer.providerType,
    providerName: offer.providerName,
    name: offer.name,
    price: Number(offer.price),
    requiresPrescription: offer.requiresPrescription === true,
  });
  persistCart();
  resetOrderRequestId();
  renderCart();
  loadCatalogOffersOnly();
  status.textContent = "Examen ajouté au panier. Le centre vérifiera la commande avant son règlement.";
  return true;
}

function loadCatalogOffersOnly() {
  if (!availableDiagnosticOffers.length) return;
  diagnosticOfferResults.replaceChildren(...availableDiagnosticOffers.filter((offer) => matchesOffer(offer, activeSearch)).map(renderDiagnosticOffer));
}

function updateDiagnosticOfferStatus() {
  const offerCount = availableDiagnosticOffers.filter((offer) => matchesOffer(offer, activeSearch)).length;
  status.textContent = `${diagnosticProviderCount} partenaire${diagnosticProviderCount === 1 ? "" : "s"} · ${offerCount} offre${offerCount === 1 ? "" : "s"}` +
    (diagnosticOffersHasMore ? " · d’autres offres sont disponibles" : "");
}

function updateNursingProviderStatus() {
  status.textContent = `${nursingProvidersShown} professionnel${nursingProvidersShown === 1 ? "" : "s"} infirmier${nursingProvidersShown === 1 ? "" : "s"}` +
    (nursingProvidersHasMore ? " · d’autres profils sont disponibles" : "");
}

async function loadMoreNursingProviders() {
  if (!nursingProvidersHasMore || nursingProvidersLoading || !nursingProvidersCursor) return;
  const generation = catalogLoadGeneration;
  nursingProvidersLoading = true;
  nursingProviderMore.disabled = true;
  nursingProviderMore.textContent = "Chargement des profils…";
  try {
    const request = new URL(NURSING_PUBLIC_CATALOG_URL);
    for (const key of ["q", "department"]) {
      const value = activeSearch.get(key);
      if (value) request.searchParams.set(key, value);
    }
    request.searchParams.set("cursor", nursingProvidersCursor);
    const response = await fetchNexaPublicFunction(request, { method: "GET", headers: { Accept: "application/json" } });
    const payload = await response.json().catch(() => null);
    if (generation !== catalogLoadGeneration) return;
    if (!response.ok || !payload || payload.ok !== true || !Array.isArray(payload.results)) {
      throw new Error("nursing-catalog-unavailable");
    }
    const cards = payload.results.map(renderProvider);
    results.append(...cards);
    nursingProvidersShown += cards.length;
    nursingProvidersHasMore = payload.hasMore === true && typeof payload.nextCursor === "string" && payload.nextCursor.length > 0;
    nursingProvidersCursor = nursingProvidersHasMore ? payload.nextCursor : "";
    nursingProviderMore.hidden = !nursingProvidersHasMore;
    updateNursingProviderStatus();
  } catch {
    if (generation === catalogLoadGeneration) status.textContent = "Les profils infirmiers suivants ne sont pas accessibles pour le moment. Réessayez.";
  } finally {
    if (generation === catalogLoadGeneration) {
      nursingProvidersLoading = false;
      nursingProviderMore.disabled = false;
      nursingProviderMore.textContent = "Afficher plus d’infirmier·ères";
    }
  }
}

async function loadMoreDiagnosticOffers() {
  if (!diagnosticOffersHasMore || diagnosticOffersLoading || !diagnosticOffersCursor) return;
  const generation = catalogLoadGeneration;
  diagnosticOffersLoading = true;
  diagnosticOfferMore.disabled = true;
  diagnosticOfferMore.textContent = "Chargement des offres…";
  try {
    const request = new URL(DIAGNOSTIC_OFFERS_URL);
    request.searchParams.set("type", type === "laboratories" ? "laboratory" : "imaging");
    request.searchParams.set("cursor", diagnosticOffersCursor);
    const response = await fetchNexaPublicFunction(request, { method: "GET", headers: { Accept: "application/json" } });
    const payload = await response.json().catch(() => null);
    if (generation !== catalogLoadGeneration) return;
    if (!response.ok || !payload || payload.ok !== true || !Array.isArray(payload.offers)) {
      throw new Error("diagnostic-offers-unavailable");
    }
    availableDiagnosticOffers.push(...payload.offers);
    diagnosticOffersHasMore = payload.hasMore === true && typeof payload.nextCursor === "string" && payload.nextCursor.length > 0;
    diagnosticOffersCursor = diagnosticOffersHasMore ? payload.nextCursor : "";
    diagnosticOfferResults.replaceChildren(...availableDiagnosticOffers.filter((offer) => matchesOffer(offer, activeSearch)).map(renderDiagnosticOffer));
    diagnosticOfferMore.hidden = !diagnosticOffersHasMore;
    updateDiagnosticOfferStatus();
  } catch {
    if (generation === catalogLoadGeneration) status.textContent = "Les offres suivantes ne sont pas accessibles pour le moment. Réessayez.";
  } finally {
    if (generation === catalogLoadGeneration) {
      diagnosticOffersLoading = false;
      diagnosticOfferMore.disabled = false;
      diagnosticOfferMore.textContent = "Charger les offres suivantes";
    }
  }
}

function normalizedExam(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/\s+/g, " ").trim();
}

async function openDiagnosticCheckout() {
  if (!diagnosticCart.length) return;
  await authReadyPromise;
  if (!currentUser) {
    const login = new URL("./connexion.html", window.location.href);
    login.searchParams.set("next", window.location.href);
    window.location.assign(login.href);
    return;
  }
  try {
    const profile = await initializePatientProfile(currentUser);
    if (!profile.profileComplete) {
      const registration = new URL("./inscription.html", window.location.href);
      registration.searchParams.set("completer", "1");
      registration.searchParams.set("next", window.location.href);
      window.location.assign(registration.href);
      return;
    }
  } catch (error) {
    checkoutError.textContent = error instanceof NexaApiError ? error.message : "Votre profil patient ne peut pas être vérifié pour le moment.";
    checkoutError.hidden = false;
    if (!checkoutDialog.open) checkoutDialog.showModal();
    return;
  }
  checkoutError.hidden = true;
  checkoutError.textContent = "";
  checkoutDialog.querySelectorAll("a.nexa-catalog-card__action").forEach((link) => link.remove());
  checkoutStatus.textContent = "Chargement de vos ordonnances validées…";
  if (!activeOrderRequestId) resetOrderRequestId();
  checkoutCreate.disabled = true;
  checkoutCreate.hidden = false;
  checkoutPrescription.replaceChildren(new Option("Aucune ordonnance", ""));
  checkoutPrescription.disabled = true;
  prescriptionOptional.textContent = diagnosticCart.some((item) => item.requiresPrescription) ? "(obligatoire pour certains examens)" : "(facultatif)";
  if (!checkoutDialog.open) checkoutDialog.showModal();
  try {
    const result = await requestNexaFunction(currentUser, "nexaPatientPrescriptions");
    const prescriptions = Array.isArray(result.prescriptions) ? result.prescriptions : [];
    prescriptions.forEach((prescription) => {
      const lines = diagnosticCart[0].providerType === "laboratory" ? prescription.labExams : prescription.imagingExams;
      const eligibleLines = Array.isArray(lines) ? lines : [];
      const requiredItems = diagnosticCart.filter((item) => item.requiresPrescription);
      const matchesRequired = requiredItems.every((item) => eligibleLines.some((line) => normalizedExam(typeof line === "string" ? line : line?.name || line?.label) === normalizedExam(item.name)));
      if (requiredItems.length && !matchesRequired) return;
      const date = prescription.validatedAt ? new Intl.DateTimeFormat("fr-HT", { dateStyle: "medium" }).format(new Date(prescription.validatedAt)) : "date non précisée";
      const labelText = `Ordonnance de ${prescription.providerName || "votre médecin"} · ${date}`;
      checkoutPrescription.append(new Option(labelText, prescription.id));
    });
    if (Array.from(checkoutPrescription.options).some((option) => option.value === requestedPrescriptionId)) {
      checkoutPrescription.value = requestedPrescriptionId;
    }
    const requires = diagnosticCart.some((item) => item.requiresPrescription);
    checkoutStatus.textContent = requires && checkoutPrescription.options.length === 1
      ? "Aucune ordonnance validée contenant les examens requis n’est disponible. Consultez votre espace patient ou demandez au médecin de vérifier l’ordonnance."
      : "Vérifiez votre sélection. Le montant et les frais définitifs seront calculés par NEXA avant le paiement.";
    checkoutPrescription.disabled = false;
    checkoutCreate.disabled = requires && checkoutPrescription.options.length === 1;
  } catch (error) {
    checkoutStatus.textContent = "";
    checkoutError.textContent = error instanceof NexaApiError ? error.message : "Vos ordonnances ne sont pas accessibles pour le moment.";
    checkoutError.hidden = false;
    checkoutCreate.disabled = diagnosticCart.some((item) => item.requiresPrescription);
    checkoutPrescription.disabled = false;
  }
}

async function createDiagnosticOrder() {
  if (!currentUser || !diagnosticCart.length) return;
  const required = diagnosticCart.some((item) => item.requiresPrescription);
  const prescriptionId = checkoutPrescription.value;
  if (required && !prescriptionId) {
    checkoutError.textContent = "Sélectionnez une ordonnance validée pour les examens qui l’exigent.";
    checkoutError.hidden = false;
    return;
  }
  checkoutError.hidden = true;
  checkoutStatus.textContent = "Vérification des offres et création de la commande…";
  checkoutCreate.disabled = true;
  try {
    const result = await requestNexaFunction(currentUser, "nexaDiagnosticOrderCreate", "POST", {
      offerIds: diagnosticCart.map((item) => item.id),
      ...(prescriptionId ? { prescriptionId } : {}),
      orderRequestId: activeOrderRequestId || window.crypto.randomUUID(),
    });
    diagnosticCart = [];
    persistCart();
    resetOrderRequestId();
    renderCart();
    checkoutCreate.hidden = true;
    const paymentSummary = result.paymentRequired
      ? `Service : ${formatMoney(result.amount)} · frais de transaction : ${formatMoney(result.transactionFee)} · total à payer : ${formatMoney(result.totalAmount)}. Les frais s’appliquent aussi au Wallet NEXA et ne sont pas remboursables.`
      : "Cette commande est gratuite et a été transmise au centre.";
    checkoutStatus.textContent = `Commande ${result.orderNumber} créée. ${paymentSummary}`;
    const openOrders = element("a", "nexa-catalog-card__action", result.paymentRequired ? "Choisir Wallet ou MonCash" : "Voir ma commande");
    openOrders.href = "./espace-patient.html#commandes";
    checkoutStatus.after(openOrders);
  } catch (error) {
    checkoutStatus.textContent = "";
    checkoutError.textContent = error instanceof NexaApiError ? error.message : "La commande n’a pas pu être créée. Vérifiez le statut avant de recommencer.";
    checkoutError.hidden = false;
    checkoutCreate.disabled = false;
  }
}

diagnosticCartCheckout.addEventListener("click", () => { void openDiagnosticCheckout(); });
checkoutCreate.addEventListener("click", () => { void createDiagnosticOrder(); });
checkoutPrescription.addEventListener("change", resetOrderRequestId);
checkoutClose.addEventListener("click", () => checkoutDialog.close());
checkoutDialog.addEventListener("click", (event) => { if (event.target === checkoutDialog) checkoutDialog.close(); });
renderCart();

function appendDetail(container, icon, text) {
  if (!text) return;
  const line = element("p");
  const symbol = element("i", "fas " + icon);
  symbol.setAttribute("aria-hidden", "true");
  line.append(symbol, element("span", "", text));
  container.append(line);
}

function normalized(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr-HT");
}

function matchesOffer(offer, search) {
  const query = normalized(search.get("q"));
  const department = normalized(search.get("department"));
  const words = normalized([
    offer.name,
    offer.category,
    offer.description,
    offer.providerName,
    offer.commune,
    offer.department,
    offer.specimenType,
  ].filter(Boolean).join(" "));
  return (!query || words.includes(query)) && (!department || normalized(offer.department).includes(department));
}

function safePhotoUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}

function resetNursingRequestId() {
  activeNursingRequestId = activeNursingProvider ? window.crypto.randomUUID() : "";
}

function updateNursingBookingPeriods() {
  nursingBookingPeriod.replaceChildren(new Option("Choisissez une période", ""));
  const week = activeNursingProvider?.weeklyAvailability?.find((entry) => entry.weekStart === nursingBookingWeek.value);
  (Array.isArray(week?.periods) ? week.periods : []).forEach((period) => {
    const option = new Option(period.label + " · " + period.schedule, period.id);
    option.dataset.schedule = period.schedule || "";
    nursingBookingPeriod.append(option);
  });
  updateNursingBookingSummary();
}

function updateNursingBookingSummary() {
  const period = nursingBookingPeriod.selectedOptions[0];
  const zone = activeNursingProvider?.zones?.find((entry) => entry.id === nursingBookingZone.value);
  const amount = zone?.tariffs?.[nursingBookingPeriod.value];
  nursingBookingSchedule.textContent = period?.dataset.schedule
    ? "Horaire de la période : " + period.dataset.schedule + "."
    : "Choisissez une semaine et une période proposée.";
  nursingBookingPrice.textContent = Number.isSafeInteger(amount) && amount > 0
    ? "Prix de la période entière : " + formatMoney(amount) + ". Les frais de transaction seront ajoutés avant paiement et s’appliquent aussi au Wallet NEXA."
    : "Le tarif de cette période n’est pas encore activé.";
}

async function openNursingBooking(provider) {
  await authReadyPromise;
  if (!currentUser) {
    const login = new URL("./connexion.html", window.location.href);
    login.searchParams.set("next", window.location.href);
    window.location.assign(login.href);
    return;
  }
  try {
    const profile = await initializePatientProfile(currentUser);
    if (!profile.profileComplete) {
      const registration = new URL("./inscription.html", window.location.href);
      registration.searchParams.set("completer", "1");
      registration.searchParams.set("next", window.location.href);
      window.location.assign(registration.href);
      return;
    }
  } catch (error) {
    nursingBookingError.textContent = error instanceof NexaApiError
      ? error.message
      : "Votre profil patient ne peut pas être vérifié pour le moment.";
    nursingBookingError.hidden = false;
    if (!nursingBookingDialog.open) nursingBookingDialog.showModal();
    return;
  }

  activeNursingProvider = provider;
  activeNursingRequestId = window.crypto.randomUUID();
  nursingBookingForm.reset();
  nursingBookingForm.querySelectorAll("input, select, textarea").forEach((field) => { field.disabled = false; });
  nursingBookingProvider.textContent = provider.name || "Infirmier·ère NEXARIS";
  nursingBookingModeDescription.textContent = provider.bookingModeDescription || "La modalité des visites n’a pas encore été configurée par NEXA.";
  nursingBookingZone.replaceChildren(new Option("Choisissez une commune", ""));
  (Array.isArray(provider.zones) ? provider.zones : []).forEach((zone) => {
    if (zone?.id) nursingBookingZone.append(new Option(zone.commune + ", " + zone.department, zone.id));
  });
  nursingBookingWeek.replaceChildren(new Option("Choisissez une semaine", ""));
  (Array.isArray(provider.weeklyAvailability) ? provider.weeklyAvailability : []).forEach((week) => {
    const date = new Date(week.weekStart + "T12:00:00.000Z");
    const label = Number.isNaN(date.getTime())
      ? week.weekStart
      : "Semaine du " + new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "long" }).format(date);
    nursingBookingWeek.append(new Option(label, week.weekStart));
  });
  nursingBookingPeriod.replaceChildren(new Option("Choisissez une période", ""));
  const serviceList = element("div", "nexa-nursing-booking__service-list");
  (Array.isArray(provider.services) ? provider.services : []).forEach((service) => {
    if (!service?.id || !service?.label) return;
    const label = element("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "serviceId";
    input.value = service.id;
    label.append(input, element("span", "", service.label));
    serviceList.append(label);
  });
  nursingBookingServices.replaceChildren(serviceList);
  nursingBookingPhone.value = "";
  nursingBookingDepartment.value = "";
  nursingBookingCommune.value = "";
  nursingBookingAddress.value = "";
  nursingBookingError.textContent = "";
  nursingBookingError.hidden = true;
  nursingBookingStatus.replaceChildren();
  nursingBookingSubmit.hidden = false;
  nursingBookingSubmit.disabled = false;
  updateNursingBookingPeriods();
  if (!nursingBookingDialog.open) nursingBookingDialog.showModal();
}

async function submitNursingBooking(event) {
  event.preventDefault();
  if (!currentUser || !activeNursingProvider) return;
  const serviceIds = [...nursingBookingForm.querySelectorAll('input[name="serviceId"]:checked')].map((input) => input.value);
  if (!serviceIds.length) {
    nursingBookingError.textContent = "Choisissez au moins un service infirmier.";
    nursingBookingError.hidden = false;
    return;
  }
  nursingBookingError.textContent = "";
  nursingBookingError.hidden = true;
  nursingBookingStatus.replaceChildren(element("span", "", "Réservation et vérification du tarif…"));
  nursingBookingSubmit.disabled = true;
  try {
    const result = await requestNexaFunction(currentUser, "nexaNursingOrderCreate", "POST", {
      providerUid: activeNursingProvider.id,
      weekStart: nursingBookingWeek.value,
      period: nursingBookingPeriod.value,
      zoneId: nursingBookingZone.value,
      serviceIds,
      orderRequestId: activeNursingRequestId || window.crypto.randomUUID(),
      visitDetails: {
        phone: nursingBookingPhone.value.trim(),
        department: nursingBookingDepartment.value.trim(),
        commune: nursingBookingCommune.value.trim(),
        addressLine: nursingBookingAddress.value.trim(),
      },
    });
    nursingBookingStatus.replaceChildren(element("span", "", "Réservation " + result.orderNumber + " créée. Prix du service : " +
      formatMoney(result.amount) + " · frais : " + formatMoney(result.transactionFee) + " · total à payer : " +
      formatMoney(result.totalAmount) + ". La période est retenue jusqu’à son début, au maximum 30 minutes; terminez le paiement avant l’heure prévue."));
    const paymentLink = element("a", "nexa-catalog-card__action", "Choisir Wallet NEXA ou MonCash");
    paymentLink.href = "./espace-patient.html#commandes";
    nursingBookingStatus.append(paymentLink);
    nursingBookingSubmit.hidden = true;
    nursingBookingForm.querySelectorAll("input, select, textarea").forEach((field) => { field.disabled = true; });
  } catch (error) {
    nursingBookingError.textContent = error instanceof NexaApiError
      ? error.message
      : "La réservation n’a pas pu être confirmée. Vérifiez son statut avant de recommencer.";
    nursingBookingError.hidden = false;
    nursingBookingSubmit.disabled = false;
  }
}

function renderProvider(item) {
  const card = element("article", "nexa-catalog-card");
  const isNurse = type === "nurses";
  const head = element("div", "nexa-catalog-card__head");
  const photoUrl = safePhotoUrl(item.photoUrl);
  if (photoUrl) {
    const photo = element("img", "nexa-catalog-card__photo");
    photo.src = photoUrl;
    photo.alt = "";
    photo.loading = "lazy";
    photo.referrerPolicy = "no-referrer";
    head.append(photo);
  } else {
    const mark = element("span", "nexa-catalog-card__mark");
    const iconName = type === "doctors"
      ? "fa-user-doctor"
      : isNurse
        ? "fa-user-nurse"
      : type === "pharmacies"
        ? "fa-prescription-bottle-medical"
        : type === "laboratories"
          ? "fa-flask"
          : "fa-x-ray";
    const icon = element("i", "fas " + iconName);
    icon.setAttribute("aria-hidden", "true");
    mark.append(icon);
    head.append(mark);
  }

  const identity = element("div");
  identity.append(element("h2", "", item.name || (isNurse ? "Infirmier·ère NEXARIS" : "Professionnel NEXARIS")));
  const subtitle = isNurse
    ? (Array.isArray(item.qualifications) ? item.qualifications.join(" · ") : "")
    : item.specialty ||
      (Array.isArray(item.specialties) ? item.specialties.join(" · ") : "") ||
      (Array.isArray(item.services) ? item.services.join(" · ") : "");
  if (subtitle) identity.append(element("p", "nexa-catalog-card__subtitle", subtitle));
  head.append(identity);
  card.append(head);

  if (item.bio) card.append(element("p", "nexa-catalog-card__bio", item.bio));
  const details = element("div", "nexa-catalog-card__details");
  const address = [item.commune, item.department].filter(Boolean).join(", ");
  if (isNurse) {
    if (Number.isSafeInteger(item.experienceYears) && item.experienceYears >= 0) {
      appendDetail(details, "fa-briefcase", item.experienceYears + " an" + (item.experienceYears === 1 ? "" : "s") + " d’expérience");
    }
    const availablePeriods = new Set((Array.isArray(item.weeklyAvailability) ? item.weeklyAvailability : [])
      .flatMap((week) => Array.isArray(week.periods) ? week.periods.map((period) => period.id) : []));
    (Array.isArray(item.zones) ? item.zones : []).forEach((zone) => {
      const prices = [...availablePeriods].map((period) => {
        const amount = zone.tariffs?.[period];
        const periodLabel = period === "DAY" ? "AM" : period === "NIGHT" ? "PM" : "Week-end";
        return Number.isSafeInteger(amount) ? periodLabel + " " + formatMoney(amount) : "";
      }).filter(Boolean).join(" · ");
      appendDetail(details, "fa-location-dot", [zone.commune, zone.department].filter(Boolean).join(", ") + (prices ? " · " + prices : ""));
    });
  } else appendDetail(details, "fa-location-dot", address || item.address);
  if (item.phone) appendDetail(details, "fa-phone", item.phone);
  if (item.openingHours) appendDetail(details, "fa-clock", item.openingHours);
  if (Number.isFinite(Number(item.indicativeFee)) && Number(item.indicativeFee) > 0) {
    appendDetail(details, "fa-money-bill-wave", Number(item.indicativeFee).toLocaleString("fr-HT") + " HTG");
  }
  if (Array.isArray(item.consultationModes) && item.consultationModes.length) {
    appendDetail(details, "fa-video", item.consultationModes.join(" · "));
  }
  if (Array.isArray(item.languages) && item.languages.length) {
    appendDetail(details, "fa-language", item.languages.join(" · "));
  }
  if (details.childElementCount) card.append(details);

  const tags = isNurse
    ? (Array.isArray(item.services) ? item.services.map((service) => service?.label) : [])
    : [
      ...(Array.isArray(item.services) ? item.services : []),
      ...(Array.isArray(item.homeVisitServices) ? item.homeVisitServices.map((entry) => entry.label) : []),
    ];
  const cleanTags = tags.filter((value) => typeof value === "string" && value.trim()).slice(0, isNurse ? 11 : 8);
  if (cleanTags.length) {
    const list = element("ul", "nexa-catalog-card__tags");
    cleanTags.forEach((tag) => list.append(element("li", "", tag)));
    card.append(list);
  }
  if (isNurse && Array.isArray(item.weeklyAvailability) && item.weeklyAvailability.length) {
    const schedule = element("details", "nexa-catalog-offer__more");
    schedule.append(element("summary", "", "Semaines proposées (" + item.weeklyAvailability.length + ")"));
    const weeks = element("ul", "nexa-catalog-card__tags");
    item.weeklyAvailability.forEach((week) => {
      const periods = (Array.isArray(week.periods) ? week.periods : [])
        .map((period) => period.label + " · " + period.schedule).join("; ");
      if (periods) weeks.append(element("li", "", week.weekStart + " : " + periods));
    });
    schedule.append(weeks);
    schedule.append(element("p", "", item.bookingModeDescription || "La modalité des visites doit être configurée par NEXA avant la réservation."));
    card.append(schedule);
    const action = element("button", "nexa-catalog-card__action nexa-catalog-card__action--button",
      item.bookingMode ? "Réserver une période" : "Réservation en préparation");
    action.type = "button";
    action.disabled = !item.bookingMode;
    if (item.bookingMode) {
      action.setAttribute("aria-label", "Réserver une période de soins avec " + (item.name || "cet infirmier"));
      action.addEventListener("click", () => { void openNursingBooking(item); });
    } else action.setAttribute("aria-label", "Réservation indisponible car NEXA n’a pas configuré la modalité des visites");
    card.append(action);
  }
  if (type === "doctors") {
    const action = element("a", "nexa-catalog-card__action", "Voir les disponibilités");
    const bookingParams = new URLSearchParams({ providerUid: item.id });
    if (activeSearch.get("service") === "HOME_VISIT") bookingParams.set("serviceType", "HOME_VISIT");
    action.href = "./rendez-vous.html?" + bookingParams.toString();
    action.setAttribute("aria-label", "Voir les disponibilités de " + (item.name || "ce médecin"));
    card.append(action);
  }
  return card;
}

function safePhone(value) {
  if (typeof value !== "string") return "";
  const phone = value.replace(/[^+\d]/g, "");
  return /^\+?\d{7,15}$/.test(phone) ? phone : "";
}

function renderDiagnosticOffer(offer) {
  const card = element("article", "nexa-catalog-offer");
  const head = element("div", "nexa-catalog-offer__head");
  const mark = element("span", "nexa-catalog-card__mark");
  const icon = element("i", "fas " + (type === "laboratories" ? "fa-flask" : "fa-x-ray"));
  icon.setAttribute("aria-hidden", "true");
  mark.append(icon);
  const identity = element("div");
  if (offer.category) identity.append(element("p", "nexa-catalog-card__subtitle", offer.category));
  identity.append(element("h3", "", offer.name || "Examen médical"));
  identity.append(element("p", "nexa-catalog-offer__provider", offer.providerName || "Partenaire NEXA"));
  head.append(mark, identity);
  card.append(head);

  if (offer.description) card.append(element("p", "nexa-catalog-offer__description", offer.description));
  const details = element("div", "nexa-catalog-card__details");
  const address = [offer.commune, offer.department].filter(Boolean).join(", ");
  appendDetail(details, "fa-location-dot", address || offer.address);
  if (offer.openingHours) appendDetail(details, "fa-clock", offer.openingHours);
  if (offer.specimenType) appendDetail(details, "fa-vial", "Échantillon : " + offer.specimenType);
  if (offer.technique) appendDetail(details, "fa-microscope", "Technique : " + offer.technique);
  if (offer.resultDelay) appendDetail(details, "fa-hourglass-half", "Délai indicatif : " + offer.resultDelay);
  if (details.childElementCount) card.append(details);

  const tags = [];
  if (offer.requiresPrescription) tags.push("Ordonnance requise");
  if (offer.appointmentRequired) tags.push("Rendez-vous requis");
  if (offer.homeSampling) tags.push("Prélèvement à domicile proposé");
  if (tags.length) {
    const list = element("ul", "nexa-catalog-card__tags");
    tags.forEach((tag) => list.append(element("li", "", tag)));
    card.append(list);
  }

  const instructions = [offer.preparation, offer.precautions, offer.instructions].filter(Boolean);
  if (instructions.length) {
    const detailsBlock = element("details", "nexa-catalog-offer__more");
    detailsBlock.append(element("summary", "", "Préparation et consignes"));
    instructions.forEach((text) => detailsBlock.append(element("p", "", text)));
    card.append(detailsBlock);
  }

  const footer = element("div", "nexa-catalog-offer__footer");
  const price = typeof offer.price === "number" ? offer.price : Number.NaN;
  footer.append(element("strong", "nexa-catalog-offer__price", Number.isSafeInteger(price) && price >= 0
    ? price.toLocaleString("fr-HT") + " HTG"
    : "Tarif à confirmer"));
  const phone = safePhone(offer.phone);
  if (offer.appointmentRequired && phone) {
    const action = element("a", "nexa-catalog-card__action", "Contacter le centre");
    action.href = "tel:" + phone;
    action.setAttribute("aria-label", "Appeler " + (offer.providerName || "le centre") + " au " + phone);
    footer.append(action);
  } else if (!offer.appointmentRequired && Number.isSafeInteger(price) && price >= 0) {
    const action = element("button", "nexa-catalog-card__action nexa-catalog-card__action--button", diagnosticCart.some((item) => item.id === offer.id) ? "Déjà dans le panier" : "Ajouter au panier");
    action.type = "button";
    action.disabled = diagnosticCart.some((item) => item.id === offer.id);
    action.addEventListener("click", () => addDiagnosticOffer(offer));
    footer.append(action);
  }
  card.append(footer);
  return card;
}

function matchesPharmacyProduct(product, search = activeSearch) {
  const department = normalized(search.get("department"));
  return !department || normalized(product.department).includes(department);
}

function renderPharmacyProduct(product) {
  const card = element("article", "nexa-catalog-offer");
  const head = element("div", "nexa-catalog-offer__head");
  const mark = element("span", "nexa-catalog-card__mark");
  const icon = element("i", "fas fa-prescription-bottle-medical");
  icon.setAttribute("aria-hidden", "true");
  mark.append(icon);
  const identity = element("div");
  identity.append(element("h3", "", product.name || "Produit pharmaceutique"));
  identity.append(element("p", "nexa-catalog-offer__provider", product.pharmacyName || "Pharmacie NEXA"));
  head.append(mark, identity);
  card.append(head);
  card.append(element("p", "nexa-catalog-offer__description", [product.dci, product.dosage, product.route, product.pharmaceuticalForm].filter(Boolean).join(" · ") || "Détails à confirmer par la pharmacie."));
  const address = [product.commune, product.department].filter(Boolean).join(", ");
  if (address) card.append(element("p", "nexa-catalog-offer__provider", address));
  if (product.description) card.append(element("p", "nexa-catalog-offer__description", product.description));
  if (product.manufacturer) card.append(element("p", "nexa-catalog-offer__provider", "Fabricant : " + product.manufacturer));
  if (product.prescriptionRequired) card.append(element("p", "nexa-catalog-offer__provider", "Ordonnance NEXA validée obligatoire"));
  if (pharmacyDeliveryEnabled && ["delivery", "both"].includes(product.deliveryMode) && !product.coldChainRequired && Array.isArray(product.deliveryZones) && product.deliveryZones.length) {
    card.append(element("p", "nexa-catalog-offer__provider", `Livraison disponible dans ${product.deliveryZones.length} zone${product.deliveryZones.length === 1 ? "" : "s"}`));
  }
  const footer = element("div", "nexa-catalog-offer__footer");
  footer.append(element("strong", "nexa-catalog-offer__price", `${formatMoney(product.price)} · stock ${product.stock}`));
  const cartItem = pharmacyCart.find((item) => item.id === product.id);
  const action = element("button", "nexa-catalog-card__action nexa-catalog-card__action--button", cartItem ? `Dans le panier (${cartItem.quantity})` : "Ajouter au panier");
  action.type = "button";
  action.disabled = product.stock < 1 || (cartItem && cartItem.quantity >= Math.min(20, product.stock));
  action.addEventListener("click", () => addPharmacyProduct(product));
  footer.append(action);
  card.append(footer);
  return card;
}

function loadPharmacyProductsOnly() {
  if (!pharmacyProductResults) return;
  pharmacyProductResults.replaceChildren(...availablePharmacyProducts.filter((product) => matchesPharmacyProduct(product)).map(renderPharmacyProduct));
}

function readFilters() {
  const next = new URLSearchParams();
  next.set("type", type);
  const query = queryInput.value.trim();
  const department = departmentInput.value.trim();
  if (query) next.set("q", query);
  if (department) next.set("department", department);
  if (type === "doctors" && homeVisitOnly.checked) next.set("service", "HOME_VISIT");
  window.history.replaceState(null, "", "./catalog.html?" + next.toString());
  activeSearch = new URLSearchParams(next);
  return next;
}

async function loadCatalog(search = parameters) {
  const generation = ++catalogLoadGeneration;
  activeSearch = new URLSearchParams(search);
  updateCatalogMetadata(activeSearch);
  if (!label) {
    title.textContent = "Répertoire indisponible";
    description.textContent = "Le type de service demandé n’est pas reconnu.";
    status.textContent = "Choisissez un pôle dans le menu NEXARIS.";
    form.hidden = true;
    return;
  }

  title.textContent = label.title;
  description.textContent = label.description;
  queryInput.value = search.get("q") || "";
  departmentInput.value = search.get("department") || "";
  const isHomeVisit = type === "doctors";
  const isNursingCatalog = type === "nurses";
  homeVisitFilter.hidden = !isHomeVisit;
  if (isHomeVisit) homeVisitOnly.checked = search.get("service") === "HOME_VISIT";

  status.textContent = "Chargement du répertoire…";
  results.replaceChildren();
  const isDiagnosticCatalog = type === "laboratories" || type === "imaging-centers";
  const isPharmacyCatalog = type === "pharmacies";
  const offerLookupId = prescriptionOfferLookupPending && (isDiagnosticCatalog || isPharmacyCatalog)
    ? requestedPrescriptionOfferId
    : "";
  let prescriptionOfferAdded = false;
  let prescriptionOfferAlreadyInCart = false;
  let prescriptionOfferUnavailable = false;
  let prescriptionOfferActionMessage = "";
  pharmacyProductSection.hidden = !isPharmacyCatalog;
  pharmacyProductResults.replaceChildren();
  availablePharmacyProducts = [];
  pharmacyDeliveryEnabled = false;
  updatePharmacyDeliveryForm();
  diagnosticOfferSection.hidden = !isDiagnosticCatalog;
  diagnosticOfferResults.replaceChildren();
  availableDiagnosticOffers = [];
  diagnosticOffersCursor = "";
  diagnosticOffersHasMore = false;
  diagnosticOffersLoading = false;
  diagnosticProviderCount = 0;
  diagnosticOfferMore.hidden = true;
  diagnosticOfferMore.disabled = false;
  diagnosticOfferMore.textContent = "Charger les offres suivantes";
  nursingProvidersCursor = "";
  nursingProvidersHasMore = false;
  nursingProvidersLoading = false;
  nursingProvidersShown = 0;
  nursingProviderMore.hidden = true;
  nursingProviderMore.disabled = false;
  nursingProviderMore.textContent = "Afficher plus d’infirmier·ères";
  const request = new URL(type === "nurses" ? NURSING_PUBLIC_CATALOG_URL : FUNCTION_URL);
  request.search = search.toString();
  if (!request.searchParams.has("type")) request.searchParams.set("type", type);
  const offerRequest = new URL(DIAGNOSTIC_OFFERS_URL);
  offerRequest.searchParams.set("type", type === "laboratories" ? "laboratory" : "imaging");
  if (isDiagnosticCatalog && offerLookupId) offerRequest.searchParams.set("offerId", offerLookupId);

  try {
    const [response, offerResponse] = await Promise.all([
      fetchNexaPublicFunction(request, {
        method: "GET",
        headers: { Accept: "application/json" },
      }),
      isDiagnosticCatalog
        ? fetchNexaPublicFunction(offerRequest, {
            method: "GET",
            headers: { Accept: "application/json" },
          })
        : Promise.resolve(null),
    ]);
    if (generation !== catalogLoadGeneration) return;
    const payload = await response.json().catch(() => null);
    if (generation !== catalogLoadGeneration) return;
    if (!response.ok || !payload || payload.ok !== true || !Array.isArray(payload.results)) {
      throw new Error("catalog-unavailable");
    }
    const cards = payload.results.map(renderProvider);
    results.replaceChildren(...cards);
    if (isNursingCatalog) {
      nursingProvidersShown = cards.length;
      nursingProvidersHasMore = payload.hasMore === true && typeof payload.nextCursor === "string" && payload.nextCursor.length > 0;
      nursingProvidersCursor = nursingProvidersHasMore ? payload.nextCursor : "";
      nursingProviderMore.hidden = !nursingProvidersHasMore;
    }
    let offerCards = [];
    if (offerResponse) {
      let offerPayload = await offerResponse.json().catch(() => null);
      if (!offerResponse.ok || !offerPayload || offerPayload.ok !== true || !Array.isArray(offerPayload.offers)) {
        throw new Error("diagnostic-offers-unavailable");
      }
      if (offerLookupId && !offerPayload.offers.some((offer) => offer.id === offerLookupId)) {
        offerRequest.searchParams.delete("offerId");
        const fallbackResponse = await fetchNexaPublicFunction(offerRequest, { method: "GET", headers: { Accept: "application/json" } });
        offerPayload = await fallbackResponse.json().catch(() => null);
        if (!fallbackResponse.ok || !offerPayload || offerPayload.ok !== true || !Array.isArray(offerPayload.offers)) {
          throw new Error("diagnostic-offers-unavailable");
        }
      }
      availableDiagnosticOffers = offerPayload.offers;
      diagnosticOffersHasMore = offerPayload.hasMore === true && typeof offerPayload.nextCursor === "string" && offerPayload.nextCursor.length > 0;
      diagnosticOffersCursor = diagnosticOffersHasMore ? offerPayload.nextCursor : "";
      diagnosticOfferMore.hidden = !diagnosticOffersHasMore;
      diagnosticProviderCount = cards.length;
      const prescriptionOffer = offerLookupId
        ? availableDiagnosticOffers.find((offer) => offer.id === offerLookupId)
        : null;
      if (prescriptionOffer) {
        prescriptionOfferAlreadyInCart = diagnosticCart.some((item) => item.id === prescriptionOffer.id);
        prescriptionOfferAdded = addDiagnosticOffer(prescriptionOffer) === true;
        if (!prescriptionOfferAdded) prescriptionOfferActionMessage = status.textContent;
      } else if (offerLookupId) {
        prescriptionOfferUnavailable = true;
      }
      offerCards = availableDiagnosticOffers.filter((offer) => matchesOffer(offer, search)).map(renderDiagnosticOffer);
      diagnosticOfferResults.replaceChildren(...offerCards);
      if (offerLookupId) prescriptionOfferLookupPending = false;
    }
    let pharmacyProducts = 0;
    if (isPharmacyCatalog) {
      const productRequest = new URL(PHARMACY_PRODUCTS_URL);
      if (search.get("q")) productRequest.searchParams.set("q", search.get("q"));
      if (offerLookupId) productRequest.searchParams.set("productId", offerLookupId);
      let productResponse = await fetchNexaPublicFunction(productRequest, { headers: { Accept: "application/json" } });
      let productPayload = await productResponse.json().catch(() => null);
      if (offerLookupId && productResponse.ok && productPayload?.ok === true && Array.isArray(productPayload.products) &&
        !productPayload.products.some((product) => product.id === offerLookupId)) {
        productRequest.searchParams.delete("productId");
        productResponse = await fetchNexaPublicFunction(productRequest, { headers: { Accept: "application/json" } });
        productPayload = await productResponse.json().catch(() => null);
      }
      if (productResponse.ok && productPayload?.ok === true && Array.isArray(productPayload.products)) {
        availablePharmacyProducts = productPayload.products;
        pharmacyDeliveryEnabled = productPayload.deliveryEnabled === true;
        pharmacyCart = pharmacyCart.map((item) => {
          const current = availablePharmacyProducts.find((product) => product.id === item.id);
          return current ? { ...item, deliveryMode: current.deliveryMode, deliveryZones: current.deliveryZones, coldChainRequired: current.coldChainRequired === true } : item;
        });
        updatePharmacyDeliveryForm();
        const prescriptionOffer = offerLookupId
          ? availablePharmacyProducts.find((product) => product.id === offerLookupId && product.prescriptionRequired === true)
          : null;
        if (prescriptionOffer) {
          prescriptionOfferAlreadyInCart = pharmacyCart.some((item) => item.id === prescriptionOffer.id);
          if (prescriptionOfferAlreadyInCart) {
            prescriptionOfferAdded = true;
          } else if (pharmacyCart.length >= 20) {
            status.textContent = "Une commande peut contenir au maximum 20 produits différents.";
            prescriptionOfferActionMessage = status.textContent;
          } else {
            addPharmacyProduct(prescriptionOffer);
            prescriptionOfferAdded = true;
          }
        } else if (offerLookupId) {
          prescriptionOfferUnavailable = true;
        }
        loadPharmacyProductsOnly();
        pharmacyProducts = pharmacyProductResults.childElementCount;
        if (offerLookupId) prescriptionOfferLookupPending = false;
      } else {
        pharmacyDeliveryEnabled = false;
        updatePharmacyDeliveryForm();
        pharmacyProductResults.replaceChildren(element("p", "nexa-catalog__status", "Le catalogue des produits pharmacie est temporairement indisponible."));
      }
    }
    const totalCount = cards.length + offerCards.length + pharmacyProducts;
    if (type === "nurses") {
      updateNursingProviderStatus();
    } else if (isDiagnosticCatalog) {
      updateDiagnosticOfferStatus();
    } else if (isPharmacyCatalog) {
      status.textContent = `${cards.length} pharmacie${cards.length === 1 ? "" : "s"} · ${pharmacyProducts} produit${pharmacyProducts === 1 ? "" : "s"}`;
    } else {
      status.textContent = totalCount === 1 ? "1 résultat" : totalCount + " résultats";
    }
    if (!totalCount && !(isDiagnosticCatalog && diagnosticOffersHasMore) && !(isNursingCatalog && nursingProvidersHasMore)) status.textContent = "Aucun service ne correspond à cette recherche.";
    if (prescriptionOfferAdded) {
      status.textContent = prescriptionOfferAlreadyInCart
        ? "L’offre de l’ordonnance est déjà dans votre panier. Vérifiez le produit ou l’examen avant de continuer."
        : "L’offre sélectionnée depuis votre ordonnance a été ajoutée au panier. Vérifiez-la avant de continuer.";
    } else if (prescriptionOfferActionMessage) {
      status.textContent = prescriptionOfferActionMessage;
    } else if (prescriptionOfferUnavailable) {
      status.textContent = "L’offre sélectionnée depuis l’ordonnance n’est plus disponible. Vérifiez les autres offres affichées.";
    }
  } catch {
    if (generation !== catalogLoadGeneration) return;
    pharmacyDeliveryEnabled = false;
    updatePharmacyDeliveryForm();
    status.textContent = "Le répertoire NEXARIS est temporairement indisponible.";
    results.replaceChildren();
    diagnosticOfferResults.replaceChildren();
    pharmacyProductResults.replaceChildren();
    availableDiagnosticOffers = [];
    availablePharmacyProducts = [];
    diagnosticOffersCursor = "";
    diagnosticOffersHasMore = false;
    diagnosticOfferMore.hidden = true;
    nursingProvidersCursor = "";
    nursingProvidersHasMore = false;
    nursingProviderMore.hidden = true;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  loadCatalog(readFilters());
});

homeVisitOnly.addEventListener("change", () => loadCatalog(readFilters()));
diagnosticOfferMore.addEventListener("click", () => { void loadMoreDiagnosticOffers(); });
nursingProviderMore.addEventListener("click", () => { void loadMoreNursingProviders(); });
firebaseAuthActions.onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (!authReady) {
    authReady = true;
    authReadyResolve();
  }
});
renderPharmacyCart();
pharmacyCartCheckout.addEventListener("click", () => { void openPharmacyCheckout(); });
pharmacyCheckoutCreate.addEventListener("click", () => { void createPharmacyOrder(); });
pharmacyCheckoutPrescription.addEventListener("change", resetPharmacyRequestId);
pharmacyDeliveryMethod.addEventListener("change", () => { updatePharmacyDeliveryForm(); resetPharmacyRequestId(); });
pharmacyDeliveryZone.addEventListener("change", () => { updatePharmacyDeliveryForm(); resetPharmacyRequestId(); });
[pharmacyDeliveryRecipient, pharmacyDeliveryPhone, pharmacyDeliveryAddress, pharmacyDeliveryInstructions].forEach((field) => field.addEventListener("input", resetPharmacyRequestId));
pharmacyCheckoutClose.addEventListener("click", () => pharmacyCheckoutDialog.close());
pharmacyCheckoutDialog.addEventListener("click", (event) => { if (event.target === pharmacyCheckoutDialog) pharmacyCheckoutDialog.close(); });
nursingBookingZone.addEventListener("change", () => {
  const zone = activeNursingProvider?.zones?.find((entry) => entry.id === nursingBookingZone.value);
  nursingBookingDepartment.value = zone?.department || "";
  nursingBookingCommune.value = zone?.commune || "";
  updateNursingBookingSummary();
  resetNursingRequestId();
});
nursingBookingWeek.addEventListener("change", () => {
  updateNursingBookingPeriods();
  resetNursingRequestId();
});
nursingBookingPeriod.addEventListener("change", () => {
  updateNursingBookingSummary();
  resetNursingRequestId();
});
nursingBookingForm.addEventListener("input", (event) => {
  if (event.target !== nursingBookingDepartment && event.target !== nursingBookingCommune &&
    event.target !== nursingBookingPhone && event.target !== nursingBookingAddress) return;
  resetNursingRequestId();
});
nursingBookingForm.addEventListener("change", (event) => {
  if (event.target.matches('input[name="serviceId"]')) resetNursingRequestId();
});
nursingBookingForm.addEventListener("submit", (event) => { void submitNursingBooking(event); });
nursingBookingClose.addEventListener("click", () => nursingBookingDialog.close());
nursingBookingDialog.addEventListener("click", (event) => { if (event.target === nursingBookingDialog) nursingBookingDialog.close(); });
loadCatalog(parameters);
