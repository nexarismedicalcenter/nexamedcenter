import { auth, downloadNexaPdf, firebaseAuthActions, getAppCheckToken, requestNexaFunction, uploadNexaClinicalAttachment, NexaApiError } from "./firebase-client.js";

const loading = document.querySelector("#provider-loading");
const loginPanel = document.querySelector("#provider-login");
const loginForm = document.querySelector("#provider-login-form");
const loginError = document.querySelector("#provider-login-error");
const loginButton = document.querySelector("#provider-login-submit");
const passwordResetButton = document.querySelector("#provider-password-reset");
const passwordResetNotice = document.querySelector("#provider-reset-notice");
const emailInput = document.querySelector("#provider-email");
const deniedPanel = document.querySelector("#provider-denied");
const deniedMessage = document.querySelector("#provider-denied-message");
const editor = document.querySelector("#provider-editor");
const providerName = document.querySelector("#provider-name");
const signOutButton = document.querySelector("#provider-sign-out");
const profilePhotoFile = document.querySelector("#provider-photo-file");
const profilePhotoConsent = document.querySelector("#provider-photo-consent");
const profilePhotoUploadButton = document.querySelector("#provider-photo-upload");
const profilePhotoPreview = document.querySelector("#provider-photo-preview");
const profilePhotoStatus = document.querySelector("#provider-photo-status");
const profilePhotoError = document.querySelector("#provider-photo-error");
const notice = document.querySelector("#provider-notice");
const errorBox = document.querySelector("#provider-error");
const providerNotificationsLoading = document.querySelector("#provider-notifications-loading");
const providerNotificationsError = document.querySelector("#provider-notifications-error");
const providerNotificationsEmpty = document.querySelector("#provider-notifications-empty");
const providerNotificationsList = document.querySelector("#provider-notifications-list");
const providerNotificationsReloadButton = document.querySelector("#provider-notifications-reload");
const availabilityForm = document.querySelector("#availability-form");
const serviceSelect = document.querySelector("#availability-service");
const homeVisitOption = document.querySelector("#home-visit-option");
const homeVisitNote = document.querySelector("#home-visit-note");
const startsAtInput = document.querySelector("#availability-start");
const submitButton = document.querySelector("#availability-submit");
const slotsLoading = document.querySelector("#availability-loading");
const slotsEmpty = document.querySelector("#availability-empty");
const slotsList = document.querySelector("#availability-list");
const reloadButton = document.querySelector("#availability-reload");
const appointmentsLoading = document.querySelector("#appointments-loading");
const appointmentsError = document.querySelector("#appointments-error");
const appointmentsEmpty = document.querySelector("#appointments-empty");
const appointmentsList = document.querySelector("#appointments-list");
const appointmentsReloadButton = document.querySelector("#appointments-reload");
const standaloneRecordForm = document.querySelector("#standalone-record-form");
const standalonePatientNumber = document.querySelector("#standalone-patient-number");
const standaloneAccessCode = document.querySelector("#standalone-access-code");
const standaloneRecordSubmit = document.querySelector("#standalone-record-submit");
const standaloneRecordFeedback = document.querySelector("#standalone-record-feedback");
const standaloneRecordError = document.querySelector("#standalone-record-error");
const standaloneRecordsLoading = document.querySelector("#standalone-records-loading");
const standaloneRecordsEmpty = document.querySelector("#standalone-records-empty");
const standaloneRecordsList = document.querySelector("#standalone-records-list");
const standaloneRecordsReloadButton = document.querySelector("#standalone-records-reload");
const providerResultsLoading = document.querySelector("#provider-results-loading");
const providerResultsError = document.querySelector("#provider-results-error");
const providerResultsEmpty = document.querySelector("#provider-results-empty");
const providerResultsList = document.querySelector("#provider-results-list");
const providerResultsReloadButton = document.querySelector("#provider-results-reload");
const haitiTime = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Port-au-Prince", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

let currentUser = null;
let busy = false;
let authGeneration = 0;
let profilePhotoPreviewObjectUrl = "";
let providerNotifications = [];
let providerNotificationsRequestUser = null;

function clearProviderPrivateState() {
  slotsList.replaceChildren();
  appointmentsList.replaceChildren();
  standaloneRecordsList.replaceChildren();
  providerResultsList.replaceChildren();
  providerNotificationsList.replaceChildren();
  providerNotifications = [];
  providerNotificationsRequestUser = null;
  standaloneAccessCode.value = "";
  standalonePatientNumber.value = "";
  providerName.textContent = "Médecin NEXA";
  profilePhotoFile.value = "";
  profilePhotoConsent.checked = false;
  profilePhotoPreview.removeAttribute("src");
  profilePhotoPreview.hidden = true;
  profilePhotoStatus.textContent = "Aucune photo déposée.";
  profilePhotoError.hidden = true;
  if (profilePhotoPreviewObjectUrl) URL.revokeObjectURL(profilePhotoPreviewObjectUrl);
  profilePhotoPreviewObjectUrl = "";
  appointmentsLoading.hidden = true;
  appointmentsError.hidden = true;
  appointmentsEmpty.hidden = true;
  standaloneRecordFeedback.hidden = true;
  standaloneRecordError.hidden = true;
  standaloneRecordsLoading.hidden = true;
  standaloneRecordsEmpty.hidden = true;
  standaloneRecordSubmit.disabled = false;
  standaloneRecordsReloadButton.disabled = false;
  providerResultsLoading.hidden = true;
  providerResultsError.hidden = true;
  providerResultsEmpty.hidden = true;
  providerNotificationsLoading.hidden = true;
  providerNotificationsError.hidden = true;
  providerNotificationsEmpty.hidden = true;
  slotsLoading.hidden = true;
  slotsEmpty.hidden = true;
  showMessage(notice, "");
  showMessage(errorBox, "");
}

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

function providerNotificationDate(value) {
  const date = new Date(value);
  return !value || Number.isNaN(date.getTime())
    ? "Date indisponible"
    : new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(date);
}

function renderProviderNotification(notification) {
  const item = document.createElement("li");
  item.className = "nexa-provider-notification" + (notification.read ? "" : " is-unread");
  const content = document.createElement("div");
  content.append(
    makeText("strong", "", notification.title || "Notification NEXA"),
    makeText("p", "nexa-provider-notification__body", notification.body || "Une mise à jour est disponible."),
  );
  const time = document.createElement("time");
  time.dateTime = notification.createdAt || "";
  time.textContent = providerNotificationDate(notification.createdAt);
  item.append(content, time);
  const actions = document.createElement("div");
  actions.className = "nexa-provider-notification__actions";
  const openLink = document.createElement("a");
  openLink.className = "nexa-provider-link";
  openLink.textContent = "Ouvrir";
  try {
    const basePath = new URL("./", window.location.href);
    const path = typeof notification.url === "string" && notification.url.startsWith("/")
      ? notification.url.slice(1)
      : "espace-professionnel.html";
    const destination = new URL(path, basePath);
    if (destination.origin !== window.location.origin) throw new Error("external-notification-link");
    openLink.href = destination.href;
  } catch {
    openLink.href = "./espace-professionnel.html";
  }
  actions.append(openLink);
  if (!notification.read) {
    const markRead = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Marquer comme lue");
    markRead.type = "button";
    markRead.addEventListener("click", () => { void markProviderNotificationRead(notification.id, markRead); });
    actions.append(markRead);
  }
  item.append(actions);
  return item;
}

function renderProviderNotifications(notifications) {
  providerNotificationsList.replaceChildren(...notifications.map(renderProviderNotification));
  providerNotificationsEmpty.hidden = notifications.length > 0;
}

async function loadProviderNotifications({ silent = false } = {}) {
  if (!currentUser || providerNotificationsRequestUser === currentUser) return;
  const generation = authGeneration;
  const user = currentUser;
  providerNotificationsRequestUser = user;
  if (!silent) providerNotificationsLoading.hidden = false;
  providerNotificationsError.hidden = true;
  providerNotificationsEmpty.hidden = true;
  providerNotificationsReloadButton.disabled = true;
  try {
    const result = await requestNexaFunction(user, "nexaUserNotifications");
    if (generation !== authGeneration || currentUser !== user) return;
    providerNotifications = Array.isArray(result.notifications) ? result.notifications : [];
    renderProviderNotifications(providerNotifications);
  } catch (error) {
    if (generation !== authGeneration || currentUser !== user) return;
    providerNotificationsError.textContent = error instanceof NexaApiError
      ? error.message
      : "Les notifications ne peuvent pas être chargées pour le moment.";
    providerNotificationsError.hidden = false;
  } finally {
    if (providerNotificationsRequestUser === user) {
      providerNotificationsRequestUser = null;
      if (generation === authGeneration) {
        providerNotificationsLoading.hidden = true;
        providerNotificationsReloadButton.disabled = false;
      }
    }
  }
}

async function markProviderNotificationRead(id, button) {
  if (!currentUser || !id) return;
  const generation = authGeneration;
  const user = currentUser;
  button.disabled = true;
  try {
    await requestNexaFunction(user, "nexaUserNotifications", "POST", { id });
    if (generation !== authGeneration || currentUser !== user) return;
    providerNotifications = providerNotifications.map((notification) => notification.id === id
      ? { ...notification, read: true }
      : notification);
    renderProviderNotifications(providerNotifications);
  } catch (error) {
    if (generation !== authGeneration || currentUser !== user) return;
    providerNotificationsError.textContent = error instanceof NexaApiError
      ? error.message
      : "Cette notification ne peut pas être marquée comme lue.";
    providerNotificationsError.hidden = false;
    button.disabled = false;
  }
}

function renderDoctorProfilePhoto(result) {
  if (profilePhotoPreviewObjectUrl) URL.revokeObjectURL(profilePhotoPreviewObjectUrl);
  profilePhotoPreviewObjectUrl = "";
  const photoUrl = typeof result?.photoUrl === "string" && result.photoUrl.startsWith("https://") ? result.photoUrl : "";
  if (photoUrl) {
    profilePhotoPreview.src = photoUrl;
    profilePhotoPreview.hidden = false;
  } else {
    profilePhotoPreview.removeAttribute("src");
    profilePhotoPreview.hidden = true;
  }
  profilePhotoConsent.checked = result?.consentToPublicDisplay === true || result?.photoStatus === "PENDING_REVIEW" || result?.photoStatus === "APPROVED";
  profilePhotoStatus.textContent = result?.photoStatus === "APPROVED"
    ? "Photo approuvée et visible dans le répertoire NEXA."
    : result?.photoStatus === "PENDING_REVIEW"
      ? "Photo reçue; le profil reste masqué jusqu’à l’approbation NEXA."
      : result?.photoStatus === "REJECTED"
        ? "La photo a été refusée. Déposez une nouvelle image après correction."
        : "Aucune photo déposée.";
}

async function doctorPhotoBase64(file) {
  if (!file || file.size > 5 * 1024 * 1024) throw new Error("Choisissez une photo de 5 Mio maximum.");
  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("Cette image ne peut pas être lue. Choisissez un JPEG, PNG ou WebP."); }
  const scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Le navigateur ne peut pas préparer cette image.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
  if (!blob || blob.size > 1_000_000) throw new Error("Cette photo ne peut pas être réduite sous la taille permise.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function loadDoctorProfilePhoto(user) {
  if (!user) return;
  const generation = authGeneration;
  try {
    const result = await requestNexaFunction(user, "nexaDoctorProfilePhoto", "GET");
    if (generation !== authGeneration || currentUser !== user) return;
    renderDoctorProfilePhoto(result);
  } catch (error) {
    if (generation !== authGeneration || currentUser !== user) return;
    profilePhotoError.textContent = error instanceof NexaApiError ? error.message : "Le statut de votre photo n’est pas accessible.";
    profilePhotoError.hidden = false;
  }
}

function haitiParts(date) {
  return Object.fromEntries(haitiTime.formatToParts(date).map((part) => [part.type, part.value]));
}

function haitiLocalValue(date) {
  const parts = haitiParts(date);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function nextHalfHour(date) {
  const rounded = new Date(date.getTime() + 30 * 60_000);
  rounded.setUTCSeconds(0, 0);
  const remainder = rounded.getUTCMinutes() % 30;
  if (remainder) rounded.setUTCMinutes(rounded.getUTCMinutes() + 30 - remainder);
  return rounded;
}

function setDateBounds() {
  const now = Date.now();
  startsAtInput.min = haitiLocalValue(nextHalfHour(new Date(now)));
  startsAtInput.max = haitiLocalValue(new Date(now + 90 * 24 * 60 * 60_000));
}

function haitiLocalToIso(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const target = Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText), Number(hourText), Number(minuteText));
  if (!Number.isFinite(target)) return null;
  let instant = target;
  for (let index = 0; index < 4; index += 1) {
    const parts = haitiParts(new Date(instant));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    const difference = target - represented;
    if (difference === 0) break;
    instant += difference;
  }
  const date = new Date(instant);
  return haitiLocalValue(date) === value ? date.toISOString() : null;
}

