import { auth, firebaseAuthActions, requestNexaFunction } from "./firebase-client.js";

const SERVICES = [
  ["vital_signs", "Prise des signes vitaux", "Tension, température, fréquence cardiaque, saturation et glycémie capillaire."],
  ["medication_administration", "Administration de médicaments", "Injections et perfusions selon prescription et qualification."],
  ["wound_care", "Soins de plaies", "Pansements, escarres et suivi de cicatrisation."],
  ["sample_collection", "Prélèvements médicaux", "Prélèvements sanguins et collecte d’échantillons."],
  ["postoperative_care", "Soins postopératoires", "Surveillance, pansements et suivi après une intervention."],
  ["chronic_care", "Suivi des maladies chroniques", "Suivi infirmier des maladies chroniques."],
  ["elderly_assistance", "Assistance aux personnes âgées", "Mobilité, prévention des chutes et surveillance générale."],
  ["hygiene_comfort", "Soins d’hygiène et de confort", "Aide à l’hygiène, à l’habillage et prévention des escarres."],
  ["medical_devices", "Gestion de dispositifs médicaux", "Sondes, stomies et oxygénothérapie selon qualification."],
  ["therapeutic_education", "Éducation thérapeutique", "Conseils de santé et suivi de l’observance."],
  ["palliative_care", "Accompagnement en soins palliatifs", "Soins de confort et accompagnement du patient et de ses proches."],
];
const PERIODS = [
  ["DAY", "AM"],
  ["NIGHT", "PM"],
  ["WEEKEND", "Week-end"],
];
const WEEKDAY_NAMES = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const elements = {
  loading: document.querySelector("#nursing-loading"),
  login: document.querySelector("#nursing-login"),
  denied: document.querySelector("#nursing-denied"),
  deniedTitle: document.querySelector("#nursing-denied-title"),
  deniedMessage: document.querySelector("#nursing-denied-message"),
  editor: document.querySelector("#nursing-editor"),
  form: document.querySelector("#nursing-profile-form"),
  status: document.querySelector("#nursing-profile-status"),
  reason: document.querySelector("#nursing-review-reason"),
  notice: document.querySelector("#nursing-notice"),
  error: document.querySelector("#nursing-error"),
  photoFile: document.querySelector("#nursing-profile-photo"),
  photoConsent: document.querySelector("#nursing-photo-public-consent"),
  photoUpload: document.querySelector("#nursing-photo-upload"),
  photoMessage: document.querySelector("#nursing-photo-message"),
  photoPreview: document.querySelector("#nursing-photo-preview"),
  year: document.querySelector("#experience-start-year"),
  services: document.querySelector("#nursing-services"),
  zones: document.querySelector("#nursing-zones"),
  noZones: document.querySelector("#nursing-no-zones"),
  weekStart: document.querySelector("#week-start"),
  periods: document.querySelector("#nursing-periods"),
  weeks: document.querySelector("#nursing-weeks"),
  noWeeks: document.querySelector("#nursing-no-weeks"),
  addWeek: document.querySelector("#add-week"),
  save: document.querySelector("#save-nursing-profile"),
  ordersLoading: document.querySelector("#nursing-orders-loading"),
  ordersError: document.querySelector("#nursing-orders-error"),
  ordersEmpty: document.querySelector("#nursing-orders-empty"),
  ordersList: document.querySelector("#nursing-orders-list"),
  ordersRetry: document.querySelector("#nursing-orders-retry"),
  ordersMore: document.querySelector("#nursing-orders-more"),
  visitsLoading: document.querySelector("#nursing-visits-loading"),
  visitsError: document.querySelector("#nursing-visits-error"),
  visitsRetry: document.querySelector("#nursing-visits-retry"),
  visitsMore: document.querySelector("#nursing-visits-more"),
};

let currentUser = null;
let nursingOrdersCursor = "";
let nursingOrdersHasMore = false;
let nursingOrdersLoading = false;
let nursingOrdersGeneration = 0;
let nursingVisitsCursor = "";
let nursingVisitsHasMore = false;
let nursingVisitsLoading = false;
let nursingVisitsGeneration = 0;
const nursingVisitsByOrder = new Map();
let profile = { experienceStartYear: 0, serviceIds: [], zoneIds: [], weeklyAvailability: [] };
let zones = [];
let periodRules = {};

document.querySelector("#current-year").textContent = String(new Date().getFullYear());

function showMessage(element, message) {
  element.textContent = message;
  element.hidden = !message;
}

