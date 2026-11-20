import {
  auth,
  firebaseAuthActions,
  getAppCheckToken,
  initializePatientProfile,
  NexaApiError,
} from "./firebase-client.js";

const form = document.querySelector("#registration-form");
const credentialsFields = document.querySelector("#credentials-fields");
const accountNotice = document.querySelector("#account-notice");
const errorBox = document.querySelector("#registration-error");
const statusBox = document.querySelector("#registration-status");
const submitButton = document.querySelector("#registration-submit");
const googleButton = document.querySelector("#google-signup");
const socialSignup = document.querySelector("#social-signup");
const successPanel = document.querySelector("#registration-success");
const patientNumber = document.querySelector("#patient-number");
const continueLink = document.querySelector("#continue-link");
const verificationNotice = document.querySelector("#verification-notice");
const formTitle = document.querySelector("#form-title");
let working = false;
const today = new Date();
form.elements.birthDate.max = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0")].join("-");

function safeNext() {
  const next = new URLSearchParams(window.location.search).get("next");
  if (!next) return "./espace-patient.html";
  try {
    const target = new URL(next, window.location.href);
    if (target.origin !== window.location.origin) return "./espace-patient.html";
    return target.href;
  } catch {
    return "./espace-patient.html";
  }
}

function setMessage(box, message) {
  box.textContent = message || "";
  box.hidden = !message;
}

function errorMessage(error) {
  if (error instanceof NexaApiError) return error.message;
  const code = error && typeof error === "object" ? error.code : "";
  if (code === "auth/email-already-in-use") return "Cette adresse e-mail possède déjà un compte. Connectez-vous pour continuer.";
  if (code === "auth/invalid-email") return "L’adresse e-mail n’est pas valide.";
  if (code === "auth/weak-password") return "Choisissez un mot de passe d’au moins 6 caractères.";
  if (code === "auth/popup-closed-by-user") return "La fenêtre Google a été fermée avant la fin de la connexion.";
  if (code === "auth/popup-blocked") return "Autorisez la fenêtre Google puis réessayez.";
  return "L’inscription n’a pas abouti. Si le compte est déjà créé, reconnectez-vous pour reprendre la finalisation.";
}

function formValues() {
  const data = new FormData(form);
  return {
    firstName: String(data.get("firstName") || "").trim(),
    lastName: String(data.get("lastName") || "").trim(),
    birthDate: String(data.get("birthDate") || ""),
    phone: String(data.get("phone") || "").trim(),
    sex: String(data.get("sex") || "Non communiqué"),
    addressLine: String(data.get("addressLine") || "").trim(),
    country: String(data.get("country") || "").trim(),
    department: String(data.get("department") || "").trim(),
    commune: String(data.get("commune") || "").trim(),
    emailMarketingConsent: data.get("emailMarketingConsent") === "on",
    termsAccepted: data.get("termsAccepted") === "on",
  };
}

function validate(values, email, password, confirmPassword, requiresCredentials) {
  if (!values.firstName || !values.lastName) return "Saisissez votre prénom et votre nom.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Saisissez une adresse e-mail valide.";
  if (requiresCredentials && password.length < 6) return "Choisissez un mot de passe d’au moins 6 caractères.";
  if (requiresCredentials && password !== confirmPassword) return "Les mots de passe ne correspondent pas.";
  const birthDate = new Date(values.birthDate + "T00:00:00.000Z");
  if (!values.birthDate || Number.isNaN(birthDate.getTime()) || birthDate.toISOString().slice(0, 10) !== values.birthDate || birthDate.getTime() > Date.now()) return "Saisissez une date de naissance valide.";
  if (!/^\+?[0-9\s().-]{7,24}$/.test(values.phone)) return "Saisissez un numéro de téléphone valide.";
  if (!values.addressLine || !values.country || !values.department || !values.commune) return "Complétez votre adresse, votre pays, votre département et votre commune.";
  if (!values.termsAccepted) return "Vous devez accepter les conditions et confirmer avoir lu la politique de confidentialité.";
  return "";
}

function fillFromUser(user) {
  const parts = String(user.displayName || "").trim().split(/\s+/);
  if (parts.length > 1 && !form.elements.firstName.value) form.elements.firstName.value = parts.slice(0, -1).join(" ");
  if (parts.length > 0 && !form.elements.lastName.value) form.elements.lastName.value = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  if (user.email) form.elements.email.value = user.email;
}

function enterCompletionMode(user) {
  credentialsFields.hidden = true;
  credentialsFields.querySelectorAll("input").forEach((input) => { input.disabled = true; });
  socialSignup.hidden = true;
  accountNotice.hidden = false;
  accountNotice.textContent = "Compte connecté : " + (user.email || user.displayName || "compte Google") + ". Complétez les renseignements du profil patient.";
  formTitle.textContent = "Finalisez votre profil patient";
  fillFromUser(user);
}

