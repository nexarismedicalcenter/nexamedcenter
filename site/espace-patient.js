import { auth, firebaseApp, downloadNexaPdf, firebaseAuthActions, initializePatientProfile, requestNexaFunction, NexaApiError } from "./firebase-client.js";

const loading = document.querySelector("#space-loading");
const content = document.querySelector("#space-content");
const identity = document.querySelector("#space-identity");
const number = document.querySelector("#space-patient-number");
const errorBox = document.querySelector("#space-error");
const signOutButton = document.querySelector("#sign-out");
const retryButton = document.querySelector("#retry-space");
const notificationsSection = document.querySelector("#notifications-section");
const notificationsCount = document.querySelector("#notifications-count");
const notificationsLoading = document.querySelector("#notifications-loading");
const notificationsError = document.querySelector("#notifications-error");
const notificationsEmpty = document.querySelector("#notifications-empty");
const notificationsList = document.querySelector("#notifications-list");
const retryNotificationsButton = document.querySelector("#retry-notifications");
const notificationPreferencesLoading = document.querySelector("#notification-preferences-loading");
const notificationEmailToggle = document.querySelector("#notification-email");
const notificationEmailHint = document.querySelector("#notification-email-hint");
const notificationPushButton = document.querySelector("#notification-push");
const notificationPushHint = document.querySelector("#notification-push-hint");
const notificationPreferencesError = document.querySelector("#notification-preferences-error");
const notificationPreferencesStatus = document.querySelector("#notification-preferences-status");
const walletSection = document.querySelector("#wallet-section");
const walletLoading = document.querySelector("#wallet-loading");
const walletError = document.querySelector("#wallet-error");
const walletContent = document.querySelector("#wallet-content");
const walletBalance = document.querySelector("#wallet-balance");
const walletStatus = document.querySelector("#wallet-status");
const walletEmpty = document.querySelector("#wallet-empty");
const walletEntries = document.querySelector("#wallet-entries");
const retryWalletButton = document.querySelector("#retry-wallet");
const ordersSection = document.querySelector("#commandes");
const ordersLoading = document.querySelector("#orders-loading");
const ordersError = document.querySelector("#orders-error");
const ordersEmpty = document.querySelector("#orders-empty");
const ordersList = document.querySelector("#orders-list");
const retryOrdersButton = document.querySelector("#retry-orders");
const loadMoreOrdersButton = document.querySelector("#load-more-orders");
const patientNursingVisitsLoading = document.querySelector("#patient-nursing-visits-loading");
const patientNursingVisitsError = document.querySelector("#patient-nursing-visits-error");
const retryPatientNursingVisitsButton = document.querySelector("#retry-patient-nursing-visits");
const loadMorePatientNursingVisitsButton = document.querySelector("#load-more-patient-nursing-visits");
const appointmentsSection = document.querySelector("#appointments-section");
const appointmentsLoading = document.querySelector("#appointments-loading");
const appointmentsError = document.querySelector("#appointments-error");
const appointmentsEmpty = document.querySelector("#appointments-empty");
const appointmentsList = document.querySelector("#appointments-list");
const retryAppointmentsButton = document.querySelector("#retry-appointments");
const loadMoreAppointmentsButton = document.querySelector("#load-more-appointments");
const homeVisitReportsSection = document.querySelector("#home-visit-reports-section");
const homeVisitReportsLoading = document.querySelector("#home-visit-reports-loading");
const homeVisitReportsError = document.querySelector("#home-visit-reports-error");
const homeVisitReportsEmpty = document.querySelector("#home-visit-reports-empty");
const homeVisitReportsList = document.querySelector("#home-visit-reports-list");
const reloadHomeVisitReportsButton = document.querySelector("#reload-home-visit-reports");
const homeVisitReportsPaginationStatus = document.querySelector("#home-visit-reports-pagination-status");
const loadMoreHomeVisitReportsButton = document.querySelector("#load-more-home-visit-reports");
const nursingReportsSection = document.querySelector("#nursing-reports-section");
const nursingReportsLoading = document.querySelector("#nursing-reports-loading");
const nursingReportsError = document.querySelector("#nursing-reports-error");
const nursingReportsEmpty = document.querySelector("#nursing-reports-empty");
const nursingReportsList = document.querySelector("#nursing-reports-list");
const reloadNursingReportsButton = document.querySelector("#reload-nursing-reports");
const nursingReportsPaginationStatus = document.querySelector("#nursing-reports-pagination-status");
const loadMoreNursingReportsButton = document.querySelector("#load-more-nursing-reports");
const standaloneRecordsSection = document.querySelector("#standalone-records-section");
const standaloneRecordsLoading = document.querySelector("#standalone-records-loading");
const standaloneRecordsError = document.querySelector("#standalone-records-error");
const standaloneRecordsEmpty = document.querySelector("#standalone-records-empty");
const standaloneRecordsList = document.querySelector("#standalone-records-list");
const reloadStandaloneRecordsButton = document.querySelector("#reload-standalone-records");
const standaloneRecordsPaginationStatus = document.querySelector("#standalone-records-pagination-status");
const loadMoreStandaloneRecordsButton = document.querySelector("#load-more-standalone-records");
const prescriptionsSection = document.querySelector("#prescriptions-section");
const prescriptionsLoading = document.querySelector("#prescriptions-loading");
const prescriptionsError = document.querySelector("#prescriptions-error");
const prescriptionsEmpty = document.querySelector("#prescriptions-empty");
const prescriptionsList = document.querySelector("#prescriptions-list");
const retryPrescriptionsButton = document.querySelector("#retry-prescriptions");
const patientResultsSection = document.querySelector("#patient-results-section");
const patientResultsLoading = document.querySelector("#patient-results-loading");
const patientResultsError = document.querySelector("#patient-results-error");
const patientResultsNotice = document.querySelector("#patient-results-notice");
const patientResultsEmpty = document.querySelector("#patient-results-empty");
const patientResultsList = document.querySelector("#patient-results-list");
const patientResultsUploadList = document.querySelector("#patient-results-upload-list");
const reloadPatientResultsButton = document.querySelector("#reload-patient-results");
const medicalSection = document.querySelector("#medical-profile-section");
const medicalLoading = document.querySelector("#medical-loading");
const medicalForm = document.querySelector("#medical-profile-form");
const medicalError = document.querySelector("#medical-error");
const medicalNotice = document.querySelector("#medical-notice");
const retryMedicalButton = document.querySelector("#retry-medical");
const saveMedicalButton = document.querySelector("#save-medical-profile");
const medicalIdentity = {
  name: document.querySelector("#medical-identity-name"),
  birthDate: document.querySelector("#medical-identity-birth-date"),
  age: document.querySelector("#medical-identity-age"),
  sex: document.querySelector("#medical-identity-sex"),
};
const clinicalAccessSection = document.querySelector("#clinical-access-section");
const clinicalAccessForm = document.querySelector("#clinical-access-form");
const clinicalAccessProvider = document.querySelector("#clinical-access-provider");
const clinicalAccessSubmit = document.querySelector("#clinical-access-submit");
const clinicalAccessStatus = document.querySelector("#clinical-access-status");
const clinicalAccessError = document.querySelector("#clinical-access-error");
const clinicalAccessCodePanel = document.querySelector("#clinical-access-code-panel");
const clinicalAccessCodeProvider = document.querySelector("#clinical-access-code-provider");
const clinicalAccessCode = document.querySelector("#clinical-access-code");
const clinicalAccessCodeExpiry = document.querySelector("#clinical-access-code-expiry");
const clinicalAccessCopyButton = document.querySelector("#clinical-access-copy");
const clinicalAccessReloadButton = document.querySelector("#clinical-access-reload");
const clinicalAccessLoading = document.querySelector("#clinical-access-loading");
const clinicalAccessListError = document.querySelector("#clinical-access-list-error");
const clinicalAccessEmpty = document.querySelector("#clinical-access-empty");
const clinicalAccessList = document.querySelector("#clinical-access-list");
let handled = false;
let currentUser = null;
let patientOrdersCursor = "";
let patientOrdersHasMore = false;
let patientOrdersLoading = false;
let patientOrdersGeneration = 0;
let patientNursingVisitsCursor = "";
let patientNursingVisitsHasMore = false;
let patientNursingVisitsLoadingState = false;
let patientNursingVisitsGeneration = 0;
const patientNursingVisitsByOrder = new Map();
let homeVisitReportsCursor = "";
let homeVisitReportsHasMore = false;
let homeVisitReportsRequestActive = false;
let nursingReportsCursor = "";
let nursingReportsHasMore = false;
let nursingReportsRequestActive = false;
let standaloneRecordsCursor = "";
let standaloneRecordsHasMore = false;
let standaloneRecordsRequestActive = false;
let notificationPreferences = null;
let notificationVapidKey = "";
let foregroundPushUnsubscribe = () => {};
let notifications = [];
let lastIssuedClinicalAccessGrantId = "";
let appointmentsCursor = "";
let appointmentsHasMore = false;
let appointmentsRequestActive = false;
let appointmentsGeneration = 0;

const appointmentStatusLabels = {
  PENDING_PAYMENT: "Paiement en attente",
  CONFIRMED: "Confirmé",
  PAYMENT_EXPIRED: "Réservation expirée",
  PAYMENT_CONFLICT_REFUND_REQUIRED: "Paiement à régulariser avec NEXA",
  PROVIDER_NO_SHOW_REFUND_REQUIRED: "Absence signalée · suivi NEXA requis",
  PATIENT_NO_SHOW_RETAINED: "Téléconsultation manquée",
  REFUNDED: "Remboursé dans le portefeuille NEXA",
  DOCTOR_ACCEPTED: "Confirmé par le médecin",
  IN_PROGRESS: "Séance en cours",
  COMPLETED: "Terminé",
  PROVIDER_REFUSED: "Téléconsultation refusée par le médecin",
};