function renderNursingPhoto(photo) {
  elements.photoConsent.checked = photo.consentToPublicDisplay === true;
  const url = typeof photo.photoUrl === "string" ? photo.photoUrl : "";
  if (url.startsWith("https://")) {
    elements.photoPreview.src = url;
    elements.photoPreview.hidden = false;
  } else {
    elements.photoPreview.removeAttribute("src");
    elements.photoPreview.hidden = true;
  }
  const messages = {
    MISSING: "Aucune photo de profil n’a été téléversée.",
    PENDING_REVIEW: "Photo reçue · en attente de l’approbation du profil.",
    APPROVED: "Photo approuvée · visible dans l’annuaire lorsque le profil est publié.",
  };
  showMessage(elements.photoMessage, messages[photo.photoStatus] || "État de la photo indisponible.");
}

async function profilePhotoBase64(file) {
  if (!(file instanceof File) || !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size < 1 || file.size > 5_000_000) {
    throw new Error("Choisissez une photo JPEG, PNG ou WebP de 5 Mio maximum.");
  }
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 20_000_000) {
      throw new Error("La résolution de cette image est trop élevée. Choisissez une photo plus petite.");
    }
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Cette photo ne peut pas être préparée sur cet appareil.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob || blob.size > 1_000_000) throw new Error("La photo compressée dépasse la taille autorisée.");
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
      reader.addEventListener("error", () => reject(new Error("La photo ne peut pas être lue.")), { once: true });
      reader.readAsDataURL(blob);
    });
    const comma = dataUrl.indexOf(",");
    if (comma < 0) throw new Error("La photo préparée n’est pas valide.");
    return dataUrl.slice(comma + 1);
  } finally {
    bitmap.close();
  }
}

function scheduleDescription(rule) {
  if (!rule || !Array.isArray(rule.daysOfWeek)) return "Horaire à confirmer par NEXA";
  const days = [1, 2, 3, 4, 5, 6, 0]
    .filter((day) => rule.daysOfWeek.includes(day))
    .map((day) => WEEKDAY_NAMES[day])
    .join(", ");
  const endDay = rule.endDayOffset === 0 ? "même jour" : rule.endDayOffset === 1 ? "lendemain" : `+${rule.endDayOffset} jours`;
  return `${days} · ${rule.startTime}–${rule.endTime} (${endDay})`;
}

function formatHtg(value) {
  return Number.isSafeInteger(value) ? `${new Intl.NumberFormat("fr-HT").format(value)} HTG / période` : "Tarif à configurer par NEXA";
}

function selectedValues(name) {
  return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
}

function makeOption({ name, value, title, detail, checked = false }) {
  const label = document.createElement("label");
  label.className = "nursing-option";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.name = name;
  input.value = value;
  input.checked = checked;
  const text = document.createElement("span");
  const strong = document.createElement("strong");
  strong.textContent = title;
  const small = document.createElement("small");
  small.textContent = detail;
  text.append(strong, small);
  label.append(input, text);
  return label;
}

function renderProfile() {
  elements.year.value = profile.experienceStartYear || "";
  elements.services.replaceChildren(...SERVICES.map(([id, title, detail]) => makeOption({
    name: "serviceId", value: id, title, detail, checked: profile.serviceIds.includes(id),
  })));

  const activeZones = zones.filter((zone) => zone.active !== false);
  elements.zones.replaceChildren(...activeZones.map((zone) => {
    const tariffs = PERIODS.map(([id, title]) => `${title} (${scheduleDescription(periodRules[id])}) : ${formatHtg(zone.tariffs?.[id])}`).join(" · ");
    return makeOption({
      name: "zoneId",
      value: zone.id,
      title: `${zone.commune}, ${zone.department}`,
      detail: tariffs,
      checked: profile.zoneIds.includes(zone.id),
    });
  }));
  elements.noZones.hidden = activeZones.length > 0;

  elements.periods.replaceChildren(...PERIODS.map(([id, title]) => makeOption({
    name: "weekPeriod", value: id, title, detail: scheduleDescription(periodRules[id]),
  })));
  renderWeeks();
  elements.save.disabled = activeZones.length === 0;
}

