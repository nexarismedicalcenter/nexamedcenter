"use strict";

const { initializeApp, getApps } = require("firebase-admin/app");
const { getAppCheck } = require("firebase-admin/app-check");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { getMessaging } = require("firebase-admin/messaging");
const { createHash, randomBytes, randomInt } = require("node:crypto");
const { logger } = require("firebase-functions");
const functionsV1 = require("firebase-functions/v1");
const { defineSecret } = require("firebase-functions/params");
const { onRequest } = require("firebase-functions/v2/https");
const { MoncashGatewayError, callSmartCut, readSignedCallback } = require("./nexa-moncash");
const createNexaAdminFunctions = require("./nexa-admin");
const createNexaAdminPharmacyFunctions = require("./nexa-admin-pharmacy");
const createNexaAdminDiagnosticResultFunctions = require("./nexa-admin-diagnostic-results");
const createNexaAdminDiagnosticOrderFunctions = require("./nexa-admin-diagnostic-orders");
const createNexaAdminDiagnosticOfferFunctions = require("./nexa-admin-diagnostic-offers");
const createNexaAdminDiagnosticPartnerReportFunctions = require("./nexa-admin-diagnostic-partner-report");
const createNexaAdminDiagnosticCenterFunctions = require("./nexa-admin-diagnostic-centers");
const createNexaLabSupportFunctions = require("./nexa-lab-support");
const createNexaAdminContractFunctions = require("./nexa-admin-contracts");
const createNexaClinicalFunctions = require("./nexa-clinical");
const createNexaClinicalAccessFunctions = require("./nexa-clinical-access");
const createNexaStandaloneRecordFunctions = require("./nexa-standalone-records");
const createNexaPatientClinicalRecordFunctions = require("./nexa-patient-clinical-records");
const createNexaClinicalAttachmentFunctions = require("./nexa-clinical-attachments");
const createNexaNursingFunctions = require("./nexa-nursing");
const createNexaNursingProfilePhotoFunction = require("./nexa-nursing-profile-photo");
const createNexaNursingVisitFunctions = require("./nexa-nursing-visits");
const createNexaNotificationFunctions = require("./nexa-notifications");
const createNexaProviderFunctions = require("./nexa-provider");
const createNexaProfessionalFunctions = require("./nexa-professional");
const createNexaPartnerFunctions = require("./nexa-partner");
const createNexaPrescriptionFunctions = require("./nexa-prescriptions");
const createNexaPrescriptionAvailabilityFunctions = require("./nexa-prescription-availability");
const createNexaPrescriptionPdfFunctions = require("./nexa-prescription-pdf");
const createNexaPatientResultFunctions = require("./nexa-patient-results");
const createNexaDiagnosticProviderFunctions = require("./nexa-diagnostic-provider");
const createNexaDiagnosticCatalogFunctions = require("./nexa-diagnostic-catalog");
const createNexaDiagnosticCommerceFunctions = require("./nexa-diagnostic-commerce");
const createNexaPharmacyCommerceFunctions = require("./nexa-pharmacy-commerce");
const createNexaTeleconsultationFunctions = require("./nexa-teleconsultation");
const createNexaSessionMessageFunctions = require("./nexa-session-messages");
const createNexaHomeVisitFunctions = require("./nexa-home-visits");

const NEXA_PROJECT_ID = "nexaris-1339d";
const FUNCTION_REGION = "us-east4";
const MEDICAL_PROFILE_WRITES_ENABLED = process.env.NEXA_MEDICAL_PROFILE_WRITES_ENABLED === "true";
const MAX_PATIENT_NUMBER = 9_999_999;
const PATIENT_NUMBER_WIDTH = 7;
const CONSULTATION_CLINICAL_ACCESS_DURATION_MS = 24 * 60 * 60 * 1_000;
const MAX_AVAILABILITY_LOOKAHEAD_DAYS = 90;
const NEXA_TELECONSULTATION_DURATION_MINUTES = 25;
const APPOINTMENT_HOLD_MINUTES = 20;
const MAX_PAYMENT_AMOUNT_HTG = 10_000_000;
const HOME_VISIT_DURATION_MINUTES = 60;
const HOME_VISIT_MIN_GAP_MINUTES = 120;
const HOME_VISIT_DAILY_LIMIT = 5;
const PAYMENT_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
const MONCASH_ORDER_RESOURCE_KINDS = { "laboratory-order": "laboratory", "imaging-order": "imaging", "pharmacy-order": "pharmacy", "nursing-order": "nursing" };
let settlePaidDiagnosticOrderPayment = async () => null;
let settlePaidPharmacyOrderPayment = async () => null;
let settlePaidNursingOrderPayment = async () => null;
const NEXA_TO_SMARTCUT_SIGNING_SECRET = defineSecret("NEXA_TO_SMARTCUT_SIGNING_SECRET");
const SMARTCUT_TO_NEXA_WEBHOOK_SECRET = defineSecret("SMARTCUT_TO_NEXA_WEBHOOK_SECRET");
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
function getTeleconsultationDurationMinutes(appointment) {
  const rights = appointment.consultationRights && typeof appointment.consultationRights === "object"
    ? appointment.consultationRights
    : {};
  const requestedDuration = [Number(rights.durationMinutes), Number(rights.videoMinutes)]
    .find((value) => Number.isFinite(value) && value > 0);
  if (requestedDuration) return Math.round(requestedDuration);

  const startsAt = Date.parse(String(appointment.startsAt || ""));
  const endsAt = Date.parse(String(appointment.endsAt || ""));
  if (Number.isFinite(startsAt) && Number.isFinite(endsAt) && endsAt > startsAt) {
    return Math.max(1, Math.round((endsAt - startsAt) / 60_000));
  }
  return 10;
}

function cleanText(value, max) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function normalizePlace(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr-HT").trim();
}

function haitiDayRange(value) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Port-au-Prince", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const nextDate = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1));
  const nextDay = `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, "0")}-${String(nextDate.getUTCDate()).padStart(2, "0")}`;
  const localMidnightUtc = (dateText) => {
    const [year, month, date] = dateText.split("-").map(Number);
    const target = Date.UTC(year, month - 1, date);
    const local = Object.fromEntries(formatter.formatToParts(new Date(target)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), Number(local.hour), Number(local.minute), Number(local.second));
    return new Date(target - (represented - target)).toISOString();
  };
  return { start: localMidnightUtc(day), end: localMidnightUtc(nextDay) };
}

async function getTransactionFeePolicy(serviceType = "allServices") {
  const snapshot = await db.doc("nexaPaymentSettings/transactionFees").get();
  const defaultPolicy = { active: true, rateBps: 350 };
  if (!snapshot.exists) return defaultPolicy;
  const serviceOverrides = snapshot.get("serviceOverrides");
  const configuredOverride = serviceOverrides && typeof serviceOverrides === "object" && !Array.isArray(serviceOverrides)
    ? serviceOverrides[serviceType]
    : null;
  // Preserve existing laboratory/imaging entries while new dashboard overrides
  // use the serviceOverrides map. The legacy teleconsultation field remains
  // the global fallback until an allServices policy is saved.
  const legacyServiceOverride = serviceType !== "allServices" && serviceType !== "teleconsultation"
    ? snapshot.get(serviceType)
    : null;
  const serviceEntry = serviceType !== "allServices" ? configuredOverride || legacyServiceOverride : null;
  const defaultEntry = snapshot.get("allServices") || snapshot.get("teleconsultation");
  const entry = serviceEntry || defaultEntry;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return defaultPolicy;
  const rateBps = Number(entry.rateBps);
  if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > 10_000) return defaultPolicy;
  return { active: entry.active === true, rateBps };
}

function calculateTransactionAmounts(serviceAmount, policy) {
  if (!Number.isSafeInteger(serviceAmount) || serviceAmount < 0 || serviceAmount > MAX_PAYMENT_AMOUNT_HTG) {
    throw new RangeError("Service amount is outside the supported range.");
  }
  const feeRateBps = policy.active ? policy.rateBps : 0;
  const feeAmount = Math.round(serviceAmount * feeRateBps / 10_000);
  const totalAmount = serviceAmount + feeAmount;
  if (!Number.isSafeInteger(totalAmount) || totalAmount > MAX_PAYMENT_AMOUNT_HTG) {
    throw new RangeError("Transaction total is outside the supported range.");
  }
  return { serviceAmount, feeAmount, totalAmount, feeRateBps, feeRecipient: "NEXARIS" };
}

function appointmentPaymentMatches(appointment, payment) {
  const serviceAmount = Number(appointment.amount);
  const feeAmount = Number(appointment.transactionFee ?? 0);
  const totalAmount = Number(appointment.totalAmount ?? serviceAmount);
  const paymentAmount = Number(payment.amount);
  const paymentServiceAmount = Number(payment.serviceAmount ?? payment.resourceAmount ?? paymentAmount);
  const paymentFeeAmount = Number(payment.transactionFee ?? 0);
  return Number.isSafeInteger(serviceAmount) && serviceAmount > 0 && Number.isSafeInteger(feeAmount) && feeAmount >= 0 &&
    Number.isSafeInteger(totalAmount) && totalAmount === serviceAmount + feeAmount && paymentAmount === totalAmount &&
    paymentServiceAmount === serviceAmount && paymentFeeAmount === feeAmount;
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class PatientNumberCapacityError extends Error {}
class PatientNumberIntegrityError extends Error {}

const isEmulator = process.env.FUNCTIONS_EMULATOR === "true";
const runtimeProjectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT;
if (isEmulator && !runtimeProjectId) {
  throw new Error("The Firebase emulator project ID is required.");
}
if (!isEmulator && runtimeProjectId !== NEXA_PROJECT_ID) {
  throw new Error("Cloud Functions must run in the NEXA Firebase project.");
}

const projectId = isEmulator ? runtimeProjectId : NEXA_PROJECT_ID;
const app = getApps().find((existing) => existing.name === "[DEFAULT]") || initializeApp({ projectId });
if (app.options.projectId && app.options.projectId !== projectId) {
  throw new Error("The Firebase Admin app project does not match the NEXA project.");
}
const auth = getAuth(app);
const db = getFirestore(app);
const appCheck = getAppCheck(app);
const storage = getStorage(app);
const messaging = getMessaging(app);

const allowedOrigins = new Set([
  "https://nexarishaiti.com",
  "https://www.nexarishaiti.com",
  "https://nexarismedicalcenter.github.io",
  ...(process.env.NEXA_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
]);
if (isEmulator) {
  allowedOrigins.add("http://localhost:5500");
  allowedOrigins.add("http://127.0.0.1:5500");
}

function setCors(req, res) {
  const origin = req.get("Origin");
  res.set("Vary", "Origin");
  res.set("Cache-Control", "no-store, max-age=0");
  if (!origin) return true;
  if (!allowedOrigins.has(origin)) return false;
  res.set("Access-Control-Allow-Origin", origin);
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Firebase-AppCheck");
  res.set("Access-Control-Max-Age", "600");
  return true;
}

function fail(res, status, code, message) {
  return res.status(status).json({ ok: false, code, error: message });
}

function readText(source, key, maximum, required = true) {
  const value = source[key];
  if (value === undefined || value === null || value === "") {
    return required ? null : "";
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maximum) return null;
  return normalized;
}

function parseRegistration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value;
  const registrationKeys = [
    "firstName", "lastName", "birthDate", "phone", "sex", "addressLine",
    "country", "department", "commune", "termsAccepted",
  ];
  if (!registrationKeys.some((key) => Object.prototype.hasOwnProperty.call(body, key))) {
    return undefined;
  }

  const firstName = readText(body, "firstName", 80);
  const lastName = readText(body, "lastName", 80);
  const birthDate = readText(body, "birthDate", 10);
  const phone = readText(body, "phone", 24);
  if (body.sex !== undefined && body.sex !== null && typeof body.sex !== "string") {
    throw new ApiError(400, "invalid-sex", "La valeur du champ sexe n’est pas valide.");
  }
  const sexValue = typeof body.sex === "string" ? readText(body, "sex", 32, false) : "";
  if (sexValue === null) {
    throw new ApiError(400, "invalid-sex", "La valeur du champ sexe n’est pas valide.");
  }
  const sex = sexValue || "Non communiqué";
  const addressLine = readText(body, "addressLine", 180);
  const country = readText(body, "country", 80);
  const department = readText(body, "department", 100);
  const commune = readText(body, "commune", 100);

  if (
    !firstName || !lastName || !birthDate || !phone || !addressLine ||
    !country || !department || !commune || body.termsAccepted !== true
  ) {
    throw new ApiError(
      400,
      "invalid-registration",
      "Vérifiez les champs obligatoires et acceptez les conditions.",
    );
  }

  const parsedBirthDate = new Date(birthDate + "T00:00:00.000Z");
  if (
    Number.isNaN(parsedBirthDate.getTime()) ||
    parsedBirthDate.toISOString().slice(0, 10) !== birthDate ||
    parsedBirthDate.getTime() > Date.now()
  ) {
    throw new ApiError(400, "invalid-birth-date", "La date de naissance n’est pas valide.");
  }
  if (!/^\+?[0-9\s().-]{7,24}$/.test(phone)) {
    throw new ApiError(400, "invalid-phone", "Le numéro de téléphone n’est pas valide.");
  }
  if (!new Set(["Femme", "Homme", "Autre", "Non communiqué"]).has(sex)) {
    throw new ApiError(400, "invalid-sex", "La valeur du champ sexe n’est pas valide.");
  }

  return {
    firstName,
    lastName,
    birthDate,
    phone,
    sex,
    addressLine,
    country,
    department,
    commune,
    emailMarketingConsent: body.emailMarketingConsent === true,
    termsAccepted: true,
  };
}

function formatPatientNumber(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_PATIENT_NUMBER) {
    throw new RangeError("Patient number sequence is outside the supported range.");
  }
  return "NMC-" + String(sequence).padStart(PATIENT_NUMBER_WIDTH, "0");
}

function isPatientNumber(value) {
  return typeof value === "string" && /^NMC-\d{7}$/.test(value);
}

