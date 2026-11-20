import { auth, firebaseAuthActions, getAppCheckToken, initializePatientProfile, requestNexaFunction } from "./firebase-client.js";

const form = document.querySelector("#nursing-application-form");
const success = document.querySelector("#application-success");
const statusLoading = document.querySelector("#application-status-loading");
const statusPanel = document.querySelector("#application-existing-status");
const statusTitle = document.querySelector("#application-status-title");
const statusText = document.querySelector("#application-status-text");
const reviewNote = document.querySelector("#application-review-note");
const submittedAt = document.querySelector("#application-submitted-at");
const approvedProfileLink = document.querySelector("#approved-profile-link");
const reapplyButton = document.querySelector("#reapply-button");
const retryStatusButton = document.querySelector("#retry-status-button");
const successMessage = document.querySelector("#application-success-message");
const patientNumber = document.querySelector("#application-patient-number");
const errorBox = document.querySelector("#application-error");
const emailInput = document.querySelector("#application-email");
const passwordInput = document.querySelector("#application-password");
const passwordLabel = document.querySelector("#application-password-label");
const accountNote = document.querySelector("#application-account-note");
const passwordResetButton = document.querySelector("#application-password-reset");
const passwordResetNotice = document.querySelector("#application-reset-notice");
const submitButton = document.querySelector("#application-submit");
const createModeButton = document.querySelector("#create-account-mode");
const existingModeButton = document.querySelector("#existing-account-mode");
let currentUser = null;
let accountMode = "create";
let rejectedProfile = null;
let isSubmitting = false;

document.querySelector("#current-year").textContent = String(new Date().getFullYear());

function showError(message) {
  errorBox.textContent = message || "";
  errorBox.hidden = !message;
}

function setAccountMode(mode) {
  if (currentUser) return;
  accountMode = mode;
  const creating = mode === "create";
  createModeButton.classList.toggle("is-selected", creating);
  existingModeButton.classList.toggle("is-selected", !creating);
  createModeButton.setAttribute("aria-pressed", String(creating));
  existingModeButton.setAttribute("aria-pressed", String(!creating));
  passwordInput.autocomplete = creating ? "new-password" : "current-password";
  passwordLabel.firstChild.textContent = creating ? "Mot de passe du compte " : "Mot de passe ";
  submitButton.textContent = creating ? "Créer mon compte et envoyer la candidature" : "Me connecter et envoyer la candidature";
  passwordResetButton.hidden = creating;
  passwordResetNotice.hidden = true;
  passwordResetNotice.textContent = "";
  showError("");
}

passwordResetButton.addEventListener("click", async () => {
  showError("");
  passwordResetNotice.hidden = true;
  passwordResetNotice.textContent = "";
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
    passwordResetNotice.textContent = "Si cette adresse est associée à un compte NEXA, un e-mail de réinitialisation a été envoyé. Vérifiez aussi vos courriers indésirables.";
    passwordResetNotice.hidden = false;
  }
});

createModeButton.addEventListener("click", () => setAccountMode("create"));
existingModeButton.addEventListener("click", () => setAccountMode("login"));

function fillApplication(profile = {}) {
  document.querySelector("#application-name").value = profile.name || "";
  document.querySelector("#application-phone").value = profile.phone || "";
  document.querySelector("#application-department").value = profile.department || "";
  document.querySelector("#application-commune").value = profile.commune || "";
  document.querySelector("#application-bio").value = profile.publicBio || "";
  const selected = new Set(Array.isArray(profile.nursingQualifications) ? profile.nursingQualifications : []);
  document.querySelectorAll('input[name="qualification"]').forEach((input) => { input.checked = selected.has(input.value); });
}

function dateLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : `Candidature soumise le ${new Intl.DateTimeFormat("fr-HT", { dateStyle: "medium", timeStyle: "short" }).format(date)}.`;
}

function showStatus(result) {
  form.hidden = true;
  statusLoading.hidden = true;
  statusPanel.hidden = false;
  reviewNote.hidden = true;
  approvedProfileLink.hidden = true;
  reapplyButton.hidden = true;
  retryStatusButton.hidden = true;
  submittedAt.textContent = dateLabel(result.submittedAt);

  if (result.status === "pending") {
    statusTitle.textContent = "Votre candidature est en cours d’examen";
    statusText.textContent = "L’équipe NEXA vérifie les renseignements et les qualifications déclarées. Votre profil n’est pas public pendant cette étape.";
  } else if (result.status === "approved") {
    statusTitle.textContent = "Votre affiliation infirmière est approuvée";
    statusText.textContent = "Vous pouvez maintenant compléter votre profil de soins. Il ne sera publié qu’après la revue du profil de services.";
    approvedProfileLink.hidden = false;
  } else if (result.status === "rejected") {
    statusTitle.textContent = "Une correction est demandée";
    statusText.textContent = "Consultez le motif de revue, corrigez les renseignements nécessaires, puis renvoyez votre candidature.";
    reviewNote.textContent = result.reviewNote || "Le motif de revue n’a pas été précisé.";
    reviewNote.hidden = false;
    rejectedProfile = result.profile || {};
    reapplyButton.hidden = false;
  } else if (result.status === "other_application") {
    statusTitle.textContent = "Une autre candidature est déjà enregistrée";
    statusText.textContent = "Ce compte est associé à une candidature professionnelle d’un autre type. Contactez l’équipe NEXA pour corriger le dossier.";
  } else {
    statusTitle.textContent = "Statut à vérifier";
    statusText.textContent = "Le statut de cette candidature n’est pas reconnu. Contactez l’équipe NEXA avant de soumettre une nouvelle demande.";
  }
}