function slotDate(value) {
  const date = new Date(value);
  return !value || Number.isNaN(date.getTime())
    ? "Horaire indisponible"
    : new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "full", timeStyle: "short" }).format(date);
}

function statusLabel(status) {
  return status === "available" ? "Disponible" : status === "held" ? "Réservation temporaire" : status === "booked" ? "Réservé" : "État à vérifier";
}

const appointmentStatusLabels = {
  PENDING_PAYMENT: "Paiement en attente",
  CONFIRMED: "Payé · en attente d’acceptation",
  DOCTOR_ACCEPTED: "Accepté · salle vidéo accessible à l’heure prévue",
  IN_PROGRESS: "Séance démarrée",
  COMPLETED: "Terminé",
  REFUNDED: "Remboursé au patient",
  PROVIDER_REFUSED: "Refusée · remboursement crédité au patient",
  PAYMENT_EXPIRED: "Réservation expirée",
  PAYMENT_CONFLICT_REFUND_REQUIRED: "Paiement à rapprocher avec NEXA",
  PROVIDER_NO_SHOW_REFUND_REQUIRED: "Absence signalée · suivi NEXA requis",
  PATIENT_NO_SHOW_RETAINED: "Séance manquée",
};

const homeVisitMissionLabels = {
  AWAITING_PAYMENT: "En attente de paiement",
  SCHEDULED: "Payée · visite à réaliser",
  AWAITING_PROVIDER_CODE: "Confirmation reçue · clôture du médecin en attente",
  ADMIN_REVIEW_REQUIRED: "Vérification NEXA requise",
  PROVIDER_ABSENT_REFUND_REQUIRED: "Absence signalée · suivi NEXA requis",
  REFUNDED: "Prix du service remboursé",
  COMPLETED: "Mission clôturée",
};

const homeVisitServiceLabels = {
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

function formatMoney(amount) {
  return `${new Intl.NumberFormat("fr-HT").format(Number.isSafeInteger(amount) ? amount : 0)} HTG`;
}

const medicalLanguageLabels = {
  creole: "Créole haïtien",
  french: "Français",
  english: "Anglais",
  spanish: "Espagnol",
};
const haitiCalendar = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Port-au-Prince", year: "numeric", month: "2-digit", day: "2-digit",
});

function ageFromBirthDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const [, yearText, monthText, dayText] = match;
  const birth = { year: Number(yearText), month: Number(monthText), day: Number(dayText) };
  const check = new Date(Date.UTC(birth.year, birth.month - 1, birth.day));
  if (check.getUTCFullYear() !== birth.year || check.getUTCMonth() + 1 !== birth.month || check.getUTCDate() !== birth.day) return "";
  const today = Object.fromEntries(haitiCalendar.formatToParts(new Date()).map((part) => [part.type, Number(part.value)]));
  if (birth.year > today.year || (birth.year === today.year && (birth.month > today.month || (birth.month === today.month && birth.day > today.day)))) return "";
  const age = today.year - birth.year - (today.month < birth.month || (today.month === birth.month && today.day < birth.day) ? 1 : 0);
  return `${age} ${age === 1 ? "an" : "ans"}`;
}

function appendMedicalFact(list, label, value) {
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  description.textContent = value || "Non renseigné";
  list.append(term, description);
}

function medicalYesNo(value, detailLabel) {
  if (!value || typeof value !== "object") return "Non renseigné";
  const answer = value.yes === true ? "Oui" : "Non";
  const details = typeof value.details === "string" ? value.details.trim() : "";
  return value.yes === true && details ? `${answer} · ${detailLabel} : ${details}` : answer;
}

function medicalCondition(value) {
  if (!value || typeof value !== "object") return "Non renseigné";
  if (value.diagnosed !== true) return "Non";
  return value.sinceMonth ? `Oui · depuis ${value.sinceMonth}` : "Oui · date non renseignée";
}

function renderMedicalProfile(container, result) {
  container.replaceChildren();
  const identity = result.patientIdentity || {};
  const profile = result.patientMedicalProfile;
  const heading = document.createElement("h4");
  heading.textContent = [identity.firstName, identity.lastName].filter(Boolean).join(" ") || "Patient NEXA";
  const accessUntil = document.createElement("p");
  accessUntil.className = "nexa-provider-clinical__notice";
  accessUntil.textContent = `Accès clinique autorisé jusqu’au ${slotDate(result.clinicalAccessExpiresAt)}.`;
  const list = document.createElement("dl");
  list.className = "nexa-provider-clinical__facts";
  appendMedicalFact(list, "Date de naissance", identity.birthDate || "");
  appendMedicalFact(list, "Âge", ageFromBirthDate(identity.birthDate));
  appendMedicalFact(list, "Sexe", identity.sex || "");

  if (!profile) {
    const empty = document.createElement("p");
    empty.className = "nexa-provider-clinical__notice";
    empty.textContent = "Le patient n’a pas encore enregistré sa fiche médicale initiale.";
    container.append(heading, accessUntil, list, empty);
    return;
  }

  const languages = Array.isArray(profile.languages)
    ? profile.languages.map((language) => medicalLanguageLabels[language]).filter(Boolean).join(", ")
    : "";
  appendMedicalFact(list, "Langues préférées", languages);
  appendMedicalFact(list, "Allergies", medicalYesNo(profile.allergies, "détails"));
  appendMedicalFact(list, "Diabète", medicalCondition(profile.diabetes));
  appendMedicalFact(list, "Hypertension", medicalCondition(profile.hypertension));
  appendMedicalFact(list, "Tabac", medicalYesNo(profile.tobacco, "fréquence"));
  appendMedicalFact(list, "Alcool", medicalYesNo(profile.alcohol, "fréquence"));
  appendMedicalFact(list, "Café", medicalYesNo(profile.coffee, "quantité"));
  appendMedicalFact(list, "Thé", medicalYesNo(profile.tea, "quantité"));
  if (profile.updatedAt) {
    const updated = document.createElement("p");
    updated.className = "nexa-provider-clinical__notice";
    updated.textContent = `Fiche mise à jour le ${slotDate(profile.updatedAt)}.`;
    container.append(heading, accessUntil, list, updated);
  } else {
    container.append(heading, accessUntil, list);
  }
}

function canOpenClinicalProfile(appointment) {
  if (appointment.paymentStatus !== "PAID") return false;
  if (appointment.bookingType === "home_visit") {
    return appointment.clinicalAccessActive === true || (appointment.status === "COMPLETED" && appointment.homeVisitMissionStatus === "COMPLETED");
  }
  return appointment.clinicalAccessActive === true || ["IN_PROGRESS", "COMPLETED"].includes(appointment.status);
}

const clinicalFieldLabels = {
  consultationReason: "Motif de consultation",
  history: "Histoire de la maladie",
  relevantHistory: "Antécédents pertinents",
  allergies: "Allergies",
  currentTreatments: "Traitements actuels",
  symptoms: "Symptômes rapportés",
  clinicalObservations: "Observations cliniques",
  clinicalAssessment: "Évaluation clinique",
  diagnoses: "Diagnostics",
  carePlan: "Conduite à tenir",
  recommendations: "Recommandations",
  followUp: "Suivi recommandé",
  additionalNotes: "Notes complémentaires",
};

const vitalLabels = {
  systolic: "Tension systolique (mmHg)", diastolic: "Tension diastolique (mmHg)",
  heartRate: "Fréquence cardiaque (bpm)", respiratoryRate: "Fréquence respiratoire (/min)",
  spo2: "Saturation en oxygène (%)", glycemia: "Glycémie capillaire",
  temperature: "Température (°C)", weight: "Poids (kg)", height: "Taille (cm)",
};

const priorClinicalFieldLabels = {
  consultationReason: "Motif de consultation",
  relevantHistory: "Antécédents pertinents",
  allergies: "Allergies",
  currentTreatments: "Traitements actuels",
  symptoms: "Symptômes rapportés",
  history: "Histoire de la maladie",
  clinicalObservations: "Observations cliniques",
  clinicalAssessment: "Évaluation clinique",
  diagnoses: "Diagnostics",
  carePlan: "Conduite à tenir",
  recommendations: "Recommandations",
  followUp: "Suivi recommandé",
  additionalNotes: "Notes complémentaires",
};

function appendClinicalText(container, label, value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return;
  const block = document.createElement("section");
  block.className = "nexa-provider-clinical__block";
  const heading = document.createElement("strong");
  heading.textContent = label;
  const body = document.createElement("p");
  body.textContent = text;
  block.append(heading, body);
  container.append(block);
}

function clinicalAttachmentRecordId(appointment) {
  return appointment.recordId || appointment.appointmentId;
}

async function openClinicalAttachment(recordId, attachment, button) {
  if (!currentUser || button.disabled) return;
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = "Ouverture sécurisée…";
  try {
    const result = await requestNexaFunction(currentUser, "nexaClinicalRecordAttachments", "GET", undefined, {
      recordId,
      attachmentId: attachment.id,
    });
    const target = new URL(result.url);
    if (target.protocol !== "https:" ||
      (target.hostname !== "storage.googleapis.com" && !target.hostname.endsWith(".storage.googleapis.com"))) {
      throw new Error("Le lien sécurisé de la pièce jointe n’est pas valide.");
    }
    const link = document.createElement("a");
    link.href = target.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", "Ouvrir la pièce jointe " + attachment.originalFileName + " dans un nouvel onglet");
    document.body.append(link);
    link.click();
    link.remove();
    button.textContent = "Document ouvert";
  } catch (error) {
    button.textContent = error instanceof NexaApiError ? error.message : "La pièce jointe n’a pas pu être ouverte.";
  } finally {
    button.disabled = false;
    if (button.textContent === "Ouverture sécurisée…") button.textContent = previous;
  }
}

async function refreshClinicalRecord(container, appointment) {
  if (!currentUser) return;
  const result = appointment.standalone
    ? await requestNexaFunction(currentUser, "nexaStandaloneClinicalRecord", "GET", undefined, { recordId: clinicalAttachmentRecordId(appointment) })
    : await requestNexaFunction(currentUser, "nexaClinicalRecord", "GET", undefined, { appointmentId: appointment.appointmentId });
  if (result.view !== "provider" || !result.record) throw new Error("clinical-record-unavailable");
  renderClinicalRecord(container, result.record, appointment);
}

function appendClinicalAttachments(container, record, appointment, editable) {
  const recordId = clinicalAttachmentRecordId(appointment);
  const section = document.createElement("section");
  section.className = "nexa-provider-clinical__block";
  const heading = document.createElement("strong");
  heading.textContent = "Pièces jointes cliniques";
  section.append(heading);
  const list = document.createElement("ul");
  list.className = "nexa-provider-clinical__history-list";
  for (const attachment of Array.isArray(record.attachments) ? record.attachments : []) {
    if (!attachment || typeof attachment.id !== "string") continue;
    const row = document.createElement("li");
    row.append(makeText("span", "", (attachment.originalFileName || "Pièce jointe") + " · " + Math.ceil((Number(attachment.size) || 0) / 1024) + " Ko"));
    const open = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Ouvrir");
    open.type = "button";
    open.addEventListener("click", () => { void openClinicalAttachment(recordId, attachment, open); });
    row.append(open);
    if (editable) {
      const remove = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Retirer");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        if (!currentUser || remove.disabled || !window.confirm("Retirer cette pièce jointe du brouillon ?")) return;
        remove.disabled = true;
        try {
          await requestNexaFunction(currentUser, "nexaClinicalRecordAttachments", "DELETE", {
            recordId,
            attachmentId: attachment.id,
          });
          await refreshClinicalRecord(container, appointment);
        } catch (error) {
          remove.disabled = false;
          status.textContent = error instanceof NexaApiError ? error.message : "La pièce jointe n’a pas pu être retirée.";
        }
      });
      row.append(remove);
    }
    list.append(row);
  }
  if (!list.childElementCount) list.append(makeText("li", "nexa-provider-clinical__notice", "Aucune pièce jointe."));
  section.append(list);
  const status = makeText("p", "nexa-provider-clinical__notice", "");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  section.append(status);
  if (editable) {
    const form = document.createElement("form");
    form.className = "nexa-provider-clinical__actions";
    const file = document.createElement("input");
    file.type = "file";
    file.accept = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";
    file.setAttribute("aria-label", "Choisir une pièce jointe PDF, JPG ou PNG");
    const upload = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Joindre le fichier");
    upload.type = "submit";
    form.append(file, upload);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const selected = file.files?.[0];
      if (!selected) { status.textContent = "Choisissez un fichier PDF, JPG ou PNG."; return; }
      if (!currentUser || selected.size > 15 * 1024 * 1024) { status.textContent = "Le fichier doit faire 15 Mio maximum."; return; }
      upload.disabled = true;
      file.disabled = true;
      status.textContent = "Téléversement et analyse antivirus en cours…";
      try {
        await uploadNexaClinicalAttachment(currentUser, recordId, selected);
        await refreshClinicalRecord(container, appointment);
      } catch (error) {
        status.textContent = error instanceof NexaApiError ? error.message : "Le fichier n’a pas pu être ajouté.";
      } finally {
        upload.disabled = false;
        file.disabled = false;
      }
    });
    section.append(form);
  }
  container.append(section);
}

