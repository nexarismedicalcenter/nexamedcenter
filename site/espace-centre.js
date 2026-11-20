import { auth, firebaseAuthActions, NexaApiError, requestNexaFunction } from "./firebase-client.js";

const loading = document.querySelector("#centre-loading");
const loginPanel = document.querySelector("#centre-login");
const loginForm = document.querySelector("#centre-login-form");
const loginError = document.querySelector("#centre-login-error");
const loginButton = document.querySelector("#centre-login-submit");
const passwordResetButton = document.querySelector("#centre-password-reset");
const resetNotice = document.querySelector("#centre-reset-notice");
const emailInput = document.querySelector("#centre-email");
const deniedPanel = document.querySelector("#centre-denied");
const deniedMessage = document.querySelector("#centre-denied-message");
const deniedSignOutButton = document.querySelector("#centre-denied-sign-out");
const editor = document.querySelector("#centre-editor");
const centreName = document.querySelector("#centre-name");
const centreTypeLabel = document.querySelector("#centre-type-label");
const signOutButton = document.querySelector("#centre-sign-out");
const notice = document.querySelector("#centre-notice");
const errorBox = document.querySelector("#centre-error");
const searchForm = document.querySelector("#centre-search-form");
const searchInput = document.querySelector("#centre-search");
const reloadButton = document.querySelector("#centre-reload");
const ordersLoading = document.querySelector("#centre-orders-loading");
const ordersEmpty = document.querySelector("#centre-orders-empty");
const ordersList = document.querySelector("#centre-orders-list");
const loadMoreButton = document.querySelector("#centre-load-more");
const supportForm = document.querySelector("#centre-support-form");
const supportSection = document.querySelector("#support");
const supportSubmit = document.querySelector("#centre-support-submit");
const supportReload = document.querySelector("#centre-support-reload");
const supportList = document.querySelector("#centre-support-list");
const supportLoading = document.querySelector("#centre-support-loading");
const supportEmpty = document.querySelector("#centre-support-empty");
const supportNotice = document.querySelector("#centre-support-notice");
const supportError = document.querySelector("#centre-support-error");

const statusLabels = {
  PENDING_PAYMENT: "Paiement en attente", PAID: "Payée · à accepter", FREE: "Gratuite",
  ACCEPTED: "Acceptée", PATIENT_PRESENTED: "Présence confirmée", SAMPLE_COLLECTED: "Prélèvement effectué",
  SAMPLE_RECEIVED: "Échantillon reçu", ANALYSIS_IN_PROGRESS: "Analyse en cours", EXAM_IN_PROGRESS: "Examen en cours",
  EXAM_COMPLETED: "Examen réalisé · résultat à transmettre", COMPLETED: "Commande terminée",
  PROVIDER_REFUSED: "Refusée · suivi NEXA requis",
};
const resultLabels = {
  RESULT_PENDING_REVIEW: "Résultat transmis · revue NEXA en attente", CORRECTION_REQUESTED: "Correction demandée par NEXA",
  VALIDATED: "Résultat validé · transfert patient en attente", RESULT_AVAILABLE: "Résultat transmis au patient",
  NOT_PERFORMED: "Examen marqué non réalisé · suivi NEXA requis", SUPERSEDED: "Ancienne version remplacée",
};

let currentUser = null;
let currentSearch = "";
let nextCursor = "";
let loadingMore = false;
let busyKey = "";
let supportBusy = false;
let currentProviderType = "";

const supportStatusLabels = { OPEN: "Ouvert", IN_PROGRESS: "En cours", RESOLVED: "Résolu", CLOSED: "Fermé" };
const supportCategoryLabels = { commande: "Commande", examen: "Examen", resultat: "Résultat", paiement: "Paiement", remboursement: "Remboursement", decaissement: "Décaissement", compte: "Compte", technique: "Technique" };

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
  const amount = Number.isSafeInteger(value) ? value : 0;
  return `${new Intl.NumberFormat("fr-HT").format(amount)} ${currency}`;
}