function renderWeeks() {
  elements.weeks.replaceChildren(...profile.weeklyAvailability.map((week) => {
    const item = document.createElement("li");
    const summary = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = `Semaine du ${week.weekStart}`;
    const detail = document.createElement("small");
    detail.textContent = week.periods.map((id) => {
      const period = PERIODS.find(([periodId]) => periodId === id);
      return period ? `${period[1]} · ${scheduleDescription(periodRules[id])}` : id;
    }).join(" · ");
    summary.append(title, detail);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "nursing-button nursing-button--quiet";
    remove.textContent = "Retirer";
    remove.setAttribute("aria-label", `Retirer la semaine du ${week.weekStart}`);
    remove.addEventListener("click", () => {
      profile.weeklyAvailability = profile.weeklyAvailability.filter((entry) => entry.weekStart !== week.weekStart);
      renderWeeks();
    });
    item.append(summary, remove);
    return item;
  }));
  elements.noWeeks.hidden = profile.weeklyAvailability.length > 0;
}

function updateStatus(status) {
  const labels = {
    INCOMPLETE: "Profil incomplet · non visible",
    PENDING_REVIEW: "Profil transmis · vérification NEXA en attente",
    APPROVED: "Profil vérifié · publication à activer par NEXA",
    REJECTED: "Correction demandée par NEXA",
  };
  elements.status.textContent = labels[status] || "Profil à compléter";
}

async function loadProfile(user) {
  elements.loading.hidden = false;
  elements.login.hidden = true;
  elements.denied.hidden = true;
  elements.editor.hidden = true;
  try {
    const result = await requestNexaFunction(user, "nexaNursingServiceProfile", "GET");
    currentUser = user;
    profile = result.profile || { experienceStartYear: 0, serviceIds: [], zoneIds: [], weeklyAvailability: [] };
    profile.weeklyAvailability = Array.isArray(profile.weeklyAvailability) ? profile.weeklyAvailability : [];
    zones = Array.isArray(result.zones) ? result.zones : [];
    periodRules = result.periodRules || {};
    renderProfile();
    updateStatus(result.serviceProfileStatus);
    showMessage(elements.reason, result.serviceProfileReviewReason || "");
    try {
      renderNursingPhoto(await requestNexaFunction(user, "nexaNursingProfilePhoto", "GET"));
    } catch {
      renderNursingPhoto({ photoStatus: "UNAVAILABLE" });
    }
    elements.editor.hidden = false;
    void loadNursingOrders(user);
    void loadNursingVisits(user);
  } catch (error) {
    if (error.status === 401) {
      elements.login.hidden = false;
    } else {
      elements.deniedTitle.textContent = error.status === 403
        ? "Profil infirmier vérifié requis"
        : "Espace temporairement indisponible";
      elements.deniedMessage.textContent = error.message || "Ce profil ne peut pas accéder à cet espace.";
      elements.denied.hidden = false;
    }
  } finally {
    elements.loading.hidden = true;
  }
}

function renderNursingOrder(order) {
  const item = document.createElement("li");
  item.className = "nursing-order-card";
  item.dataset.orderId = order.id;
  const title = document.createElement("h3");
  title.textContent = order.orderNumber || "Réservation de soins infirmiers";
  const status = document.createElement("p");
  status.className = "nursing-order-card__status";
  status.textContent = order.status === "COMPLETED" ? "Période terminée" : "Payée · à coordonner avec le patient";
  const booking = order.booking || {};
  item.dataset.bookingMode = booking.bookingMode || "";
  const details = document.createElement("p");
  details.textContent = [
    "Patient " + (order.patientNumber || ""),
    booking.periodLabel || "",
    "semaine du " + (booking.weekStart || ""),
    booking.periodSchedule || "",
  ].filter(Boolean).join(" · ");
  const contact = document.createElement("p");
  contact.textContent = [order.patientName, booking.phone || order.patientPhone].filter(Boolean).join(" · ");
  const address = document.createElement("p");
  address.textContent = [booking.addressLine, booking.commune, booking.department].filter(Boolean).join(", ");
  const services = document.createElement("p");
  services.textContent = "Services souhaités : " + (Array.isArray(booking.services) ? booking.services.map((service) => service.label).filter(Boolean).join(" · ") : "");
  const mode = document.createElement("p");
  mode.textContent = booking.bookingModeDescription || "";
  item.append(title, status, details, contact, address, services);
  if (mode.textContent) item.append(mode);

  const visits = Array.isArray(order.visits) ? order.visits : [];
  renderNursingOrderVisits(item, visits);

  const singleVisitAlreadyPlanned = booking.bookingMode === "ONE_VISIT" && visits.length > 0;
  if (["PAID", "IN_PROGRESS"].includes(order.status) && !singleVisitAlreadyPlanned) {
    item.append(renderNursingVisitPlanForm(order));
  } else if (singleVisitAlreadyPlanned) {
    item.append(makeNursingText("p", "nursing-order-card__hint nursing-order-card__single-visit-hint", "La visite unique prévue pour cette période est déjà enregistrée."));
  }
  return item;
}

