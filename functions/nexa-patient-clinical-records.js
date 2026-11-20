"use strict";

const { onRequest } = require("firebase-functions/v2/https");

const REGION = "us-east4";
const FINAL_STATUSES = new Set(["FINALIZED", "SIGNED"]);
const PATIENT_RECORD_PAGE_SIZE = 25;
const TEXT_FIELDS = [
  ["consultationReason", "Motif de consultation"], ["history", "Histoire / anamnèse"],
  ["relevantHistory", "Antécédents pertinents"], ["allergies", "Allergies"],
  ["currentTreatments", "Traitements en cours"], ["symptoms", "Symptômes"],
  ["clinicalObservations", "Observations cliniques"], ["clinicalAssessment", "Évaluation clinique"],
  ["diagnoses", "Diagnostic(s)"], ["carePlan", "Plan de soins"],
  ["recommendations", "Recommandations"], ["followUp", "Suivi"],
  ["additionalNotes", "Notes complémentaires"],
];
const VITAL_LABELS = {
  systolic: "TA systolique (mmHg)", diastolic: "TA diastolique (mmHg)",
  heartRate: "Fréquence cardiaque (BPM)", respiratoryRate: "Fréquence respiratoire (RPM)",
  spo2: "SpO2 (%)", glycemia: "Glycémie (mg/dl)", temperature: "Température (°C)",
  weight: "Poids", height: "Taille",
};
const WIN_ANSI = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89,
  "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95,
  "–": 0x96, "—": 0x97, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
  "À": 0xc0, "Â": 0xc2, "Ç": 0xc7, "È": 0xc8, "É": 0xc9, "Ê": 0xca, "Ë": 0xcb, "Î": 0xce, "Ï": 0xcf,
  "Ô": 0xd4, "Ù": 0xd9, "Û": 0xdb, "Ü": 0xdc, "à": 0xe0, "â": 0xe2, "ç": 0xe7, "è": 0xe8, "é": 0xe9,
  "ê": 0xea, "ë": 0xeb, "î": 0xee, "ï": 0xef, "ô": 0xf4, "ù": 0xf9, "û": 0xfb, "ü": 0xfc, "°": 0xb0,
};

function clean(value, maximum = 5_000) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum) : "";
}

function iso(value) {
  if (value && typeof value.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

function projectContent(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  for (const [field] of TEXT_FIELDS) result[field] = clean(source[field]);
  const sourceVitals = source.patientVitals && typeof source.patientVitals === "object" && !Array.isArray(source.patientVitals) ? source.patientVitals : {};
  const vitals = {};
  for (const field of Object.keys(VITAL_LABELS)) vitals[field] = typeof sourceVitals[field] === "number" && Number.isFinite(sourceVitals[field]) ? sourceVitals[field] : null;
  vitals.weightUnit = clean(sourceVitals.weightUnit, 10) || "kg";
  vitals.heightUnit = clean(sourceVitals.heightUnit, 10) || "cm";
  result.patientVitals = vitals;
  result.medications = Array.isArray(source.medications) ? source.medications.slice(0, 50).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = {
      name: clean(entry.name, 180), dosage: clean(entry.dosage, 120), form: clean(entry.form, 120),
      route: clean(entry.route, 120), duration: clean(entry.duration, 120), instructions: clean(entry.instructions, 300),
      quantity: typeof entry.quantity === "number" && Number.isFinite(entry.quantity) && entry.quantity >= 0 ? entry.quantity : null,
    };
    return item.name ? [item] : [];
  }) : [];
  for (const field of ["laboratoryTests", "imagingExams"]) result[field] = Array.isArray(source[field])
    ? source[field].slice(0, 50).map((item) => clean(item, 250)).filter(Boolean)
    : [];
  return result;
}

function winAnsi(value) {
  return Array.from(String(value ?? "")).map((character) => {
    const code = character.charCodeAt(0);
    return code <= 0xff ? character : Object.hasOwn(WIN_ANSI, character) ? String.fromCharCode(WIN_ANSI[character]) : "?";
  }).join("");
}