const homeVisitMissionLabels = {
  AWAITING_PAYMENT: "En attente de paiement",
  SCHEDULED: "Payée · visite à réaliser",
  AWAITING_PROVIDER_CODE: "Confirmation reçue · clôture du médecin en attente",
  ADMIN_REVIEW_REQUIRED: "Vérification NEXA requise",
  PROVIDER_ABSENT_REFUND_REQUIRED: "Absence signalée · remboursement en cours",
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

const diagnosticOrderStatusLabels = {
  PENDING_PAYMENT: "Paiement en attente",
  PAID: "Payée · en attente du partenaire",
  ACCEPTED: "Acceptée par le centre",
  PREPARING: "En préparation par la pharmacie",
  READY: "Prête · remise en cours",
  PATIENT_PRESENTED: "Présence confirmée",
  SAMPLE_COLLECTED: "Prélèvement effectué",
  SAMPLE_RECEIVED: "Échantillon reçu au laboratoire",
  ANALYSIS_IN_PROGRESS: "Analyse en cours",
  EXAM_IN_PROGRESS: "Examen en cours",
  EXAM_COMPLETED: "Examen réalisé · résultat à venir",
  COMPLETED: "Terminée",
  PROVIDER_REFUSED: "Refusée · remboursement à vérifier par NEXA",
  REFUNDED: "Prix du service remboursé au Wallet NEXA",
  PAYMENT_CONFLICT_REFUND_REQUIRED: "Paiement à rapprocher par NEXA",
  PAYMENT_REVIEW_REQUIRED: "Paiement à rapprocher par NEXA",
  EXPIRED: "Commande expirée · stock libéré",
  PAYMENT_EXPIRED: "Réservation expirée · période libérée",
};

const nursingVisitStatusLabels = {
  SCHEDULED: "Horaire convenu · compte rendu disponible après la visite",
  AWAITING_PROVIDER_CODE: "Compte rendu confirmé · clôture infirmière en attente",
  ADMIN_REVIEW_REQUIRED: "Écart signalé · vérification NEXA requise",
  CASH_REFUND_PENDING: "Demande d’espèces transmise à l’administration",
  REFUND_PENDING_ADMIN: "Remboursement de la période autorisé · crédit Wallet en attente",
  COMPLETED: "Prestation clôturée",
  REFUNDED: "Période remboursée",
};

function makeText(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value || "";
  return node;
}

function appointmentDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "Horaire à confirmer";
  return new Intl.DateTimeFormat("fr-HT", {
    timeZone: "America/Port-au-Prince",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function haitiLocalToIso(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return "";
  const [, year, month, day, hour, minute] = match;
  const target = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  let instant = target;
  for (let index = 0; index < 4; index += 1) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Port-au-Prince", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    const difference = target - represented;
    if (!difference) break;
    instant += difference;
  }
  return Number.isFinite(instant) ? new Date(instant).toISOString() : "";
}

function formatMoney(value) {
  return new Intl.NumberFormat("fr-HT", { maximumFractionDigits: 0 }).format(value) + " HTG";
}

function formatMinorMoney(value) {
  return new Intl.NumberFormat("fr-HT", { maximumFractionDigits: 2 }).format(Number(value || 0) / 100) + " HTG";
}

async function resumeMoncashPayment(paymentRef, button, message) {
  if (!currentUser) return;
  button.disabled = true;
  button.textContent = "Vérification du paiement…";
  message.textContent = "";
  try {
    const returnPage = new URL("./paiement/retour/", window.location.href);
    returnPage.searchParams.set("paymentRef", paymentRef);
    let payment;
    try {
      payment = await requestNexaFunction(currentUser, "appointmentMoncashStatus", "POST", { paymentRef });
    } catch (error) {
      if (!(error instanceof NexaApiError) || error.code !== "payment-not-found") throw error;
    }
    if (payment?.status === "paid") {
      window.location.assign(returnPage.href);
      return;
    }
    if (payment && payment.status !== "pending") {
      throw new Error("Le paiement est en cours de vérification. Ne payez pas une seconde fois; vérifiez de nouveau dans un instant.");
    }
    if (!payment) {
      payment = await requestNexaFunction(currentUser, "appointmentMoncashCreate", "POST", { paymentRef });
      if (payment.status === "paid") {
        window.location.assign(returnPage.href);
        return;
      }
    }
    const checkoutUrl = new URL(String(payment.checkoutUrl || ""));
    if (payment.status !== "pending" || checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "moncashbutton.digicelgroup.com") {
      throw new Error("Le lien de paiement n’a pas pu être validé.");
    }
    window.location.assign(checkoutUrl.href);
  } catch (error) {
    message.textContent = error instanceof NexaApiError
      ? error.message
      : "Le paiement ne peut pas être repris pour le moment. Actualisez vos rendez-vous et vérifiez le statut avant une nouvelle tentative.";
    button.disabled = false;
    button.textContent = "Réessayer avec MonCash";
  }
}

async function payAppointmentWithWallet(paymentRef, button, message) {
  if (!currentUser) return;
  button.disabled = true;
  button.textContent = "Paiement Wallet en cours…";
  message.textContent = "";
  try {
    const payment = await requestNexaFunction(currentUser, "appointmentWalletPay", "POST", { paymentRef });
    if (payment.status !== "paid") throw new Error("Le paiement Wallet n’a pas été confirmé.");
    message.textContent = "Paiement confirmé. Le prix du service et les frais de transaction ont été débités de votre Wallet NEXA.";
    button.textContent = "Paiement confirmé";
    await Promise.all([loadWallet(), loadAppointments()]);
  } catch (error) {
    message.textContent = error instanceof NexaApiError
      ? error.message
      : error instanceof Error ? error.message : "Le paiement Wallet n’a pas pu être confirmé. Vérifiez votre portefeuille avant de réessayer.";
    button.disabled = false;
    button.textContent = "Payer avec Wallet NEXA";
  }
}

async function resumeDiagnosticOrderMoncash(paymentRef, button, message, kind = "diagnostic") {
  if (!currentUser) return;
  button.disabled = true;
  button.textContent = "Préparation de MonCash…";
  message.textContent = "";
  try {
    const endpoint = kind === "pharmacy" ? "pharmacyOrderMoncashCreate"
      : kind === "nursing" ? "nexaNursingOrderMoncashCreate"
        : "diagnosticOrderMoncashCreate";
    const payment = await requestNexaFunction(currentUser, endpoint, "POST", { paymentRef });
    if (payment.status === "paid") {
      const returnPage = new URL("./paiement/retour/", window.location.href);
      returnPage.searchParams.set("paymentRef", paymentRef);
      window.location.assign(returnPage.href);
      return;
    }
    const checkoutUrl = new URL(String(payment.checkoutUrl || ""));
    if (payment.status !== "pending" || checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "moncashbutton.digicelgroup.com") throw new Error("Le lien de paiement n’a pas pu être validé.");
    window.location.assign(checkoutUrl.href);
  } catch (error) {
    message.textContent = error instanceof NexaApiError ? error.message : "MonCash ne peut pas être préparé pour le moment. Vérifiez le statut avant de réessayer.";
    button.disabled = false;
    button.textContent = "Reprendre avec MonCash";
  }
}

async function payDiagnosticOrderWithWallet(orderId, button, message, kind = "diagnostic") {
  if (!currentUser) return;
  button.disabled = true;
  button.textContent = "Paiement Wallet en cours…";
  message.textContent = "";
  try {
    const endpoint = kind === "pharmacy" ? "nexaPharmacyOrderWalletPay"
      : kind === "nursing" ? "nexaNursingOrderWalletPay"
        : "nexaDiagnosticOrderWalletPay";
    const result = await requestNexaFunction(currentUser, endpoint, "POST", { orderId });
    if (result.status !== "paid") throw new Error("Le paiement Wallet n’a pas été confirmé.");
    message.textContent = "Paiement confirmé. Le montant de la commande et les frais de transaction ont été débités du Wallet NEXA.";
    button.textContent = "Paiement confirmé";
    await Promise.all([loadWallet(), loadOrders()]);
  } catch (error) {
    message.textContent = error instanceof NexaApiError ? error.message : error instanceof Error ? error.message : "Le paiement Wallet n’a pas abouti.";
    button.disabled = false;
    button.textContent = "Payer avec Wallet NEXA";
  }
}

async function requestDiagnosticCashRefund(orderId, button, message) {
  if (!currentUser) return;
  button.disabled = true;
  button.textContent = "Enregistrement de la demande…";
  message.textContent = "";
  try {
    await requestNexaFunction(currentUser, "nexaPatientRequestDiagnosticCashRefund", "POST", { orderId });
    message.textContent = "Votre demande de remboursement en espèces est transmise à l’administration pour traitement manuel. Les frais de transaction ne sont pas remboursés.";
    await loadOrders();
  } catch (error) {
    message.textContent = error instanceof NexaApiError ? error.message : "La demande en espèces n’a pas pu être enregistrée.";
    button.disabled = false;
    button.textContent = "Demander un remboursement en espèces";
  }
}

async function updateTeleconsultationRefundPreference(appointmentId, refundMethod, button, message) {
  if (!currentUser) return;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Enregistrement…";
  message.textContent = "";
  try {
    const result = await requestNexaFunction(currentUser, "nexaPatientTeleconsultationCashRefundPreference", "POST", {
      appointmentId,
      refundMethod,
    });
    if (result.refundStatus === "PENDING_MANUAL_CASH") {
      message.textContent = "Votre demande de remboursement en espèces est transmise à l’administration NEXA. Les frais de transaction ne sont pas remboursés.";
    } else if (refundMethod === "CASH_MANUAL") {
      message.textContent = "Votre préférence est enregistrée. Si le médecin n’accepte jamais cette téléconsultation payée, le dossier restera en attente d’examen administratif; votre demande en espèces sera traitée manuellement. Si NEXA confirme l’absence du médecin après deux appels initiés par vous et restés sans réponse du médecin, l’administration traitera aussi votre demande manuellement. Les frais de transaction ne sont pas remboursés.";
    } else {
      message.textContent = "Votre préférence en espèces est annulée. Si le médecin n’accepte jamais cette téléconsultation payée, le dossier restera en attente d’examen administratif, sans remboursement automatique; l’administration décidera de la suite pour le prix du service. Après deux appels initiés par vous et restés sans réponse du médecin pendant une consultation acceptée, le prix du service sera crédité au Wallet. Les frais de transaction ne sont pas remboursés.";
    }
    await loadAppointments();
  } catch (error) {
    message.textContent = error instanceof NexaApiError ? error.message : "La préférence de remboursement n’a pas pu être enregistrée.";
    button.disabled = false;
    button.textContent = originalText;
  }
}

const patientClinicalFieldLabels = {
  consultationReason: "Motif de consultation", history: "Histoire de la maladie",
  relevantHistory: "Antécédents pertinents", allergies: "Allergies", currentTreatments: "Traitements actuels",
  symptoms: "Symptômes rapportés", clinicalObservations: "Observations cliniques",
  clinicalAssessment: "Évaluation clinique", diagnoses: "Diagnostics", carePlan: "Conduite à tenir",
  recommendations: "Recommandations", followUp: "Suivi recommandé", additionalNotes: "Notes complémentaires",
};

function renderPatientClinicalRecord(container, record) {
  container.replaceChildren();
  if (!record) {
    container.append(makeText("p", "nexa-patient-appointments__record-message", "Le médecin n’a pas encore finalisé le compte rendu."));
    return;
  }
  const title = makeText("strong", "", "Compte rendu finalisé par " + (record.providerName || "votre médecin"));
  const meta = makeText("p", "nexa-patient-appointments__record-message", [
    record.specialtyName,
    record.finalizedAt ? "Finalisé le " + appointmentDate(record.finalizedAt) : "",
  ].filter(Boolean).join(" · "));
  container.append(title, meta);
  const clinicalContent = record.clinicalContent || {};
  for (const [field, label] of Object.entries(patientClinicalFieldLabels)) {
    const value = typeof clinicalContent[field] === "string" ? clinicalContent[field].trim() : "";
    if (value) container.append(makeText("p", "nexa-patient-appointments__record-detail", `${label} : ${value}`));
  }
  const vitals = clinicalContent.patientVitals && typeof clinicalContent.patientVitals === "object" ? clinicalContent.patientVitals : {};
  const vitalNames = {
    systolic: "Tension systolique", diastolic: "Tension diastolique", heartRate: "Fréquence cardiaque",
    respiratoryRate: "Fréquence respiratoire", spo2: "Saturation en oxygène", glycemia: "Glycémie",
    temperature: "Température", weight: "Poids", height: "Taille",
  };
  const vitalText = Object.entries(vitalNames).map(([field, label]) => {
    const value = vitals[field];
    return value === null || value === undefined || value === "" ? "" : `${label} : ${value}`;
  }).filter(Boolean).join(" · ");
  if (vitalText) container.append(makeText("p", "nexa-patient-appointments__record-detail", "Signes vitaux : " + vitalText));
  const medications = Array.isArray(clinicalContent.medications) ? clinicalContent.medications : [];
  for (const medication of medications) {
    if (!medication || typeof medication !== "object" || !medication.name) continue;
    const details = [medication.dosage, medication.form, medication.route, medication.duration].filter(Boolean).join(" · ");
    const instructions = [details, medication.quantity != null ? `Quantité : ${medication.quantity}` : "", medication.instructions].filter(Boolean).join(" — ");
    container.append(makeText("p", "nexa-patient-appointments__record-detail", `${medication.name}${instructions ? ` · ${instructions}` : ""}`));
  }
  for (const [field, label] of [["laboratoryTests", "Examens de laboratoire"], ["imagingExams", "Examens d’imagerie"]]) {
    const entries = Array.isArray(clinicalContent[field]) ? clinicalContent[field].filter((entry) => typeof entry === "string" && entry.trim()) : [];
    if (entries.length) container.append(makeText("p", "nexa-patient-appointments__record-detail", `${label} : ${entries.join(" · ")}`));
  }
  if (record.signature?.name) {
    container.append(makeText("p", "nexa-patient-appointments__record-message", `Signé par ${record.signature.name}${record.signature.specialty ? ` · ${record.signature.specialty}` : ""}${record.signature.signedAt ? ` · ${appointmentDate(record.signature.signedAt)}` : ""}`));
  }
  const recordId = record.recordId || record.appointmentId;
  const attachments = Array.isArray(record.attachments) ? record.attachments : [];
  if (recordId && attachments.length) {
    const attachmentSection = document.createElement("section");
    attachmentSection.className = "nexa-patient-appointments__record-correction";
    attachmentSection.append(makeText("strong", "", "Pièces jointes cliniques"));
    for (const attachment of attachments) {
      if (!attachment || typeof attachment.id !== "string") continue;
      const row = document.createElement("div");
      const openButton = makeText("button", "nexa-patient-appointments__pay nexa-patient-appointments__pay--secondary",
        (attachment.originalFileName || "Pièce jointe") + " · Ouvrir");
      openButton.type = "button";
      openButton.addEventListener("click", async () => {
        if (!currentUser || openButton.disabled) return;
        openButton.disabled = true;
        const previous = openButton.textContent;
        openButton.textContent = "Ouverture sécurisée…";
        try {
          const result = await requestNexaFunction(currentUser, "nexaClinicalRecordAttachments", "GET", undefined, {
            recordId,
            attachmentId: attachment.id,
          });
          const target = new URL(result.url);
          if (target.protocol !== "https:" ||
            (target.hostname !== "storage.googleapis.com" && !target.hostname.endsWith(".storage.googleapis.com"))) {
            throw new Error("invalid-clinical-attachment-url");
          }
          const anchor = document.createElement("a");
          anchor.href = target.href;
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          anchor.setAttribute("aria-label", "Ouvrir la pièce jointe " + attachment.originalFileName + " dans un nouvel onglet");
          document.body.append(anchor);
          anchor.click();
          anchor.remove();
          openButton.textContent = "Document ouvert";
        } catch (error) {
          openButton.textContent = error instanceof NexaApiError ? error.message : "La pièce jointe n’a pas pu être ouverte.";
        } finally {
          openButton.disabled = false;
          if (openButton.textContent === "Ouverture sécurisée…") openButton.textContent = previous;
        }
      });
      row.append(openButton);
      attachmentSection.append(row);
    }
    container.append(attachmentSection);
  }
  for (const addendum of record.addenda || []) {
    const correction = document.createElement("article");
    correction.className = "nexa-patient-appointments__record-correction";
    correction.append(
      makeText("strong", "", `Correction de ${addendum.signatureName || "votre médecin"}`),
      makeText("time", "", addendum.createdAt ? appointmentDate(addendum.createdAt) : "Date indisponible"),
      makeText("p", "", [addendum.reason, addendum.content].filter(Boolean).join(" — ")),
    );
    container.append(correction);
  }
}

function renderStandalonePatientRecordItem(summary) {
  const item = document.createElement("li");
  const details = document.createElement("div");
  details.append(
    makeText("h3", "", summary.recordNumber ? `Dossier ${summary.recordNumber}` : "Compte rendu médical"),
    makeText("p", "nexa-patient-appointments__date", [summary.providerName || "Professionnel NEXA", summary.specialtyName || "", summary.createdAt ? appointmentDate(summary.createdAt) : ""].filter(Boolean).join(" · ")),
    makeText("span", "nexa-patient-appointments__status", ["FINALIZED", "SIGNED"].includes(summary.status) ? "Compte rendu finalisé" : "En préparation"),
  );
  if (summary.addendumCount > 0) details.append(makeText("p", "nexa-patient-appointments__detail", `${summary.addendumCount} correction${summary.addendumCount === 1 ? "" : "s"} ajoutée${summary.addendumCount === 1 ? "" : "s"} au dossier.`));
  const button = makeText("button", "nexa-patient-appointments__pay nexa-patient-appointments__pay--secondary", "Consulter mon compte rendu");
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div");
  panel.className = "nexa-patient-appointments__record-panel";
  panel.hidden = true;
  panel.id = `standalone-patient-record-${summary.recordId}`;
  button.setAttribute("aria-controls", panel.id);
  const output = document.createElement("div");
  panel.append(output);
  button.addEventListener("click", () => { void toggleStandalonePatientRecord(summary, button, panel, output); });
  item.append(details, button, panel);
  return item;
}

function renderHomeVisitReport(report) {
  const item = document.createElement("li");
  const details = document.createElement("div");
  const service = homeVisitServiceLabels[report.serviceId] || "Visite médicale à domicile";
  const status = homeVisitMissionLabels[report.missionStatus] || "Compte rendu enregistré";
  details.append(
    makeText("h3", "", service),
    makeText("p", "nexa-patient-appointments__date", [report.providerName || "Médecin NEXA", report.appointmentStartsAt ? appointmentDate(report.appointmentStartsAt) : "Date du rendez-vous indisponible"].join(" · ")),
    makeText("span", "nexa-patient-appointments__status", status),
  );

  const yesNo = (value) => value === true ? "Oui" : value === false ? "Non" : "Non renseigné";
  const completionLabels = {
    COMPLETED: "Service entièrement réalisé",
    PARTIAL: "Service partiellement réalisé",
    NOT_COMPLETED: "Service non réalisé",
    UNKNOWN: "Non renseigné",
  };
  const responseRows = [
    ["Présence du médecin", yesNo(report.providerPresent)],
    ["Identité du médecin", report.identityMatched === false ? "Écart signalé" : yesNo(report.identityMatched)],
    ["Réalisation du service", completionLabels[report.serviceCompletion] || completionLabels.UNKNOWN],
    ["Examen effectué", yesNo(report.examPerformed)],
    ["Ordonnance remise", yesNo(report.prescriptionProvided)],
    ["Examens complémentaires recommandés", yesNo(report.additionalExamsRecommended)],
    ["Questions répondues", yesNo(report.questionsAnswered)],
  ];
  const responseList = document.createElement("div");
  responseList.className = "nexa-home-visit-report__responses";
  for (const [label, value] of responseRows) {
    const row = document.createElement("p");
    row.className = "nexa-home-visit-report__response";
    row.append(makeText("strong", "", `${label} : `), document.createTextNode(value));
    responseList.append(row);
  }
  details.append(responseList);

  if (report.visitStartedAt || report.visitEndedAt) {
    details.append(makeText("p", "nexa-patient-appointments__detail", `Horaire déclaré : ${report.visitStartedAt ? appointmentDate(report.visitStartedAt) : "début non renseigné"} – ${report.visitEndedAt ? appointmentDate(report.visitEndedAt) : "fin non renseignée"}`));
  }
  const ratingLabels = {
    punctuality: "Ponctualité",
    professionalism: "Professionnalisme",
    listening: "Écoute",
    explanations: "Clarté des explications",
    satisfaction: "Satisfaction générale",
  };
  const ratings = report.ratings && typeof report.ratings === "object" ? report.ratings : {};
  const ratingText = Object.entries(ratingLabels)
    .filter(([key]) => Number.isInteger(ratings[key]) && ratings[key] >= 1 && ratings[key] <= 5)
    .map(([key, label]) => `${label} : ${ratings[key]}/5`);
  if (ratingText.length) details.append(makeText("p", "nexa-patient-appointments__detail", ratingText.join(" · ")));
  if (report.comment) details.append(makeText("p", "nexa-patient-appointments__detail", `Votre commentaire : ${report.comment}`));
  if (report.signature?.name) {
    const signer = report.signature.signerRole === "REPRESENTATIVE" ? "représentant" : "patient";
    details.append(makeText("p", "nexa-patient-appointments__detail", `Signé par ${report.signature.name} (${signer})${report.signature.signedAt ? ` · ${appointmentDate(report.signature.signedAt)}` : ""}`));
  }
  if (report.submittedAt) details.append(makeText("p", "nexa-patient-appointments__detail", `Compte rendu envoyé le ${appointmentDate(report.submittedAt)}.`));
  item.append(details);
  return item;
}

async function loadHomeVisitReports(append = false) {
  if (!currentUser || homeVisitReportsRequestActive) return;
  if (append && (!homeVisitReportsHasMore || !homeVisitReportsCursor)) return;
  const user = currentUser;
  homeVisitReportsRequestActive = true;
  homeVisitReportsSection.hidden = false;
  homeVisitReportsLoading.hidden = append;
  homeVisitReportsError.hidden = true;
  if (!append) {
    homeVisitReportsEmpty.hidden = true;
    homeVisitReportsList.replaceChildren();
    homeVisitReportsCursor = "";
    homeVisitReportsHasMore = false;
    homeVisitReportsPaginationStatus.textContent = "";
    homeVisitReportsPaginationStatus.hidden = true;
    loadMoreHomeVisitReportsButton.hidden = true;
  } else {
    homeVisitReportsPaginationStatus.textContent = "Chargement des visites plus anciennes…";
    homeVisitReportsPaginationStatus.hidden = false;
  }
  reloadHomeVisitReportsButton.disabled = true;
  loadMoreHomeVisitReportsButton.disabled = true;
  try {
    const result = await requestNexaFunction(
      user,
      "nexaPatientHomeVisitReports",
      "GET",
      undefined,
      append ? { cursor: homeVisitReportsCursor } : undefined,
    );
    if (currentUser !== user) return;
    const reports = Array.isArray(result.reports) ? result.reports : [];
    const items = reports.map(renderHomeVisitReport);
    if (append) homeVisitReportsList.append(...items);
    else homeVisitReportsList.replaceChildren(...items);
    homeVisitReportsCursor = typeof result.nextCursor === "string" ? result.nextCursor : "";
    homeVisitReportsHasMore = result.hasMore === true && Boolean(homeVisitReportsCursor);
    homeVisitReportsEmpty.hidden = homeVisitReportsList.children.length > 0;
    loadMoreHomeVisitReportsButton.hidden = !homeVisitReportsHasMore;
    const count = homeVisitReportsList.children.length;
    homeVisitReportsPaginationStatus.textContent = count
      ? homeVisitReportsHasMore
        ? `${count} compte rendu${count === 1 ? "" : "s"} affiché${count === 1 ? "" : "s"}. Des visites plus anciennes sont disponibles.`
        : `${count} compte rendu${count === 1 ? "" : "s"} affiché${count === 1 ? "" : "s"}.`
      : append ? "Aucune autre visite n’est disponible." : "";
    homeVisitReportsPaginationStatus.hidden = !homeVisitReportsPaginationStatus.textContent;
  } catch (error) {
    if (currentUser !== user) return;
    homeVisitReportsError.textContent = error instanceof NexaApiError ? error.message : "Vos comptes rendus de visites à domicile ne sont pas accessibles pour le moment.";
    homeVisitReportsError.hidden = false;
    homeVisitReportsPaginationStatus.textContent = "";
    homeVisitReportsPaginationStatus.hidden = true;
  } finally {
    if (currentUser === user) {
      homeVisitReportsRequestActive = false;
      homeVisitReportsLoading.hidden = true;
      reloadHomeVisitReportsButton.disabled = false;
      loadMoreHomeVisitReportsButton.disabled = false;
    }
  }
}

function renderNursingVisitReport(report) {
  const item = document.createElement("li");
  const details = document.createElement("div");
  details.append(
    makeText("h3", "", `Prestation infirmière · ${report.periodLabel || "Période réservée"}`),
    makeText("p", "nexa-patient-appointments__date", [report.providerName || "Infirmier·ère NEXA", report.scheduledAt ? nursingVisitDate(report.scheduledAt) : "Horaire indisponible"].join(" · ")),
    makeText("span", "nexa-patient-appointments__status", nursingVisitStatusLabels[report.status] || "Compte rendu enregistré"),
  );
  const services = Array.isArray(report.serviceLabels) ? report.serviceLabels.filter((label) => typeof label === "string" && label.trim()) : [];
  if (services.length) details.append(makeText("p", "nexa-patient-appointments__detail", `Soins prévus : ${services.join(" · ")}`));

  const yesNo = (value) => value === true ? "Oui" : value === false ? "Non" : "Non renseigné";
  const completionLabels = {
    COMPLETED: "Soins entièrement réalisés",
    PARTIAL: "Soins partiellement réalisés",
    NOT_COMPLETED: "Soins non réalisés",
    UNKNOWN: "Non renseigné",
  };
  const responseRows = [
    ["Présence de l’infirmier·ère", yesNo(report.providerPresent)],
    ["Identité/photo correspondante", report.identityMatched === false ? "Écart signalé" : yesNo(report.identityMatched)],
    ["Réalisation des soins", completionLabels[report.serviceCompletion] || completionLabels.UNKNOWN],
  ];
  const responseList = document.createElement("div");
  responseList.className = "nexa-home-visit-report__responses";
  for (const [label, value] of responseRows) {
    const row = document.createElement("p");
    row.className = "nexa-home-visit-report__response";
    row.append(makeText("strong", "", `${label} : `), document.createTextNode(value));
    responseList.append(row);
  }
  details.append(responseList);

  if (report.visitStartedAt || report.visitEndedAt) {
    details.append(makeText("p", "nexa-patient-appointments__detail", `Horaire déclaré : ${report.visitStartedAt ? nursingVisitDate(report.visitStartedAt) : "début non renseigné"} – ${report.visitEndedAt ? nursingVisitDate(report.visitEndedAt) : "fin non renseignée"}`));
  }
  const ratingLabels = {
    quality: "Qualité des soins",
    professionalism: "Professionnalisme",
    punctuality: "Ponctualité",
    courtesyRespect: "Courtoisie et respect",
    satisfaction: "Satisfaction générale",
  };
  const ratings = report.ratings && typeof report.ratings === "object" ? report.ratings : {};
  const ratingText = Object.entries(ratingLabels)
    .filter(([key]) => Number.isInteger(ratings[key]) && ratings[key] >= 1 && ratings[key] <= 5)
    .map(([key, label]) => `${label} : ${ratings[key]}/5`);
  if (ratingText.length) details.append(makeText("p", "nexa-patient-appointments__detail", ratingText.join(" · ")));
  if (report.comment) details.append(makeText("p", "nexa-patient-appointments__detail", `Votre commentaire : ${report.comment}`));
  if (report.nursingCareRecord && typeof report.nursingCareRecord === "object" && report.nursingCareRecord.summary) {
    const careRecord = report.nursingCareRecord;
    details.append(makeText("h4", "", "Compte rendu infirmier"));
    if (Array.isArray(careRecord.performedServiceLabels) && careRecord.performedServiceLabels.length) {
      details.append(makeText("p", "nexa-patient-appointments__detail", `Soins consignés : ${careRecord.performedServiceLabels.join(" · ")}`));
    }
    details.append(makeText("p", "nexa-nursing-care-record__summary", careRecord.summary));
    details.append(makeText("p", "nexa-patient-appointments__detail", `Signé par ${careRecord.providerName || "Infirmier·ère NEXA"}${careRecord.signedAt ? ` · ${nursingVisitDate(careRecord.signedAt)}` : ""}`));
  }
  if (report.signature?.name) {
    const signer = report.signature.signerRole === "REPRESENTATIVE" ? "représentant" : "patient";
    details.append(makeText("p", "nexa-patient-appointments__detail", `Signé par ${report.signature.name} (${signer})${report.signature.signedAt ? ` · ${nursingVisitDate(report.signature.signedAt)}` : ""}`));
  }
  if (report.submittedAt) details.append(makeText("p", "nexa-patient-appointments__detail", `Compte rendu envoyé le ${nursingVisitDate(report.submittedAt)}.`));
  item.append(details);
  return item;
}

async function loadNursingVisitReports(append = false) {
  if (!currentUser || nursingReportsRequestActive) return;
  if (append && (!nursingReportsHasMore || !nursingReportsCursor)) return;
  const user = currentUser;
  nursingReportsRequestActive = true;
  nursingReportsSection.hidden = false;
  nursingReportsLoading.hidden = append;
  nursingReportsError.hidden = true;
  if (!append) {
    nursingReportsEmpty.hidden = true;
    nursingReportsList.replaceChildren();
    nursingReportsCursor = "";
    nursingReportsHasMore = false;
    nursingReportsPaginationStatus.textContent = "";
    nursingReportsPaginationStatus.hidden = true;
    loadMoreNursingReportsButton.hidden = true;
  } else {
    nursingReportsPaginationStatus.textContent = "Chargement des soins plus anciens…";
    nursingReportsPaginationStatus.hidden = false;
  }
  reloadNursingReportsButton.disabled = true;
  loadMoreNursingReportsButton.disabled = true;
  try {
    const result = await requestNexaFunction(
      user,
      "nexaPatientNursingVisitReports",
      "GET",
      undefined,
      append ? { cursor: nursingReportsCursor } : undefined,
    );
    if (currentUser !== user) return;
    const reports = Array.isArray(result.reports) ? result.reports : [];
    const items = reports.map(renderNursingVisitReport);
    if (append) nursingReportsList.append(...items);
    else nursingReportsList.replaceChildren(...items);
    nursingReportsCursor = typeof result.nextCursor === "string" ? result.nextCursor : "";
    nursingReportsHasMore = result.hasMore === true && Boolean(nursingReportsCursor);
    nursingReportsEmpty.hidden = nursingReportsList.children.length > 0;
    loadMoreNursingReportsButton.hidden = !nursingReportsHasMore;
    const count = nursingReportsList.children.length;
    nursingReportsPaginationStatus.textContent = count
      ? nursingReportsHasMore
        ? `${count} compte rendu${count === 1 ? "" : "s"} affiché${count === 1 ? "" : "s"}. Des soins plus anciens sont disponibles.`
        : `${count} compte rendu${count === 1 ? "" : "s"} affiché${count === 1 ? "" : "s"}.`
      : append ? "Aucun autre compte rendu infirmier n’est disponible." : "";
    nursingReportsPaginationStatus.hidden = !nursingReportsPaginationStatus.textContent;
  } catch (error) {
    if (currentUser !== user) return;
    nursingReportsError.textContent = error instanceof NexaApiError ? error.message : "Vos comptes rendus infirmiers ne sont pas accessibles pour le moment.";
    nursingReportsError.hidden = false;
    nursingReportsPaginationStatus.textContent = "";
    nursingReportsPaginationStatus.hidden = true;
  } finally {
    if (currentUser === user) {
      nursingReportsRequestActive = false;
      nursingReportsLoading.hidden = true;
      reloadNursingReportsButton.disabled = false;
      loadMoreNursingReportsButton.disabled = false;
    }
  }
}

async function toggleStandalonePatientRecord(summary, button, panel, output) {
  if (!currentUser || button.disabled) return;
  if (!panel.hidden && panel.dataset.loaded === "true") {
    panel.hidden = true;
    delete panel.dataset.loaded;
    output.replaceChildren();
    button.setAttribute("aria-expanded", "false");
    button.textContent = "Consulter mon compte rendu";
    return;
  }
  const user = currentUser;
  button.disabled = true;
  button.textContent = "Chargement du compte rendu…";
  panel.hidden = false;
  button.setAttribute("aria-expanded", "true");
  output.replaceChildren(makeText("p", "nexa-patient-appointments__record-message", "Vérification de votre accès…"));
  try {
    const result = await requestNexaFunction(user, "nexaPatientStandaloneClinicalRecord", "GET", undefined, { recordId: summary.recordId });
    if (currentUser !== user) return;
    if (result.view !== "patient" || !result.record || result.record.recordId !== summary.recordId) throw new Error("clinical-record-view-invalid");
    const record = result.record;
    if (["FINALIZED", "SIGNED"].includes(record.status)) {
      renderPatientClinicalRecord(output, record);
      const download = makeText("button", "nexa-patient-appointments__pay nexa-patient-appointments__pay--secondary", "Télécharger le compte rendu PDF");
      download.type = "button";
      const downloadStatus = makeText("p", "nexa-patient-appointments__record-message", "");
      downloadStatus.setAttribute("role", "status");
      downloadStatus.setAttribute("aria-live", "polite");
      download.addEventListener("click", () => { void downloadStandaloneClinicalRecordPdf(record, download, downloadStatus); });
      output.append(download, downloadStatus);
    } else {
      output.replaceChildren(
        makeText("strong", "", "Votre médecin prépare le compte rendu."),
        makeText("p", "nexa-patient-appointments__record-message", [record.providerName, record.specialtyName, record.createdAt ? appointmentDate(record.createdAt) : ""].filter(Boolean).join(" · ")),
      );
    }
    panel.dataset.loaded = "true";
    button.textContent = "Masquer le compte rendu";
  } catch (error) {
    if (currentUser !== user) return;
    delete panel.dataset.loaded;
    output.replaceChildren(makeText("p", "nexa-patient-appointments__record-error", error instanceof NexaApiError ? error.message : "Le compte rendu n’est pas accessible pour le moment."));
    button.textContent = "Réessayer de consulter le compte rendu";
  } finally {
    if (currentUser === user) button.disabled = false;
  }
}

async function downloadStandaloneClinicalRecordPdf(record, button, status) {
  if (!currentUser || button.disabled) return;
  const user = currentUser;
  button.disabled = true;
  status.textContent = "Préparation du PDF sécurisé…";
  try {
    const blob = await downloadNexaPdf(user, "nexaPatientStandaloneClinicalRecordPdf", { recordId: record.recordId });
    if (currentUser !== user) return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `nexa-compte-rendu-${String(record.recordNumber || record.recordId).replace(/[^A-Za-z0-9_-]/g, "-")}.pdf`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    status.textContent = "Le téléchargement de votre compte rendu a commencé.";
  } catch (error) {
    if (currentUser !== user) return;
    status.textContent = error instanceof NexaApiError ? error.message : "Le compte rendu PDF n’a pas pu être téléchargé.";
  } finally {
    if (currentUser === user) button.disabled = false;
  }
}

async function loadStandaloneClinicalRecords(append = false) {
  if (!currentUser || standaloneRecordsRequestActive) return;
  if (append && (!standaloneRecordsHasMore || !standaloneRecordsCursor)) return;
  const user = currentUser;
  standaloneRecordsRequestActive = true;
  standaloneRecordsSection.hidden = false;
  standaloneRecordsLoading.hidden = append;
  standaloneRecordsLoading.textContent = "Chargement de vos dossiers médicaux…";
  standaloneRecordsError.hidden = true;
  if (!append) {
    standaloneRecordsEmpty.hidden = true;
    standaloneRecordsList.replaceChildren();
    standaloneRecordsCursor = "";
    standaloneRecordsHasMore = false;
    standaloneRecordsPaginationStatus.textContent = "";
    standaloneRecordsPaginationStatus.hidden = true;
    loadMoreStandaloneRecordsButton.hidden = true;
  } else {
    standaloneRecordsPaginationStatus.textContent = "Chargement des dossiers plus anciens…";
    standaloneRecordsPaginationStatus.hidden = false;
  }
  reloadStandaloneRecordsButton.disabled = true;
  loadMoreStandaloneRecordsButton.disabled = true;
  try {
    const result = await requestNexaFunction(
      user,
      "nexaPatientClinicalRecords",
      "GET",
      undefined,
      append ? { cursor: standaloneRecordsCursor } : undefined,
    );
    if (currentUser !== user) return;
    const records = Array.isArray(result.records) ? result.records : [];
    const items = records.map(renderStandalonePatientRecordItem);
    if (append) standaloneRecordsList.append(...items);
    else standaloneRecordsList.replaceChildren(...items);
    standaloneRecordsCursor = typeof result.nextCursor === "string" ? result.nextCursor : "";
    standaloneRecordsHasMore = result.hasMore === true && Boolean(standaloneRecordsCursor);
    standaloneRecordsEmpty.hidden = standaloneRecordsList.children.length > 0;
    loadMoreStandaloneRecordsButton.hidden = !standaloneRecordsHasMore;
    const loadedCount = standaloneRecordsList.children.length;
    standaloneRecordsPaginationStatus.textContent = loadedCount
      ? standaloneRecordsHasMore
        ? `${loadedCount} dossier${loadedCount === 1 ? "" : "s"} affiché${loadedCount === 1 ? "" : "s"}. Des dossiers plus anciens sont disponibles.`
        : `${loadedCount} dossier${loadedCount === 1 ? "" : "s"} affiché${loadedCount === 1 ? "" : "s"}.`
      : append ? "Aucun autre dossier médical n’est disponible." : "";
    standaloneRecordsPaginationStatus.hidden = !standaloneRecordsPaginationStatus.textContent;
  } catch (error) {
    if (currentUser !== user) return;
    standaloneRecordsError.textContent = error instanceof NexaApiError ? error.message : "Vos comptes rendus autonomes ne sont pas accessibles pour le moment.";
    standaloneRecordsError.hidden = false;
    standaloneRecordsPaginationStatus.textContent = "";
    standaloneRecordsPaginationStatus.hidden = true;
  } finally {
    if (currentUser === user) {
      standaloneRecordsRequestActive = false;
      standaloneRecordsLoading.hidden = true;
      reloadStandaloneRecordsButton.disabled = false;
      loadMoreStandaloneRecordsButton.disabled = false;
    }
  }
}

function appendPatientClinicalRecord(item, appointment) {
  const isHomeVisit = appointment.bookingType === "home_visit";
  const eligible = appointment.paymentStatus === "PAID" && appointment.status === "COMPLETED" &&
    (!isHomeVisit || appointment.homeVisitMissionStatus === "COMPLETED");
  if (!eligible) return;
  const section = document.createElement("section");
  section.className = "nexa-patient-appointments__record";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "nexa-patient-appointments__pay nexa-patient-appointments__pay--secondary";
  button.textContent = "Consulter mon compte rendu médical";
  button.setAttribute("aria-expanded", "false");
  const panel = document.createElement("div");
  panel.className = "nexa-patient-appointments__record-panel";
  panel.hidden = true;
  const output = document.createElement("div");
  panel.append(output);
  button.setAttribute("aria-controls", `patient-clinical-record-${appointment.appointmentId}`);
  panel.id = `patient-clinical-record-${appointment.appointmentId}`;
  button.addEventListener("click", async () => {
    if (!panel.hidden && panel.dataset.loaded === "true") {
      panel.hidden = true;
      delete panel.dataset.loaded;
      output.replaceChildren();
      button.setAttribute("aria-expanded", "false");
      button.textContent = "Consulter mon compte rendu médical";
      return;
    }
    button.disabled = true;
    button.textContent = "Chargement du compte rendu…";
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    output.replaceChildren(makeText("p", "nexa-patient-appointments__record-message", "Vérification de votre accès…"));
    try {
      const result = await requestNexaFunction(currentUser, "nexaClinicalRecord", "GET", undefined, { appointmentId: appointment.appointmentId });
      if (result.view !== "patient") throw new Error("clinical-record-view-invalid");
      renderPatientClinicalRecord(output, result.record || null);
      panel.dataset.loaded = "true";
      button.textContent = "Masquer le compte rendu médical";
    } catch (error) {
      output.replaceChildren(makeText("p", "nexa-patient-appointments__record-error", error instanceof NexaApiError ? error.message : "Le compte rendu n’est pas accessible pour le moment."));
      button.textContent = "Réessayer de consulter le compte rendu";
    } finally {
      button.disabled = false;
    }
  });
  section.append(button, panel);
  item.append(section);
}

function appendExpiredAppointmentActions(item, details, appointment) {
  const note = makeText(
    "p",
    "nexa-patient-appointments__detail",
    "Cette réservation a expiré. Choisissez un créneau actuellement disponible; l’ancien rendez-vous reste archivé.",
  );
  details.append(note);

  if (/^[A-Za-z0-9_-]{1,128}$/.test(String(appointment.providerUid || ""))) {
    const query = new URLSearchParams({
      providerUid: appointment.providerUid,
      serviceType: appointment.bookingType === "home_visit" ? "HOME_VISIT" : "TELECONSULTATION",
    });
    const chooseSlot = makeText("a", "nexa-patient-appointments__pay nexa-patient-appointments__pay--secondary", "Choisir un nouveau créneau");
    chooseSlot.href = "./rendez-vous.html?" + query.toString();
    details.append(chooseSlot);
  }

  const dismissButton = makeText("button", "nexa-patient-appointments__pay nexa-patient-appointments__pay--secondary", "Masquer ce rendez-vous expiré");
  dismissButton.type = "button";
  const message = makeText("p", "nexa-patient-appointments__detail", "");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  dismissButton.addEventListener("click", async () => {
    if (!currentUser) return;
    dismissButton.disabled = true;
    message.textContent = "Vérification du statut du rendez-vous…";
    try {
      await requestNexaFunction(currentUser, "patientAppointmentDismiss", "POST", {
        appointmentId: appointment.appointmentId,
      });
      item.remove();
      await loadAppointments();
    } catch (error) {
      message.textContent = error instanceof NexaApiError
        ? error.message
        : "Le rendez-vous n’a pas pu être masqué. Vérifiez votre connexion puis réessayez.";
      dismissButton.disabled = false;
    }
  });
  details.append(dismissButton, message);
}

function renderAppointment(appointment) {
  const item = document.createElement("li");
  const details = document.createElement("div");
  details.append(
    makeText("h3", "", appointment.providerName || "Professionnel NEXA"),
    makeText("p", "nexa-patient-appointments__date", appointmentDate(appointment.startsAt)),
  );
  if (appointment.bookingType === "home_visit") {
    const service = homeVisitServiceLabels[appointment.homeVisitServiceId] || "Visite médicale à domicile";
    details.append(makeText("p", "nexa-patient-appointments__detail", service + " · 1 heure"));
    if (appointment.homeVisitDetails) {
      const address = [
        appointment.homeVisitDetails.addressLine,
        appointment.homeVisitDetails.commune,
        appointment.homeVisitDetails.department,
      ].filter(Boolean).join(", ");
      if (address) details.append(makeText("p", "nexa-patient-appointments__detail", "Adresse : " + address));
      if (appointment.homeVisitDetails.contactPhone) {
        details.append(makeText("p", "nexa-patient-appointments__detail", "Téléphone : " + appointment.homeVisitDetails.contactPhone));
      }
    }
  } else if (appointment.bookingType === "doctor_proposed_appointment") {
    details.append(makeText("p", "nexa-patient-appointments__detail", "Rendez-vous proposé par votre médecin"));
  } else if (appointment.durationMinutes) {
    details.append(makeText("p", "nexa-patient-appointments__detail", "Téléconsultation · " + appointment.durationMinutes + " minutes"));
  }

  const unacceptedTeleconsultation = appointment.noShowReason === "PROVIDER_DID_NOT_ACCEPT";
  const statusLabel = unacceptedTeleconsultation && appointment.status === "PROVIDER_NO_SHOW_REFUND_REQUIRED"
    ? "Téléconsultation en examen par NEXA"
    : appointmentStatusLabels[appointment.status] || appointment.status || "État indisponible";
  details.append(makeText("span", "nexa-patient-appointments__status", statusLabel));
  if (appointment.status === "PAYMENT_EXPIRED" && appointment.paymentStatus === "EXPIRED") {
    appendExpiredAppointmentActions(item, details, appointment);
  }
  if (appointment.paymentStatus === "PAID" && appointment.paymentMethod === "NEXA_WALLET") {
    details.append(makeText("p", "nexa-patient-appointments__detail", "Paiement confirmé par Wallet NEXA."));
  }
  if (appointment.bookingType === "teleconsultation" && appointment.status === "PROVIDER_REFUSED") {
    const refundMessage = appointment.refundStatus === "COMPLETED" && appointment.refundMethod === "NEXA_WALLET"
      ? "Le médecin a refusé cette téléconsultation. Le prix du service a été crédité à votre Wallet NEXA; les frais de transaction ne sont pas remboursés."
      : "Le médecin a refusé cette téléconsultation. Le remboursement du prix du service est en cours de vérification par NEXA; les frais de transaction ne sont pas remboursés.";
    details.append(makeText("p", "nexa-patient-appointments__detail", refundMessage));
  }
  if (appointment.paymentStatus === "PENDING" && appointment.paymentRef) {
    details.append(makeText("p", "nexa-patient-appointments__detail",
      "Service " + formatMoney(appointment.amount) + " + frais " + formatMoney(appointment.transactionFee) +
      " = total à payer " + formatMoney(appointment.totalAmount) + ". Les frais s’appliquent aussi au Wallet."));
    const paymentMessage = makeText("p", "nexa-patient-appointments__detail", "");
    paymentMessage.setAttribute("role", "status");
    paymentMessage.setAttribute("aria-live", "polite");
    const paymentButton = document.createElement("button");
    paymentButton.type = "button";
    paymentButton.className = "nexa-patient-appointments__pay";
    paymentButton.textContent = "Reprendre le paiement MonCash";
    paymentButton.addEventListener("click", () => {
      void resumeMoncashPayment(appointment.paymentRef, paymentButton, paymentMessage);
    });
    const walletButton = document.createElement("button");
    walletButton.type = "button";
    walletButton.className = "nexa-patient-appointments__pay nexa-patient-appointments__pay--secondary";
    walletButton.textContent = "Payer avec Wallet NEXA";
    walletButton.addEventListener("click", () => {
      void payAppointmentWithWallet(appointment.paymentRef, walletButton, paymentMessage);
    });
    details.append(paymentButton, walletButton, paymentMessage);
  }
  if (appointment.bookingType === "home_visit" && appointment.paymentStatus === "PAID") {
    const missionLabel = homeVisitMissionLabels[appointment.homeVisitMissionStatus] || "À suivre par NEXA";
    details.append(makeText("p", "nexa-patient-appointments__detail", "Mission : " + missionLabel + ". Les frais de transaction ne sont pas remboursés."));
  }
  if (appointment.bookingType === "home_visit" && appointment.homeVisitMissionStatus === "PROVIDER_ABSENT_REFUND_REQUIRED") {
    const refundMessage = appointment.refundStatus === "PENDING_MANUAL_CASH"
      ? "Votre demande de remboursement en espèces attend le traitement manuel de l’administration. Aucun crédit Wallet n’a été fait; les frais de transaction ne sont pas remboursés."
      : appointment.refundStatus === "COMPLETED" && appointment.refundMethod === "NEXA_WALLET"
        ? "Le prix du service a été crédité à votre Wallet NEXA. Les frais de transaction ne sont pas remboursés."
        : "Le remboursement du prix du service est en attente. Les frais de transaction ne sont pas remboursés.";
    details.append(makeText("p", "nexa-patient-appointments__detail", refundMessage));
    if (appointment.refundStatus === "PENDING_AUTO_REFUND") {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "nexa-patient-appointments__pay";
      retry.textContent = "Reprendre le remboursement Wallet";
      const feedback = makeText("p", "nexa-home-visit-feedback__message", "");
      feedback.setAttribute("role", "status");
      feedback.setAttribute("aria-live", "polite");
      retry.addEventListener("click", async () => {
        if (!currentUser) return;
        retry.disabled = true;
        retry.textContent = "Vérification du remboursement…";
        try {
          await requestNexaFunction(currentUser, "nexaPatientHomeVisitFeedback", "POST", {
            appointmentId: appointment.appointmentId,
            retryNoShowRefund: true,
          });
          await loadAppointments();
        } catch (error) {
          feedback.textContent = error instanceof NexaApiError ? error.message : "Le remboursement ne peut pas être repris pour le moment.";
          retry.disabled = false;
          retry.textContent = "Réessayer le remboursement Wallet";
        }
      });
      details.append(retry, feedback);
    }
  }
  appendHomeVisitFeedback(details, appointment);
  if (appointment.homeVisitMissionCode) {
    const code = document.createElement("div");
    code.className = "nexa-patient-appointments__code";
    code.append(
      makeText("strong", "", "Code de clôture : " + appointment.homeVisitMissionCode),
      makeText("p", "", "Donnez ce code au médecin après la visite et après avoir confirmé sa présence."),
    );
    details.append(code);
  }
  if (appointment.noShowOutcome === "PROVIDER_UNRESPONSIVE") {
    const refundMessage = appointment.refundStatus === "PENDING_MANUAL_CASH"
      ? "Votre demande de remboursement en espèces est en attente de traitement par l’administration. Aucun crédit Wallet n’a été fait. Les frais de transaction ne sont pas remboursés."
      : appointment.refundStatus === "COMPLETED" && appointment.refundMethod === "CASH_MANUAL"
        ? "L’administration a enregistré le remboursement manuel en espèces. Les frais de transaction ne sont pas remboursés."
        : appointment.refundStatus === "COMPLETED" && appointment.refundMethod === "NEXA_WALLET"
          ? "Le prix du service a été crédité au portefeuille NEXA. Les frais de transaction ne sont pas remboursés."
          : unacceptedTeleconsultation && appointment.refundStatus === "PENDING_REVIEW"
            ? "Le dossier est en attente d’examen par l’administration NEXA. Aucun remboursement automatique n’a été effectué. Une éventuelle décision porte sur le prix du service; les frais de transaction ne sont pas remboursés."
            : "Le remboursement du prix du service au Wallet est en cours. Les frais de transaction ne sont pas remboursés.";
    details.append(makeText("p", "nexa-patient-appointments__detail", refundMessage));
  } else if (appointment.noShowOutcome === "PATIENT_UNRESPONSIVE") {
    details.append(makeText("p", "nexa-patient-appointments__detail", "Le montant du service reste à NEXA après deux appels initiés par le médecin et restés sans réponse de votre part."));
  }
  const isTeleconsultation = ["teleconsultation", "doctor_proposed_appointment"].includes(appointment.bookingType);
  if (isTeleconsultation && appointment.paymentStatus === "PAID" &&
    appointment.noShowOutcome === "PROVIDER_UNRESPONSIVE" && ["PENDING_AUTO_REFUND", "PENDING_REVIEW"].includes(appointment.refundStatus) &&
    appointment.requestedRefundMethod !== "CASH_MANUAL") {
    const preferenceMessage = makeText("p", "nexa-patient-appointments__detail", unacceptedTeleconsultation
      ? "Le dossier est en examen. Vous pouvez demander à l’administration de traiter le prix du service en espèces; cette demande sera traitée manuellement. Les frais de transaction ne sont pas remboursés."
      : "Le remboursement Wallet n’est pas encore confirmé. Vous pouvez demander à l’administration de traiter le prix du service en espèces. Les frais de transaction ne sont pas remboursés.");
    preferenceMessage.setAttribute("role", "status");
    preferenceMessage.setAttribute("aria-live", "polite");
    const cashButton = document.createElement("button");
    cashButton.type = "button";
    cashButton.className = "nexa-patient-appointments__pay";
    cashButton.textContent = "Demander un remboursement manuel en espèces";
    cashButton.addEventListener("click", () => {
      void updateTeleconsultationRefundPreference(appointment.appointmentId, "CASH_MANUAL", cashButton, preferenceMessage);
    });
    details.append(cashButton, preferenceMessage);
  } else if (isTeleconsultation && appointment.paymentStatus === "PAID" &&
    ["CONFIRMED", "DOCTOR_ACCEPTED", "IN_PROGRESS"].includes(appointment.status) && !appointment.consultationStarted &&
    !appointment.noShowOutcome) {
    const waitingForAcceptance = appointment.status === "CONFIRMED";
    const cashRefundCondition = waitingForAcceptance
      ? "si le rendez-vous payé est transmis à NEXA pour examen parce que le médecin ne l’a pas accepté"
      : "si NEXA confirme l’absence du médecin après deux appels initiés par vous et restés sans réponse du médecin";
    const preferenceMessage = makeText("p", "nexa-patient-appointments__detail", appointment.requestedRefundMethod === "CASH_MANUAL"
      ? `Votre préférence en espèces est enregistrée pour le cas où ${cashRefundCondition}.`
      : `Vous pouvez choisir avant le démarrage de la séance que l’administration traite en espèces le remboursement du prix du service ${cashRefundCondition}.`);
    preferenceMessage.setAttribute("role", "status");
    preferenceMessage.setAttribute("aria-live", "polite");
    const preferenceButton = document.createElement("button");
    preferenceButton.type = "button";
    preferenceButton.className = "nexa-patient-appointments__pay";
    const nextMethod = appointment.requestedRefundMethod === "CASH_MANUAL" ? "NEXA_WALLET" : "CASH_MANUAL";
    preferenceButton.textContent = nextMethod === "CASH_MANUAL"
      ? "Préférer un remboursement manuel en espèces"
      : "Annuler ma préférence en espèces";
    preferenceButton.addEventListener("click", () => {
      void updateTeleconsultationRefundPreference(appointment.appointmentId, nextMethod, preferenceButton, preferenceMessage);
    });
    details.append(preferenceButton, preferenceMessage);
  }
  if (["teleconsultation", "doctor_proposed_appointment"].includes(appointment.bookingType) &&
    appointment.paymentStatus === "PAID" && ["DOCTOR_ACCEPTED", "IN_PROGRESS"].includes(appointment.status)) {
    const videoLink = makeText("a", "nexa-patient-appointments__pay", "Rejoindre la téléconsultation");
    videoLink.href = `./teleconsultation.html?appointmentId=${encodeURIComponent(appointment.appointmentId)}`;
    details.append(videoLink);
  }
  item.append(details);
  appendPatientClinicalRecord(item, appointment);
  return item;
}

function makeFieldLabel(text, control) {
  const label = document.createElement("label");
  label.append(document.createTextNode(text), control);
  return label;
}

function makeSelect(options, name) {
  const select = document.createElement("select");
  select.name = name;
  select.required = true;
  for (const [value, label] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  }
  return select;
}

function appendHomeVisitFeedback(container, appointment) {
  const visitEnd = Date.parse(String(appointment.endsAt || ""));
  if (appointment.bookingType !== "home_visit" || appointment.paymentStatus !== "PAID" || appointment.status !== "CONFIRMED" ||
    appointment.homeVisitMissionStatus !== "SCHEDULED" || !Number.isFinite(visitEnd) || Date.now() < visitEnd) return;

  const section = document.createElement("section");
  section.className = "nexa-home-visit-feedback";
  section.setAttribute("aria-labelledby", `home-visit-feedback-title-${appointment.appointmentId}`);
  const title = makeText("h4", "", "Confirmer la visite à domicile");
  title.id = `home-visit-feedback-title-${appointment.appointmentId}`;
  const intro = makeText("p", "nexa-home-visit-feedback__help", "Après l’heure prévue, indiquez si le médecin est venu et confirmez le service. Votre réponse et votre signature sont enregistrées pour le suivi de cette visite.");
  const form = document.createElement("form");
  form.className = "nexa-home-visit-feedback__form";
  const presence = makeSelect([["", "Choisissez une réponse"], ["yes", "Oui, le médecin est venu"], ["no", "Non, le médecin était absent"]], "providerPresent");
  form.append(makeFieldLabel("Le médecin était-il présent?", presence));

  const attendedFields = document.createElement("div");
  attendedFields.className = "nexa-home-visit-feedback__fields";
  attendedFields.hidden = true;
  const identityMatch = makeSelect([["", "Choisissez une réponse"], ["yes", "Oui"], ["no", "Non"]], "identityMatched");
  attendedFields.append(makeFieldLabel("Le médecin correspondait-il à la personne attendue?", identityMatch));
  const completion = makeSelect([["", "Choisissez une réponse"], ["COMPLETED", "Service entièrement réalisé"], ["PARTIAL", "Service partiellement réalisé"], ["NOT_COMPLETED", "Service non réalisé"]], "serviceCompletion");
  attendedFields.append(makeFieldLabel("État du service", completion));
  for (const [name, text] of [["examPerformed", "Un examen a été effectué"], ["prescriptionProvided", "Une ordonnance a été remise"], ["additionalExamsRecommended", "Des examens complémentaires ont été recommandés"], ["questionsAnswered", "Vos questions ont reçu une réponse"]]) {
    const select = makeSelect([["", "Choisissez une réponse"], ["yes", "Oui"], ["no", "Non"]], name);
    attendedFields.append(makeFieldLabel(text, select));
  }
  const started = document.createElement("input");
  started.type = "datetime-local";
  started.name = "visitStartedAt";
  started.required = true;
  attendedFields.append(makeFieldLabel("Début de la visite", started));
  const ended = document.createElement("input");
  ended.type = "datetime-local";
  ended.name = "visitEndedAt";
  ended.required = true;
  attendedFields.append(makeFieldLabel("Fin de la visite", ended));
  const ratings = document.createElement("fieldset");
  ratings.className = "nexa-home-visit-feedback__ratings";
  ratings.append(makeText("legend", "", "Évaluez la visite de 1 à 5"));
  const ratingPrompts = [
    ["punctuality", "Ponctualité"], ["professionalism", "Professionnalisme"], ["listening", "Écoute"],
    ["explanations", "Clarté des explications"], ["satisfaction", "Satisfaction générale"],
  ];
  for (const [name, text] of ratingPrompts) {
    const rating = makeSelect([["", "Choisissez une note"], ["1", "1 · Très faible"], ["2", "2 · Faible"], ["3", "3 · Moyen"], ["4", "4 · Bon"], ["5", "5 · Excellent"]], name);
    ratings.append(makeFieldLabel(text, rating));
  }
  attendedFields.append(ratings);
  form.append(attendedFields);

  const absentFields = document.createElement("div");
  absentFields.className = "nexa-home-visit-feedback__fields";
  absentFields.hidden = true;
  absentFields.append(makeText("p", "nexa-home-visit-feedback__help", "Le prix du service peut être crédité à votre Wallet NEXA. Si vous demandez un remboursement en espèces, l’administration le traitera manuellement. Les frais de transaction ne sont pas remboursés."));
  const refundMethod = makeSelect([["NEXA_WALLET", "Créditer mon Wallet NEXA"], ["CASH_MANUAL", "Demander un remboursement en espèces (traitement manuel)"]], "refundMethod");
  absentFields.append(makeFieldLabel("Mode de remboursement demandé", refundMethod));
  form.append(absentFields);

  const comment = document.createElement("textarea");
  comment.name = "comment";
  comment.maxLength = 500;
  comment.rows = 3;
  comment.autocomplete = "off";
  form.append(makeFieldLabel("Commentaire facultatif", comment));
  const signatureName = document.createElement("input");
  signatureName.type = "text";
  signatureName.name = "signatureName";
  signatureName.maxLength = 160;
  signatureName.autocomplete = "name";
  signatureName.required = true;
  form.append(makeFieldLabel("Nom du patient ou du représentant", signatureName));
  const signerRole = makeSelect([["", "Choisissez un rôle"], ["PATIENT", "Je suis le patient"], ["REPRESENTATIVE", "Je représente le patient"]], "signerRole");
  form.append(makeFieldLabel("Votre rôle", signerRole));

  const patientConfirmed = document.createElement("input");
  patientConfirmed.type = "checkbox";
  patientConfirmed.name = "patientConfirmed";
  patientConfirmed.required = true;
  const patientConfirmedLabel = document.createElement("label");
  patientConfirmedLabel.className = "nexa-home-visit-feedback__check";
  patientConfirmedLabel.append(patientConfirmed, document.createTextNode("Je confirme que les réponses décrivent cette visite."));
  form.append(patientConfirmedLabel);
  const signatureConsent = document.createElement("input");
  signatureConsent.type = "checkbox";
  signatureConsent.name = "signatureConsent";
  signatureConsent.required = true;
  const signatureLabel = document.createElement("label");
  signatureLabel.className = "nexa-home-visit-feedback__check";
  signatureLabel.append(signatureConsent, document.createTextNode("J’accepte l’enregistrement de mon nom comme signature électronique de ce compte rendu de visite."));
  form.append(signatureLabel);

  const message = makeText("p", "nexa-home-visit-feedback__message", "");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "nexa-patient-appointments__pay";
  submit.textContent = "Envoyer le formulaire";
  form.append(message, submit);
  presence.addEventListener("change", () => {
    const hasProvider = presence.value === "yes";
    attendedFields.hidden = !hasProvider;
    absentFields.hidden = presence.value !== "no";
    for (const control of attendedFields.querySelectorAll("select,input")) control.required = hasProvider;
    if (!hasProvider) for (const control of attendedFields.querySelectorAll("select,input")) control.required = false;
    if (presence.value === "no") {
      identityMatch.value = "no";
      completion.value = "NOT_COMPLETED";
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!currentUser) return;
    submit.disabled = true;
    message.textContent = "Enregistrement sécurisé…";
    const data = new FormData(form);
    const attended = data.get("providerPresent") === "yes";
    const startedAtIso = attended ? haitiLocalToIso(String(data.get("visitStartedAt") || "")) : "";
    const endedAtIso = attended ? haitiLocalToIso(String(data.get("visitEndedAt") || "")) : "";
    if (attended && (!startedAtIso || !endedAtIso)) {
      message.textContent = "Indiquez des horaires de visite valides en heure d’Haïti.";
      submit.disabled = false;
      return;
    }
    const payload = {
      appointmentId: appointment.appointmentId,
      providerPresent: attended,
      identityMatched: attended && data.get("identityMatched") === "yes",
      serviceCompletion: attended ? String(data.get("serviceCompletion") || "") : "NOT_COMPLETED",
      examPerformed: data.get("examPerformed") === "yes",
      prescriptionProvided: data.get("prescriptionProvided") === "yes",
      additionalExamsRecommended: data.get("additionalExamsRecommended") === "yes",
      questionsAnswered: data.get("questionsAnswered") === "yes",
      ...(attended ? { visitStartedAt: startedAtIso, visitEndedAt: endedAtIso } : {}),
      ratings: Object.fromEntries(ratingPrompts.map(([name]) => [name, Number(data.get(name))])),
      comment: String(data.get("comment") || ""),
      signatureName: String(data.get("signatureName") || ""),
      signerRole: String(data.get("signerRole") || ""),
      patientConfirmed: data.get("patientConfirmed") === "on",
      signatureConsent: data.get("signatureConsent") === "on",
      refundMethod: attended ? "NEXA_WALLET" : String(data.get("refundMethod") || "NEXA_WALLET"),
    };
    try {
      const result = await requestNexaFunction(currentUser, "nexaPatientHomeVisitFeedback", "POST", payload);
      message.textContent = result.refundStatus === "PENDING_MANUAL_CASH"
        ? "Votre demande de remboursement en espèces est transmise à l’administration."
        : "Votre formulaire est enregistré. Le statut de la visite a été actualisé.";
      await loadAppointments();
      await loadHomeVisitReports();
    } catch (error) {
      message.textContent = error instanceof NexaApiError ? error.message : "Le formulaire n’a pas pu être envoyé. Vérifiez votre connexion puis réessayez.";
      submit.disabled = false;
    }
  });
  section.append(title, intro, form);
  container.append(section);
}

async function loadAppointments(user = currentUser, append = false) {
  if (!user || (append && (!appointmentsHasMore || appointmentsRequestActive || !appointmentsCursor))) return;
  const generation = append ? appointmentsGeneration : ++appointmentsGeneration;
  appointmentsRequestActive = true;
  appointmentsSection.hidden = false;
  appointmentsLoading.textContent = append ? "Chargement des rendez-vous plus anciens…" : "Chargement de vos rendez-vous…";
  appointmentsLoading.hidden = false;
  appointmentsError.hidden = true;
  if (!append) {
    appointmentsCursor = "";
    appointmentsHasMore = false;
    appointmentsList.replaceChildren();
    appointmentsEmpty.hidden = true;
    loadMoreAppointmentsButton.hidden = true;
    retryAppointmentsButton.hidden = true;
  } else {
    loadMoreAppointmentsButton.disabled = true;
  }
  try {
    const result = await requestNexaFunction(user, "patientAppointments", "GET", undefined,
      append ? { cursor: appointmentsCursor } : undefined);
    if (generation !== appointmentsGeneration || currentUser !== user) return;
    const appointments = Array.isArray(result.appointments) ? result.appointments : [];
    appointmentsHasMore = result.hasMore === true && typeof result.nextCursor === "string" && result.nextCursor.length > 0;
    appointmentsCursor = appointmentsHasMore ? result.nextCursor : "";
    appointmentsLoading.hidden = true;
    appointmentsList.append(...appointments.map(renderAppointment));
    appointmentsEmpty.textContent = appointmentsHasMore
      ? "Aucun rendez-vous à afficher dans cette page. Chargez la suite pour parcourir l’historique."
      : "Vous n’avez pas encore de rendez-vous.";
    appointmentsEmpty.hidden = appointmentsList.children.length > 0;
    loadMoreAppointmentsButton.hidden = !appointmentsHasMore;
    retryAppointmentsButton.hidden = true;
  } catch (error) {
    if (generation !== appointmentsGeneration || currentUser !== user) return;
    appointmentsLoading.hidden = true;
    appointmentsError.hidden = false;
    appointmentsError.textContent = error instanceof NexaApiError
      ? error.message
      : "Vos rendez-vous ne peuvent pas être chargés pour le moment.";
    retryAppointmentsButton.hidden = append;
    loadMoreAppointmentsButton.hidden = !append || !appointmentsCursor;
  } finally {
    if (generation === appointmentsGeneration && currentUser === user) {
      appointmentsRequestActive = false;
      loadMoreAppointmentsButton.disabled = false;
      loadMoreAppointmentsButton.textContent = "Afficher les rendez-vous plus anciens";
    }
  }
}

function nursingVisitDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(date) + " · heure d’Haïti"
    : "Horaire invalide";
}

function appendNursingVisit(container, visit) {
  const section = document.createElement("section");
  section.className = "nexa-patient-appointments__record";
  section.dataset.visitId = visit.visitId || "";
  section.append(
    makeText("h4", "", "Prestation infirmière · " + nursingVisitDate(visit.scheduledAt)),
    makeText("p", "nexa-patient-appointments__detail", "Professionnel : " + (visit.providerName || "Infirmier·ère NEXA")),
    makeText("p", "nexa-patient-appointments__detail", nursingVisitStatusLabels[visit.status] || "État à suivre auprès de NEXA."),
  );
  if (typeof visit.providerPhotoUrl === "string" && visit.providerPhotoUrl.startsWith("https://")) {
    const photo = document.createElement("img");
    photo.className = "nexa-nursing-visit__provider-photo";
    photo.src = visit.providerPhotoUrl;
    photo.alt = "Photo de " + (visit.providerName || "l’infirmier assigné");
    photo.loading = "lazy";
    photo.referrerPolicy = "no-referrer";
    section.append(photo, makeText("p", "nexa-patient-appointments__detail", "Comparez cette photo à la personne présente avant de remettre un code de clôture."));
  }
  const services = Array.isArray(visit.serviceLabels) ? visit.serviceLabels.filter(Boolean) : [];
  if (services.length) section.append(makeText("p", "nexa-patient-appointments__detail", "Soins prévus : " + services.join(" · ")));

  if (visit.status === "AWAITING_PROVIDER_CODE" && visit.patientCode) {
    section.append(
      makeText("strong", "", "Code de clôture : " + visit.patientCode),
      makeText("p", "nexa-patient-appointments__detail", "Remettez ce code à l’infirmier seulement après avoir vérifié son identité et confirmé le soin."),
    );
  } else if (visit.status === "SCHEDULED") {
    section.append(renderNursingVisitFeedbackForm(visit));
  } else if (visit.status === "ADMIN_REVIEW_REQUIRED") {
    section.append(makeText("p", "nexa-patient-appointments__detail", "NEXA examinera votre signalement avant toute clôture ou décision de remboursement."));
  } else if (visit.status === "CASH_REFUND_PENDING") {
    section.append(makeText("p", "nexa-patient-appointments__detail", "L’administration doit exécuter et consigner manuellement le remboursement en espèces du prix total de la période. Les frais restent acquis à NEXARIS."));
  } else if (visit.status === "REFUND_PENDING_ADMIN") {
    section.append(makeText("p", "nexa-patient-appointments__detail", "NEXA a autorisé le remboursement du prix total de la période. Le crédit Wallet sera enregistré dans la file administrative; les frais ne sont pas remboursés."));
  }
  container.append(section);
}

function patientNursingVisitsForOrder(orderId) {
  return [...(patientNursingVisitsByOrder.get(orderId) || [])]
    .sort((left, right) => String(right.scheduledAt).localeCompare(String(left.scheduledAt)));
}

function cachePatientNursingVisit(visit) {
  if (!visit || typeof visit.orderId !== "string" || !visit.orderId ||
    typeof visit.visitId !== "string" || !visit.visitId) return;
  const visits = patientNursingVisitsByOrder.get(visit.orderId) || [];
  const existingIndex = visits.findIndex((item) => item.visitId === visit.visitId);
  if (existingIndex >= 0) {
    visits[existingIndex] = { ...visits[existingIndex], ...visit };
    return;
  }
  visits.push(visit);
  patientNursingVisitsByOrder.set(visit.orderId, visits);
  for (const card of ordersList.querySelectorAll("li[data-order-id]")) {
    if (card.dataset.orderId !== visit.orderId) continue;
    const details = card.querySelector(".nexa-patient-order__details");
    if (!details) continue;
    let section = details.querySelector(".nexa-patient-order__nursing-visits");
    if (!section) {
      section = document.createElement("div");
      section.className = "nexa-patient-order__nursing-visits";
      const settlement = details.querySelector(".nexa-patient-appointments__record-error");
      details.insertBefore(section, settlement || null);
    }
    if (![...section.querySelectorAll("[data-visit-id]")].some((item) => item.dataset.visitId === visit.visitId)) {
      appendNursingVisit(section, visit);
    }
  }
}

function updateRenderedPatientNursingVisit(visit) {
  for (const card of ordersList.querySelectorAll("li[data-order-id]")) {
    if (card.dataset.orderId !== visit.orderId) continue;
    const existing = [...card.querySelectorAll("[data-visit-id]")].find((item) => item.dataset.visitId === visit.visitId);
    if (!existing) continue;
    const replacement = document.createElement("div");
    appendNursingVisit(replacement, visit);
    existing.replaceWith(replacement.firstElementChild);
  }
}

function renderPatientNursingVisits(container, visits) {
  const section = document.createElement("div");
  section.className = "nexa-patient-order__nursing-visits";
  for (const visit of visits) appendNursingVisit(section, visit);
  container.append(section);
}

function renderNursingVisitFeedbackForm(visit) {
  const form = document.createElement("form");
  form.className = "nexa-home-visit-feedback__form";
  const presence = makeSelect([["", "Choisissez une réponse"], ["yes", "Oui, l’infirmier était présent"], ["no", "Non, l’infirmier était absent"]], "providerPresent");
  const identity = makeSelect([["", "Choisissez une réponse"], ["yes", "Oui, son identité/photo correspond"], ["no", "Non, j’ai signalé un écart d’identité"]], "identityMatched");
  const completion = makeSelect([
    ["", "Choisissez l’état des soins"], ["COMPLETED", "Soins entièrement réalisés"],
    ["PARTIAL", "Soins partiellement réalisés"], ["NOT_COMPLETED", "Soins non réalisés"],
  ], "serviceCompletion");
  const startsAt = document.createElement("input");
  startsAt.type = "datetime-local";
  startsAt.required = true;
  const endsAt = document.createElement("input");
  endsAt.type = "datetime-local";
  endsAt.required = true;
  const presenceFields = document.createElement("div");
  presenceFields.className = "nexa-home-visit-feedback__fields";
  presenceFields.append(makeFieldLabel("Début du soin · heure d’Haïti", startsAt), makeFieldLabel("Fin du soin · heure d’Haïti", endsAt));

  const ratingsFieldset = document.createElement("fieldset");
  ratingsFieldset.className = "nexa-home-visit-feedback__ratings";
  ratingsFieldset.append(makeText("legend", "", "Évaluez la prestation de 1 à 5"));
  const ratingInputs = {};
  const ratingLabels = [
    ["quality", "Qualité des soins"], ["professionalism", "Professionnalisme"],
    ["punctuality", "Ponctualité"], ["courtesyRespect", "Courtoisie et respect"], ["satisfaction", "Satisfaction globale"],
  ];
  ratingLabels.forEach(([key, label]) => {
    const select = makeSelect([["", "Choisir"], ["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"], ["5", "5"]], key);
    ratingInputs[key] = select;
    ratingsFieldset.append(makeFieldLabel(label, select));
  });

  const comment = document.createElement("textarea");
  comment.name = "comment";
  comment.maxLength = 500;
  comment.rows = 3;
  comment.setAttribute("aria-label", "Commentaire facultatif");
  const signerName = document.createElement("input");
  signerName.name = "signatureName";
  signerName.type = "text";
  signerName.maxLength = 160;
  signerName.required = true;
  const signerRole = makeSelect([["", "Qui confirme ?"], ["PATIENT", "Le patient"], ["REPRESENTATIVE", "Son représentant"]], "signerRole");
  const confirmed = document.createElement("input");
  confirmed.type = "checkbox";
  confirmed.required = true;
  const signatureConsent = document.createElement("input");
  signatureConsent.type = "checkbox";
  signatureConsent.required = true;
  const confirmationLabel = makeFieldLabel("Je confirme que mes réponses décrivent cette prestation.", confirmed);
  const signatureLabel = makeFieldLabel("J’accepte l’enregistrement de mon nom comme signature électronique du compte rendu.", signatureConsent);
  const cashRequest = document.createElement("input");
  cashRequest.type = "checkbox";
  const cashLabel = makeFieldLabel("Je demande un remboursement en espèces pour cet écart; l’administration le traitera manuellement.", cashRequest);
  cashLabel.hidden = true;

  const updateFields = () => {
    const providerPresent = presence.value === "yes";
    identity.disabled = !providerPresent || !presence.value;
    startsAt.disabled = !providerPresent;
    endsAt.disabled = !providerPresent;
    Object.values(ratingInputs).forEach((input) => { input.disabled = !providerPresent; });
    if (!providerPresent && presence.value === "no") {
      identity.value = "no";
      completion.value = "NOT_COMPLETED";
      completion.disabled = true;
    } else {
      if (completion.disabled) completion.value = "";
      completion.disabled = !providerPresent;
    }
    presenceFields.hidden = !providerPresent;
    ratingsFieldset.hidden = !providerPresent;
    const discrepancy = presence.value === "no" || identity.value === "no" || ["PARTIAL", "NOT_COMPLETED"].includes(completion.value);
    cashLabel.hidden = !discrepancy;
    if (!discrepancy) cashRequest.checked = false;
  };
  [presence, identity, completion].forEach((control) => control.addEventListener("change", updateFields));
  updateFields();

  form.append(
    makeFieldLabel("L’infirmier était-il présent ?", presence),
    makeFieldLabel("La photo et l’identité correspondaient-elles ?", identity),
    makeFieldLabel("État des soins", completion),
    presenceFields,
    ratingsFieldset,
    makeFieldLabel("Commentaire facultatif · n’inscrivez pas de diagnostic ni de détail médical", comment),
    makeFieldLabel("Nom du patient ou du représentant", signerName),
    makeFieldLabel("Signature donnée par", signerRole),
    confirmationLabel,
    signatureLabel,
    cashLabel,
  );
  const message = makeText("p", "nexa-home-visit-feedback__message", "");
  message.setAttribute("role", "status");
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "nexa-patient-appointments__pay";
  submit.textContent = "Envoyer mon compte rendu";
  form.append(submit, message);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!currentUser) return;
    submit.disabled = true;
    message.textContent = "Enregistrement sécurisé du compte rendu…";
    const providerPresent = presence.value === "yes";
    const payload = {
      visitId: visit.visitId, providerPresent,
      identityMatched: providerPresent && identity.value === "yes",
      serviceCompletion: completion.value,
      ...(providerPresent ? {
        visitStartedLocal: startsAt.value, visitEndedLocal: endsAt.value,
        ratings: Object.fromEntries(Object.entries(ratingInputs).map(([key, input]) => [key, Number(input.value)])),
      } : {}),
      comment: comment.value.trim(), signatureName: signerName.value.trim(), signerRole: signerRole.value,
      patientConfirmed: confirmed.checked, signatureConsent: signatureConsent.checked,
      ...(cashRequest.checked ? { refundMethod: "CASH_MANUAL" } : { refundMethod: "NEXA_WALLET" }),
    };
    try {
      const result = await requestNexaFunction(currentUser, "nexaPatientNursingVisitFeedback", "POST", payload);
      const updatedVisit = {
        ...visit, status: result.visitStatus || visit.status, patientCode: result.patientCode || "",
      };
      cachePatientNursingVisit(updatedVisit);
      updateRenderedPatientNursingVisit(updatedVisit);
      message.textContent = result.patientCode
        ? "Compte rendu enregistré. Votre code de clôture est visible ci-dessous et dans votre espace patient."
        : result.visitStatus === "CASH_REFUND_PENDING"
          ? "Compte rendu envoyé. L’administration traitera manuellement votre demande en espèces."
          : "Compte rendu envoyé. NEXA examinera le signalement avant toute clôture ou décision de remboursement.";
      await Promise.all([loadOrders(), loadNursingVisitReports()]);
    } catch (error) {
      message.textContent = error instanceof NexaApiError ? error.message : "Le compte rendu ne peut pas être enregistré pour le moment.";
      submit.disabled = false;
    }
  });
  return form;
}

