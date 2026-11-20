import { auth, firebaseAuthActions, NexaApiError, requestNexaFunction } from "./firebase-client.js";

const loading = document.querySelector("#pharmacie-loading");
const loginPanel = document.querySelector("#pharmacie-login");
const loginForm = document.querySelector("#pharmacie-login-form");
const loginError = document.querySelector("#pharmacie-login-error");
const loginButton = document.querySelector("#pharmacie-login-submit");
const passwordResetButton = document.querySelector("#pharmacie-password-reset");
const passwordResetNotice = document.querySelector("#pharmacie-reset-notice");
const emailInput = document.querySelector("#pharmacie-email");
const deniedPanel = document.querySelector("#pharmacie-denied");
const deniedMessage = document.querySelector("#pharmacie-denied-message");
const deniedSignOutButton = document.querySelector("#pharmacie-denied-sign-out");
const editor = document.querySelector("#pharmacie-editor");
const pharmacyName = document.querySelector("#pharmacie-name");
const signOutButton = document.querySelector("#pharmacie-sign-out");
const notice = document.querySelector("#pharmacie-notice");
const errorBox = document.querySelector("#pharmacie-error");
const reloadButton = document.querySelector("#pharmacie-reload");
const ordersLoading = document.querySelector("#pharmacie-orders-loading");
const ordersEmpty = document.querySelector("#pharmacie-orders-empty");
const ordersList = document.querySelector("#pharmacie-orders-list");
const productsLoading = document.querySelector("#pharmacie-products-loading");
const productsEmpty = document.querySelector("#pharmacie-products-empty");
const productsError = document.querySelector("#pharmacie-products-error");
const productsList = document.querySelector("#pharmacie-products-list");
const newProductButton = document.querySelector("#pharmacie-product-new");
const productForm = document.querySelector("#pharmacie-product-form");
const productFormTitle = document.querySelector("#pharmacie-product-form-title");
const productFormMessage = document.querySelector("#pharmacie-product-form-message");
const productSubmitButton = document.querySelector("#pharmacie-product-submit");
const productIdInput = document.querySelector("#pharmacie-product-id");
const productCategoryInput = document.querySelector("#pharmacie-product-category");
const productPrescriptionInput = document.querySelector("#pharmacie-product-prescription");
const productStockField = document.querySelector("#pharmacie-product-stock-field");
const productStockInput = document.querySelector("#pharmacie-product-stock");
const initialLotFields = document.querySelector("#pharmacie-initial-lot-fields");
const deliveryModeInput = document.querySelector("#pharmacie-product-delivery-mode");
const deliveryZones = document.querySelector("#pharmacie-delivery-zones");
const productCancelButton = document.querySelector("#pharmacie-product-cancel");
const zoneAddButton = document.querySelector("#pharmacie-zone-add");

const statusLabels = {
  PAID: "Payée · à accepter",
  ACCEPTED: "Acceptée",
  PREPARING: "En préparation",
  READY: "Prête · remise à effectuer",
  COMPLETED: "Remise confirmée",
  PROVIDER_REFUSED: "Refusée · revue NEXA requise",
};

let currentUser = null;
let currentOrders = [];
let currentProducts = [];
let busyOrderId = "";
let productBusy = false;

function makeText(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value || "";
  return element;
}

function showMessage(element, message) {
  element.textContent = message || "";
  element.hidden = !message;
}

function formatDate(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "Date non disponible" : new Intl.DateTimeFormat("fr-HT", {
    timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short",
  }).format(date);
}

function formatMoney(value, currency = "HTG") {
  const amount = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return `${new Intl.NumberFormat("fr-HT").format(amount)} ${currency}`;
}

function actionButton(order, action, label, quiet = false) {
  const button = makeText("button", `nexa-provider-button${quiet ? " nexa-provider-button--quiet" : ""}`, label);
  button.type = "button";
  button.disabled = Boolean(busyOrderId);
  button.addEventListener("click", () => { void updateOrder(order, action); });
  return button;
}

function productButton(label, quiet = false) {
  const button = makeText("button", `nexa-provider-button${quiet ? " nexa-provider-button--quiet" : ""}`, label);
  button.type = "button";
  button.disabled = productBusy;
  return button;
}

