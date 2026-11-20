"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { Timestamp } = require("firebase-admin/firestore");
const { onRequest } = require("firebase-functions/v2/https");

const REGION = "us-east4";
const STANDALONE_ACCESS_MS = 24 * 60 * 60_000;
const FINAL_STATUSES = new Set(["FINALIZED", "SIGNED"]);
const TEXT_FIELDS = [
  "consultationReason", "history", "relevantHistory", "allergies", "currentTreatments",
  "symptoms", "clinicalObservations", "clinicalAssessment", "diagnoses", "carePlan",
  "recommendations", "followUp", "additionalNotes",
];
const VITAL_FIELDS = ["systolic", "diastolic", "heartRate", "respiratoryRate", "spo2", "glycemia", "temperature", "weight", "height"];

function clean(value, maximum) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum) : "";
}

function timestamp(value) {
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(String(value || ""));
}

function iso(value) {
  const milliseconds = timestamp(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function safeAttachments(value, recordId) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const id = typeof entry.id === "string" ? entry.id : "";
    const contentType = typeof entry.contentType === "string" ? entry.contentType.toLowerCase() : "";
    const size = Number(entry.size);
    const sha256Hash = typeof entry.sha256Hash === "string" ? entry.sha256Hash : "";
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(id) ||
      !["application/pdf", "image/jpeg", "image/png"].includes(contentType) ||
      !Number.isSafeInteger(size) || size < 1 || size > 15 * 1024 * 1024 ||
      entry.antivirusStatus !== "CLEAN" || !/^[a-f0-9]{64}$/.test(sha256Hash) ||
      entry.storagePath !== "nexa-clinical-records/" + recordId + "/" + id) return [];
    return [{
      id,
      originalFileName: clean(entry.originalFileName, 180) || "Pièce jointe clinique",
      contentType,
      size,
      sha256Hash,
      uploadedAt: clean(entry.uploadedAt, 80),
    }];
  });
}

function activeStandaloneAccess(record, now = Date.now()) {
  const grantedAt = timestamp(record.accessGrantedAt);
  const expiresAt = timestamp(record.accessExpiresAt);
  return record.accessRevoked !== true && Number.isFinite(grantedAt) && Number.isFinite(expiresAt) &&
    grantedAt > 0 && now >= grantedAt && now < expiresAt;
}