function renderDiagnosticOrder(order) {
  const item = document.createElement("li");
  item.dataset.orderId = order.id;
  const details = document.createElement("div");
  details.className = "nexa-patient-order__details";
  const statusLabel = order.kind === "nursing" && order.status === "EXPIRED"
    ? "Réservation expirée · période libérée"
    : diagnosticOrderStatusLabels[order.status] || order.status || "État indisponible";
  const providerFallback = order.kind === "pharmacy" ? "Pharmacie NEXA"
    : order.kind === "nursing" ? "Infirmier·ère NEXARIS" : "Centre NEXA";
  details.append(
    makeText("h3", "", `${order.orderNumber} · ${order.providerName || providerFallback}`),
    makeText("p", "nexa-patient-appointments__date", appointmentDate(order.createdAt)),
    makeText("span", "nexa-patient-appointments__status", statusLabel),
  );
  const itemList = document.createElement("ul");
  itemList.className = "nexa-patient-appointments__details-list";
  (Array.isArray(order.items) ? order.items : []).forEach((line) => {
    const entry = document.createElement("li");
    const isPharmacy = order.kind === "pharmacy";
    const description = isPharmacy
      ? `${line.dci || ""}${line.dosage ? ` · ${line.dosage}` : ""}${line.route ? ` · ${line.route}` : ""}${line.pharmaceuticalForm ? ` · ${line.pharmaceuticalForm}` : ""}${Number(line.quantity) > 1 ? ` · Qté ${line.quantity}` : ""}`
      : "";
    const lineTotal = isPharmacy && Number.isSafeInteger(line.lineTotal) ? line.lineTotal : line.price;
    entry.append(makeText("strong", "", line.name || (isPharmacy ? "Médicament" : "Examen")), makeText("span", "", formatMoney(lineTotal)));
    if (description) entry.append(makeText("p", "nexa-patient-appointments__detail", description));
    if (line.preparation) entry.append(makeText("p", "nexa-patient-appointments__detail", "Préparation : " + line.preparation));
    if (line.instructions) entry.append(makeText("p", "nexa-patient-appointments__detail", line.instructions));
    itemList.append(entry);
  });
  if (itemList.childElementCount) details.append(itemList);
  if (order.kind === "pharmacy") {
    details.append(makeText("p", "nexa-patient-appointments__detail", order.deliveryMethod === "delivery" ? "Livraison à domicile" : "Retrait en pharmacie"));
    if (order.deliveryMethod === "delivery" && order.deliveryAddress) {
      const address = order.deliveryAddress;
      details.append(makeText("p", "nexa-patient-appointments__detail", [
        address.recipientName, address.phone, address.addressLine, address.commune, address.department,
        address.instructions ? "Instructions : " + address.instructions : "",
      ].filter(Boolean).join(" · ")));
    }
    const deliverySummary = Number(order.deliveryFee) > 0 ? ` + livraison ${formatMoney(order.deliveryFee)}` : "";
    details.append(makeText("p", "nexa-patient-appointments__detail",
      `Produits ${formatMoney(order.subtotal)}${deliverySummary} + frais ${formatMoney(order.transactionFee)} = total ${formatMoney(order.totalAmount)}. Les frais de transaction ne sont pas remboursables.`));
  } else if (order.kind !== "nursing") details.append(makeText("p", "nexa-patient-appointments__detail",
    `Service ${formatMoney(order.amount)} + frais ${formatMoney(order.transactionFee)} = total ${formatMoney(order.totalAmount)}. Les frais ne sont pas remboursables.`));
  if (order.kind === "nursing") {
    const booking = order.nursingBooking || {};
    details.append(makeText("p", "nexa-patient-appointments__detail", [
      "Semaine du " + (booking.weekStart || "à confirmer"),
      booking.periodLabel || "",
      booking.periodSchedule || "",
      [booking.commune, booking.department].filter(Boolean).join(", "),
    ].filter(Boolean).join(" · ")));
    if (booking.bookingModeDescription) {
      details.append(makeText("p", "nexa-patient-appointments__detail", booking.bookingModeDescription));
    }
    const services = Array.isArray(booking.services) ? booking.services.map((service) => service.label).filter(Boolean) : [];
    if (services.length) details.append(makeText("p", "nexa-patient-appointments__detail", "Services souhaités : " + services.join(" · ")));
    details.append(makeText("p", "nexa-patient-appointments__detail",
      "Prix de la période entière " + formatMoney(order.amount) + " + frais " + formatMoney(order.transactionFee) +
      " = total " + formatMoney(order.totalAmount) + ". Les frais ne sont pas remboursables."));
    renderPatientNursingVisits(details, Array.isArray(order.nursingVisits) ? order.nursingVisits : []);
  }
  if (order.status === "PENDING_PAYMENT" && order.paymentStatus === "PENDING" && order.paymentRef) {
    const message = makeText("p", "nexa-patient-appointments__detail", "");
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    const moncash = document.createElement("button");
    moncash.type = "button";
    moncash.className = "nexa-patient-appointments__pay";
    moncash.textContent = "Payer ou reprendre avec MonCash";
    moncash.addEventListener("click", () => { void resumeDiagnosticOrderMoncash(order.paymentRef, moncash, message, order.kind); });
    const wallet = document.createElement("button");
    wallet.type = "button";
    wallet.className = "nexa-patient-appointments__pay nexa-patient-appointments__pay--secondary";
    wallet.textContent = "Payer avec Wallet NEXA";
    wallet.addEventListener("click", () => { void payDiagnosticOrderWithWallet(order.id, wallet, message, order.kind); });
    details.append(moncash, wallet, message, makeText("p", "nexa-patient-appointments__detail", "Après le démarrage d’un paiement MonCash, le choix Wallet est verrouillé jusqu’à la vérification du paiement."));
  }
  if (order.status === "REFUNDED" && order.refundStatus === "COMPLETED") {
    const refundText = order.refundMethod === "CASH_MANUAL"
      ? "L’administration a enregistré le remboursement manuel en espèces. Les frais de transaction ne sont pas remboursés."
      : "Le prix du service a été crédité à votre Wallet NEXA. Les frais de transaction ne sont pas remboursés.";
    details.append(makeText("p", "nexa-patient-appointments__detail", refundText));
  } else if (order.kind === "nursing" && order.status === "PAYMENT_REVIEW_REQUIRED" && order.paymentStatus === "PAID" && order.refundRequired === true) {
    if (order.refundStatus === "PENDING_MANUAL_CASH" || order.requestedRefundMethod === "CASH_MANUAL") {
      details.append(makeText("p", "nexa-patient-appointments__detail", "Votre demande de remboursement en espèces est en attente de traitement manuel par l’administration. Seul le prix de la période peut être remboursé; les frais de transaction restent acquis à NEXARIS."));
    } else {
      const refundMessage = makeText("p", "nexa-patient-appointments__detail", "");
      const cashButton = document.createElement("button");
      cashButton.type = "button";
      cashButton.className = "nexa-patient-appointments__pay nexa-patient-appointments__pay--secondary";
      cashButton.textContent = "Demander un remboursement en espèces";
      cashButton.addEventListener("click", () => { void requestDiagnosticCashRefund(order.id, cashButton, refundMessage); });
      details.append(
        makeText("p", "nexa-patient-appointments__detail", "La période n’a pas pu être confirmée. NEXA traite le remboursement du prix au Wallet; vous pouvez demander des espèces, qui seront remises manuellement par l’administration. Les frais de transaction ne sont pas remboursés."),
        cashButton,
        refundMessage,
      );
    }
  } else if (order.status === "PROVIDER_REFUSED" && order.paymentStatus === "PAID" && order.refundRequired === true) {
    if (order.refundStatus === "PENDING_MANUAL_CASH" || order.requestedRefundMethod === "CASH_MANUAL") {
      details.append(makeText("p", "nexa-patient-appointments__detail", "Votre demande de remboursement en espèces est en attente de traitement manuel par l’administration. Seul le prix du service peut être remboursé; les frais de transaction restent acquis à NEXARIS."));
    } else if (order.refundStatus === "COMPLETED" && order.refundMethod === "CASH_MANUAL") {
      details.append(makeText("p", "nexa-patient-appointments__detail", "L’administration a enregistré le remboursement manuel en espèces. Les frais de transaction ne sont pas remboursés."));
    } else if (order.refundStatus === "COMPLETED" && order.refundMethod === "NEXA_WALLET") {
      details.append(makeText("p", "nexa-patient-appointments__detail", "Le prix du service a été crédité à votre Wallet NEXA. Les frais de transaction ne sont pas remboursés."));
    } else {
      const refundMessage = makeText("p", "nexa-patient-appointments__detail", "");
      const cashButton = document.createElement("button");
      cashButton.type = "button";
      cashButton.className = "nexa-patient-appointments__pay nexa-patient-appointments__pay--secondary";
      cashButton.textContent = "Demander un remboursement en espèces";
      cashButton.addEventListener("click", () => { void requestDiagnosticCashRefund(order.id, cashButton, refundMessage); });
      details.append(makeText("p", "nexa-patient-appointments__detail", "Le centre a refusé cette commande. Vous pouvez demander un crédit Wallet du prix du service ou une remise en espèces traitée manuellement par l’administration. Les frais ne sont pas remboursés."), cashButton, refundMessage);
    }
  }
  const cashRefundPending = order.refundStatus === "PENDING_MANUAL_CASH" || order.requestedRefundMethod === "CASH_MANUAL";
  const canRequestCashRefund = order.kind !== "nursing" && order.status === "PAYMENT_REVIEW_REQUIRED" &&
    order.settlementStatus === "REVIEW_REQUIRED" && order.paymentStatus === "PAID" && order.refundRequired === true &&
    !cashRefundPending && order.refundStatus !== "COMPLETED" && order.refundMethod !== "NEXA_WALLET";
  const hasSettlementReview = order.kind !== "nursing" &&
    (order.settlementStatus === "REVIEW_REQUIRED" || (order.refundRequired && order.status !== "PROVIDER_REFUSED"));
  if (order.status !== "REFUNDED" && order.refundStatus !== "COMPLETED" && hasSettlementReview) {
    details.append(makeText("p", cashRefundPending ? "nexa-patient-appointments__detail" : "nexa-patient-appointments__record-error",
      cashRefundPending
        ? "Votre demande de remboursement en espèces est en attente de traitement manuel par l’administration. Les frais de transaction ne sont pas remboursés."
        : "NEXA doit rapprocher ce paiement. Ne payez pas une seconde fois; l’administration vous informera du remboursement du prix du service."));
    if (canRequestCashRefund) {
      const refundMessage = makeText("p", "nexa-patient-appointments__detail", "");
      const cashButton = document.createElement("button");
      cashButton.type = "button";
      cashButton.className = "nexa-patient-appointments__pay nexa-patient-appointments__pay--secondary";
      cashButton.textContent = "Demander un remboursement en espèces";
      cashButton.addEventListener("click", () => { void requestDiagnosticCashRefund(order.id, cashButton, refundMessage); });
      details.append(
        makeText("p", "nexa-patient-appointments__detail", "Si le prix du service doit être remboursé, vous pouvez demander une remise en espèces que l’administration effectuera manuellement. Les frais de transaction ne sont pas remboursés."),
        cashButton,
        refundMessage,
      );
    }
  }
  item.append(details);
  return item;
}

