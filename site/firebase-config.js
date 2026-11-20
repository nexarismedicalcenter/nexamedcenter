const localHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);

export const USE_FIREBASE_EMULATORS = localHost;
// GitHub Pages injects the production site key into its build artifact.
export const APPCHECK_SITE_KEY = "";

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyC-f-9NRF6aIR4lMi2nhtl45SuYMq17QOo",
  authDomain: USE_FIREBASE_EMULATORS
    ? "demo-nexaris.firebaseapp.com"
    : "nexaris-1339d.firebaseapp.com",
  projectId: USE_FIREBASE_EMULATORS ? "demo-nexaris" : "nexaris-1339d",
  storageBucket: USE_FIREBASE_EMULATORS
    ? "demo-nexaris.firebasestorage.app"
    : "nexaris-1339d.firebasestorage.app",
  messagingSenderId: "150995776114",
  appId: "1:150995776114:web:a0818d137049a74d5a88eb",
};

export const FUNCTIONS_BASE_URL = USE_FIREBASE_EMULATORS
  ? "http://127.0.0.1:5001/demo-nexaris/us-east4"
  : "https://us-east4-nexaris-1339d.cloudfunctions.net";

export const AUTH_EMULATOR_URL = "http://127.0.0.1:9099";
