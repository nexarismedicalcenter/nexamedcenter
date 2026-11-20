"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { Timestamp } = require("firebase-admin/firestore");

const REGION = "us-east4";
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 20;
const ACCEPTED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
const ACTIVE_SESSION_STATES = ["OPEN", "SCANNING"];
const CLEANUP_SESSION_STATES = ["OPEN", "SCANNING", "FAILED", "CANCELLED", "SCAN_FAILED", "REJECTED", "EXPIRED"];
const FILE_CATEGORY = { laboratory: "LAB_RESULT", imaging: "IMAGING" };

function cleanText(value, maximum = 180) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

function validId(value, minimum = 10, maximum = 200) {
  return typeof value === "string" && new RegExp("^[A-Za-z0-9_-]{" + minimum + "," + maximum + "}$").test(value);
}

function claimId(prescriptionId, examType, examIndex) {
  return createHash("sha256").update(prescriptionId + ":" + examType + ":" + examIndex).digest("hex");
}

function readExam(prescription, examType, examIndex, ApiError) {
  if (!Number.isSafeInteger(examIndex) || examIndex < 0 || examIndex > 49) {
    throw new ApiError(400, "invalid-prescribed-exam", "L’examen prescrit sélectionné n’est pas valide.");
  }
  const values = prescription[examType === "laboratory" ? "labExams" : "imagingExams"];
  const name = Array.isArray(values) ? cleanText(values[examIndex], 250) : "";
  if (!name) throw new ApiError(404, "prescribed-exam-not-found", "Cet examen ne fait pas partie d’une ordonnance active.");
  return name;
}

function validateFiles(value, examType, ApiError) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FILES) {
    throw new ApiError(400, "invalid-result-files", "Sélectionnez de 1 à 20 fichiers pour le résultat.");
  }
  const requiredCategory = FILE_CATEGORY[examType];
  let hasRequired = false;
  const files = value.map((entry) => {
    const item = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
    const contentType = cleanText(item.contentType, 100).toLowerCase();
    const size = Number(item.size);
    const category = cleanText(item.category, 40);
    const fileName = cleanText(item.fileName, 180).replace(/[\\/\r\n"]/g, "_");
    if (!ACCEPTED_TYPES.has(contentType) || !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES ||
      (category !== requiredCategory && category !== "SUPPLEMENTAL") || !fileName) {
      throw new ApiError(400, "invalid-result-file", "Chaque fichier doit être un PDF, JPG ou PNG de 15 Mio maximum.");
    }
    if (category === requiredCategory) hasRequired = true;
    return { category, fileName, contentType, size };
  });
  if (!hasRequired) throw new ApiError(400, "result-file-required", "Ajoutez au moins un fichier principal pour cet examen.");
  return files;
}

function millis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return Number.NaN;
}