function showSuccess(result, user, verificationMessage) {
  patientNumber.textContent = result.patientNumber;
  continueLink.href = safeNext();
  form.hidden = true;
  successPanel.hidden = false;
  verificationNotice.hidden = Boolean(user.emailVerified);
  if (!user.emailVerified) {
    verificationNotice.textContent = verificationMessage || "Votre adresse e-mail n’est pas vérifiée. Consultez votre boîte de réception ou demandez un nouveau lien depuis votre espace.";
  }
}

async function continueExistingUser(user, displaySuccess) {
  const result = await initializePatientProfile(user);
  if (result.profileComplete) {
    if (displaySuccess) showSuccess(result, user);
    else window.location.replace(safeNext());
    return true;
  }
  enterCompletionMode(user);
  setMessage(statusBox, "Votre numéro patient " + result.patientNumber + " est attribué. Complétez les champs ci-dessous pour finaliser le profil.");
  return false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage(errorBox, "");
  setMessage(statusBox, "");
  const currentUser = auth.currentUser;
  const values = formValues();
  const email = String(form.elements.email.value || currentUser?.email || "").trim();
  const password = String(form.elements.password.value || "");
  const confirmPassword = String(form.elements.confirmPassword.value || "");
  if (currentUser?.email && email.toLowerCase() !== currentUser.email.toLowerCase()) {
    setMessage(errorBox, "L’adresse du profil doit correspondre au compte connecté.");
    return;
  }
  const validationError = validate(values, email, password, confirmPassword, !currentUser);
  if (validationError) {
    setMessage(errorBox, validationError);
    return;
  }
  submitButton.disabled = true;
  googleButton.disabled = true;
  working = true;
  submitButton.textContent = currentUser ? "Finalisation du profil…" : "Création du compte…";
  try {
    await getAppCheckToken();
    let user = auth.currentUser;
    if (!user) {
      user = (await firebaseAuthActions.createUserWithEmailAndPassword(auth, email, password)).user;
      submitButton.textContent = "Attribution du numéro patient et finalisation…";
    }
    const result = await initializePatientProfile(user, values);
    if (user.displayName !== (values.firstName + " " + values.lastName).trim()) {
      await firebaseAuthActions.updateProfile(user, { displayName: (values.firstName + " " + values.lastName).trim() }).catch(() => undefined);
    }
    let verificationMessage = "";
    if (!user.emailVerified) {
      try {
        await firebaseAuthActions.sendEmailVerification(user);
        verificationMessage = "Un lien de vérification a été envoyé à votre adresse e-mail.";
      } catch {
        verificationMessage = "Votre compte est créé. La vérification de l’adresse pourra être renvoyée depuis votre espace.";
      }
    }
    showSuccess(result, user, verificationMessage);
  } catch (error) {
    setMessage(errorBox, errorMessage(error));
    if (auth.currentUser) enterCompletionMode(auth.currentUser);
  } finally {
    working = false;
    submitButton.disabled = false;
    googleButton.disabled = false;
    submitButton.textContent = auth.currentUser ? "Finaliser et obtenir mon numéro patient" : "Créer mon compte patient";
  }
});

googleButton.addEventListener("click", async () => {
  setMessage(errorBox, "");
  setMessage(statusBox, "");
  googleButton.disabled = true;
  submitButton.disabled = true;
  working = true;
  try {
    await getAppCheckToken();
    const provider = new firebaseAuthActions.GoogleAuthProvider();
    const user = (await firebaseAuthActions.signInWithPopup(auth, provider)).user;
    enterCompletionMode(user);
    const result = await initializePatientProfile(user);
    if (result.profileComplete) showSuccess(result, user);
    else setMessage(statusBox, "Votre numéro patient " + result.patientNumber + " est attribué. Complétez les champs ci-dessous pour finaliser le profil.");
  } catch (error) {
    setMessage(errorBox, errorMessage(error));
    if (auth.currentUser) enterCompletionMode(auth.currentUser);
  } finally {
    working = false;
    googleButton.disabled = false;
    submitButton.disabled = false;
  }
});

const params = new URLSearchParams(window.location.search);
const loginLink = document.querySelector("#login-link");
if (params.has("next")) loginLink.href = "./connexion.html?next=" + encodeURIComponent(params.get("next"));

firebaseAuthActions.onAuthStateChanged(auth, (user) => {
  if (!user || working) return;
  const completing = params.get("completer") === "1";
  void continueExistingUser(user, !completing).catch((error) => setMessage(errorBox, errorMessage(error)));
});
