"use strict";

const { onRequest } = require("firebase-functions/v2/https");

const REGION = "us-east4";
const EDITABLE_STATUSES = new Set(["IN_PROGRESS", "COMPLETED"]);
const WIN_ANSI = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89,
  "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95,
  "–": 0x96, "—": 0x97, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
  "À": 0xc0, "Â": 0xc2, "Ç": 0xc7, "È": 0xc8, "É": 0xc9, "Ê": 0xca, "Ë": 0xcb, "Î": 0xce, "Ï": 0xcf,
  "Ô": 0xd4, "Ù": 0xd9, "Û": 0xdb, "Ü": 0xdc, "à": 0xe0, "â": 0xe2, "ç": 0xe7, "è": 0xe8, "é": 0xe9,
  "ê": 0xea, "ë": 0xeb, "î": 0xee, "ï": 0xef, "ô": 0xf4, "ù": 0xf9, "û": 0xfb, "ü": 0xfc, "°": 0xb0,
};

function cleanText(value, maximum = 1_000) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function safeMedication(value) {
  const item = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const quantity = item.quantity == null || item.quantity === "" ? null : Number(item.quantity);
  return {
    name: cleanText(item.name || "Médicament", 180), dosage: cleanText(item.dosage, 120),
    form: cleanText(item.form, 120), route: cleanText(item.route, 120),
    quantity: Number.isFinite(quantity) && quantity >= 0 && quantity <= 1_000_000 ? quantity : null,
    duration: cleanText(item.duration, 120), instructions: cleanText(item.instructions, 500),
  };
}

function safeExam(value) {
  if (typeof value === "string") return cleanText(value, 250);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return cleanText(value.name || value.label, 250);
}

function winAnsi(value) {
  return Array.from(String(value ?? "")).map((character) => {
    const code = character.charCodeAt(0);
    if (code <= 0xff) return character;
    return Object.hasOwn(WIN_ANSI, character) ? String.fromCharCode(WIN_ANSI[character]) : "?";
  }).join("");
}

function escapePdf(value) {
  return winAnsi(cleanText(value, 2_000)).replace(/[\\()]/g, "\\$&");
}