function appendClinicalVersionHistory(container, appointment) {
  const recordId = clinicalAttachmentRecordId(appointment);
  const section = document.createElement("section");
  section.className = "nexa-provider-clinical";
  const button = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Afficher l’historique des versions");
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div");
  panel.className = "nexa-provider-clinical__panel";
  panel.hidden = true;
  panel.id = "clinical-record-versions-" + recordId;
  button.setAttribute("aria-controls", panel.id);
  const feedback = makeText("p", "nexa-provider-clinical__notice", "");
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  const list = document.createElement("div");
  list.className = "nexa-provider-clinical__history-list";
  const more = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Charger les versions précédentes");
  more.type = "button";
  more.hidden = true;
  let beforeVersion = null;
  let loaded = false;
  let loading = false;
  const loadPage = async (append) => {
    if (!currentUser || loading) return;
    loading = true;
    more.disabled = true;
    feedback.textContent = "Chargement de l’historique…";
    try {
      const query = { recordId, limit: 20 };
      if (append && beforeVersion) query.beforeVersion = beforeVersion;
      const result = await requestNexaFunction(currentUser, "nexaClinicalRecordVersions", "GET", undefined, query);
      if (!append) list.replaceChildren();
      for (const version of Array.isArray(result.versions) ? result.versions : []) {
        const details = document.createElement("details");
        details.className = "nexa-provider-clinical__block";
        const summary = document.createElement("summary");
        summary.textContent = "Version " + version.version + " · " + (version.changeType || "Mise à jour") +
          (version.createdAt ? " · " + slotDate(version.createdAt) : "");
        details.append(summary);
        for (const [name, label] of Object.entries(clinicalFieldLabels)) appendClinicalText(details, label, version.clinicalContent?.[name]);
        const versionVitals = version.clinicalContent?.patientVitals || {};
        const versionVitalSummary = Object.entries(vitalLabels).map(([field, label]) => {
          const value = versionVitals[field];
          return value === null || value === undefined || value === "" ? "" : label + " : " + value;
        }).filter(Boolean).join(" · ");
        appendClinicalText(details, "Signes vitaux", versionVitalSummary);
        const versionMedications = Array.isArray(version.clinicalContent?.medications) ? version.clinicalContent.medications : [];
        appendClinicalText(details, "Médicaments", versionMedications.map((item) => item.name).filter(Boolean).join(" · "));
        appendClinicalText(details, "Examens de laboratoire", (version.clinicalContent?.laboratoryTests || []).join(" · "));
        appendClinicalText(details, "Examens d’imagerie", (version.clinicalContent?.imagingExams || []).join(" · "));
        const historyAttachments = Array.isArray(version.attachments) ? version.attachments : [];
        if (historyAttachments.length) appendClinicalText(details, "Pièces jointes à cette version", historyAttachments.map((item) => item.originalFileName).join(" · "));
        if (version.signature?.name) appendClinicalText(details, "Signé par", version.signature.name + (version.signature.signedAt ? " · " + slotDate(version.signature.signedAt) : ""));
        list.append(details);
      }
      beforeVersion = result.nextBeforeVersion || null;
      more.hidden = !beforeVersion;
      feedback.textContent = list.childElementCount ? "Historique chargé." : "Aucune version précédente disponible.";
      loaded = true;
    } catch (error) {
      feedback.textContent = error instanceof NexaApiError ? error.message : "L’historique n’est pas accessible pour le moment.";
    } finally {
      loading = false;
      more.disabled = false;
    }
  };
  button.addEventListener("click", () => {
    const open = panel.hidden;
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open && !loaded) void loadPage(false);
  });
  more.addEventListener("click", () => { void loadPage(true); });
  panel.append(feedback, list, more);
  section.append(button, panel);
  container.append(section);
}

function renderClinicalRecord(container, record, appointment) {
  container.replaceChildren();
  const standalone = appointment.standalone === true;
  const title = document.createElement("h4");
  title.textContent = standalone
    ? `${["FINALIZED", "SIGNED"].includes(record.status) ? "Dossier finalisé" : "Dossier clinique autonome"}${record.recordNumber ? ` · ${record.recordNumber}` : ""}`
    : ["FINALIZED", "SIGNED"].includes(record.status) ? "Compte rendu finalisé" : "Dossier de consultation en brouillon";
  const meta = document.createElement("p");
  meta.className = "nexa-provider-clinical__notice";
  meta.textContent = [
    record.patientNumber ? `Patient ${record.patientNumber}` : "",
    appointment.startsAt ? `Consultation du ${slotDate(appointment.startsAt)}` : "",
    `Version ${record.version || 1}`,
    record.updatedAt ? `mise à jour ${slotDate(record.updatedAt)}` : "",
    standalone && record.accessExpiresAt ? `Autorisation jusqu’au ${slotDate(record.accessExpiresAt)}` : "",
    !standalone ? "Accès clinique limité à 24 heures après le démarrage effectif." : "",
  ].filter(Boolean).join(" · ");
  container.append(title, meta);
  const content = record.clinicalContent || {};
  const final = ["FINALIZED", "SIGNED"].includes(record.status);

  if (!final) {
    appendClinicalAttachments(container, record, appointment, true);
    appendClinicalVersionHistory(container, appointment);
    const form = document.createElement("form");
    form.className = "nexa-provider-clinical__form";
    for (const [name, labelText] of Object.entries(clinicalFieldLabels)) {
      const label = document.createElement("label");
      label.textContent = labelText;
      const field = document.createElement("textarea");
      field.name = name;
      field.rows = 3;
      field.maxLength = 5_000;
      field.value = typeof content[name] === "string" ? content[name] : "";
      label.append(field);
      form.append(label);
    }
    const vitals = content.patientVitals && typeof content.patientVitals === "object" ? content.patientVitals : {};
    const vitalGroup = document.createElement("fieldset");
    vitalGroup.className = "nexa-provider-clinical__vitals";
    const legend = document.createElement("legend");
    legend.textContent = "Signes vitaux (facultatifs)";
    vitalGroup.append(legend);
    const vitalGrid = document.createElement("div");
    vitalGrid.className = "nexa-provider-clinical__vital-grid";
    for (const [name, labelText] of Object.entries(vitalLabels)) {
      const label = document.createElement("label");
      label.textContent = labelText;
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "any";
      input.name = `vital-${name}`;
      input.value = Number.isFinite(Number(vitals[name])) && vitals[name] !== null ? String(vitals[name]) : "";
      label.append(input);
      vitalGrid.append(label);
    }
    vitalGroup.append(vitalGrid);
    form.append(vitalGroup);

    const actions = document.createElement("div");
    actions.className = "nexa-provider-clinical__actions";
    const save = document.createElement("button");
    save.type = "submit";
    save.value = "saveDraft";
    save.dataset.recordAction = "saveDraft";
    save.className = "nexa-provider-button nexa-provider-button--quiet";
    save.textContent = "Enregistrer le brouillon";
    const finalize = document.createElement("button");
    finalize.type = "submit";
    finalize.value = "finalize";
    finalize.dataset.recordAction = "finalize";
    finalize.className = "nexa-provider-button";
    finalize.textContent = "Finaliser et signer";
    actions.append(save, finalize);
    const feedback = document.createElement("p");
    feedback.className = "nexa-provider-clinical__notice";
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    form.append(actions, feedback);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const action = event.submitter?.dataset.recordAction;
      if (!["saveDraft", "finalize"].includes(action)) return;
      if (action === "finalize" && !window.confirm("Finaliser et signer ce compte rendu ? Il ne pourra plus être modifié; seule une correction datée pourra être ajoutée.")) return;
      const nextContent = Object.fromEntries(Object.keys(clinicalFieldLabels).map((name) => [name, form.elements.namedItem(name).value]));
      nextContent.patientVitals = Object.fromEntries(Object.keys(vitalLabels).map((name) => {
        const raw = form.elements.namedItem(`vital-${name}`).value;
        return [name, raw === "" ? null : Number(raw)];
      }));
      nextContent.patientVitals.weightUnit = "kg";
      nextContent.patientVitals.heightUnit = "cm";
      void submitClinicalRecord(appointment.appointmentId, action, { clinicalContent: nextContent }, form, feedback, container, appointment);
    });
    container.append(form);
    return;
  }

  for (const [name, label] of Object.entries(clinicalFieldLabels)) appendClinicalText(container, label, content[name]);
  const recordedVitals = content.patientVitals && typeof content.patientVitals === "object" ? content.patientVitals : {};
  const vitalSummary = Object.entries(vitalLabels).map(([key, label]) => {
    const value = recordedVitals[key];
    return value === null || value === undefined || value === "" ? "" : `${label} : ${value}`;
  }).filter(Boolean).join(" · ");
  appendClinicalText(container, "Signes vitaux", vitalSummary);
  if (record.signature?.name) appendClinicalText(container, "Signé par", `${record.signature.name}${record.signature.specialty ? ` · ${record.signature.specialty}` : ""}${record.signature.signedAt ? ` · ${slotDate(record.signature.signedAt)}` : ""}`);
  if (record.documentHash) appendClinicalText(container, "Empreinte du document", record.documentHash);
  for (const addendum of record.addenda || []) {
    const section = document.createElement("section");
    section.className = "nexa-provider-clinical__block";
    const heading = document.createElement("strong");
    heading.textContent = `Correction · ${addendum.signatureName || "Médecin NEXA"}`;
    const time = document.createElement("small");
    time.textContent = slotDate(addendum.createdAt);
    const body = document.createElement("p");
    body.textContent = [addendum.reason, addendum.content].filter(Boolean).join(" — ");
    section.append(heading, time, body);
    container.append(section);
  }
  appendClinicalAttachments(container, record, appointment, false);
  appendClinicalVersionHistory(container, appointment);

  const addendumForm = document.createElement("form");
  addendumForm.className = "nexa-provider-clinical__form";
  const reasonLabel = document.createElement("label");
  reasonLabel.textContent = "Motif de correction";
  const reason = document.createElement("input");
  reason.name = "reason";
  reason.maxLength = 500;
  reasonLabel.append(reason);
  const contentLabel = document.createElement("label");
  contentLabel.textContent = "Correction datée";
  const correction = document.createElement("textarea");
  correction.name = "content";
  correction.rows = 3;
  correction.maxLength = 5_000;
  correction.required = true;
  contentLabel.append(correction);
  const addendumButton = document.createElement("button");
  addendumButton.type = "submit";
  addendumButton.className = "nexa-provider-button nexa-provider-button--quiet";
  addendumButton.textContent = "Ajouter une correction signée";
  const feedback = document.createElement("p");
  feedback.className = "nexa-provider-clinical__notice";
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  addendumForm.append(reasonLabel, contentLabel, addendumButton, feedback);
  addendumForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitClinicalRecord(appointment.appointmentId, "addendum", { reason: reason.value, content: correction.value }, addendumForm, feedback, container, appointment);
  });
  container.append(addendumForm);
}

async function submitClinicalRecord(appointmentId, action, payload, form, feedback, container, appointment) {
  if (!currentUser || busy) return;
  const user = currentUser;
  const generation = authGeneration;
  busy = true;
  form.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  feedback.textContent = action === "finalize" ? "Finalisation du compte rendu…" : action === "addendum" ? "Enregistrement de la correction…" : "Enregistrement du brouillon…";
  try {
    const result = appointment.standalone
      ? await requestNexaFunction(user, "nexaStandaloneClinicalRecord", "POST", { recordId: appointment.recordId || appointmentId, action, ...payload })
      : await requestNexaFunction(user, "nexaClinicalRecord", "POST", { action, ...payload }, { appointmentId });
    if (generation !== authGeneration || currentUser !== user) return;
    renderClinicalRecord(container, result.record, appointment);
  } catch (error) {
    if (generation !== authGeneration || currentUser !== user) return;
    feedback.textContent = error instanceof NexaApiError ? error.message : "Le dossier clinique n’a pas pu être enregistré.";
  } finally {
    if (generation === authGeneration) {
      busy = false;
      form.querySelectorAll("button").forEach((button) => { button.disabled = false; });
    }
  }
}