async function loadOrders(append = false) {
  if (!currentUser || (append && (!patientOrdersHasMore || patientOrdersLoading || !patientOrdersCursor))) return;
  const generation = append ? patientOrdersGeneration : ++patientOrdersGeneration;
  const requestingUser = currentUser;
  patientOrdersLoading = true;
  if (!append) {
    patientOrdersCursor = "";
    patientOrdersHasMore = false;
    ordersList.replaceChildren();
    ordersEmpty.hidden = true;
    loadMoreOrdersButton.hidden = true;
    loadMoreOrdersButton.disabled = false;
    retryOrdersButton.hidden = true;
  } else {
    loadMoreOrdersButton.disabled = true;
    ordersLoading.textContent = "Chargement des commandes plus anciennes…";
  }
  ordersSection.hidden = false;
  ordersLoading.hidden = false;
  if (!append) ordersLoading.textContent = "Chargement de vos commandes…";
  ordersError.hidden = true;
  try {
    const result = await requestNexaFunction(
      requestingUser,
      "nexaPatientOrders",
      "GET",
      undefined,
      append ? { cursor: patientOrdersCursor } : undefined,
    );
    if (generation !== patientOrdersGeneration || currentUser !== requestingUser) return;
    const orders = Array.isArray(result.orders) ? result.orders : [];
    patientOrdersHasMore = result.hasMore === true && typeof result.nextCursor === "string" && result.nextCursor.length > 0;
    patientOrdersCursor = patientOrdersHasMore ? result.nextCursor : "";
    ordersLoading.hidden = true;
    if (!orders.length && !append && !patientOrdersHasMore) {
      ordersEmpty.hidden = false;
      loadMoreOrdersButton.hidden = true;
      if (window.location.hash === "#commandes") requestAnimationFrame(() => ordersSection.scrollIntoView({ block: "start" }));
      return;
    }
    if (!orders.length && patientOrdersHasMore) {
      ordersLoading.hidden = false;
      ordersLoading.textContent = "Aucune commande dans cette page; vous pouvez continuer vers les plus anciennes.";
    } else {
      const cards = orders.map((order) => renderDiagnosticOrder({
        ...order, nursingVisits: patientNursingVisitsForOrder(order.id),
      }));
      if (append) ordersList.append(...cards);
      else ordersList.replaceChildren(...cards);
    }
    loadMoreOrdersButton.hidden = !patientOrdersHasMore;
    if (window.location.hash === "#commandes" && !append) requestAnimationFrame(() => ordersSection.scrollIntoView({ block: "start" }));
  } catch (error) {
    if (generation !== patientOrdersGeneration || currentUser !== requestingUser) return;
    ordersLoading.hidden = true;
    ordersError.hidden = false;
    ordersError.textContent = error instanceof NexaApiError ? error.message : "Vos commandes ne peuvent pas être chargées pour le moment.";
    retryOrdersButton.hidden = append;
    loadMoreOrdersButton.hidden = !append || !patientOrdersCursor;
  } finally {
    if (generation === patientOrdersGeneration && currentUser === requestingUser) {
      patientOrdersLoading = false;
      loadMoreOrdersButton.disabled = false;
      loadMoreOrdersButton.textContent = "Afficher les commandes plus anciennes";
    }
  }
}