function requirementsFor(item, providerType) {
  const value = item.resultRequirements;
  return value && typeof value === "object" ? value : {
    requiredCategories: [providerType === "laboratory" ? "LAB_RESULT" : "IMAGING"],
    allowSupplemental: true, allowMultiplePerCategory: true, maxFiles: 20, maxFileBytes: 15 * 1024 * 1024,
    allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"],
  };
}

function statusNext(order, type) {
  if (order.status === "PAID") return { action: "accept", label: "Accepter la commande" };
  if (type === "laboratory") {
    const values = {
      ACCEPTED: ["PATIENT_PRESENTED", "Confirmer l’arrivée du patient"],
      PATIENT_PRESENTED: ["SAMPLE_COLLECTED", "Confirmer le prélèvement"],
      SAMPLE_COLLECTED: ["SAMPLE_RECEIVED", "Confirmer la réception de l’échantillon"],
      SAMPLE_RECEIVED: ["ANALYSIS_IN_PROGRESS", "Démarrer l’analyse"],
      ANALYSIS_IN_PROGRESS: ["EXAM_COMPLETED", "Marquer l’examen comme réalisé"],
    };
    return values[order.status] ? { action: "advance", label: values[order.status][1] } : null;
  }
  const values = {
    ACCEPTED: ["PATIENT_PRESENTED", "Confirmer l’arrivée du patient"],
    PATIENT_PRESENTED: ["EXAM_IN_PROGRESS", "Démarrer l’examen"],
    EXAM_IN_PROGRESS: ["EXAM_COMPLETED", "Marquer l’examen comme réalisé"],
  };
  return values[order.status] ? { action: "advance", label: values[order.status][1] } : null;
}

async function updateOrder(order, action, reason = "") {
  const key = order.id + ":" + action;
  if (!currentUser || busyKey) return;
  busyKey = key;
  showMessage(errorBox, "");
  showMessage(notice, "");
  try {
    await requestNexaFunction(currentUser, "nexaDiagnosticProviderOrders", "POST", { orderId: order.id, action, ...(reason ? { reason } : {}) });
    showMessage(notice, action === "refuse" ? "Le refus est enregistré et le suivi de règlement est transmis à NEXA." : "La commande a été mise à jour.");
    busyKey = "";
    await loadOrders();
  } catch (error) {
    showMessage(errorBox, error instanceof Error ? error.message : "La commande n’a pas pu être mise à jour.");
  } finally { busyKey = ""; }
}

function buildRefusalForm(order) {
  const form = document.createElement("form");
  form.className = "nexa-diagnostic-refusal";
  const label = makeText("label", "", "Motif du refus");
  const reason = document.createElement("textarea");
  reason.required = true;
  reason.maxLength = 500;
  reason.minLength = 5;
  reason.rows = 2;
  label.append(reason);
  const submit = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Signaler l’impossibilité de traiter");
  submit.type = "submit";
  submit.disabled = Boolean(busyKey);
  form.append(label, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void updateOrder(order, "refuse", reason.value.trim());
  });
  return form;
}