async function toggleClinicalRecord(appointment, button, panel, content) {
  if (!currentUser || busy) return;
  const user = currentUser;
  const generation = authGeneration;
  if (!panel.hidden && panel.dataset.loaded === "true") {
    panel.hidden = true;
    delete panel.dataset.loaded;
    content.replaceChildren();
    button.textContent = appointment.standalone ? "Ouvrir le dossier clinique" : "Ouvrir le dossier de consultation";
    button.setAttribute("aria-expanded", "false");
    return;
  }
  busy = true;
  button.disabled = true;
  button.textContent = "Vérification de l’accès clinique…";
  panel.hidden = false;
  button.setAttribute("aria-expanded", "true");
  content.replaceChildren();
  const loadingMessage = document.createElement("p");
  loadingMessage.className = "nexa-provider-clinical__notice";
  loadingMessage.setAttribute("role", "status");
  loadingMessage.textContent = "Vérification de l’autorisation et chargement du dossier…";
  content.append(loadingMessage);
  try {
    const result = appointment.standalone
      ? await requestNexaFunction(user, "nexaStandaloneClinicalRecord", "GET", undefined, { recordId: appointment.recordId || appointment.appointmentId })
      : await requestNexaFunction(user, "nexaClinicalRecord", "GET", undefined, { appointmentId: appointment.appointmentId });
    if (generation !== authGeneration || currentUser !== user) return;
    if (result.view !== "provider" || !result.record) throw new Error("clinical-record-unavailable");
    panel.dataset.loaded = "true";
    renderClinicalRecord(content, result.record, appointment);
    if (appointment.standalone && result.record.accessExpiresAt) {
      const expiresAt = Date.parse(result.record.accessExpiresAt);
      const delay = expiresAt - Date.now();
      if (Number.isFinite(expiresAt) && delay > 0) {
        setTimeout(() => {
          if (Date.now() < expiresAt) return;
          panel.hidden = true;
          delete panel.dataset.loaded;
          content.replaceChildren();
          button.setAttribute("aria-expanded", "false");
          button.disabled = true;
          button.textContent = "Autorisation expirée — demander un nouveau code";
        }, delay + 500);
      }
    }
    button.textContent = appointment.standalone ? "Masquer le dossier clinique" : "Masquer le dossier de consultation";
  } catch (error) {
    if (generation !== authGeneration || currentUser !== user) return;
    delete panel.dataset.loaded;
    content.replaceChildren();
    const message = document.createElement("p");
    message.className = "nexa-provider-error";
    message.setAttribute("role", "alert");
    message.textContent = error instanceof NexaApiError ? error.message : "Le dossier de consultation n’est pas accessible pour le moment.";
    content.append(message);
    button.textContent = appointment.standalone ? "Réessayer d’ouvrir le dossier" : "Réessayer d’ouvrir le dossier de consultation";
  } finally {
    if (generation === authGeneration) {
      busy = false;
      button.disabled = false;
    }
  }
}

function renderPriorClinicalRecord(record) {
  const article = document.createElement("article");
  article.className = "nexa-provider-clinical__block";
  const heading = document.createElement("h4");
  heading.textContent = record.providerName || "Médecin NEXA";
  const metadata = document.createElement("p");
  metadata.className = "nexa-provider-clinical__notice";
  metadata.textContent = [
    record.specialtyName || "",
    record.finalizedAt ? `Finalisé le ${slotDate(record.finalizedAt)}` : "Date indisponible",
    record.signature?.name ? `Signé par ${record.signature.name}` : "Signature médicale",
  ].filter(Boolean).join(" · ");
  article.append(heading, metadata);

  const content = record.clinicalContent && typeof record.clinicalContent === "object" ? record.clinicalContent : {};
  for (const [field, label] of Object.entries(priorClinicalFieldLabels)) appendClinicalText(article, label, content[field]);
  const vitals = content.patientVitals && typeof content.patientVitals === "object" ? content.patientVitals : {};
  const vitalSummary = Object.entries(vitalLabels).map(([field, label]) => {
    const value = vitals[field];
    return value === null || value === undefined || value === "" ? "" : `${label} : ${value}`;
  }).filter(Boolean).join(" · ");
  appendClinicalText(article, "Signes vitaux", vitalSummary);

  const medications = Array.isArray(content.medications) ? content.medications : [];
  if (medications.length) {
    const section = document.createElement("section");
    section.className = "nexa-provider-clinical__block";
    section.append(makeText("strong", "", "Médicaments consignés"));
    const list = document.createElement("ul");
    for (const medication of medications) {
      const item = document.createElement("li");
      item.textContent = [
        medication.name,
        medication.dosage,
        medication.form,
        medication.route,
        medication.quantity == null ? "" : `Quantité : ${medication.quantity}`,
        medication.duration ? `Durée : ${medication.duration}` : "",
        medication.instructions,
      ].filter(Boolean).join(" · ");
      list.append(item);
    }
    section.append(list);
    article.append(section);
  }

  for (const [field, label] of [["laboratoryTests", "Examens de laboratoire"], ["imagingExams", "Examens d’imagerie"]]) {
    const values = Array.isArray(content[field]) ? content[field].filter((value) => typeof value === "string" && value.trim()) : [];
    if (values.length) appendClinicalText(article, label, values.join(" · "));
  }

  for (const addendum of Array.isArray(record.addenda) ? record.addenda : []) {
    const section = document.createElement("section");
    section.className = "nexa-provider-clinical__block";
    section.append(makeText("strong", "", `Correction signée · ${addendum.signatureName || "Médecin NEXA"}`));
    if (addendum.createdAt) section.append(makeText("small", "", slotDate(addendum.createdAt)));
    section.append(makeText("p", "", [addendum.reason, addendum.content].filter(Boolean).join(" — ")));
    article.append(section);
  }
  return article;
}

async function loadPriorClinicalHistoryPage(appointment, button, feedback, list, moreButton, state, append = false) {
  if (!currentUser || busy) return;
  const generation = authGeneration;
  const user = currentUser;
  busy = true;
  button.disabled = true;
  moreButton.disabled = true;
  feedback.textContent = append ? "Chargement des dossiers suivants…" : "Vérification de l’accès clinique…";
  try {
    const query = { appointmentId: appointment.appointmentId };
    if (state.cursor) query.cursor = state.cursor;
    const result = await requestNexaFunction(user, "nexaClinicalHistory", "GET", undefined, query);
    if (generation !== authGeneration || currentUser !== user) return;
    if (!Array.isArray(result.records)) throw new Error("clinical-history-response-invalid");
    const cards = result.records.map(renderPriorClinicalRecord);
    if (append) list.append(...cards);
    else list.replaceChildren(...cards);
    state.cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : "";
    feedback.textContent = cards.length
      ? "Comptes rendus signés chargés. L’accès reste limité à cette prise en charge."
      : append ? "Aucun autre compte rendu à afficher." : "Aucun autre compte rendu signé n’est disponible pour ce patient.";
    moreButton.hidden = !state.cursor;
  } catch (error) {
    if (generation !== authGeneration || currentUser !== user) return;
    feedback.textContent = error instanceof NexaApiError
      ? error.message
      : "L’historique clinique n’est pas accessible pour le moment.";
  } finally {
    if (generation === authGeneration) busy = false;
    button.disabled = false;
    moreButton.disabled = false;
  }
}

function togglePriorClinicalHistory(appointment, button, panel, feedback, list, moreButton, state) {
  if (!currentUser || busy) return;
  if (!panel.hidden) {
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.textContent = "Afficher l’historique clinique autorisé";
    feedback.textContent = "";
    list.replaceChildren();
    moreButton.hidden = true;
    state.cursor = "";
    return;
  }
  panel.hidden = false;
  button.setAttribute("aria-expanded", "true");
  button.textContent = "Masquer l’historique clinique";
  void loadPriorClinicalHistoryPage(appointment, button, feedback, list, moreButton, state);
}

function prescriptionContent(prescription = {}) {
  return {
    medications: Array.isArray(prescription.medications) ? prescription.medications.map((item) => ({
      name: item.name || "", dosage: item.dosage || "", form: item.form || "", route: item.route || "",
      quantity: item.quantity == null ? "" : String(item.quantity), duration: item.duration || "", instructions: item.instructions || "",
    })) : [],
    labExams: Array.isArray(prescription.labExams) ? prescription.labExams : [],
    imagingExams: Array.isArray(prescription.imagingExams) ? prescription.imagingExams : [],
    notes: typeof prescription.notes === "string" ? prescription.notes : "",
  };
}

function prescriptionField(labelText, value, { multiline = false, required = false, maxLength = 250, type = "text" } = {}) {
  const label = document.createElement("label");
  label.textContent = labelText;
  const field = document.createElement(multiline ? "textarea" : "input");
  field.maxLength = maxLength;
  field.required = required;
  field.value = value || "";
  if (multiline) field.rows = 3;
  else field.type = type;
  label.append(field);
  return { label, field };
}