function wrap(value, maximum = 88) {
  const words = clean(value, 2_000).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const parts = word.length > maximum ? word.match(new RegExp(`.{1,${maximum}}`, "g")) || [word] : [word];
    for (const part of parts) {
      if (!line) line = part;
      else if (`${line} ${part}`.length <= maximum) line += ` ${part}`;
      else { lines.push(line); line = part; }
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function buildPdf(lines) {
  const normalized = lines.flatMap((line) => wrap(line));
  const pages = Array.from({ length: Math.max(1, Math.ceil(normalized.length / 48)) }, (_, index) => normalized.slice(index * 48, (index + 1) * 48));
  const objects = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  pages.forEach((page, index) => {
    const pageId = 4 + index * 2;
    const stream = ["BT", "/F1 10 Tf", "15 TL", "50 790 Td", ...page.map((line) => `(${winAnsi(line).replace(/[\\()]/g, "\\$&")}) Tj T*`), "ET"].join("\n");
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = Buffer.byteLength(pdf, "latin1");
    pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

function dateLabel(value) {
  let date = null;
  if (value && typeof value.toDate === "function") date = value.toDate();
  else if (value instanceof Date) date = value;
  else if (typeof value === "string" && !Number.isNaN(Date.parse(value))) date = new Date(value);
  return date ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "long", timeStyle: "short" }).format(date) : "Non renseignée";
}

function finalRecord(data) {
  return FINAL_STATUSES.has(String(data.status || "").trim().toUpperCase());
}

function safeAddenda(documents, recordId, patientUid, providerUid) {
  return documents.flatMap((document) => {
    const item = document.data() || {};
    if (item.recordId !== recordId || item.patientUid !== patientUid || item.providerUid !== providerUid) return [];
    return [{
      id: document.id,
      reason: clean(item.reason, 500),
      content: clean(item.content),
      signatureName: clean(item.signatureName, 180),
      createdAt: iso(item.createdAt),
    }];
  });
}

function safeAttachments(value, recordId) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const id = typeof entry.id === "string" ? entry.id : "";
    const contentType = typeof entry.contentType === "string" ? entry.contentType.toLowerCase() : "";
    const size = Number(entry.size);
    const hash = typeof entry.sha256Hash === "string" ? entry.sha256Hash : "";
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(id) ||
      !["application/pdf", "image/jpeg", "image/png"].includes(contentType) ||
      !Number.isSafeInteger(size) || size < 1 || size > 15 * 1024 * 1024 ||
      entry.antivirusStatus !== "CLEAN" || !/^[a-f0-9]{64}$/.test(hash) ||
      entry.storagePath !== "nexa-clinical-records/" + recordId + "/" + id) return [];
    return [{
      id,
      originalFileName: clean(entry.originalFileName, 180) || "Pièce jointe clinique",
      contentType,
      size,
      uploadedAt: clean(entry.uploadedAt, 80),
    }];
  });
}