function buildUploadForm(order, item, providerType) {
  const requirements = requirementsFor(item, providerType);
  const form = document.createElement("form");
  form.className = "nexa-diagnostic-upload nexa-provider-form";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.accept = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";
  const fileLabel = makeText("label", "", `Fichiers PDF, JPG ou PNG · ${Math.round(requirements.maxFileBytes / (1024 * 1024))} Mio maximum chacun`);
  fileLabel.append(fileInput);
  const fileList = document.createElement("ul");
  fileList.className = "nexa-diagnostic-files";
  const dateInput = document.createElement("input");
  dateInput.type = "date";
  const dateLabel = makeText("label", "", "Date de réalisation (facultative)");
  dateLabel.append(dateInput);
  const commentInput = document.createElement("textarea");
  commentInput.maxLength = 1_000;
  commentInput.rows = 3;
  const commentLabel = makeText("label", "", "Commentaire facultatif");
  commentLabel.append(commentInput);
  const confirmInput = document.createElement("input");
  confirmInput.type = "checkbox";
  confirmInput.required = true;
  const confirmLabel = makeText("label", "nexa-diagnostic-confirm", "Je confirme que les fichiers correspondent au patient, à l’examen et à la commande affichés.");
  confirmLabel.prepend(confirmInput);
  const feedback = makeText("p", "nexa-provider-help", "");
  feedback.setAttribute("role", "status");
  const submit = makeText("button", "nexa-provider-button", item.resultStatus === "CORRECTION_REQUESTED" ? "Transmettre la correction" : "Transmettre à la revue NEXA");
  submit.type = "submit";
  const required = Array.isArray(requirements.requiredCategories) ? requirements.requiredCategories : [];
  const categories = providerType === "laboratory" ? ["LAB_RESULT", "SUPPLEMENTAL"] : ["IMAGING", "RADIOLOGY_REPORT", "SUPPLEMENTAL"];
  const selectedFiles = [];

  function renderFiles() {
    fileList.replaceChildren();
    selectedFiles.forEach((entry) => {
      const row = document.createElement("li");
      const name = makeText("span", "", `${entry.file.name} · ${new Intl.NumberFormat("fr-HT", { maximumFractionDigits: 1 }).format(entry.file.size / (1024 * 1024))} Mio`);
      const categoryLabel = makeText("label", "", "Catégorie");
      const select = document.createElement("select");
      categories.filter((category) => category !== "SUPPLEMENTAL" || requirements.allowSupplemental).forEach((category) => {
        const option = document.createElement("option");
        option.value = category;
        option.textContent = category === "LAB_RESULT" ? "Résultat de laboratoire" : category === "IMAGING" ? "Image d’imagerie" : category === "RADIOLOGY_REPORT" ? "Compte rendu d’imagerie" : "Document complémentaire";
        select.append(option);
      });
      select.value = entry.category;
      select.addEventListener("change", () => { entry.category = select.value; });
      categoryLabel.append(select);
      const remove = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Retirer");
      remove.type = "button";
      remove.addEventListener("click", () => {
        const index = selectedFiles.indexOf(entry);
        if (index >= 0) selectedFiles.splice(index, 1);
        renderFiles();
      });
      row.append(name, categoryLabel, remove);
      fileList.append(row);
    });
  }

  fileInput.addEventListener("change", () => {
    const newFiles = Array.from(fileInput.files || []);
    const currentSize = selectedFiles.length;
    const invalid = newFiles.find((file) => !requirements.allowedMimeTypes.includes(file.type) || file.size < 1 || file.size > requirements.maxFileBytes);
    if (invalid) {
      showMessage(feedback, "Un fichier ne respecte pas les formats autorisés ou la limite de taille.");
      fileInput.value = "";
      return;
    }
    if (currentSize + newFiles.length > requirements.maxFiles) {
      showMessage(feedback, `Un résultat peut contenir au maximum ${requirements.maxFiles} fichiers.`);
      fileInput.value = "";
      return;
    }
    newFiles.forEach((file) => selectedFiles.push({ file, category: required[0] || (providerType === "laboratory" ? "LAB_RESULT" : "IMAGING") }));
    showMessage(feedback, "");
    renderFiles();
    fileInput.value = "";
  });

  form.append(fileLabel, fileList, dateLabel, commentLabel, confirmLabel, feedback, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!currentUser || busyKey) return;
    const missing = required.find((category) => !selectedFiles.some((entry) => entry.category === category));
    if (!selectedFiles.length || missing) {
      showMessage(feedback, `Ajoutez un fichier pour chaque catégorie obligatoire${missing ? ` : ${missing}` : ""}.`);
      return;
    }
    if (!requirements.allowMultiplePerCategory && selectedFiles.some((entry, index) => selectedFiles.some((other, otherIndex) => otherIndex < index && other.category === entry.category))) {
      showMessage(feedback, "Cet examen n’autorise qu’un seul fichier par catégorie.");
      return;
    }
    const key = order.id + ":" + item.offerId;
    busyKey = key;
    submit.disabled = true;
    showMessage(errorBox, "");
    showMessage(notice, "");
    showMessage(feedback, "Dépôt, analyse de sécurité et transmission en cours…");
    let uploadSessionId = "";
    try {
      const started = await requestNexaFunction(currentUser, "nexaDiagnosticResultUploadSessions", "POST", {
        orderId: order.id, examLineId: item.offerId, confirmMatch: true,
        files: selectedFiles.map(({ file, category }) => ({ fileName: file.name, contentType: file.type, size: file.size, category })),
      });
      uploadSessionId = started.uploadSessionId;
      await Promise.all(started.files.map(async (policy, index) => {
        const target = new URL(policy.uploadUrl);
        const localUpload = location.hostname === "localhost" && target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
        if ((!localUpload && target.protocol !== "https:") || (!localUpload && target.hostname !== "storage.googleapis.com" && !target.hostname.endsWith(".storage.googleapis.com"))) {
          throw new Error("Le lien de téléversement sécurisé n’est pas valide.");
        }
        const upload = new FormData();
        Object.entries(policy.fields || {}).forEach(([name, value]) => upload.append(name, value));
        upload.append("file", selectedFiles[index].file, policy.fileName);
        const response = await fetch(target, { method: "POST", body: upload, cache: "no-store" });
        if (!response.ok) throw new Error(`Le fichier ${index + 1} n’a pas été téléversé. Vérifiez votre connexion puis réessayez.`);
      }));
      const submitted = await requestNexaFunction(currentUser, "nexaDiagnosticResultSubmit", "POST", {
        uploadSessionId, comment: commentInput.value.trim(), performedAt: dateInput.value,
      });
      showMessage(notice, submitted.message || "Le résultat est transmis à la revue sécurisée NEXA.");
      busyKey = "";
      await loadOrders();
    } catch (error) {
      showMessage(errorBox, error instanceof Error ? error.message : "Le résultat n’a pas pu être transmis.");
      if (uploadSessionId) await requestNexaFunction(currentUser, "nexaDiagnosticResultUploadSessions", "DELETE", { uploadSessionId }).catch(() => undefined);
    } finally {
      busyKey = "";
      submit.disabled = false;
      showMessage(feedback, "");
    }
  });
  return form;
}

