"use strict";

const { createHash } = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");

const REGION = "us-east4";
const FINAL_STATUSES = new Set(["FINALIZED", "SIGNED"]);
const EDITABLE_APPOINTMENT_STATUSES = new Set(["IN_PROGRESS", "COMPLETED"]);
const TEXT_FIELDS = [
  "consultationReason", "history", "relevantHistory", "allergies", "currentTreatments",
  "symptoms", "clinicalObservations", "clinicalAssessment", "diagnoses", "carePlan",
  "recommendations", "followUp", "additionalNotes",
];
const VITAL_FIELDS = ["systolic", "diastolic", "heartRate", "respiratoryRate", "spo2", "glycemia", "temperature", "weight", "height"];
const HISTORY_PAGE_SIZE = 10;
const HISTORY_BATCH_SIZE = 20;
const HISTORY_MAX_SCAN = 100;
const HISTORY_FINAL_STATUSES = ["FINALIZED", "SIGNED"];

function getBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  if (!Buffer.isBuffer(req.rawBody)) return null;
  try {
    const value = JSON.parse(req.rawBody.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function cleanText(value, maximum) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim().slice(0, maximum);
}

function cleanContent(value, ApiError) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid-clinical-content", "Le contenu du dossier n’est pas valide.");
  }
  const result = {};
  for (const field of TEXT_FIELDS) result[field] = cleanText(value[field], 5_000);

  const sourceVitals = value.patientVitals && typeof value.patientVitals === "object" && !Array.isArray(value.patientVitals)
    ? value.patientVitals
    : {};
  const vitals = {};
  for (const field of VITAL_FIELDS) {
    const raw = sourceVitals[field];
    if (raw === "" || raw === null || raw === undefined) { vitals[field] = null; continue; }
    const number = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(number) || Math.abs(number) > 1_000_000) {
      throw new ApiError(400, "invalid-patient-vitals", "Vérifiez les signes vitaux saisis.");
    }
    vitals[field] = number;
  }
  if (Object.hasOwn(sourceVitals, "weightUnit")) vitals.weightUnit = cleanText(sourceVitals.weightUnit, 10) || "kg";
  if (Object.hasOwn(sourceVitals, "heightUnit")) vitals.heightUnit = cleanText(sourceVitals.heightUnit, 10) || "cm";
  result.patientVitals = vitals;

  result.medications = Array.isArray(value.medications) ? value.medications.slice(0, 50).map((raw) => {
    const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const quantity = item.quantity === "" || item.quantity == null ? null : Number(item.quantity);
    if (quantity !== null && (!Number.isFinite(quantity) || Math.abs(quantity) > 1_000_000)) {
      throw new ApiError(400, "invalid-medication-quantity", "Vérifiez les quantités de médicaments.");
    }
    return {
      name: cleanText(item.name, 180), dosage: cleanText(item.dosage, 120),
      form: cleanText(item.form, 120), route: cleanText(item.route, 120), quantity,
      instructions: cleanText(item.instructions, 300), duration: cleanText(item.duration, 120),
    };
  }).filter((item) => item.name) : [];
  for (const field of ["laboratoryTests", "imagingExams"]) {
    result[field] = Array.isArray(value[field]) ? value[field].slice(0, 50).map((item) => cleanText(item, 250)).filter(Boolean) : [];
  }
  return result;
}