async function ensurePatientProfile(identity, registration) {
  if (!identity.uid) {
    throw new Error("Patient identity is incomplete.");
  }

  const patientRef = db.collection("patientProfiles").doc(identity.uid);
  const sequenceRef = db.collection("systemCounters").doc("patientNumbers");
  const indexCollection = db.collection("patientNumberIndex");

  return db.runTransaction(async (transaction) => {
    const patientSnapshot = await transaction.get(patientRef);
    const existingPatientNumber = patientSnapshot.get("patientNumber");

    if (isPatientNumber(existingPatientNumber)) {
      const indexRef = indexCollection.doc(existingPatientNumber);
      const indexSnapshot = await transaction.get(indexRef);
      if (indexSnapshot.exists && indexSnapshot.get("uid") !== identity.uid) {
        throw new PatientNumberIntegrityError();
      }
      const assignedProfiles = await transaction.get(
        db.collection("patientProfiles")
          .where("patientNumber", "==", existingPatientNumber)
          .limit(2),
      );
      if (assignedProfiles.docs.some((profile) => profile.id !== identity.uid)) {
        throw new PatientNumberIntegrityError();
      }
      if (!registration) {
        if (!indexSnapshot.exists) {
          transaction.create(indexRef, {
            uid: identity.uid,
            createdAt: FieldValue.serverTimestamp(),
          });
        }
        return {
          patientNumber: existingPatientNumber,
          created: false,
          profileComplete: patientSnapshot.get("profileComplete") === true,
        };
      }

      transaction.set(
        patientRef,
        {
          ...registration,
          email: identity.email,
          displayName: (registration.firstName + " " + registration.lastName).trim(),
          profileComplete: true,
          termsAcceptedAt:
            patientSnapshot.get("termsAcceptedAt") || FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      if (!indexSnapshot.exists) {
        transaction.create(indexRef, {
          uid: identity.uid,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      return {
        patientNumber: existingPatientNumber,
        created: false,
        profileComplete: true,
      };
    }

    const sequenceSnapshot = await transaction.get(sequenceRef);
    const lastIssuedNumber = sequenceSnapshot.exists
      ? sequenceSnapshot.get("lastIssuedNumber")
      : 0;
    if (
      typeof lastIssuedNumber !== "number" ||
      !Number.isSafeInteger(lastIssuedNumber) ||
      lastIssuedNumber < 0 ||
      lastIssuedNumber > MAX_PATIENT_NUMBER
    ) {
      throw new PatientNumberIntegrityError();
    }

    let sequence = lastIssuedNumber + 1;
    let patientNumber = "";
    let indexRef = indexCollection.doc("pending");
    while (sequence <= MAX_PATIENT_NUMBER) {
      patientNumber = formatPatientNumber(sequence);
      indexRef = indexCollection.doc(patientNumber);
      const indexSnapshot = await transaction.get(indexRef);
      if (indexSnapshot.exists) {
        sequence += 1;
        continue;
      }

      // The counter/index are the fast uniqueness path. Also check profiles so
      // a missing or damaged index cannot cause an old NMC number to be reused.
      const assignedProfile = await transaction.get(
        db.collection("patientProfiles").where("patientNumber", "==", patientNumber).limit(1),
      );
      if (!assignedProfile.empty) {
        sequence += 1;
        continue;
      }
      break;
    }
    if (sequence > MAX_PATIENT_NUMBER) throw new PatientNumberCapacityError();

    transaction.create(indexRef, {
      uid: identity.uid,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.set(
      sequenceRef,
      {
        lastIssuedNumber: sequence,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    transaction.set(
      patientRef,
      {
        uid: identity.uid,
        ...(identity.email ? { email: identity.email } : {}),
        role: "patient",
        patientNumber,
        ...(registration || {}),
        ...(!registration && identity.displayName ? { displayName: identity.displayName } : {}),
        ...(registration
          ? { displayName: (registration.firstName + " " + registration.lastName).trim() }
          : {}),
        profileComplete: Boolean(registration),
        ...(registration ? { termsAcceptedAt: FieldValue.serverTimestamp() } : {}),
        createdAt: patientSnapshot.get("createdAt") || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      patientNumber,
      created: true,
      profileComplete: Boolean(registration),
    };
  }, { maxAttempts: 20 });
}

function parseRequestBody(req) {
  const body = req.body;
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) return body;
  if (Buffer.isBuffer(body)) {
    if (body.length > 16_384) throw new ApiError(413, "request-too-large", "La requête est trop volumineuse.");
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      return null;
    }
  }
  if (typeof body === "string") {
    if (Buffer.byteLength(body, "utf8") > 16_384) {
      throw new ApiError(413, "request-too-large", "La requête est trop volumineuse.");
    }
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return null;
}

async function requireUser(req) {
  const authorization = req.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new ApiError(401, "authentication-required", "Connexion requise.");
  }
  try {
    return await auth.verifyIdToken(match[1], true);
  } catch {
    throw new ApiError(401, "invalid-session", "La session a expiré. Reconnectez-vous.");
  }
}

async function requireAppCheckToken(req) {
  if (isEmulator) return;
  const token = req.get("X-Firebase-AppCheck");
  if (!token) {
    throw new ApiError(403, "app-check-required", "Vérification de sécurité requise.");
  }
  try {
    await appCheck.verifyToken(token);
  } catch {
    throw new ApiError(403, "invalid-app-check", "Vérification de sécurité invalide.");
  }
}

function sendError(res, error) {
  let status = 500;
  let code = "profile-initialization-failed";
  let message = "Impossible de finaliser le profil pour le moment.";
  if (error instanceof ApiError) {
    status = error.status;
    code = error.code;
    message = error.message;
  } else if (error instanceof PatientNumberCapacityError) {
    status = 503;
    code = "patient-number-capacity";
    message = "Le service d’inscription est temporairement indisponible.";
  } else if (error instanceof PatientNumberIntegrityError) {
    status = 503;
    code = "patient-number-unavailable";
    message = "Le service d’inscription est temporairement indisponible.";
  }
  if (status === 500) {
    logger.error("Patient profile initialization failed", {
      errorName: error instanceof Error ? error.name : "unknown-error",
    });
  }
  return fail(res, status, code, message);
}

exports.patientProfileInitialize = onRequest(
  { region: FUNCTION_REGION },
  async (req, res) => {
    if (!setCors(req, res)) {
      return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      res.set("Allow", "POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if ((Number(req.get("Content-Length")) || 0) > 16_384) {
      return fail(res, 413, "request-too-large", "La requête est trop volumineuse.");
    }
    if (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 16_384) {
      return fail(res, 413, "request-too-large", "La requête est trop volumineuse.");
    }

    try {
      const body = parseRequestBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new ApiError(400, "invalid-request", "La requête est invalide.");
      }
      const registration = parseRegistration(body);
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      if (user.firebase?.sign_in_provider === "anonymous") {
        throw new ApiError(401, "registered-account-required", "Créez un compte NEXA pour obtenir votre numéro patient.");
      }
      if (!user.email && registration) {
        throw new ApiError(400, "email-required", "Une adresse e-mail est requise pour ce compte.");
      }
      const result = await ensurePatientProfile(
        { uid: user.uid, ...(user.email ? { email: user.email } : {}) },
        registration,
      );
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, ...result });
    } catch (error) {
      return sendError(res, error);
    }
  },
);

// Assign a patient number at the Auth boundary as a server-side guarantee.
// The registration endpoint uses the same transaction and remains safe if
// it races this at-least-once trigger.
exports.nexaPatientProfileOnAuthCreate = functionsV1
  .runWith({ failurePolicy: true })
  .region(FUNCTION_REGION)
  .auth.user()
  .onCreate(async (user) => {
    // Anonymous sessions are not registered NEXA accounts and should not
    // consume sequential patient numbers. Phone-only accounts are registered
    // accounts too, even when Auth has no email or linked provider data.
    if (!user?.uid || (!user.email && !user.phoneNumber && !user.providerData?.length)) return null;
    const email = typeof user.email === "string" && user.email.trim()
      ? user.email.trim()
      : undefined;
    const displayName = typeof user.displayName === "string" && user.displayName.trim()
      ? user.displayName.trim()
      : undefined;

    try {
      await ensurePatientProfile(
        {
          uid: user.uid,
          ...(email ? { email } : {}),
          ...(displayName ? { displayName } : {}),
        },
        null,
      );
    } catch (error) {
      if (error instanceof PatientNumberCapacityError || error instanceof PatientNumberIntegrityError) {
        logger.error("NMC patient number allocation requires operator attention", {
          errorName: error.name,
        });
        throw error;
      }
      throw error;
    }
    return null;
  });



const HOME_VISIT_SERVICES = [
  { id: "CONSULTATION_EXAMINATION", label: "Consultation et examen" },
  { id: "EVALUATION_ORIENTATION", label: "Évaluation et orientation" },
  { id: "CHRONIC_DISEASE_FOLLOW_UP", label: "Suivi des maladies chroniques" },
  { id: "GERIATRIC_CARE", label: "Soins gériatriques" },
  { id: "PEDIATRIC_CARE", label: "Soins pédiatriques" },
  { id: "PALLIATIVE_CARE", label: "Soins palliatifs" },
  { id: "NON_LIFE_THREATENING_URGENT_CARE", label: "Urgence non vitale" },
  { id: "PRESCRIPTION", label: "Prescription" },
  { id: "PRESCRIPTION_RENEWAL", label: "Renouvellement d’ordonnance" },
  { id: "CERTIFICATE", label: "Certificat médical" },
  { id: "PREVENTION_COUNSELING", label: "Conseils de prévention" },
];
const DOCTOR_PROFILE_PHOTO_CONSENT_VERSION = "nexa-doctor-photo-v1";

function validDoctorProfilePhotoPath(uid, value) {
  if (typeof uid !== "string" || typeof value !== "string") return false;
  const prefix = `nexa-doctor-profile-photos/${uid}/`;
  const fileName = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  return /^[a-f0-9]{32}\.jpg$/.test(fileName);
}

function doctorProfilePhotoApproved(uid, provider) {
  return provider?.profilePhotoStatus === "APPROVED" &&
    provider?.profilePhotoConsentVersion === DOCTOR_PROFILE_PHOTO_CONSENT_VERSION &&
    validDoctorProfilePhotoPath(uid, provider?.profilePhotoPath);
}

function cleanPublicText(value, max = 160) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function publicProvider(id, value) {
  const typeMap = {
    doctor: "doctors",
    laboratory: "laboratories",
    imaging: "imaging-centers",
    pharmacy: "pharmacies",
  };
  const type = typeof value.type === "string" ? typeMap[value.type] : undefined;
  if (!type || value.status !== "verified" || value.publiclyListed !== true) return null;
  if (type === "doctors" && value.clinicalCredentialsVerified !== true) return null;
  if (type === "doctors" && !doctorProfilePhotoApproved(id, value)) return null;

  const profile = value.profile && typeof value.profile === "object" && !Array.isArray(value.profile)
    ? value.profile
    : {};
  const name = cleanPublicText(profile.name || profile.displayName || value.displayName, 120);
  if (!name) return null;
  const arrayText = (candidate, max) =>
    Array.isArray(candidate)
      ? candidate.map((entry) => cleanPublicText(entry, max)).filter(Boolean).slice(0, 12)
      : [];

  const item = {
    id,
    type,
    name,
    address: cleanPublicText(profile.address, 200) || undefined,
    department: cleanPublicText(profile.department, 80) || undefined,
    commune: cleanPublicText(profile.commune, 80) || undefined,
    phone: cleanPublicText(profile.publicPhone, 30) || undefined,
  };

  if (type === "doctors") {
    item.specialty = cleanPublicText(profile.specialty, 100) || undefined;
    item.specialties = arrayText(profile.specialties, 100);
    item.bio = cleanPublicText(profile.publicBio, 500) || undefined;
    item.languages = arrayText(profile.languages, 40);
    item.consultationModes = arrayText(profile.consultationModes, 40);
    item.indicativeFee = Number.isFinite(Number(profile.indicativeFee))
      ? Math.max(0, Number(profile.indicativeFee))
      : undefined;
    item.profilePhotoPath = value.profilePhotoPath;

    const rawTariffs =
      profile.homeVisitTariffs &&
      typeof profile.homeVisitTariffs === "object" &&
      !Array.isArray(profile.homeVisitTariffs)
        ? profile.homeVisitTariffs
        : {};
    const homeVisitServices = HOME_VISIT_SERVICES.flatMap((service) => {
      const tariffHTG = Number(rawTariffs[service.id]);
      return Number.isSafeInteger(tariffHTG) && tariffHTG > 0
        ? [{ id: service.id, label: service.label, tariffHTG }]
        : [];
    });
    const homeVisitZones = Array.isArray(profile.homeVisitZones)
      ? profile.homeVisitZones.flatMap((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
          const department = cleanPublicText(entry.department, 80);
          const commune = cleanPublicText(entry.commune, 80);
          return department && commune ? [{ department, commune }] : [];
        }).slice(0, 20)
      : [];
    if (profile.homeVisitEnabled === true && homeVisitServices.length && homeVisitZones.length) {
      item.homeVisitServices = homeVisitServices;
      item.homeVisitZones = homeVisitZones;
    }
  } else {
    item.services = arrayText(profile.services, 100);
    item.openingHours = cleanPublicText(profile.openingHours, 300) || undefined;
  }

  return item;
}

function normalizePublicQuery(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr");
}

exports.publicCatalog = onRequest(
  { region: FUNCTION_REGION },
  async (req, res) => {
    if (!setCors(req, res)) {
      return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") {
      res.set("Allow", "GET, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }

    const type = typeof req.query.type === "string" ? req.query.type : "";
    const service = typeof req.query.service === "string" ? req.query.service : "";
    const serviceId = typeof req.query.serviceId === "string" ? req.query.serviceId : "";
    const allowedTypes = new Set(["doctors", "laboratories", "imaging-centers", "pharmacies"]);
    const homeVisitServiceIds = new Set(HOME_VISIT_SERVICES.map((entry) => entry.id));
    if (
      !allowedTypes.has(type) ||
      (service && (service !== "HOME_VISIT" || type !== "doctors")) ||
      (serviceId && (!homeVisitServiceIds.has(serviceId) || service !== "HOME_VISIT"))
    ) {
      return fail(res, 400, "invalid-catalog-query", "Type de répertoire invalide.");
    }

    try {
      await requireAppCheckToken(req);
      const snapshot = await db
        .collection("providerProfiles")
        .where("status", "==", "verified")
        .limit(300)
        .get();
      const query = normalizePublicQuery(cleanPublicText(req.query.q, 100));
      const department = normalizePublicQuery(cleanPublicText(req.query.department, 80));
      const candidates = snapshot.docs
        .map((doc) => publicProvider(doc.id, doc.data()))
        .filter((item) => item !== null && item.type === type)
        .filter((item) => {
          const words = normalizePublicQuery([
            item.name,
            item.specialty,
            ...(item.specialties || []),
            ...(item.services || []),
            item.commune,
            item.department,
            ...(item.homeVisitServices || []).map((serviceItem) => serviceItem.label),
          ].filter(Boolean).join(" "));
          return (!query || words.includes(query)) &&
            (!department || normalizePublicQuery(item.department || "").includes(department)) &&
            (service !== "HOME_VISIT" || Boolean(item.homeVisitServices?.length && item.homeVisitZones?.length)) &&
            (!serviceId || Boolean(item.homeVisitServices?.some((serviceItem) => serviceItem.id === serviceId)));
        })
        .slice(0, 100);
      const photoBucket = storage.bucket(process.env.NEXA_STORAGE_BUCKET || "nexaris-1339d.firebasestorage.app");
      const results = await Promise.all(candidates.map(async (item) => {
        if (item.type !== "doctors") return item;
        try {
          const file = photoBucket.file(item.profilePhotoPath);
          const [metadata] = await file.getMetadata();
          if (metadata.contentType !== "image/jpeg" || metadata.metadata?.nexaScanStatus !== "CLEAN" ||
            metadata.metadata?.nexaOwnerUid !== item.id || metadata.metadata?.nexaConsentVersion !== DOCTOR_PROFILE_PHOTO_CONSENT_VERSION) return null;
          const [photoUrl] = await file.getSignedUrl({ action: "read", expires: Date.now() + 5 * 60_000 });
          const { profilePhotoPath, ...publicItem } = item;
          return { ...publicItem, photoUrl };
        } catch {
          return null;
        }
      }));

      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, results: results.filter(Boolean) });
    } catch (error) {
      logger.error("Public catalog request failed", {
        errorName: error instanceof Error ? error.name : "unknown-error",
      });
      return fail(res, 503, "catalog-unavailable", "Le répertoire n’est pas disponible pour le moment.");
    }
  },
);

exports.publicProviderAvailability = onRequest(
  { region: FUNCTION_REGION },
  async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") {
      res.set("Allow", "GET, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }

    const providerUid = typeof req.query.providerUid === "string" ? req.query.providerUid : "";
    const serviceType = typeof req.query.serviceType === "string" ? req.query.serviceType : "TELECONSULTATION";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(providerUid)) {
      return fail(res, 404, "provider-not-found", "Professionnel introuvable.");
    }
    if (!["TELECONSULTATION", "HOME_VISIT"].includes(serviceType)) {
      return fail(res, 400, "invalid-service-type", "Type de service invalide.");
    }

    try {
      await requireAppCheckToken(req);
      const providerSnapshot = await db.collection("providerProfiles").doc(providerUid).get();
      const provider = providerSnapshot.data() || {};
      const profile = provider.profile && typeof provider.profile === "object" && !Array.isArray(provider.profile)
        ? provider.profile
        : {};
      if (
        !providerSnapshot.exists || provider.status !== "verified" || provider.type !== "doctor" ||
        provider.publiclyListed !== true || provider.clinicalCredentialsVerified !== true ||
        !doctorProfilePhotoApproved(providerUid, provider)
      ) return fail(res, 404, "provider-not-found", "Professionnel introuvable.");

      const rawTariffs = profile.homeVisitTariffs && typeof profile.homeVisitTariffs === "object" && !Array.isArray(profile.homeVisitTariffs)
        ? profile.homeVisitTariffs
        : {};
      const homeVisitTariffs = Object.fromEntries(HOME_VISIT_SERVICES.flatMap((service) => {
        const amount = Number(rawTariffs[service.id]);
        return Number.isSafeInteger(amount) && amount > 0 ? [[service.id, amount]] : [];
      }));
      const homeVisitZones = Array.isArray(profile.homeVisitZones)
        ? profile.homeVisitZones.flatMap((zone) => {
            if (!zone || typeof zone !== "object" || Array.isArray(zone)) return [];
            const department = cleanPublicText(zone.department, 80);
            const commune = cleanPublicText(zone.commune, 80);
            return department && commune ? [{ department, commune }] : [];
          }).slice(0, 20)
        : [];
      if (serviceType === "HOME_VISIT" && (
        profile.homeVisitEnabled !== true || !Object.keys(homeVisitTariffs).length || !homeVisitZones.length
      )) return fail(res, 404, "home-visit-not-configured", "Les visites à domicile ne sont pas configurées pour ce médecin.");

      const now = new Date();
      const until = new Date(now.getTime() + MAX_AVAILABILITY_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1_000);
      const buildSlotsQuery = (status) => {
        let query = db.collection("providerAvailabilitySlots").where("providerUid", "==", providerUid);
        if (serviceType === "HOME_VISIT") query = query.where("serviceType", "==", serviceType);
        return query.where("status", "==", status)
          .where("startsAt", ">=", now.toISOString())
          .where("startsAt", "<=", until.toISOString())
          .orderBy("startsAt")
          .limit(100);
      };
      const [availableSnapshot, heldSnapshot] = await Promise.all([
        buildSlotsQuery("available").get(),
        buildSlotsQuery("held").get(),
      ]);
      const slots = [
        ...availableSnapshot.docs,
        ...heldSnapshot.docs.filter((slot) => Number(slot.get("holdExpiresAt")) <= now.getTime()),
      ].filter((slot) => String(slot.get("serviceType") || "TELECONSULTATION") === serviceType)
        .sort((left, right) => String(left.get("startsAt") || "").localeCompare(String(right.get("startsAt") || "")))
        .slice(0, 100);

      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({
        ok: true,
        provider: {
          id: providerUid,
          name: cleanPublicText(profile.name, 120),
          specialty: cleanPublicText(profile.specialty, 100),
          department: cleanPublicText(profile.department, 80),
          commune: cleanPublicText(profile.commune, 80),
          indicativeFee: Number.isSafeInteger(profile.indicativeFee) ? profile.indicativeFee : null,
          homeVisitAvailable: profile.homeVisitEnabled === true && Object.keys(homeVisitTariffs).length > 0 && homeVisitZones.length > 0,
          ...(serviceType === "HOME_VISIT" ? { homeVisitTariffs, homeVisitZones } : {}),
          consultationDurationMinutes: serviceType === "HOME_VISIT" ? 60 : 25,
          serviceType,
        },
        slots: slots.map((slot) => ({
          id: slot.id,
          startsAt: String(slot.get("startsAt") || ""),
          endsAt: String(slot.get("endsAt") || ""),
        })),
      });
    } catch (error) {
      logger.error("Public provider availability request failed", {
        errorName: error instanceof Error ? error.name : "unknown-error",
      });
      return fail(res, 503, "availability-unavailable", "Les disponibilités ne sont pas accessibles pour le moment.");
    }
  },
);

exports.appointmentBooking = onRequest(
  { region: FUNCTION_REGION },
  async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      res.set("Allow", "POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if ((Number(req.get("Content-Length")) || 0) > 16_384 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 16_384)) {
      return fail(res, 413, "request-too-large", "La requête est trop volumineuse.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "book-appointment", 8, 5 * 60_000);
      const body = parseRequestBody(req);
      const slotId = body && typeof body === "object" && !Array.isArray(body) && typeof body.slotId === "string"
        ? body.slotId.trim()
        : "";
      if (!/^[a-f0-9]{32}$/.test(slotId)) throw new ApiError(400, "invalid-slot", "Choisissez un créneau disponible.");
      const requestedBookingType = body && typeof body === "object" && !Array.isArray(body) && typeof body.bookingType === "string"
        ? body.bookingType
        : "teleconsultation";
      const isHomeVisit = requestedBookingType === "home_visit";
      if (!isHomeVisit && requestedBookingType !== "teleconsultation") {
        throw new ApiError(400, "invalid-booking-type", "Choisissez un type de rendez-vous valide.");
      }
      const homeVisitServiceId = body && typeof body === "object" && !Array.isArray(body) && typeof body.homeVisitServiceId === "string"
        ? body.homeVisitServiceId
        : "";
      if (isHomeVisit && !HOME_VISIT_SERVICES.some((service) => service.id === homeVisitServiceId)) {
        throw new ApiError(400, "invalid-home-visit-service", "Choisissez le type de soin à domicile.");
      }
      const proposalId = body && typeof body === "object" && !Array.isArray(body) && typeof body.proposalId === "string"
        ? body.proposalId.trim()
        : "";
      if (proposalId && !/^[a-f0-9]{32}$/.test(proposalId)) {
        throw new ApiError(400, "invalid-follow-up-proposal", "La proposition du médecin n’est pas valide.");
      }
      if (isHomeVisit && proposalId) {
        throw new ApiError(400, "home-visit-proposal-invalid", "Un rendez-vous proposé par un médecin ne peut pas être réservé comme visite à domicile.");
      }
      const rawVisitDetails = body && typeof body === "object" && !Array.isArray(body) &&
        body.homeVisitDetails && typeof body.homeVisitDetails === "object" && !Array.isArray(body.homeVisitDetails)
        ? body.homeVisitDetails
        : {};
      const homeVisitDetails = isHomeVisit ? {
        department: cleanText(rawVisitDetails.department, 80),
        commune: cleanText(rawVisitDetails.commune, 80),
        addressLine: cleanText(rawVisitDetails.addressLine, 220),
        contactPhone: cleanText(rawVisitDetails.contactPhone, 24),
      } : null;
      if (isHomeVisit && (!homeVisitDetails.department || !homeVisitDetails.commune || !homeVisitDetails.addressLine || !/^\+?[0-9\s().-]{7,24}$/.test(homeVisitDetails.contactPhone))) {
        throw new ApiError(400, "invalid-home-visit-details", "Renseignez l’adresse complète et un numéro de téléphone valide pour la visite.");
      }

      const slotRef = db.collection("providerAvailabilitySlots").doc(slotId);
      const proposalRef = proposalId ? db.collection("followUpProposals").doc(proposalId) : null;
      const slotPreview = await slotRef.get();
      if (!slotPreview.exists) throw new ApiError(404, "slot-not-found", "Ce créneau n’est plus disponible.");
      const providerUid = String(slotPreview.get("providerUid") || "");
      if (!providerUid || providerUid === user.uid) throw new ApiError(409, "invalid-provider", "Ce rendez-vous ne peut pas être réservé.");

      const patientRef = db.collection("patientProfiles").doc(user.uid);
      const providerRef = db.collection("providerProfiles").doc(providerUid);
      const [patientSnapshot, providerSnapshot] = await Promise.all([patientRef.get(), providerRef.get()]);
      const patient = patientSnapshot.data() || {};
      const provider = providerSnapshot.data() || {};
      const profile = provider.profile && typeof provider.profile === "object" && !Array.isArray(provider.profile)
        ? provider.profile
        : {};
      if (!patientSnapshot.exists || patient.role !== "patient" || patient.profileComplete !== true || typeof patient.patientNumber !== "string") {
        throw new ApiError(403, "complete-patient-profile-required", "Terminez votre inscription patient avant de réserver un rendez-vous.");
      }
      if (!providerSnapshot.exists || provider.status !== "verified" || provider.type !== "doctor" || provider.publiclyListed !== true || provider.clinicalCredentialsVerified !== true || !doctorProfilePhotoApproved(providerUid, provider)) {
        throw new ApiError(409, "provider-unavailable", "Ce médecin n’est plus disponible sur NEXA.");
      }
      const tariffs = profile.homeVisitTariffs && typeof profile.homeVisitTariffs === "object" && !Array.isArray(profile.homeVisitTariffs)
        ? profile.homeVisitTariffs
        : {};
      const homeVisitFee = Number(tariffs[homeVisitServiceId]);
      const homeVisitZones = Array.isArray(profile.homeVisitZones) ? profile.homeVisitZones : [];
      if (isHomeVisit && (
        profile.homeVisitEnabled !== true || !Number.isSafeInteger(homeVisitFee) || homeVisitFee <= 0 ||
        !homeVisitZones.some((zone) => zone && typeof zone === "object" && !Array.isArray(zone) &&
          normalizePlace(cleanText(zone.commune, 80)) === normalizePlace(homeVisitDetails.commune) &&
          normalizePlace(cleanText(zone.department, 80)) === normalizePlace(homeVisitDetails.department))
      )) {
        throw new ApiError(409, "home-visit-service-unavailable", "Ce médecin ne propose pas de visites dans cette commune. Choisissez un autre professionnel ou une autre zone.");
      }
      const amount = isHomeVisit ? homeVisitFee : profile.indicativeFee;
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_PAYMENT_AMOUNT_HTG) {
        throw new ApiError(409, "provider-fee-unavailable", "Le tarif du service n’est pas encore configuré. Contactez NEXA avant de réserver.");
      }
      let paymentAmounts;
      try {
        paymentAmounts = calculateTransactionAmounts(amount, await getTransactionFeePolicy(isHomeVisit ? "home_visit" : "teleconsultation"));
      } catch {
        throw new ApiError(409, "appointment-total-invalid", "Le total du rendez-vous dépasse le montant autorisé.");
      }

      const appointmentRef = db.collection("appointments").doc();
      const paymentRef = randomBytes(24).toString("base64url");
      if (!PAYMENT_REFERENCE_PATTERN.test(paymentRef)) throw new ApiError(500, "payment-reference-failed", "Le paiement ne peut pas être préparé.");
      const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
      const holdExpiresAt = Date.now() + APPOINTMENT_HOLD_MINUTES * 60_000;
      const outcome = await db.runTransaction(async (transaction) => {
        const [freshPatient, freshProvider, slotSnapshot] = await Promise.all([
          transaction.get(patientRef),
          transaction.get(providerRef),
          transaction.get(slotRef),
        ]);
        if (!freshPatient.exists || freshPatient.get("profileComplete") !== true || freshPatient.get("role") !== "patient") {
          throw new ApiError(403, "complete-patient-profile-required", "Terminez votre inscription patient avant de réserver un rendez-vous.");
        }
        if (!freshProvider.exists || freshProvider.get("status") !== "verified" || freshProvider.get("type") !== "doctor" || freshProvider.get("publiclyListed") !== true || freshProvider.get("clinicalCredentialsVerified") !== true || !doctorProfilePhotoApproved(providerUid, freshProvider.data() || {})) {
          throw new ApiError(409, "provider-unavailable", "Ce médecin n’est plus disponible sur NEXA.");
        }
        if (!slotSnapshot.exists || slotSnapshot.get("providerUid") !== providerUid) {
          throw new ApiError(404, "slot-not-found", "Ce créneau n’est plus disponible.");
        }
        if (proposalRef) {
          const proposalSnapshot = await transaction.get(proposalRef);
          if (
            !proposalSnapshot.exists || proposalSnapshot.get("status") !== "PENDING" ||
            proposalSnapshot.get("patientUid") !== user.uid || proposalSnapshot.get("providerUid") !== providerUid ||
            proposalSnapshot.get("slotId") !== slotId
          ) throw new ApiError(409, "follow-up-proposal-unavailable", "Cette proposition n’est plus disponible pour ce créneau.");
        }
        const slot = slotSnapshot.data() || {};
        const startsAt = Date.parse(String(slot.startsAt || ""));
        const endsAt = Date.parse(String(slot.endsAt || ""));
        const expectedDuration = isHomeVisit ? HOME_VISIT_DURATION_MINUTES : 30;
        const slotServiceType = String(slot.serviceType || "TELECONSULTATION");
        if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || startsAt <= Date.now() ||
          endsAt - startsAt !== expectedDuration * 60_000 || slotServiceType !== (isHomeVisit ? "HOME_VISIT" : "TELECONSULTATION")) {
          throw new ApiError(409, "slot-invalid", "Les horaires de ce créneau ne sont plus valides.");
        }

        const freshProfile = freshProvider.get("profile") && typeof freshProvider.get("profile") === "object" && !Array.isArray(freshProvider.get("profile"))
          ? freshProvider.get("profile")
          : {};
        const homeVisitDayLocks = [];
        if (isHomeVisit) {
          const currentZones = Array.isArray(freshProfile.homeVisitZones) ? freshProfile.homeVisitZones : [];
          const currentTariffs = freshProfile.homeVisitTariffs && typeof freshProfile.homeVisitTariffs === "object" && !Array.isArray(freshProfile.homeVisitTariffs)
            ? freshProfile.homeVisitTariffs
            : {};
          if (freshProfile.homeVisitEnabled !== true || currentTariffs[homeVisitServiceId] !== amount || !currentZones.some((zone) =>
            zone && typeof zone === "object" && !Array.isArray(zone) &&
            normalizePlace(cleanText(zone.commune, 80)) === normalizePlace(homeVisitDetails.commune) &&
            normalizePlace(cleanText(zone.department, 80)) === normalizePlace(homeVisitDetails.department))) {
            throw new ApiError(409, "home-visit-settings-changed", "Les paramètres de visite de ce médecin ont changé. Actualisez la page.");
          }
          const dayRange = haitiDayRange(startsAt);
          const previousDayRange = haitiDayRange(Date.parse(dayRange.start) - 1);
          const lockRanges = [previousDayRange, dayRange];
          const lockRefs = lockRanges.map((range) => {
            const lockId = createHash("sha256").update(`${providerUid}:${range.start}`).digest("hex");
            return db.collection("providerHomeVisitScheduleLocks").doc(lockId);
          });
          const lockSnapshots = await Promise.all(lockRefs.map((ref) => transaction.get(ref)));
          for (let index = 0; index < lockRefs.length; index += 1) {
            const range = lockRanges[index];
            const snapshot = lockSnapshots[index];
            const priorRevision = Number(snapshot.exists ? snapshot.get("revision") : 0);
            homeVisitDayLocks.push({
              ref: lockRefs[index],
              dayStart: range.start,
              dayEnd: range.end,
              revision: Number.isSafeInteger(priorRevision) && priorRevision >= 0 ? priorRevision + 1 : 1,
            });
          }
          const nowMs = Date.now();
          const dayStartMs = Date.parse(dayRange.start);
          const dayEndMs = Date.parse(dayRange.end);
          const spacingWindowMs = (HOME_VISIT_DURATION_MINUTES + HOME_VISIT_MIN_GAP_MINUTES) * 60_000;
          const ownPendingAppointmentId = slot.status === "held" && slot.patientUid === user.uid && typeof slot.appointmentId === "string"
            ? slot.appointmentId
            : "";
          const visitsQuery = db.collection("appointments")
            .where("providerUid", "==", providerUid)
            .where("bookingType", "==", "home_visit")
            .where("startsAt", ">=", new Date(dayStartMs - spacingWindowMs).toISOString())
            .where("startsAt", "<", new Date(dayEndMs + spacingWindowMs).toISOString());
          const [paidVisits, activePaymentHolds] = await Promise.all([
            transaction.get(visitsQuery.where("paymentStatus", "in", ["PAID", "REFUNDED"])),
            transaction.get(visitsQuery
              .where("paymentStatus", "==", "PENDING")
              .where("holdExpiresAt", ">", nowMs)),
          ]);
          const existingVisits = [
            ...paidVisits.docs
              .filter((document) => document.id !== ownPendingAppointmentId &&
                document.get("status") !== "PAYMENT_CONFLICT_REFUND_REQUIRED" && document.get("homeVisitMissionStatus") !== "PAYMENT_CONFLICT")
              .map((document) => document.data()),
            ...activePaymentHolds.docs
              .filter((document) => document.id !== ownPendingAppointmentId && document.get("status") === "PENDING_PAYMENT" &&
                Number(document.get("holdExpiresAt")) > nowMs)
              .map((document) => document.data()),
          ];
          const sameDayVisits = existingVisits.filter((item) => {
            const visitStart = Date.parse(String(item.startsAt || ""));
            return Number.isFinite(visitStart) && visitStart >= dayStartMs && visitStart < dayEndMs;
          });
          if (sameDayVisits.length >= HOME_VISIT_DAILY_LIMIT) {
            throw new ApiError(409, "home-visit-daily-limit", "Ce médecin a déjà atteint cinq visites à domicile ce jour-là. Choisissez un autre créneau.");
          }
          const minGapMs = HOME_VISIT_MIN_GAP_MINUTES * 60_000;
          if (existingVisits.some((item) => {
            const priorStart = Date.parse(String(item.startsAt || ""));
            const priorEnd = Date.parse(String(item.endsAt || ""));
            return Number.isFinite(priorStart) && Number.isFinite(priorEnd) &&
              startsAt < priorEnd + minGapMs && startsAt + expectedDuration * 60_000 + minGapMs > priorStart;
          })) throw new ApiError(409, "home-visit-spacing-conflict", "Un intervalle d’au moins deux heures entre les visites est requis. Choisissez un autre créneau.");
        } else if (freshProfile.indicativeFee !== amount) {
          throw new ApiError(409, "provider-fee-changed", "Le tarif du service vient de changer. Actualisez la page.");
        }

        const isExpiredHold = slot.status === "held" && Number(slot.holdExpiresAt) <= Date.now();
        if (slot.status === "held" && !isExpiredHold && slot.patientUid === user.uid && typeof slot.appointmentId === "string") {
          const priorAppointmentRef = db.collection("appointments").doc(slot.appointmentId);
          const priorAppointmentSnapshot = await transaction.get(priorAppointmentRef);
          const priorAppointment = priorAppointmentSnapshot.data() || {};
          const priorPaymentRef = typeof priorAppointment.moncashPaymentRef === "string" ? priorAppointment.moncashPaymentRef : "";
          const appointmentTypeMatches = proposalId
            ? priorAppointment.followUpProposalId === proposalId
            : isHomeVisit
              ? priorAppointment.bookingType === "home_visit"
              : priorAppointment.bookingType !== "doctor_proposed_appointment";
          if (priorAppointmentSnapshot.exists && priorAppointment.patientUid === user.uid && appointmentTypeMatches &&
            priorAppointment.status === "PENDING_PAYMENT" && priorAppointment.paymentStatus === "PENDING" &&
            PAYMENT_REFERENCE_PATTERN.test(priorPaymentRef)) {
            const priorIntentSnapshot = await transaction.get(db.collection("paymentIntents").doc(priorPaymentRef));
            const priorIntent = priorIntentSnapshot.data() || {};
            if (priorIntentSnapshot.exists && priorIntent.uid === user.uid && priorIntent.resourcePath === priorAppointmentRef.path &&
              appointmentPaymentMatches(priorAppointment, priorIntent) && priorIntent.currency === "HTG" && priorIntent.paymentMethod === "MONCASH") {
              return {
                appointmentId: priorAppointmentRef.id,
                paymentRef: priorPaymentRef,
                amount: Number(priorAppointment.amount),
                durationMinutes: isHomeVisit ? HOME_VISIT_DURATION_MINUTES : getTeleconsultationDurationMinutes(priorAppointment),
                transactionFee: Number(priorAppointment.transactionFee) || 0,
                totalAmount: Number(priorAppointment.totalAmount) || Number(priorAppointment.amount),
                feeRateBps: Number(priorAppointment.transactionFeeRateBps) || 0,
                holdExpiresAt: Number(slot.holdExpiresAt),
                reused: true,
              };
            }
          }
          throw new ApiError(409, "slot-unavailable", "La réservation temporaire ne peut pas être reprise. Actualisez vos rendez-vous.");
        }
        if (slot.status !== "available" && !isExpiredHold) {
          throw new ApiError(409, "slot-unavailable", "Ce créneau vient d’être réservé par une autre personne.");
        }
        if (isExpiredHold && typeof slot.appointmentId === "string") {
          const expiredAppointmentRef = db.collection("appointments").doc(slot.appointmentId);
          const expiredAppointment = await transaction.get(expiredAppointmentRef);
          if (expiredAppointment.exists) transaction.set(expiredAppointmentRef, {
            status: "PAYMENT_EXPIRED",
            paymentStatus: "EXPIRED",
            requiresNewSlot: true,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }

        for (const homeVisitDayLock of homeVisitDayLocks) {
          transaction.set(homeVisitDayLock.ref, {
            providerUid,
            dayStart: homeVisitDayLock.dayStart,
            dayEnd: homeVisitDayLock.dayEnd,
            revision: homeVisitDayLock.revision,
            updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        transaction.set(slotRef, {
          status: "held",
          patientUid: user.uid,
          appointmentId: appointmentRef.id,
          holdExpiresAt,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.create(appointmentRef, {
          patientUid: user.uid,
          providerUid,
          providerName: typeof profile.name === "string" ? profile.name : null,
          providerType: "doctor",
          bookingType: isHomeVisit ? "home_visit" : proposalId ? "doctor_proposed_appointment" : "teleconsultation",
          ...(proposalId ? { followUpProposalId: proposalId } : {}),
          ...(isHomeVisit
            ? { homeVisitServiceId, homeVisitDetails, homeVisitMissionStatus: "AWAITING_PAYMENT" }
            : { consultationRights: { durationMinutes: NEXA_TELECONSULTATION_DURATION_MINUTES } }),
          slotId,
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
          amount,
          transactionFee: paymentAmounts.feeAmount,
          transactionFeeRateBps: paymentAmounts.feeRateBps,
          totalAmount: paymentAmounts.totalAmount,
          transactionFeeRecipient: paymentAmounts.feeRecipient,
          currency: "HTG",
          status: "PENDING_PAYMENT",
          paymentStatus: "PENDING",
          holdExpiresAt,
          moncashPaymentRef: paymentRef,
          sessionStatus: null,
          requiresNewSlot: false,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        if (proposalRef) transaction.set(proposalRef, {
          pendingAppointmentId: appointmentRef.id,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.create(paymentRefDoc, {
          uid: user.uid,
          paymentMethod: "MONCASH",
          resourceType: "appointment",
          resourcePath: appointmentRef.path,
          amount: paymentAmounts.totalAmount,
          serviceAmount: amount,
          transactionFee: paymentAmounts.feeAmount,
          transactionFeeRateBps: paymentAmounts.feeRateBps,
          feeRecipient: paymentAmounts.feeRecipient,
          currency: "HTG",
          status: "created",
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        return {
          appointmentId: appointmentRef.id,
          paymentRef,
          amount,
          durationMinutes: isHomeVisit ? HOME_VISIT_DURATION_MINUTES : NEXA_TELECONSULTATION_DURATION_MINUTES,
          transactionFee: paymentAmounts.feeAmount,
          totalAmount: paymentAmounts.totalAmount,
          feeRateBps: paymentAmounts.feeRateBps,
          holdExpiresAt,
          reused: false,
        };
      });

      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(outcome.reused ? 200 : 201).json({
        ok: true,
        appointmentId: outcome.appointmentId,
        paymentRef: outcome.paymentRef,
        amount: outcome.amount,
        durationMinutes: outcome.durationMinutes,
        transactionFee: outcome.transactionFee,
        totalAmount: outcome.totalAmount,
        transactionFeeRate: outcome.feeRateBps / 100,
        feeRecipient: "NEXARIS",
        currency: "HTG",
        status: "PENDING_PAYMENT",
        holdExpiresAt: new Date(outcome.holdExpiresAt).toISOString(),
      });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("Appointment booking request failed", {
        errorName: error instanceof Error ? error.name : "unknown-error",
      });
      return fail(res, 500, "appointment-booking-failed", "Le rendez-vous ne peut pas être réservé pour le moment.");
    }
  },
);

function safeMoncashCheckoutUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "moncashbutton.digicelgroup.com" ? url : null;
  } catch {
    return null;
  }
}

function readSecretValue(secret) {
  try { return String(secret.value() || "").trim(); } catch { return ""; }
}

function sendMoncashError(res, error, fallbackCode, fallbackMessage) {
  if (error instanceof ApiError || error instanceof MoncashGatewayError) {
    return fail(res, error.status, error.code, error instanceof ApiError ? error.message : fallbackMessage);
  }
  logger.error("NEXA MonCash request failed", {
    errorName: error instanceof Error ? error.name : "unknown-error",
  });
  return fail(res, 500, fallbackCode, fallbackMessage);
}

async function requireAppointmentPaymentResource(uid, paymentRef, intent) {
  const resourcePath = typeof intent.resourcePath === "string" ? intent.resourcePath : "";
  const match = resourcePath.match(/^appointments\/([A-Za-z0-9_-]{1,200})$/);
  if (intent.resourceType !== "appointment" || !match) {
    throw new ApiError(409, "appointment-payment-invalid", "Ce paiement n’est plus associé à un rendez-vous valide.");
  }
  const appointmentRef = db.collection("appointments").doc(match[1]);
  const appointment = await appointmentRef.get();
  const appointmentData = appointment.data() || {};
  const slotId = typeof appointmentData.slotId === "string" ? appointmentData.slotId : "";
  const slotRef = slotId ? db.collection("providerAvailabilitySlots").doc(slotId) : null;
  const slot = slotRef ? await slotRef.get() : null;
  if (
    !appointment.exists || appointmentData.patientUid !== uid || appointmentData.moncashPaymentRef !== paymentRef ||
    !appointmentPaymentMatches(appointmentData, intent) || String(appointmentData.currency || "").toUpperCase() !== "HTG" ||
    appointmentData.status !== "PENDING_PAYMENT" || appointmentData.paymentStatus !== "PENDING" ||
    !slot?.exists || slot.get("appointmentId") !== appointment.id || slot.get("status") !== "held" ||
    Number(slot.get("holdExpiresAt")) <= Date.now()
  ) throw new ApiError(409, "appointment-hold-expired", "La réservation temporaire a expiré. Choisissez un nouveau créneau avant de payer.");
  return { appointment, slot };
}

function diagnosticOrderPaymentMatches(order, payment) {
  const serviceAmount = Number(order.amount);
  const feeAmount = Number(order.transactionFee || 0);
  const totalAmount = Number(order.totalAmount ?? serviceAmount + feeAmount);
  return Number.isSafeInteger(serviceAmount) && serviceAmount >= 0 && Number.isSafeInteger(feeAmount) && feeAmount >= 0 &&
    Number.isSafeInteger(totalAmount) && totalAmount === serviceAmount + feeAmount && Number(payment.amount) === totalAmount &&
    Number(payment.serviceAmount ?? payment.resourceAmount ?? payment.amount) === serviceAmount && Number(payment.transactionFee || 0) === feeAmount;
}

async function requireMoncashPaymentResource(uid, paymentRef, intent) {
  if (intent.resourceType === "appointment") return requireAppointmentPaymentResource(uid, paymentRef, intent);
  const expectedKind = MONCASH_ORDER_RESOURCE_KINDS[String(intent.resourceType || "")];
  const match = String(intent.resourcePath || "").match(/^nexaOrders\/([A-Za-z0-9_-]{1,200})$/);
  if (!expectedKind || !match) throw new ApiError(409, "payment-resource-invalid", "Ce paiement n’est plus associé à une commande NEXA valide.");
  const order = await db.collection("nexaOrders").doc(match[1]).get();
  const data = order.data() || {};
  if (!order.exists || data.kind !== expectedKind || data.patientUid !== uid || data.moncashPaymentRef !== paymentRef ||
    !diagnosticOrderPaymentMatches(data, intent) || String(data.currency || "").toUpperCase() !== "HTG" || String(intent.currency || "").toUpperCase() !== "HTG" ||
    data.status !== "PENDING_PAYMENT" || data.paymentStatus !== "PENDING" || data.settlementStatus !== "PENDING" ||
    (Number(data.holdExpiresAt || 0) && Number(data.holdExpiresAt) <= Date.now())) {
    throw new ApiError(409, "diagnostic-order-not-payable", "Cette commande n’est plus disponible pour le paiement.");
  }
  return { order };
}

async function createNexaNotification(uid, eventKey, notification, appointmentId) {
  if (!uid || !eventKey) return;
  const notificationId = createHash("sha256").update(uid + ":" + eventKey).digest("hex");
  const notificationRef = db.collection("userNotifications").doc(notificationId);
  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(notificationRef);
    if (existing.exists) return;
    transaction.create(notificationRef, {
      uid,
      type: String(notification.type || "system").slice(0, 80),
      title: String(notification.title || "Notification NEXA").slice(0, 180),
      body: String(notification.body || "Une mise à jour est disponible dans votre espace NEXA.").slice(0, 500),
      url: typeof notification.url === "string" && notification.url.startsWith("/") && !notification.url.startsWith("//")
        ? notification.url.slice(0, 300)
        : "/espace-patient.html",
      ...(appointmentId ? { context: { appointmentId: appointmentId.slice(0, 200) } } : {}),
      read: false,
      readAt: null,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
}

function homeVisitMissionCodeHash(appointmentId, code) {
  return createHash("sha256").update("NEXA_HOME_VISIT:" + appointmentId + ":" + code).digest("hex");
}

async function sendHomeVisitMissionCodeEmail(uid, appointmentId, paymentRef, code) {
  if (!uid || !/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId) || !PAYMENT_REFERENCE_PATTERN.test(paymentRef) || !/^\d{8}$/.test(code)) return;
  if (isEmulator) return;
  const apiKey = readSecretValue(RESEND_API_KEY);
  const from = typeof process.env.NEXA_EMAIL_FROM === "string" ? process.env.NEXA_EMAIL_FROM.trim() : "";
  const senderAddress = from.match(/<([^<>]+)>/)?.[1] || from;
  if (!apiKey || !from || /[\r\n]/.test(from) || !/^[^<>\s@]+@nexarishaiti\.com$/i.test(senderAddress)) return;
  try {
    const recipient = await auth.getUser(uid);
    if (!recipient.email || recipient.emailVerified !== true) return;
    const eventKey = createHash("sha256").update(`home-visit-mission-code:${appointmentId}:${paymentRef}`).digest("hex");
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": eventKey,
      },
      body: JSON.stringify({
        from,
        to: [recipient.email],
        subject: "Code de clôture de votre visite NEXA",
        text: `Votre visite médicale à domicile est confirmée. Votre code de clôture est ${code}. Remettez-le au médecin seulement après avoir vérifié sa présence. Consultez votre espace patient : https://nexarishaiti.com/espace-patient.html`,
        html: `<p>Votre visite médicale à domicile est confirmée.</p><p>Votre code de clôture est <strong>${code}</strong>.</p><p>Remettez-le au médecin seulement après avoir vérifié sa présence.</p><p><a href="https://nexarishaiti.com/espace-patient.html">Consulter mon espace patient NEXA</a></p>`,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`resend-http-${response.status}`);
  } catch (error) {
    logger.warn("NEXA home visit mission-code email failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
  }
}

async function sendNursingVisitCodeEmail(uid, visitId, code) {
  if (!uid || !/^[A-Za-z0-9_-]{10,200}$/.test(visitId) || !/^\d{8}$/.test(code)) return;
  if (isEmulator) return;
  const apiKey = readSecretValue(RESEND_API_KEY);
  const from = typeof process.env.NEXA_EMAIL_FROM === "string" ? process.env.NEXA_EMAIL_FROM.trim() : "";
  const senderAddress = from.match(/<([^<>]+)>/)?.[1] || from;
  if (!apiKey || !from || /[\r\n]/.test(from) || !/^[^<>\s@]+@nexarishaiti\.com$/i.test(senderAddress)) return;
  try {
    const recipient = await auth.getUser(uid);
    if (!recipient.email || recipient.emailVerified !== true) return;
    const eventKey = createHash("sha256").update(`nursing-visit-code:${visitId}:${createHash("sha256").update(code).digest("hex")}`).digest("hex");
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": eventKey,
      },
      body: JSON.stringify({
        from,
        to: [recipient.email],
        subject: "Code de clôture de votre prestation NEXA",
        text: `Votre prestation infirmière NEXA a été confirmée. Votre code de clôture est ${code}. Remettez-le à l’infirmier seulement après avoir vérifié son identité et confirmé le soin. Consultez votre espace patient : https://nexarishaiti.com/espace-patient.html#commandes`,
        html: `<p>Votre prestation infirmière NEXA a été confirmée.</p><p>Votre code de clôture est <strong>${code}</strong>.</p><p>Remettez-le à l’infirmier seulement après avoir vérifié son identité et confirmé le soin.</p><p><a href="https://nexarishaiti.com/espace-patient.html#commandes">Consulter mon espace patient NEXA</a></p>`,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`resend-http-${response.status}`);
  } catch (error) {
    logger.warn("NEXA nursing visit-code email failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
  }
}

async function settlePaidAppointment(paymentRef) {
  const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
  const preview = await paymentRefDoc.get();
  if (!preview.exists || preview.get("status") !== "paid" || preview.get("paymentMethod") !== "MONCASH" || preview.get("resourceType") !== "appointment") return;
  const resourcePath = String(preview.get("resourcePath") || "");
  const match = resourcePath.match(/^appointments\/([A-Za-z0-9_-]{1,200})$/);
  if (!match) return;

  const appointmentRef = db.collection("appointments").doc(match[1]);
  const feeLedgerRef = db.collection("nexaTransactionFeeLedger").doc(paymentRef);
  const alertRef = db.collection("paymentSettlementAlerts").doc("appointment_" + paymentRef);
  const outcome = await db.runTransaction(async (transaction) => {
    const [paymentSnapshot, appointmentSnapshot, feeLedgerSnapshot, alertSnapshot] = await Promise.all([
      transaction.get(paymentRefDoc), transaction.get(appointmentRef), transaction.get(feeLedgerRef), transaction.get(alertRef),
    ]);
    if (!paymentSnapshot.exists || paymentSnapshot.get("status") !== "paid" || paymentSnapshot.get("resourcePath") !== resourcePath) return null;
    if (!appointmentSnapshot.exists) return null;
    const appointment = appointmentSnapshot.data() || {};
    const payment = paymentSnapshot.data() || {};
    const patientUid = String(appointment.patientUid || "");
    const providerUid = String(appointment.providerUid || "");
    if (
      patientUid !== paymentSnapshot.get("uid") || appointment.moncashPaymentRef !== paymentRef ||
      !appointmentPaymentMatches(appointment, payment) || String(appointment.currency || "").toUpperCase() !== "HTG" ||
      String(payment.currency || "").toUpperCase() !== "HTG"
    ) return null;

    const slotId = typeof appointment.slotId === "string" ? appointment.slotId : "";
    const slotRef = slotId ? db.collection("providerAvailabilitySlots").doc(slotId) : null;
    const slotSnapshot = slotRef ? await transaction.get(slotRef) : null;
    const slot = slotSnapshot?.data() || {};
    const proposalId = typeof appointment.followUpProposalId === "string" ? appointment.followUpProposalId : "";
    const proposalRef = appointment.bookingType === "doctor_proposed_appointment" && proposalId
      ? db.collection("followUpProposals").doc(proposalId)
      : null;
    const proposalSnapshot = proposalRef ? await transaction.get(proposalRef) : null;
    const proposalMatches = appointment.bookingType !== "doctor_proposed_appointment" || Boolean(
      proposalSnapshot?.exists && proposalSnapshot.get("patientUid") === patientUid &&
      proposalSnapshot.get("providerUid") === providerUid && proposalSnapshot.get("slotId") === slotId &&
      proposalSnapshot.get("pendingAppointmentId") === appointmentRef.id &&
      ["PENDING", "BOOKED"].includes(String(proposalSnapshot.get("status") || "")),
    );
    const feeAmount = Number(appointment.transactionFee) || 0;
    const feeLedgerMatches = feeAmount === 0
      ? !feeLedgerSnapshot.exists
      : feeLedgerSnapshot.exists && feeLedgerSnapshot.get("paymentRef") === paymentRef &&
        feeLedgerSnapshot.get("resourceType") === "appointment" && feeLedgerSnapshot.get("resourceId") === appointmentRef.id &&
        Number(feeLedgerSnapshot.get("amountMinor")) === feeAmount * 100 && feeLedgerSnapshot.get("recipient") === "NEXARIS" &&
        feeLedgerSnapshot.get("status") === "COMPLETED";
    if (feeLedgerSnapshot.exists && !feeLedgerMatches) return null;

    if (appointment.paymentStatus === "REFUNDED") {
      return {
        patientUid, providerUid, appointmentId: appointmentRef.id,
        confirmed: appointment.status !== "PAYMENT_CONFLICT_REFUND_REQUIRED",
        appointmentStatus: String(appointment.status || "REFUNDED"),
        homeVisitCode: "", alreadySettled: true,
      };
    }

    if (appointment.paymentStatus === "PAID") {
      if (feeAmount > 0 && !feeLedgerSnapshot.exists) transaction.create(feeLedgerRef, {
        paymentRef,
        resourceType: "appointment",
        resourceId: appointmentRef.id,
        serviceAmountMinor: Number(appointment.amount) * 100,
        amountMinor: feeAmount * 100,
        currency: "HTG",
        recipient: "NEXARIS",
        transactionFeeRateBps: Number(appointment.transactionFeeRateBps) || 0,
        paymentMethod: "MONCASH",
        status: "COMPLETED",
        createdAt: FieldValue.serverTimestamp(),
      });
      return {
        patientUid, providerUid, appointmentId: appointmentRef.id,
        confirmed: appointment.status !== "PAYMENT_CONFLICT_REFUND_REQUIRED",
        appointmentStatus: String(appointment.status),
        homeVisitCode: appointment.bookingType === "home_visit" &&
          ["SCHEDULED", "AWAITING_PROVIDER_CODE"].includes(String(appointment.homeVisitMissionStatus || "")) &&
          typeof appointment.homeVisitMissionCode === "string" && /^\d{8}$/.test(appointment.homeVisitMissionCode)
          ? appointment.homeVisitMissionCode
          : "",
        alreadySettled: true,
      };
    }

    const slotBelongsToAppointment = Boolean(
      slotSnapshot?.exists && slot.appointmentId === appointmentRef.id && slot.providerUid === appointment.providerUid &&
      ["held", "booked"].includes(String(slot.status)) && proposalMatches,
    );
    if (feeAmount > 0 && !feeLedgerSnapshot.exists) transaction.create(feeLedgerRef, {
      paymentRef,
      resourceType: "appointment",
      resourceId: appointmentRef.id,
      serviceAmountMinor: Number(appointment.amount) * 100,
      amountMinor: feeAmount * 100,
      currency: "HTG",
      recipient: "NEXARIS",
      transactionFeeRateBps: Number(appointment.transactionFeeRateBps) || 0,
      paymentMethod: "MONCASH",
      status: "COMPLETED",
      createdAt: FieldValue.serverTimestamp(),
    });

    const homeVisitCode = appointment.bookingType === "home_visit" && slotBelongsToAppointment
      ? typeof appointment.homeVisitMissionCode === "string"
        ? appointment.homeVisitMissionCode
        : String(randomInt(0, 100_000_000)).padStart(8, "0")
      : "";
    transaction.set(appointmentRef, {
      paymentStatus: "PAID",
      status: slotBelongsToAppointment
        ? appointment.bookingType === "doctor_proposed_appointment" ? "DOCTOR_ACCEPTED" : "CONFIRMED"
        : "PAYMENT_CONFLICT_REFUND_REQUIRED",
      sessionStatus: slotBelongsToAppointment && appointment.bookingType !== "home_visit" ? "SCHEDULED" : null,
      ...(appointment.bookingType === "home_visit" ? {
        homeVisitMissionStatus: slotBelongsToAppointment ? "SCHEDULED" : "PAYMENT_CONFLICT",
        ...(slotBelongsToAppointment ? {
          homeVisitMissionCode: homeVisitCode,
          homeVisitMissionCodeHash: homeVisitMissionCodeHash(appointmentRef.id, homeVisitCode),
          homeVisitMissionCodeIssuedAt: FieldValue.serverTimestamp(),
        } : {}),
      } : {}),
      refundRequired: !slotBelongsToAppointment,
      paidAt: appointment.paidAt || FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    if (slotBelongsToAppointment && slotRef) {
      transaction.set(slotRef, { status: "booked", holdExpiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      if (proposalRef) transaction.set(proposalRef, {
        status: "BOOKED",
        bookedAppointmentId: appointmentRef.id,
        paidAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    } else if (!alertSnapshot.exists) {
      transaction.create(alertRef, {
        paymentRef,
        resourceType: "appointment",
        resourceId: appointmentRef.id,
        reason: "SLOT_NO_LONGER_HELD",
        status: "open",
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    return {
      patientUid,
      providerUid,
      appointmentId: appointmentRef.id,
      confirmed: slotBelongsToAppointment,
      appointmentStatus: slotBelongsToAppointment
        ? appointment.bookingType === "doctor_proposed_appointment" ? "DOCTOR_ACCEPTED" : "CONFIRMED"
        : "PAYMENT_CONFLICT_REFUND_REQUIRED",
      homeVisitCode,
    };
  });

  if (!outcome?.patientUid) return;
  if (outcome.alreadySettled) {
    if (outcome.homeVisitCode) await sendHomeVisitMissionCodeEmail(outcome.patientUid, outcome.appointmentId, paymentRef, outcome.homeVisitCode);
    return {
      appointmentId: outcome.appointmentId,
      appointmentStatus: outcome.appointmentStatus,
      confirmed: outcome.confirmed,
    };
  }
  if (outcome.homeVisitCode) await sendHomeVisitMissionCodeEmail(outcome.patientUid, outcome.appointmentId, paymentRef, outcome.homeVisitCode);
  await createNexaNotification(outcome.patientUid, "appointment:payment:" + paymentRef, outcome.confirmed
    ? { type: "appointment_payment_confirmed", title: "Paiement confirmé", body: outcome.homeVisitCode
      ? "Votre visite à domicile est confirmée. Consultez votre espace patient pour votre code de clôture."
      : "Votre rendez-vous est confirmé. NEXA vous avisera de la suite.", url: "/espace-patient.html" }
    : { type: "appointment_payment_reconciliation", title: "Paiement à rapprocher", body: "Le paiement a été reçu, mais le créneau doit être vérifié. Ne payez pas une seconde fois; NEXA examinera la transaction.", url: "/espace-patient.html" },
  outcome.appointmentId);
  if (outcome.confirmed && outcome.providerUid) await createNexaNotification(outcome.providerUid, "appointment:payment:" + paymentRef, {
    type: "appointment_payment_confirmed",
    title: "Nouveau rendez-vous payé",
    body: "Un patient a réservé et payé un créneau. Consultez votre espace professionnel.",
    url: "/espace-professionnel.html",
  }, outcome.appointmentId);
  return { appointmentId: outcome.appointmentId, appointmentStatus: outcome.appointmentStatus, confirmed: outcome.confirmed };
}

async function settleVerifiedMoncashResource(paymentRef) {
  const payment = await db.collection("paymentIntents").doc(paymentRef).get();
  if (!payment.exists) return null;
  const resourceType = String(payment.get("resourceType") || "");
  if (resourceType === "appointment") return settlePaidAppointment(paymentRef);
  if (resourceType === "pharmacy-order") return settlePaidPharmacyOrderPayment(paymentRef);
  if (resourceType === "nursing-order") return settlePaidNursingOrderPayment(paymentRef);
  if (MONCASH_ORDER_RESOURCE_KINDS[resourceType]) return settlePaidDiagnosticOrderPayment(paymentRef);
  return null;
}

async function recordVerifiedMoncashPayment(paymentRef, amount, currency, transactionId) {
  const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(paymentRefDoc);
    if (!snapshot.exists) throw new MoncashGatewayError(404, "payment-not-found");
    const resourceType = String(snapshot.get("resourceType") || "");
    const resourcePath = String(snapshot.get("resourcePath") || "");
    const validResource = resourceType === "appointment"
      ? /^appointments\/[A-Za-z0-9_-]{1,200}$/.test(resourcePath)
      : Boolean(MONCASH_ORDER_RESOURCE_KINDS[resourceType] && /^nexaOrders\/[A-Za-z0-9_-]{1,200}$/.test(resourcePath));
    if (Number(snapshot.get("amount")) !== amount ||
      String(snapshot.get("currency") || "").toUpperCase() !== currency ||
      String(snapshot.get("paymentMethod") || "").toUpperCase() !== "MONCASH" ||
      !validResource) {
      throw new MoncashGatewayError(404, "payment-not-found");
    }
    if (snapshot.get("status") === "paid") return { status: "paid", alreadyPaid: true };
    const currentStatus = String(snapshot.get("status") || "").toLowerCase();
    if (!["created", "awaiting_payment", "payment_pending", "initializing", "pending", "creating", "creation_uncertain", "creation_failed", "expired"].includes(currentStatus)) {
      throw new MoncashGatewayError(409, "payment-transition-invalid");
    }
    transaction.set(paymentRefDoc, {
      status: "paid",
      paymentProvider: "moncash",
      providerTransactionId: transactionId.slice(0, 120),
      paidAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { status: "paid", alreadyPaid: false };
  });
}

const MONCASH_FUNCTION_SECRETS = [NEXA_TO_SMARTCUT_SIGNING_SECRET, SMARTCUT_TO_NEXA_WEBHOOK_SECRET, RESEND_API_KEY];

exports.appointmentMoncashCreate = onRequest(
  { region: FUNCTION_REGION, secrets: MONCASH_FUNCTION_SECRETS },
  async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      res.set("Allow", "POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if ((Number(req.get("Content-Length")) || 0) > 4_096 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 4_096)) {
      return fail(res, 413, "request-too-large", "La requête est trop volumineuse.");
    }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      const body = parseRequestBody(req);
      const paymentRef = body && typeof body === "object" && !Array.isArray(body) && typeof body.paymentRef === "string"
        ? body.paymentRef.trim()
        : "";
      if (!PAYMENT_REFERENCE_PATTERN.test(paymentRef)) throw new ApiError(400, "invalid-payment-reference", "La référence de paiement n’est pas valide.");
      const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
      const snapshot = await paymentRefDoc.get();
      if (!snapshot.exists || snapshot.get("uid") !== user.uid || String(snapshot.get("paymentMethod") || "").toUpperCase() !== "MONCASH") {
        throw new ApiError(404, "payment-not-found", "Le paiement n’a pas été trouvé.");
      }
      const intent = snapshot.data() || {};
      const amount = Number(intent.amount);
      const currency = String(intent.currency || "").toUpperCase();
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_PAYMENT_AMOUNT_HTG || currency !== "HTG") {
        throw new ApiError(409, "payment-intent-invalid", "Le montant de ce paiement n’est pas valide.");
      }
      if (intent.status === "paid") {
        const settlement = await settleVerifiedMoncashResource(paymentRef);
        res.set("Cache-Control", "no-store, max-age=0");
        return res.status(200).json({ ok: true, paymentRef, status: "paid", ...(settlement?.appointmentStatus ? { appointmentStatus: settlement.appointmentStatus } : {}), ...(typeof settlement?.confirmed === "boolean" ? { settlementStatus: settlement.confirmed ? "CONFIRMED" : "REVIEW_REQUIRED" } : {}) });
      }
      await requireMoncashPaymentResource(user.uid, paymentRef, intent);

      let existingCheckoutUrl = null;
      let alreadyPaid = false;
      const createAttemptId = randomBytes(16).toString("hex");
      await db.runTransaction(async (transaction) => {
        const fresh = await transaction.get(paymentRefDoc);
        if (!fresh.exists || fresh.get("uid") !== user.uid || String(fresh.get("paymentMethod") || "").toUpperCase() !== "MONCASH") {
          throw new ApiError(404, "payment-not-found", "Le paiement n’a pas été trouvé.");
        }
        if (fresh.get("status") === "paid") {
          alreadyPaid = true;
          return;
        }
        const currentStatus = String(fresh.get("status") || "").toLowerCase();
        if (currentStatus === "pending" && fresh.get("checkoutUrl")) {
          existingCheckoutUrl = safeMoncashCheckoutUrl(fresh.get("checkoutUrl"));
          if (existingCheckoutUrl) return;
        }
        if (!["created", "awaiting_payment", "payment_pending", "initializing", "pending"].includes(currentStatus)) {
          throw new ApiError(409, "payment-intent-not-payable", "Ce paiement n’est pas disponible.");
        }
        const startedAt = fresh.get("moncashCreateAttemptStartedAt");
        const startedAtMs = startedAt && typeof startedAt === "object" && typeof startedAt.toMillis === "function"
          ? startedAt.toMillis()
          : 0;
        if (currentStatus === "initializing" && fresh.get("moncashCreateAttemptId") && startedAtMs && Date.now() - startedAtMs < 60_000) {
          throw new ApiError(409, "payment-initializing", "La préparation du paiement est en cours. Réessayez dans quelques instants.");
        }
        transaction.set(paymentRefDoc, {
          status: "initializing",
          moncashCreateAttemptId: createAttemptId,
          moncashCreateAttemptStartedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      if (alreadyPaid) {
        const settlement = await settleVerifiedMoncashResource(paymentRef);
        res.set("Cache-Control", "no-store, max-age=0");
        return res.status(200).json({ ok: true, paymentRef, status: "paid", ...(settlement?.appointmentStatus ? { appointmentStatus: settlement.appointmentStatus } : {}), ...(typeof settlement?.confirmed === "boolean" ? { settlementStatus: settlement.confirmed ? "CONFIRMED" : "REVIEW_REQUIRED" } : {}) });
      }
      if (existingCheckoutUrl) {
        res.set("Cache-Control", "no-store, max-age=0");
        return res.status(200).json({ ok: true, paymentRef, status: "pending", amount, currency, checkoutUrl: existingCheckoutUrl.toString() });
      }

      const gateway = await callSmartCut("SMARTCUT_MONCASH_CREATE_URL", { paymentRef, amount, currency },
        readSecretValue(NEXA_TO_SMARTCUT_SIGNING_SECRET), readSecretValue(SMARTCUT_TO_NEXA_WEBHOOK_SECRET));
      const checkoutUrl = safeMoncashCheckoutUrl(gateway.checkoutUrl);
      const gatewayStatus = String(gateway.status || "").toLowerCase();
      if (gateway.paymentRef !== paymentRef || Number(gateway.amount) !== amount ||
        String(gateway.currency || "").toUpperCase() !== currency || !["pending", "paid"].includes(gatewayStatus) ||
        (gatewayStatus === "pending" && !checkoutUrl) ||
        (gatewayStatus === "paid" && !(typeof gateway.transactionId === "string" && gateway.transactionId.trim()))) {
        throw new MoncashGatewayError(502, "payment-gateway-response-invalid");
      }

      let effectiveStatus = gatewayStatus;
      await db.runTransaction(async (transaction) => {
        const fresh = await transaction.get(paymentRefDoc);
        if (!fresh.exists || fresh.get("uid") !== user.uid || String(fresh.get("paymentMethod") || "").toUpperCase() !== "MONCASH") {
          throw new ApiError(404, "payment-not-found", "Le paiement n’a pas été trouvé.");
        }
        if (fresh.get("status") === "paid") {
          effectiveStatus = "paid";
          return;
        }
        if (fresh.get("moncashCreateAttemptId") !== createAttemptId) {
          throw new ApiError(409, "payment-initialization-changed", "La préparation de ce paiement a changé. Vérifiez son état avant de réessayer.");
        }
        const currentStatus = String(fresh.get("status") || "").toLowerCase();
        if (!["created", "awaiting_payment", "payment_pending", "initializing", "pending"].includes(currentStatus)) {
          throw new ApiError(409, "payment-transition-invalid", "Le statut de ce paiement a changé.");
        }
        transaction.set(paymentRefDoc, {
          status: gatewayStatus,
          ...(gatewayStatus === "pending" ? { checkoutUrl: checkoutUrl.toString() } : {}),
          paymentProvider: "moncash",
          gateway: "smartcut-moncash",
          ...(gatewayStatus === "paid" ? {
            providerTransactionId: String(gateway.transactionId).trim().slice(0, 120),
            paidAt: fresh.get("paidAt") || FieldValue.serverTimestamp(),
          } : {}),
          moncashCreateAttemptId: FieldValue.delete(),
          moncashCreateAttemptStartedAt: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      const settlement = effectiveStatus === "paid" ? await settleVerifiedMoncashResource(paymentRef) : null;
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({
        ok: true,
        paymentRef,
        amount,
        currency,
        status: effectiveStatus,
        ...(settlement ? { appointmentStatus: settlement.appointmentStatus } : {}),
        ...(typeof settlement?.confirmed === "boolean" ? { settlementStatus: settlement.confirmed ? "CONFIRMED" : "REVIEW_REQUIRED" } : {}),
        ...(effectiveStatus === "pending" ? { checkoutUrl: checkoutUrl.toString() } : {}),
      });
    } catch (error) {
      return sendMoncashError(res, error, "payment-initialization-failed", "Le paiement ne peut pas être préparé pour le moment.");
    }
  },
);

exports.appointmentMoncashStatus = onRequest(
  { region: FUNCTION_REGION, secrets: MONCASH_FUNCTION_SECRETS },
  async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      res.set("Allow", "POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      const body = parseRequestBody(req);
      const paymentRef = body && typeof body === "object" && !Array.isArray(body) && typeof body.paymentRef === "string"
        ? body.paymentRef.trim()
        : "";
      if (!PAYMENT_REFERENCE_PATTERN.test(paymentRef)) throw new ApiError(400, "invalid-payment-reference", "La référence de paiement n’est pas valide.");
      const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
      const snapshot = await paymentRefDoc.get();
      if (!snapshot.exists || snapshot.get("uid") !== user.uid || String(snapshot.get("paymentMethod") || "").toUpperCase() !== "MONCASH") {
        throw new ApiError(404, "payment-not-found", "Le paiement n’a pas été trouvé.");
      }
      const intent = snapshot.data() || {};
      const amount = Number(intent.amount);
      const currency = String(intent.currency || "").toUpperCase();
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_PAYMENT_AMOUNT_HTG || currency !== "HTG" ||
        (intent.resourceType !== "appointment" && !MONCASH_ORDER_RESOURCE_KINDS[String(intent.resourceType || "")])) {
        throw new ApiError(409, "payment-intent-invalid", "Le montant de ce paiement n’est pas valide.");
      }
      if (intent.status === "paid") {
        const settlement = await settleVerifiedMoncashResource(paymentRef);
        res.set("Cache-Control", "no-store, max-age=0");
        return res.status(200).json({ ok: true, paymentRef, status: "paid", amount, currency, ...(settlement?.appointmentStatus ? { appointmentStatus: settlement.appointmentStatus } : {}), ...(typeof settlement?.confirmed === "boolean" ? { settlementStatus: settlement.confirmed ? "CONFIRMED" : "REVIEW_REQUIRED" } : {}) });
      }

      const gateway = await callSmartCut("SMARTCUT_MONCASH_STATUS_URL", { paymentRef },
        readSecretValue(NEXA_TO_SMARTCUT_SIGNING_SECRET), readSecretValue(SMARTCUT_TO_NEXA_WEBHOOK_SECRET));
      const gatewayStatus = String(gateway.status || "").toLowerCase();
      const checkoutUrl = safeMoncashCheckoutUrl(gateway.checkoutUrl);
      if (gateway.paymentRef !== paymentRef || Number(gateway.amount) !== amount ||
        String(gateway.currency || "").toUpperCase() !== currency ||
        !["pending", "paid", "creating", "creation_uncertain", "creation_failed"].includes(gatewayStatus) ||
        (gateway.checkoutUrl && !checkoutUrl) ||
        (gatewayStatus === "paid" && !(typeof gateway.transactionId === "string" && gateway.transactionId.trim()))) {
        throw new MoncashGatewayError(502, "payment-gateway-response-invalid");
      }

      let status = gatewayStatus;
      await db.runTransaction(async (transaction) => {
        const fresh = await transaction.get(paymentRefDoc);
        if (!fresh.exists || fresh.get("uid") !== user.uid || String(fresh.get("paymentMethod") || "").toUpperCase() !== "MONCASH") {
          throw new ApiError(404, "payment-not-found", "Le paiement n’a pas été trouvé.");
        }
        if (fresh.get("status") === "paid") {
          status = "paid";
          return;
        }
        const currentStatus = String(fresh.get("status") || "").toLowerCase();
        if (!["created", "awaiting_payment", "payment_pending", "initializing", "pending", "creating", "creation_uncertain", "creation_failed", "expired"].includes(currentStatus)) {
          throw new ApiError(409, "payment-transition-invalid", "Le statut de ce paiement a changé.");
        }
        if (currentStatus === "expired" && status !== "paid") {
          status = "creation_failed";
          return;
        }
        transaction.set(paymentRefDoc, {
          status,
          paymentProvider: "moncash",
          ...(status === "paid" ? {
            providerTransactionId: String(gateway.transactionId).trim().slice(0, 120),
            paidAt: fresh.get("paidAt") || FieldValue.serverTimestamp(),
          } : {}),
          ...(status === "pending" && checkoutUrl ? { checkoutUrl: checkoutUrl.toString() } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      let settlement = null;
      if (status === "paid") {
        await recordVerifiedMoncashPayment(paymentRef, amount, currency, String(gateway.transactionId).trim());
        settlement = await settleVerifiedMoncashResource(paymentRef);
      }
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({
        ok: true,
        paymentRef,
        status,
        amount,
        currency,
        transactionId: typeof gateway.transactionId === "string" ? gateway.transactionId.slice(0, 120) : null,
        ...(settlement ? { appointmentStatus: settlement.appointmentStatus } : {}),
        ...(typeof settlement?.confirmed === "boolean" ? { settlementStatus: settlement.confirmed ? "CONFIRMED" : "REVIEW_REQUIRED" } : {}),
        ...(status === "pending" && checkoutUrl ? { checkoutUrl: checkoutUrl.toString() } : {}),
      });
    } catch (error) {
      return sendMoncashError(res, error, "payment-status-unavailable", "Le statut du paiement ne peut pas être vérifié pour le moment.");
    }
  },
);

// The shared signed MonCash bridge handles appointments and NEXA service orders.
exports.diagnosticOrderMoncashCreate = exports.appointmentMoncashCreate;
exports.diagnosticOrderMoncashStatus = exports.appointmentMoncashStatus;
exports.pharmacyOrderMoncashCreate = exports.appointmentMoncashCreate;
exports.pharmacyOrderMoncashStatus = exports.appointmentMoncashStatus;
exports.nexaNursingOrderMoncashCreate = exports.appointmentMoncashCreate;
exports.nexaNursingOrderMoncashStatus = exports.appointmentMoncashStatus;

exports.nexaMoncashCallback = onRequest(
  { region: FUNCTION_REGION, secrets: [SMARTCUT_TO_NEXA_WEBHOOK_SECRET, RESEND_API_KEY] },
  async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method !== "POST") {
      res.set("Allow", "POST");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    try {
      const callback = readSignedCallback(req, readSecretValue(SMARTCUT_TO_NEXA_WEBHOOK_SECRET));
      const paymentRef = typeof callback.paymentRef === "string" ? callback.paymentRef.trim() : "";
      const amount = Number(callback.amount);
      const currency = String(callback.currency || "").toUpperCase();
      const transactionId = typeof callback.transactionId === "string" ? callback.transactionId.trim().slice(0, 120) : "";
      if (!PAYMENT_REFERENCE_PATTERN.test(paymentRef) || callback.status !== "paid" || !Number.isSafeInteger(amount) ||
        amount <= 0 || amount > MAX_PAYMENT_AMOUNT_HTG || currency !== "HTG" || !transactionId) {
        throw new MoncashGatewayError(400, "callback-payload-invalid");
      }
      await recordVerifiedMoncashPayment(paymentRef, amount, currency, transactionId);
      await settleVerifiedMoncashResource(paymentRef);
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, paymentRef, status: "paid" });
    } catch (error) {
      const status = error instanceof ApiError || error instanceof MoncashGatewayError ? error.status : 500;
      const code = error instanceof ApiError || error instanceof MoncashGatewayError ? error.code : "callback-processing-failed";
      if (!(error instanceof ApiError) && !(error instanceof MoncashGatewayError)) {
        logger.error("NEXA MonCash callback failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      }
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(status).json({ ok: false, code });
    }
  },
);

function patientAppointmentSummary(document, now = Date.now()) {
  const item = document.data() || {};
  const holdExpiresAt = Number.isSafeInteger(item.holdExpiresAt) ? item.holdExpiresAt : null;
  const pendingPayment = item.status === "PENDING_PAYMENT" && item.paymentStatus === "PENDING" &&
    typeof item.moncashPaymentRef === "string" && (!holdExpiresAt || holdExpiresAt > now);
  const holdExpired = item.status === "PENDING_PAYMENT" && item.paymentStatus === "PENDING" &&
    Boolean(holdExpiresAt && holdExpiresAt <= now);
  const summary = {
    appointmentId: document.id,
    ...(typeof item.bookingType === "string" ? { bookingType: item.bookingType } : {}),
    providerUid: typeof item.providerUid === "string" ? item.providerUid : "",
    providerName: typeof item.providerName === "string" ? item.providerName.slice(0, 120) : "Professionnel NEXA",
    startsAt: typeof item.startsAt === "string" ? item.startsAt : "",
    endsAt: typeof item.endsAt === "string" ? item.endsAt : "",
    durationMinutes: item.bookingType === "home_visit" ? 60 : getTeleconsultationDurationMinutes(item),
    amount: Number.isSafeInteger(item.amount) ? item.amount : 0,
    currency: "HTG",
    ...(typeof item.paymentMethod === "string" ? { paymentMethod: item.paymentMethod } : {}),
    status: holdExpired ? "PAYMENT_EXPIRED" : typeof item.status === "string" ? item.status : "UNKNOWN",
    paymentStatus: holdExpired ? "EXPIRED" : typeof item.paymentStatus === "string" ? item.paymentStatus : "UNKNOWN",
    refundRequired: item.refundRequired === true,
    consultationStarted: clinicalTimestamp(item.effectiveConsultationStartedAt) > 0 ||
      clinicalTimestamp(item.trustedAgoraRtcStartedAt) > 0 ||
      String(item.sessionStatus || "").toUpperCase() === "ACTIVE" || String(item.videoStatus || "").toUpperCase() === "ACTIVE",
  };
  const clinicalAccess = consultationClinicalAccessWindow(item);
  summary.clinicalAccessActive = Boolean(clinicalAccess);
  if (clinicalAccess) summary.clinicalAccessExpiresAt = new Date(clinicalAccess.expiresAtMs).toISOString();

  if (item.bookingType === "home_visit" && item.homeVisitDetails && typeof item.homeVisitDetails === "object") {
    const details = item.homeVisitDetails;
    Object.assign(summary, {
      homeVisitServiceId: typeof item.homeVisitServiceId === "string" ? item.homeVisitServiceId.slice(0, 64) : "",
      homeVisitDetails: {
        department: cleanPublicText(details.department, 80),
        commune: cleanPublicText(details.commune, 80),
        addressLine: cleanPublicText(details.addressLine, 220),
        contactPhone: cleanPublicText(details.contactPhone, 24),
      },
      homeVisitMissionStatus: typeof item.homeVisitMissionStatus === "string" ? item.homeVisitMissionStatus : "UNKNOWN",
    });
    if (
      item.paymentStatus === "PAID" && item.status === "CONFIRMED" &&
      ["SCHEDULED", "AWAITING_PROVIDER_CODE"].includes(String(item.homeVisitMissionStatus || "")) &&
      typeof item.homeVisitMissionCode === "string"
    ) summary.homeVisitMissionCode = item.homeVisitMissionCode.slice(0, 8);
  }
  for (const key of ["refundMethod", "requestedRefundMethod", "refundStatus", "noShowOutcome", "noShowReason"]) {
    if (typeof item[key] === "string") summary[key] = item[key];
  }
  if (pendingPayment) {
    summary.paymentRef = item.moncashPaymentRef;
    summary.transactionFee = Number.isSafeInteger(item.transactionFee) ? item.transactionFee : 0;
    summary.totalAmount = Number.isSafeInteger(item.totalAmount) ? item.totalAmount : summary.amount + summary.transactionFee;
  }
  return summary;
}

exports.patientAppointments = onRequest(
  { region: FUNCTION_REGION },
  async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") {
      res.set("Allow", "GET, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "patient-appointments-read", 20, 5 * 60_000);
      const patient = await db.collection("patientProfiles").doc(user.uid).get();
      if (!patient.exists || patient.get("role") !== "patient" || patient.get("profileComplete") !== true) {
        throw new ApiError(403, "complete-patient-profile-required", "Accès patient NEXA requis.");
      }

      const requestedCursor = req.query.cursor;
      if (requestedCursor !== undefined &&
        (typeof requestedCursor !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(requestedCursor))) {
        throw new ApiError(400, "invalid-patient-appointments-cursor", "Actualisez la liste des rendez-vous avant de continuer.");
      }
      const appointmentsRef = db.collection("appointments");
      let appointmentsQuery = appointmentsRef.where("patientUid", "==", user.uid).orderBy("startsAt", "desc");
      if (requestedCursor) {
        const cursorSnapshot = await appointmentsRef.doc(requestedCursor).get();
        if (!cursorSnapshot.exists || cursorSnapshot.get("patientUid") !== user.uid ||
          typeof cursorSnapshot.get("startsAt") !== "string" || !Number.isFinite(Date.parse(cursorSnapshot.get("startsAt")))) {
          throw new ApiError(400, "invalid-patient-appointments-cursor", "Actualisez la liste des rendez-vous avant de continuer.");
        }
        appointmentsQuery = appointmentsQuery.startAfter(cursorSnapshot);
      }
      const pageSnapshot = await appointmentsQuery.limit(101).get();
      const scanDocs = pageSnapshot.docs.slice(0, 100);
      const appointments = [];
      let lastScannedDocument = null;
      for (const document of scanDocs) {
        lastScannedDocument = document;
        const appointment = patientAppointmentSummary(document);
        const dismissedExpired = document.get("dismissedByPatient") === true &&
          appointment.status === "PAYMENT_EXPIRED" && appointment.paymentStatus === "EXPIRED";
        if (!dismissedExpired) appointments.push(appointment);
        if (appointments.length >= 25) break;
      }
      const hasMore = Boolean(lastScannedDocument) && (
        lastScannedDocument.id !== scanDocs[scanDocs.length - 1]?.id || pageSnapshot.docs.length > scanDocs.length
      );

      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({
        ok: true,
        appointments,
        hasMore,
        nextCursor: hasMore ? lastScannedDocument.id : null,
      });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("Patient appointments request failed", {
        errorName: error instanceof Error ? error.name : "unknown-error",
      });
      return fail(res, 500, "patient-appointments-unavailable", "Vos rendez-vous ne sont pas accessibles pour le moment.");
    }
  },
);

exports.patientAppointmentDismiss = onRequest(
  { region: FUNCTION_REGION },
  async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      res.set("Allow", "POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if ((Number(req.get("Content-Length")) || 0) > 4_096 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 4_096)) {
      return fail(res, 413, "request-too-large", "La requête est trop volumineuse.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "patient-appointment-dismiss", 10, 5 * 60_000);
      const patient = await db.collection("patientProfiles").doc(user.uid).get();
      if (!patient.exists || patient.get("role") !== "patient" || patient.get("profileComplete") !== true) {
        throw new ApiError(403, "complete-patient-profile-required", "Accès patient NEXA requis.");
      }

      const body = parseRequestBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "appointmentId")) {
        throw new ApiError(400, "invalid-appointment", "Le rendez-vous à masquer n’est pas valide.");
      }
      const appointmentId = typeof body.appointmentId === "string" ? body.appointmentId.trim() : "";
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) {
        throw new ApiError(400, "invalid-appointment", "Le rendez-vous à masquer n’est pas valide.");
      }

      const appointmentRef = db.collection("appointments").doc(appointmentId);
      const outcome = await db.runTransaction(async (transaction) => {
        const appointmentSnapshot = await transaction.get(appointmentRef);
        if (!appointmentSnapshot.exists || appointmentSnapshot.get("patientUid") !== user.uid) {
          throw new ApiError(404, "appointment-not-found", "Le rendez-vous n’a pas été trouvé.");
        }

        const appointment = appointmentSnapshot.data() || {};
        const expiredPersisted = appointment.status === "PAYMENT_EXPIRED" && appointment.paymentStatus === "EXPIRED";
        const holdExpiresAt = Number(appointment.holdExpiresAt);
        const expiredPendingHold = appointment.status === "PENDING_PAYMENT" && appointment.paymentStatus === "PENDING" &&
          Number.isSafeInteger(holdExpiresAt) && holdExpiresAt > 0 && holdExpiresAt <= Date.now();
        if (!expiredPersisted && !expiredPendingHold) {
          throw new ApiError(409, "appointment-not-expired", "Seul un rendez-vous dont la réservation a expiré peut être masqué.");
        }

        const paymentRef = typeof appointment.moncashPaymentRef === "string" ? appointment.moncashPaymentRef : "";
        if (paymentRef) {
          if (!PAYMENT_REFERENCE_PATTERN.test(paymentRef)) {
            throw new ApiError(409, "appointment-payment-unverified", "Le statut du paiement doit être vérifié par NEXA avant de masquer ce rendez-vous.");
          }
          const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
          const paymentSnapshot = await transaction.get(paymentRefDoc);
          if (!paymentSnapshot.exists || paymentSnapshot.get("uid") !== user.uid ||
            paymentSnapshot.get("resourceType") !== "appointment" || paymentSnapshot.get("resourcePath") !== appointmentRef.path) {
            throw new ApiError(409, "appointment-payment-unverified", "Le statut du paiement doit être vérifié par NEXA avant de masquer ce rendez-vous.");
          }
          if (String(paymentSnapshot.get("status") || "").toLowerCase() === "paid" ||
            ["PAID", "REFUNDED"].includes(String(appointment.paymentStatus || "").toUpperCase())) {
            throw new ApiError(409, "appointment-payment-settled", "Un rendez-vous payé ou remboursé ne peut pas être masqué comme une réservation expirée.");
          }
        }

        if (appointment.dismissedByPatient === true) return { dismissed: true, alreadyDismissed: true };
        transaction.set(appointmentRef, {
          dismissedByPatient: true,
          dismissedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        return { dismissed: true, alreadyDismissed: false };
      });

      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, ...outcome });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("Patient appointment dismiss request failed", {
        errorName: error instanceof Error ? error.name : "unknown-error",
      });
      return fail(res, 500, "patient-appointment-dismiss-unavailable", "Ce rendez-vous ne peut pas être masqué pour le moment.");
    }
  },
);

function patientWalletEntrySummary(document) {
  const item = document.data() || {};
  const createdAt = item.createdAt && typeof item.createdAt.toDate === "function"
    ? item.createdAt.toDate().toISOString()
    : null;
  return {
    id: document.id,
    type: ["REFUND", "PAYMENT"].includes(String(item.type || "")) ? item.type : "OTHER",
    direction: ["CREDIT", "DEBIT"].includes(String(item.direction || "")) ? item.direction : "OTHER",
    amountMinor: Number.isSafeInteger(item.amountMinor) && item.amountMinor >= 0 ? item.amountMinor : 0,
    serviceAmountMinor: Number.isSafeInteger(item.serviceAmountMinor) && item.serviceAmountMinor >= 0 ? item.serviceAmountMinor : null,
    transactionFeeMinor: Number.isSafeInteger(item.transactionFeeMinor) && item.transactionFeeMinor >= 0 ? item.transactionFeeMinor : null,
    currency: "HTG",
    status: item.status === "COMPLETED" ? "COMPLETED" : "PENDING",
    createdAt,
  };
}

exports.nexaPatientWallet = onRequest(
  { region: FUNCTION_REGION },
  async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") {
      res.set("Allow", "GET, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "patient-wallet-read", 30, 5 * 60_000);
      const walletRef = db.collection("nexaPatientWallets").doc(user.uid);
      const patientRef = db.collection("patientProfiles").doc(user.uid);
      const [patientSnapshot, walletSnapshot, ledgerSnapshot] = await Promise.all([
        patientRef.get(),
        walletRef.get(),
        db.collection("nexaWalletLedger").where("userUid", "==", user.uid).orderBy("createdAt", "desc").limit(40).get(),
      ]);
      if (!patientSnapshot.exists || patientSnapshot.get("role") !== "patient" || patientSnapshot.get("profileComplete") !== true ||
        !isPatientNumber(patientSnapshot.get("patientNumber"))) {
        throw new ApiError(403, "complete-patient-profile-required", "Accès patient NEXA requis.");
      }
      const wallet = walletSnapshot.data() || {};
      const availableMinor = wallet.availableMinor === undefined ? 0 : Number(wallet.availableMinor);
      const reservedMinor = wallet.reservedMinor === undefined ? 0 : Number(wallet.reservedMinor);
      if (!Number.isSafeInteger(availableMinor) || availableMinor < 0 || !Number.isSafeInteger(reservedMinor) || reservedMinor < 0 ||
        (wallet.currency && wallet.currency !== "HTG") || (wallet.status && !["ACTIVE", "FROZEN"].includes(wallet.status))) {
        throw new ApiError(503, "wallet-state-invalid", "Le portefeuille NEXA ne peut pas être affiché actuellement.");
      }
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({
        ok: true,
        wallet: {
          currency: "HTG",
          availableMinor,
          reservedMinor,
          status: wallet.status || "ACTIVE",
          cashOutEnabled: false,
        },
        entries: ledgerSnapshot.docs.map(patientWalletEntrySummary),
      });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA patient wallet request failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "patient-wallet-unavailable", "Votre portefeuille NEXA n’est pas accessible pour le moment.");
    }
  },
);

exports.appointmentWalletPay = onRequest(
  { region: FUNCTION_REGION, secrets: [RESEND_API_KEY] },
  async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      res.set("Allow", "POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if ((Number(req.get("Content-Length")) || 0) > 4_096 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 4_096)) {
      return fail(res, 413, "request-too-large", "La requête est trop volumineuse.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "appointment-wallet-pay", 8, 5 * 60_000);
      const body = parseRequestBody(req);
      const paymentRef = body && typeof body === "object" && !Array.isArray(body) && typeof body.paymentRef === "string"
        ? body.paymentRef.trim()
        : "";
      if (!PAYMENT_REFERENCE_PATTERN.test(paymentRef)) throw new ApiError(400, "invalid-payment-reference", "La référence de paiement n’est pas valide.");

      const paymentRefDoc = db.collection("paymentIntents").doc(paymentRef);
      const walletRef = db.collection("nexaPatientWallets").doc(user.uid);
      const patientRef = db.collection("patientProfiles").doc(user.uid);
      const walletLedgerId = createHash("sha256").update("NEXA_WALLET_PAYMENT:" + paymentRef).digest("hex");
      const walletLedgerRef = db.collection("nexaWalletLedger").doc(walletLedgerId);
      const feeLedgerRef = db.collection("nexaTransactionFeeLedger").doc(paymentRef);
      const homeVisitCode = String(randomInt(0, 100_000_000)).padStart(8, "0");

      const outcome = await db.runTransaction(async (transaction) => {
        const paymentSnapshot = await transaction.get(paymentRefDoc);
        if (!paymentSnapshot.exists || paymentSnapshot.get("uid") !== user.uid || paymentSnapshot.get("resourceType") !== "appointment") {
          throw new ApiError(404, "payment-not-found", "Le paiement n’a pas été trouvé.");
        }
        const payment = paymentSnapshot.data() || {};
        const match = String(payment.resourcePath || "").match(/^appointments\/([A-Za-z0-9_-]{1,200})$/);
        if (!match) throw new ApiError(409, "appointment-payment-invalid", "Ce paiement n’est plus associé à un rendez-vous valide.");
        const appointmentRef = db.collection("appointments").doc(match[1]);
        const appointmentSnapshot = await transaction.get(appointmentRef);
        if (!appointmentSnapshot.exists) throw new ApiError(404, "appointment-not-found", "Le rendez-vous n’existe plus.");
        const appointment = appointmentSnapshot.data() || {};
        const slotRef = typeof appointment.slotId === "string" && appointment.slotId
          ? db.collection("providerAvailabilitySlots").doc(appointment.slotId)
          : null;
        const proposalRef = appointment.bookingType === "doctor_proposed_appointment" && typeof appointment.followUpProposalId === "string"
          ? db.collection("followUpProposals").doc(appointment.followUpProposalId)
          : null;
        const [patientSnapshot, walletSnapshot, walletLedgerSnapshot, feeLedgerSnapshot, slotSnapshot, proposalSnapshot] = await Promise.all([
          transaction.get(patientRef),
          transaction.get(walletRef),
          transaction.get(walletLedgerRef),
          transaction.get(feeLedgerRef),
          slotRef ? transaction.get(slotRef) : Promise.resolve(null),
          proposalRef ? transaction.get(proposalRef) : Promise.resolve(null),
        ]);
        if (!patientSnapshot.exists || patientSnapshot.get("role") !== "patient" || patientSnapshot.get("profileComplete") !== true ||
          !isPatientNumber(patientSnapshot.get("patientNumber"))) {
          throw new ApiError(403, "complete-patient-profile-required", "Terminez votre inscription patient avant de payer.");
        }
        if (!["teleconsultation", "doctor_proposed_appointment", "home_visit"].includes(String(appointment.bookingType || "")) ||
          appointment.patientUid !== user.uid || appointment.moncashPaymentRef !== paymentRef ||
          !appointmentPaymentMatches(appointment, payment) || String(appointment.currency || "").toUpperCase() !== "HTG" ||
          String(payment.currency || "").toUpperCase() !== "HTG") {
          throw new ApiError(409, "appointment-payment-invalid", "Le montant ou le propriétaire du rendez-vous ne correspond pas au paiement.");
        }

        if (payment.status === "paid" && payment.paymentMethod === "NEXA_WALLET") {
          const ledger = walletLedgerSnapshot.data() || {};
          if (appointment.paymentStatus !== "PAID" || !["CONFIRMED", "DOCTOR_ACCEPTED"].includes(String(appointment.status || "")) ||
            !walletLedgerSnapshot.exists || ledger.userUid !== user.uid || ledger.direction !== "DEBIT" || ledger.type !== "PAYMENT" ||
            Number(ledger.amountMinor) !== Number(payment.amount) * 100 || ledger.paymentRef !== paymentRef) {
            throw new ApiError(409, "wallet-payment-record-conflict", "Le règlement Wallet est enregistré de façon incohérente; contactez NEXA avant de réessayer.");
          }
          const homeVisitCode = appointment.bookingType === "home_visit" &&
            ["SCHEDULED", "AWAITING_PROVIDER_CODE"].includes(String(appointment.homeVisitMissionStatus || "")) &&
            typeof appointment.homeVisitMissionCode === "string" && /^\d{8}$/.test(appointment.homeVisitMissionCode)
            ? appointment.homeVisitMissionCode
            : "";
          return { appointmentId: appointmentRef.id, providerUid: appointment.providerUid, status: appointment.status, homeVisitCode, alreadyPaid: true };
        }

        if (payment.paymentMethod !== "MONCASH" || payment.status !== "created") {
          throw new ApiError(409, "payment-method-locked", "Un autre moyen de paiement est déjà en cours ou terminé pour ce rendez-vous. Vérifiez son état avant de réessayer.");
        }
        if (appointment.status !== "PENDING_PAYMENT" || appointment.paymentStatus !== "PENDING" ||
          !slotSnapshot?.exists || slotSnapshot.get("status") !== "held" || slotSnapshot.get("appointmentId") !== appointmentRef.id ||
          slotSnapshot.get("providerUid") !== appointment.providerUid || Number(slotSnapshot.get("holdExpiresAt")) <= Date.now()) {
          throw new ApiError(409, "appointment-hold-expired", "La réservation temporaire a expiré. Choisissez un nouveau créneau avant de payer.");
        }
        if (proposalRef && (!proposalSnapshot?.exists || proposalSnapshot.get("patientUid") !== user.uid ||
          proposalSnapshot.get("providerUid") !== appointment.providerUid || proposalSnapshot.get("slotId") !== appointment.slotId ||
          proposalSnapshot.get("pendingAppointmentId") !== appointmentRef.id || !["PENDING", "BOOKED"].includes(String(proposalSnapshot.get("status"))))) {
          throw new ApiError(409, "follow-up-proposal-unavailable", "La proposition de rendez-vous n’est plus disponible.");
        }
        if (walletLedgerSnapshot.exists || feeLedgerSnapshot.exists) {
          throw new ApiError(409, "wallet-payment-record-conflict", "Un mouvement financier existe déjà pour ce paiement. Contactez NEXA avant de réessayer.");
        }

        const totalAmount = Number(payment.amount);
        const serviceAmount = Number(appointment.amount);
        const transactionFee = Number(appointment.transactionFee || 0);
        const totalMinor = totalAmount * 100;
        const serviceMinor = serviceAmount * 100;
        const feeMinor = transactionFee * 100;
        if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0 || !Number.isSafeInteger(serviceMinor) || serviceMinor <= 0 ||
          !Number.isSafeInteger(feeMinor) || feeMinor < 0 || totalMinor !== serviceMinor + feeMinor) {
          throw new ApiError(409, "appointment-total-invalid", "Le total du rendez-vous ne peut pas être débité du portefeuille.");
        }
        const wallet = walletSnapshot.data() || {};
        const availableMinor = wallet.availableMinor === undefined ? 0 : Number(wallet.availableMinor);
        const reservedMinor = wallet.reservedMinor === undefined ? 0 : Number(wallet.reservedMinor);
        if (!Number.isSafeInteger(availableMinor) || availableMinor < 0 || !Number.isSafeInteger(reservedMinor) || reservedMinor < 0 ||
          (wallet.currency && wallet.currency !== "HTG") || (wallet.status && wallet.status !== "ACTIVE")) {
          throw new ApiError(409, "wallet-state-invalid", "Le portefeuille NEXA ne peut pas être utilisé actuellement.");
        }
        if (availableMinor < totalMinor) {
          throw new ApiError(409, "wallet-insufficient-funds", "Le solde Wallet est insuffisant pour le prix du service et les frais de transaction.");
        }

        const now = FieldValue.serverTimestamp();
        const isHomeVisit = appointment.bookingType === "home_visit";
        transaction.set(walletRef, {
          userUid: user.uid,
          currency: "HTG",
          availableMinor: availableMinor - totalMinor,
          reservedMinor,
          status: wallet.status || "ACTIVE",
          updatedAt: now,
        }, { merge: true });
        transaction.create(walletLedgerRef, {
          userUid: user.uid,
          walletId: user.uid,
          type: "PAYMENT",
          direction: "DEBIT",
          amountMinor: totalMinor,
          serviceAmountMinor: serviceMinor,
          transactionFeeMinor: feeMinor,
          currency: "HTG",
          resourceType: "appointment",
          resourceId: appointmentRef.id,
          paymentRef,
          source: "PATIENT_WALLET",
          status: "COMPLETED",
          createdAt: now,
        });
        if (feeMinor > 0) transaction.create(feeLedgerRef, {
          paymentRef,
          resourceType: "appointment",
          resourceId: appointmentRef.id,
          serviceAmountMinor: serviceMinor,
          amountMinor: feeMinor,
          currency: "HTG",
          recipient: "NEXARIS",
          transactionFeeRateBps: Number(appointment.transactionFeeRateBps) || 0,
          paymentMethod: "NEXA_WALLET",
          status: "COMPLETED",
          createdAt: now,
        });
        transaction.set(paymentRefDoc, {
          paymentMethod: "NEXA_WALLET",
          paymentProvider: "NEXA_WALLET",
          gateway: "nexa-wallet",
          status: "paid",
          paidAt: now,
          updatedAt: now,
        }, { merge: true });
        transaction.set(appointmentRef, {
          paymentMethod: "NEXA_WALLET",
          paymentStatus: "PAID",
          status: appointment.bookingType === "doctor_proposed_appointment" ? "DOCTOR_ACCEPTED" : "CONFIRMED",
          sessionStatus: isHomeVisit ? null : "SCHEDULED",
          ...(isHomeVisit ? {
            homeVisitMissionStatus: "SCHEDULED",
            homeVisitMissionCode: homeVisitCode,
            homeVisitMissionCodeHash: homeVisitMissionCodeHash(appointmentRef.id, homeVisitCode),
            homeVisitMissionCodeIssuedAt: now,
          } : {}),
          refundRequired: false,
          paidAt: now,
          updatedAt: now,
        }, { merge: true });
        transaction.set(slotRef, { status: "booked", holdExpiresAt: FieldValue.delete(), updatedAt: now }, { merge: true });
        if (proposalRef) transaction.set(proposalRef, {
          status: "BOOKED",
          bookedAppointmentId: appointmentRef.id,
          paidAt: now,
          updatedAt: now,
        }, { merge: true });
        return {
          appointmentId: appointmentRef.id,
          providerUid: appointment.providerUid,
          status: appointment.bookingType === "doctor_proposed_appointment" ? "DOCTOR_ACCEPTED" : "CONFIRMED",
          homeVisitCode: isHomeVisit ? homeVisitCode : "",
          alreadyPaid: false,
        };
      });

      if (!outcome.alreadyPaid) {
        const notices = [createNexaNotification(user.uid, "appointment:payment:" + paymentRef, {
          type: "appointment_payment_confirmed",
          title: "Paiement Wallet confirmé",
          body: "Votre paiement par Wallet NEXA est confirmé. Consultez votre espace patient pour suivre le rendez-vous.",
          url: "/espace-patient.html",
        }, outcome.appointmentId)];
        if (outcome.providerUid) notices.push(createNexaNotification(outcome.providerUid, "appointment:payment:" + paymentRef, {
          type: "appointment_payment_confirmed",
          title: "Nouveau rendez-vous payé",
          body: "Un patient a réservé et payé un créneau. Consultez votre espace professionnel.",
          url: "/espace-professionnel.html",
        }, outcome.appointmentId));
        await Promise.all(notices.map((promise) => promise.catch((error) => {
          logger.warn("NEXA Wallet payment notification could not be written", { errorName: error instanceof Error ? error.name : "unknown-error" });
        })));
      }
      if (outcome.homeVisitCode) await sendHomeVisitMissionCodeEmail(user.uid, outcome.appointmentId, paymentRef, outcome.homeVisitCode);
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, appointmentId: outcome.appointmentId, status: "paid", appointmentStatus: outcome.status, alreadyPaid: outcome.alreadyPaid });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA Wallet appointment payment failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "wallet-payment-failed", "Le paiement Wallet n’a pas pu être confirmé. Vérifiez votre portefeuille et le rendez-vous avant de réessayer.");
    }
  },
);

const MEDICAL_PROFILE_LANGUAGES = new Set(["creole", "french", "english", "spanish"]);
const MEDICAL_PROFILE_FIELDS = new Set([
  "languages",
  "allergies",
  "diabetes",
  "hypertension",
  "tobacco",
  "alcohol",
  "coffee",
  "tea",
]);

function medicalProfileText(value, maximum, required) {
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid-medical-profile", "Vérifiez les informations de santé saisies.");
  }
  const normalized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();
  if (normalized.length > maximum || (required && !normalized)) {
    throw new ApiError(400, "invalid-medical-profile", "Vérifiez les informations de santé saisies.");
  }
  return normalized;
}

function parseMedicalYesNo(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid-medical-profile", "Une réponse de la fiche médicale est invalide.");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !["yes", "details"].includes(key)) || typeof value.yes !== "boolean") {
    throw new ApiError(400, "invalid-medical-profile", "Une réponse de la fiche médicale est invalide.");
  }
  const details = medicalProfileText(value.details === undefined ? "" : value.details, 500, value.yes);
  if (!value.yes && details) {
    throw new ApiError(400, "invalid-medical-profile", "Retirez les détails si la réponse est non.");
  }
  return { yes: value.yes, details };
}

function parseMedicalCondition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid-medical-profile", "Une réponse de la fiche médicale est invalide.");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !["diagnosed", "sinceMonth"].includes(key)) || typeof value.diagnosed !== "boolean") {
    throw new ApiError(400, "invalid-medical-profile", "Une réponse de la fiche médicale est invalide.");
  }
  const sinceMonth = medicalProfileText(value.sinceMonth === undefined ? "" : value.sinceMonth, 7, value.diagnosed);
  if (value.diagnosed && !/^\d{4}-(0[1-9]|1[0-2])$/.test(sinceMonth)) {
    throw new ApiError(400, "invalid-medical-profile", "Indiquez le mois et l’année du diagnostic.");
  }
  if (!value.diagnosed && sinceMonth) {
    throw new ApiError(400, "invalid-medical-profile", "Retirez la date si la réponse est non.");
  }
  return { diagnosed: value.diagnosed, sinceMonth };
}

function parseMedicalProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid-medical-profile", "La fiche médicale n’est pas valide.");
  }
  if (Object.keys(value).some((key) => !MEDICAL_PROFILE_FIELDS.has(key))) {
    throw new ApiError(400, "invalid-medical-profile", "La fiche contient des champs inattendus.");
  }
  if (
    !Array.isArray(value.languages) ||
    value.languages.length < 1 ||
    value.languages.length > MEDICAL_PROFILE_LANGUAGES.size ||
    value.languages.some((language) => typeof language !== "string" || !MEDICAL_PROFILE_LANGUAGES.has(language)) ||
    new Set(value.languages).size !== value.languages.length
  ) {
    throw new ApiError(400, "invalid-medical-profile", "Choisissez au moins une langue préférée parmi les langues proposées.");
  }

  return {
    languages: [...value.languages],
    allergies: parseMedicalYesNo(value.allergies, "les allergies"),
    diabetes: parseMedicalCondition(value.diabetes),
    hypertension: parseMedicalCondition(value.hypertension),
    tobacco: parseMedicalYesNo(value.tobacco, "le tabac"),
    alcohol: parseMedicalYesNo(value.alcohol, "l’alcool"),
    coffee: parseMedicalYesNo(value.coffee, "le café"),
    tea: parseMedicalYesNo(value.tea, "le thé"),
  };
}

async function enforceUserRateLimit(uid, action, limit, windowMs) {
  const key = createHash("sha256").update(uid + ":" + action).digest("hex");
  const reference = db.collection("nexaApiRateLimits").doc(key);
  const now = Date.now();
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    let windowStartMs = snapshot.exists ? snapshot.get("windowStartMs") : now;
    let count = snapshot.exists ? snapshot.get("count") : 0;
    if (!Number.isSafeInteger(windowStartMs) || !Number.isSafeInteger(count) || now - windowStartMs >= windowMs || now < windowStartMs) {
      windowStartMs = now;
      count = 0;
    }
    if (count >= limit) {
      throw new ApiError(429, "rate-limit-exceeded", "Trop de demandes. Réessayez plus tard.");
    }
    transaction.set(reference, {
      windowStartMs,
      count: count + 1,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

function publicMedicalProfile(data) {
  if (!data || typeof data !== "object") return null;
  const timestamp = data.updatedAt;
  return {
    languages: Array.isArray(data.languages) ? data.languages.filter((language) => MEDICAL_PROFILE_LANGUAGES.has(language)) : [],
    allergies: data.allergies && typeof data.allergies === "object" ? { yes: data.allergies.yes === true, details: cleanPublicText(data.allergies.details, 500) } : null,
    diabetes: data.diabetes && typeof data.diabetes === "object" ? { diagnosed: data.diabetes.diagnosed === true, sinceMonth: cleanPublicText(data.diabetes.sinceMonth, 7) } : null,
    hypertension: data.hypertension && typeof data.hypertension === "object" ? { diagnosed: data.hypertension.diagnosed === true, sinceMonth: cleanPublicText(data.hypertension.sinceMonth, 7) } : null,
    tobacco: data.tobacco && typeof data.tobacco === "object" ? { yes: data.tobacco.yes === true, details: cleanPublicText(data.tobacco.details, 500) } : null,
    alcohol: data.alcohol && typeof data.alcohol === "object" ? { yes: data.alcohol.yes === true, details: cleanPublicText(data.alcohol.details, 500) } : null,
    coffee: data.coffee && typeof data.coffee === "object" ? { yes: data.coffee.yes === true, details: cleanPublicText(data.coffee.details, 500) } : null,
    tea: data.tea && typeof data.tea === "object" ? { yes: data.tea.yes === true, details: cleanPublicText(data.tea.details, 500) } : null,
    updatedAt: timestamp && typeof timestamp.toDate === "function" ? timestamp.toDate().toISOString() : null,
  };
}

function clinicalTimestamp(value) {
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

function consultationClinicalAccessWindow(appointment, nowMs = Date.now()) {
  if (appointment.paymentStatus !== "PAID") return null;
  const status = String(appointment.status || "").toUpperCase();
  const completedHomeVisit = appointment.bookingType === "home_visit" &&
    appointment.homeVisitMissionStatus === "COMPLETED" && status === "COMPLETED";
  const startedHomeVisit = appointment.bookingType === "home_visit" &&
    ["CONFIRMED", "COMPLETED"].includes(status) && clinicalTimestamp(appointment.effectiveConsultationStartedAt) > 0;
  const startedAtMs = startedHomeVisit
    ? clinicalTimestamp(appointment.effectiveConsultationStartedAt)
    : completedHomeVisit
      ? clinicalTimestamp(appointment.homeVisitMissionClosedAt)
    : ["IN_PROGRESS", "COMPLETED"].includes(status)
      ? clinicalTimestamp(appointment.effectiveConsultationStartedAt)
      : Number.NaN;
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;
  const expiresAtMs = startedAtMs + CONSULTATION_CLINICAL_ACCESS_DURATION_MS;
  if (nowMs < startedAtMs || nowMs >= expiresAtMs) return null;
  return { startedAtMs, expiresAtMs };
}

exports.doctorPatientMedicalProfile = onRequest(
  { region: FUNCTION_REGION },
  async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") {
      res.set("Allow", "GET, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "doctor-medical-profile-read", 20, 5 * 60_000);
      const appointmentId = typeof req.query.appointmentId === "string" ? req.query.appointmentId : "";
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) {
        throw new ApiError(400, "invalid-appointment", "La référence de consultation n’est pas valide.");
      }

      const appointmentRef = db.collection("appointments").doc(appointmentId);
      const providerRef = db.collection("providerProfiles").doc(user.uid);
      const auditRef = db.collection("clinicalAuditLogs").doc();
      const result = await db.runTransaction(async (transaction) => {
        const appointmentSnapshot = await transaction.get(appointmentRef);
        if (!appointmentSnapshot.exists || appointmentSnapshot.get("providerUid") !== user.uid || appointmentSnapshot.get("providerType") !== "doctor") {
          throw new ApiError(404, "appointment-not-found", "Cette consultation n’est pas accessible.");
        }
        const appointment = appointmentSnapshot.data() || {};
        const patientUid = typeof appointment.patientUid === "string" ? appointment.patientUid : "";
        if (!patientUid) throw new ApiError(404, "patient-not-found", "Le patient de cette consultation n’est pas disponible.");

        const patientRef = db.collection("patientProfiles").doc(patientUid);
        const medicalRef = db.collection("patientMedicalProfiles").doc(patientUid);
        const [providerSnapshot, patientSnapshot, medicalSnapshot] = await Promise.all([
          transaction.get(providerRef),
          transaction.get(patientRef),
          transaction.get(medicalRef),
        ]);
        if (!providerSnapshot.exists || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("clinicalCredentialsVerified") !== true) {
          throw new ApiError(403, "verified-doctor-required", "Cette fiche est réservée au médecin NEXA vérifié associé à la consultation.");
        }
        if (!patientSnapshot.exists || patientSnapshot.get("role") !== "patient" || !isPatientNumber(patientSnapshot.get("patientNumber"))) {
          throw new ApiError(404, "patient-not-found", "Le profil patient associé à cette consultation n’est pas disponible.");
        }
        const accessWindow = consultationClinicalAccessWindow(appointment);
        if (!accessWindow) {
          throw new ApiError(403, "clinical-access-expired", "L’autorisation d’accès clinique n’est pas active ou a expiré.");
        }
        if (medicalSnapshot.exists && medicalSnapshot.get("patientUid") !== patientUid) {
          throw new ApiError(503, "medical-profile-integrity", "La fiche médicale n’est pas accessible pour le moment.");
        }

        const providerProfile = providerSnapshot.get("profile");
        const profile = providerProfile && typeof providerProfile === "object" && !Array.isArray(providerProfile)
          ? providerProfile
          : {};
        transaction.create(auditRef, {
          actorUid: user.uid,
          action: "doctor_patient_medical_profile_accessed",
          appointmentId,
          createdAt: FieldValue.serverTimestamp(),
        });
        return {
          accessWindow,
          identity: {
            firstName: typeof patientSnapshot.get("firstName") === "string" ? patientSnapshot.get("firstName") : "",
            lastName: typeof patientSnapshot.get("lastName") === "string" ? patientSnapshot.get("lastName") : "",
            birthDate: typeof patientSnapshot.get("birthDate") === "string" ? patientSnapshot.get("birthDate") : "",
            sex: typeof patientSnapshot.get("sex") === "string" ? patientSnapshot.get("sex") : "",
          },
          provider: {
            name: cleanPublicText(profile.name, 180) || "Médecin NEXA",
            specialty: cleanPublicText(profile.specialty, 160),
          },
          medicalProfile: medicalSnapshot.exists ? publicMedicalProfile(medicalSnapshot.data()) : null,
        };
      });

      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({
        ok: true,
        view: "provider",
        clinicalAccessExpiresAt: new Date(result.accessWindow.expiresAtMs).toISOString(),
        patientIdentity: result.identity,
        patientMedicalProfile: result.medicalProfile,
        provider: result.provider,
      });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("Doctor patient medical profile request failed", {
        errorName: error instanceof Error ? error.name : "unknown-error",
      });
      return fail(res, 500, "patient-medical-profile-unavailable", "La fiche médicale n’est pas accessible pour le moment.");
    }
  },
);

exports.patientMedicalProfile = onRequest(
  { region: FUNCTION_REGION },
  async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "PUT"].includes(req.method)) {
      res.set("Allow", "GET, PUT, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if ((Number(req.get("Content-Length")) || 0) > 16_384) {
      return fail(res, 413, "request-too-large", "La requête est trop volumineuse.");
    }
    if (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 16_384) {
      return fail(res, 413, "request-too-large", "La requête est trop volumineuse.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(
        user.uid,
        req.method === "GET" ? "patient-medical-profile-read" : "patient-medical-profile-write",
        req.method === "GET" ? 20 : 10,
        5 * 60_000,
      );

      const patientRef = db.collection("patientProfiles").doc(user.uid);
      const profileRef = db.collection("patientMedicalProfiles").doc(user.uid);
      if (req.method === "GET") {
        const [patient, profile] = await Promise.all([patientRef.get(), profileRef.get()]);
        if (!patient.exists || patient.get("role") !== "patient") {
          throw new ApiError(403, "patient-profile-required", "Accès patient NEXA requis.");
        }
        res.set("Cache-Control", "no-store, max-age=0");
        return res.status(200).json({
          ok: true,
          profileWritesEnabled: MEDICAL_PROFILE_WRITES_ENABLED,
          profile: profile.exists ? publicMedicalProfile(profile.data()) : null,
          identity: {
            firstName: typeof patient.get("firstName") === "string" ? patient.get("firstName") : "",
            lastName: typeof patient.get("lastName") === "string" ? patient.get("lastName") : "",
            birthDate: typeof patient.get("birthDate") === "string" ? patient.get("birthDate") : "",
            sex: typeof patient.get("sex") === "string" ? patient.get("sex") : "",
          },
        });
      }

      if (!MEDICAL_PROFILE_WRITES_ENABLED) {
        throw new ApiError(503, "medical-profile-writes-disabled", "La création et la modification de cette fiche sont désactivées jusqu’à l’approbation des documents de confidentialité et du consentement.");
      }

      const body = parseRequestBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "profile")) {
        throw new ApiError(400, "invalid-medical-profile", "La fiche médicale n’est pas valide.");
      }
      const profile = parseMedicalProfile(body.profile);
      const auditRef = db.collection("clinicalAuditLogs").doc();
      await db.runTransaction(async (transaction) => {
        const patient = await transaction.get(patientRef);
        const existing = await transaction.get(profileRef);
        if (!patient.exists || patient.get("role") !== "patient") {
          throw new ApiError(403, "patient-profile-required", "Accès patient NEXA requis.");
        }
        transaction.set(profileRef, {
          ...profile,
          patientUid: user.uid,
          createdAt: existing.get("createdAt") || FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.create(auditRef, {
          actorUid: user.uid,
          action: "patient_medical_profile_updated",
          createdAt: FieldValue.serverTimestamp(),
        });
      });
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, saved: true });
    } catch (error) {
      if (error instanceof ApiError) {
        return fail(res, error.status, error.code, error.message);
      }
      logger.error("Patient medical profile request failed", {
        errorName: error instanceof Error ? error.name : "unknown-error",
      });
      return fail(res, 500, "patient-medical-profile-unavailable", "La fiche médicale n’est pas accessible pour le moment.");
    }
  },
);

// The dashboard is a separate static GitHub Pages app. Privileged work remains
// behind NEXA Cloud Functions and the server-side UID allowlist.
Object.assign(exports, createNexaAdminFunctions({
  db,
  FieldValue,
  storage,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  createNexaNotification,
  appointmentPaymentMatches,
  getTransactionFeePolicy,
}));

Object.assign(exports, createNexaPartnerFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
}));

Object.assign(exports, createNexaAdminPharmacyFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  createNexaNotification,
  appointmentPaymentMatches,
}));

Object.assign(exports, createNexaAdminDiagnosticResultFunctions({
  db,
  FieldValue,
  storage,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  createNexaNotification,
}));

Object.assign(exports, createNexaAdminDiagnosticOrderFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
}));

Object.assign(exports, createNexaAdminDiagnosticOfferFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  createNexaNotification,
}));

Object.assign(exports, createNexaAdminDiagnosticPartnerReportFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
}));

Object.assign(exports, createNexaAdminDiagnosticCenterFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
}));

Object.assign(exports, createNexaLabSupportFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  createNexaNotification,
}));

Object.assign(exports, createNexaAdminContractFunctions({
  db,
  FieldValue,
  storage,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
}));

const nursingFunctions = createNexaNursingFunctions({
  db,
  FieldValue,
  storage,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  getTransactionFeePolicy,
  calculateTransactionAmounts,
  createNexaNotification,
});
Object.assign(exports, {
  nexaNursingOrderCreate: nursingFunctions.nexaNursingOrderCreate,
  nexaNursingOrderWalletPay: nursingFunctions.nexaNursingOrderWalletPay,
  nexaNursingProviderOrders: nursingFunctions.nexaNursingProviderOrders,
  nexaNursingPublicCatalog: nursingFunctions.nexaNursingPublicCatalog,
  nexaNursingServiceProfile: nursingFunctions.nexaNursingServiceProfile,
  nexaNursingApplication: nursingFunctions.nexaNursingApplication,
});
exports.nexaNursingProfilePhoto = createNexaNursingProfilePhotoFunction({
  db,
  FieldValue,
  storage,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
});
exports.nexaDoctorProfilePhoto = createNexaNursingProfilePhotoFunction({
  db,
  FieldValue,
  storage,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
}, {
  providerType: "doctor",
  credentialField: "clinicalCredentialsVerified",
  pathPrefix: "nexa-doctor-profile-photos",
  photoPathField: "profilePhotoPath",
  photoStatusField: "profilePhotoStatus",
  photoConsentVersionField: "profilePhotoConsentVersion",
  photoConsentedAtField: "profilePhotoConsentedAt",
  consentVersion: "nexa-doctor-photo-v1",
});
settlePaidNursingOrderPayment = nursingFunctions.settlePaidNursingOrderPayment;

Object.assign(exports, createNexaNursingVisitFunctions({
  db,
  FieldValue,
  storage,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  createNexaNotification,
  sendNursingVisitCodeEmail,
}));

Object.assign(exports, createNexaNotificationFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  adminAuth: auth,
  messaging,
  RESEND_API_KEY,
}));