function wrap(value, limit = 88) {
  const words = cleanText(value, 2_000).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const pieces = word.length > limit ? word.match(new RegExp(`.{1,${limit}}`, "g")) || [word] : [word];
    for (const piece of pieces) {
      if (!line) line = piece;
      else if (`${line} ${piece}`.length <= limit) line += ` ${piece}`;
      else { lines.push(line); line = piece; }
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
    const contentId = pageId + 1;
    const stream = ["BT", "/F1 10 Tf", "15 TL", "50 790 Td", ...page.map((line) => `(${escapePdf(line)}) Tj T*`), "ET"].join("\n");
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
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

function timestamp(value) {
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

function activeClinicalAccess(appointment, now = Date.now()) {
  if (appointment.paymentStatus !== "PAID") return false;
  const status = String(appointment.status || "").toUpperCase();
  const completedHomeVisit = appointment.bookingType === "home_visit" && status === "COMPLETED" && appointment.homeVisitMissionStatus === "COMPLETED";
  const startedHomeVisit = appointment.bookingType === "home_visit" && ["CONFIRMED", "COMPLETED"].includes(status) && timestamp(appointment.effectiveConsultationStartedAt) > 0;
  const start = startedHomeVisit ? timestamp(appointment.effectiveConsultationStartedAt)
    : completedHomeVisit ? timestamp(appointment.homeVisitMissionClosedAt)
    : EDITABLE_STATUSES.has(status) ? timestamp(appointment.effectiveConsultationStartedAt) : Number.NaN;
  return Number.isFinite(start) && start > 0 && now >= start && now < start + 24 * 60 * 60_000;
}

module.exports = function createNexaPrescriptionPdfFunctions(dependencies) {
  const { db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger } = dependencies;

  const nexaPrescriptionPdf = onRequest({ region: REGION }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") {
      res.set("Allow", "GET, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      const prescriptionId = typeof req.query.prescriptionId === "string" ? req.query.prescriptionId.trim() : "";
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(prescriptionId)) throw new ApiError(400, "invalid-prescription", "La référence de l’ordonnance n’est pas valide.");
      const prescriptionSnapshot = await db.collection("clinicalPrescriptions").doc(prescriptionId).get();
      if (!prescriptionSnapshot.exists) throw new ApiError(404, "prescription-not-found", "Ordonnance validée introuvable.");
      const prescription = prescriptionSnapshot.data() || {};
      if (prescription.status !== "VALIDATED" || typeof prescription.patientUid !== "string" || typeof prescription.providerUid !== "string") {
        throw new ApiError(404, "prescription-not-found", "Ordonnance validée introuvable.");
      }
      const patientView = prescription.patientUid === user.uid;
      const rateAction = patientView ? "patient-prescription-pdf" : "doctor-prescription-pdf";
      await enforceUserRateLimit(user.uid, rateAction, 10, 5 * 60_000);

      const patientRef = db.collection("patientProfiles").doc(prescription.patientUid);
      const patientSnapshot = await patientRef.get();
      if (!patientSnapshot.exists || patientSnapshot.get("role") !== "patient" || patientSnapshot.get("profileComplete") !== true) {
        throw new ApiError(404, "prescription-not-found", "Ordonnance validée introuvable.");
      }
      if (patientView) {
        if (prescription.patientUid !== user.uid) throw new ApiError(404, "prescription-not-found", "Ordonnance validée introuvable.");
      } else {
        if (prescription.providerUid !== user.uid) throw new ApiError(403, "forbidden", "Cette ordonnance ne vous est pas accessible.");
        const appointmentId = typeof prescription.appointmentId === "string" ? prescription.appointmentId : "";
        if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) throw new ApiError(403, "prescription-appointment-unavailable", "La consultation associée n’est pas accessible.");
        const [providerSnapshot, appointmentSnapshot] = await Promise.all([
          db.collection("providerProfiles").doc(user.uid).get(),
          db.collection("appointments").doc(appointmentId).get(),
        ]);
        if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) {
          throw new ApiError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé.");
        }
        if (!appointmentSnapshot.exists || appointmentSnapshot.get("providerUid") !== user.uid || appointmentSnapshot.get("patientUid") !== prescription.patientUid || !activeClinicalAccess(appointmentSnapshot.data() || {})) {
          throw new ApiError(403, "clinical-access-expired", "L’accès au document est réservé au médecin associé pendant la prise en charge autorisée.");
        }
      }

      const signature = prescription.signature && typeof prescription.signature === "object" && !Array.isArray(prescription.signature)
        ? prescription.signature
        : {};
      const signatureName = cleanText(signature.name, 180);
      const signatureTime = Date.parse(cleanText(signature.signedAt, 80));
      if (!signatureName || !Number.isFinite(signatureTime)) {
        throw new ApiError(409, "prescription-signature-incomplete", "Les métadonnées de validation de cette ordonnance sont incomplètes.");
      }

      const patient = patientSnapshot.data() || {};
      const dateMillis = timestamp(prescription.validatedAt);
      const dateText = Number.isFinite(dateMillis)
        ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "long" }).format(new Date(dateMillis))
        : "Date indisponible";
      const medications = Array.isArray(prescription.medications) ? prescription.medications.slice(0, 50).map(safeMedication) : [];
      const labs = Array.isArray(prescription.labExams) ? prescription.labExams.slice(0, 50).map(safeExam).filter(Boolean) : [];
      const imaging = Array.isArray(prescription.imagingExams) ? prescription.imagingExams.slice(0, 50).map(safeExam).filter(Boolean) : [];
      const lines = [
        "NEXARIS MEDICAL CENTER",
        "ORDONNANCE MEDICALE",
        "",
        `Patient : ${cleanText(patient.displayName, 180) || "Patient NEXA"}`,
        `Numero patient : ${/^NMC-\d{7}$/.test(String(patient.patientNumber || "")) ? patient.patientNumber : "Non renseigne"}`,
        `Medecin : ${cleanText(prescription.providerName, 180) || "Medecin NEXA"}`,
        `Specialite : ${cleanText(prescription.specialtyName, 160) || "Non renseignee"}`,
        `Validee le : ${dateText}`,
        `Version : ${Number.isSafeInteger(prescription.version) && prescription.version > 0 ? prescription.version : 1}`,
        "",
      ];
      if (medications.length) {
        lines.push("MEDICAMENTS");
        medications.forEach((medication, index) => {
          lines.push(`${index + 1}. ${medication.name}`);
          const details = [medication.dosage, medication.form, medication.route ? `Voie : ${medication.route}` : "", medication.quantity !== null ? `Quantite : ${medication.quantity}` : "", medication.duration ? `Duree : ${medication.duration}` : ""].filter(Boolean).join(" · ");
          if (details) lines.push(`   ${details}`);
          if (medication.instructions) lines.push(`   Instructions : ${medication.instructions}`);
        });
        lines.push("");
      }
      if (labs.length) lines.push("EXAMENS DE LABORATOIRE", ...labs.map((exam, index) => `${index + 1}. ${exam}`), "");
      if (imaging.length) lines.push("EXAMENS D’IMAGERIE", ...imaging.map((exam, index) => `${index + 1}. ${exam}`), "");
      const notes = cleanText(prescription.notes, 1_000);
      if (notes) lines.push("INSTRUCTIONS COMPLEMENTAIRES", notes, "");
      const signatureSpecialty = cleanText(signature.specialty, 160) || cleanText(prescription.specialtyName, 160);
      const signedAtText = `Date : ${new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "long", timeStyle: "short" }).format(new Date(signatureTime))}`;
      lines.push("VALIDATION ENREGISTREE DANS NEXA", `Medecin : ${signatureName}`, signatureSpecialty, signedAtText, "Ce document reprend une ordonnance validee dans le systeme NEXA.");

      const pdf = buildPdf(lines);
      await db.collection("clinicalAuditLogs").add({ actorUid: user.uid, action: "clinical_prescription_pdf_downloaded", appointmentId: cleanText(prescription.appointmentId, 200), prescriptionId, version: Number(prescription.version) || 1, createdAt: FieldValue.serverTimestamp() });
      res.set("Cache-Control", "no-store, max-age=0");
      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", `attachment; filename="nexa-ordonnance-${prescriptionId.slice(0, 10)}.pdf"`);
      return res.status(200).send(pdf);
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA prescription PDF request failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "prescription-pdf-unavailable", "Le document PDF ne peut pas être généré.");
    }
  });

  return { nexaPrescriptionPdf };
};