module.exports = function createNexaPatientClinicalRecordFunctions(dependencies) {
  const { db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger } = dependencies;

  async function requirePatient(req) {
    const user = await requireUser(req);
    await requireAppCheckToken(req);
    const profile = await db.collection("patientProfiles").doc(user.uid).get();
    if (!profile.exists || profile.get("role") !== "patient" || profile.get("profileComplete") !== true) {
      throw new ApiError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
    }
    return { user, profile };
  }

  function prepareRead(req, res, methods) {
    res.set("Cache-Control", "no-store, max-age=0");
    if (!setCors(req, res)) { fail(res, 403, "origin-not-allowed", "Origine non autorisée."); return false; }
    if (req.method === "OPTIONS") { res.status(204).end(); return false; }
    if (req.method !== "GET") { res.set("Allow", methods); fail(res, 405, "method-not-allowed", "Méthode non autorisée."); return false; }
    return true;
  }

  const nexaPatientClinicalRecords = onRequest({ region: REGION }, async (req, res) => {
    if (!prepareRead(req, res, "GET, OPTIONS")) return;
    try {
      const { user } = await requirePatient(req);
      await enforceUserRateLimit(user.uid, "patient-standalone-record-library", 20, 5 * 60_000);
      const requestedCursor = req.query.cursor;
      if (requestedCursor !== undefined && (typeof requestedCursor !== "string" || requestedCursor.length > 200 || !/^[A-Za-z0-9_-]{10,200}$/.test(requestedCursor))) {
        throw new ApiError(400, "invalid-record-cursor", "La pagination des dossiers n’est pas valide.");
      }
      let cursorSnapshot = null;
      if (requestedCursor) {
        cursorSnapshot = await db.collection("electronicPatientRecords").doc(requestedCursor).get();
        if (!cursorSnapshot.exists || cursorSnapshot.get("patientUid") !== user.uid || cursorSnapshot.get("recordType") !== "STANDALONE") {
          throw new ApiError(400, "invalid-record-cursor", "Actualisez la liste des dossiers avant de continuer.");
        }
      }
      let query = db.collection("electronicPatientRecords")
        .where("patientUid", "==", user.uid)
        .where("recordType", "==", "STANDALONE")
        .orderBy("createdAt", "desc")
        .limit(PATIENT_RECORD_PAGE_SIZE + 1);
      if (cursorSnapshot) query = query.startAfter(cursorSnapshot);
      const snapshot = await query.get();
      const pageDocuments = snapshot.docs.slice(0, PATIENT_RECORD_PAGE_SIZE);
      const records = pageDocuments.flatMap((document) => {
        const data = document.data() || {};
        if (data.recordType !== "STANDALONE" || data.recordId !== document.id) return [];
        return [{
          recordId: document.id,
          recordNumber: clean(data.recordNumber, 100),
          status: clean(data.status, 30) || "DRAFT",
          providerName: clean(data.providerName, 180) || "Professionnel NEXA",
          specialtyName: clean(data.specialtyName, 160),
          createdAt: iso(data.createdAt),
          finalizedAt: iso(data.finalizedAt),
          addendumCount: Number(data.addendumCount) || 0,
        }];
      });
      const hasMore = snapshot.docs.length > PATIENT_RECORD_PAGE_SIZE;
      const nextCursor = hasMore && pageDocuments.length ? pageDocuments[pageDocuments.length - 1].id : null;
      await db.collection("clinicalAuditLogs").doc().create({
        actorUid: user.uid,
        action: "patient_standalone_clinical_record_library_accessed",
        recordCount: records.length,
        hasMore,
        createdAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ ok: true, records, hasMore, nextCursor });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA patient standalone record library failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "patient-records-unavailable", "La liste des dossiers médicaux n’est pas accessible pour le moment.");
    }
  });

  const nexaPatientStandaloneClinicalRecord = onRequest({ region: REGION }, async (req, res) => {
    if (!prepareRead(req, res, "GET, OPTIONS")) return;
    try {
      const { user } = await requirePatient(req);
      await enforceUserRateLimit(user.uid, "patient-standalone-record-read", 30, 5 * 60_000);
      const recordId = typeof req.query.recordId === "string" ? req.query.recordId.trim() : "";
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(recordId)) throw new ApiError(400, "invalid-record-id", "La référence du dossier n’est pas valide.");
      const ref = db.collection("electronicPatientRecords").doc(recordId);
      const snapshot = await ref.get();
      if (!snapshot.exists || snapshot.get("recordType") !== "STANDALONE" || snapshot.get("recordId") !== recordId || snapshot.get("patientUid") !== user.uid) {
        throw new ApiError(404, "clinical-record-not-found", "Ce dossier médical n’est pas disponible.");
      }
      const data = snapshot.data() || {};
      const finalized = finalRecord(data);
      const addendaSnapshot = finalized ? await ref.collection("addenda").orderBy("createdAt", "desc").limit(100).get() : null;
      const signature = data.signature && typeof data.signature === "object" && !Array.isArray(data.signature) ? data.signature : {};
      const record = {
        recordId,
        recordType: "STANDALONE",
        recordNumber: clean(data.recordNumber, 100),
        status: clean(data.status, 30),
        providerName: clean(data.providerName, 180) || "Professionnel NEXA",
        specialtyName: clean(data.specialtyName, 160),
        createdAt: iso(data.createdAt),
        finalizedAt: iso(data.finalizedAt),
        ...(finalized ? {
          clinicalContent: projectContent(data.clinicalContent),
          attachments: safeAttachments(data.attachments, recordId),
          signature: signature.name ? { name: clean(signature.name, 180), specialty: clean(signature.specialty, 160), signedAt: clean(signature.signedAt, 80) } : null,
          documentHash: /^[a-f0-9]{64}$/i.test(String(data.documentHash || "")) ? String(data.documentHash) : null,
          addenda: safeAddenda(addendaSnapshot?.docs || [], recordId, user.uid, String(data.providerUid || "")),
        } : {}),
      };
      await db.collection("clinicalAuditLogs").doc().create({
        actorUid: user.uid,
        action: "patient_standalone_clinical_record_accessed",
        recordId,
        createdAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ ok: true, view: "patient", record });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA patient standalone clinical record failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "patient-record-unavailable", "Le dossier médical n’est pas accessible pour le moment.");
    }
  });

  const nexaPatientStandaloneClinicalRecordPdf = onRequest({ region: REGION }, async (req, res) => {
    if (!prepareRead(req, res, "GET, OPTIONS")) return;
    try {
      const { user, profile } = await requirePatient(req);
      await enforceUserRateLimit(user.uid, "patient-standalone-record-pdf", 10, 5 * 60_000);
      const recordId = typeof req.query.recordId === "string" ? req.query.recordId.trim() : "";
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(recordId)) throw new ApiError(400, "invalid-record-id", "La référence du dossier n’est pas valide.");
      const ref = db.collection("electronicPatientRecords").doc(recordId);
      const snapshot = await ref.get();
      if (!snapshot.exists || snapshot.get("recordType") !== "STANDALONE" || snapshot.get("recordId") !== recordId || snapshot.get("patientUid") !== user.uid) {
        throw new ApiError(404, "clinical-record-not-found", "Ce dossier médical n’est pas disponible.");
      }
      const data = snapshot.data() || {};
      if (!finalRecord(data)) throw new ApiError(409, "record-not-finalized", "Le PDF sera disponible après la finalisation du dossier par le médecin.");
      const addendaSnapshot = await ref.collection("addenda").orderBy("createdAt", "desc").limit(100).get();
      const content = projectContent(data.clinicalContent);
      const patientNumber = clean(data.patientNumber, 40) || clean(profile.get("patientNumber"), 40) || "Non renseigné";
      const signature = data.signature && typeof data.signature === "object" && !Array.isArray(data.signature) ? data.signature : {};
      const addenda = safeAddenda(addendaSnapshot.docs, recordId, user.uid, String(data.providerUid || ""));
      const lines = [
        "NEXA MEDICAL CENTER", "COMPTE RENDU MÉDICAL", "",
        `Numéro patient : ${patientNumber}`,
        `Référence du dossier : ${clean(data.recordNumber, 100) || "Non renseignée"}`,
        `Professionnel : ${clean(data.providerName, 180) || "Professionnel NEXA"}`,
        `Spécialité : ${clean(data.specialtyName, 160) || "Non renseignée"}`,
        `Date de finalisation : ${dateLabel(data.finalizedAt)}`,
        `Version : ${Number(data.version) || 1}`,
        ...(typeof data.documentHash === "string" && /^[a-f0-9]{64}$/i.test(data.documentHash) ? [`Empreinte du dossier : ${data.documentHash}`] : []),
        "",
      ];
      for (const [field, label] of TEXT_FIELDS) if (content[field]) lines.push(label.toUpperCase(), content[field], "");
      const vitals = content.patientVitals || {};
      const vitalLines = Object.entries(VITAL_LABELS).flatMap(([field, label]) => {
        const value = vitals[field];
        if (typeof value !== "number" || !Number.isFinite(value)) return [];
        const unit = field === "weight" ? clean(vitals.weightUnit, 10) : field === "height" ? clean(vitals.heightUnit, 10) : "";
        return [`${label}${unit ? ` (${unit})` : ""} : ${String(value).slice(0, 40)}`];
      });
      if (vitalLines.length) lines.push("SIGNES VITAUX", ...vitalLines, "");
      if (content.medications.length) {
        lines.push("MÉDICAMENTS");
        for (const [index, item] of content.medications.entries()) {
          lines.push(`${index + 1}. ${item.name}`);
          const details = [item.dosage, item.form, item.route, item.duration].filter(Boolean);
          if (item.quantity !== null) details.push(`Quantité : ${item.quantity}`);
          if (details.length) lines.push(`   ${details.join(" · ")}`);
          if (item.instructions) lines.push(`   Instructions : ${item.instructions}`);
        }
        lines.push("");
      }
      if (content.laboratoryTests.length) lines.push("EXAMENS DE LABORATOIRE", ...content.laboratoryTests, "");
      if (content.imagingExams.length) lines.push("EXAMENS D’IMAGERIE", ...content.imagingExams, "");
      lines.push(`Finalisé par : ${clean(signature.name, 180) || clean(data.providerName, 180) || "Professionnel NEXA"}`);
      const specialty = clean(signature.specialty, 160) || clean(data.specialtyName, 160);
      if (specialty) lines.push(`Spécialité : ${specialty}`);
      if (signature.signedAt) lines.push(`Signé le : ${dateLabel(signature.signedAt)}`);
      if (addenda.length) {
        lines.push("", "CORRECTIONS AJOUTÉES AU DOSSIER");
        for (const addendum of addenda) {
          lines.push(addendum.reason || "Correction", addendum.content);
          if (addendum.signatureName) lines.push(`Ajouté par : ${addendum.signatureName}`);
          lines.push(`Date : ${dateLabel(addendum.createdAt)}`, "");
        }
      }
      const pdf = buildPdf(lines);
      await db.collection("clinicalAuditLogs").doc().create({
        actorUid: user.uid,
        action: "clinical_record_pdf_downloaded",
        recordId,
        version: Number(data.version) || 1,
        createdAt: FieldValue.serverTimestamp(),
      });
      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", `attachment; filename="nexa-compte-rendu-${clean(data.recordNumber, 100).replace(/[^A-Za-z0-9_-]/g, "-") || recordId.slice(0, 10)}.pdf"`);
      res.set("X-Content-Type-Options", "nosniff");
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).send(pdf);
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA patient clinical record PDF failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "clinical-record-pdf-unavailable", "Le PDF du dossier médical ne peut pas être généré pour le moment.");
    }
  });

  return { nexaPatientClinicalRecords, nexaPatientStandaloneClinicalRecord, nexaPatientStandaloneClinicalRecordPdf };
};