function renderOrder(order, providerType) {
  const card = document.createElement("li");
  card.className = "nexa-diagnostic-order";
  const top = document.createElement("div");
  top.className = "nexa-diagnostic-order__top";
  const identity = document.createElement("div");
  identity.append(makeText("strong", "", order.orderNumber), makeText("span", "", `Patient ${order.patientNumber}`),
    makeText("small", "", `${formatDate(order.createdAt)} · ${formatMoney(order.amount, order.currency)}`));
  top.append(identity, makeText("span", "nexa-diagnostic-order__status", statusLabels[order.status] || order.status));
  card.append(top);
  const items = document.createElement("ul");
  items.className = "nexa-diagnostic-lines";
  (Array.isArray(order.items) ? order.items : []).forEach((item) => {
    const line = document.createElement("li");
    line.append(makeText("strong", "", item.name || "Examen médical"));
    if (item.resultStatus) line.append(makeText("p", "nexa-provider-help", resultLabels[item.resultStatus] || item.resultStatus));
    if (item.resultStatus === "CORRECTION_REQUESTED" && item.correctionReason) {
      const reason = makeText("p", "nexa-provider-error", `Correction demandée par NEXA : ${item.correctionReason}`);
      reason.setAttribute("role", "note");
      line.append(reason);
    }
    if (["EXAM_COMPLETED", "COMPLETED"].includes(order.status) && (!item.resultStatus || item.resultStatus === "CORRECTION_REQUESTED")) {
      line.append(buildUploadForm(order, item, providerType));
    }
    items.append(line);
  });
  card.append(items);
  const next = statusNext(order, providerType);
  if (next || ["PAID", "ACCEPTED"].includes(order.status)) {
    const actions = document.createElement("div");
    actions.className = "nexa-diagnostic-order__actions";
    if (next) {
      const button = makeText("button", "nexa-provider-button", next.label);
      button.type = "button";
      button.disabled = Boolean(busyKey);
      button.addEventListener("click", () => void updateOrder(order, next.action));
      actions.append(button);
    }
    if (["PAID", "ACCEPTED"].includes(order.status)) actions.append(buildRefusalForm(order));
    card.append(actions);
  }
  return card;
}