function timestamp(value) {
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

function iso(value) {
  const time = timestamp(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function clinicalAccessWindow(appointment) {
  if (appointment.paymentStatus !== "PAID") return null;
  const status = String(appointment.status || "").toUpperCase();
  const closedHomeVisit = appointment.bookingType === "home_visit" && appointment.homeVisitMissionStatus === "COMPLETED" && status === "COMPLETED";
  const startedHomeVisit = appointment.bookingType === "home_visit" && ["CONFIRMED", "COMPLETED"].includes(status) && timestamp(appointment.effectiveConsultationStartedAt) > 0;
  const startedAtMs = startedHomeVisit ? timestamp(appointment.effectiveConsultationStartedAt)
    : closedHomeVisit ? timestamp(appointment.homeVisitMissionClosedAt)
    : EDITABLE_APPOINTMENT_STATUSES.has(status) ? timestamp(appointment.effectiveConsultationStartedAt) : Number.NaN;
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;
  return { startedAtMs, expiresAtMs: startedAtMs + 24 * 60 * 60_000 };
}

function editableAppointment(appointment) {
  const status = String(appointment.status || "").toUpperCase();
  return EDITABLE_APPOINTMENT_STATUSES.has(status) || (
    appointment.bookingType === "home_visit" && status === "CONFIRMED" &&
    appointment.paymentStatus === "PAID" && timestamp(appointment.effectiveConsultationStartedAt) > 0
  );
}

function activeClinicalAccess(appointment, now = Date.now()) {
  const window = clinicalAccessWindow(appointment);
  return Boolean(window && now >= window.startedAtMs && now < window.expiresAtMs);
}

function isFinal(status) {
  return FINAL_STATUSES.has(String(status || "").trim().toUpperCase());
}

function safeAttachments(value, recordId) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw;
    const id = typeof item.id === "string" ? item.id : "";
    const contentType = typeof item.contentType === "string" ? item.contentType.toLowerCase() : "";
    const size = Number(item.size);
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(id) || !["application/pdf", "image/jpeg", "image/png"].includes(contentType) ||
      !Number.isSafeInteger(size) || size < 1 || size > 15 * 1024 * 1024 || item.antivirusStatus !== "CLEAN" ||
      !/^[a-f0-9]{64}$/.test(String(item.sha256Hash || "")) ||
      item.storagePath !== "nexa-clinical-records/" + recordId + "/" + id) return [];
    return [{
      id, originalFileName: cleanText(item.originalFileName, 180) || "Pièce jointe clinique",
      contentType, size, sha256Hash: item.sha256Hash, uploadedAt: cleanText(item.uploadedAt, 80),
    }];
  });
}

function recordPayload(id, data, addenda = []) {
  return {
    appointmentId: data.appointmentId,
    recordNumber: data.recordNumber,
    patientNumber: data.patientNumber,
    providerName: data.providerName,
    specialtyName: data.specialtyName,
    status: data.status,
    version: Number(data.version) || 1,
    clinicalContent: data.clinicalContent || {},
    attachments: safeAttachments(data.attachments, id),
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
    finalizedAt: iso(data.finalizedAt),
    signature: data.signature || null,
    documentHash: data.documentHash || null,
    addendumCount: Number(data.addendumCount) || 0,
    addenda,
  };
}

function projectHistoryContent(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  for (const field of TEXT_FIELDS) result[field] = cleanText(source[field], 2_000);

  const sourceVitals = source.patientVitals && typeof source.patientVitals === "object" && !Array.isArray(source.patientVitals)
    ? source.patientVitals
    : {};
  const patientVitals = {};
  for (const field of VITAL_FIELDS) {
    patientVitals[field] = typeof sourceVitals[field] === "number" && Number.isFinite(sourceVitals[field])
      ? sourceVitals[field]
      : null;
  }
  for (const field of ["weightUnit", "heightUnit"]) {
    if (typeof sourceVitals[field] === "string") patientVitals[field] = cleanText(sourceVitals[field], 10);
  }
  result.patientVitals = patientVitals;

  result.medications = Array.isArray(source.medications) ? source.medications.slice(0, 20).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const medication = {
      name: cleanText(entry.name, 180),
      dosage: cleanText(entry.dosage, 120),
      form: cleanText(entry.form, 80),
      route: cleanText(entry.route, 80),
      quantity: typeof entry.quantity === "number" && Number.isFinite(entry.quantity) ? entry.quantity : null,
      instructions: cleanText(entry.instructions, 300),
      duration: cleanText(entry.duration, 120),
    };
    return medication.name ? [medication] : [];
  }) : [];
  for (const field of ["laboratoryTests", "imagingExams"]) {
    result[field] = Array.isArray(source[field]) ? source[field].slice(0, 20).map((item) => cleanText(item, 250)).filter(Boolean) : [];
  }
  return result;
}

function isSignedHistoryRecord(snapshot) {
  const data = snapshot.data() || {};
  const signature = data.signature && typeof data.signature === "object" && !Array.isArray(data.signature)
    ? data.signature
    : {};
  return HISTORY_FINAL_STATUSES.includes(data.status) &&
    typeof data.providerUid === "string" && data.providerUid.length > 0 &&
    signature.uid === data.providerUid && typeof signature.signedAt === "string" &&
    /^[a-f0-9]{64}$/i.test(String(data.documentHash || "")) && Boolean(data.finalizedAt);
}