function renderNursingOrderVisits(orderItem, visits) {
  orderItem.querySelector(".nursing-order-card__visits")?.remove();
  if (visits.length) {
    const section = document.createElement("section");
    section.className = "nursing-order-card__visits";
    section.append(makeNursingText("h4", "nursing-order-card__subheading", "Prestations planifiées"));
    const list = document.createElement("ul");
    list.className = "nursing-visit-list";
    for (const visit of visits) list.append(renderNursingVisit(visit));
    section.append(list);
    const planForm = orderItem.querySelector(".nursing-visit-plan-form");
    orderItem.insertBefore(section, planForm || null);
  }
  if (orderItem.dataset.bookingMode === "ONE_VISIT" && visits.length) {
    orderItem.querySelector(".nursing-visit-plan-form")?.remove();
    if (!orderItem.querySelector(".nursing-order-card__single-visit-hint")) {
      orderItem.append(makeNursingText("p", "nursing-order-card__hint nursing-order-card__single-visit-hint", "La visite unique prévue pour cette période est déjà enregistrée."));
    }
  }
}

function visitsForNursingOrder(orderId) {
  return [...(nursingVisitsByOrder.get(orderId) || [])]
    .sort((left, right) => String(left.scheduledAt).localeCompare(String(right.scheduledAt)));
}

function cacheNursingVisit(visit) {
  if (!visit || typeof visit.orderId !== "string" || !visit.orderId || typeof visit.visitId !== "string" || !visit.visitId) return;
  const existing = nursingVisitsByOrder.get(visit.orderId) || [];
  const index = existing.findIndex((item) => item.visitId === visit.visitId);
  if (index >= 0) existing[index] = { ...existing[index], ...visit };
  else existing.push(visit);
  nursingVisitsByOrder.set(visit.orderId, existing);
  for (const card of elements.ordersList.querySelectorAll(".nursing-order-card[data-order-id]")) {
    if (card.dataset.orderId === visit.orderId) renderNursingOrderVisits(card, visitsForNursingOrder(visit.orderId));
  }
}

function makeNursingText(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function nursingVisitDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(date) + " · heure d’Haïti"
    : "Horaire invalide";
}

function nursingVisitStatus(status) {
  return ({
    SCHEDULED: "Horaire convenu · attente du compte rendu patient",
    AWAITING_PROVIDER_CODE: "Patient confirmé · code de clôture requis",
    ADMIN_REVIEW_REQUIRED: "Vérification NEXA requise",
    CASH_REFUND_PENDING: "Demande d’espèces transmise à NEXA",
    REFUND_PENDING_ADMIN: "Remboursement de la période autorisé · traitement admin en attente",
    COMPLETED: "Prestation clôturée par code patient",
  })[status] || "État à vérifier auprès de NEXA";
}