async function loadApplicationStatus(user) {
  statusPanel.hidden = true;
  form.hidden = true;
  statusLoading.hidden = false;
  try {
    const result = await requestNexaFunction(user, "nexaNursingApplication", "GET");
    if (auth.currentUser?.uid !== user.uid || isSubmitting) return;
    if (result.status === "not_submitted") {
      statusLoading.hidden = true;
      fillApplication();
      form.hidden = false;
      return;
    }
    showStatus(result);
  } catch (error) {
    if (auth.currentUser?.uid !== user.uid || isSubmitting) return;
    statusLoading.hidden = true;
    statusPanel.hidden = false;
    statusTitle.textContent = "Impossible de consulter la candidature";
    statusText.textContent = error instanceof Error ? error.message : "Réessayez lorsque le service sera accessible.";
    submittedAt.textContent = "";
    retryStatusButton.hidden = false;
  }
}

firebaseAuthActions.onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (!user) {
    emailInput.readOnly = false;
    passwordLabel.hidden = false;
    passwordInput.required = true;
    accountNote.hidden = true;
    createModeButton.disabled = false;
    existingModeButton.disabled = false;
    statusLoading.hidden = true;
    statusPanel.hidden = true;
    form.hidden = false;
    return;
  }
  emailInput.value = user.email || "";
  emailInput.readOnly = true;
  passwordLabel.hidden = true;
  passwordInput.required = false;
  passwordInput.value = "";
  createModeButton.disabled = true;
  existingModeButton.disabled = true;
  accountNote.textContent = `Compte NEXA connecté : ${user.email || "adresse e-mail indisponible"}.`;
  accountNote.hidden = false;
  if (!isSubmitting) void loadApplicationStatus(user);
});

reapplyButton.addEventListener("click", () => {
  fillApplication(rejectedProfile || {});
  statusPanel.hidden = true;
  form.hidden = false;
  document.querySelector("#application-name").focus();
});

retryStatusButton.addEventListener("click", () => {
  if (auth.currentUser) void loadApplicationStatus(auth.currentUser);
});

function authMessage(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "auth/email-already-in-use") return "Cette adresse a déjà un compte. Choisissez « J’ai déjà un compte » et connectez-vous.";
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") return "Adresse e-mail ou mot de passe incorrect.";
  if (code === "auth/weak-password") return "Choisissez un mot de passe d’au moins six caractères.";
  if (code === "auth/invalid-email") return "L’adresse e-mail n’est pas valide.";
  return error instanceof Error ? error.message : "La candidature n’a pas pu être envoyée.";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  isSubmitting = true;
  showError("");
  const qualifications = [...document.querySelectorAll('input[name="qualification"]:checked')].map((input) => input.value);
  if (!qualifications.length) {
    showError("Choisissez au moins une qualification infirmière.");
    isSubmitting = false;
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Envoi sécurisé…";
  try {
    await getAppCheckToken();
    let user = auth.currentUser;
    if (!user) {
      const email = emailInput.value.trim();
      const credential = accountMode === "create"
        ? await firebaseAuthActions.createUserWithEmailAndPassword(auth, email, passwordInput.value)
        : await firebaseAuthActions.signInWithEmailAndPassword(auth, email, passwordInput.value);
      user = credential.user;
    }
    if (!user.email) throw new Error("Une adresse e-mail est nécessaire pour déposer la candidature.");

    const patient = await initializePatientProfile(user);
    const result = await requestNexaFunction(user, "nexaNursingApplication", "POST", {
      name: document.querySelector("#application-name").value.trim(),
      phone: document.querySelector("#application-phone").value.trim(),
      department: document.querySelector("#application-department").value.trim(),
      commune: document.querySelector("#application-commune").value.trim(),
      publicBio: document.querySelector("#application-bio").value.trim(),
      nursingQualifications: qualifications,
      termsAccepted: document.querySelector("#application-terms").checked,
    });

    if (!user.emailVerified) await firebaseAuthActions.sendEmailVerification(user).catch(() => undefined);
    successMessage.textContent = result.alreadySubmitted
      ? "Votre candidature infirmière est déjà en cours d’examen par NEXA."
      : "Votre candidature a été transmise à NEXA pour vérification. L’approbation est requise avant de compléter votre profil de services.";
    patientNumber.textContent = `Votre numéro patient NEXA : ${patient.patientNumber}`;
    form.hidden = true;
    statusPanel.hidden = true;
    success.hidden = false;
  } catch (error) {
    showError(authMessage(error));
  } finally {
    isSubmitting = false;
    submitButton.disabled = false;
    if (!form.hidden) submitButton.textContent = accountMode === "create"
      ? "Créer mon compte et envoyer la candidature"
      : "Me connecter et envoyer la candidature";
  }
});