function patientAge(birthDate, now = new Date()) {
  const value = cleanText(birthDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(value + "T12:00:00.000Z");
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Port-au-Prince", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  let age = Number(parts.year) - Number(value.slice(0, 4));
  if (Number(parts.month) < Number(value.slice(5, 7)) ||
    (Number(parts.month) === Number(value.slice(5, 7)) && Number(parts.day) < Number(value.slice(8, 10)))) age -= 1;
  return age >= 0 && age <= 130 ? age : null;
}

function isoDate(value) {
  return value && typeof value.toDate === "function" ? value.toDate().toISOString() : null;
}

function assertDoctor(profile, ApiError) {
  if (!profile.exists || profile.get("type") !== "doctor" || profile.get("status") !== "verified" ||
    profile.get("clinicalCredentialsVerified") !== true) {
    throw new ApiError(403, "verified-doctor-required", "Cette action est réservée au médecin NEXA vérifié.");
  }
}

async function getScannerToken(audience, localScanner, ApiError) {
  if (localScanner) return "";
  const identityUrl = new URL("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity");
  identityUrl.searchParams.set("audience", audience);
  identityUrl.searchParams.set("format", "full");
  let response;
  try {
    response = await fetch(identityUrl, {
      headers: { "Metadata-Flavor": "Google" },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new ApiError(503, "scanner-identity-unavailable", "L’analyse de sécurité n’est pas configurée. Aucun résultat n’a été transmis.");
  }
  if (!response.ok) throw new ApiError(503, "scanner-identity-unavailable", "L’analyse de sécurité n’est pas configurée. Aucun résultat n’a été transmis.");
  const token = (await response.text()).trim();
  if (!token || token.length > 20_000) throw new ApiError(503, "scanner-identity-unavailable", "L’analyse de sécurité n’est pas configurée. Aucun résultat n’a été transmis.");
  return token;
}

async function scanFile(fileBuffer, contentType, ApiError) {
  const configuredUrl = process.env.NEXA_MALWARE_SCANNER_URL || "";
  const configuredAudience = process.env.NEXA_MALWARE_SCANNER_AUDIENCE || "";
  let target;
  try { target = new URL(configuredUrl); } catch {
    throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité est temporairement indisponible. Réessayez plus tard.");
  }
  const localScanner = process.env.NODE_ENV !== "production" && target.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if ((target.protocol !== "https:" && !localScanner) || target.username || target.password || target.search ||
    target.hash || !["", "/"].includes(target.pathname)) {
    throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité est temporairement indisponible. Réessayez plus tard.");
  }
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length < 1 || fileBuffer.length > MAX_FILE_BYTES || !ACCEPTED_TYPES.has(contentType)) {
    throw new ApiError(400, "invalid-result-file", "Le fichier ne respecte pas les limites de sécurité NEXA.");
  }
  let audience = "";
  if (!localScanner) {
    let parsed;
    try { parsed = new URL(configuredAudience); } catch { /* fail closed below */ }
    if (!parsed || parsed.origin !== target.origin || !["", "/"].includes(parsed.pathname) || parsed.search ||
      parsed.hash || parsed.username || parsed.password) {
      throw new ApiError(503, "scanner-audience-not-configured", "L’identité de l’analyse de sécurité n’est pas configurée.");
    }
    audience = configuredAudience;
  }
  const token = await getScannerToken(audience, localScanner, ApiError);
  let response;
  try {
    response = await fetch(new URL("/scan", target.origin), {
      method: "POST",
      headers: { "Content-Type": contentType, ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: new Blob([new Uint8Array(fileBuffer)], { type: contentType }),
      cache: "no-store",
      signal: AbortSignal.timeout(40_000),
    });
  } catch {
    throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité est temporairement indisponible. Aucun résultat n’a été transmis.");
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 415 || response.status === 413) throw new ApiError(400, "invalid-result-file", "Le fichier ne correspond pas à son type ou dépasse la taille permise.");
    throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité est temporairement indisponible. Aucun résultat n’a été transmis.");
  }
  if (result.status === "INFECTED") throw new ApiError(422, "malware-detected", "Un fichier a été bloqué par l’analyse antivirus. Vérifiez-le puis recommencez le dépôt.");
  if (result.status !== "CLEAN") throw new ApiError(503, "malware-scanner-invalid-response", "L’analyse de sécurité n’a pas confirmé que le fichier est propre.");
  return { scannerVersion: typeof result.scannerVersion === "string" ? result.scannerVersion.slice(0, 80) : null };
}

module.exports = function createNexaPatientResultFunctions(dependencies) {
  const {
    db, FieldValue, storage, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit,
    setCors, fail, logger, createNexaNotification,
  } = dependencies;

  const bucket = storage.bucket(process.env.NEXA_STORAGE_BUCKET || "nexaris-1339d.firebasestorage.app");

  function withCors(req, res) {
    if (!setCors(req, res)) {
      fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
      return false;
    }
    if (req.method === "OPTIONS") { res.status(204).end(); return false; }
    return true;
  }

  function parseBody(req, ApiError, maximum = 32_768) {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}), "utf8");
    if (raw.byteLength > maximum) throw new ApiError(413, "request-too-large", "La demande de dépôt est trop volumineuse.");
    try { return JSON.parse(raw.toString("utf8")); } catch {
      throw new ApiError(400, "invalid-request", "La demande de dépôt n’est pas valide.");
    }
  }

  async function requirePatient(uid, ApiError) {
    const profile = await db.collection("patientProfiles").doc(uid).get();
    if (!profile.exists || profile.get("role") !== "patient" || profile.get("profileComplete") !== true) {
      throw new ApiError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
    }
    return profile;
  }

  const nexaPatientDiagnosticResults = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!withCors(req, res)) return;
    if (req.method !== "GET") { res.set("Allow", "GET, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "patient-diagnostic-results-read", 40, 60_000);
      await requirePatient(user.uid, ApiError);
      const [submitted, prescriptions, claims, partnerResultsSnapshot] = await Promise.all([
        db.collection("patientSubmittedResults").where("patientUid", "==", user.uid).limit(100).get(),
        db.collection("clinicalPrescriptions").where("patientUid", "==", user.uid).limit(100).get(),
        db.collection("patientResultClaims").where("patientUid", "==", user.uid).limit(500).get(),
        db.collection("diagnosticResults").where("patientUid", "==", user.uid).orderBy("createdAt", "desc").limit(100).get(),
      ]);
      const claimMap = new Map(claims.docs.map((doc) => [doc.id, doc.data()]));
      const results = await Promise.all(submitted.docs.map(async (doc) => {
        const data = doc.data();
        const files = Array.isArray(data.files) ? data.files.filter((file) => file && file.antivirusStatus === "CLEAN").map((file) => ({
          id: cleanText(file.id, 100), category: cleanText(file.category, 40), fileName: cleanText(file.fileName, 180),
          contentType: cleanText(file.contentType, 100), size: Number(file.size) || 0,
        })) : [];
        const actions = await doc.ref.collection("followUpActions").orderBy("createdAt", "desc").limit(20).get();
        const followUpActions = await Promise.all(actions.docs.map(async (actionDoc) => {
          const action = actionDoc.data();
          const proposalId = cleanText(action.proposalId, 32);
          let proposalStatus = "";
          if (action.type === "APPOINTMENT" && /^[a-f0-9]{32}$/.test(proposalId)) {
            const proposal = await db.collection("followUpProposals").doc(proposalId).get();
            if (proposal.exists && proposal.get("patientUid") === user.uid && proposal.get("sourceResultId") === doc.id) {
              proposalStatus = cleanText(proposal.get("status"), 30);
            }
          }
          return {
            id: actionDoc.id, type: cleanText(action.type, 30),
            content: action.type === "NOTE" ? cleanText(action.content, 5_000) : "",
            providerName: cleanText(action.providerName, 180),
            recordNumber: cleanText(action.recordNumber, 100),
            startsAt: typeof action.startsAt === "string" && Number.isFinite(Date.parse(action.startsAt))
              ? new Date(action.startsAt).toISOString() : isoDate(action.startsAt),
            createdAt: isoDate(action.createdAt),
            ...(validId(cleanText(action.providerUid, 128), 1, 128) ? { providerUid: cleanText(action.providerUid, 128) } : {}),
            ...(validId(proposalId, 32, 32) ? { proposalId } : {}),
            ...(validId(cleanText(action.slotId, 32), 32, 32) ? { slotId: cleanText(action.slotId, 32) } : {}),
            ...(proposalStatus ? { proposalStatus } : {}),
          };
        }));
        return {
          id: doc.id,
          source: "PATIENT_UPLOAD",
          examName: cleanText(data.examName, 250) || "Résultat médical",
          providerName: "Transmis au médecin prescripteur",
          followUpStatus: cleanText(data.followUpStatus, 40) || cleanText(data.status, 40),
          reviewedAt: isoDate(data.reviewedAt),
          transferredAt: isoDate(data.createdAt),
          files,
          followUpActions,
        };
      }));
      const partnerResults = partnerResultsSnapshot.docs.flatMap((doc) => {
        const data = doc.data() || {};
        if (data.status !== "RESULT_AVAILABLE" || !data.patientTransferredAt) return [];
        const orderId = cleanText(data.orderId, 200);
        if (!validId(orderId)) return [];
        const files = Array.isArray(data.files) ? data.files.filter((file) => file && file.antivirusStatus === "CLEAN" &&
          validId(file.id, 10, 100) && String(file.storagePath || "").startsWith("nexa-diagnostic-results/" + orderId + "/" + doc.id + "/"))
          .map((file) => ({ id: cleanText(file.id, 100), category: cleanText(file.category, 40),
            fileName: cleanText(file.fileName, 180), contentType: cleanText(file.contentType, 100), size: Number(file.size) || 0 })) : [];
        if (!files.length) return [];
        return [{ id: doc.id, source: "DIAGNOSTIC_CENTER", examName: cleanText(data.examName, 250) || "Résultat médical",
          providerName: cleanText(data.providerName, 180) || "Centre partenaire NEXA", followUpStatus: "RESULT_AVAILABLE",
          transferredAt: isoDate(data.patientTransferredAt), files, followUpActions: [] }];
      });
      await db.collection("diagnosticResultAuditLogs").doc().create({
        actorUid: user.uid, action: "patient_diagnostic_results_listed",
        resultCount: partnerResults.length, createdAt: FieldValue.serverTimestamp(),
      });
      const uploadableExams = [];
      for (const doc of prescriptions.docs) {
        const prescription = doc.data();
        if (prescription.status !== "VALIDATED") continue;
        for (const [examType, field] of [["laboratory", "labExams"], ["imaging", "imagingExams"]]) {
          const exams = Array.isArray(prescription[field]) ? prescription[field] : [];
          for (let examIndex = 0; examIndex < Math.min(exams.length, 50); examIndex += 1) {
            const claim = claimMap.get(claimId(doc.id, examType, examIndex));
            const expiresAt = millis(claim && claim.expiresAt);
            if (claim && claim.status !== "AVAILABLE" &&
              !(["OPEN", "SCANNING"].includes(claim.status) && expiresAt <= Date.now())) continue;
            uploadableExams.push({
              prescriptionId: doc.id,
              examType,
              examIndex,
              examName: readExam(prescription, examType, examIndex, ApiError),
              providerName: cleanText(prescription.providerName, 180) || "Médecin NEXA",
              specialtyName: cleanText(prescription.specialtyName, 160),
            });
          }
        }
      }
      return res.status(200).json({
        ok: true,
        results: [...results.filter((item) => item.files.length > 0), ...partnerResults]
          .sort((a, b) => String(b.transferredAt || "").localeCompare(String(a.transferredAt || ""))).slice(0, 100),
        uploadableExams,
      });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA patient diagnostic results failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "patient-diagnostic-results-unavailable", "Vos résultats médicaux ne sont pas accessibles pour le moment.");
    }
  });

  const nexaPatientResultUploadStart = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!withCors(req, res)) return;
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "patient-result-upload-start", 5, 10 * 60_000);
      const input = parseBody(req, ApiError);
      const prescriptionId = cleanText(input.prescriptionId, 200);
      const examType = input.examType;
      const examIndex = input.examIndex;
      if (!validId(prescriptionId, 10, 200) || !["laboratory", "imaging"].includes(examType) || !Number.isSafeInteger(examIndex)) {
        throw new ApiError(400, "invalid-prescribed-exam", "L’examen prescrit sélectionné n’est pas valide.");
      }
      if (input.confirmMatch !== true) throw new ApiError(400, "result-confirmation-required", "Confirmez que les documents correspondent au patient et à l’examen prescrit.");
      const files = validateFiles(input.files, examType, ApiError);
      const patientRef = db.collection("patientProfiles").doc(user.uid);
      const prescriptionRef = db.collection("clinicalPrescriptions").doc(prescriptionId);
      const id = claimId(prescriptionId, examType, examIndex);
      const claimRef = db.collection("patientResultClaims").doc(id);
      const sessionRef = db.collection("patientResultUploadSessions").doc();
      const resultRef = db.collection("patientSubmittedResults").doc();
      const expiresAt = Timestamp.fromMillis(Date.now() + 20 * 60_000);
      const created = await db.runTransaction(async (transaction) => {
        const [patient, prescription, claimSnapshot] = await Promise.all([
          transaction.get(patientRef), transaction.get(prescriptionRef), transaction.get(claimRef),
        ]);
        if (!patient.exists || patient.get("role") !== "patient" || patient.get("profileComplete") !== true) {
          throw new ApiError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
        }
        if (!prescription.exists || prescription.get("status") !== "VALIDATED" || prescription.get("patientUid") !== user.uid) {
          throw new ApiError(404, "prescription-not-found", "Aucune ordonnance active ne correspond à cet examen.");
        }
        const data = prescription.data() || {};
        const providerUid = cleanText(data.providerUid, 200);
        const appointmentId = cleanText(data.appointmentId, 200);
        if (!validId(providerUid, 10, 200) || !validId(appointmentId, 10, 200)) {
          throw new ApiError(409, "prescription-link-invalid", "L’ordonnance n’est pas liée à une prise en charge valide.");
        }
        const [appointment, provider] = await Promise.all([
          transaction.get(db.collection("appointments").doc(appointmentId)),
          transaction.get(db.collection("providerProfiles").doc(providerUid)),
        ]);
        if (!appointment.exists || appointment.get("patientUid") !== user.uid || appointment.get("providerUid") !== providerUid ||
          appointment.get("providerType") !== "doctor" || appointment.get("paymentStatus") !== "PAID" ||
          !["IN_PROGRESS", "COMPLETED"].includes(String(appointment.get("status") || "").toUpperCase())) {
          throw new ApiError(409, "prescription-encounter-invalid", "L’ordonnance n’est plus liée à une consultation NEXA admissible.");
        }
        assertDoctor(provider, ApiError);
        const examName = readExam(data, examType, examIndex, ApiError);
        const claim = claimSnapshot.data() || {};
        if (claim.status === "SUBMITTED") throw new ApiError(409, "result-already-uploaded", "Un résultat a déjà été envoyé pour cet examen.");
        if (["OPEN", "SCANNING"].includes(claim.status) && validId(claim.sessionId, 10, 80) &&
          millis(claim.expiresAt) > Date.now()) {
          const openSession = await transaction.get(db.collection("patientResultUploadSessions").doc(claim.sessionId));
          if (openSession.exists && ["OPEN", "SCANNING"].includes(String(openSession.get("status"))) &&
            millis(openSession.get("expiresAt")) > Date.now()) {
            const scanning = openSession.get("status") === "SCANNING";
            throw new ApiError(409, scanning ? "result-upload-in-progress" : "result-upload-already-open",
              scanning ? "L’analyse du dépôt est en cours. Attendez son résultat avant de recommencer." :
                "Un dépôt est déjà ouvert. Terminez-le ou réessayez après son expiration.");
          }
        }
        const fileEntries = files.map((file, index) => {
          const extension = file.contentType === "application/pdf" ? "pdf" : file.contentType === "image/jpeg" ? "jpg" : "png";
          const fileId = randomBytes(18).toString("base64url");
          return {
            id: fileId, category: file.category,
            fileName: (examType === "laboratory" ? "laboratoire-" : "imagerie-") + (index + 1) + "." + extension,
            contentType: file.contentType, expectedSize: file.size,
            storagePath: "nexa-patient-result-quarantine/" + sessionRef.id + "/" + fileId,
          };
        });
        const now = FieldValue.serverTimestamp();
        transaction.create(sessionRef, {
          patientUid: user.uid, providerUid, appointmentId, prescriptionId, examType, examIndex,
          examName, claimId: id, resultId: resultRef.id, files: fileEntries,
          status: "OPEN", cleanupComplete: false, createdAt: now, expiresAt,
        });
        transaction.set(claimRef, {
          patientUid: user.uid, providerUid, prescriptionId, examType, examIndex,
          status: "OPEN", sessionId: sessionRef.id, resultId: resultRef.id,
          updatedAt: now, expiresAt,
        }, { merge: true });
        return { providerUid, appointmentId, examName, fileEntries, sessionId: sessionRef.id, resultId: resultRef.id };
      });

      let uploads;
      try {
        uploads = await Promise.all(created.fileEntries.map(async (file) => {
          const [policy] = await bucket.file(file.storagePath).generateSignedPostPolicyV4({
            expires: Date.now() + 10 * 60_000,
            fields: {
              "Content-Type": file.contentType, success_action_status: "201",
              "x-goog-if-generation-match": "0", "x-goog-meta-firebasestoragedownloadtokens": "",
            },
            conditions: [
              ["content-length-range", 1, MAX_FILE_BYTES], ["eq", "$key", file.storagePath],
              ["eq", "$Content-Type", file.contentType], ["eq", "$success_action_status", "201"],
              ["eq", "$x-goog-if-generation-match", "0"], ["eq", "$x-goog-meta-firebasestoragedownloadtokens", ""],
            ],
          });
          return {
            fileId: file.id, category: file.category, fileName: file.fileName,
            contentType: file.contentType, expectedSize: file.expectedSize,
            uploadUrl: policy.url, fields: policy.fields,
          };
        }));
      } catch {
        await closeSession(db, created.sessionId, user.uid, "FAILED", FieldValue, Timestamp);
        throw new ApiError(503, "secure-upload-unavailable", "Le téléversement sécurisé est indisponible. Aucun résultat n’a été transmis.");
      }
      return res.status(201).json({ ok: true, uploadSessionId: created.sessionId, resultId: created.resultId, files: uploads });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA patient result upload start failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "patient-result-upload-unavailable", "Le dépôt sécurisé du résultat n’est pas disponible.");
    }
  });

  const nexaPatientResultUploadCancel = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!withCors(req, res)) return;
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "patient-result-upload-cancel", 10, 10 * 60_000);
      const input = parseBody(req, ApiError, 8_192);
      const sessionId = cleanText(input.uploadSessionId, 80);
      if (!validId(sessionId, 10, 80)) throw new ApiError(400, "invalid-upload-session", "La session de dépôt n’est pas valide.");
      const sessionRef = db.collection("patientResultUploadSessions").doc(sessionId);
      const session = await sessionRef.get();
      if (!session.exists || session.get("patientUid") !== user.uid || session.get("status") !== "OPEN") {
        throw new ApiError(404, "upload-session-invalid", "La session de dépôt n’est pas disponible.");
      }
      const data = session.data() || {};
      const files = Array.isArray(data.files) ? data.files : [];
      await Promise.allSettled(files.filter((file) =>
        file && file.storagePath === "nexa-patient-result-quarantine/" + sessionId + "/" + file.id)
        .map((file) => bucket.file(file.storagePath).delete({ ignoreNotFound: true })));
      await closeSession(db, sessionId, user.uid, "CANCELLED", FieldValue, Timestamp);
      return res.status(200).json({ ok: true });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA patient result upload cancel failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "patient-result-upload-unavailable", "La session de dépôt n’a pas pu être annulée.");
    }
  });

  const nexaPatientResultSubmit = onRequest({ region: REGION, timeoutSeconds: 300, memory: "1GiB", maxInstances: 5 }, async (req, res) => {
    if (!withCors(req, res)) return;
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    let uid = "";
    let sessionId = "";
    let scanLocked = false;
    let submitted = false;
    const touchedPaths = [];
    try {
      const user = await requireUser(req);
      uid = user.uid;
      await requireAppCheckToken(req);
      await enforceUserRateLimit(uid, "patient-result-submit", 5, 10 * 60_000);
      const input = parseBody(req, ApiError, 8_192);
      sessionId = cleanText(input.uploadSessionId, 80);
      if (!validId(sessionId, 10, 80)) throw new ApiError(400, "invalid-upload-session", "La session de dépôt n’est pas valide.");
      const sessionRef = db.collection("patientResultUploadSessions").doc(sessionId);
      const sessionSnapshot = await sessionRef.get();
      if (!sessionSnapshot.exists || sessionSnapshot.get("patientUid") !== uid || sessionSnapshot.get("status") !== "OPEN") {
        throw new ApiError(403, "upload-session-invalid", "La session de dépôt est expirée ou non autorisée.");
      }
      const session = sessionSnapshot.data() || {};
      if (millis(session.expiresAt) <= Date.now() || !["laboratory", "imaging"].includes(session.examType)) {
        throw new ApiError(403, "upload-session-expired", "La session de dépôt a expiré. Sélectionnez à nouveau l’examen.");
      }
      const files = Array.isArray(session.files) ? session.files : [];
      if (files.length < 1 || files.length > MAX_FILES || files.some((file) =>
        !validId(file.id, 10, 80) || file.storagePath !== "nexa-patient-result-quarantine/" + sessionId + "/" + file.id)) {
        throw new ApiError(409, "upload-session-files-invalid", "Les fichiers attendus pour cette session ne sont pas valides.");
      }
      const patientRef = db.collection("patientProfiles").doc(uid);
      const providerRef = db.collection("providerProfiles").doc(cleanText(session.providerUid, 200));
      const prescriptionRef = db.collection("clinicalPrescriptions").doc(cleanText(session.prescriptionId, 200));
      const appointmentRef = db.collection("appointments").doc(cleanText(session.appointmentId, 200));
      const claimRef = db.collection("patientResultClaims").doc(cleanText(session.claimId, 100));
      const resultRef = db.collection("patientSubmittedResults").doc(cleanText(session.resultId, 200));
      const [patient, provider, prescription, appointment, claim] = await Promise.all([
        patientRef.get(), providerRef.get(), prescriptionRef.get(), appointmentRef.get(), claimRef.get(),
      ]);
      if (!patient.exists || patient.get("role") !== "patient" || patient.get("profileComplete") !== true) {
        throw new ApiError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
      }
      assertDoctor(provider, ApiError);
      if (!prescription.exists || prescription.get("status") !== "VALIDATED" || prescription.get("patientUid") !== uid ||
        prescription.get("providerUid") !== session.providerUid || prescription.get("appointmentId") !== session.appointmentId) {
        throw new ApiError(409, "prescription-changed", "L’ordonnance n’est plus active pour ce dépôt.");
      }
      if (!appointment.exists || appointment.get("patientUid") !== uid || appointment.get("providerUid") !== session.providerUid ||
        appointment.get("providerType") !== "doctor" || appointment.get("paymentStatus") !== "PAID" ||
        !["IN_PROGRESS", "COMPLETED"].includes(String(appointment.get("status") || "").toUpperCase())) {
        throw new ApiError(409, "prescription-encounter-invalid", "La prise en charge liée à cette ordonnance n’est plus valide.");
      }
      if (readExam(prescription.data() || {}, session.examType, Number(session.examIndex), ApiError) !== session.examName ||
        !claim.exists || claim.get("sessionId") !== sessionId || claim.get("status") !== "OPEN") {
        throw new ApiError(409, "result-upload-claim-lost", "Le dépôt n’est plus associé à l’examen prescrit sélectionné.");
      }
      validateFiles(files.map((file) => ({
        category: file.category, fileName: file.fileName, contentType: file.contentType, size: file.expectedSize,
      })), session.examType, ApiError);

      await db.runTransaction(async (transaction) => {
        const [freshSession, freshClaim, freshResult] = await Promise.all([
          transaction.get(sessionRef), transaction.get(claimRef), transaction.get(resultRef),
        ]);
        if (!freshSession.exists || freshSession.get("patientUid") !== uid || freshSession.get("status") !== "OPEN" ||
          !freshClaim.exists || freshClaim.get("sessionId") !== sessionId || freshClaim.get("status") !== "OPEN" || freshResult.exists) {
          throw new ApiError(409, "result-upload-session-conflict", "La session a expiré ou a déjà été utilisée.");
        }
        transaction.update(sessionRef, { status: "SCANNING", scanningStartedAt: FieldValue.serverTimestamp() });
        transaction.update(claimRef, { status: "SCANNING", updatedAt: FieldValue.serverTimestamp() });
      });
      scanLocked = true;

      const storedFiles = await Promise.all(files.map(async (file) => {
        const object = bucket.file(file.storagePath);
        const [exists] = await object.exists();
        if (!exists) throw new ApiError(400, "result-file-missing", "Un fichier sélectionné n’a pas été téléversé.");
        const [metadata] = await object.getMetadata();
        const size = Number(metadata.size || 0);
        const contentType = String(metadata.contentType || "").toLowerCase();
        const custom = metadata.metadata && typeof metadata.metadata === "object" ? metadata.metadata : {};
        const downloadToken = Object.entries(custom).find(([key]) => key.toLowerCase() === "firebasestoragedownloadtokens")?.[1];
        if (contentType !== file.contentType || size !== file.expectedSize || size < 1 || size > MAX_FILE_BYTES ||
          (typeof downloadToken === "string" && downloadToken.length > 0)) {
          throw new ApiError(400, "result-file-metadata-invalid", "Un fichier ne correspond pas à son type ou sa taille attendue.");
        }
        return { ...file, size, contentType, md5Hash: typeof metadata.md5Hash === "string" ? metadata.md5Hash : null };
      }));
      const hashes = new Set();
      for (const file of storedFiles) {
        if (file.md5Hash && hashes.has(file.md5Hash)) throw new ApiError(409, "duplicate-result-file", "Le même fichier a été sélectionné plusieurs fois.");
        if (file.md5Hash) hashes.add(file.md5Hash);
      }
      const scanResults = new Array(storedFiles.length);
      let cursor = 0;
      let scanFailure = null;
      const scanWorker = async () => {
        while (!scanFailure) {
          const index = cursor++;
          if (index >= storedFiles.length) return;
          try {
            const [contents] = await bucket.file(storedFiles[index].storagePath).download();
            scanResults[index] = await scanFile(contents, storedFiles[index].contentType, ApiError);
          } catch (error) { scanFailure ||= error; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, storedFiles.length) }, () => scanWorker()));
      if (scanFailure) throw scanFailure;

      const resultFiles = [];
      for (let index = 0; index < storedFiles.length; index += 1) {
        const file = storedFiles[index];
        const destination = "nexa-patient-submitted-results/" + uid + "/" + resultRef.id + "/" + file.id;
        await bucket.file(file.storagePath).move(destination);
        touchedPaths.push(destination);
        await bucket.file(destination).setMetadata({
          contentType: file.contentType,
          cacheControl: "private, no-store",
          metadata: { nexaScanStatus: "CLEAN", firebaseStorageDownloadTokens: "" },
        });
        resultFiles.push({
          id: file.id, category: file.category, storagePath: destination, fileName: file.fileName,
          contentType: file.contentType, size: file.size, md5Hash: file.md5Hash,
          antivirusStatus: "CLEAN", antivirusScannerVersion: scanResults[index].scannerVersion,
          antivirusScannedAt: new Date().toISOString(),
        });
      }
      const profile = patient.data() || {};
      let patientIdentity = {
        firstName: cleanText(profile.firstName, 80) || "Non renseigné",
        lastName: cleanText(profile.lastName, 80) || "Non renseigné",
        patientNumber: cleanText(profile.patientNumber, 32) || "Non renseigné",
        sex: cleanText(profile.sex, 32) || "Non renseigné",
        age: patientAge(profile.birthDate),
      };
      const grantRef = db.collection("patientResultFollowUpGrants").doc(resultRef.id);
      const auditRef = db.collection("patientResultAuditLogs").doc();
      const now = FieldValue.serverTimestamp();
      await db.runTransaction(async (transaction) => {
        const [freshPatient, freshProvider, freshPrescription, freshAppointment, freshSession, freshClaim, freshResult] = await Promise.all([
          transaction.get(patientRef), transaction.get(providerRef), transaction.get(prescriptionRef), transaction.get(appointmentRef),
          transaction.get(sessionRef), transaction.get(claimRef), transaction.get(resultRef),
        ]);
        const currentExam = freshPrescription.exists
          ? readExam(freshPrescription.data() || {}, session.examType, Number(session.examIndex), ApiError) : "";
        if (!freshPatient.exists || freshPatient.get("role") !== "patient" || freshPatient.get("profileComplete") !== true ||
          !freshProvider.exists || freshProvider.get("type") !== "doctor" || freshProvider.get("status") !== "verified" ||
          freshProvider.get("clinicalCredentialsVerified") !== true || !freshPrescription.exists ||
          freshPrescription.get("status") !== "VALIDATED" || freshPrescription.get("patientUid") !== uid ||
          freshPrescription.get("providerUid") !== session.providerUid || currentExam !== session.examName ||
          !freshAppointment.exists || freshAppointment.get("patientUid") !== uid || freshAppointment.get("providerUid") !== session.providerUid ||
          freshAppointment.get("providerType") !== "doctor" || freshAppointment.get("paymentStatus") !== "PAID" ||
          !["IN_PROGRESS", "COMPLETED"].includes(String(freshAppointment.get("status") || "").toUpperCase())) {
          throw new ApiError(409, "result-authorization-changed", "L’ordonnance ou l’autorisation du médecin a changé pendant l’analyse.");
        }
        const currentProfile = freshPatient.data() || {};
        patientIdentity = {
          firstName: cleanText(currentProfile.firstName, 80) || "Non renseigné",
          lastName: cleanText(currentProfile.lastName, 80) || "Non renseigné",
          patientNumber: cleanText(currentProfile.patientNumber, 32) || "Non renseigné",
          sex: cleanText(currentProfile.sex, 32) || "Non renseigné",
          age: patientAge(currentProfile.birthDate),
        };
        if (!freshSession.exists || freshSession.get("status") !== "SCANNING" || freshSession.get("patientUid") !== uid ||
          !freshClaim.exists || freshClaim.get("sessionId") !== sessionId || freshClaim.get("status") !== "SCANNING" ||
          freshResult.exists) {
          throw new ApiError(409, "result-upload-session-conflict", "La session de résultat a expiré ou a déjà été utilisée.");
        }
        transaction.create(resultRef, {
          patientUid: uid, patientNumber: patientIdentity.patientNumber === "Non renseigné" ? "" : patientIdentity.patientNumber,
          providerUid: session.providerUid, appointmentId: session.appointmentId,
          prescriptionId: session.prescriptionId, examType: session.examType, examIndex: Number(session.examIndex),
          examName: session.examName, files: resultFiles, status: "AVAILABLE_TO_PRESCRIBER", followUpStatus: "RECU",
          reviewedAt: null, reviewedByUid: null, createdAt: now, updatedAt: now,
        });
        transaction.create(grantRef, {
          resultId: resultRef.id, patientUid: uid, providerUid: session.providerUid, appointmentId: session.appointmentId,
          prescriptionId: session.prescriptionId, status: "OPEN", allowedActions: ["note", "prescription", "appointment", "review", "close"],
          createdAt: now, closedAt: null,
        });
        transaction.update(sessionRef, { status: "SUBMITTED", submittedAt: now });
        transaction.update(claimRef, { status: "SUBMITTED", resultId: resultRef.id, sessionId: FieldValue.delete(), expiresAt: FieldValue.delete(), updatedAt: now });
        transaction.create(auditRef, {
          actorUid: uid, providerUid: session.providerUid, action: "patient_diagnostic_result_submitted",
          resultId: resultRef.id, fileCount: resultFiles.length, createdAt: now,
        });
      });
      submitted = true;
      if (typeof createNexaNotification === "function") {
        const patientAgeText = patientIdentity.age === null ? "non renseigné" : patientIdentity.age + " ans";
        await createNexaNotification(String(session.providerUid), "patient-result:" + resultRef.id + ":available", {
          type: "patient_result_available",
          title: "Résultat médical disponible",
          body: "Résultat prescrit reçu. Prénom : " + patientIdentity.firstName + "; nom : " + patientIdentity.lastName +
            "; NMC : " + patientIdentity.patientNumber + "; sexe : " + patientIdentity.sex + "; âge : " + patientAgeText +
            ". Consultez votre espace professionnel sécurisé.",
          url: "/espace-professionnel.html#resultats-patient",
        }, String(session.appointmentId)).catch((error) => logger.warn("NEXA patient result notification failed", {
          errorName: error instanceof Error ? error.name : "unknown-error",
        }));
      }
      return res.status(201).json({
        ok: true, resultId: resultRef.id, status: "AVAILABLE_TO_PRESCRIBER",
        message: "Votre résultat est sécurisé et transmis au médecin qui a prescrit cet examen.",
      });
    } catch (error) {
      if (!submitted && scanLocked && uid && sessionId) {
        const sessionSnapshot = await db.collection("patientResultUploadSessions").doc(sessionId).get().catch(() => null);
        const sessionFiles = sessionSnapshot && sessionSnapshot.exists && Array.isArray(sessionSnapshot.get("files")) ? sessionSnapshot.get("files") : [];
        const quarantine = sessionFiles.filter((file) => file && file.storagePath === "nexa-patient-result-quarantine/" + sessionId + "/" + file.id)
          .map((file) => file.storagePath);
        await Promise.allSettled([...quarantine, ...touchedPaths].map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
        const status = error instanceof ApiError && error.code === "malware-detected" ? "REJECTED" : "SCAN_FAILED";
        await closeSession(db, sessionId, uid, status, FieldValue, Timestamp).catch((cleanupError) =>
          logger.warn("NEXA patient result upload cleanup failed", { errorName: cleanupError instanceof Error ? cleanupError.name : "unknown-error" }));
      }
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA patient result submit failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "patient-result-submit-unavailable", "Le résultat n’a pas pu être transmis. Aucun fichier n’est disponible.");
    }
  });

  const nexaPatientResultFile = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!withCors(req, res)) return;
    if (req.method !== "GET") { res.set("Allow", "GET, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "patient-result-file", 20, 60_000);
      await requirePatient(user.uid, ApiError);
      const resultId = cleanText(req.query.resultId, 200);
      const fileId = cleanText(req.query.fileId, 100);
      if (!validId(resultId, 10, 200) || !validId(fileId, 10, 100)) throw new ApiError(400, "invalid-result-file", "La référence du fichier n’est pas valide.");
      const resultSnapshot = await db.collection("patientSubmittedResults").doc(resultId).get();
      if (!resultSnapshot.exists || resultSnapshot.get("patientUid") !== user.uid) throw new ApiError(404, "patient-result-not-found", "Ce résultat n’est pas disponible.");
      const data = resultSnapshot.data() || {};
      const file = Array.isArray(data.files) ? data.files.find((item) => item && item.id === fileId) : null;
      const expectedPrefix = "nexa-patient-submitted-results/" + user.uid + "/" + resultId + "/";
      if (!file || file.antivirusStatus !== "CLEAN" || !String(file.storagePath || "").startsWith(expectedPrefix)) {
        throw new ApiError(409, "patient-result-file-not-cleared", "Ce fichier n’a pas reçu un verdict de sécurité valide.");
      }
      const fileName = cleanText(file.fileName, 180).replace(/[\r\n"\\]/g, "_") || "resultat";
      const [url] = await bucket.file(file.storagePath).getSignedUrl({
        action: "read", expires: Date.now() + 5 * 60_000, responseDisposition: 'inline; filename="' + fileName + '"',
      });
      await db.collection("patientResultAuditLogs").add({
        actorUid: user.uid, action: "patient_result_file_opened", resultId, fileId, createdAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ ok: true, url, expiresInSeconds: 300 });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA patient result file failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "patient-result-file-unavailable", "Ce résultat ne peut pas être ouvert pour le moment.");
    }
  });

  const nexaPatientDiagnosticCenterResultFile = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!withCors(req, res)) return;
    if (req.method !== "GET") { res.set("Allow", "GET, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "patient-center-result-file", 20, 60_000);
      await requirePatient(user.uid, ApiError);
      const resultId = cleanText(req.query.resultId, 200);
      const fileId = cleanText(req.query.fileId, 100);
      if (!validId(resultId, 10, 200) || !validId(fileId, 10, 100)) throw new ApiError(400, "invalid-result-file", "La référence du fichier n’est pas valide.");
      const resultRef = db.collection("diagnosticResults").doc(resultId);
      const result = await resultRef.get();
      const data = result.data() || {};
      if (!result.exists || data.patientUid !== user.uid || data.status !== "RESULT_AVAILABLE" || !data.patientTransferredAt) {
        throw new ApiError(404, "diagnostic-result-not-found", "Ce résultat n’est pas disponible dans votre espace patient.");
      }
      const orderId = cleanText(data.orderId, 200);
      const file = Array.isArray(data.files) ? data.files.find((entry) => entry && entry.id === fileId) : null;
      const expectedPrefix = "nexa-diagnostic-results/" + orderId + "/" + resultId + "/";
      const storagePath = cleanText(file?.storagePath, 600);
      if (!validId(orderId) || !file || file.antivirusStatus !== "CLEAN" || !storagePath.startsWith(expectedPrefix)) {
        throw new ApiError(409, "diagnostic-result-file-not-cleared", "Ce fichier n’a pas reçu un verdict de sécurité valide.");
      }
      const fileName = cleanText(file.fileName, 180).replace(/[\r\n"\\]/g, "_") || "resultat";
      const [url] = await bucket.file(storagePath).getSignedUrl({ action: "read", expires: Date.now() + 5 * 60_000,
        responseDisposition: 'inline; filename="' + fileName + '"' });
      await db.collection("diagnosticResultAuditLogs").doc().create({
        actorUid: user.uid, action: "diagnostic_result_file_opened_by_patient", orderId, resultId, fileId,
        createdAt: FieldValue.serverTimestamp(),
      });
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, url, expiresInSeconds: 300 });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA patient diagnostic-center result file failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "patient-center-result-file-unavailable", "Ce résultat ne peut pas être ouvert pour le moment.");
    }
  });

  const nexaProviderPatientResults = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!withCors(req, res)) return;
    if (req.method !== "GET") { res.set("Allow", "GET, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "provider-patient-result-list", 30, 5 * 60_000);
      assertDoctor(await db.collection("providerProfiles").doc(user.uid).get(), ApiError);
      const snapshot = await db.collection("patientSubmittedResults").where("providerUid", "==", user.uid).limit(100).get();
      const candidates = snapshot.docs.filter((doc) => doc.get("status") === "AVAILABLE_TO_PRESCRIBER").slice(0, 50);
      const results = [];
      for (const doc of candidates) {
        const [grant, patient] = await Promise.all([
          db.collection("patientResultFollowUpGrants").doc(doc.id).get(),
          db.collection("patientProfiles").doc(String(doc.get("patientUid") || "")).get(),
        ]);
        if (!grant.exists || grant.get("providerUid") !== user.uid || grant.get("patientUid") !== doc.get("patientUid") || grant.get("status") !== "OPEN" ||
          !patient.exists || patient.get("role") !== "patient") continue;
        const profile = patient.data() || {};
        const files = Array.isArray(doc.get("files")) ? doc.get("files").filter((file) =>
          file && file.antivirusStatus === "CLEAN" && validId(file.id, 10, 100)).map((file) => ({
          id: file.id, category: cleanText(file.category, 40), fileName: cleanText(file.fileName, 180),
          contentType: cleanText(file.contentType, 100), size: Number(file.size) || 0,
        })) : [];
        results.push({
          id: doc.id, examName: cleanText(doc.get("examName"), 250) || "Résultat médical",
          examType: cleanText(doc.get("examType"), 20),
          followUpStatus: cleanText(doc.get("followUpStatus"), 40) || "RECU",
          reviewedAt: isoDate(doc.get("reviewedAt")),
          patient: {
            name: cleanText(profile.displayName || [profile.firstName, profile.lastName].filter(Boolean).join(" "), 140) || "Patient NEXA",
            patientNumber: cleanText(profile.patientNumber, 32),
            sex: cleanText(profile.sex, 32) || "Non communiqué",
            age: patientAge(profile.birthDate),
          },
          createdAt: isoDate(doc.get("createdAt")),
          files,
        });
        await db.collection("patientResultAuditLogs").add({
          actorUid: user.uid, action: "prescriber_patient_result_opened", resultId: doc.id, createdAt: FieldValue.serverTimestamp(),
        });
      }
      results.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      return res.status(200).json({ ok: true, results });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA provider patient results failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "provider-result-submissions-unavailable", "Les résultats transmis par vos patients ne sont pas accessibles pour le moment.");
    }
  });

  const nexaProviderPatientResultFile = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!withCors(req, res)) return;
    if (req.method !== "GET") { res.set("Allow", "GET, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "provider-patient-result-file", 20, 60_000);
      assertDoctor(await db.collection("providerProfiles").doc(user.uid).get(), ApiError);
      const resultId = cleanText(req.query.resultId, 200);
      const fileId = cleanText(req.query.fileId, 100);
      if (!validId(resultId, 10, 200) || !validId(fileId, 10, 100)) throw new ApiError(400, "invalid-result-file", "La référence du fichier n’est pas valide.");
      const [result, grant] = await Promise.all([
        db.collection("patientSubmittedResults").doc(resultId).get(),
        db.collection("patientResultFollowUpGrants").doc(resultId).get(),
      ]);
      if (!result.exists || result.get("providerUid") !== user.uid || result.get("status") !== "AVAILABLE_TO_PRESCRIBER" ||
        !grant.exists || grant.get("providerUid") !== user.uid || grant.get("patientUid") !== result.get("patientUid") || grant.get("status") !== "OPEN") {
        throw new ApiError(404, "patient-result-not-found", "Ce résultat n’est pas accessible.");
      }
      const data = result.data() || {};
      const file = Array.isArray(data.files) ? data.files.find((item) => item && item.id === fileId) : null;
      const expectedPrefix = "nexa-patient-submitted-results/" + cleanText(data.patientUid, 200) + "/" + resultId + "/";
      if (!file || file.antivirusStatus !== "CLEAN" || !String(file.storagePath || "").startsWith(expectedPrefix)) {
        throw new ApiError(409, "patient-result-file-not-cleared", "Ce fichier n’a pas reçu un verdict de sécurité valide.");
      }
      const fileName = cleanText(file.fileName, 180).replace(/[\r\n"\\]/g, "_") || "resultat";
      const [url] = await bucket.file(file.storagePath).getSignedUrl({
        action: "read", expires: Date.now() + 5 * 60_000, responseDisposition: 'inline; filename="' + fileName + '"',
      });
      await db.collection("patientResultAuditLogs").add({
        actorUid: user.uid, action: "prescriber_patient_result_file_opened", resultId, fileId, createdAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ ok: true, url, expiresInSeconds: 300 });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA provider patient result file failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "provider-patient-result-file-unavailable", "Ce résultat ne peut pas être ouvert pour le moment.");
    }
  });

  const nexaProviderPatientResultFollowUp = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!withCors(req, res)) return;
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > 24_576 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 24_576)) {
      return fail(res, 413, "request-too-large", "La demande de suivi est trop volumineuse.");
    }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "provider-patient-result-follow-up", 15, 10 * 60_000);
      const body = parseBody(req, ApiError, 24_576);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new ApiError(400, "invalid-request", "La demande de suivi n’est pas valide.");
      }
      const resultId = cleanText(body.resultId, 200);
      const action = cleanText(body.action, 30);
      if (!validId(resultId, 10, 200)) throw new ApiError(400, "invalid-result-id", "La référence du résultat n’est pas valide.");
      if (!["note", "prescription", "appointment", "review", "close"].includes(action)) {
        throw new ApiError(400, "invalid-follow-up-action", "Choisissez une action de suivi valide.");
      }

      const providerRef = db.collection("providerProfiles").doc(user.uid);
      const resultRef = db.collection("patientSubmittedResults").doc(resultId);
      const grantRef = db.collection("patientResultFollowUpGrants").doc(resultId);
      const [provider, result, grant] = await Promise.all([providerRef.get(), resultRef.get(), grantRef.get()]);
      assertDoctor(provider, ApiError);
      if (!result.exists || result.get("providerUid") !== user.uid || !grant.exists ||
        grant.get("providerUid") !== user.uid || grant.get("patientUid") !== result.get("patientUid")) {
        throw new ApiError(404, "patient-result-not-found", "Ce résultat n’est pas accessible.");
      }
      if (grant.get("status") !== "OPEN") throw new ApiError(403, "follow-up-access-closed", "L’accès de suivi associé à ce résultat est fermé.");

      const patientUid = cleanText(result.get("patientUid"), 200);
      const appointmentId = cleanText(result.get("appointmentId"), 200);
      if (!validId(patientUid, 1, 200) || !validId(appointmentId, 1, 200)) {
        throw new ApiError(409, "patient-result-link-invalid", "Les références patient de ce résultat ne sont plus valides.");
      }
      const patientRef = db.collection("patientProfiles").doc(patientUid);
      const appointmentRef = db.collection("appointments").doc(appointmentId);
      const profile = provider.get("profile") && typeof provider.get("profile") === "object" ? provider.get("profile") : {};
      const providerName = cleanText(profile.name || profile.displayName, 180) || "Médecin NEXA";
      const specialtyName = cleanText(profile.specialty, 160);
      const timestamp = FieldValue.serverTimestamp();
      const auditRef = db.collection("patientResultAuditLogs").doc();
      const clinicalAuditRef = db.collection("clinicalAuditLogs").doc();
      const actionRef = resultRef.collection("followUpActions").doc();
      let responsePayload = { ok: true, action };
      let notification = null;

      if (action === "review") {
        let alreadyReviewed = false;
        await db.runTransaction(async (transaction) => {
          const [freshProvider, freshResult, freshGrant, patient, appointment] = await Promise.all([
            transaction.get(providerRef), transaction.get(resultRef), transaction.get(grantRef),
            transaction.get(patientRef), transaction.get(appointmentRef),
          ]);
          assertDoctor(freshProvider, ApiError);
          if (!freshResult.exists || freshResult.get("providerUid") !== user.uid || freshResult.get("patientUid") !== patientUid ||
            freshResult.get("status") !== "AVAILABLE_TO_PRESCRIBER" || !freshGrant.exists || freshGrant.get("providerUid") !== user.uid ||
            freshGrant.get("patientUid") !== patientUid || freshGrant.get("status") !== "OPEN" || !patient.exists ||
            patient.get("role") !== "patient" || patient.get("profileComplete") !== true || !appointment.exists ||
            appointment.get("patientUid") !== patientUid || appointment.get("providerUid") !== user.uid) {
            throw new ApiError(403, "follow-up-access-closed", "L’accès de suivi a été fermé ou n’est plus autorisé.");
          }
          if (freshResult.get("followUpStatus") === "EXAMINEE") {
            if (freshResult.get("reviewedByUid") !== user.uid) {
              throw new ApiError(409, "result-review-conflict", "Ce résultat a déjà été examiné par un autre professionnel.");
            }
            alreadyReviewed = true;
            return;
          }
          transaction.update(resultRef, {
            followUpStatus: "EXAMINEE", reviewedAt: timestamp, reviewedByUid: user.uid, updatedAt: timestamp,
          });
          transaction.create(auditRef, {
            actorUid: user.uid, action: "prescriber_patient_result_reviewed", resultId, createdAt: timestamp,
          });
        });
        responsePayload = { ...responsePayload, followUpStatus: "EXAMINEE", alreadyReviewed };
      } else if (action === "note") {
        const content = cleanText(body.note, 5_000);
        if (!content) throw new ApiError(400, "follow-up-note-required", "Rédigez une note avant de l’ajouter au dossier.");
        const clinicalRecordRef = db.collection("electronicPatientRecords").doc();
        const counterRef = db.collection("systemCounters").doc("clinicalRecordNumbers");
        let recordNumber = "";
        await db.runTransaction(async (transaction) => {
          const [freshProvider, freshResult, freshGrant, patient, counter] = await Promise.all([
            transaction.get(providerRef), transaction.get(resultRef), transaction.get(grantRef),
            transaction.get(patientRef), transaction.get(counterRef),
          ]);
          assertDoctor(freshProvider, ApiError);
          if (!freshResult.exists || freshResult.get("providerUid") !== user.uid || freshResult.get("patientUid") !== patientUid || !freshGrant.exists ||
            freshGrant.get("providerUid") !== user.uid || freshGrant.get("status") !== "OPEN" ||
            freshGrant.get("patientUid") !== patientUid || !patient.exists || patient.get("role") !== "patient" ||
            patient.get("profileComplete") !== true) {
            throw new ApiError(403, "follow-up-access-closed", "L’accès de suivi a été fermé ou n’est plus autorisé.");
          }
          const lastIssuedNumber = counter.exists ? counter.get("lastIssuedNumber") : 0;
          if (typeof lastIssuedNumber !== "number" || !Number.isSafeInteger(lastIssuedNumber) || lastIssuedNumber < 0 || lastIssuedNumber >= 9_999_999) {
            throw new ApiError(503, "record-number-unavailable", "La numérotation des dossiers est indisponible.");
          }
          const sequence = lastIssuedNumber + 1;
          recordNumber = "NEXA-" + new Date().getUTCFullYear() + "-" + String(sequence).padStart(7, "0");
          const patientData = patient.data() || {};
          const patientNumber = cleanText(patientData.patientNumber, 32);
          const patientName = cleanText(patientData.displayName || [patientData.firstName, patientData.lastName].filter(Boolean).join(" "), 140) || "Patient NEXA";
          const signedAt = new Date().toISOString();
          const signature = { uid: user.uid, name: providerName, specialty: specialtyName, signedAt, source: "PATIENT_RESULT_FOLLOW_UP" };
          const clinicalContent = {
            consultationReason: "Suivi du résultat transmis par le patient",
            relevantHistory: cleanText(freshResult.get("examName"), 250),
            additionalNotes: content,
          };
          const documentHash = createHash("sha256").update(JSON.stringify({
            recordId: clinicalRecordRef.id, providerUid: user.uid, patientUid, version: 1, clinicalContent, signature,
          })).digest("hex");
          transaction.create(clinicalRecordRef.collection("versions").doc("00000001"), {
            version: 1, status: "FINALIZED", clinicalContent, attachments: [], actorUid: user.uid,
            createdAt: timestamp, changeType: "FINALIZED", signature, documentHash,
          });
          transaction.create(clinicalRecordRef, {
            recordId: clinicalRecordRef.id, recordType: "STANDALONE", sourceType: "PATIENT_RESULT_FOLLOW_UP",
            sourceResultId: resultId, appointmentId, patientUid, patientNumber, patientName,
            providerUid: user.uid, providerName, specialtyName, recordNumber, status: "FINALIZED", version: 1,
            clinicalContent, attachments: [], addendumCount: 0, createdAt: timestamp, updatedAt: timestamp,
            finalizedAt: timestamp, signedAt: timestamp, signature, documentHash, createdBy: user.uid, updatedBy: user.uid,
            accessGrantId: resultId, accessGrantedAt: freshGrant.get("createdAt"), accessRevoked: false,
          });
          transaction.set(counterRef, { lastIssuedNumber: sequence, updatedAt: timestamp }, { merge: true });
          transaction.create(actionRef, {
            type: "NOTE", patientUid, providerUid: user.uid, providerName, specialtyName, content,
            recordId: clinicalRecordRef.id, recordNumber, signature, createdAt: timestamp,
          });
          transaction.create(auditRef, { actorUid: user.uid, action: "prescriber_patient_result_note_added", resultId, createdAt: timestamp });
          transaction.create(clinicalAuditRef, {
            actorUid: user.uid, action: "result_follow_up_clinical_record_created", resultId,
            recordId: clinicalRecordRef.id, recordNumber, createdAt: timestamp,
          });
        });
        responsePayload = { ...responsePayload, actionId: actionRef.id, recordNumber };
        notification = {
          eventKey: "patient-result:" + resultId + ":note:" + actionRef.id,
          type: "patient_result_note_added", title: "Note médicale ajoutée",
          body: "Votre médecin a ajouté une note de suivi à votre résultat médical.",
          url: "/espace-patient.html#patient-results-section",
        };
      } else if (action === "prescription") {
        const medicationInput = body.medication && typeof body.medication === "object" && !Array.isArray(body.medication) ? body.medication : {};
        const medication = {
          name: cleanText(medicationInput.name, 180), dosage: cleanText(medicationInput.dosage, 120),
          form: cleanText(medicationInput.form, 120), route: cleanText(medicationInput.route, 120),
          quantity: medicationInput.quantity === "" || medicationInput.quantity == null ? null : Number(medicationInput.quantity),
          instructions: cleanText(medicationInput.instructions, 500), duration: cleanText(medicationInput.duration, 120),
        };
        const notes = cleanText(body.notes, 1_000);
        if (!medication.name || (medication.quantity !== null &&
          (!Number.isFinite(medication.quantity) || medication.quantity < 0 || medication.quantity > 1_000_000))) {
          throw new ApiError(400, "invalid-medication", "Vérifiez le nom et la quantité du médicament.");
        }
        const prescriptionRef = db.collection("clinicalPrescriptions").doc();
        await db.runTransaction(async (transaction) => {
          const [freshProvider, freshResult, freshGrant, patient, appointment] = await Promise.all([
            transaction.get(providerRef), transaction.get(resultRef), transaction.get(grantRef),
            transaction.get(patientRef), transaction.get(appointmentRef),
          ]);
          assertDoctor(freshProvider, ApiError);
          if (!freshResult.exists || freshResult.get("providerUid") !== user.uid || freshResult.get("patientUid") !== patientUid || !freshGrant.exists ||
            freshGrant.get("providerUid") !== user.uid || freshGrant.get("status") !== "OPEN" ||
            freshGrant.get("patientUid") !== patientUid || !patient.exists || patient.get("role") !== "patient" ||
            !appointment.exists || appointment.get("patientUid") !== patientUid || appointment.get("providerUid") !== user.uid) {
            throw new ApiError(403, "follow-up-access-closed", "L’accès de suivi a été fermé ou n’est plus autorisé.");
          }
          transaction.create(prescriptionRef, {
            appointmentId, patientUid, providerUid: user.uid, providerName, specialtyName,
            medications: [medication], labExams: [], imagingExams: [], notes, status: "VALIDATED",
            version: 1, versionGroupId: prescriptionRef.id, previousVersionId: null, replacedBy: null,
            signature: { uid: user.uid, name: providerName, specialty: specialtyName, signedAt: new Date().toISOString(), source: "PATIENT_RESULT_FOLLOW_UP" },
            validatedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
            createdBy: user.uid, updatedBy: user.uid, sourceResultId: resultId,
          });
          transaction.create(actionRef, {
            type: "PRESCRIPTION", patientUid, providerUid: user.uid, prescriptionId: prescriptionRef.id, createdAt: timestamp,
          });
          transaction.create(auditRef, {
            actorUid: user.uid, action: "prescriber_patient_result_prescription_created", resultId,
            prescriptionId: prescriptionRef.id, createdAt: timestamp,
          });
        });
        responsePayload = { ...responsePayload, prescriptionId: prescriptionRef.id };
        notification = {
          eventKey: "patient-result:" + resultId + ":prescription:" + prescriptionRef.id,
          type: "prescription_received", title: "Ordonnance reçue",
          body: "Votre médecin vous a transmis une ordonnance après la lecture de votre résultat.",
          url: "/espace-patient.html#prescriptions-section",
        };
      } else if (action === "appointment") {
        const slotId = cleanText(body.slotId, 80);
        const note = cleanText(body.note, 300);
        if (!/^[a-f0-9]{32}$/.test(slotId)) throw new ApiError(400, "invalid-follow-up-slot", "Choisissez un créneau disponible.");
        const slotRef = db.collection("providerAvailabilitySlots").doc(slotId);
        const proposalId = createHash("sha256").update("patient-result:" + resultId + ":" + slotId).digest("hex").slice(0, 32);
        const proposalRef = db.collection("followUpProposals").doc(proposalId);
        let startsAt = "";
        await db.runTransaction(async (transaction) => {
          const [freshProvider, freshResult, freshGrant, patient, appointment, slot, existing] = await Promise.all([
            transaction.get(providerRef), transaction.get(resultRef), transaction.get(grantRef), transaction.get(patientRef),
            transaction.get(appointmentRef), transaction.get(slotRef), transaction.get(proposalRef),
          ]);
          assertDoctor(freshProvider, ApiError);
          if (!freshResult.exists || freshResult.get("providerUid") !== user.uid || freshResult.get("patientUid") !== patientUid || !freshGrant.exists ||
            freshGrant.get("providerUid") !== user.uid || freshGrant.get("status") !== "OPEN" ||
            freshGrant.get("patientUid") !== patientUid || !patient.exists || patient.get("role") !== "patient" ||
            !appointment.exists || appointment.get("patientUid") !== patientUid || appointment.get("providerUid") !== user.uid) {
            throw new ApiError(403, "follow-up-access-closed", "L’accès de suivi a été fermé ou n’est plus autorisé.");
          }
          if (!slot.exists || slot.get("providerUid") !== user.uid || slot.get("status") !== "available" ||
            String(slot.get("serviceType") || "TELECONSULTATION") !== "TELECONSULTATION") {
            throw new ApiError(409, "follow-up-slot-unavailable", "Ce créneau n’est plus disponible. Actualisez la liste.");
          }
          const startMs = Date.parse(String(slot.get("startsAt") || ""));
          const endMs = Date.parse(String(slot.get("endsAt") || ""));
          if (!Number.isFinite(startMs) || startMs <= Date.now() || !Number.isFinite(endMs) || endMs - startMs !== 30 * 60_000) {
            throw new ApiError(409, "follow-up-slot-invalid", "La date du créneau n’est plus valide.");
          }
          startsAt = new Date(startMs).toISOString();
          if (existing.exists) throw new ApiError(409, "follow-up-proposal-conflict", "Ce créneau a déjà été proposé pour ce résultat.");
          transaction.create(proposalRef, {
            appointmentId, sourceResultId: resultId, patientUid, providerUid: user.uid,
            slotId, startsAt, note, status: "PENDING", createdAt: timestamp, updatedAt: timestamp,
          });
          transaction.create(actionRef, {
            type: "APPOINTMENT", patientUid, providerUid: user.uid, providerName,
            proposalId, slotId, startsAt, createdAt: timestamp,
          });
          transaction.create(auditRef, {
            actorUid: user.uid, action: "prescriber_patient_result_appointment_proposed", resultId,
            proposalId, createdAt: timestamp,
          });
        });
        responsePayload = { ...responsePayload, proposalId, slotId, startsAt };
        notification = {
          eventKey: "patient-result:" + resultId + ":appointment:" + proposalId,
          type: "appointment_proposed", title: "Rendez-vous de suivi proposé",
          body: "Votre médecin vous propose un rendez-vous de suivi. Consultez votre espace NEXA pour réserver et payer le créneau.",
          url: "/rendez-vous.html?providerUid=" + encodeURIComponent(user.uid) + "&slotId=" + encodeURIComponent(slotId) + "&proposalId=" + encodeURIComponent(proposalId),
        };
      } else {
        await db.runTransaction(async (transaction) => {
          const [freshProvider, freshResult, freshGrant] = await Promise.all([
            transaction.get(providerRef), transaction.get(resultRef), transaction.get(grantRef),
          ]);
          assertDoctor(freshProvider, ApiError);
          if (!freshResult.exists || freshResult.get("providerUid") !== user.uid || freshResult.get("patientUid") !== patientUid || !freshGrant.exists ||
            freshGrant.get("providerUid") !== user.uid || freshGrant.get("patientUid") !== patientUid || freshGrant.get("status") !== "OPEN") {
            throw new ApiError(403, "follow-up-access-closed", "L’accès de suivi a déjà été fermé ou n’est plus autorisé.");
          }
          transaction.update(grantRef, { status: "CLOSED", closedAt: timestamp, closedBy: user.uid, updatedAt: timestamp });
          transaction.update(resultRef, { status: "FOLLOW_UP_CLOSED", followUpStatus: "CLOSED", updatedAt: timestamp });
          transaction.create(auditRef, {
            actorUid: user.uid, action: "prescriber_patient_result_follow_up_closed", resultId, createdAt: timestamp,
          });
        });
        notification = {
          eventKey: "patient-result:" + resultId + ":follow-up-closed",
          type: "patient_result_follow_up_closed", title: "Suivi médical terminé",
          body: "Le médecin prescripteur a terminé le suivi de ce résultat.",
          url: "/espace-patient.html#patient-results-section",
        };
        responsePayload.followUpStatus = "CLOSED";
      }

      if (notification) await createNexaNotification(patientUid, notification.eventKey, notification, appointmentId).catch((error) =>
        logger.warn("NEXA patient result follow-up notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
      return res.status(action === "close" || action === "review" ? 200 : 201).json(responsePayload);
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA patient result follow-up failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "patient-result-follow-up-failed", "Le suivi du résultat n’a pas pu être enregistré.");
    }
  });

  const nexaCleanupPatientResultUploads = onSchedule({
    schedule: "every 15 minutes", region: REGION, timeZone: "America/Port-au-Prince",
  }, async () => {
    const now = Timestamp.now();
    const sessions = await db.collection("patientResultUploadSessions")
      .where("status", "in", CLEANUP_SESSION_STATES)
      .where("cleanupComplete", "==", false)
      .orderBy("expiresAt", "asc")
      .limit(500)
      .get();
    for (const doc of sessions.docs) {
      if (millis(doc.get("expiresAt")) > now.toMillis()) continue;
      const data = doc.data() || {};
      const currentStatus = String(data.status || "");
      const terminal = !ACTIVE_SESSION_STATES.includes(currentStatus);
      const files = Array.isArray(data.files) ? data.files : [];
      const quarantinePaths = files.filter((file) =>
        file && file.storagePath === "nexa-patient-result-quarantine/" + doc.id + "/" + file.id)
        .map((file) => file.storagePath);
      const submittedPrefix = "nexa-patient-submitted-results/" + cleanText(data.patientUid, 200) + "/" +
        cleanText(data.resultId, 200) + "/";
      const failedFinalPaths = terminal && validId(cleanText(data.patientUid, 200), 10, 200) &&
        validId(cleanText(data.resultId, 200), 10, 200)
        ? files.filter((file) => file && validId(file.id, 10, 80)).map((file) => submittedPrefix + file.id)
        : [];
      await Promise.allSettled([...quarantinePaths, ...failedFinalPaths]
        .map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
      const claimRef = db.collection("patientResultClaims").doc(cleanText(data.claimId, 100));
      await db.runTransaction(async (transaction) => {
        const [session, claim] = await Promise.all([transaction.get(doc.ref), transaction.get(claimRef)]);
        if (!session.exists || millis(session.get("expiresAt")) > now.toMillis()) return;
        const state = String(session.get("status") || "");
        if (ACTIVE_SESSION_STATES.includes(state)) {
          transaction.update(doc.ref, {
            status: "EXPIRED", cleanupComplete: true, closedAt: FieldValue.serverTimestamp(),
          });
        } else if (CLEANUP_SESSION_STATES.includes(state) && session.get("cleanupComplete") !== true) {
          transaction.update(doc.ref, { cleanupComplete: true, cleanupCompletedAt: FieldValue.serverTimestamp() });
        } else {
          return;
        }
        if (ACTIVE_SESSION_STATES.includes(state) && claim.exists && claim.get("sessionId") === doc.id &&
          ["OPEN", "SCANNING"].includes(String(claim.get("status")))) {
          transaction.update(claimRef, { status: "AVAILABLE", sessionId: FieldValue.delete(), resultId: FieldValue.delete(), expiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
        }
      });
    }
  });

  return {
    nexaPatientDiagnosticResults,
    nexaPatientResultUploadStart,
    nexaPatientResultUploadCancel,
    nexaPatientResultSubmit,
    nexaPatientResultFile,
    nexaPatientDiagnosticCenterResultFile,
    nexaProviderPatientResults,
    nexaProviderPatientResultFile,
    nexaProviderPatientResultFollowUp,
    nexaCleanupPatientResultUploads,
  };
};

async function closeSession(db, sessionId, uid, status, FieldValue, Timestamp) {
  const sessionRef = db.collection("patientResultUploadSessions").doc(sessionId);
  await db.runTransaction(async (transaction) => {
    const session = await transaction.get(sessionRef);
    if (!session.exists || session.get("patientUid") !== uid || !ACTIVE_SESSION_STATES.includes(String(session.get("status")))) return;
    const claimRef = db.collection("patientResultClaims").doc(cleanText(session.get("claimId"), 100));
    const claim = await transaction.get(claimRef);
    transaction.update(sessionRef, {
      status, cleanupComplete: false, closedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(Date.now() + 15 * 60_000),
    });
    if (claim.exists && claim.get("sessionId") === sessionId) {
      transaction.update(claimRef, {
        status: "AVAILABLE", sessionId: FieldValue.delete(), resultId: FieldValue.delete(),
        expiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });
}