async function loadPatientNursingVisits(user = currentUser, append = false) {
  if (!user || (append && (!patientNursingVisitsHasMore || patientNursingVisitsLoadingState || !patientNursingVisitsCursor))) return;
  const generation = append ? patientNursingVisitsGeneration : ++patientNursingVisitsGeneration;
  patientNursingVisitsLoadingState = true;
  if (!append) {
    patientNursingVisitsCursor = "";
    patientNursingVisitsHasMore = false;
    patientNursingVisitsByOrder.clear();
    for (const section of ordersList.querySelectorAll(".nexa-patient-order__nursing-visits")) section.replaceChildren();
    loadMorePatientNursingVisitsButton.hidden = true;
    retryPatientNursingVisitsButton.hidden = true;
    retryPatientNursingVisitsButton.disabled = false;
  } else {
    loadMorePatientNursingVisitsButton.disabled = true;
  }
  patientNursingVisitsLoading.textContent = append
    ? "Chargement des prestations plus anciennes…"
    : "Chargement des prestations infirmières…";
  patientNursingVisitsLoading.hidden = false;
  patientNursingVisitsError.hidden = true;
  try {
    const result = await requestNexaFunction(user, "nexaPatientNursingVisits", "GET", undefined,
      append ? { cursor: patientNursingVisitsCursor } : undefined);
    if (generation !== patientNursingVisitsGeneration || currentUser !== user) return;
    const pageHasMore = result.hasMore === true && typeof result.nextCursor === "string" && result.nextCursor.length > 0;
    patientNursingVisitsCursor = pageHasMore ? result.nextCursor : "";
    patientNursingVisitsHasMore = pageHasMore;
    for (const visit of Array.isArray(result.visits) ? result.visits : []) cachePatientNursingVisit(visit);
    patientNursingVisitsLoading.hidden = true;
    loadMorePatientNursingVisitsButton.hidden = !patientNursingVisitsHasMore;
    retryPatientNursingVisitsButton.hidden = true;
  } catch (error) {
    if (generation !== patientNursingVisitsGeneration || currentUser !== user) return;
    patientNursingVisitsLoading.hidden = true;
    patientNursingVisitsError.textContent = error instanceof NexaApiError
      ? error.message : "Les prestations infirmières ne peuvent pas être chargées pour le moment.";
    patientNursingVisitsError.hidden = false;
    retryPatientNursingVisitsButton.hidden = append || Boolean(patientNursingVisitsCursor);
    loadMorePatientNursingVisitsButton.hidden = !append || !patientNursingVisitsCursor;
  } finally {
    if (generation === patientNursingVisitsGeneration && currentUser === user) {
      patientNursingVisitsLoadingState = false;
      loadMorePatientNursingVisitsButton.disabled = false;
      loadMorePatientNursingVisitsButton.textContent = "Afficher les prestations plus anciennes";
    }
  }
}