function renderPrescriptionEditor(container, appointment, current, mode, reload) {
  const localDraft = { id: current?.id || "" };
  const form = document.createElement("form");
  form.className = "nexa-provider-clinical__form";
  const heading = document.createElement("h4");
  heading.textContent = mode === "correct" ? "Nouvelle version corrigée" : mode === "draft" ? "Brouillon d’ordonnance" : "Nouvelle ordonnance";
  form.append(heading);
  const medicineGroup = document.createElement("fieldset");
  medicineGroup.className = "nexa-provider-clinical__vitals";
  const medicineLegend = document.createElement("legend");
  medicineLegend.textContent = "Médicaments (facultatifs si vous prescrivez un examen)";
  medicineGroup.append(medicineLegend);
  const medicines = prescriptionContent(current).medications;
  const addMedicineRow = (item = {}) => {
    const row = document.createElement("div");
    row.className = "nexa-provider-prescription__medicine";
    const fields = [
      prescriptionField("Nom du médicament", item.name, { required: true, maxLength: 180 }),
      prescriptionField("Dosage", item.dosage, { maxLength: 120 }),
      prescriptionField("Forme", item.form, { maxLength: 120 }),
      prescriptionField("Voie d’administration", item.route, { maxLength: 120 }),
      prescriptionField("Quantité", item.quantity, { type: "number", maxLength: 20 }),
      prescriptionField("Durée", item.duration, { maxLength: 120 }),
      prescriptionField("Instructions", item.instructions, { multiline: true, maxLength: 500 }),
    ];
    fields.forEach(({ label, field }, index) => {
      field.dataset.medicationField = ["name", "dosage", "form", "route", "quantity", "duration", "instructions"][index];
      label.append(field);
      row.append(label);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "nexa-provider-button nexa-provider-button--quiet";
    remove.textContent = "Retirer ce médicament";
    remove.addEventListener("click", () => row.remove());
    row.append(remove);
    medicineGroup.append(row);
  };
  medicines.forEach(addMedicineRow);
  const addMedicine = document.createElement("button");
  addMedicine.type = "button";
  addMedicine.className = "nexa-provider-button nexa-provider-button--quiet";
  addMedicine.textContent = "Ajouter un médicament";
  addMedicine.addEventListener("click", () => addMedicineRow());
  medicineGroup.append(addMedicine);
  form.append(medicineGroup);

  const original = prescriptionContent(current);
  const lab = prescriptionField("Examens de laboratoire (un par ligne)", original.labExams.join("\n"), { multiline: true, maxLength: 5_000 });
  lab.field.dataset.prescriptionField = "labExams";
  const imaging = prescriptionField("Examens d’imagerie (un par ligne)", original.imagingExams.join("\n"), { multiline: true, maxLength: 5_000 });
  imaging.field.dataset.prescriptionField = "imagingExams";
  const notes = prescriptionField("Instructions complémentaires", original.notes, { multiline: true, maxLength: 1_000 });
  notes.field.dataset.prescriptionField = "notes";
  form.append(lab.label, imaging.label, notes.label);

  const feedback = document.createElement("p");
  feedback.className = "nexa-provider-clinical__notice";
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  const actions = document.createElement("div");
  actions.className = "nexa-provider-clinical__actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.dataset.prescriptionAction = mode === "correct" ? "correct" : "saveDraft";
  save.className = "nexa-provider-button nexa-provider-button--quiet";
  save.textContent = mode === "correct" ? "Valider la version corrigée" : "Enregistrer le brouillon";
  actions.append(save);
  if (mode !== "correct") {
    const validate = document.createElement("button");
    validate.type = "submit";
    validate.dataset.prescriptionAction = "validate";
    validate.className = "nexa-provider-button";
    validate.textContent = "Valider et transmettre au patient";
    actions.append(validate);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "nexa-provider-button nexa-provider-button--quiet";
  close.textContent = "Fermer le formulaire";
  close.addEventListener("click", () => { void reload(); });
  actions.append(close);
  form.append(actions, feedback);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const action = event.submitter?.dataset.prescriptionAction;
    if (!action) return;
    const content = {
      medications: [...form.querySelectorAll(".nexa-provider-prescription__medicine")].map((row) => {
        const values = Object.fromEntries([...row.querySelectorAll("[data-medication-field]")].map((field) => [field.dataset.medicationField, field.value.trim()]));
        return { ...values, quantity: values.quantity ? Number(values.quantity) : null };
      }).filter((item) => item.name),
      labExams: lab.field.value.split("\n").map((value) => value.trim()).filter(Boolean),
      imagingExams: imaging.field.value.split("\n").map((value) => value.trim()).filter(Boolean),
      notes: notes.field.value.trim(),
    };
    if (action === "validate" && !content.medications.length && !content.labExams.length && !content.imagingExams.length) {
      feedback.textContent = "Ajoutez au moins un médicament ou un examen avant de valider.";
      return;
    }
    if (action !== "saveDraft" && !window.confirm("Valider cette ordonnance et la transmettre au patient ?")) return;
    void submitPrescription(appointment, action, current, mode, content, form, feedback, reload, localDraft);
  });
  container.append(form);
}

async function submitPrescription(appointment, action, current, mode, content, form, feedback, reload, localDraft) {
  if (!currentUser || busy) return;
  busy = true;
  form.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  feedback.textContent = action === "saveDraft" ? "Enregistrement du brouillon…" : "Validation sécurisée de l’ordonnance…";
  try {
    const query = { appointmentId: appointment.appointmentId };
    if (action === "correct") {
      await requestNexaFunction(currentUser, "nexaClinicalPrescriptions", "POST", { action, prescriptionId: current.id, content }, query);
    } else if (mode === "new" && !localDraft.id) {
      const created = await requestNexaFunction(currentUser, "nexaClinicalPrescriptions", "POST", { action: "createDraft", content }, query);
      localDraft.id = created.prescriptionId;
      if (action === "validate") await requestNexaFunction(currentUser, "nexaClinicalPrescriptions", "POST", { action: "validate", prescriptionId: localDraft.id }, query);
    } else if (action === "validate") {
      await requestNexaFunction(currentUser, "nexaClinicalPrescriptions", "POST", { action: "updateDraft", prescriptionId: localDraft.id, content }, query);
      await requestNexaFunction(currentUser, "nexaClinicalPrescriptions", "POST", { action: "validate", prescriptionId: localDraft.id }, query);
    } else {
      await requestNexaFunction(currentUser, "nexaClinicalPrescriptions", "POST", { action: "updateDraft", prescriptionId: localDraft.id, content }, query);
    }
    await reload();
  } catch (error) {
    feedback.textContent = error instanceof NexaApiError ? error.message : "L’ordonnance n’a pas pu être enregistrée.";
  } finally {
    busy = false;
    form.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
}

async function loadClinicalPrescriptions(appointment, container) {
  container.replaceChildren();
  const loadingMessage = document.createElement("p");
  loadingMessage.className = "nexa-provider-clinical__notice";
  loadingMessage.setAttribute("role", "status");
  loadingMessage.textContent = "Chargement des ordonnances de cette consultation…";
  container.append(loadingMessage);
  try {
    const result = await requestNexaFunction(currentUser, "nexaClinicalPrescriptions", "GET", undefined, { appointmentId: appointment.appointmentId });
    if (result.view !== "provider") throw new Error("prescription-view-invalid");
    const prescriptions = Array.isArray(result.prescriptions) ? result.prescriptions : [];
    container.replaceChildren();
    const intro = document.createElement("p");
    intro.className = "nexa-provider-clinical__notice";
    intro.textContent = "Seul le médecin vérifié associé à cette prise en charge peut créer ou valider une ordonnance. Les versions transmises au patient sont conservées dans l’historique.";
    container.append(intro);
    for (const prescription of prescriptions) {
      const card = document.createElement("article");
      card.className = "nexa-provider-clinical__block";
      const state = prescription.status === "VALIDATED" ? "validée" : prescription.status === "REPLACED" ? "remplacée" : "brouillon";
      card.append(
        makeProviderText("strong", `Ordonnance · version ${prescription.version} · ${state}`),
        makeProviderText("small", prescription.validatedAt ? `Transmise le ${slotDate(prescription.validatedAt)}` : "Non transmise au patient"),
      );
      for (const medication of prescription.medications || []) {
        const details = [medication.dosage, medication.form, medication.route, medication.duration].filter(Boolean).join(" · ");
        card.append(makeProviderText("p", `${medication.name}${details ? ` — ${details}` : ""}${medication.instructions ? ` · ${medication.instructions}` : ""}`));
      }
      for (const [label, values] of [["Laboratoire", prescription.labExams], ["Imagerie", prescription.imagingExams]]) {
        if (values?.length) card.append(makeProviderText("p", `${label} : ${values.join(" · ")}`));
      }
      if (prescription.notes) card.append(makeProviderText("p", `Notes : ${prescription.notes}`));
      if (prescription.status === "VALIDATED") {
        const pdfButton = document.createElement("button");
        pdfButton.type = "button";
        pdfButton.className = "nexa-provider-button nexa-provider-button--quiet";
        pdfButton.textContent = "Télécharger le PDF";
        const pdfStatus = makeProviderText("p", "", "nexa-provider-clinical__notice");
        pdfStatus.setAttribute("role", "status");
        pdfStatus.setAttribute("aria-live", "polite");
        pdfButton.addEventListener("click", () => { void downloadClinicalPrescriptionPdf(prescription, pdfButton, pdfStatus); });
        card.append(pdfButton, pdfStatus);
      }
      if (prescription.status === "DRAFT" || prescription.status === "VALIDATED") {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "nexa-provider-button nexa-provider-button--quiet";
        edit.textContent = prescription.status === "DRAFT" ? "Modifier le brouillon" : "Créer une version corrigée";
        edit.addEventListener("click", () => {
          container.replaceChildren();
          renderPrescriptionEditor(container, appointment, prescription, prescription.status === "DRAFT" ? "draft" : "correct", () => loadClinicalPrescriptions(appointment, container));
        });
        card.append(edit);
      }
      container.append(card);
    }
    const create = document.createElement("button");
    create.type = "button";
    create.className = "nexa-provider-button";
    create.textContent = "Créer une ordonnance";
    create.addEventListener("click", () => {
      container.replaceChildren();
      renderPrescriptionEditor(container, appointment, null, "new", () => loadClinicalPrescriptions(appointment, container));
    });
    container.append(create);
  } catch (error) {
    container.replaceChildren(makeProviderText("p", error instanceof NexaApiError ? error.message : "Les ordonnances ne sont pas accessibles pour le moment.", "nexa-provider-error"));
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "nexa-provider-button nexa-provider-button--quiet";
    retry.textContent = "Réessayer";
    retry.addEventListener("click", () => { void loadClinicalPrescriptions(appointment, container); });
    container.append(retry);
  }
}

function makeProviderText(tag, value, className = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value || "";
  return node;
}

async function downloadClinicalPrescriptionPdf(prescription, button, feedback) {
  if (!currentUser || busy) return;
  busy = true;
  button.disabled = true;
  feedback.textContent = "Préparation du PDF sécurisé…";
  try {
    const blob = await downloadNexaPdf(currentUser, "nexaPrescriptionPdf", { prescriptionId: prescription.id });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `nexa-ordonnance-v${Number(prescription.version) || 1}.pdf`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    feedback.textContent = "Le téléchargement du PDF a commencé.";
  } catch (error) {
    feedback.textContent = error instanceof NexaApiError ? error.message : "Le PDF n’a pas pu être téléchargé.";
  } finally {
    busy = false;
    button.disabled = false;
  }
}

async function toggleClinicalPrescriptions(appointment, button, panel, content) {
  if (!currentUser || busy) return;
  if (!panel.hidden && panel.dataset.loaded === "true") {
    panel.hidden = true;
    delete panel.dataset.loaded;
    content.replaceChildren();
    button.textContent = "Gérer les ordonnances";
    button.setAttribute("aria-expanded", "false");
    return;
  }
  busy = true;
  button.disabled = true;
  panel.hidden = false;
  button.setAttribute("aria-expanded", "true");
  button.textContent = "Vérification de l’accès clinique…";
  try {
    await loadClinicalPrescriptions(appointment, content);
    panel.dataset.loaded = "true";
    button.textContent = "Masquer les ordonnances";
  } finally {
    busy = false;
    button.disabled = false;
  }
}

async function toggleMedicalProfile(appointment, button, panel, content) {
  if (!currentUser || busy) return;
  if (!panel.hidden && panel.dataset.loaded === "true") {
    panel.hidden = true;
    delete panel.dataset.loaded;
    content.replaceChildren();
    button.setAttribute("aria-expanded", "false");
    button.textContent = "Consulter la fiche médicale";
    return;
  }

  busy = true;
  button.disabled = true;
  button.textContent = "Vérification de l’autorisation…";
  content.replaceChildren();
  const loadingMessage = document.createElement("p");
  loadingMessage.className = "nexa-provider-clinical__notice";
  loadingMessage.setAttribute("role", "status");
  loadingMessage.textContent = "Vérification de l’accès clinique…";
  content.append(loadingMessage);
  panel.hidden = false;
  button.setAttribute("aria-expanded", "true");
  try {
    const result = await requestNexaFunction(currentUser, "doctorPatientMedicalProfile", "GET", undefined, {
      appointmentId: appointment.appointmentId,
    });
    renderMedicalProfile(content, result);
    panel.dataset.loaded = "true";
    button.textContent = "Masquer la fiche médicale";
  } catch (error) {
    delete panel.dataset.loaded;
    content.replaceChildren();
    const message = document.createElement("p");
    message.className = "nexa-provider-error";
    message.setAttribute("role", "alert");
    message.textContent = error instanceof NexaApiError
      ? error.message
      : "La fiche médicale n’est pas accessible pour le moment.";
    content.append(message);
    button.textContent = "Réessayer l’accès à la fiche médicale";
  } finally {
    busy = false;
    button.disabled = false;
  }
}

function renderSlots(slots) {
  const rows = slots.map((slot) => {
    const item = document.createElement("li");
    const summary = document.createElement("div");
    const date = document.createElement("strong");
    date.textContent = slotDate(slot.startsAt);
    const service = document.createElement("span");
    service.textContent = slot.serviceType === "HOME_VISIT" ? "Visite médicale à domicile · 1 heure" : "Téléconsultation · créneau de 30 minutes";
    const state = document.createElement("small");
    state.textContent = statusLabel(slot.status);
    summary.append(date, service, state);
    item.append(summary);
    if (slot.status === "available") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "nexa-provider-button nexa-provider-button--quiet";
      remove.textContent = "Retirer";
      remove.setAttribute("aria-label", `Retirer le créneau du ${slotDate(slot.startsAt)}`);
      remove.addEventListener("click", () => { void removeSlot(slot.id, remove); });
      item.append(remove);
    }
    return item;
  });
  slotsList.replaceChildren(...rows);
  slotsEmpty.hidden = slots.length > 0;
}

function renderAppointments(appointments) {
  const rows = appointments.map((appointment) => {
    const item = document.createElement("li");
    const details = document.createElement("div");
    const patient = document.createElement("strong");
    patient.textContent = appointment.patientName || "Patient NEXA";
    const date = document.createElement("span");
    date.textContent = slotDate(appointment.startsAt);
    const service = document.createElement("small");
    const homeVisit = appointment.bookingType === "home_visit";
    service.textContent = homeVisit
      ? `${homeVisitServiceLabels[appointment.homeVisitServiceId] || "Visite médicale"} · visite à domicile · 1 heure · ${formatMoney(appointment.amount)}`
      : `Téléconsultation · ${appointment.durationMinutes || 25} minutes · ${formatMoney(appointment.amount)}`;
    const status = document.createElement("small");
    status.textContent = homeVisit
      ? appointment.homeVisitMissionStatus === "SCHEDULED" && appointment.consultationStarted
        ? "Visite commencée · dossier clinique ouvert"
        : homeVisitMissionLabels[appointment.homeVisitMissionStatus] || appointmentStatusLabels[appointment.status] || appointment.status || "État indisponible"
      : appointmentStatusLabels[appointment.status] || appointment.status || "État indisponible";
    details.append(patient, date, service, status);
    if (appointment.noShowReason === "PROVIDER_DID_NOT_ACCEPT") {
      const noShow = document.createElement("small");
      noShow.textContent = "Vous n’avez pas accepté ce rendez-vous à l’heure prévue. Le dossier est en attente d’examen par l’administration NEXA; aucun remboursement automatique n’a été effectué.";
      details.append(noShow);
    } else if (appointment.noShowOutcome === "PROVIDER_UNRESPONSIVE") {
      const noShow = document.createElement("small");
      noShow.textContent = "Deux appels initiés par le patient sont restés sans réponse de votre part. Le prix du service est remboursé au patient; les frais de transaction ne sont pas remboursés.";
      details.append(noShow);
    } else if (appointment.noShowOutcome === "PATIENT_UNRESPONSIVE") {
      const noShow = document.createElement("small");
      noShow.textContent = "Deux appels initiés par vous sont restés sans réponse du patient. Le montant du service est conservé par NEXA et aucun versement n’est dû au médecin.";
      details.append(noShow);
    } else if (appointment.status === "PROVIDER_REFUSED" && appointment.refundStatus === "COMPLETED") {
      const refusal = document.createElement("small");
      refusal.textContent = `Refusée. ${formatMoney(appointment.amount)} correspondant au prix du service ont été crédités dans le Wallet du patient; les frais de transaction ne sont pas remboursés.`;
      details.append(refusal);
    }

    if (homeVisit && appointment.homeVisitDetails) {
      const addressParts = [appointment.homeVisitDetails.addressLine, appointment.homeVisitDetails.commune, appointment.homeVisitDetails.department].filter(Boolean);
      const phone = appointment.homeVisitDetails.contactPhone;
      if (addressParts.length || phone) {
        const contact = document.createElement("small");
        contact.textContent = [addressParts.length ? `Adresse : ${addressParts.join(", ")}` : "", phone ? `Téléphone : ${phone}` : ""].filter(Boolean).join(" · ");
        details.append(contact);
      }
    }

    if (homeVisit && appointment.status === "CONFIRMED" && appointment.paymentStatus === "PAID" &&
      appointment.homeVisitMissionStatus === "SCHEDULED" && !appointment.consultationStarted) {
      const startButton = document.createElement("button");
      startButton.type = "button";
      startButton.className = "nexa-provider-button";
      startButton.textContent = "Commencer la visite et ouvrir le dossier clinique";
      startButton.setAttribute("aria-label", `Commencer la visite du ${slotDate(appointment.startsAt)}`);
      const startStatus = makeText("p", "nexa-provider-clinical__notice", "");
      startStatus.setAttribute("role", "status");
      startStatus.setAttribute("aria-live", "polite");
      startButton.addEventListener("click", async () => {
        if (!currentUser || busy) return;
        busy = true;
        startButton.disabled = true;
        startStatus.textContent = "Enregistrement du début de visite…";
        try {
          await requestNexaFunction(currentUser, "nexaHomeVisitMissionStart", "POST", { appointmentId: appointment.appointmentId });
          startStatus.textContent = "Visite démarrée. L’accès au dossier clinique est ouvert pour 24 heures.";
          await loadAppointments();
        } catch (error) {
          startStatus.textContent = error instanceof NexaApiError ? error.message : "La visite ne peut pas être démarrée pour le moment.";
          startButton.disabled = false;
        } finally {
          busy = false;
        }
      });
      item.append(startButton, startStatus);
    }

    if (homeVisit && appointment.homeVisitMissionStatus === "AWAITING_PROVIDER_CODE") {
      const closeSection = document.createElement("section");
      closeSection.className = "nexa-provider-mission-close";
      const closeTitle = makeText("h4", "", "Clôturer la visite confirmée par le patient");
      const explanation = makeText("p", "nexa-provider-clinical__notice", "Saisissez le code à huit chiffres que le patient vous remet après avoir confirmé votre présence. Le code n’est pas affiché dans cet espace.");
      const closeForm = document.createElement("form");
      closeForm.className = "nexa-provider-mission-close__form";
      const codeLabel = document.createElement("label");
      codeLabel.textContent = "Code patient";
      const codeInput = document.createElement("input");
      codeInput.name = "code";
      codeInput.type = "text";
      codeInput.inputMode = "numeric";
      codeInput.autocomplete = "one-time-code";
      codeInput.pattern = "[0-9]{8}";
      codeInput.maxLength = 8;
      codeInput.minLength = 8;
      codeInput.required = true;
      codeInput.setAttribute("aria-label", `Code patient à huit chiffres pour la visite du ${slotDate(appointment.startsAt)}`);
      codeLabel.append(codeInput);
      const closeMessage = makeText("p", "nexa-provider-mission-close__message", "");
      closeMessage.setAttribute("role", "status");
      closeMessage.setAttribute("aria-live", "polite");
      const closeButton = document.createElement("button");
      closeButton.type = "submit";
      closeButton.className = "nexa-provider-button";
      closeButton.textContent = "Valider le code et clôturer";
      closeForm.append(codeLabel, closeMessage, closeButton);
      closeForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!currentUser || busy) return;
        busy = true;
        closeButton.disabled = true;
        closeMessage.textContent = "Vérification du code…";
        try {
          await requestNexaFunction(currentUser, "nexaHomeVisitMissionClose", "POST", {
            appointmentId: appointment.appointmentId,
            code: codeInput.value.trim(),
          });
          closeMessage.textContent = "La visite est clôturée.";
          await loadAppointments();
        } catch (error) {
          closeMessage.textContent = error instanceof NexaApiError ? error.message : "La visite ne peut pas être clôturée pour le moment.";
          closeButton.disabled = false;
        } finally {
          busy = false;
        }
      });
      closeSection.append(closeTitle, explanation, closeForm);
      details.append(closeSection);
    }

    item.append(details);
    if (canOpenClinicalProfile(appointment)) {
      const clinical = document.createElement("section");
      clinical.className = "nexa-provider-clinical";
      const clinicalButton = document.createElement("button");
      clinicalButton.type = "button";
      clinicalButton.className = "nexa-provider-button nexa-provider-button--quiet";
      clinicalButton.textContent = "Consulter la fiche médicale";
      clinicalButton.setAttribute("aria-expanded", "false");
      const panelId = `clinical-profile-${appointment.appointmentId}`;
      clinicalButton.setAttribute("aria-controls", panelId);
      const clinicalPanel = document.createElement("div");
      clinicalPanel.id = panelId;
      clinicalPanel.className = "nexa-provider-clinical__panel";
      clinicalPanel.hidden = true;
      clinicalButton.addEventListener("click", () => {
        void toggleMedicalProfile(appointment, clinicalButton, clinicalPanel, clinicalContent);
      });
      const clinicalContent = document.createElement("div");
      clinicalPanel.append(clinicalContent);
      const help = document.createElement("p");
      help.className = "nexa-provider-clinical__notice";
      help.textContent = "Cette fiche contient des informations de santé. L’accès est réservé au médecin associé et limité à 24 heures après le début effectif de la prise en charge.";
      clinical.append(help, clinicalButton, clinicalPanel);
      item.append(clinical);
    }
    if (canOpenClinicalProfile(appointment)) {
      const recordSection = document.createElement("section");
      recordSection.className = "nexa-provider-clinical";
      const recordButton = document.createElement("button");
      recordButton.type = "button";
      recordButton.className = "nexa-provider-button";
      recordButton.textContent = "Ouvrir le dossier de consultation";
      recordButton.setAttribute("aria-expanded", "false");
      const recordPanel = document.createElement("div");
      recordPanel.className = "nexa-provider-clinical__panel";
      recordPanel.hidden = true;
      const recordContent = document.createElement("div");
      recordButton.setAttribute("aria-controls", `clinical-record-${appointment.appointmentId}`);
      recordPanel.id = `clinical-record-${appointment.appointmentId}`;
      recordPanel.append(recordContent);
      recordButton.addEventListener("click", () => { void toggleClinicalRecord(appointment, recordButton, recordPanel, recordContent); });
      const recordHelp = document.createElement("p");
      recordHelp.className = "nexa-provider-clinical__notice";
      recordHelp.textContent = "Le dossier est privé, horodaté et limité au rendez-vous associé. La finalisation crée une signature et rend le contenu immuable; les corrections restent datées dans l’historique.";
      recordSection.append(recordHelp, recordButton, recordPanel);
      item.append(recordSection);
    }
    if (canOpenClinicalProfile(appointment)) {
      const historySection = document.createElement("section");
      historySection.className = "nexa-provider-clinical";
      const historyHelp = document.createElement("p");
      historyHelp.className = "nexa-provider-clinical__notice";
      historyHelp.textContent = "Les comptes rendus signés d’autres médecins sont consultables uniquement pendant l’autorisation clinique active de ce rendez-vous. Les brouillons et les dossiers du médecin actuel ne sont pas affichés.";
      const historyButton = document.createElement("button");
      historyButton.type = "button";
      historyButton.className = "nexa-provider-button nexa-provider-button--quiet";
      historyButton.textContent = "Afficher l’historique clinique autorisé";
      historyButton.setAttribute("aria-expanded", "false");
      const historyPanel = document.createElement("div");
      historyPanel.className = "nexa-provider-clinical__panel";
      historyPanel.hidden = true;
      historyPanel.id = `clinical-history-${appointment.appointmentId}`;
      historyButton.setAttribute("aria-controls", historyPanel.id);
      const historyFeedback = makeText("p", "nexa-provider-clinical__notice", "");
      historyFeedback.setAttribute("role", "status");
      historyFeedback.setAttribute("aria-live", "polite");
      const historyList = document.createElement("div");
      historyList.className = "nexa-provider-clinical__history-list";
      const historyMoreButton = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Charger les dossiers suivants");
      historyMoreButton.type = "button";
      historyMoreButton.hidden = true;
      const historyState = { cursor: "" };
      historyButton.addEventListener("click", () => {
        togglePriorClinicalHistory(appointment, historyButton, historyPanel, historyFeedback, historyList, historyMoreButton, historyState);
      });
      historyMoreButton.addEventListener("click", () => {
        void loadPriorClinicalHistoryPage(appointment, historyButton, historyFeedback, historyList, historyMoreButton, historyState, true);
      });
      historyPanel.append(historyFeedback, historyList, historyMoreButton);
      historySection.append(historyHelp, historyButton, historyPanel);
      item.append(historySection);
    }
    if (canOpenClinicalProfile(appointment)) {
      const prescriptionSection = document.createElement("section");
      prescriptionSection.className = "nexa-provider-clinical";
      const prescriptionButton = document.createElement("button");
      prescriptionButton.type = "button";
      prescriptionButton.className = "nexa-provider-button nexa-provider-button--quiet";
      prescriptionButton.textContent = "Gérer les ordonnances";
      prescriptionButton.setAttribute("aria-expanded", "false");
      const prescriptionPanel = document.createElement("div");
      prescriptionPanel.className = "nexa-provider-clinical__panel";
      prescriptionPanel.hidden = true;
      const prescriptionContent = document.createElement("div");
      prescriptionPanel.id = `clinical-prescriptions-${appointment.appointmentId}`;
      prescriptionContent.setAttribute("aria-live", "polite");
      prescriptionPanel.append(prescriptionContent);
      prescriptionButton.setAttribute("aria-controls", prescriptionPanel.id);
      prescriptionButton.addEventListener("click", () => { void toggleClinicalPrescriptions(appointment, prescriptionButton, prescriptionPanel, prescriptionContent); });
      const prescriptionHelp = document.createElement("p");
      prescriptionHelp.className = "nexa-provider-clinical__notice";
      prescriptionHelp.textContent = "Une ordonnance n’est créée et transmise que par le médecin associé, pendant la fenêtre de prise en charge autorisée.";
      prescriptionSection.append(prescriptionHelp, prescriptionButton, prescriptionPanel);
      item.append(prescriptionSection);
    }
    if (!homeVisit && appointment.bookingType === "teleconsultation" && appointment.status === "CONFIRMED" && appointment.paymentStatus === "PAID") {
      const accept = document.createElement("button");
      accept.type = "button";
      accept.className = "nexa-provider-button";
      accept.textContent = "Accepter";
      accept.setAttribute("aria-label", `Accepter le rendez-vous du ${slotDate(appointment.startsAt)}`);
      accept.addEventListener("click", () => { void acceptAppointment(appointment.appointmentId, accept); });
      const refuse = document.createElement("button");
      refuse.type = "button";
      refuse.className = "nexa-provider-button nexa-provider-button--quiet";
      refuse.textContent = "Refuser la téléconsultation";
      refuse.setAttribute("aria-label", `Refuser la téléconsultation du ${slotDate(appointment.startsAt)}`);
      refuse.addEventListener("click", () => { void refuseAppointment(appointment.appointmentId, appointment.amount, refuse); });
      item.append(accept, refuse);
    }
    if (!homeVisit && ["DOCTOR_ACCEPTED", "IN_PROGRESS"].includes(appointment.status)) {
      const join = document.createElement("a");
      join.className = "nexa-provider-link";
      join.href = `./teleconsultation.html?appointmentId=${encodeURIComponent(appointment.appointmentId)}`;
      join.textContent = "Ouvrir la séance vidéo";
      item.append(join);
    }
    return item;
  });
  appointmentsList.replaceChildren(...rows);
  appointmentsEmpty.hidden = appointments.length > 0;
}