async function loadOrders({ append = false } = {}) {
  if (!currentUser || busyKey) return;
  if (append) loadingMore = true;
  ordersLoading.hidden = false;
  ordersEmpty.hidden = true;
  loadMoreButton.disabled = true;
  showMessage(errorBox, "");
  try {
    const query = { ...(currentSearch ? { q: currentSearch } : {}), ...(append && nextCursor ? { cursor: nextCursor } : {}) };
    const response = await requestNexaFunction(currentUser, "nexaDiagnosticProviderOrders", "GET", undefined, query);
    if (!append) {
      ordersList.replaceChildren();
      centreName.textContent = response.providerName || "Centre NEXA";
      centreTypeLabel.textContent = response.providerType === "laboratory" ? "NEXA - LAB · CENTRE VÉRIFIÉ" : "NEXA - IMAGING · CENTRE VÉRIFIÉ";
      currentProviderType = response.providerType || "";
      supportSection.hidden = currentProviderType !== "laboratory";
    }
    (response.orders || []).forEach((order) => ordersList.append(renderOrder(order, response.providerType)));
    nextCursor = response.nextCursor || "";
    ordersEmpty.hidden = ordersList.children.length > 0;
    loadMoreButton.hidden = !nextCursor;
  } catch (error) {
    if (error instanceof NexaApiError && error.status === 403 && error.code === "verified-diagnostic-provider-required") {
      editor.hidden = true;
      deniedPanel.hidden = false;
      showMessage(deniedMessage, error.message);
    } else {
      showMessage(errorBox, error instanceof Error ? error.message : "Les commandes ne peuvent pas être chargées.");
    }
  } finally {
    ordersLoading.hidden = true;
    loadingMore = false;
    loadMoreButton.disabled = false;
  }
  if (currentProviderType === "laboratory") void loadSupportTickets();
}

function renderSupportTicket(ticket) {
  const card = document.createElement("li");
  card.className = "nexa-diagnostic-order";
  card.append(makeText("strong", "", ticket.subject), makeText("span", "nexa-diagnostic-order__status", supportStatusLabels[ticket.status] || ticket.status));
  card.append(makeText("p", "nexa-provider-help", `${supportCategoryLabels[ticket.category] || "Technique"} · ${ticket.messageCount || 0} réponse(s) · ${formatDate(ticket.updatedAt || ticket.createdAt)}`));
  card.append(makeText("p", "nexa-provider-help", ticket.description));
  if (Array.isArray(ticket.messages) && ticket.messages.length) {
    const thread = document.createElement("ol");
    thread.className = "nexa-diagnostic-lines";
    ticket.messages.forEach((message) => {
      const item = document.createElement("li");
      item.append(makeText("strong", "", "Support NEXA"), makeText("p", "nexa-provider-help", message.message), makeText("small", "", formatDate(message.createdAt)));
      thread.append(item);
    });
    card.append(thread);
  }
  const openButton = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Afficher les réponses");
  openButton.type = "button";
  openButton.addEventListener("click", async () => {
    if (!currentUser || supportBusy) return;
    supportBusy = true;
    showMessage(supportError, "");
    try {
      const response = await requestNexaFunction(currentUser, "nexaLabSupportTickets", "GET", undefined, { ticketId: ticket.id });
      supportList.replaceChild(renderSupportTicket(response.ticket), card);
    } catch (error) {
      showMessage(supportError, error instanceof Error ? error.message : "Les réponses ne peuvent pas être chargées.");
    } finally { supportBusy = false; }
  });
  if (!Array.isArray(ticket.messages)) card.append(openButton);
  return card;
}