function renderNursingVisit(visit) {
  const item = document.createElement("li");
  item.className = "nursing-visit-card";
  item.append(
    makeNursingText("strong", "", nursingVisitDate(visit.scheduledAt)),
    makeNursingText("span", "nursing-visit-card__status", nursingVisitStatus(visit.status)),
    makeNursingText("span", "", Array.isArray(visit.serviceLabels) ? visit.serviceLabels.join(" · ") : ""),
  );
  if (visit.status === "AWAITING_PROVIDER_CODE") {
    const form = document.createElement("form");
    form.className = "nursing-visit-code-form";
    const careServices = document.createElement("fieldset");
    careServices.className = "nursing-visit-code-form__services";
    careServices.append(makeNursingText("legend", "", "Soins réellement effectués"));
    const serviceIds = Array.isArray(visit.serviceIds) ? visit.serviceIds : [];
    const serviceLabels = Array.isArray(visit.serviceLabels) ? visit.serviceLabels : [];
    serviceIds.forEach((serviceId, index) => {
      const serviceInput = document.createElement("input");
      serviceInput.type = "checkbox";
      serviceInput.name = "careServiceId";
      serviceInput.value = serviceId;
      const serviceLabel = document.createElement("label");
      serviceLabel.append(serviceInput, document.createTextNode(" " + (serviceLabels[index] || serviceId)));
      careServices.append(serviceLabel);
    });
    const careSummary = document.createElement("textarea");
    careSummary.name = "careSummary";
    careSummary.minLength = 10;
    careSummary.maxLength = 3_000;
    careSummary.rows = 5;
    careSummary.required = true;
    careSummary.setAttribute("aria-label", "Compte rendu des soins et observations");
    const careSummaryLabel = document.createElement("label");
    careSummaryLabel.append(
      document.createTextNode("Compte rendu des soins et observations "),
      careSummary,
      makeNursingText("small", "", "Indiquez les actes effectués et les observations utiles. Une ordonnance ne peut pas être créée depuis l’espace infirmier."),
    );
    const label = document.createElement("label");
    label.append(document.createTextNode("Code remis par le patient "));
    const input = document.createElement("input");
    input.name = "code";
    input.type = "text";
    input.inputMode = "numeric";
    input.pattern = "[0-9]{8}";
    input.maxLength = 8;
    input.required = true;
    input.autocomplete = "one-time-code";
    input.setAttribute("aria-label", "Code patient à huit chiffres");
    label.append(input);
    const message = makeNursingText("p", "nursing-visit-card__message", "");
    message.setAttribute("role", "status");
    const button = document.createElement("button");
    button.type = "submit";
    button.className = "nursing-button nursing-button--quiet";
    button.textContent = "Enregistrer les soins et clôturer cette prestation";
    form.append(careServices, careSummaryLabel, label, button, message);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!currentUser) return;
      button.disabled = true;
      message.textContent = "Enregistrement du compte rendu et vérification du code…";
      try {
        const careServiceIds = [...careServices.querySelectorAll('input[name="careServiceId"]:checked')].map((checkbox) => checkbox.value);
        await requestNexaFunction(currentUser, "nexaNursingVisitClose", "POST", {
          visitId: visit.visitId, code: input.value.trim(), careServiceIds, careSummary: careSummary.value,
        });
        message.textContent = "Compte rendu signé et enregistré. La prestation est clôturée.";
        await loadNursingOrders();
      } catch (error) {
        message.textContent = error.message || "La prestation ne peut pas être clôturée pour le moment.";
        button.disabled = false;
      }
    });
    item.append(form);
  } else if (visit.status === "COMPLETED") {
    item.append(renderNursingCareRecordButton(visit));
  }
  return item;
}

function renderNursingCareRecordButton(visit) {
  const button = makeNursingText("button", "nursing-button nursing-button--quiet", "Consulter mon compte rendu de soins");
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div");
  panel.className = "nursing-visit-card__clinical-record";
  panel.hidden = true;
  panel.id = `nursing-care-record-${visit.visitId}`;
  button.setAttribute("aria-controls", panel.id);
  button.addEventListener("click", async () => {
    if (!currentUser || button.disabled) return;
    if (!panel.hidden && panel.dataset.loaded === "true") {
      panel.hidden = true;
      panel.replaceChildren();
      delete panel.dataset.loaded;
      button.setAttribute("aria-expanded", "false");
      button.textContent = "Consulter mon compte rendu de soins";
      return;
    }
    const user = currentUser;
    button.disabled = true;
    button.textContent = "Chargement du compte rendu…";
    button.setAttribute("aria-expanded", "true");
    panel.hidden = false;
    panel.replaceChildren(makeNursingText("p", "nursing-visit-card__message", "Vérification de votre accès…"));
    try {
      const result = await requestNexaFunction(user, "nexaNursingCareRecord", "GET", undefined, { visitId: visit.visitId });
      if (currentUser !== user) return;
      if (!result.record || result.record.visitId !== visit.visitId) throw new Error("nursing-care-record-invalid");
      const record = result.record;
      const services = Array.isArray(record.performedServiceLabels) ? record.performedServiceLabels.filter(Boolean) : [];
      panel.replaceChildren(
        makeNursingText("strong", "", "Compte rendu signé"),
        ...(services.length ? [makeNursingText("p", "", `Soins consignés : ${services.join(" · ")}`)] : []),
        makeNursingText("p", "nursing-visit-card__clinical-note", record.summary || "Aucun détail n’est enregistré."),
        makeNursingText("small", "", `Signé par ${record.providerName || "votre compte infirmier"}${record.signedAt ? ` · ${nursingVisitDate(record.signedAt)}` : ""}`),
      );
      panel.dataset.loaded = "true";
      button.textContent = "Masquer le compte rendu de soins";
    } catch (error) {
      if (currentUser !== user) return;
      panel.replaceChildren(makeNursingText("p", "nursing-visit-card__message", error.message || "Le compte rendu n’est pas accessible pour le moment."));
      delete panel.dataset.loaded;
      button.textContent = "Réessayer d’ouvrir le compte rendu";
    } finally {
      if (currentUser === user) button.disabled = false;
    }
  });
  const container = document.createElement("div");
  container.append(button, panel);
  return container;
}