async function loadAppointments() {
  if (!currentUser) return;
  const generation = authGeneration;
  const user = currentUser;
  appointmentsLoading.hidden = false;
  appointmentsError.hidden = true;
  appointmentsReloadButton.disabled = true;
  try {
    const result = await requestNexaFunction(user, "nexaProviderAppointments");
    if (generation !== authGeneration || currentUser !== user) return;
    const appointments = Array.isArray(result.appointments) ? result.appointments : [];
    renderAppointments(appointments);
    appointmentsLoading.hidden = true;
  } catch (error) {
    if (generation !== authGeneration || currentUser !== user) return;
    appointmentsLoading.hidden = true;
    appointmentsError.textContent = error instanceof NexaApiError ? error.message : "Les rendez-vous ne peuvent pas être chargés.";
    appointmentsError.hidden = false;
  } finally {
    if (generation === authGeneration) appointmentsReloadButton.disabled = false;
  }
}

function renderStandaloneRecords(records) {
  const rows = records.map((record) => {
    const item = document.createElement("li");
    const summary = document.createElement("div");
    summary.append(
      makeText("strong", "", record.patientName || "Patient NEXA"),
      makeText("span", "", `${record.patientNumber || "NMC indisponible"} · ${record.recordNumber || "Dossier NEXA"}`),
      makeText("small", "", `${["FINALIZED", "SIGNED"].includes(record.status) ? "Finalisé" : "Brouillon"}${record.accessExpiresAt ? ` · autorisation jusqu’au ${slotDate(record.accessExpiresAt)}` : ""}`),
    );
    const section = document.createElement("section");
    section.className = "nexa-provider-clinical";
    const button = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Ouvrir le dossier clinique");
    button.type = "button";
    button.dataset.recordId = record.recordId;
    button.setAttribute("aria-expanded", "false");
    const panel = document.createElement("div");
    panel.className = "nexa-provider-clinical__panel";
    panel.id = `standalone-clinical-record-${record.recordId}`;
    panel.hidden = true;
    button.setAttribute("aria-controls", panel.id);
    const content = document.createElement("div");
    panel.append(content);
    const context = { standalone: true, recordId: record.recordId, appointmentId: record.recordId };
    button.addEventListener("click", () => { void toggleClinicalRecord(context, button, panel, content); });
    section.append(button, panel);
    item.append(summary, section);
    return item;
  });
  standaloneRecordsList.replaceChildren(...rows);
  standaloneRecordsEmpty.hidden = records.length > 0;
}