async function projectHistoryRecord(snapshot) {
  const data = snapshot.data() || {};
  const signature = data.signature && typeof data.signature === "object" && !Array.isArray(data.signature)
    ? data.signature
    : {};
  const addendaSnapshot = await snapshot.ref.collection("addenda").orderBy("createdAt", "asc").limit(100).get();
  return {
    recordId: snapshot.id,
    recordNumber: cleanText(data.recordNumber, 100) || "Dossier clinique",
    recordType: data.recordType === "STANDALONE" ? "STANDALONE" : "APPOINTMENT",
    providerName: cleanText(data.providerName, 180) || "Médecin NEXA",
    specialtyName: cleanText(data.specialtyName, 160),
    finalizedAt: iso(data.finalizedAt),
    signature: {
      name: cleanText(signature.name, 180),
      specialty: cleanText(signature.specialty, 160),
      signedAt: cleanText(signature.signedAt, 80),
    },
    clinicalContent: projectHistoryContent(data.clinicalContent),
    addenda: addendaSnapshot.docs.flatMap((document) => {
      const addendum = document.data() || {};
      if (addendum.patientUid !== data.patientUid || addendum.providerUid !== data.providerUid) return [];
      return [{
        reason: cleanText(addendum.reason, 500),
        content: cleanText(addendum.content, 2_000),
        signatureName: cleanText(addendum.signatureName, 180),
        createdAt: iso(addendum.createdAt),
      }];
    }),
  };
}

async function listOtherPhysicianClinicalHistory({ db, patientUid, requestingProviderUid, excludeRecordId, cursor }) {
  const collection = db.collection("electronicPatientRecords");
  const baseQuery = collection
    .where("patientUid", "==", patientUid)
    .where("status", "in", HISTORY_FINAL_STATUSES)
    .orderBy("finalizedAt", "desc");
  let scanCursor = null;
  if (cursor) {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(cursor)) throw new Error("invalid-cursor");
    const candidate = await collection.doc(cursor).get();
    if (!candidate.exists || candidate.get("patientUid") !== patientUid || !isSignedHistoryRecord(candidate)) {
      throw new Error("invalid-cursor");
    }
    scanCursor = candidate;
  }

  const records = [];
  let scanned = 0;
  let lastBatchSize = 0;
  while (records.length < HISTORY_PAGE_SIZE + 1 && scanned < HISTORY_MAX_SCAN) {
    const batchLimit = Math.min(HISTORY_BATCH_SIZE, HISTORY_MAX_SCAN - scanned);
    let batchQuery = baseQuery.limit(batchLimit);
    if (scanCursor) batchQuery = batchQuery.startAfter(scanCursor);
    const batch = await batchQuery.get();
    lastBatchSize = batch.size;
    if (batch.empty) break;
    for (const document of batch.docs) {
      scanCursor = document;
      scanned += 1;
      if (document.id === excludeRecordId || document.get("providerUid") === requestingProviderUid || !isSignedHistoryRecord(document)) continue;
      records.push(document);
      if (records.length === HISTORY_PAGE_SIZE + 1 || scanned === HISTORY_MAX_SCAN) break;
    }
    if (batch.size < batchLimit || scanned >= HISTORY_MAX_SCAN) break;
  }

  const hasExtraRecord = records.length > HISTORY_PAGE_SIZE;
  const pageDocuments = records.slice(0, HISTORY_PAGE_SIZE);
  const page = await Promise.all(pageDocuments.map(projectHistoryRecord));
  const expectedLastBatchSize = Math.min(HISTORY_BATCH_SIZE, HISTORY_MAX_SCAN - (scanned - lastBatchSize));
  const canContinueAfterScan = !hasExtraRecord && scanned >= HISTORY_MAX_SCAN && lastBatchSize === expectedLastBatchSize;
  return {
    records: page,
    nextCursor: hasExtraRecord
      ? pageDocuments[pageDocuments.length - 1]?.id || null
      : canContinueAfterScan ? scanCursor?.id || null : null,
  };
}

function revisionRef(recordRef, version) {
  return recordRef.collection("versions").doc(String(version).padStart(8, "0"));
}

