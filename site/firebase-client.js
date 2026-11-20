import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import {
  getToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app-check.js";
import {
  APPCHECK_SITE_KEY,
  AUTH_EMULATOR_URL,
  FIREBASE_CONFIG,
  FUNCTIONS_BASE_URL,
  USE_FIREBASE_EMULATORS,
} from "./firebase-config.js";

export class NexaApiError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = "NexaApiError";
    this.code = code;
    this.status = status;
  }
}

const existingApp = getApps().find((candidate) => candidate.name === "nexa-static-client");
export const firebaseApp = existingApp || initializeApp(FIREBASE_CONFIG, "nexa-static-client");

let appCheck = null;
if (!USE_FIREBASE_EMULATORS && APPCHECK_SITE_KEY) {
  appCheck = initializeAppCheck(firebaseApp, {
    provider: new ReCaptchaEnterpriseProvider(APPCHECK_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
}

export const auth = getAuth(firebaseApp);
if (USE_FIREBASE_EMULATORS) {
  connectAuthEmulator(auth, AUTH_EMULATOR_URL, { disableWarnings: true });
}

export const firebaseAuthActions = {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
};

export function hasProtectedRequestConfiguration() {
  return USE_FIREBASE_EMULATORS || Boolean(appCheck);
}

export async function getAppCheckToken() {
  if (USE_FIREBASE_EMULATORS) return "";
  if (!appCheck) {
    throw new NexaApiError(
      "app-check-configuration-required",
      "Les services sécurisés de NEXA ne sont pas encore configurés pour cet environnement.",
      503,
    );
  }
  try {
    return (await getToken(appCheck)).token;
  } catch {
    throw new NexaApiError(
      "app-check-unavailable",
      "La vérification de sécurité NEXA n’a pas abouti. Réessayez plus tard.",
      503,
    );
  }
}

export async function fetchNexaPublicFunction(requestUrl, options = {}) {
  const functionsBase = new URL(FUNCTIONS_BASE_URL);
  const url = new URL(requestUrl, functionsBase);
  const basePath = functionsBase.pathname.endsWith("/") ? functionsBase.pathname : functionsBase.pathname + "/";
  if (url.origin !== functionsBase.origin || url.username || url.password || url.hash ||
    !url.pathname.startsWith(basePath) || String(options.method || "GET").toUpperCase() !== "GET") {
    throw new NexaApiError("invalid-public-function-url", "La demande ne cible pas un service public NEXA.", 400);
  }

  const headers = new Headers(options.headers || {});
  const appCheckToken = await getAppCheckToken();
  if (appCheckToken) headers.set("X-Firebase-AppCheck", appCheckToken);

  try {
    return await fetch(url, { ...options, headers, cache: options.cache || "no-store" });
  } catch {
    throw new NexaApiError("nexa-public-function-network-error", "Le service NEXA est momentanément inaccessible. Réessayez plus tard.", 503);
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export async function initializePatientProfile(user, registration) {
  if (!user) {
    throw new NexaApiError("authentication-required", "Connexion requise.", 401);
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const headers = new Headers({
        Authorization: "Bearer " + await user.getIdToken(),
        "Content-Type": "application/json",
      });
      const appCheckToken = await getAppCheckToken();
      if (appCheckToken) headers.set("X-Firebase-AppCheck", appCheckToken);

      const response = await fetch(FUNCTIONS_BASE_URL + "/patientProfileInitialize", {
        method: "POST",
        headers,
        body: JSON.stringify(registration || {}),
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload && payload.ok === true) {
        if (!/^NMC-\d{7}$/.test(payload.patientNumber || "")) {
          throw new NexaApiError(
            "invalid-patient-number-response",
            "Le numéro patient NEXA n’a pas pu être confirmé. Réessayez.",
            502,
          );
        }
        return payload;
      }

      const apiError = new NexaApiError(
        (payload && payload.code) || "patient-profile-request-failed",
        (payload && payload.error) || "La création du profil patient a échoué.",
        response.status,
      );
      if (response.status < 500 && response.status !== 429) throw apiError;
      if (attempt === 2) throw apiError;
    } catch (error) {
      if (error instanceof NexaApiError && error.status < 500 && error.status !== 429) {
        throw error;
      }
      if (attempt === 2) {
        if (error instanceof NexaApiError) throw error;
        throw new NexaApiError(
          "patient-profile-network-error",
          "Le compte est ouvert, mais la confirmation du numéro patient n’a pas abouti. Réessayez : le numéro ne sera pas attribué en double.",
          503,
        );
      }
    }
    await wait(250 * (2 ** attempt));
  }

  throw new NexaApiError(
    "patient-profile-request-failed",
    "La création du profil patient a échoué.",
    503,
  );
}

export async function requestNexaFunction(user, functionName, method = "GET", body = undefined, query = undefined) {
  if (!user) {
    throw new NexaApiError("authentication-required", "Connexion requise.", 401);
  }
  if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(functionName) || !["GET", "PUT", "POST", "DELETE"].includes(method)) {
    throw new NexaApiError("invalid-function-request", "Cette demande NEXA n’est pas valide.", 400);
  }
  const url = new URL(FUNCTIONS_BASE_URL + "/" + functionName);
  if (query !== undefined) {
    if (method !== "GET" || !query || typeof query !== "object" || Array.isArray(query)) {
      throw new NexaApiError("invalid-function-query", "Les paramètres de cette demande NEXA ne sont pas valides.", 400);
    }
    for (const [key, value] of Object.entries(query)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || !["string", "number", "boolean"].includes(typeof value)) {
        throw new NexaApiError("invalid-function-query", "Les paramètres de cette demande NEXA ne sont pas valides.", 400);
      }
      const textValue = String(value);
      if (textValue.length > (key === "cursor" ? 2_048 : 500)) {
        throw new NexaApiError("invalid-function-query", "Les paramètres de cette demande NEXA sont trop longs.", 400);
      }
      url.searchParams.set(key, textValue);
    }
  }

  const headers = new Headers({ Authorization: "Bearer " + await user.getIdToken() });
  const appCheckToken = await getAppCheckToken();
  if (appCheckToken) headers.set("X-Firebase-AppCheck", appCheckToken);
  const options = { method, headers, cache: "no-store" };
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url.toString(), options);
  } catch {
    throw new NexaApiError("nexa-function-network-error", "Le service NEXA est momentanément inaccessible. Réessayez plus tard.", 503);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.ok !== true) {
    throw new NexaApiError(
      payload?.code || "nexa-function-request-failed",
      payload?.error || "La demande NEXA n’a pas abouti.",
      response.status || 502,
    );
  }
  return payload;
}

export async function downloadNexaPdf(user, functionName, query) {
  if (!user) throw new NexaApiError("authentication-required", "Connexion requise.", 401);
  if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(functionName) || !query || typeof query !== "object" || Array.isArray(query)) {
    throw new NexaApiError("invalid-file-request", "Cette demande de document NEXA n’est pas valide.", 400);
  }
  const url = new URL(FUNCTIONS_BASE_URL + "/" + functionName);
  for (const [key, value] of Object.entries(query)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || !["string", "number", "boolean"].includes(typeof value) || String(value).length > 500) {
      throw new NexaApiError("invalid-file-query", "Les paramètres du document NEXA ne sont pas valides.", 400);
    }
    url.searchParams.set(key, String(value));
  }
  const headers = new Headers({ Authorization: "Bearer " + await user.getIdToken() });
  const appCheckToken = await getAppCheckToken();
  if (appCheckToken) headers.set("X-Firebase-AppCheck", appCheckToken);
  let response;
  try {
    response = await fetch(url.toString(), { method: "GET", headers, cache: "no-store" });
  } catch {
    throw new NexaApiError("nexa-file-network-error", "Le document NEXA n’est pas accessible pour le moment.", 503);
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new NexaApiError(payload?.code || "nexa-file-request-failed", payload?.error || "Le document NEXA n’a pas pu être téléchargé.", response.status || 502);
  }
  if (!String(response.headers.get("Content-Type") || "").toLowerCase().includes("application/pdf")) {
    throw new NexaApiError("nexa-file-type-invalid", "Le service n’a pas renvoyé un PDF valide.", 502);
  }
  return response.blob();
}