function renderNursingVisitPlanForm(order) {
  const booking = order.booking || {};
  const form = document.createElement("form");
  form.className = "nursing-visit-plan-form";
  form.append(
    makeNursingText("h4", "nursing-order-card__subheading", "Enregistrer un horaire convenu"),
    makeNursingText("p", "nursing-order-card__hint", "Après entente avec le patient, inscrivez une prestation dans la période réservée. La date est vérifiée par NEXA en heure locale d’Haïti."),
  );
  const dateLabel = document.createElement("label");
  dateLabel.append(document.createTextNode("Date et heure convenues · heure d’Haïti "));
  const dateInput = document.createElement("input");
  dateInput.type = "datetime-local";
  dateInput.name = "scheduledLocal";
  dateInput.required = true;
  dateLabel.append(dateInput);
  const servicesFieldset = document.createElement("fieldset");
  const legend = makeNursingText("legend", "", "Soins prévus lors de cette visite");
  servicesFieldset.append(legend);
  const serviceChoices = document.createElement("div");
  serviceChoices.className = "nursing-visit-service-choices";
  (Array.isArray(booking.services) ? booking.services : []).forEach((service) => {
    if (!service?.id || !service?.label) return;
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "serviceId";
    input.value = service.id;
    label.append(input, document.createTextNode(service.label));
    serviceChoices.append(label);
  });
  servicesFieldset.append(serviceChoices);
  const message = makeNursingText("p", "nursing-visit-card__message", "");
  message.setAttribute("role", "status");
  const button = document.createElement("button");
  button.type = "submit";
  button.className = "nursing-button nursing-button--quiet";
  button.textContent = "Enregistrer la prestation convenue";
  form.append(dateLabel, servicesFieldset, button, message);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!currentUser) return;
    const serviceIds = [...form.querySelectorAll('input[name="serviceId"]:checked')].map((input) => input.value);
    if (!serviceIds.length) {
      message.textContent = "Choisissez au moins un soin prévu pendant cette visite.";
      return;
    }
    button.disabled = true;
    message.textContent = "Enregistrement de l’horaire convenu…";
    try {
      const result = await requestNexaFunction(currentUser, "nexaNursingVisitPlan", "POST", {
        orderId: order.id, scheduledLocal: dateInput.value, serviceIds, requestId: window.crypto.randomUUID(),
      });
      const selectedLabels = [...form.querySelectorAll('input[name="serviceId"]:checked')].map((input) =>
        input.closest("label")?.textContent?.trim() || input.value);
      cacheNursingVisit({
        visitId: result.visitId, orderId: order.id, orderNumber: result.orderNumber || order.orderNumber,
        patientNumber: order.patientNumber, patientName: order.patientName,
        patientPhone: booking.phone || order.patientPhone,
        addressLine: booking.addressLine, commune: booking.commune, department: booking.department,
        weekStart: booking.weekStart, periodLabel: booking.periodLabel,
        bookingModeDescription: booking.bookingModeDescription,
        serviceIds, serviceLabels: selectedLabels,
        scheduledAt: result.scheduledAt, status: result.status,
      });
      form.reset();
      message.textContent = "La prestation convenue a été enregistrée.";
      button.disabled = false;
    } catch (error) {
      message.textContent = error.message || "La visite ne peut pas être enregistrée pour le moment.";
      button.disabled = false;
    }
  });
  return form;
}