function renderRefusalForm(order) {
  const form = document.createElement("form");
  form.className = "nexa-pharmacy-refusal";
  const label = makeText("label", "", "Motif du refus");
  const reason = document.createElement("textarea");
  reason.required = true;
  reason.minLength = 5;
  reason.maxLength = 500;
  reason.rows = 2;
  reason.setAttribute("aria-label", "Motif du refus");
  label.append(reason);
  const submit = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Refuser et transmettre à NEXA");
  submit.type = "submit";
  submit.disabled = Boolean(busyOrderId);
  form.append(label, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void updateOrder(order, "refuse", reason.value.trim());
  });
  return form;
}

function renderOrder(order) {
  const item = document.createElement("li");
  item.className = "nexa-pharmacy-order";
  const top = document.createElement("div");
  top.className = "nexa-diagnostic-order__top";
  const identity = document.createElement("div");
  identity.append(
    makeText("strong", "", order.orderNumber || "Commande NEXA"),
    makeText("span", "", `Créée le ${formatDate(order.createdAt)} · ${order.paymentMethod === "SMART_WALLET" ? "Wallet NEXA" : "MonCash"} · ${order.deliveryMethod === "delivery" ? "Livraison" : "Retrait"}`),
  );
  const status = makeText("span", "nexa-diagnostic-order__status", statusLabels[order.status] || "Statut en cours de vérification");
  top.append(identity, status);

  const productList = document.createElement("ul");
  productList.className = "nexa-pharmacy-order__items";
  productList.setAttribute("aria-label", "Produits de la commande");
  (Array.isArray(order.items) ? order.items : []).forEach((line) => {
    const row = document.createElement("li");
    const details = [line.name, line.dci, line.dosage, line.route, line.pharmaceuticalForm].filter(Boolean).join(" · ");
    const amount = `${line.quantity} × ${formatMoney(line.unitPrice, order.currency)} · ${formatMoney(line.lineTotal, order.currency)}`;
    row.append(makeText("span", "", details), makeText("span", "", amount));
    productList.append(row);
    if (line.prescriptionRequired) productList.append(makeText("li", "nexa-pharmacy-order__prescription", "Produit soumis à ordonnance · détails non affichés"));
  });

  const totals = document.createElement("div");
  totals.className = "nexa-pharmacy-order__totals";
  totals.append(
    makeText("span", "", `Médicaments : ${formatMoney(order.subtotal, order.currency)}`),
    ...(order.deliveryMethod === "delivery" ? [makeText("span", "", `Livraison : ${formatMoney(order.deliveryFee, order.currency)}`)] : []),
    makeText("span", "", `Frais de transaction NEXA : ${formatMoney(order.transactionFee, order.currency)}`),
    makeText("strong", "", `Total payé : ${formatMoney(order.totalAmount, order.currency)}`),
  );

  let deliveryDetails = null;
  if (order.deliveryMethod === "delivery" && order.deliveryAddress) {
    const address = order.deliveryAddress;
    deliveryDetails = document.createElement("address");
    deliveryDetails.className = "nexa-pharmacy-order__delivery";
    deliveryDetails.append(
      makeText("strong", "", `Livrer à ${address.recipientName || ""}`),
      makeText("span", "", address.phone || ""),
      makeText("span", "", [address.addressLine, address.commune, address.department].filter(Boolean).join(", ")),
    );
    if (address.instructions) deliveryDetails.append(makeText("span", "", `Instructions : ${address.instructions}`));
  }

  const actions = document.createElement("div");
  actions.className = "nexa-pharmacy-order__actions";
  if (order.status === "PAID") actions.append(actionButton(order, "accept", "Accepter la commande"));
  if (order.status === "ACCEPTED") actions.append(actionButton(order, "prepare", "Commencer la préparation"));
  if (order.status === "PREPARING") actions.append(actionButton(order, "ready", order.deliveryMethod === "delivery" ? "Prête pour la livraison" : "Marquer prête au retrait"));
  if (order.status === "READY") actions.append(actionButton(order, "complete", order.deliveryMethod === "delivery" ? "Confirmer la livraison" : "Confirmer le retrait"));
  if (["PAID", "ACCEPTED", "PREPARING"].includes(order.status)) actions.append(renderRefusalForm(order));

  item.append(top, productList, totals);
  if (deliveryDetails) item.append(deliveryDetails);
  if (actions.childElementCount) item.append(actions);
  return item;
}