Object.assign(exports, createNexaProviderFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  createNexaNotification,
  appointmentPaymentMatches,
}));

Object.assign(exports, createNexaClinicalFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  createNexaNotification,
}));

Object.assign(exports, createNexaClinicalAccessFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
}));

Object.assign(exports, createNexaStandaloneRecordFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  createNexaNotification,
}));

Object.assign(exports, createNexaPatientClinicalRecordFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
}));

Object.assign(exports, createNexaClinicalAttachmentFunctions({
  db,
  FieldValue,
  storage,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
}));

Object.assign(exports, createNexaPrescriptionFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  createNexaNotification,
}));

Object.assign(exports, createNexaPrescriptionAvailabilityFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
}));

Object.assign(exports, createNexaPrescriptionPdfFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
}));

Object.assign(exports, createNexaPatientResultFunctions({
  db,
  FieldValue,
  storage,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  createNexaNotification,
}));

Object.assign(exports, createNexaDiagnosticProviderFunctions({
  db,
  FieldValue,
  storage,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  createNexaNotification,
}));

Object.assign(exports, createNexaDiagnosticCatalogFunctions({
  db,
  requireAppCheckToken,
  setCors,
  fail,
  logger,
}));

const diagnosticCommerceFunctions = createNexaDiagnosticCommerceFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  getTransactionFeePolicy,
  calculateTransactionAmounts,
  createNexaNotification,
});
settlePaidDiagnosticOrderPayment = diagnosticCommerceFunctions.settlePaidDiagnosticOrderPayment;
Object.assign(exports, {
  nexaDiagnosticOrderCreate: diagnosticCommerceFunctions.nexaDiagnosticOrderCreate,
  nexaPatientOrders: diagnosticCommerceFunctions.nexaPatientOrders,
  nexaDiagnosticOrderWalletPay: diagnosticCommerceFunctions.nexaDiagnosticOrderWalletPay,
  nexaPatientRequestDiagnosticCashRefund: diagnosticCommerceFunctions.nexaPatientRequestDiagnosticCashRefund,
});