async function loadNursingOrders(user = currentUser, append = false) {
  if (!user || (append && (!nursingOrdersHasMore || nursingOrdersLoading || !nursingOrdersCursor))) return;
  const generation = append ? nursingOrdersGeneration : ++nursingOrdersGeneration;
  nursingOrdersLoading = true;
  if (!append) {
    nursingOrdersCursor = "";
    nursingOrdersHasMore = false;
    elements.ordersList.replaceChildren();
    elements.ordersMore.hidden = true;
    elements.ordersMore.disabled = false;
    elements.ordersRetry.hidden = true;
  } else {
    elements.ordersMore.disabled = true;
    elements.ordersLoading.textContent = "Chargement des réservations plus anciennes…";
  }
  if (!append) elements.ordersLoading.textContent = "Chargement des réservations…";
  elements.ordersLoading.hidden = false;
  elements.ordersError.hidden = true;
  elements.ordersEmpty.hidden = true;
  try {
    const result = await requestNexaFunction(user, "nexaNursingProviderOrders", "GET", undefined,
      append ? { cursor: nursingOrdersCursor } : undefined);
    if (generation !== nursingOrdersGeneration || currentUser !== user) return;
    const pageHasMore = result.hasMore === true && typeof result.nextCursor === "string" && result.nextCursor.length > 0;
    const pageCursor = pageHasMore ? result.nextCursor : "";
    const orders = Array.isArray(result.orders) ? result.orders : [];
    const pageOrders = orders.map((order) => ({
      ...order, visits: visitsForNursingOrder(order.id),
    }));
    elements.ordersLoading.hidden = true;
    nursingOrdersHasMore = pageHasMore;
    nursingOrdersCursor = pageCursor;
    if (!pageOrders.length && !append && !nursingOrdersHasMore) {
      elements.ordersEmpty.hidden = false;
      elements.ordersMore.hidden = true;
      return;
    }
    if (append) elements.ordersList.append(...pageOrders.map(renderNursingOrder));
    else elements.ordersList.replaceChildren(...pageOrders.map(renderNursingOrder));
    elements.ordersMore.hidden = !nursingOrdersHasMore;
  } catch (error) {
    if (generation !== nursingOrdersGeneration || currentUser !== user) return;
    elements.ordersLoading.hidden = true;
    elements.ordersError.textContent = error.message || "Les réservations ne peuvent pas être chargées pour le moment.";
    elements.ordersError.hidden = false;
    elements.ordersRetry.hidden = append;
    elements.ordersMore.hidden = !append || !nursingOrdersCursor;
  } finally {
    if (generation === nursingOrdersGeneration && currentUser === user) {
      nursingOrdersLoading = false;
      elements.ordersMore.disabled = false;
      elements.ordersMore.textContent = "Afficher les réservations plus anciennes";
    }
  }
}

async function loadNursingVisits(user = currentUser, append = false) {
  if (!user || (append && (!nursingVisitsHasMore || nursingVisitsLoading || !nursingVisitsCursor))) return;
  const generation = append ? nursingVisitsGeneration : ++nursingVisitsGeneration;
  nursingVisitsLoading = true;
  if (!append) {
    nursingVisitsCursor = "";
    nursingVisitsHasMore = false;
    nursingVisitsByOrder.clear();
    elements.visitsMore.hidden = true;
    elements.visitsRetry.hidden = true;
    elements.visitsRetry.disabled = false;
  } else {
    elements.visitsMore.disabled = true;
  }
  elements.visitsLoading.textContent = append ? "Chargement des prestations suivantes…" : "Chargement des prestations planifiées…";
  elements.visitsLoading.hidden = false;
  elements.visitsError.hidden = true;
  try {
    const result = await requestNexaFunction(user, "nexaNursingVisitPlan", "GET", undefined,
      append ? { cursor: nursingVisitsCursor } : undefined);
    if (generation !== nursingVisitsGeneration || currentUser !== user) return;
    const pageHasMore = result.hasMore === true && typeof result.nextCursor === "string" && result.nextCursor.length > 0;
    nursingVisitsCursor = pageHasMore ? result.nextCursor : "";
    nursingVisitsHasMore = pageHasMore;
    for (const visit of Array.isArray(result.visits) ? result.visits : []) cacheNursingVisit(visit);
    elements.visitsLoading.hidden = true;
    elements.visitsMore.hidden = !nursingVisitsHasMore;
    elements.visitsRetry.hidden = true;
  } catch (error) {
    if (generation !== nursingVisitsGeneration || currentUser !== user) return;
    elements.visitsLoading.hidden = true;
    elements.visitsError.textContent = error.message || "Les prestations planifiées ne peuvent pas être chargées pour le moment.";
    elements.visitsError.hidden = false;
    elements.visitsRetry.hidden = append || Boolean(nursingVisitsCursor);
    elements.visitsMore.hidden = !append || !nursingVisitsCursor;
    if (append && nursingVisitsCursor) elements.visitsMore.textContent = "Réessayer de charger les prestations";
  } finally {
    if (generation === nursingVisitsGeneration && currentUser === user) {
      nursingVisitsLoading = false;
      elements.visitsMore.disabled = false;
      elements.visitsMore.textContent = "Afficher les prestations suivantes";
    }
  }
}

