import {
  auth,
  firebaseAuthActions,
  getAppCheckToken,
  initializePatientProfile,
  NexaApiError,
} from "./firebase-client.js";

const form = document.querySelector("#login-form");
const errorBox = document.querySelector("#login-error");
const statusBox = document.querySelector("#login-status");
const submitButton = document.querySelector("#login-submit");
const googleButton = document.querySelector("#google-login");
const resetButton = document.querySelector("#password-reset");

function safeNext() {
  const next = new URLSearchParams(window.location.search).get("next");
  if (!next) return "./espace-patient.html";
  try {
    const target = new URL(next, window.location.href);
    return target.origin === window.location.origin ? target.href : "./espace-patient.html";
  } catch {
    return "./espace-patient.html";
  }
}

function isProfessionalDestination() {
  const professionalPages = new Set([
    "/espace-professionnel.html",
    "/espace-professionnel-infirmier.html",
    "/espace-centre.html",
    "/espace-pharmacie.html",
  ]);
  return professionalPages.has(new URL(safeNext(), window.location.href).pathname);
}

function setMessage(box, message) {
  box.textContent = message || "";
  box.hidden = !message;
}

function errorMessage(error) {
  if (error instanceof NexaApiError) return error.message;
  const code = error && typeof error === "object" ? error.code : "";
  if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"].includes(code)) return "Adresse e-mail ou mot de passe incorrect.";
  if (code === "auth/too-many-requests") return "Trop de tentatives. Réessayez plus tard.";
  if (code === "auth/popup-closed-by-user") return "La fenêtre Google a été fermée avant la fin de la connexion.";
  if (code === "auth/popup-blocked") return "Autorisez la fenêtre Google puis réessayez.";
  return "Connexion impossible pour le moment. Vérifiez votre connexion puis réessayez.";
}

let redirecting = false;
async function completeSignIn(user) {
  if (redirecting) return;
  redirecting = true;
  try {
    const result = await initializePatientProfile(user);
    if (!result.profileComplete && !isProfessionalDestination()) {
      window.location.replace("./inscription.html?completer=1&next=" + encodeURIComponent(safeNext()));
      return;
    }
    window.location.replace(safeNext());
  } catch (error) {
    redirecting = false;
    throw error;
  }
}

async function signIn(action) {
  setMessage(errorBox, "");
  setMessage(statusBox, "");
  submitButton.disabled = true;
  googleButton.disabled = true;
  resetButton.disabled = true;
  try {
    await getAppCheckToken();
    const user = await action();
    await completeSignIn(user);
  } catch (error) {
    setMessage(errorBox, errorMessage(error));
  } finally {
    submitButton.disabled = false;
    googleButton.disabled = false;
    resetButton.disabled = false;
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = String(form.elements.email.value || "").trim();
  const password = String(form.elements.password.value || "");
  if (!email || !password) {
    setMessage(errorBox, "Saisissez votre adresse e-mail et votre mot de passe.");
    return;
  }
  await signIn(async () => (await firebaseAuthActions.signInWithEmailAndPassword(auth, email, password)).user);
});

googleButton.addEventListener("click", async () => {
  await signIn(async () => {
    const provider = new firebaseAuthActions.GoogleAuthProvider();
    return (await firebaseAuthActions.signInWithPopup(auth, provider)).user;
  });
});

resetButton.addEventListener("click", async () => {
  setMessage(errorBox, "");
  const email = String(form.elements.email.value || "").trim();
  if (!email) {
    setMessage(errorBox, "Saisissez votre adresse e-mail pour recevoir le lien de réinitialisation.");
    return;
  }
  resetButton.disabled = true;
  try {
    await firebaseAuthActions.sendPasswordResetEmail(auth, email);
  } catch {
    // Keep the response neutral so account existence is not disclosed.
  } finally {
    resetButton.disabled = false;
    setMessage(statusBox, "Si un compte correspond à cette adresse, un lien de réinitialisation a été envoyé.");
  }
});

const signupLink = document.querySelector("#signup-link");
const next = new URLSearchParams(window.location.search).get("next");
if (next) signupLink.href = "./inscription.html?next=" + encodeURIComponent(next);

firebaseAuthActions.onAuthStateChanged(auth, async (user) => {
  if (!user || redirecting) return;
  try {
    await getAppCheckToken();
    await completeSignIn(user);
  } catch (error) {
    setMessage(errorBox, errorMessage(error));
  }
});