async function loadStandaloneRecords() {
  if (!currentUser) return;
  const generation = authGeneration;
  const user = currentUser;
  standaloneRecordsLoading.hidden = false;
  standaloneRecordError.hidden = true;
  standaloneRecordsReloadButton.disabled = true;
  try {
    const result = await requestNexaFunction(user, "nexaProviderClinicalRecords");
    if (generation !== authGeneration || currentUser !== user) return;
    const records = Array.isArray(result.records) ? result.records : [];
    renderStandaloneRecords(records);
    standaloneRecordsLoading.hidden = true;
  } catch (error) {
    if (generation !== authGeneration || currentUser !== user) return;
    standaloneRecordsLoading.hidden = true;
    standaloneRecordError.textContent = error instanceof NexaApiError ? error.message : "Les dossiers autonomes ne peuvent pas être chargés.";
    standaloneRecordError.hidden = false;
  } finally {
    if (generation === authGeneration) standaloneRecordsReloadButton.disabled = false;
  }
}

async function openPatientResultFile(result, file, button) {
  if (!currentUser) return;
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = "Ouverture sécurisée…";
  try {
    const payload = await requestNexaFunction(currentUser, "nexaProviderPatientResultFile", "GET", undefined, {
      resultId: result.id,
      fileId: file.id,
    });
    const target = new URL(payload.url);
    if (target.protocol !== "https:" ||
      (target.hostname !== "storage.googleapis.com" && !target.hostname.endsWith(".storage.googleapis.com"))) {
      throw new Error("Le lien sécurisé du fichier n’est pas valide.");
    }
    const link = document.createElement("a");
    link.href = target.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", "Ouvrir le résultat " + file.fileName + " dans un nouvel onglet");
    document.body.append(link);
    link.click();
    link.remove();
    button.textContent = "Document ouvert";
  } catch (error) {
    button.textContent = error instanceof NexaApiError ? error.message : "Le document n’a pas pu être ouvert.";
  } finally {
    button.disabled = false;
    if (button.textContent === "Ouverture sécurisée…") button.textContent = previous;
  }
}

function resultActionField(labelText, name, options = {}) {
  const label = document.createElement("label");
  label.append(document.createTextNode(labelText));
  const field = options.multiline ? document.createElement("textarea") : document.createElement("input");
  field.name = name;
  field.required = options.required === true;
  if (options.multiline) {
    field.rows = options.rows || 3;
    field.maxLength = options.maxLength || 5_000;
  } else {
    field.type = options.type || "text";
    if (options.maxLength) field.maxLength = options.maxLength;
    if (options.min !== undefined) field.min = String(options.min);
    if (options.step !== undefined) field.step = String(options.step);
  }
  label.append(field);
  return { label, field };
}

function formatFollowUpSlot(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Créneau disponible";
  return new Intl.DateTimeFormat("fr-HT", {
    timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short",
  }).format(date);
}

async function submitPatientResultAction(result, action, values, feedback, button) {
  if (!currentUser) return;
  button.disabled = true;
  feedback.textContent = "Enregistrement sécurisé…";
  try {
    await requestNexaFunction(currentUser, "nexaProviderPatientResultFollowUp", "POST", {
      resultId: result.id, action, ...values,
    });
    feedback.textContent = action === "close"
      ? "Le suivi est terminé."
      : action === "review"
        ? "Le résultat est marqué comme examiné; l’accès de suivi reste ouvert."
        : "L’action de suivi a été enregistrée.";
    await loadPatientResultInbox();
  } catch (error) {
    feedback.textContent = error instanceof NexaApiError ? error.message : "L’action de suivi n’a pas pu être enregistrée.";
    button.disabled = false;
  }
}

function makeResultFollowUp(result, availableSlots) {
  const details = document.createElement("details");
  details.className = "nexa-provider-result-follow-up";
  const summary = document.createElement("summary");
  summary.textContent = "Actions de suivi médical";
  details.append(summary);
  const forms = document.createElement("div");
  forms.className = "nexa-provider-result-follow-up__forms";
  const feedback = makeText("p", "nexa-provider-result-follow-up__feedback");
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");

  if (result.followUpStatus === "EXAMINEE") {
    forms.append(makeText("p", "nexa-provider-help", "Résultat marqué comme examiné le " +
      (result.reviewedAt ? formatFollowUpSlot(result.reviewedAt) : "date indisponible") + "."));
  } else {
    const reviewButton = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Marquer le résultat comme examiné");
    reviewButton.type = "button";
    reviewButton.addEventListener("click", () => {
      void submitPatientResultAction(result, "review", {}, feedback, reviewButton);
    });
    forms.append(reviewButton);
  }

  const noteForm = document.createElement("form");
  noteForm.className = "nexa-provider-result-follow-up__form";
  noteForm.append(makeText("h4", "", "Ajouter une note signée au dossier"));
  const note = resultActionField("Note médicale", "note", { multiline: true, required: true, maxLength: 5_000 });
  noteForm.append(note.label);
  const noteButton = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Enregistrer la note signée");
  noteButton.type = "submit";
  noteForm.append(noteButton);
  noteForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!noteForm.reportValidity()) return;
    void submitPatientResultAction(result, "note", { note: note.field.value }, feedback, noteButton);
  });
  forms.append(noteForm);

  const prescriptionForm = document.createElement("form");
  prescriptionForm.className = "nexa-provider-result-follow-up__form";
  prescriptionForm.append(makeText("h4", "", "Créer une ordonnance de suivi"));
  const medication = {};
  for (const [key, label, options] of [
    ["name", "Médicament", { required: true, maxLength: 180 }],
    ["dosage", "Dosage", { maxLength: 120 }],
    ["form", "Forme", { maxLength: 120 }],
    ["route", "Voie d’administration", { maxLength: 120 }],
    ["quantity", "Quantité", { type: "number", min: 0, step: 1 }],
    ["duration", "Durée", { maxLength: 120 }],
    ["instructions", "Instructions", { multiline: true, maxLength: 500, rows: 2 }],
  ]) {
    const control = resultActionField(label, key, options);
    medication[key] = control.field;
    prescriptionForm.append(control.label);
  }
  const prescriptionNotes = resultActionField("Note sur l’ordonnance", "notes", { multiline: true, maxLength: 1_000, rows: 2 });
  prescriptionForm.append(prescriptionNotes.label);
  const prescriptionButton = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Valider et signer l’ordonnance");
  prescriptionButton.type = "submit";
  prescriptionForm.append(prescriptionButton);
  prescriptionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!prescriptionForm.reportValidity()) return;
    void submitPatientResultAction(result, "prescription", {
      medication: Object.fromEntries(Object.entries(medication).map(([key, field]) => [key, field.value.trim()])),
      notes: prescriptionNotes.field.value,
    }, feedback, prescriptionButton);
  });
  forms.append(prescriptionForm);

  const appointmentForm = document.createElement("form");
  appointmentForm.className = "nexa-provider-result-follow-up__form";
  appointmentForm.append(makeText("h4", "", "Proposer un rendez-vous de suivi"));
  const slotLabel = document.createElement("label");
  slotLabel.append(document.createTextNode("Créneau de téléconsultation"));
  const slotSelect = document.createElement("select");
  slotSelect.name = "slotId";
  slotSelect.required = true;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = availableSlots.length ? "Choisissez un créneau" : "Aucun créneau disponible";
  slotSelect.append(placeholder);
  for (const slot of availableSlots) {
    const option = document.createElement("option");
    option.value = slot.id;
    option.textContent = formatFollowUpSlot(slot.startsAt);
    slotSelect.append(option);
  }
  slotLabel.append(slotSelect);
  appointmentForm.append(slotLabel);
  const appointmentNote = resultActionField("Message au patient (facultatif)", "note", { multiline: true, maxLength: 300, rows: 2 });
  appointmentForm.append(appointmentNote.label);
  const appointmentButton = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Envoyer la proposition");
  appointmentButton.type = "submit";
  appointmentButton.disabled = availableSlots.length === 0;
  appointmentForm.append(appointmentButton);
  appointmentForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!appointmentForm.reportValidity()) return;
    void submitPatientResultAction(result, "appointment", {
      slotId: slotSelect.value, note: appointmentNote.field.value,
    }, feedback, appointmentButton);
  });
  forms.append(appointmentForm);

  const closeButton = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Terminer le suivi médical");
  closeButton.type = "button";
  closeButton.addEventListener("click", () => {
    if (window.confirm("Terminer le suivi et fermer l’accès du médecin à ce résultat ?")) {
      void submitPatientResultAction(result, "close", {}, feedback, closeButton);
    }
  });
  forms.append(closeButton, feedback);
  details.append(forms);
  return details;
}

function renderPatientResultInbox(results, availableSlots) {
  return results.map((result) => {
    const item = document.createElement("li");
    const summary = document.createElement("div");
    summary.append(
      makeText("strong", "", result.examName || "Résultat médical"),
      makeText("span", "", (result.patient?.name || "Patient NEXA") + " · " + (result.patient?.patientNumber || "NMC indisponible")),
      makeText("small", "", [result.patient?.sex, Number.isSafeInteger(result.patient?.age) ? result.patient.age + " ans" : ""].filter(Boolean).join(" · ") || "Informations patient limitées"),
    );
    if (result.createdAt) {
      summary.append(makeText("small", "", "Transmis le " + new Intl.DateTimeFormat("fr-HT", {
        timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short",
      }).format(new Date(result.createdAt))));
    }
    if (result.followUpStatus === "EXAMINEE" && result.reviewedAt) {
      summary.append(makeText("small", "", "Examiné le " + new Intl.DateTimeFormat("fr-HT", {
        timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short",
      }).format(new Date(result.reviewedAt))));
    } else if (result.followUpStatus === "RECU") {
      summary.append(makeText("small", "", "À examiner"));
    }
    item.append(summary);
    for (const file of Array.isArray(result.files) ? result.files : []) {
      const button = makeText("button", "nexa-provider-button nexa-provider-button--quiet", "Ouvrir le résultat · " + (file.category || "document"));
      button.type = "button";
      button.addEventListener("click", () => void openPatientResultFile(result, file, button));
      item.append(button);
    }
    item.append(makeResultFollowUp(result, availableSlots));
    return item;
  });
}