elements.photoUpload.addEventListener("click", async () => {
  showMessage(elements.photoMessage, "");
  if (!currentUser) return;
  const file = elements.photoFile.files?.[0];
  if (!file) {
    showMessage(elements.photoMessage, "Choisissez d’abord une photo.");
    return;
  }
  if (!elements.photoConsent.checked) {
    showMessage(elements.photoMessage, "Confirmez que cette photo pourra apparaître publiquement après approbation NEXA.");
    return;
  }
  elements.photoUpload.disabled = true;
  elements.photoUpload.textContent = "Préparation et analyse…";
  try {
    const photoBase64 = await profilePhotoBase64(file);
    const result = await requestNexaFunction(currentUser, "nexaNursingProfilePhoto", "POST", {
      photoBase64,
      consentToPublicDisplay: true,
    });
    renderNursingPhoto({ ...result, consentToPublicDisplay: true });
    elements.photoFile.value = "";
  } catch (error) {
    showMessage(elements.photoMessage, error.message || "La photo ne peut pas être envoyée pour le moment.");
  } finally {
    elements.photoUpload.disabled = false;
    elements.photoUpload.textContent = "Téléverser la photo";
  }
});

elements.addWeek.addEventListener("click", () => {
  showMessage(elements.error, "");
  showMessage(elements.notice, "");
  const weekStart = elements.weekStart.value;
  const periods = selectedValues("weekPeriod");
  if (!weekStart || periods.length === 0) {
    showMessage(elements.error, "Choisissez un lundi et au moins une période de travail.");
    return;
  }
  const date = new Date(`${weekStart}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.getUTCDay() !== 1) {
    showMessage(elements.error, "La semaine doit commencer un lundi.");
    return;
  }
  profile.weeklyAvailability = [...profile.weeklyAvailability.filter((week) => week.weekStart !== weekStart), { weekStart, periods }]
    .sort((left, right) => left.weekStart.localeCompare(right.weekStart));
  elements.weekStart.value = "";
  document.querySelectorAll('input[name="weekPeriod"]').forEach((input) => { input.checked = false; });
  renderWeeks();
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage(elements.error, "");
  showMessage(elements.notice, "");
  if (!currentUser) return;
  elements.save.disabled = true;
  elements.save.textContent = "Enregistrement…";
  try {
    profile = {
      experienceStartYear: Number(elements.year.value),
      serviceIds: selectedValues("serviceId"),
      zoneIds: selectedValues("zoneId"),
      weeklyAvailability: profile.weeklyAvailability,
    };
    const result = await requestNexaFunction(currentUser, "nexaNursingServiceProfile", "POST", profile);
    profile = result.profile;
    updateStatus(result.serviceProfileStatus);
    showMessage(elements.reason, "");
    showMessage(elements.notice, result.message || "Profil enregistré.");
  } catch (error) {
    showMessage(elements.error, error.message || "Le profil infirmier n’a pas pu être enregistré.");
  } finally {
    elements.save.disabled = zones.filter((zone) => zone.active !== false).length === 0;
    elements.save.textContent = "Enregistrer mon profil infirmier";
  }
});
elements.ordersRetry.addEventListener("click", () => { void loadNursingOrders(); });
elements.ordersMore.addEventListener("click", () => { void loadNursingOrders(currentUser, true); });
elements.visitsRetry.addEventListener("click", () => { void loadNursingVisits(currentUser, Boolean(nursingVisitsCursor)); });
elements.visitsMore.addEventListener("click", () => { void loadNursingVisits(currentUser, true); });

firebaseAuthActions.onAuthStateChanged(auth, (user) => {
  if (!user) {
    currentUser = null;
    nursingVisitsGeneration += 1;
    nursingVisitsByOrder.clear();
    elements.ordersList.replaceChildren();
    elements.visitsLoading.hidden = true;
    elements.visitsError.hidden = true;
    elements.visitsRetry.hidden = true;
    elements.visitsMore.hidden = true;
    elements.loading.hidden = true;
    elements.login.hidden = false;
    elements.denied.hidden = true;
    elements.editor.hidden = true;
    return;
  }
  void loadProfile(user);
});