function renderPatientPrescription(prescription) {
  const item = document.createElement("li");
  item.append(
    makeText("h3", "", `Ordonnance · version ${prescription.version || 1}`),
    makeText("p", "nexa-patient-appointments__date", [
      prescription.providerName || "Médecin NEXA",
      prescription.specialtyName || "",
      prescription.validatedAt ? "Transmise le " + appointmentDate(prescription.validatedAt) : "",
    ].filter(Boolean).join(" · ")),
  );
  for (const medication of Array.isArray(prescription.medications) ? prescription.medications : []) {
    const entry = document.createElement("p");
    entry.className = "nexa-patient-appointments__detail";
    const description = [medication.dosage, medication.form, medication.route, medication.duration].filter(Boolean).join(" · ");
    entry.textContent = `${medication.name || "Médicament"}${description ? " — " + description : ""}${medication.quantity !== null && medication.quantity !== undefined ? " · Quantité : " + medication.quantity : ""}${medication.instructions ? " · " + medication.instructions : ""}`;
    item.append(entry);
  }
  for (const [label, field] of [["Laboratoire", "labExams"], ["Imagerie", "imagingExams"]]) {
    const values = Array.isArray(prescription[field]) ? prescription[field].filter((value) => typeof value === "string" && value.trim()) : [];
    if (values.length) item.append(makeText("p", "nexa-patient-appointments__detail", `${label} : ${values.join(" · ")}`));
  }
  if (prescription.notes) item.append(makeText("p", "nexa-patient-appointments__detail", "Instructions : " + prescription.notes));
  if (prescription.signature?.name) {
    item.append(makeText("p", "nexa-patient-appointments__detail", `Signée par ${prescription.signature.name}${prescription.signature.specialty ? " · " + prescription.signature.specialty : ""}`));
  }
  const availabilityButton = document.createElement("button");
  availabilityButton.type = "button";
  availabilityButton.className = "nexa-patient-appointments__pay nexa-patient-appointments__pay--secondary";
  availabilityButton.textContent = "Rechercher les offres correspondantes";
  const availabilityPanel = document.createElement("div");
  availabilityPanel.className = "nexa-prescription-availability";
  availabilityPanel.setAttribute("aria-live", "polite");
  availabilityPanel.hidden = true;
  const availabilityMoreButton = document.createElement("button");
  availabilityMoreButton.type = "button";
  availabilityMoreButton.className = "nexa-patient-appointments__pay nexa-patient-appointments__pay--secondary";
  availabilityMoreButton.textContent = "Continuer la recherche dans les catalogues";
  availabilityMoreButton.hidden = true;
  const availabilityState = { cursor: null, lines: [], searchLocation: null, loading: false, prescriptionId: prescription.id };
  availabilityButton.addEventListener("click", () => {
    void checkPrescriptionAvailability(prescription, availabilityButton, availabilityMoreButton, availabilityPanel, availabilityState);
  });
  availabilityMoreButton.addEventListener("click", () => {
    void checkPrescriptionAvailability(prescription, availabilityButton, availabilityMoreButton, availabilityPanel, availabilityState, true);
  });
  const pdfButton = document.createElement("button");
  pdfButton.type = "button";
  pdfButton.className = "nexa-patient-appointments__pay nexa-patient-appointments__pay--secondary";
  pdfButton.textContent = "Télécharger l’ordonnance PDF";
  const pdfStatus = makeText("p", "nexa-patient-appointments__record-message", "");
  pdfStatus.setAttribute("role", "status");
  pdfStatus.setAttribute("aria-live", "polite");
  pdfButton.addEventListener("click", () => { void downloadPrescriptionPdf(prescription, pdfButton, pdfStatus); });
  item.append(availabilityButton, availabilityPanel, availabilityMoreButton, pdfButton, pdfStatus);
  for (const [label, type, present] of [
    ["Voir les pharmacies Nexa - Pharma", "pharmacies", Boolean(prescription.medications?.length)],
    ["Voir les laboratoires Nexa - Lab", "laboratories", Boolean(prescription.labExams?.length)],
    ["Voir les centres Nexa - Imaging", "imaging-centers", Boolean(prescription.imagingExams?.length)],
  ]) {
    if (!present) continue;
    const link = document.createElement("a");
    link.className = "nexa-patient-appointments__link";
    link.href = `./catalog.html?type=${encodeURIComponent(type)}`;
    link.textContent = label;
    item.append(link);
  }
  return item;
}

async function downloadPrescriptionPdf(prescription, button, status) {
  if (!currentUser) return;
  button.disabled = true;
  status.textContent = "Préparation du PDF sécurisé…";
  try {
    const blob = await downloadNexaPdf(currentUser, "nexaPrescriptionPdf", { prescriptionId: prescription.id });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `nexa-ordonnance-v${Number(prescription.version) || 1}.pdf`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    status.textContent = "Le téléchargement de votre ordonnance a commencé.";
  } catch (error) {
    status.textContent = error instanceof NexaApiError ? error.message : "L’ordonnance PDF n’a pas pu être téléchargée.";
  } finally {
    button.disabled = false;
  }
}

function availabilityText(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").trim();
}

function availabilityLocationRank(searchLocation, offer) {
  const department = availabilityText(offer.department);
  const commune = availabilityText(offer.commune);
  const wantedDepartment = availabilityText(searchLocation?.department);
  const wantedCommune = availabilityText(searchLocation?.commune);
  if (commune && wantedCommune && commune === wantedCommune && department === wantedDepartment) return 0;
  if (department && wantedDepartment && department === wantedDepartment) return 1;
  return 2;
}

function renderPrescriptionAvailability(state, panel, moreButton) {
  panel.replaceChildren();
  if (!state.lines.length) {
    panel.append(makeText("p", "nexa-patient-appointments__detail", "Aucun médicament ou examen exploitable n’a été trouvé dans cette ordonnance."));
    moreButton.hidden = !state.cursor;
    return;
  }
  for (const line of state.lines) {
    const section = document.createElement("section");
    section.className = "nexa-prescription-availability__line";
    const status = line.offers.length
      ? line.searchComplete ? "Offres trouvées" : "Offres trouvées · recherche partielle"
      : line.searchComplete ? "Aucune correspondance actuellement" : "Aucune correspondance dans les catalogues déjà parcourus";
    section.append(makeText("strong", "", `${line.label} · ${status}`));
    const visibleOffers = line.offers.slice(0, line.visibleOfferCount);
    for (const offer of visibleOffers) {
      const card = document.createElement("article");
      card.className = "nexa-prescription-availability__offer";
      card.append(makeText("strong", "", offer.providerName || "Partenaire NEXA"));
      const details = [
        offer.name,
        offer.dosage,
        offer.route,
        offer.form,
        [offer.commune, offer.department].filter(Boolean).join(", "),
        Number.isSafeInteger(offer.price) ? `${new Intl.NumberFormat("fr-HT").format(offer.price)} HTG` : "Prix à confirmer",
        Number.isSafeInteger(offer.stock) ? `${offer.stock} en stock` : "",
      ].filter(Boolean).join(" · ");
      card.append(makeText("p", "nexa-patient-appointments__detail", details));
      if (offer.appointmentRequired) card.append(makeText("p", "nexa-patient-appointments__detail", "Cette offre nécessite un rendez-vous auprès du centre."));
      const type = line.type === "medication" ? "pharmacies" : line.type === "laboratory" ? "laboratories" : "imaging-centers";
      const link = document.createElement("a");
      link.className = "nexa-patient-appointments__link";
      link.href = `./catalog.html?${new URLSearchParams({ type, q: offer.name || line.label, prescriptionId: state.prescriptionId, offerId: offer.id })}`;
      link.textContent = "Ouvrir le catalogue NEXA";
      card.append(link);
      section.append(card);
    }
    if (!line.offers.length) {
      section.append(makeText("p", "nexa-patient-appointments__detail", line.searchComplete
        ? "Vous pouvez réessayer plus tard; cette recherche ne réserve pas de produit ni de créneau."
        : "La recherche continue; cette partie du catalogue ne contient pas encore de correspondance."));
    } else if (line.offers.length > line.visibleOfferCount) {
      const showMore = document.createElement("button");
      showMore.type = "button";
      showMore.className = "nexa-patient-appointments__pay nexa-patient-appointments__pay--secondary";
      showMore.textContent = "Afficher 20 offres supplémentaires";
      showMore.addEventListener("click", () => {
        line.visibleOfferCount += 20;
        renderPrescriptionAvailability(state, panel, moreButton);
      });
      section.append(showMore);
    }
    panel.append(section);
  }
  moreButton.hidden = !state.cursor;
}

async function checkPrescriptionAvailability(prescription, button, moreButton, panel, state, append = false) {
  if (!currentUser || state.loading) return;
  const cursor = append ? state.cursor : null;
  state.loading = true;
  button.disabled = true;
  moreButton.disabled = true;
  button.textContent = append ? "Recherche des offres NEXA…" : "Recherche des offres NEXA…";
  panel.hidden = false;
  if (!append) {
    state.cursor = null;
    state.lines = [];
    moreButton.hidden = true;
    panel.replaceChildren(makeText("p", "nexa-patient-appointments__detail", "Recherche dans les offres publiées par les partenaires vérifiés…"));
  }
  moreButton.textContent = "Recherche de la suite des catalogues…";
  try {
    const result = await requestNexaFunction(currentUser, "nexaPrescriptionAvailability", "GET", undefined, {
      prescriptionId: prescription.id,
      ...(cursor ? { cursor } : {}),
    });
    state.searchLocation = result.searchLocation || state.searchLocation;
    for (const pageLine of Array.isArray(result.lines) ? result.lines : []) {
      let line = state.lines.find((item) => item.id === pageLine.id);
      if (!line) {
        line = { ...pageLine, offers: [], visibleOfferCount: 20 };
        state.lines.push(line);
      }
      line.searchComplete = pageLine.searchComplete === true;
      line.status = pageLine.status;
      const knownOffers = new Set(line.offers.map((offer) => `${offer.catalogType}:${offer.id}`));
      for (const offer of Array.isArray(pageLine.offers) ? pageLine.offers : []) {
        const key = `${offer.catalogType}:${offer.id}`;
        if (!knownOffers.has(key)) {
          line.offers.push(offer);
          knownOffers.add(key);
        }
      }
      line.offers.sort((left, right) => availabilityLocationRank(state.searchLocation, left) - availabilityLocationRank(state.searchLocation, right) ||
        (Number.isSafeInteger(left.price) ? left.price : Number.MAX_SAFE_INTEGER) - (Number.isSafeInteger(right.price) ? right.price : Number.MAX_SAFE_INTEGER));
    }
    state.cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
    renderPrescriptionAvailability(state, panel, moreButton);
    button.textContent = "Actualiser les offres correspondantes";
    moreButton.textContent = "Continuer la recherche dans les catalogues";
  } catch (error) {
    if (!append) panel.replaceChildren();
    panel.append(makeText("p", "nexa-patient-appointments__record-error", error instanceof NexaApiError
      ? error.message
      : "Les offres de cette ordonnance ne sont pas accessibles pour le moment."));
    moreButton.hidden = !state.cursor;
    button.textContent = append ? "Actualiser les offres correspondantes" : "Réessayer la recherche";
    moreButton.textContent = "Réessayer la suite des catalogues";
  } finally {
    state.loading = false;
    button.disabled = false;
    moreButton.disabled = false;
  }
}

async function loadPrescriptions() {
  if (!currentUser) return;
  prescriptionsSection.hidden = false;
  prescriptionsLoading.hidden = false;
  prescriptionsError.hidden = true;
  prescriptionsEmpty.hidden = true;
  prescriptionsList.replaceChildren();
  retryPrescriptionsButton.hidden = true;
  try {
    const result = await requestNexaFunction(currentUser, "nexaPatientPrescriptions");
    const prescriptions = Array.isArray(result.prescriptions) ? result.prescriptions : [];
    prescriptionsLoading.hidden = true;
    prescriptionsEmpty.hidden = prescriptions.length > 0;
    prescriptionsList.replaceChildren(...prescriptions.map(renderPatientPrescription));
  } catch (error) {
    prescriptionsLoading.hidden = true;
    prescriptionsError.hidden = false;
    prescriptionsError.textContent = error instanceof NexaApiError ? error.message : "Vos ordonnances ne sont pas accessibles pour le moment.";
    retryPrescriptionsButton.hidden = false;
  }
}

function resultDate(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime())
    ? "Date indisponible"
    : new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(date);
}

function safeResultStorageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "storage.googleapis.com" || url.hostname.endsWith(".storage.googleapis.com"))
      ? url.href
      : "";
  } catch {
    return "";
  }
}

async function openPatientResultFile(result, file, button) {
  if (!currentUser) return;
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = "Ouverture sécurisée…";
  try {
    const functionName = result.source === "DIAGNOSTIC_CENTER" ? "nexaPatientDiagnosticCenterResultFile" : "nexaPatientResultFile";
    const response = await requestNexaFunction(currentUser, functionName, "GET", undefined, {
      resultId: result.id,
      fileId: file.id,
    });
    const url = safeResultStorageUrl(response.url);
    if (!url) throw new Error("Le lien sécurisé du fichier n’est pas valide.");
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.setAttribute("aria-label", "Ouvrir le fichier " + file.fileName + " dans un nouvel onglet");
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    button.textContent = "Document ouvert";
  } catch (error) {
    button.textContent = error instanceof NexaApiError ? error.message : "Le document n’a pas pu être ouvert.";
  } finally {
    button.disabled = false;
    if (button.textContent === "Ouverture sécurisée…") button.textContent = previous;
  }
}

function renderPatientResult(result) {
  const item = document.createElement("li");
  const fromCentre = result.source === "DIAGNOSTIC_CENTER";
  item.append(
    makeText("strong", "", result.examName || "Résultat médical"),
    makeText("span", "", fromCentre ? "Transmis par " + (result.providerName || "un centre partenaire NEXA") : "Transmis au médecin prescripteur"),
    makeText("small", "", (fromCentre ? "Rendu disponible le " : "Déposé le ") + resultDate(result.transferredAt)),
  );
  if (fromCentre) {
    item.append(makeText("small", "", "Résultat vérifié par NEXA et disponible dans votre espace."));
  } else if (["CLOSED", "FOLLOW_UP_CLOSED"].includes(result.followUpStatus)) {
    item.append(makeText("small", "", "Le suivi du médecin est terminé."));
  } else if (result.followUpStatus === "EXAMINEE") {
    item.append(makeText("small", "", "Le médecin prescripteur a examiné ce résultat le " + resultDate(result.reviewedAt) + ". Le suivi reste ouvert."));
  } else if (result.followUpStatus === "RECU") {
    item.append(makeText("small", "", "Le résultat a été transmis au médecin prescripteur et attend son examen."));
  } else {
    item.append(makeText("small", "", "Le médecin prescripteur dispose d’un accès sécurisé à ce résultat."));
  }
  for (const file of Array.isArray(result.files) ? result.files : []) {
    const button = makeText("button", "nexa-patient-results__file", "Ouvrir le document · " + (file.category || "résultat"));
    button.type = "button";
    button.addEventListener("click", () => void openPatientResultFile(result, file, button));
    item.append(button);
  }
  for (const action of Array.isArray(result.followUpActions) ? result.followUpActions : []) {
    if (action.type === "NOTE" && action.content) {
      item.append(makeText("p", "nexa-patient-appointments__detail", "Note de suivi · " + action.content));
    } else if (action.type === "PRESCRIPTION") {
      item.append(makeText("p", "nexa-patient-appointments__detail", "Une ordonnance de suivi est disponible dans « Mes ordonnances »."));
    } else if (action.type === "APPOINTMENT") {
      if (action.proposalStatus === "PENDING" && action.providerUid && action.slotId && action.proposalId) {
        const link = makeText("a", "nexa-patient-appointments__pay", "Réserver le rendez-vous de suivi proposé" );
        const booking = new URL("./rendez-vous.html", window.location.href);
        booking.searchParams.set("providerUid", action.providerUid);
        booking.searchParams.set("slotId", action.slotId);
        booking.searchParams.set("proposalId", action.proposalId);
        link.href = booking.href;
        item.append(link);
      } else if (action.proposalStatus === "BOOKED") {
        item.append(makeText("p", "nexa-patient-appointments__detail", "Le rendez-vous de suivi proposé est réservé."));
      } else {
        item.append(makeText("p", "nexa-patient-appointments__detail", "Une proposition de rendez-vous de suivi n’est plus disponible."));
      }
    }
  }
  return item;
}