function readBody(req, maximumBytes) {
  if (Buffer.isBuffer(req.rawBody) && req.rawBody.byteLength > maximumBytes) return { tooLarge: true };
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return { value: req.body };
  if (!Buffer.isBuffer(req.rawBody)) return { value: null };
  try {
    const parsed = JSON.parse(req.rawBody.toString("utf8"));
    return { value: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null };
  } catch {
    return { value: null };
  }
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

module.exports = function createNexaStandaloneRecordFunctions(dependencies) {
  const { db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger, createNexaNotification } = dependencies;

  async function requireDoctor(uid) {
    const provider = await db.collection("providerProfiles").doc(uid).get();
    if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
      throw new ApiError(403, "verified-doctor-required", "La gestion des dossiers autonomes est réservée aux médecins NEXA vérifiés.");
    }
    const profile = provider.get("profile") && typeof provider.get("profile") === "object" && !Array.isArray(provider.get("profile"))
      ? provider.get("profile")
      : {};
    return {
      uid,
      name: clean(profile.name || "Médecin NEXA", 180) || "Médecin NEXA",
      specialty: clean(profile.specialty, 160),
    };
  }

  function cleanClinicalContent(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ApiError(400, "invalid-clinical-content", "Le contenu du dossier n’est pas valide.");
    }
    const result = {};
    for (const field of TEXT_FIELDS) result[field] = clean(value[field], 5_000);
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
    if (typeof sourceVitals.weightUnit === "string") vitals.weightUnit = clean(sourceVitals.weightUnit, 10) || "kg";
    if (typeof sourceVitals.heightUnit === "string") vitals.heightUnit = clean(sourceVitals.heightUnit, 10) || "cm";
    result.patientVitals = vitals;
    result.medications = Array.isArray(value.medications) ? value.medications.slice(0, 50).flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const quantity = entry.quantity === "" || entry.quantity == null ? null : Number(entry.quantity);
      if (quantity !== null && (!Number.isFinite(quantity) || quantity < 0 || quantity > 1_000_000)) {
        throw new ApiError(400, "invalid-medication-quantity", "Vérifiez les quantités de médicaments.");
      }
      const medication = {
        name: clean(entry.name, 180), dosage: clean(entry.dosage, 120), form: clean(entry.form, 120),
        route: clean(entry.route, 120), quantity, instructions: clean(entry.instructions, 300), duration: clean(entry.duration, 120),
      };
      return medication.name ? [medication] : [];
    }) : [];
    for (const field of ["laboratoryTests", "imagingExams"]) {
      result[field] = Array.isArray(value[field]) ? value[field].slice(0, 50).map((item) => clean(item, 250)).filter(Boolean) : [];
    }
    return result;
  }

  function projectClinicalContent(value) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const result = {};
    for (const field of TEXT_FIELDS) result[field] = clean(source[field], 5_000);
    const sourceVitals = source.patientVitals && typeof source.patientVitals === "object" && !Array.isArray(source.patientVitals)
      ? source.patientVitals
      : {};
    const vitals = {};
    for (const field of VITAL_FIELDS) vitals[field] = typeof sourceVitals[field] === "number" && Number.isFinite(sourceVitals[field]) ? sourceVitals[field] : null;
    for (const field of ["weightUnit", "heightUnit"]) if (typeof sourceVitals[field] === "string") vitals[field] = clean(sourceVitals[field], 10);
    result.patientVitals = vitals;
    result.medications = Array.isArray(source.medications) ? source.medications.slice(0, 50).flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const item = {
        name: clean(entry.name, 180), dosage: clean(entry.dosage, 120), form: clean(entry.form, 120), route: clean(entry.route, 120),
        quantity: typeof entry.quantity === "number" && Number.isFinite(entry.quantity) ? entry.quantity : null,
        instructions: clean(entry.instructions, 300), duration: clean(entry.duration, 120),
      };
      return item.name ? [item] : [];
    }) : [];
    for (const field of ["laboratoryTests", "imagingExams"]) {
      result[field] = Array.isArray(source[field]) ? source[field].slice(0, 50).map((item) => clean(item, 250)).filter(Boolean) : [];
    }
    return result;
  }

  async function loadRecord(recordId, providerUid) {
    const recordRef = db.collection("electronicPatientRecords").doc(recordId);
    const snapshot = await recordRef.get();
    if (!snapshot.exists || snapshot.get("recordType") !== "STANDALONE" || snapshot.get("providerUid") !== providerUid) {
      throw new ApiError(404, "clinical-record-not-found", "Ce dossier clinique autonome n’est pas accessible.");
    }
    const data = snapshot.data() || {};
    if (!activeStandaloneAccess(data)) throw new ApiError(403, "clinical-access-expired", "L’autorisation patient a expiré ou a été révoquée. Un nouveau code est nécessaire.");
    const addendaSnapshot = await recordRef.collection("addenda").orderBy("createdAt", "asc").limit(100).get();
    const signature = data.signature && typeof data.signature === "object" && !Array.isArray(data.signature) ? data.signature : {};
    const addenda = addendaSnapshot.docs.flatMap((document) => {
      const item = document.data() || {};
      if (item.recordId !== recordId || item.patientUid !== data.patientUid || item.providerUid !== providerUid) return [];
      return [{
        id: document.id,
        reason: clean(item.reason, 500),
        content: clean(item.content, 5_000),
        signatureName: clean(item.signatureName, 180),
        createdAt: iso(item.createdAt),
      }];
    });
    return {
      recordId,
      recordType: "STANDALONE",
      recordNumber: clean(data.recordNumber, 100),
      patientNumber: clean(data.patientNumber, 32),
      patientName: clean(data.patientName, 100) || "Patient NEXA",
      providerName: clean(data.providerName, 180),
      specialtyName: clean(data.specialtyName, 160),
      status: clean(data.status, 30) || "DRAFT",
      version: Number(data.version) || 1,
      clinicalContent: projectClinicalContent(data.clinicalContent),
      attachments: safeAttachments(data.attachments, recordId),
      createdAt: iso(data.createdAt),
      updatedAt: iso(data.updatedAt),
      accessExpiresAt: iso(data.accessExpiresAt),
      finalizedAt: iso(data.finalizedAt),
      signature: signature.name ? { name: clean(signature.name, 180), specialty: clean(signature.specialty, 160), signedAt: clean(signature.signedAt, 80) } : null,
      documentHash: /^[a-f0-9]{64}$/i.test(String(data.documentHash || "")) ? String(data.documentHash) : null,
      addendumCount: Number(data.addendumCount) || 0,
      addenda,
    };
  }

  const nexaProviderClinicalRecords = onRequest({ region: REGION }, async (req, res) => {
    res.set("Cache-Control", "no-store, max-age=0");
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) {
      res.set("Allow", "GET, POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      const doctor = await requireDoctor(user.uid);
      if (req.method === "GET") {
        await enforceUserRateLimit(user.uid, "provider-clinical-record-library", 20, 5 * 60_000);
        const snapshot = await db.collection("electronicPatientRecords").where("providerUid", "==", user.uid).limit(200).get();
        const records = snapshot.docs.flatMap((document) => {
          const data = document.data() || {};
          if (data.recordType !== "STANDALONE" || typeof data.patientUid !== "string" || !data.patientNumber || !data.recordNumber || !activeStandaloneAccess(data)) return [];
          return [{
            recordId: document.id,
            recordNumber: clean(data.recordNumber, 100),
            patientNumber: clean(data.patientNumber, 32),
            patientName: clean(data.patientName, 100) || "Patient NEXA",
            createdAt: iso(data.createdAt),
            status: clean(data.status, 30) || "DRAFT",
            specialtyName: clean(data.specialtyName, 120),
            accessExpiresAt: iso(data.accessExpiresAt),
          }];
        }).sort((left, right) => Date.parse(right.createdAt || "") - Date.parse(left.createdAt || ""));
        await db.collection("clinicalAuditLogs").doc().create({
          actorUid: user.uid,
          action: "provider_standalone_clinical_record_library_accessed",
          recordCount: records.length,
          createdAt: FieldValue.serverTimestamp(),
        });
        return res.status(200).json({ ok: true, records });
      }

      await enforceUserRateLimit(user.uid, "provider-clinical-record-create", 8, 10 * 60_000);
      const parsed = readBody(req, 2_000);
      if (parsed.tooLarge) throw new ApiError(413, "request-too-large", "La demande est trop volumineuse.");
      const input = parsed.value;
      if (!input || Object.keys(input).some((key) => !["patientNumber", "accessCode"].includes(key))) {
        throw new ApiError(400, "invalid-request", "Saisissez uniquement le numéro patient et le code d’autorisation.");
      }
      const patientNumber = clean(input.patientNumber, 32).toUpperCase();
      const accessCode = clean(input.accessCode, 64);
      if (!/^NMC-\d{7}$/.test(patientNumber)) throw new ApiError(400, "invalid-patient-number", "Saisissez un numéro patient au format NMC-0000001.");
      if (!/^[A-Za-z0-9_-]{32}$/.test(accessCode)) throw new ApiError(400, "patient-authorization-required", "Un code d’autorisation patient valide est requis. Le numéro NMC seul ne donne aucun accès.");

      const codeHash = createHash("sha256").update(accessCode).digest("hex");
      const codeIndexRef = db.collection("clinicalAccessCodeIndex").doc(codeHash);
      const indexRef = db.collection("patientNumberIndex").doc(patientNumber);
      const counterRef = db.collection("systemCounters").doc("clinicalRecordNumbers");
      const providerRef = db.collection("providerProfiles").doc(user.uid);
      const recordRef = db.collection("electronicPatientRecords").doc();
      const auditRef = db.collection("clinicalAuditLogs").doc();
      let recordId = recordRef.id;
      let recordNumber = "";
      let patientName = "Patient NEXA";
      let recordStatus = "DRAFT";
      let claimedAccessExpiresAt = 0;
      let created = false;

      await db.runTransaction(async (transaction) => {
        const codeIndex = await transaction.get(codeIndexRef);
        if (!codeIndex.exists || codeIndex.get("providerUid") !== user.uid || !["ISSUED", "CLAIMED"].includes(String(codeIndex.get("status") || ""))) {
          throw new ApiError(404, "patient-authorization-not-found", "Cette autorisation patient n’est pas disponible.");
        }
        const grantId = typeof codeIndex.get("grantId") === "string" ? codeIndex.get("grantId") : "";
        if (!/^[0-9a-f-]{36}$/i.test(grantId)) throw new ApiError(404, "patient-authorization-not-found", "Cette autorisation patient n’est pas disponible.");
        const grantRef = db.collection("clinicalAccessGrants").doc(grantId);
        const [grant, patientIndex, providerSnapshot] = await Promise.all([
          transaction.get(grantRef), transaction.get(indexRef), transaction.get(providerRef),
        ]);
        if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) {
          throw new ApiError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à créer un dossier.");
        }
        const patientUid = patientIndex.exists && typeof patientIndex.get("uid") === "string" ? patientIndex.get("uid") : "";
        if (!patientUid || !grant.exists || grant.get("patientUid") !== patientUid || grant.get("patientNumber") !== patientNumber || grant.get("providerUid") !== user.uid || grant.get("accessCodeHash") !== codeHash) {
          throw new ApiError(404, "patient-authorization-not-found", "Cette autorisation patient ne correspond pas au numéro indiqué.");
        }
        const patientRef = db.collection("patientProfiles").doc(patientUid);
        const patientSnapshot = await transaction.get(patientRef);
        if (!patientSnapshot.exists || patientSnapshot.get("role") !== "patient" || patientSnapshot.get("profileComplete") !== true || patientSnapshot.get("patientNumber") !== patientNumber) {
          throw new ApiError(404, "patient-not-found", "Aucun profil patient complet ne correspond à ce numéro.");
        }
        const providerProfile = providerSnapshot.get("profile") && typeof providerSnapshot.get("profile") === "object" && !Array.isArray(providerSnapshot.get("profile"))
          ? providerSnapshot.get("profile")
          : {};
        const providerName = clean(providerProfile.name || doctor.name, 180) || "Médecin NEXA";
        const providerSpecialty = clean(providerProfile.specialty || doctor.specialty, 160);
        const profile = patientSnapshot.data() || {};
        patientName = clean(profile.displayName || `${profile.firstName || ""} ${profile.lastName || ""}`.trim(), 100) || "Patient NEXA";

        if (codeIndex.get("status") === "CLAIMED") {
          const existingId = typeof grant.get("claimedRecordId") === "string" ? grant.get("claimedRecordId") : "";
          if (grant.get("status") !== "CLAIMED" || grant.get("claimedBy") !== user.uid || !/^[A-Za-z0-9_-]{10,200}$/.test(existingId)) {
            throw new ApiError(409, "patient-authorization-used", "Cette autorisation ne peut pas être réutilisée.");
          }
          const existingRef = db.collection("electronicPatientRecords").doc(existingId);
          const existing = await transaction.get(existingRef);
          const data = existing.data() || {};
          if (!existing.exists || data.recordType !== "STANDALONE" || data.providerUid !== user.uid || data.patientUid !== patientUid || data.patientNumber !== patientNumber || data.accessGrantId !== grantId || !activeStandaloneAccess(data)) {
            throw new ApiError(403, "clinical-access-expired", "Cette autorisation clinique a expiré ou a été révoquée. Demandez un nouveau code au patient.");
          }
          recordId = existingId;
          recordNumber = clean(data.recordNumber, 100);
          patientName = clean(data.patientName, 100) || patientName;
          recordStatus = clean(data.status, 30) || "DRAFT";
          claimedAccessExpiresAt = timestamp(data.accessExpiresAt);
          return;
        }

        if (grant.get("status") !== "ISSUED" || timestamp(grant.get("expiresAt")) <= Date.now()) {
          throw new ApiError(409, "patient-authorization-expired", "Le code patient a expiré. Demandez une nouvelle autorisation.");
        }
        const counterSnapshot = await transaction.get(counterRef);
        const last = counterSnapshot.exists ? counterSnapshot.get("lastIssuedNumber") : 0;
        if (typeof last !== "number" || !Number.isSafeInteger(last) || last < 0 || last >= 9_999_999) {
          throw new ApiError(503, "record-number-unavailable", "La numérotation des dossiers est indisponible.");
        }
        const sequence = last + 1;
        recordNumber = `NEXA-${new Date().getUTCFullYear()}-${String(sequence).padStart(7, "0")}`;
        const accessGrantedAt = Date.now();
        claimedAccessExpiresAt = accessGrantedAt + STANDALONE_ACCESS_MS;
        const initialContent = {};
        transaction.create(revisionRef(recordRef, 1), {
          version: 1,
          status: "DRAFT",
          clinicalContent: initialContent,
          attachments: [],
          actorUid: user.uid,
          createdAt: FieldValue.serverTimestamp(),
          changeType: "INITIAL",
        });
        transaction.create(recordRef, {
          recordId: recordRef.id,
          recordType: "STANDALONE",
          patientUid,
          patientNumber,
          patientName,
          providerUid: user.uid,
          providerName,
          specialtyName: providerSpecialty,
          recordNumber,
          status: "DRAFT",
          version: 1,
          clinicalContent: initialContent,
          attachments: [],
          addendumCount: 0,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          createdBy: user.uid,
          updatedBy: user.uid,
          accessGrantId: grantId,
          accessGrantedAt: Timestamp.fromMillis(accessGrantedAt),
          accessExpiresAt: Timestamp.fromMillis(claimedAccessExpiresAt),
          accessRevoked: false,
        });
        transaction.set(counterRef, { lastIssuedNumber: sequence, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        transaction.set(grantRef, {
          status: "CLAIMED",
          claimedBy: user.uid,
          claimedRecordId: recordRef.id,
          claimedAt: FieldValue.serverTimestamp(),
          accessExpiresAt: Timestamp.fromMillis(claimedAccessExpiresAt),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.set(codeIndexRef, { status: "CLAIMED", claimedAt: FieldValue.serverTimestamp(), claimedRecordId: recordRef.id }, { merge: true });
        transaction.create(auditRef, { actorUid: user.uid, action: "standalone_clinical_record_created", recordId: recordRef.id, createdAt: FieldValue.serverTimestamp() });
        created = true;
      });

      return res.status(created ? 201 : 200).json({
        ok: true,
        created,
        recordId,
        recordNumber,
        patientNumber,
        patientName,
        status: recordStatus,
        accessExpiresAt: claimedAccessExpiresAt ? new Date(claimedAccessExpiresAt).toISOString() : null,
      });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA provider clinical record library failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "provider-clinical-records-unavailable", "La bibliothèque des dossiers cliniques n’est pas accessible.");
    }
  });

  const nexaStandaloneClinicalRecord = onRequest({ region: REGION }, async (req, res) => {
    res.set("Cache-Control", "no-store, max-age=0");
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) {
      res.set("Allow", "GET, POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      const doctor = await requireDoctor(user.uid);
      if (req.method === "GET") {
        await enforceUserRateLimit(user.uid, "standalone-clinical-record-read", 30, 5 * 60_000);
        const recordId = typeof req.query.recordId === "string" ? req.query.recordId.trim() : "";
        if (!/^[A-Za-z0-9_-]{10,200}$/.test(recordId)) throw new ApiError(400, "invalid-record-id", "La référence du dossier n’est pas valide.");
        const record = await loadRecord(recordId, user.uid);
        await db.collection("clinicalAuditLogs").doc().create({ actorUid: user.uid, action: "standalone_clinical_record_accessed", recordId, createdAt: FieldValue.serverTimestamp() });
        return res.status(200).json({ ok: true, view: "provider", record });
      }

      await enforceUserRateLimit(user.uid, "standalone-clinical-record-write", 30, 5 * 60_000);
      const parsed = readBody(req, 100_000);
      if (parsed.tooLarge) throw new ApiError(413, "clinical-record-too-large", "Le dossier transmis est trop volumineux.");
      const input = parsed.value;
      if (!input || Object.keys(input).some((key) => !["recordId", "action", "clinicalContent", "content", "reason"].includes(key))) {
        throw new ApiError(400, "invalid-request", "La demande de dossier n’est pas valide.");
      }
      const recordId = typeof input.recordId === "string" ? input.recordId.trim() : "";
      const action = typeof input.action === "string" ? input.action : "";
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(recordId)) throw new ApiError(400, "invalid-record-id", "La référence du dossier n’est pas valide.");
      if (!["saveDraft", "finalize", "addendum"].includes(action)) throw new ApiError(400, "invalid-record-action", "Choisissez une action valide pour le dossier.");
      const recordRef = db.collection("electronicPatientRecords").doc(recordId);
      const providerRef = db.collection("providerProfiles").doc(user.uid);
      const auditRef = db.collection("clinicalAuditLogs").doc();

      if (action === "saveDraft" || action === "finalize") {
        const content = cleanClinicalContent(input.clinicalContent);
        if (action === "finalize" && !["consultationReason", "clinicalObservations", "clinicalAssessment", "carePlan"].some((field) => Boolean(content[field]))) {
          throw new ApiError(400, "clinical-content-required", "Ajoutez le motif, les observations, l’évaluation ou la conduite à tenir avant de finaliser le dossier.");
        }
        await db.runTransaction(async (transaction) => {
          const [recordSnapshot, providerSnapshot] = await Promise.all([transaction.get(recordRef), transaction.get(providerRef)]);
          if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) {
            throw new ApiError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à modifier les dossiers.");
          }
          if (!recordSnapshot.exists || recordSnapshot.get("recordType") !== "STANDALONE" || recordSnapshot.get("providerUid") !== user.uid) {
            throw new ApiError(404, "clinical-record-not-found", "Ce dossier clinique autonome n’est pas accessible.");
          }
          const data = recordSnapshot.data() || {};
          if (!activeStandaloneAccess(data)) throw new ApiError(403, "clinical-access-expired", "L’autorisation patient a expiré ou a été révoquée. Un nouveau code est nécessaire.");
          if (FINAL_STATUSES.has(String(data.status || "").toUpperCase())) throw new ApiError(409, "record-immutable", "Ce dossier est finalisé. Ajoutez une correction à son historique.");
          const version = (Number(data.version) || 1) + 1;
          const signedAt = new Date().toISOString();
          const signature = action === "finalize" ? { uid: user.uid, name: doctor.name, specialty: doctor.specialty, signedAt } : null;
          const attachments = safeAttachments(data.attachments, recordId).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
          const documentHash = action === "finalize" ? createHash("sha256").update(JSON.stringify({ recordId, providerUid: user.uid, patientUid: data.patientUid, version, content, attachments, signature })).digest("hex") : null;
          const currentRevisionRef = revisionRef(recordRef, Number(data.version) || 1);
          const nextRevisionRef = revisionRef(recordRef, version);
          const [currentRevision, nextRevision] = await Promise.all([transaction.get(currentRevisionRef), transaction.get(nextRevisionRef)]);
          if (nextRevision.exists) throw new ApiError(409, "record-version-conflict", "Une autre mise à jour vient d’être enregistrée. Rechargez le dossier.");
          if (!currentRevision.exists) transaction.create(currentRevisionRef, revisionPayload(data, typeof data.updatedBy === "string" ? data.updatedBy : user.uid, "INITIAL"));
          transaction.create(nextRevisionRef, {
            version,
            status: action === "finalize" ? "FINALIZED" : "DRAFT",
            clinicalContent: content,
            attachments: Array.isArray(data.attachments) ? data.attachments : [],
            actorUid: user.uid,
            createdAt: FieldValue.serverTimestamp(),
            changeType: action === "finalize" ? "FINALIZED" : "DRAFT_SAVED",
            ...(signature ? { signature, documentHash } : {}),
          });
          transaction.set(recordRef, {
            clinicalContent: content,
            status: action === "finalize" ? "FINALIZED" : "DRAFT",
            version,
            updatedBy: user.uid,
            updatedAt: FieldValue.serverTimestamp(),
            ...(signature ? { signedAt: FieldValue.serverTimestamp(), finalizedAt: FieldValue.serverTimestamp(), signature, documentHash } : {}),
          }, { merge: true });
          transaction.create(auditRef, {
            actorUid: user.uid,
            action: action === "finalize" ? "standalone_clinical_record_finalized" : "standalone_clinical_record_draft_updated",
            recordId,
            version,
            createdAt: FieldValue.serverTimestamp(),
          });
        });
      } else {
        const content = clean(input.content, 5_000);
        const reason = clean(input.reason, 500);
        if (!content) throw new ApiError(400, "addendum-content-required", "Le contenu de la correction est requis.");
        const addendumRef = recordRef.collection("addenda").doc();
        await db.runTransaction(async (transaction) => {
          const [recordSnapshot, providerSnapshot] = await Promise.all([transaction.get(recordRef), transaction.get(providerRef)]);
          if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) {
            throw new ApiError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à modifier les dossiers.");
          }
          if (!recordSnapshot.exists || recordSnapshot.get("recordType") !== "STANDALONE" || recordSnapshot.get("providerUid") !== user.uid || !FINAL_STATUSES.has(String(recordSnapshot.get("status") || "").toUpperCase())) {
            throw new ApiError(409, "record-not-finalized", "Finalisez le dossier avant d’ajouter une correction.");
          }
          const data = recordSnapshot.data() || {};
          if (!activeStandaloneAccess(data)) throw new ApiError(403, "clinical-access-expired", "L’autorisation patient a expiré ou a été révoquée.");
          transaction.create(addendumRef, {
            recordId,
            providerUid: user.uid,
            patientUid: data.patientUid,
            reason,
            content,
            signatureName: doctor.name,
            createdAt: FieldValue.serverTimestamp(),
          });
          transaction.set(recordRef, { addendumCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp(), updatedBy: user.uid }, { merge: true });
          transaction.create(auditRef, { actorUid: user.uid, action: "standalone_clinical_record_addendum_created", recordId, createdAt: FieldValue.serverTimestamp() });
        });
      }

      const record = await loadRecord(recordId, user.uid);
      if (action === "finalize" && record.patientName && typeof createNexaNotification === "function") {
        const freshRecord = await recordRef.get();
        const patientUid = freshRecord.exists ? String(freshRecord.get("patientUid") || "") : "";
        if (patientUid) await createNexaNotification(patientUid, `clinical-record:${recordId}:finalized`, {
          type: "clinical_record_finalized",
          title: "Compte rendu médical disponible",
          body: "Votre médecin a finalisé le compte rendu de votre dossier.",
          url: "/espace-patient.html",
        }, recordId).catch((error) => logger.warn("NEXA standalone record notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
      }
      return res.status(200).json({ ok: true, record });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA standalone clinical record request failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "standalone-clinical-record-unavailable", "Le dossier clinique n’est pas accessible pour le moment.");
    }
  });

  return { nexaProviderClinicalRecords, nexaStandaloneClinicalRecord };
};