function renderOrders() {
  ordersList.replaceChildren(...currentOrders.map(renderOrder));
  ordersEmpty.hidden = currentOrders.length > 0;
}

async function loadOrders() {
  if (!currentUser) return;
  ordersLoading.hidden = false;
  ordersEmpty.hidden = true;
  reloadButton.disabled = true;
  showMessage(errorBox, "");
  try {
    const response = await requestNexaFunction(currentUser, "nexaPharmacyProviderOrders", "GET");
    pharmacyName.textContent = response.providerName || "Pharmacie NEXA";
    currentOrders = Array.isArray(response.orders) ? response.orders : [];
    renderOrders();
  } catch (error) {
    if (error instanceof NexaApiError && error.status === 403 && error.code === "verified-pharmacy-required") {
      editor.hidden = true;
      deniedPanel.hidden = false;
      showMessage(deniedMessage, error.message);
    } else {
      showMessage(errorBox, error instanceof Error ? error.message : "Les commandes ne peuvent pas être chargées.");
    }
  } finally {
    ordersLoading.hidden = true;
    reloadButton.disabled = false;
  }
}

async function updateOrder(order, action, reason = "") {
  if (!currentUser || busyOrderId) return;
  busyOrderId = order.id;
  reloadButton.disabled = true;
  renderOrders();
  showMessage(errorBox, "");
  showMessage(notice, "");
  try {
    await requestNexaFunction(currentUser, "nexaPharmacyProviderOrders", "POST", {
      orderId: order.id, action, ...(reason ? { reason } : {}),
    });
    showMessage(notice, action === "refuse"
      ? "Le refus et la libération du stock sont enregistrés. NEXA a reçu la demande de revue du remboursement."
      : "La commande a été mise à jour.");
    busyOrderId = "";
    await loadOrders();
  } catch (error) {
    showMessage(errorBox, error instanceof Error ? error.message : "La commande n’a pas pu être mise à jour.");
  } finally {
    busyOrderId = "";
    reloadButton.disabled = false;
    renderOrders();
  }
}

const productStatusLabels = {
  PENDING_REVIEW: "En revue NEXA",
  NEEDS_CORRECTION: "Correction demandée",
  PUBLISHED: "Publié",
  SUSPENDED: "Suspendu",
  REJECTED: "Refusé",
  ARCHIVED: "Archivé",
};

function appendZoneField(container, labelText, value, type, field, required = true) {
  const label = makeText("label", "", labelText);
  const input = document.createElement("input");
  input.type = type;
  input.value = value ?? "";
  input.dataset.zoneField = field;
  input.required = required;
  if (type === "number") { input.min = "0"; input.max = "100000"; input.step = "1"; }
  label.append(input);
  container.append(label);
}

function addDeliveryZone(zone = {}) {
  const row = document.createElement("div");
  row.className = "nexa-pharmacy-zone";
  appendZoneField(row, "Département", zone.department || "", "text", "department");
  appendZoneField(row, "Commune", zone.commune || "", "text", "commune");
  appendZoneField(row, "Frais de livraison (HTG)", zone.feeHTG ?? 0, "number", "feeHTG");
  appendZoneField(row, "Délai indicatif", zone.etaLabel || "", "text", "etaLabel");
  const activeLabel = makeText("label", "nexa-pharmacy-check", "Zone active");
  const active = document.createElement("input");
  active.type = "checkbox";
  active.dataset.zoneField = "active";
  active.checked = zone.active !== false;
  activeLabel.prepend(active);
  const remove = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Retirer");
  remove.type = "button";
  remove.addEventListener("click", () => row.remove());
  row.append(activeLabel, remove);
  deliveryZones.append(row);
}

function readDeliveryZones() {
  return Array.from(deliveryZones.querySelectorAll(".nexa-pharmacy-zone")).map((row) => ({
    department: row.querySelector('[data-zone-field="department"]').value.trim(),
    commune: row.querySelector('[data-zone-field="commune"]').value.trim(),
    feeHTG: Number(row.querySelector('[data-zone-field="feeHTG"]').value),
    etaLabel: row.querySelector('[data-zone-field="etaLabel"]').value.trim(),
    active: row.querySelector('[data-zone-field="active"]').checked,
  }));
}