function renderResultUpload(exam) {
  const card = document.createElement("article");
  card.className = "nexa-patient-results__exam";
  const heading = makeText("h3", "", exam.examName || "Examen prescrit");
  const provider = [exam.providerName, exam.specialtyName].filter(Boolean).join(" · ");
  card.append(heading, makeText("p", "", "Ordonnance de " + (provider || "votre médecin NEXA") + " · " +
    (exam.examType === "laboratory" ? "Nexa - Lab" : "Nexa - Imaging")));

  const form = document.createElement("form");
  const fileLabel = document.createElement("label");
  fileLabel.textContent = "Fichiers du résultat (PDF, JPG ou PNG · 15 Mio maximum par fichier)";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "application/pdf,image/jpeg,image/png";
  fileInput.multiple = true;
  fileInput.required = true;
  fileInput.setAttribute("aria-label", "Sélectionner les fichiers de " + (exam.examName || "l’examen"));
  const fileList = document.createElement("ul");
  fileList.className = "nexa-patient-results__files";
  fileInput.addEventListener("change", () => {
    const selected = Array.from(fileInput.files || []);
    fileList.replaceChildren(...selected.map((file) => makeText("li", "", file.name + " · " + (file.size / (1024 * 1024)).toFixed(2) + " Mio")));
  });
  fileLabel.append(fileInput);

  const confirmLabel = document.createElement("label");
  confirmLabel.className = "nexa-patient-results__confirm";
  const confirm = document.createElement("input");
  confirm.type = "checkbox";
  confirm.required = true;
  confirmLabel.append(confirm, document.createTextNode("Je confirme que ces documents concernent bien mon examen et mon dossier."));

  const feedback = makeText("p", "nexa-patient-results__feedback", "");
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  const button = makeText("button", "nexa-patient-results__submit", "Transmettre le résultat au médecin");
  button.type = "submit";
  form.append(fileLabel, fileList, confirmLabel, button, feedback);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitPatientResult(event, exam, fileInput, confirm, button, feedback);
  });
  card.append(form);
  return card;
}

async function submitPatientResult(event, exam, fileInput, confirm, button, feedback) {
  if (!currentUser || busy) return;
  const files = Array.from(fileInput.files || []);
  const allowedTypes = new Set(["application/pdf", "image/jpeg", "image/png"]);
  if (!confirm.checked) {
    confirm.focus();
    feedback.textContent = "Confirmez que le document correspond à l’examen prescrit.";
    return;
  }
  if (!files.length || files.length > 20 || files.some((file) => !allowedTypes.has(file.type) || file.size < 1 || file.size > 15 * 1024 * 1024)) {
    feedback.textContent = "Choisissez de 1 à 20 fichiers PDF, JPG ou PNG de 15 Mio maximum chacun.";
    return;
  }
  busy = true;
  button.disabled = true;
  reloadPatientResultsButton.disabled = true;
  let uploadSessionId = "";
  feedback.textContent = "Ouverture de la session sécurisée…";
  try {
    const category = exam.examType === "laboratory" ? "LAB_RESULT" : "IMAGING";
    const started = await requestNexaFunction(currentUser, "nexaPatientResultUploadStart", "POST", {
      prescriptionId: exam.prescriptionId,
      examType: exam.examType,
      examIndex: exam.examIndex,
      confirmMatch: true,
      files: files.map((file) => ({ category, fileName: file.name, contentType: file.type, size: file.size })),
    });
    uploadSessionId = started.uploadSessionId;
    const policies = Array.isArray(started.files) ? started.files : [];
    if (policies.length !== files.length) throw new Error("Le serveur n’a pas préparé tous les fichiers.");
    for (let index = 0; index < files.length; index += 1) {
      const policy = policies[index];
      const target = safeResultStorageUrl(policy.uploadUrl);
      if (!target || Number(policy.expectedSize) !== files[index].size) throw new Error("Le lien sécurisé du téléversement n’est pas valide.");
      feedback.textContent = "Téléversement sécurisé du fichier " + (index + 1) + " sur " + files.length + "…";
      const data = new FormData();
      Object.entries(policy.fields || {}).forEach(([key, value]) => data.append(key, String(value)));
      data.append("file", files[index], files[index].name);
      const response = await fetch(target, { method: "POST", body: data, cache: "no-store" });
      if (!response.ok) throw new Error("Le téléversement sécurisé n’a pas abouti. Réessayez.");
    }
    feedback.textContent = "Analyse de sécurité et transmission au médecin…";
    const submitted = await requestNexaFunction(currentUser, "nexaPatientResultSubmit", "POST", { uploadSessionId });
    uploadSessionId = "";
    showPatientResultMessage(patientResultsNotice, submitted.message || "Votre résultat a été transmis au médecin prescripteur.");
    formClear(fileInput, confirm);
    await loadPatientResults();
  } catch (error) {
    if (uploadSessionId) {
      await requestNexaFunction(currentUser, "nexaPatientResultUploadCancel", "POST", { uploadSessionId }).catch(() => undefined);
    }
    feedback.textContent = error instanceof NexaApiError
      ? error.message
      : error instanceof Error ? error.message : "Le résultat n’a pas pu être transmis.";
  } finally {
    busy = false;
    button.disabled = false;
    reloadPatientResultsButton.disabled = false;
  }
}

function formClear(fileInput, confirm) {
  fileInput.value = "";
  confirm.checked = false;
  fileInput.dispatchEvent(new Event("change"));
}

function showPatientResultMessage(element, message) {
  element.textContent = message || "";
  element.hidden = !message;
}

async function loadPatientResults() {
  if (!currentUser) return;
  patientResultsSection.hidden = false;
  patientResultsLoading.hidden = false;
  patientResultsError.hidden = true;
  patientResultsEmpty.hidden = true;
  patientResultsList.replaceChildren();
  patientResultsUploadList.replaceChildren();
  patientResultsUploadList.hidden = true;
  try {
    const result = await requestNexaFunction(currentUser, "nexaPatientDiagnosticResults");
    const submitted = Array.isArray(result.results) ? result.results : [];
    const exams = Array.isArray(result.uploadableExams) ? result.uploadableExams : [];
    patientResultsList.replaceChildren(...submitted.map(renderPatientResult));
    patientResultsUploadList.replaceChildren(...exams.map(renderResultUpload));
    patientResultsUploadList.hidden = exams.length === 0;
    patientResultsEmpty.hidden = submitted.length > 0 || exams.length > 0;
  } catch (error) {
    patientResultsError.textContent = error instanceof NexaApiError ? error.message : "Vos résultats ne sont pas accessibles pour le moment.";
    patientResultsError.hidden = false;
  } finally {
    patientResultsLoading.hidden = true;
  }
}

const clinicalAccessStatusLabels = {
  ISSUED: "Code émis · en attente du médecin",
  CLAIMED: "Code utilisé · accès clinique actif",
  EXPIRED: "Expirée",
  REVOKED: "Révoquée",
};

function clinicalAccessDate(value) {
  const date = new Date(value || "");
  return !value || Number.isNaN(date.getTime())
    ? "Date indisponible"
    : new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(date);
}

function clinicalAccessMessage(element, message) {
  element.textContent = message || "";
  element.hidden = !message;
}

function clearIssuedClinicalAccessCode() {
  lastIssuedClinicalAccessGrantId = "";
  clinicalAccessCode.value = "";
  clinicalAccessCodeProvider.textContent = "";
  clinicalAccessCodeExpiry.textContent = "";
  clinicalAccessCodePanel.hidden = true;
}

function renderClinicalAccessGrant(grant) {
  const item = document.createElement("li");
  const details = document.createElement("div");
  const name = makeText("strong", "", grant.providerName || "Médecin NEXA");
  const status = makeText("small", "", clinicalAccessStatusLabels[grant.status] || "État à vérifier");
  const expiration = grant.status === "CLAIMED" ? grant.accessExpiresAt : grant.expiresAt;
  const timing = makeText("small", "", [
    grant.issuedAt ? `Créée le ${clinicalAccessDate(grant.issuedAt)}` : "Date de création indisponible",
    expiration ? `Expire le ${clinicalAccessDate(expiration)}` : "",
  ].filter(Boolean).join(" · "));
  details.append(name, status, timing);
  item.append(details);

  if (["ISSUED", "CLAIMED"].includes(grant.status) && typeof grant.grantId === "string") {
    const revokeButton = makeText("button", "nexa-auth-button nexa-auth-button--google", "Révoquer");
    revokeButton.type = "button";
    revokeButton.setAttribute("aria-label", `Révoquer l’accès de ${grant.providerName || "ce médecin"}`);
    revokeButton.addEventListener("click", () => void revokeClinicalAccess(grant.grantId, revokeButton));
    item.append(revokeButton);
  }
  return item;
}

async function loadClinicalAccess() {
  if (!currentUser) return;
  const user = currentUser;
  clinicalAccessSection.hidden = false;
  clinicalAccessLoading.hidden = false;
  clinicalAccessListError.hidden = true;
  clinicalAccessError.hidden = true;
  clinicalAccessSubmit.disabled = true;
  try {
    const [accessResult, providerResult] = await Promise.all([
      requestNexaFunction(user, "nexaPatientClinicalAccess"),
      requestNexaFunction(user, "publicCatalog", "GET", undefined, { type: "doctors" }),
    ]);
    if (currentUser !== user) return;

    const providers = Array.isArray(providerResult.results)
      ? providerResult.results.filter((provider) => provider && typeof provider.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(provider.id) && typeof provider.name === "string")
      : [];
    const selectedProviderUid = clinicalAccessProvider.value;
    clinicalAccessProvider.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = providers.length ? "Choisissez un médecin" : "Aucun médecin disponible";
    clinicalAccessProvider.append(placeholder);
    for (const provider of providers) {
      const option = document.createElement("option");
      option.value = provider.id;
      option.textContent = [provider.name, provider.specialty || "", provider.department || ""].filter(Boolean).join(" · ");
      clinicalAccessProvider.append(option);
    }
    if (providers.some((provider) => provider.id === selectedProviderUid)) clinicalAccessProvider.value = selectedProviderUid;
    clinicalAccessSubmit.disabled = providers.length === 0 || !clinicalAccessProvider.value;

    const grants = Array.isArray(accessResult.grants) ? accessResult.grants : [];
    clinicalAccessList.replaceChildren(...grants.map(renderClinicalAccessGrant));
    clinicalAccessEmpty.hidden = grants.length > 0;
  } catch (error) {
    if (currentUser !== user) return;
    const message = error instanceof NexaApiError ? error.message : "Les autorisations cliniques ne peuvent pas être chargées pour le moment.";
    clinicalAccessListError.textContent = message;
    clinicalAccessListError.hidden = false;
    clinicalAccessEmpty.hidden = true;
    clinicalAccessList.replaceChildren();
    clinicalAccessError.textContent = message;
    clinicalAccessError.hidden = false;
  } finally {
    if (currentUser === user) clinicalAccessLoading.hidden = true;
  }
}

async function revokeClinicalAccess(grantId, button) {
  if (!currentUser || button.disabled) return;
  const user = currentUser;
  button.disabled = true;
  clinicalAccessListError.hidden = true;
  try {
    await requestNexaFunction(user, "nexaPatientClinicalAccess", "DELETE", { grantId });
    if (currentUser !== user) return;
    if (lastIssuedClinicalAccessGrantId === grantId) clearIssuedClinicalAccessCode();
    clinicalAccessMessage(clinicalAccessStatus, "L’autorisation clinique a été révoquée.");
    await loadClinicalAccess();
  } catch (error) {
    if (currentUser !== user) return;
    clinicalAccessListError.textContent = error instanceof NexaApiError ? error.message : "L’autorisation ne peut pas être révoquée pour le moment.";
    clinicalAccessListError.hidden = false;
  } finally {
    button.disabled = false;
  }
}

function notificationDate(value) {
  const date = new Date(value);
  return !value || Number.isNaN(date.getTime())
    ? "Date indisponible"
    : new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(date);
}

function renderNotification(notification) {
  const item = document.createElement("article");
  item.className = "health-notification" + (notification.read ? "" : " is-unread");
  item.setAttribute("role", "listitem");
  const icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  const iconGlyph = document.createElement("i");
  iconGlyph.className = "fas fa-bell";
  icon.append(iconGlyph);

  const content = document.createElement("div");
  const title = makeText("strong", "", notification.title || "Notification NEXA");
  const body = makeText("p", "", notification.body || "Une mise à jour est disponible.");
  const openLink = document.createElement("a");
  openLink.className = "nexa-notifications__open";
  openLink.textContent = "Ouvrir";
  try {
    const basePath = new URL("./", window.location.href);
    const path = typeof notification.url === "string" && notification.url.startsWith("/") ? notification.url.slice(1) : "espace-patient.html";
    const destination = new URL(path, basePath);
    if (destination.origin !== window.location.origin) throw new Error("external-notification-link");
    openLink.href = destination.href;
  } catch {
    openLink.href = "./espace-patient.html";
  }
  content.append(title, body, openLink);

  const time = document.createElement("time");
  time.dateTime = notification.createdAt || "";
  time.textContent = notificationDate(notification.createdAt);
  item.append(icon, content, time);
  if (!notification.read) {
    const markRead = document.createElement("button");
    markRead.type = "button";
    markRead.className = "nexa-notifications__mark-read";
    markRead.textContent = "Marquer comme lue";
    markRead.setAttribute("aria-label", `Marquer comme lue : ${notification.title || "notification NEXA"}`);
    markRead.addEventListener("click", () => { void markNotificationRead(notification.id, markRead); });
    item.append(markRead);
  }
  return item;
}

async function loadNotifications() {
  if (!currentUser) return;
  notificationsSection.hidden = false;
  notificationsLoading.hidden = false;
  notificationsError.hidden = true;
  notificationsEmpty.hidden = true;
  notificationsList.replaceChildren();
  retryNotificationsButton.hidden = true;
  try {
    const result = await requestNexaFunction(currentUser, "nexaUserNotifications");
    notifications = Array.isArray(result.notifications) ? result.notifications : [];
    notificationsLoading.hidden = true;
    const unreadCount = notifications.filter((notification) => !notification.read).length;
    notificationsCount.textContent = String(unreadCount);
    notificationsCount.setAttribute("aria-label", `${unreadCount} notification${unreadCount === 1 ? "" : "s"} non lue${unreadCount === 1 ? "" : "s"}`);
    notificationsEmpty.hidden = notifications.length > 0;
    notificationsList.replaceChildren(...notifications.map(renderNotification));
  } catch (error) {
    notificationsLoading.hidden = true;
    notificationsError.hidden = false;
    notificationsError.textContent = error instanceof NexaApiError
      ? error.message
      : "Vos notifications ne peuvent pas être chargées pour le moment.";
    retryNotificationsButton.hidden = false;
  }
}

function setNotificationPreferenceMessage(message, isError = false) {
  notificationPreferencesError.hidden = !isError || !message;
  notificationPreferencesStatus.hidden = isError || !message;
  notificationPreferencesError.textContent = isError ? message : "";
  notificationPreferencesStatus.textContent = isError ? "" : message;
}

function updateNotificationPreferenceControls() {
  if (!notificationPreferences) return;
  const verifiedEmailAvailable = notificationPreferences.emailAvailable &&
    Boolean(currentUser?.email) && currentUser?.emailVerified === true;
  notificationEmailToggle.checked = notificationPreferences.emailEnabled;
  notificationEmailToggle.disabled = notificationPreferences.busy || (!verifiedEmailAvailable && !notificationPreferences.emailEnabled);
  notificationEmailHint.textContent = !notificationPreferences.emailAvailable
    ? "Les alertes e-mail seront disponibles après la configuration du service NEXA."
    : !verifiedEmailAvailable
      ? "Confirmez votre adresse e-mail pour activer cette option."
      : "Un message général sera envoyé à votre adresse confirmée.";
  notificationPushButton.textContent = notificationPreferences.busy
    ? "Enregistrement…"
    : notificationPreferences.pushEnabled
      ? "Désactiver les notifications push"
      : "Activer les notifications push";
  notificationPushButton.disabled = notificationPreferences.busy ||
    (!notificationPreferences.pushAvailable && !notificationPreferences.pushEnabled);
  notificationPushHint.textContent = notificationPreferences.pushAvailable
    ? "Les alertes push ne contiennent aucun détail médical."
    : "La configuration Web Push du projet NEXA est nécessaire pour activer cette option.";
}

async function listenForForegroundPush() {
  foregroundPushUnsubscribe();
  foregroundPushUnsubscribe = () => {};
  if (!notificationPreferences?.pushEnabled) return;
  try {
    const sdk = await import("https://www.gstatic.com/firebasejs/13.2.0/firebase-messaging.js");
    if (!(await sdk.isSupported())) return;
    foregroundPushUnsubscribe = sdk.onMessage(sdk.getMessaging(firebaseApp), () => {
      void loadNotifications();
    });
  } catch {
    // In-app notification history remains available if foreground push is unsupported.
  }
}

async function loadNotificationPreferences() {
  if (!currentUser) return;
  notificationPreferencesLoading.hidden = false;
  notificationPreferencesError.hidden = true;
  notificationPreferencesStatus.hidden = true;
  try {
    const result = await requestNexaFunction(currentUser, "nexaNotificationPreferences");
    notificationPreferences = {
      emailEnabled: result.preferences?.emailEnabled === true,
      pushEnabled: result.preferences?.pushEnabled === true,
      emailAvailable: result.emailAvailable === true,
      pushAvailable: result.pushAvailable === true,
      busy: false,
    };
    notificationVapidKey = typeof result.vapidKey === "string" ? result.vapidKey : "";
    updateNotificationPreferenceControls();
    await listenForForegroundPush();
  } catch (error) {
    notificationPreferencesLoading.hidden = true;
    notificationPreferencesError.hidden = false;
    notificationPreferencesError.textContent = error instanceof NexaApiError
      ? error.message
      : "Les préférences de notification ne peuvent pas être chargées.";
    return;
  }
  notificationPreferencesLoading.hidden = true;
}

async function saveNotificationPreference(patch, successMessage) {
  if (!currentUser || !notificationPreferences || notificationPreferences.busy) return false;
  notificationPreferences.busy = true;
  notificationPreferencesError.hidden = true;
  notificationPreferencesStatus.hidden = true;
  updateNotificationPreferenceControls();
  try {
    await requestNexaFunction(currentUser, "nexaNotificationPreferences", "POST", patch);
    Object.assign(notificationPreferences, patch);
    setNotificationPreferenceMessage(successMessage);
    await listenForForegroundPush();
    return true;
  } catch (error) {
    setNotificationPreferenceMessage(
      error instanceof NexaApiError ? error.message : "La préférence de notification n’a pas pu être enregistrée.",
      true,
    );
    return false;
  } finally {
    notificationPreferences.busy = false;
    updateNotificationPreferenceControls();
  }
}

function waitForPushInstallationId(messaging, sdk, options) {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      unsubscribe();
      callback(value);
    };
    const timeout = window.setTimeout(() => finish(reject, new Error("L’inscription push ne répond pas. Réessayez.")), 20_000);
    unsubscribe = sdk.onRegistered(messaging, (fid) => finish(resolve, fid));
    void sdk.register(messaging, options).catch((error) => finish(reject, error));
  });
}

async function enablePatientPush() {
  if (!notificationVapidKey || !("Notification" in window) || !("serviceWorker" in navigator)) {
    setNotificationPreferenceMessage("Ce navigateur ou la configuration NEXA ne prend pas en charge les notifications push.", true);
    return;
  }
  if (Notification.permission !== "granted") {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setNotificationPreferenceMessage("Autorisez les notifications NEXA dans les réglages du navigateur pour les activer.", true);
      return;
    }
  }
  let fid = "";
  try {
    const sdk = await import("https://www.gstatic.com/firebasejs/13.2.0/firebase-messaging.js");
    if (!(await sdk.isSupported())) throw new Error("Les notifications push ne sont pas prises en charge par ce navigateur.");
    const serviceWorkerUrl = new URL("./firebase-messaging-sw.js", document.baseURI);
    const serviceWorkerScope = new URL("./", document.baseURI).pathname;
    const serviceWorkerRegistration = await navigator.serviceWorker.register(serviceWorkerUrl.href, { scope: serviceWorkerScope });
    const messaging = sdk.getMessaging(firebaseApp);
    fid = await waitForPushInstallationId(messaging, sdk, {
      vapidKey: notificationVapidKey,
      serviceWorkerRegistration,
    });
    await requestNexaFunction(currentUser, "nexaNotificationPushRegistrations", "POST", { fid });
    const enabled = await saveNotificationPreference(
      { pushEnabled: true },
      "Les notifications push NEXA sont activées pour votre compte.",
    );
    if (!enabled) {
      await requestNexaFunction(currentUser, "nexaNotificationPushRegistrations", "DELETE", { fid }).catch(() => undefined);
      await sdk.unregister(messaging).catch(() => undefined);
    }
  } catch (error) {
    if (fid) {
      await requestNexaFunction(currentUser, "nexaNotificationPushRegistrations", "DELETE", { fid }).catch(() => undefined);
    }
    setNotificationPreferenceMessage(
      error instanceof NexaApiError ? error.message : error.message || "Les notifications push n’ont pas pu être activées.",
      true,
    );
  }
}