const pharmacyCommerceFunctions = createNexaPharmacyCommerceFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  getTransactionFeePolicy,
  calculateTransactionAmounts,
  createNexaNotification,
});
settlePaidPharmacyOrderPayment = pharmacyCommerceFunctions.settlePaidPharmacyOrderPayment;
Object.assign(exports, {
  nexaPharmacyPublicProducts: pharmacyCommerceFunctions.nexaPharmacyPublicProducts,
  nexaPharmacyProviderProducts: pharmacyCommerceFunctions.nexaPharmacyProviderProducts,
  nexaPharmacyProviderLotReceive: pharmacyCommerceFunctions.nexaPharmacyProviderLotReceive,
  nexaPharmacyOrderCreate: pharmacyCommerceFunctions.nexaPharmacyOrderCreate,
  nexaPharmacyOrderWalletPay: pharmacyCommerceFunctions.nexaPharmacyOrderWalletPay,
  nexaPharmacyProviderOrders: pharmacyCommerceFunctions.nexaPharmacyProviderOrders,
  nexaExpirePharmacyOrderHolds: pharmacyCommerceFunctions.nexaExpirePharmacyOrderHolds,
});

Object.assign(exports, createNexaTeleconsultationFunctions({
  db,
  FieldValue,
  appointmentPaymentMatches,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  createNexaNotification,
}));

Object.assign(exports, createNexaSessionMessageFunctions({
  db,
  FieldValue,
  storage,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  createNexaNotification,
}));

Object.assign(exports, createNexaHomeVisitFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
  createNexaNotification,
  appointmentPaymentMatches,
}));

Object.assign(exports, createNexaProfessionalFunctions({
  db,
  FieldValue,
  ApiError,
  requireUser,
  requireAppCheckToken,
  enforceUserRateLimit,
  setCors,
  fail,
  logger,
}));