function syncPrescriptionControl() {
  const mandatory = productCategoryInput.value !== "OTC";
  if (mandatory) productPrescriptionInput.checked = true;
  productPrescriptionInput.disabled = mandatory;
}

function clearProductEditor() {
  productForm.reset();
  productIdInput.value = "";
  productStockInput.value = "0";
  productStockField.hidden = false;
  initialLotFields.hidden = false;
  deliveryModeInput.value = "pickup";
  deliveryZones.replaceChildren();
  productFormTitle.textContent = "Nouveau produit";
  showMessage(productFormMessage, "");
  productForm.hidden = true;
  syncPrescriptionControl();
}

function openProductEditor(product = null) {
  clearProductEditor();
  productForm.hidden = false;
  if (!product) { productForm.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
  productFormTitle.textContent = "Modifier la fiche produit";
  productIdInput.value = product.id;
  productForm.elements.name.value = product.name || "";
  productForm.elements.dci.value = product.dci || "";
  productForm.elements.dosage.value = product.dosage || "";
  productForm.elements.route.value = product.route || "";
  productForm.elements.pharmaceuticalForm.value = product.pharmaceuticalForm || "";
  productForm.elements.therapeuticClass.value = product.therapeuticClass || "";
  productForm.elements.manufacturer.value = product.manufacturer || "";
  productCategoryInput.value = product.regulatoryCategory || "OTC";
  productForm.elements.price.value = String(product.price || "");
  productForm.elements.publicDescription.value = product.publicDescription || "";
  productPrescriptionInput.checked = product.prescriptionRequired === true;
  document.querySelector("#pharmacie-product-cold-chain").checked = product.coldChainRequired === true;
  deliveryModeInput.value = product.deliveryMode || "pickup";
  productStockField.hidden = true;
  initialLotFields.hidden = true;
  (Array.isArray(product.deliveryZones) ? product.deliveryZones : []).forEach(addDeliveryZone);
  syncPrescriptionControl();
  productForm.scrollIntoView({ behavior: "smooth", block: "center" });
}

function createLotReceiptForm(product) {
  const form = document.createElement("form");
  form.className = "nexa-pharmacy-receipt";
  const fields = [
    ["Numéro de lot", "text", "lotNumber", 80],
    ["Date d’expiration", "date", "expirationDate", 20],
    ["Quantité reçue", "number", "quantityReceived", 8],
  ];
  fields.forEach(([labelText, type, name, maxLength]) => {
    const label = makeText("label", "", labelText);
    const input = document.createElement("input");
    input.name = name;
    input.type = type;
    input.required = true;
    input.maxLength = maxLength;
    if (type === "number") { input.min = "1"; input.max = "1000000"; input.step = "1"; }
    label.append(input);
    form.append(label);
  });
  const submit = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Enregistrer le lot");
  submit.type = "submit";
  form.append(submit);
  const feedback = makeText("p", "nexa-provider-message", "");
  feedback.setAttribute("role", "status");
  feedback.hidden = true;
  form.append(feedback);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!currentUser || productBusy) return;
    productBusy = true;
    submit.disabled = true;
    showMessage(productsError, "");
    try {
      const data = new FormData(form);
      const response = await requestNexaFunction(currentUser, "nexaPharmacyProviderLotReceive", "POST", {
        productId: product.id,
        lotNumber: String(data.get("lotNumber") || "").trim(),
        expirationDate: String(data.get("expirationDate") || ""),
        quantityReceived: Number(data.get("quantityReceived")),
      });
      showMessage(feedback, response.alreadyReceived ? "Ce lot avait déjà été enregistré." : "Le lot et son mouvement de stock ont été enregistrés.");
      form.reset();
      await loadProducts();
    } catch (error) {
      showMessage(feedback, error instanceof Error ? error.message : "Le lot n’a pas pu être enregistré.");
    } finally {
      productBusy = false;
      submit.disabled = false;
    }
  });
  return form;
}