async function togglePatientPush() {
  if (!notificationPreferences || notificationPreferences.busy) return;
  if (notificationPreferences.pushEnabled) {
    const disabled = await saveNotificationPreference(
      { pushEnabled: false },
      "Les notifications push sont désactivées pour ce compte.",
    );
    if (disabled) {
      try {
        const sdk = await import("https://www.gstatic.com/firebasejs/13.2.0/firebase-messaging.js");
        if (await sdk.isSupported()) await sdk.unregister(sdk.getMessaging(firebaseApp));
      } catch {
        // The server-side registration has already been removed.
      }
    }
    return;
  }
  await enablePatientPush();
}

function renderWalletEntry(entry) {
  const item = document.createElement("li");
  const heading = document.createElement("div");
  const label = entry.type === "REFUND" && entry.direction === "CREDIT"
    ? "Remboursement du prix du service"
    : entry.type === "PAYMENT" && entry.direction === "DEBIT"
      ? "Paiement d’un service"
      : "Mouvement Wallet";
  const signed = entry.direction === "DEBIT" ? "−" : entry.direction === "CREDIT" ? "+" : "";
  heading.append(
    makeText("strong", "", label),
    makeText("span", "nexa-patient-wallet__amount", signed + formatMinorMoney(entry.amountMinor)),
  );
  item.append(heading);
  if (entry.type === "PAYMENT" && Number.isSafeInteger(entry.serviceAmountMinor) && Number.isSafeInteger(entry.transactionFeeMinor)) {
    item.append(makeText("p", "", "Service " + formatMinorMoney(entry.serviceAmountMinor) + " + frais " + formatMinorMoney(entry.transactionFeeMinor)));
  } else if (entry.type === "REFUND") {
    item.append(makeText("p", "", "Les frais de transaction du paiement initial ne sont pas remboursés."));
  }
  if (entry.createdAt) {
    const time = document.createElement("time");
    time.dateTime = entry.createdAt;
    time.textContent = notificationDate(entry.createdAt);
    item.append(time);
  }
  return item;
}

async function loadWallet() {
  if (!currentUser) return;
  walletSection.hidden = false;
  walletLoading.hidden = false;
  walletError.hidden = true;
  walletContent.hidden = true;
  walletEntries.replaceChildren();
  retryWalletButton.hidden = true;
  try {
    const result = await requestNexaFunction(currentUser, "nexaPatientWallet");
    const wallet = result.wallet || {};
    walletBalance.textContent = formatMinorMoney(wallet.availableMinor);
    walletStatus.textContent = wallet.status === "ACTIVE"
      ? "Solde disponible pour régler un service NEXA. Les fonds réservés ne sont pas inclus."
      : "Le portefeuille est temporairement suspendu. Contactez NEXA pour obtenir de l’aide.";
    const entries = Array.isArray(result.entries) ? result.entries : [];
    walletEmpty.hidden = entries.length > 0;
    walletEntries.replaceChildren(...entries.map(renderWalletEntry));
    walletLoading.hidden = true;
    walletContent.hidden = false;
  } catch (error) {
    walletLoading.hidden = true;
    walletError.hidden = false;
    walletError.textContent = error instanceof NexaApiError
      ? error.message
      : "Votre portefeuille NEXA n’est pas accessible pour le moment.";
    retryWalletButton.hidden = false;
  }
}

async function markNotificationRead(notificationId, button) {
  if (!currentUser) return;
  button.disabled = true;
  try {
    await requestNexaFunction(currentUser, "nexaUserNotifications", "POST", { id: notificationId });
    notifications = notifications.map((notification) => notification.id === notificationId ? { ...notification, read: true } : notification);
    const unreadCount = notifications.filter((notification) => !notification.read).length;
    notificationsCount.textContent = String(unreadCount);
    notificationsCount.setAttribute("aria-label", `${unreadCount} notification${unreadCount === 1 ? "" : "s"} non lue${unreadCount === 1 ? "" : "s"}`);
    notificationsList.replaceChildren(...notifications.map(renderNotification));
  } catch (error) {
    notificationsError.hidden = false;
    notificationsError.textContent = error instanceof NexaApiError
      ? error.message
      : "Cette notification n’a pas pu être marquée comme lue.";
    button.disabled = false;
  }
}

function showMedicalMessage(element, message) {
  element.textContent = message || "";
  element.hidden = !message;
}

function calculatePatientAge(birthDate, now = new Date()) {
  const match = String(birthDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const birthYear = Number(match[1]);
  const birthMonth = Number(match[2]);
  const birthDay = Number(match[3]);
  const parsedBirthDate = new Date(Date.UTC(birthYear, birthMonth - 1, birthDay));
  if (
    parsedBirthDate.getUTCFullYear() !== birthYear ||
    parsedBirthDate.getUTCMonth() !== birthMonth - 1 ||
    parsedBirthDate.getUTCDate() !== birthDay
  ) return null;

  const todayParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Port-au-Prince",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const today = Object.fromEntries(todayParts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const beforeBirthday = today.month < birthMonth || (today.month === birthMonth && today.day < birthDay);
  const age = today.year - birthYear - (beforeBirthday ? 1 : 0);
  return Number.isSafeInteger(age) && age >= 0 ? age : null;
}

function updateConditionalFields() {
  medicalForm.querySelectorAll("[data-answer]").forEach((fieldset) => {
    const key = fieldset.dataset.answer;
    const answer = fieldset.querySelector("select");
    const detail = fieldset.querySelector(".nexa-medical-detail");
    const input = detail.querySelector("textarea");
    const visible = answer.value === "yes";
    detail.hidden = !visible;
    input.required = visible;
    if (!visible) input.value = "";
  });
  medicalForm.querySelectorAll("[data-condition]").forEach((fieldset) => {
    const answer = fieldset.querySelector("select");
    const detail = fieldset.querySelector(".nexa-medical-detail");
    const input = detail.querySelector("input");
    const visible = answer.value === "yes";
    detail.hidden = !visible;
    input.required = visible;
    if (!visible) input.value = "";
  });
}

function fillMedicalForm(profile) {
  medicalForm.reset();
  if (profile && typeof profile === "object") {
    const languageSet = new Set(Array.isArray(profile.languages) ? profile.languages : []);
    medicalForm.querySelectorAll('input[name="language"]').forEach((input) => {
      input.checked = languageSet.has(input.value);
    });
    for (const key of ["allergies", "tobacco", "alcohol", "coffee", "tea"]) {
      const answer = profile[key];
      if (!answer || typeof answer !== "object") continue;
      medicalForm.elements[key].value = answer.yes === true ? "yes" : answer.yes === false ? "no" : "";
      medicalForm.elements[key + "Details"].value = typeof answer.details === "string" ? answer.details : "";
    }
    for (const key of ["diabetes", "hypertension"]) {
      const condition = profile[key];
      if (!condition || typeof condition !== "object") continue;
      medicalForm.elements[key].value = condition.diagnosed === true ? "yes" : condition.diagnosed === false ? "no" : "";
      medicalForm.elements[key + "Month"].value = typeof condition.sinceMonth === "string" ? condition.sinceMonth : "";
    }
  }
  updateConditionalFields();
}

async function loadMedicalProfile() {
  if (!currentUser) return;
  medicalSection.hidden = false;
  medicalLoading.hidden = false;
  medicalForm.hidden = true;
  retryMedicalButton.hidden = true;
  showMedicalMessage(medicalError, "");
  showMedicalMessage(medicalNotice, "");
  try {
    const result = await requestNexaFunction(currentUser, "patientMedicalProfile");
    const patientIdentity = result.identity && typeof result.identity === "object" ? result.identity : {};
    medicalIdentity.name.textContent = [patientIdentity.firstName, patientIdentity.lastName].filter(Boolean).join(" ") || "À compléter dans le profil";
    medicalIdentity.birthDate.textContent = patientIdentity.birthDate || "Non renseignée";
    const age = calculatePatientAge(patientIdentity.birthDate);
    medicalIdentity.age.textContent = age === null ? "Non calculé" : `${age} ans`;
    medicalIdentity.sex.textContent = patientIdentity.sex || "Non renseigné";
    fillMedicalForm(result.profile);
    const profileWritesEnabled = result.profileWritesEnabled === true;
    medicalForm.querySelectorAll("fieldset").forEach((fieldset) => {
      fieldset.disabled = !profileWritesEnabled;
    });
    saveMedicalButton.disabled = !profileWritesEnabled;
    medicalLoading.hidden = true;
    medicalForm.hidden = false;
    if (!profileWritesEnabled) {
      showMedicalMessage(medicalNotice, result.profile
        ? "Votre fiche est affichée en lecture seule. Les modifications seront ouvertes après l’approbation des documents de confidentialité et du consentement."
        : "La fiche médicale ne peut pas encore être créée. L’enregistrement sera ouvert après l’approbation des documents de confidentialité et du consentement.");
    } else if (result.profile) {
      showMedicalMessage(medicalNotice, "Votre fiche médicale enregistrée a été chargée.");
    }
  } catch (error) {
    medicalLoading.hidden = true;
    showMedicalMessage(medicalError, error instanceof NexaApiError ? error.message : "Votre fiche médicale ne peut pas être chargée pour le moment.");
    retryMedicalButton.hidden = false;
  }
}

firebaseAuthActions.onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentUser = null;
    appointmentsGeneration += 1;
    appointmentsCursor = "";
    appointmentsHasMore = false;
    appointmentsRequestActive = false;
    appointmentsLoading.hidden = true;
    appointmentsError.hidden = true;
    appointmentsEmpty.hidden = true;
    appointmentsList.replaceChildren();
    retryAppointmentsButton.hidden = true;
    loadMoreAppointmentsButton.hidden = true;
    patientNursingVisitsGeneration += 1;
    patientNursingVisitsByOrder.clear();
    patientNursingVisitsLoading.hidden = true;
    patientNursingVisitsError.hidden = true;
    retryPatientNursingVisitsButton.hidden = true;
    loadMorePatientNursingVisitsButton.hidden = true;
    clearIssuedClinicalAccessCode();
    clinicalAccessList.replaceChildren();
    homeVisitReportsList.replaceChildren();
    homeVisitReportsCursor = "";
    homeVisitReportsHasMore = false;
    homeVisitReportsRequestActive = false;
    homeVisitReportsPaginationStatus.textContent = "";
    homeVisitReportsPaginationStatus.hidden = true;
    loadMoreHomeVisitReportsButton.hidden = true;
    homeVisitReportsSection.hidden = true;
    nursingReportsList.replaceChildren();
    nursingReportsCursor = "";
    nursingReportsHasMore = false;
    nursingReportsRequestActive = false;
    nursingReportsPaginationStatus.textContent = "";
    nursingReportsPaginationStatus.hidden = true;
    loadMoreNursingReportsButton.hidden = true;
    nursingReportsSection.hidden = true;
    standaloneRecordsList.replaceChildren();
    standaloneRecordsCursor = "";
    standaloneRecordsHasMore = false;
    standaloneRecordsPaginationStatus.textContent = "";
    standaloneRecordsPaginationStatus.hidden = true;
    loadMoreStandaloneRecordsButton.hidden = true;
    standaloneRecordsSection.hidden = true;
    window.location.replace("./connexion.html?next=" + encodeURIComponent("./espace-patient.html"));
    return;
  }
  if (handled) return;
  handled = true;
  currentUser = user;
  try {
    const profile = await initializePatientProfile(user);
    if (!profile.profileComplete) {
      window.location.replace("./inscription.html?completer=1&next=" + encodeURIComponent("./espace-patient.html"));
      return;
    }
    identity.textContent = user.displayName || user.email || "Compte patient connecté";
    number.textContent = profile.patientNumber;
    loading.hidden = true;
    content.hidden = false;
    await Promise.all([loadMedicalProfile(), loadAppointments(), loadNotifications(), loadNotificationPreferences(), loadWallet(), loadOrders(), loadPatientNursingVisits(user), loadPrescriptions(), loadPatientResults(), loadClinicalAccess(), loadHomeVisitReports(), loadNursingVisitReports(), loadStandaloneClinicalRecords()]);
  } catch (error) {
    handled = false;
    loading.hidden = true;
    content.hidden = false;
    errorBox.hidden = false;
    errorBox.textContent = error instanceof NexaApiError ? error.message : "Votre espace est momentanément indisponible. Réessayez plus tard.";
    retryButton.hidden = false;
  }
});

retryButton.addEventListener("click", () => window.location.reload());
retryMedicalButton.addEventListener("click", () => void loadMedicalProfile());
retryAppointmentsButton.addEventListener("click", () => void loadAppointments());
loadMoreAppointmentsButton.addEventListener("click", () => void loadAppointments(currentUser, true));
retryPrescriptionsButton.addEventListener("click", () => void loadPrescriptions());
reloadPatientResultsButton.addEventListener("click", () => void loadPatientResults());
reloadHomeVisitReportsButton.addEventListener("click", () => void loadHomeVisitReports());
loadMoreHomeVisitReportsButton.addEventListener("click", () => void loadHomeVisitReports(true));
reloadNursingReportsButton.addEventListener("click", () => void loadNursingVisitReports());
loadMoreNursingReportsButton.addEventListener("click", () => void loadNursingVisitReports(true));
reloadStandaloneRecordsButton.addEventListener("click", () => void loadStandaloneClinicalRecords());
loadMoreStandaloneRecordsButton.addEventListener("click", () => void loadStandaloneClinicalRecords(true));
retryNotificationsButton.addEventListener("click", () => void loadNotifications());
notificationEmailToggle.addEventListener("change", async () => {
  const enabled = notificationEmailToggle.checked;
  await saveNotificationPreference(
    { emailEnabled: enabled },
    enabled ? "Les notifications e-mail sont activées." : "Les notifications e-mail sont désactivées.",
  );
});
notificationPushButton.addEventListener("click", () => void togglePatientPush());
retryWalletButton.addEventListener("click", () => void loadWallet());
retryOrdersButton.addEventListener("click", () => void loadOrders());
loadMoreOrdersButton.addEventListener("click", () => void loadOrders(true));
retryPatientNursingVisitsButton.addEventListener("click", () => void loadPatientNursingVisits(currentUser, Boolean(patientNursingVisitsCursor)));
loadMorePatientNursingVisitsButton.addEventListener("click", () => void loadPatientNursingVisits(currentUser, true));
clinicalAccessReloadButton.addEventListener("click", () => void loadClinicalAccess());
clinicalAccessProvider.addEventListener("change", () => {
  clinicalAccessSubmit.disabled = !clinicalAccessProvider.value;
});

clinicalAccessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser || !clinicalAccessProvider.value) return;
  const user = currentUser;
  const providerUid = clinicalAccessProvider.value;
  const providerName = clinicalAccessProvider.selectedOptions[0]?.textContent || "Médecin NEXA";
  clinicalAccessSubmit.disabled = true;
  clinicalAccessListError.hidden = true;
  clinicalAccessError.hidden = true;
  clinicalAccessMessage(clinicalAccessStatus, "Création du code temporaire…");
  clearIssuedClinicalAccessCode();
  try {
    const result = await requestNexaFunction(user, "nexaPatientClinicalAccess", "POST", { providerUid });
    if (currentUser !== user) return;
    if (!/^[0-9a-f-]{36}$/i.test(result.grantId || "") || !/^[A-Za-z0-9_-]{32}$/.test(result.accessCode || "")) {
      throw new Error("clinical-access-response-invalid");
    }
    lastIssuedClinicalAccessGrantId = result.grantId;
    clinicalAccessCode.value = result.accessCode;
    clinicalAccessCodeProvider.textContent = `Pour ${result.providerName || providerName}`;
    clinicalAccessCodeExpiry.textContent = `À transmettre dans les 30 minutes, avant le ${clinicalAccessDate(result.expiresAt)}. Le code ne sera pas affiché de nouveau.`;
    clinicalAccessCodePanel.hidden = false;
    clinicalAccessMessage(clinicalAccessStatus, "Le code est prêt. Partagez-le uniquement avec le médecin affiché ci-dessus.");
    await loadClinicalAccess();
  } catch (error) {
    if (currentUser !== user) return;
    clinicalAccessMessage(clinicalAccessStatus, "");
    clinicalAccessError.textContent = error instanceof NexaApiError ? error.message : "Le code d’autorisation n’a pas pu être créé.";
    clinicalAccessError.hidden = false;
  } finally {
    if (currentUser === user) clinicalAccessSubmit.disabled = !clinicalAccessProvider.value;
  }
});

clinicalAccessCopyButton.addEventListener("click", async () => {
  if (!clinicalAccessCode.value) return;
  try {
    await navigator.clipboard.writeText(clinicalAccessCode.value);
    clinicalAccessMessage(clinicalAccessStatus, "Le code a été copié. Transmettez-le uniquement au médecin sélectionné.");
  } catch {
    clinicalAccessCode.focus();
    clinicalAccessCode.select();
    clinicalAccessMessage(clinicalAccessStatus, "Le code est sélectionné. Copiez-le puis transmettez-le uniquement au médecin choisi.");
  }
});

medicalForm.querySelectorAll('select[name="allergies"],select[name="tobacco"],select[name="alcohol"],select[name="coffee"],select[name="tea"],select[name="diabetes"],select[name="hypertension"]').forEach((select) => {
  select.addEventListener("change", updateConditionalFields);
});

medicalForm.querySelectorAll('input[name="language"]').forEach((input) => {
  input.addEventListener("change", () => input.setCustomValidity(""));
});

medicalForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saveMedicalButton.disabled) return;
  showMedicalMessage(medicalError, "");
  showMedicalMessage(medicalNotice, "");
  const languages = [...medicalForm.querySelectorAll('input[name="language"]:checked')].map((input) => input.value);
  const firstLanguage = medicalForm.querySelector('input[name="language"]');
  if (languages.length === 0) {
    firstLanguage.setCustomValidity("Choisissez au moins une langue.");
    firstLanguage.reportValidity();
    return;
  }
  firstLanguage.setCustomValidity("");

  const data = new FormData(medicalForm);
  const yesNo = (key) => ({
    yes: data.get(key) === "yes",
    details: data.get(key) === "yes" ? String(data.get(key + "Details") || "").trim() : "",
  });
  const condition = (key) => ({
    diagnosed: data.get(key) === "yes",
    sinceMonth: data.get(key) === "yes" ? String(data.get(key + "Month") || "") : "",
  });
  const profile = {
    languages,
    allergies: yesNo("allergies"),
    diabetes: condition("diabetes"),
    hypertension: condition("hypertension"),
    tobacco: yesNo("tobacco"),
    alcohol: yesNo("alcohol"),
    coffee: yesNo("coffee"),
    tea: yesNo("tea"),
  };
  saveMedicalButton.disabled = true;
  saveMedicalButton.textContent = "Enregistrement…";
  try {
    await requestNexaFunction(currentUser, "patientMedicalProfile", "PUT", { profile });
    showMedicalMessage(medicalNotice, "Votre fiche médicale a été enregistrée.");
  } catch (error) {
    showMedicalMessage(medicalError, error instanceof NexaApiError ? error.message : "La fiche médicale n’a pas été enregistrée. Réessayez.");
  } finally {
    saveMedicalButton.disabled = false;
    saveMedicalButton.textContent = "Enregistrer ma fiche médicale";
  }
});

signOutButton.addEventListener("click", async () => {
  signOutButton.disabled = true;
  clearIssuedClinicalAccessCode();
  try {
    await firebaseAuthActions.signOut(auth);
    window.location.replace("./index.html");
  } catch {
    signOutButton.disabled = false;
    errorBox.hidden = false;
    errorBox.textContent = "La déconnexion n’a pas abouti. Réessayez.";
  }
});