async function loadSupportTickets() {
  if (!currentUser || supportBusy) return;
  supportBusy = true;
  supportLoading.hidden = false;
  supportEmpty.hidden = true;
  showMessage(supportError, "");
  try {
    const response = await requestNexaFunction(currentUser, "nexaLabSupportTickets", "GET");
    supportList.replaceChildren(...(response.tickets || []).map(renderSupportTicket));
    supportEmpty.hidden = supportList.children.length > 0;
  } catch (error) {
    showMessage(supportError, error instanceof Error ? error.message : "Les demandes ne peuvent pas être chargées.");
  } finally {
    supportBusy = false;
    supportLoading.hidden = true;
  }
}

supportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser || supportBusy) return;
  supportBusy = true;
  supportSubmit.disabled = true;
  showMessage(supportNotice, "");
  showMessage(supportError, "");
  try {
    const formData = new FormData(supportForm);
    await requestNexaFunction(currentUser, "nexaLabSupportTickets", "POST", {
      category: String(formData.get("category") || ""),
      subject: String(formData.get("subject") || "").trim(),
      description: String(formData.get("description") || "").trim(),
    });
    supportForm.reset();
    showMessage(supportNotice, "Votre demande a été transmise au support NEXA.");
    supportBusy = false;
    await loadSupportTickets();
  } catch (error) {
    showMessage(supportError, error instanceof Error ? error.message : "La demande ne peut pas être envoyée.");
  } finally {
    supportBusy = false;
    supportSubmit.disabled = false;
  }
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginButton.disabled = true;
  showMessage(loginError, "");
  showMessage(resetNotice, "");
  try {
    const data = new FormData(loginForm);
    await firebaseAuthActions.signInWithEmailAndPassword(auth, String(data.get("email") || "").trim(), String(data.get("password") || ""));
  } catch (error) {
    showMessage(loginError, error instanceof Error ? error.message : "La connexion n’a pas abouti.");
  } finally { loginButton.disabled = false; }
});

passwordResetButton.addEventListener("click", async () => {
  const email = emailInput.value.trim();
  showMessage(loginError, "");
  showMessage(resetNotice, "");
  if (!email) {
    showMessage(loginError, "Saisissez votre adresse e-mail pour demander un lien de réinitialisation.");
    emailInput.focus();
    return;
  }
  passwordResetButton.disabled = true;
  try {
    await firebaseAuthActions.sendPasswordResetEmail(auth, email);
  } catch {
    // Keep the response the same for registered and unregistered addresses.
  } finally {
    passwordResetButton.disabled = false;
    showMessage(resetNotice, "Si cette adresse est associée à un compte NEXA, un e-mail de réinitialisation a été envoyé. Vérifiez aussi vos courriers indésirables.");
  }
});

signOutButton.addEventListener("click", () => firebaseAuthActions.signOut(auth));
deniedSignOutButton.addEventListener("click", () => firebaseAuthActions.signOut(auth));
reloadButton.addEventListener("click", () => void loadOrders());
supportReload.addEventListener("click", () => void loadSupportTickets());
loadMoreButton.addEventListener("click", () => { if (!loadingMore) void loadOrders({ append: true }); });
searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  currentSearch = searchInput.value.trim().toUpperCase();
  nextCursor = "";
  void loadOrders();
});

firebaseAuthActions.onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  currentProviderType = "";
  deniedPanel.hidden = true;
  editor.hidden = true;
  ordersList.replaceChildren();
  supportList.replaceChildren();
  supportSection.hidden = true;
  showMessage(supportError, "");
  showMessage(supportNotice, "");
  nextCursor = "";
  if (!user) {
    loading.hidden = true;
    loginPanel.hidden = false;
    return;
  }
  loginPanel.hidden = true;
  editor.hidden = false;
  loading.hidden = true;
  await loadOrders();
});