function revisionPayload(data, actorUid, changeType) {
  return {
    version: Number(data.version) || 1,
    status: data.status || "DRAFT",
    clinicalContent: data.clinicalContent || {},
    attachments: Array.isArray(data.attachments) ? data.attachments : [],
    actorUid,
    createdAt: data.updatedAt || data.createdAt,
    changeType,
    ...(data.signature ? { signature: data.signature } : {}),
    ...(data.documentHash ? { documentHash: data.documentHash } : {}),
  };
}

module.exports = function createNexaClinicalFunctions(dependencies) {
  const { db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger, createNexaNotification } = dependencies;

  async function requireDoctor(req, authenticatedUser = null) {
    const user = authenticatedUser || await requireUser(req);
    if (!authenticatedUser) await requireAppCheckToken(req);
    const provider = await db.collection("providerProfiles").doc(user.uid).get();
    if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
      throw new ApiError(403, "verified-doctor-required", "Le dossier est réservé au médecin NEXA vérifié associé à la consultation.");
    }
    const profile = provider.get("profile") && typeof provider.get("profile") === "object" && !Array.isArray(provider.get("profile"))
      ? provider.get("profile") : {};
    return { uid: user.uid, name: cleanText(profile.name || user.name || "Médecin NEXA", 180), specialty: cleanText(profile.specialty, 160) };
  }

  async function ensureRecord(appointmentId, doctor) {
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const providerRef = db.collection("providerProfiles").doc(doctor.uid);
    const recordRef = db.collection("electronicPatientRecords").doc(appointmentId);
    const auditRef = db.collection("clinicalAuditLogs").doc();
    await db.runTransaction(async (transaction) => {
      const appointmentSnapshot = await transaction.get(appointmentRef);
      if (!appointmentSnapshot.exists || appointmentSnapshot.get("providerUid") !== doctor.uid || appointmentSnapshot.get("providerType") !== "doctor") {
        throw new ApiError(404, "appointment-not-found", "Cette consultation n’est pas accessible.");
      }
      const appointment = appointmentSnapshot.data() || {};
      const providerSnapshot = await transaction.get(providerRef);
      if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) {
        throw new ApiError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à accéder aux dossiers.");
      }
      if (appointment.paymentStatus !== "PAID") throw new ApiError(409, "appointment-not-paid", "Le paiement confirmé est requis avant d’ouvrir le dossier.");
      if (!editableAppointment(appointment)) {
        throw new ApiError(409, "appointment-not-active", "Le dossier sera ouvert lorsque la séance aura démarré.");
      }
      if (!activeClinicalAccess(appointment)) throw new ApiError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée. Une nouvelle autorisation est nécessaire.");
      const patientUid = typeof appointment.patientUid === "string" ? appointment.patientUid : "";
      if (!patientUid) throw new ApiError(409, "patient-required", "Cette consultation n’est pas associée à un patient.");
      const patientRef = db.collection("patientProfiles").doc(patientUid);
      const [patientSnapshot, recordSnapshot] = await Promise.all([transaction.get(patientRef), transaction.get(recordRef)]);
      if (!patientSnapshot.exists || patientSnapshot.get("role") !== "patient" || !/^NMC-\d{7}$/.test(String(patientSnapshot.get("patientNumber") || ""))) {
        throw new ApiError(409, "patient-profile-incomplete", "Le profil patient associé à cette consultation n’est pas complet.");
      }
      if (recordSnapshot.exists) {
        if (recordSnapshot.get("patientUid") !== patientUid || recordSnapshot.get("providerUid") !== doctor.uid || recordSnapshot.get("appointmentId") !== appointmentId) {
          throw new ApiError(409, "record-link-conflict", "Le dossier lié à cette consultation ne peut pas être ouvert.");
        }
        return;
      }

      const initialContent = cleanContent({ consultationReason: appointment.reason || "" }, ApiError);
      const createdAt = FieldValue.serverTimestamp();
      transaction.create(revisionRef(recordRef, 1), {
        version: 1, status: "DRAFT", clinicalContent: initialContent, attachments: [], actorUid: doctor.uid,
        createdAt, changeType: "INITIAL",
      });
      transaction.create(recordRef, {
        appointmentId, patientUid, patientNumber: patientSnapshot.get("patientNumber"), providerUid: doctor.uid,
        providerName: doctor.name, specialtyName: doctor.specialty,
        recordNumber: `DEP-${new Date().getUTCFullYear()}-${appointmentId.toUpperCase()}`,
        status: "DRAFT", version: 1, clinicalContent: initialContent, attachments: [], addendumCount: 0,
        createdAt, updatedAt: createdAt, createdBy: doctor.uid, updatedBy: doctor.uid,
      });
      transaction.set(appointmentRef, {
        electronicPatientRecordId: appointmentId, electronicPatientRecordCreatedAt: createdAt,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.create(auditRef, {
        actorUid: doctor.uid, action: "clinical_record_created", appointmentId, recordId: appointmentId,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    return recordRef;
  }

  async function loadRecord(recordRef) {
    const snapshot = await recordRef.get();
    if (!snapshot.exists) throw new ApiError(404, "record-not-found", "Le dossier de consultation est introuvable.");
    const addendaSnapshot = await recordRef.collection("addenda").orderBy("createdAt", "desc").limit(100).get();
    const addenda = addendaSnapshot.docs.map((doc) => {
      const item = doc.data() || {};
      return {
        id: doc.id, reason: cleanText(item.reason, 500), content: cleanText(item.content, 5_000),
        signatureName: cleanText(item.signatureName, 180), createdAt: iso(item.createdAt),
      };
    });
    return recordPayload(snapshot.id, snapshot.data() || {}, addenda);
  }

  const nexaClinicalRecord = onRequest({ region: REGION }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) {
      res.set("Allow", "GET, POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if (req.method === "POST" && ((Number(req.get("Content-Length")) || 0) > 100_000 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 100_000))) {
      return fail(res, 413, "clinical-record-too-large", "Le dossier transmis est trop volumineux.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      const appointmentId = typeof req.query.appointmentId === "string" ? req.query.appointmentId.trim() : "";
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) throw new ApiError(400, "invalid-appointment", "La référence de consultation n’est pas valide.");
      const appointmentRef = db.collection("appointments").doc(appointmentId);
      const appointmentSnapshot = await appointmentRef.get();
      if (!appointmentSnapshot.exists) throw new ApiError(404, "appointment-not-found", "Cette consultation est introuvable.");
      const appointment = appointmentSnapshot.data() || {};
      const recordRef = db.collection("electronicPatientRecords").doc(appointmentId);
      res.set("Cache-Control", "no-store, max-age=0");

      if (req.method === "GET") {
        if (appointment.patientUid === user.uid) {
          await enforceUserRateLimit(user.uid, "clinical-record-read", 30, 5 * 60_000);
          const profile = await db.collection("patientProfiles").doc(user.uid).get();
          if (!profile.exists || profile.get("role") !== "patient") throw new ApiError(403, "patient-profile-required", "Accès patient NEXA requis.");
          const snapshot = await recordRef.get();
          if (!snapshot.exists) return res.status(200).json({ ok: true, view: "patient", record: null });
          const data = snapshot.data() || {};
          if (data.patientUid !== user.uid || data.appointmentId !== appointmentId || data.providerUid !== appointment.providerUid) {
            throw new ApiError(404, "record-not-found", "Le dossier de consultation est introuvable.");
          }
          if (!isFinal(data.status)) return res.status(200).json({ ok: true, view: "patient", record: null, pending: true });
          const addendaSnapshot = await recordRef.collection("addenda").orderBy("createdAt", "desc").limit(100).get();
          const auditRef = db.collection("clinicalAuditLogs").doc();
          await auditRef.create({ actorUid: user.uid, action: "patient_clinical_record_accessed", appointmentId, recordId: appointmentId, createdAt: FieldValue.serverTimestamp() });
          const signature = data.signature && typeof data.signature === "object" ? {
            name: cleanText(data.signature.name, 180), specialty: cleanText(data.signature.specialty, 160), signedAt: cleanText(data.signature.signedAt, 80),
          } : null;
          const addenda = addendaSnapshot.docs.map((doc) => ({ doc, data: doc.data() || {} }))
            .filter(({ data: item }) => item.patientUid === user.uid && item.providerUid === appointment.providerUid && item.appointmentId === appointmentId)
            .map(({ doc, data: item }) => ({ id: doc.id, reason: cleanText(item.reason, 500), content: cleanText(item.content, 5_000), signatureName: cleanText(item.signatureName, 180), createdAt: iso(item.createdAt) }));
          return res.status(200).json({ ok: true, view: "patient", record: {
            recordNumber: cleanText(data.recordNumber, 220), status: data.status,
            providerName: cleanText(data.providerName, 180), specialtyName: cleanText(data.specialtyName, 160),
            createdAt: iso(data.createdAt), finalizedAt: iso(data.finalizedAt),
            clinicalContent: cleanContent(data.clinicalContent || {}, ApiError),
            attachments: safeAttachments(data.attachments, appointmentId), appointmentId, signature, addenda,
          } });
        }

        const doctor = await requireDoctor(req, user);
        if (appointment.providerUid !== user.uid) throw new ApiError(403, "forbidden", "Vous ne participez pas à cette consultation.");
        await enforceUserRateLimit(doctor.uid, "clinical-record-read", 30, 5 * 60_000);
        await ensureRecord(appointmentId, doctor);
        const freshAppointment = await appointmentRef.get();
        if (!freshAppointment.exists || !activeClinicalAccess(freshAppointment.data() || {})) throw new ApiError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée.");
        const auditRef = db.collection("clinicalAuditLogs").doc();
        await auditRef.create({ actorUid: doctor.uid, action: "doctor_clinical_record_accessed", appointmentId, recordId: appointmentId, createdAt: FieldValue.serverTimestamp() });
        return res.status(200).json({ ok: true, view: "provider", clinicalAccessExpiresAt: new Date(clinicalAccessWindow(freshAppointment.data()).expiresAtMs).toISOString(), record: await loadRecord(recordRef) });
      }

      const doctor = await requireDoctor(req, user);
      await enforceUserRateLimit(doctor.uid, "clinical-record-write", 30, 5 * 60_000);
      const input = getBody(req);
      if (!input || Object.keys(input).some((key) => !["action", "clinicalContent", "content", "reason"].includes(key))) {
        throw new ApiError(400, "invalid-request", "La demande de dossier clinique n’est pas valide.");
      }
      const action = typeof input.action === "string" ? input.action : "";
      if (!["saveDraft", "finalize", "addendum"].includes(action)) throw new ApiError(400, "invalid-record-action", "Choisissez une action valide pour le dossier.");
      await ensureRecord(appointmentId, doctor);
      const auditRef = db.collection("clinicalAuditLogs").doc();
      const signatureName = doctor.name || "Médecin NEXA";

      if (action === "saveDraft" || action === "finalize") {
        const content = cleanContent(input.clinicalContent, ApiError);
        if (action === "finalize" && !["consultationReason", "clinicalObservations", "clinicalAssessment", "carePlan"].some((field) => Boolean(content[field]))) {
          throw new ApiError(400, "clinical-content-required", "Ajoutez le motif, les observations, l’évaluation ou la conduite à tenir avant de finaliser le dossier.");
        }
        await db.runTransaction(async (transaction) => {
          const providerRef = db.collection("providerProfiles").doc(doctor.uid);
          const [appointmentFresh, recordSnapshot, providerSnapshot] = await Promise.all([transaction.get(appointmentRef), transaction.get(recordRef), transaction.get(providerRef)]);
          if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) throw new ApiError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à accéder aux dossiers.");
          if (!appointmentFresh.exists || appointmentFresh.get("providerUid") !== doctor.uid || appointmentFresh.get("providerType") !== "doctor" || appointmentFresh.get("paymentStatus") !== "PAID") throw new ApiError(404, "appointment-not-found", "Cette consultation n’est pas accessible.");
          const appointmentData = appointmentFresh.data() || {};
          if (!editableAppointment(appointmentData)) throw new ApiError(409, "appointment-not-active", "Le dossier ne peut être modifié avant le démarrage de la séance.");
          if (!activeClinicalAccess(appointmentData)) throw new ApiError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée. Une nouvelle autorisation est nécessaire.");
          if (!recordSnapshot.exists || recordSnapshot.get("providerUid") !== doctor.uid || recordSnapshot.get("patientUid") !== appointmentFresh.get("patientUid")) throw new ApiError(404, "record-not-found", "Le dossier de consultation est introuvable.");
          const data = recordSnapshot.data() || {};
          if (isFinal(data.status)) throw new ApiError(409, "record-immutable", "Ce dossier est finalisé. Ajoutez une correction à son historique.");
          const version = (Number(data.version) || 1) + 1;
          const nowIso = new Date().toISOString();
          const signature = action === "finalize" ? { uid: doctor.uid, name: signatureName, specialty: doctor.specialty, signedAt: nowIso } : null;
          const attachments = Array.isArray(data.attachments) ? data.attachments : [];
          const documentHash = action === "finalize" ? createHash("sha256").update(JSON.stringify({
            appointmentId, providerUid: doctor.uid, patientUid: data.patientUid, version, content,
            attachments: safeAttachments(attachments, appointmentId).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), signatureName, signedAt: nowIso,
          })).digest("hex") : null;
          const currentRef = revisionRef(recordRef, Number(data.version) || 1);
          const nextRef = revisionRef(recordRef, version);
          const [currentRevision, nextRevision] = await Promise.all([transaction.get(currentRef), transaction.get(nextRef)]);
          if (nextRevision.exists) throw new ApiError(409, "record-version-conflict", "Une autre mise à jour du dossier vient d’être enregistrée. Rechargez la page.");
          if (!currentRevision.exists) transaction.create(currentRef, revisionPayload(data, typeof data.updatedBy === "string" ? data.updatedBy : doctor.uid, "INITIAL"));
          const status = action === "finalize" ? "FINALIZED" : "DRAFT";
          transaction.create(nextRef, {
            version, status, clinicalContent: content, attachments, actorUid: doctor.uid,
            createdAt: FieldValue.serverTimestamp(), changeType: action === "finalize" ? "FINALIZED" : "DRAFT_SAVED",
            ...(signature ? { signature, documentHash } : {}),
          });
          transaction.set(recordRef, {
            clinicalContent: content, status, version, updatedBy: doctor.uid, updatedAt: FieldValue.serverTimestamp(),
            ...(action === "finalize" ? { signedAt: FieldValue.serverTimestamp(), finalizedAt: FieldValue.serverTimestamp(), signature, documentHash } : {}),
          }, { merge: true });
          transaction.create(auditRef, { actorUid: doctor.uid, action: action === "finalize" ? "clinical_record_finalized" : "clinical_record_draft_updated", appointmentId, recordId: appointmentId, version, createdAt: FieldValue.serverTimestamp() });
        });
      } else {
        const content = cleanText(input.content, 5_000);
        const reason = cleanText(input.reason, 500);
        if (!content) throw new ApiError(400, "addendum-content-required", "Le contenu de la correction est requis.");
        const addendumRef = recordRef.collection("addenda").doc();
        await db.runTransaction(async (transaction) => {
          const providerRef = db.collection("providerProfiles").doc(doctor.uid);
          const [appointmentFresh, recordSnapshot, providerSnapshot] = await Promise.all([transaction.get(appointmentRef), transaction.get(recordRef), transaction.get(providerRef)]);
          if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) throw new ApiError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à accéder aux dossiers.");
          if (!appointmentFresh.exists || appointmentFresh.get("providerUid") !== doctor.uid || appointmentFresh.get("providerType") !== "doctor" || appointmentFresh.get("paymentStatus") !== "PAID") throw new ApiError(404, "appointment-not-found", "Cette consultation n’est pas accessible.");
          if (!activeClinicalAccess(appointmentFresh.data() || {})) throw new ApiError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée.");
          if (!recordSnapshot.exists || recordSnapshot.get("providerUid") !== doctor.uid || recordSnapshot.get("patientUid") !== appointmentFresh.get("patientUid") || !isFinal(recordSnapshot.get("status"))) throw new ApiError(409, "record-not-finalized", "Finalisez le dossier avant d’ajouter une correction.");
          transaction.create(addendumRef, { appointmentId, providerUid: doctor.uid, patientUid: recordSnapshot.get("patientUid"), reason, content, signatureName, createdAt: FieldValue.serverTimestamp() });
          transaction.set(recordRef, { addendumCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp(), updatedBy: doctor.uid }, { merge: true });
          transaction.create(auditRef, { actorUid: doctor.uid, action: "clinical_record_addendum_created", appointmentId, recordId: appointmentId, createdAt: FieldValue.serverTimestamp() });
        });
      }

      if (action === "finalize") {
        const latest = await db.collection("appointments").doc(appointmentId).get();
        const patientUid = latest.exists ? String(latest.get("patientUid") || "") : "";
        if (patientUid && typeof createNexaNotification === "function") {
          await createNexaNotification(patientUid, `clinical-record:${appointmentId}:finalized`, {
            type: "clinical_record_finalized", title: "Compte rendu médical disponible",
            body: "Votre médecin a finalisé le compte rendu de votre consultation.", url: "/espace-patient.html",
          }, appointmentId).catch((error) => logger.warn("NEXA clinical record notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
        }
      }
      return res.status(200).json({ ok: true, record: await loadRecord(recordRef) });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA clinical record request failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "clinical-record-unavailable", "Le dossier de consultation n’est pas accessible pour le moment.");
    }
  });

  const nexaClinicalHistory = onRequest({ region: REGION }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") {
      res.set("Allow", "GET, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "clinical-history-read", 20, 5 * 60_000);
      const appointmentId = typeof req.query.appointmentId === "string" ? req.query.appointmentId.trim() : "";
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) {
        throw new ApiError(400, "invalid-appointment", "La référence de consultation n’est pas valide.");
      }
      const cursor = typeof req.query.cursor === "string" ? req.query.cursor : "";
      const appointmentRef = db.collection("appointments").doc(appointmentId);
      const providerRef = db.collection("providerProfiles").doc(user.uid);
      const [appointmentSnapshot, providerSnapshot] = await Promise.all([appointmentRef.get(), providerRef.get()]);
      if (!appointmentSnapshot.exists || appointmentSnapshot.get("providerUid") !== user.uid || appointmentSnapshot.get("providerType") !== "doctor") {
        throw new ApiError(403, "consultation-not-authorized", "L’historique est réservé au médecin associé à cette consultation.");
      }
      if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) {
        throw new ApiError(403, "verified-doctor-required", "Un profil médecin NEXA vérifié est requis.");
      }
      const appointment = appointmentSnapshot.data() || {};
      if (appointment.paymentStatus !== "PAID" || !activeClinicalAccess(appointment)) {
        throw new ApiError(403, "clinical-access-expired", "L’historique est disponible uniquement pendant l’accès clinique actif d’une consultation payée.");
      }
      const patientUid = typeof appointment.patientUid === "string" ? appointment.patientUid : "";
      if (!patientUid) throw new ApiError(409, "patient-required", "Cette consultation n’est pas associée à un profil patient.");

      let page;
      try {
        page = await listOtherPhysicianClinicalHistory({
          db,
          patientUid,
          requestingProviderUid: user.uid,
          excludeRecordId: appointmentId,
          cursor: cursor || undefined,
        });
      } catch (error) {
        if (error instanceof Error && error.message === "invalid-cursor") {
          throw new ApiError(400, "invalid-history-cursor", "Le curseur de pagination n’est pas valide pour ce dossier.");
        }
        throw error;
      }

      const [freshAppointmentSnapshot, freshProviderSnapshot] = await Promise.all([appointmentRef.get(), providerRef.get()]);
      const freshAppointment = freshAppointmentSnapshot.data() || {};
      if (!freshAppointmentSnapshot.exists || freshAppointment.providerUid !== user.uid || freshAppointment.providerType !== "doctor" ||
          freshAppointment.patientUid !== patientUid || freshAppointment.paymentStatus !== "PAID" || !activeClinicalAccess(freshAppointment) ||
          !freshProviderSnapshot.exists || freshProviderSnapshot.get("status") !== "verified" || freshProviderSnapshot.get("type") !== "doctor" || freshProviderSnapshot.get("clinicalCredentialsVerified") !== true) {
        throw new ApiError(403, "clinical-access-expired", "L’autorisation d’accès clinique a expiré.");
      }

      await db.collection("clinicalAuditLogs").doc().create({
        actorUid: user.uid,
        action: "prior_clinical_history_accessed",
        appointmentId,
        recordCount: page.records.length,
        hasMore: Boolean(page.nextCursor),
        createdAt: FieldValue.serverTimestamp(),
      });
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, ...page });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA clinical history request failed", {
        errorName: error instanceof Error ? error.name : "unknown-error",
      });
      return fail(res, 500, "clinical-history-unavailable", "L’historique clinique n’est pas accessible pour le moment.");
    }
  });

  return { nexaClinicalRecord, nexaClinicalHistory };
};