function renderProduct(product) {
  const card = document.createElement("li");
  card.className = "nexa-pharmacy-product-card";
  const top = document.createElement("div");
  top.className = "nexa-pharmacy-product-card__top";
  const identity = document.createElement("div");
  identity.append(
    makeText("strong", "", `${product.name || "Produit"} · ${product.dosage || "Dosage non indiqué"}`),
    makeText("span", "", `${product.dci || "DCI non indiquée"} · ${product.route || "Voie non indiquée"} · ${product.pharmaceuticalForm || "Forme non indiquée"} · ${formatMoney(product.price)}`),
  );
  top.append(identity, makeText("span", "nexa-pharmacy-product-status", productStatusLabels[product.publicationStatus] || "Statut à vérifier"));
  card.append(top, makeText("span", "", `Stock vendable : ${product.availableStock || 0} · Réservé : ${product.reservedStock || 0} · ${product.deliveryMode === "both" ? "Retrait ou livraison" : product.deliveryMode === "delivery" ? "Livraison" : "Retrait"}${product.coldChainRequired ? " · Chaîne du froid" : ""}`));
  if (product.reviewReason) card.append(makeText("span", "nexa-provider-error", `Motif NEXA : ${product.reviewReason}`));
  if (Array.isArray(product.deliveryZones) && product.deliveryZones.some((zone) => zone.active)) {
    card.append(makeText("span", "", `Zones : ${product.deliveryZones.filter((zone) => zone.active).map((zone) => `${zone.commune} (${formatMoney(zone.feeHTG)})`).join(" · ")}`));
  }
  const lots = document.createElement("ul");
  lots.className = "nexa-pharmacy-lots";
  lots.setAttribute("aria-label", `Lots de ${product.name || "ce produit"}`);
  (Array.isArray(product.lots) ? product.lots : []).forEach((lot) => lots.append(makeText("li", "", `Lot ${lot.lotNumber} · expire ${lot.expirationDate || "date inconnue"} · disponible ${lot.quantityAvailable} · réservé ${lot.reservedQuantity} · ${lot.status}`)));
  if (lots.childElementCount) card.append(lots);

  const actions = document.createElement("div");
  actions.className = "nexa-pharmacy-product-actions--card";
  const edit = productButton("Modifier la fiche", true);
  edit.disabled = Boolean(productBusy || product.reservedStock > 0 || product.publicationStatus === "ARCHIVED");
  edit.addEventListener("click", () => openProductEditor(product));
  const receive = productButton("Recevoir un lot", true);
  receive.disabled = Boolean(productBusy || product.publicationStatus === "ARCHIVED");
  receive.addEventListener("click", () => {
    const existing = card.querySelector(".nexa-pharmacy-receipt");
    if (existing) existing.remove();
    else card.append(createLotReceiptForm(product));
  });
  actions.append(edit, receive);
  if (product.publicationStatus !== "ARCHIVED") {
    const archive = productButton("Archiver", true);
    archive.disabled = Boolean(productBusy);
    archive.addEventListener("click", async () => {
      if (!window.confirm("Archiver ce produit et le retirer du catalogue ?")) return;
      try {
        productBusy = true;
        await requestNexaFunction(currentUser, "nexaPharmacyProviderProducts", "DELETE", { productId: product.id });
        showMessage(notice, "Le produit est archivé.");
        await loadProducts();
      } catch (error) { showMessage(productsError, error instanceof Error ? error.message : "Le produit n’a pas pu être archivé."); }
      finally { productBusy = false; renderProducts(); }
    });
    actions.append(archive);
  }
  card.append(actions);
  return card;
}

function renderProducts() {
  productsList.replaceChildren(...currentProducts.map(renderProduct));
  productsEmpty.hidden = currentProducts.length > 0;
}

async function loadProducts() {
  if (!currentUser) return;
  productsLoading.hidden = false;
  productsEmpty.hidden = true;
  showMessage(productsError, "");
  try {
    const response = await requestNexaFunction(currentUser, "nexaPharmacyProviderProducts", "GET");
    currentProducts = Array.isArray(response.products) ? response.products : [];
    renderProducts();
  } catch (error) {
    showMessage(productsError, error instanceof Error ? error.message : "Les produits ne peuvent pas être chargés.");
  } finally { productsLoading.hidden = true; }
}