async function loadPatientResultInbox() {
  if (!currentUser) return;
  const generation = authGeneration;
  const user = currentUser;
  providerResultsLoading.hidden = false;
  providerResultsError.hidden = true;
  providerResultsEmpty.hidden = true;
  providerResultsReloadButton.disabled = true;
  providerResultsList.replaceChildren();
  try {
    const [result, availability] = await Promise.all([
      requestNexaFunction(user, "nexaProviderPatientResults"),
      requestNexaFunction(user, "nexaProviderAvailability").catch(() => ({ slots: [] })),
    ]);
    if (generation !== authGeneration || currentUser !== user) return;
    const items = Array.isArray(result.results) ? result.results : [];
    const slots = Array.isArray(availability.slots)
      ? availability.slots.filter((slot) => slot.status === "available" && slot.serviceType === "TELECONSULTATION" && /^[a-f0-9]{32}$/.test(slot.id))
      : [];
    providerResultsList.replaceChildren(...renderPatientResultInbox(items, slots));
    providerResultsEmpty.hidden = items.length > 0;
  } catch (error) {
    if (generation !== authGeneration || currentUser !== user) return;
    providerResultsError.textContent = error instanceof NexaApiError ? error.message : "Les résultats transmis ne sont pas accessibles pour le moment.";
    providerResultsError.hidden = false;
  } finally {
    if (generation === authGeneration) {
      providerResultsLoading.hidden = true;
      providerResultsReloadButton.disabled = false;
    }
  }
}

async function acceptAppointment(appointmentId, button) {
  if (!currentUser || busy) return;
  showMessage(notice, "");
  showMessage(errorBox, "");
  busy = true;
  button.disabled = true;
  button.textContent = "Acceptation…";
  try {
    await requestNexaFunction(currentUser, "nexaProviderAppointments", "POST", { appointmentId, action: "accept" });
    showMessage(notice, "Le rendez-vous est accepté. Vous pourrez rejoindre la séance à l’heure prévue.");
    await loadAppointments();
  } catch (error) {
    showMessage(errorBox, error instanceof NexaApiError ? error.message : "Le rendez-vous n’a pas pu être accepté.");
    button.disabled = false;
    button.textContent = "Accepter";
  } finally {
    busy = false;
  }
}

async function refuseAppointment(appointmentId, amount, button) {
  if (!currentUser || busy) return;
  const servicePrice = formatMoney(amount);
  const confirmed = window.confirm(
    `Refuser cette téléconsultation demandée par le patient? ${servicePrice} correspondant au prix du service sera crédité à son Wallet NEXA. Les frais de transaction ne seront pas remboursés.`,
  );
  if (!confirmed) return;
  showMessage(notice, "");
  showMessage(errorBox, "");
  busy = true;
  button.disabled = true;
  button.textContent = "Refus et remboursement…";
  try {
    await requestNexaFunction(currentUser, "nexaProviderAppointments", "POST", { appointmentId, action: "refuse" });
    showMessage(notice, `La téléconsultation est refusée. ${servicePrice} correspondant au prix du service ont été crédités au Wallet du patient; les frais de transaction ne sont pas remboursés.`);
    await loadAppointments();
  } catch (error) {
    showMessage(errorBox, error instanceof NexaApiError ? error.message : "Le refus et le crédit Wallet n’ont pas pu être enregistrés.");
    button.disabled = false;
    button.textContent = "Refuser la téléconsultation";
  } finally {
    busy = false;
  }
}

async function loadSlots() {
  if (!currentUser) return;
  const generation = authGeneration;
  const user = currentUser;
  slotsLoading.hidden = false;
  reloadButton.disabled = true;
  try {
    const result = await requestNexaFunction(user, "nexaProviderAvailability");
    if (generation !== authGeneration || currentUser !== user) return null;
    const services = result.services || {};
    homeVisitOption.hidden = services.homeVisit !== true;
    homeVisitNote.hidden = services.homeVisit === true;
    if (services.homeVisit !== true && serviceSelect.value === "HOME_VISIT") serviceSelect.value = "TELECONSULTATION";
    const slots = Array.isArray(result.slots) ? result.slots : [];
    renderSlots(slots);
    slotsLoading.hidden = true;
    return result;
  } catch (error) {
    if (generation !== authGeneration || currentUser !== user) return null;
    slotsLoading.hidden = true;
    showMessage(errorBox, error instanceof NexaApiError ? error.message : "Les créneaux ne peuvent pas être chargés.");
    return null;
  } finally {
    if (generation === authGeneration) reloadButton.disabled = false;
  }
}

async function loadProvider(user) {
  const generation = ++authGeneration;
  currentUser = null;
  busy = false;
  clearProviderPrivateState();
  loading.hidden = false;
  loginPanel.hidden = true;
  deniedPanel.hidden = true;
  editor.hidden = true;
  showMessage(loginError, "");
  if (!user) {
    loading.hidden = true;
    loginPanel.hidden = false;
    return;
  }
  currentUser = user;
  try {
    const result = await requestNexaFunction(user, "nexaProviderAvailability");
    if (generation !== authGeneration || currentUser !== user) return;
    providerName.textContent = result.provider?.name || "Médecin NEXA";
    editor.hidden = false;
    loading.hidden = true;
    setDateBounds();
    renderSlots(Array.isArray(result.slots) ? result.slots : []);
    void loadDoctorProfilePhoto(user);
    void loadProviderNotifications();
    void loadAppointments();
    void loadStandaloneRecords();
    void loadPatientResultInbox();
    const services = result.services || {};
    homeVisitOption.hidden = services.homeVisit !== true;
    homeVisitNote.hidden = services.homeVisit === true;
  } catch (error) {
    if (generation !== authGeneration || currentUser !== user) return;
    loading.hidden = true;
    deniedPanel.hidden = false;
    deniedMessage.textContent = error instanceof NexaApiError
      ? error.message
      : "Le portail professionnel est momentanément indisponible.";
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage(loginError, "");
  showMessage(passwordResetNotice, "");
  loginButton.disabled = true;
  try {
    await getAppCheckToken();
    const email = String(loginForm.elements.email.value || "").trim();
    const password = String(loginForm.elements.password.value || "");
    if (!email || !password) throw new Error("Saisissez l’adresse e-mail et le mot de passe de votre compte professionnel.");
    await firebaseAuthActions.signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : "";
    const message = error instanceof NexaApiError
      ? error.message
      : ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"].includes(code)
        ? "Adresse e-mail ou mot de passe incorrect."
        : "La connexion professionnelle n’a pas abouti. Vérifiez vos identifiants puis réessayez.";
    showMessage(loginError, message);
  } finally {
    loginButton.disabled = false;
  }
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

profilePhotoFile.addEventListener("change", () => {
  showMessage(profilePhotoError, "");
  const file = profilePhotoFile.files?.[0];
  if (!file) return;
  profilePhotoConsent.checked = false;
  if (profilePhotoPreviewObjectUrl) URL.revokeObjectURL(profilePhotoPreviewObjectUrl);
  profilePhotoPreviewObjectUrl = URL.createObjectURL(file);
  profilePhotoPreview.src = profilePhotoPreviewObjectUrl;
  profilePhotoPreview.hidden = false;
});

profilePhotoUploadButton.addEventListener("click", async () => {
  showMessage(profilePhotoError, "");
  if (!currentUser) return;
  const file = profilePhotoFile.files?.[0];
  if (!file) {
    showMessage(profilePhotoError, "Choisissez d’abord une photo.");
    return;
  }
  if (!profilePhotoConsent.checked) {
    showMessage(profilePhotoError, "Confirmez que cette photo peut apparaître dans le répertoire public après approbation NEXA.");
    return;
  }
  profilePhotoUploadButton.disabled = true;
  profilePhotoUploadButton.textContent = "Préparation et analyse…";
  try {
    const photoBase64 = await doctorPhotoBase64(file);
    const result = await requestNexaFunction(currentUser, "nexaDoctorProfilePhoto", "POST", {
      photoBase64,
      consentToPublicDisplay: true,
    });
    renderDoctorProfilePhoto({ ...result, consentToPublicDisplay: true });
    profilePhotoFile.value = "";
  } catch (error) {
    showMessage(profilePhotoError, error instanceof NexaApiError ? error.message : error.message || "La photo ne peut pas être envoyée pour le moment.");
  } finally {
    profilePhotoUploadButton.disabled = false;
    profilePhotoUploadButton.textContent = "Téléverser la photo";
  }
});

standaloneRecordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage(standaloneRecordFeedback, "");
  showMessage(standaloneRecordError, "");
  if (!currentUser || busy || !standaloneRecordForm.reportValidity()) return;
  const user = currentUser;
  const generation = authGeneration;
  const patientNumber = standalonePatientNumber.value.trim().toUpperCase();
  const accessCode = standaloneAccessCode.value;
  let claimedRecordId = "";
  standaloneAccessCode.value = "";
  busy = true;
  standaloneRecordSubmit.disabled = true;
  showMessage(standaloneRecordFeedback, "Vérification de l’autorisation et ouverture du dossier…");
  try {
    const result = await requestNexaFunction(user, "nexaProviderClinicalRecords", "POST", { patientNumber, accessCode });
    if (generation !== authGeneration || currentUser !== user) return;
    claimedRecordId = typeof result.recordId === "string" ? result.recordId : "";
    showMessage(standaloneRecordFeedback, result.created
      ? "L’autorisation est validée. Le dossier est ouvert pour 24 heures."
      : "Cette autorisation donne déjà accès au dossier jusqu’à son expiration.");
  } catch (error) {
    if (generation !== authGeneration || currentUser !== user) return;
    standaloneRecordError.textContent = error instanceof NexaApiError ? error.message : "Le dossier ne peut pas être ouvert avec cette autorisation.";
    standaloneRecordError.hidden = false;
  } finally {
    if (generation === authGeneration) {
      busy = false;
      standaloneRecordSubmit.disabled = false;
    }
  }
  if (generation !== authGeneration || currentUser !== user) return;
  await loadStandaloneRecords();
  if (claimedRecordId) {
    const openButton = [...standaloneRecordsList.querySelectorAll("button[data-record-id]")]
      .find((button) => button.dataset.recordId === claimedRecordId);
    if (openButton) openButton.click();
  }
});

availabilityForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage(notice, "");
  showMessage(errorBox, "");
  if (!currentUser || busy) return;
  const startsAt = haitiLocalToIso(startsAtInput.value);
  if (!startsAt) {
    showMessage(errorBox, "Choisissez une heure valide en heure d’Haïti, à l’heure pleine ou à la demi-heure.");
    return;
  }
  busy = true;
  submitButton.disabled = true;
  submitButton.textContent = "Publication…";
  try {
    const result = await requestNexaFunction(currentUser, "nexaProviderAvailability", "POST", {
      startsAt: [startsAt],
      serviceType: serviceSelect.value,
    });
    showMessage(notice, result.created
      ? serviceSelect.value === "HOME_VISIT" ? "Le créneau d’une heure est publié." : "Le créneau de téléconsultation est publié."
      : "Ce créneau était déjà publié pour ce service.");
    availabilityForm.reset();
    setDateBounds();
    await loadSlots();
  } catch (error) {
    showMessage(errorBox, error instanceof NexaApiError ? error.message : "Le créneau n’a pas pu être publié.");
  } finally {
    busy = false;
    submitButton.disabled = false;
    submitButton.textContent = "Publier le créneau";
  }
});

async function removeSlot(slotId, button) {
  if (!currentUser || busy) return;
  showMessage(errorBox, "");
  showMessage(notice, "");
  busy = true;
  button.disabled = true;
  try {
    await requestNexaFunction(currentUser, "nexaProviderAvailability", "DELETE", { slotId });
    showMessage(notice, "Le créneau a été retiré.");
    await loadSlots();
  } catch (error) {
    showMessage(errorBox, error instanceof NexaApiError ? error.message : "Le créneau n’a pas pu être retiré.");
    button.disabled = false;
  } finally {
    busy = false;
  }
}

serviceSelect.addEventListener("change", () => {
  submitButton.textContent = serviceSelect.value === "HOME_VISIT" ? "Publier la visite d’une heure" : "Publier le créneau";
});
reloadButton.addEventListener("click", () => void loadSlots());
appointmentsReloadButton.addEventListener("click", () => void loadAppointments());
providerNotificationsReloadButton.addEventListener("click", () => void loadProviderNotifications());
standaloneRecordsReloadButton.addEventListener("click", () => void loadStandaloneRecords());
providerResultsReloadButton.addEventListener("click", () => void loadPatientResultInbox());
signOutButton.addEventListener("click", async () => {
  await firebaseAuthActions.signOut(auth);
});
firebaseAuthActions.onAuthStateChanged(auth, (user) => { void loadProvider(user); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && currentUser) {
    void loadProviderNotifications();
    void loadStandaloneRecords();
  }
});
window.setInterval(() => {
  if (!document.hidden && currentUser) void loadProviderNotifications({ silent: true });
}, 60_000);
document.querySelector("#current-year").textContent = String(new Date().getFullYear());
setDateBounds();