export async function uploadNexaClinicalAttachment(user, recordId, file) {
  if (!user || typeof recordId !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(recordId) || !(file instanceof File)) {
    throw new NexaApiError("invalid-clinical-attachment", "La pièce jointe sélectionnée n’est pas valide.", 400);
  }
  const started = await requestNexaFunction(user, "nexaClinicalRecordAttachments", "POST", {
    action: "start",
    recordId,
    fileName: file.name,
    contentType: file.type,
    size: file.size,
  });
  let target;
  try { target = new URL(started.uploadUrl); } catch { throw new NexaApiError("secure-upload-unavailable", "Le téléversement sécurisé est indisponible.", 503); }
  if (target.protocol !== "https:" ||
    (target.hostname !== "storage.googleapis.com" && !target.hostname.endsWith(".storage.googleapis.com")) ||
    !started.fields || typeof started.fields !== "object" || Array.isArray(started.fields)) {
    throw new NexaApiError("secure-upload-unavailable", "Le téléversement sécurisé n’a pas retourné une destination valide.", 503);
  }
  const form = new FormData();
  for (const [name, value] of Object.entries(started.fields)) {
    if (typeof value !== "string") throw new NexaApiError("secure-upload-unavailable", "La session sécurisée de téléversement est invalide.", 503);
    form.append(name, value);
  }
  form.append("file", file);
  let uploaded;
  try {
    uploaded = await fetch(target.href, {
      method: "POST",
      body: form,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch {
    await requestNexaFunction(user, "nexaClinicalRecordAttachments", "DELETE", {
      recordId,
      uploadId: started.uploadId,
    }).catch(() => undefined);
    throw new NexaApiError("secure-upload-failed", "Le fichier n’a pas pu être téléversé. Réessayez.", 503);
  }
  if (!uploaded.ok) {
    await requestNexaFunction(user, "nexaClinicalRecordAttachments", "DELETE", {
      recordId,
      uploadId: started.uploadId,
    }).catch(() => undefined);
    throw new NexaApiError("secure-upload-failed", "Le fichier n’a pas pu être téléversé. Vérifiez sa taille et réessayez.", uploaded.status);
  }
  return requestNexaFunction(user, "nexaClinicalRecordAttachments", "POST", {
    action: "finalize",
    recordId,
    uploadId: started.uploadId,
  });
}