newProductButton.addEventListener("click", () => openProductEditor());
productCancelButton.addEventListener("click", clearProductEditor);
zoneAddButton.addEventListener("click", () => addDeliveryZone());
productCategoryInput.addEventListener("change", syncPrescriptionControl);
productStockInput.addEventListener("input", () => {
  initialLotFields.hidden = Boolean(productIdInput.value) || Number(productStockInput.value) < 1;
});
productForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser || productBusy) return;
  const data = new FormData(productForm);
  const initialStock = Number(data.get("stock"));
  const lotNumber = String(data.get("lotNumber") || "").trim();
  const expirationDate = String(data.get("expirationDate") || "");
  if (!productIdInput.value && initialStock > 0 && (!lotNumber || !expirationDate)) {
    showMessage(productFormMessage, "Saisissez le numéro et la date d’expiration du lot initial, ou mettez le stock initial à zéro.");
    return;
  }
  productBusy = true;
  productSubmitButton.disabled = true;
  showMessage(productFormMessage, "Envoi de la fiche à la revue NEXA…");
  try {
    await requestNexaFunction(currentUser, "nexaPharmacyProviderProducts", "POST", {
      productId: productIdInput.value || undefined,
      name: String(data.get("name") || "").trim(), dci: String(data.get("dci") || "").trim(),
      dosage: String(data.get("dosage") || "").trim(), route: String(data.get("route") || "").trim(), pharmaceuticalForm: String(data.get("pharmaceuticalForm") || "").trim(),
      therapeuticClass: String(data.get("therapeuticClass") || "").trim(), manufacturer: String(data.get("manufacturer") || "").trim(),
      regulatoryCategory: String(data.get("regulatoryCategory") || "OTC"), prescriptionRequired: productPrescriptionInput.checked,
      price: Number(data.get("price")), stock: productIdInput.value ? 0 : initialStock,
      ...(productIdInput.value ? {} : { lotNumber, expirationDate }),
      publicDescription: String(data.get("publicDescription") || "").trim(), coldChainRequired: document.querySelector("#pharmacie-product-cold-chain").checked,
      deliveryMode: deliveryModeInput.value, deliveryZones: readDeliveryZones(),
    });
    showMessage(notice, "La fiche a été transmise à la revue NEXA. Elle ne sera visible qu’après publication.");
    clearProductEditor();
    await loadProducts();
  } catch (error) {
    showMessage(productFormMessage, error instanceof Error ? error.message : "La fiche produit n’a pas pu être enregistrée.");
  } finally {
    productBusy = false;
    productSubmitButton.disabled = false;
    renderProducts();
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginButton.disabled = true;
  showMessage(loginError, "");
  showMessage(passwordResetNotice, "");
  try {
    const data = new FormData(loginForm);
    await firebaseAuthActions.signInWithEmailAndPassword(auth, String(data.get("email") || "").trim(), String(data.get("password") || ""));
  } catch (error) {
    showMessage(loginError, error instanceof Error ? error.message : "La connexion n’a pas abouti.");
  } finally { loginButton.disabled = false; }
});

passwordResetButton.addEventListener("click", async () => {
  showMessage(loginError, "");
  showMessage(passwordResetNotice, "");
  if (!emailInput.reportValidity()) {
    emailInput.focus();
    return;
  }
  passwordResetButton.disabled = true;
  try {
    await firebaseAuthActions.sendPasswordResetEmail(auth, emailInput.value.trim());
  } catch {
    // Keep the response identical for registered and unregistered addresses.
  } finally {
    passwordResetButton.disabled = false;
    showMessage(passwordResetNotice, "Si cette adresse est associée à un compte NEXA, un e-mail de réinitialisation a été envoyé. Vérifiez aussi vos courriers indésirables.");
  }
});

signOutButton.addEventListener("click", () => firebaseAuthActions.signOut(auth));
deniedSignOutButton.addEventListener("click", () => firebaseAuthActions.signOut(auth));
reloadButton.addEventListener("click", () => { void loadOrders(); });

firebaseAuthActions.onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  deniedPanel.hidden = true;
  editor.hidden = true;
  ordersList.replaceChildren();
  currentOrders = [];
  productsList.replaceChildren();
  currentProducts = [];
  clearProductEditor();
  if (!user) {
    loading.hidden = true;
    loginPanel.hidden = false;
    return;
  }
  loginPanel.hidden = true;
  editor.hidden = false;
  loading.hidden = true;
  await Promise.all([loadOrders(), loadProducts()]);
});
