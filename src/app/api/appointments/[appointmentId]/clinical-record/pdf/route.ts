import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

const FINAL_STATUSES = new Set(["FINALIZED", "SIGNED"]);
const TEXT_FIELDS: Array<[string, string]> = [
  ["consultationReason", "Motif de consultation"], ["history", "Histoire / anamnèse"],
  ["relevantHistory", "Antécédents pertinents"], ["allergies", "Allergies"],
  ["currentTreatments", "Traitements en cours"], ["symptoms", "Symptômes"],
  ["clinicalObservations", "Observations cliniques"], ["clinicalAssessment", "Évaluation clinique"],
  ["diagnoses", "Diagnostic(s)"], ["carePlan", "Plan de soins"],
  ["recommendations", "Recommandations"], ["followUp", "Suivi"],
  ["additionalNotes", "Notes complémentaires"],
];
const VITAL_LABELS: Record<string, string> = {
  systolic: "TA systolique (mmHg)", diastolic: "TA diastolique (mmHg)",
  heartRate: "Fréquence cardiaque (BPM)", respiratoryRate: "Fréquence respiratoire (RPM)",
  spo2: "SpO2 (%)", glycemia: "Glycémie (mg/dl)", temperature: "Température (°C)",
  weight: "Poids", height: "Taille",
};
const WIN_ANSI: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89,
  "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95,
  "–": 0x96, "—": 0x97, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
  "À": 0xc0, "Â": 0xc2, "Ç": 0xc7, "È": 0xc8, "É": 0xc9, "Ê": 0xca, "Ë": 0xcb, "Î": 0xce,
  "Ï": 0xcf, "Ô": 0xd4, "Ù": 0xd9, "Û": 0xdb, "Ü": 0xdc, "à": 0xe0, "â": 0xe2, "ç": 0xe7,
  "è": 0xe8, "é": 0xe9, "ê": 0xea, "ë": 0xeb, "î": 0xee, "ï": 0xef, "ô": 0xf4, "ù": 0xf9,
  "û": 0xfb, "ü": 0xfc, "°": 0xb0,
};

function cleanText(value: unknown, limit = 5000): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, limit);
}

function winAnsi(value: string): string {
  return Array.from(value).map((character) => {
    const code = character.charCodeAt(0);
    return code <= 0xff ? character : WIN_ANSI[character] ? String.fromCharCode(WIN_ANSI[character]) : "?";
  }).join("");
}

function wrap(value: string, limit = 88): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const parts = word.length > limit ? word.match(new RegExp(`.{1,${limit}}`, "g")) || [word] : [word];
    for (const part of parts) {
      if (!line) line = part;
      else if (`${line} ${part}`.length <= limit) line += ` ${part}`;
      else { lines.push(line); line = part; }
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function buildPdf(lines: string[]): Buffer {
  const normalized = lines.flatMap((line) => wrap(line));
  const pages = Array.from({ length: Math.max(1, Math.ceil(normalized.length / 48)) }, (_, index) => normalized.slice(index * 48, (index + 1) * 48));
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  pages.forEach((page, index) => {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    const stream = ["BT", "/F1 10 Tf", "15 TL", "50 790 Td", ...page.map((line) => `(${winAnsi(line).replace(/[\\()]/g, "\\$&")}) Tj T*`), "ET"].join("\n");
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

function dateLabel(value: unknown): string {
  let date: Date | null = null;
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    date = (value.toDate as () => Date)();
  } else if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  }
  return date ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "long", timeStyle: "short" }).format(date) : "Non renseignée";
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "clinical-record-pdf-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le dossier médical PDF ne peut pas être généré pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA clinical record PDF generation failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request, { params }: { params: Promise<{ appointmentId: string }> }) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "clinical-record-pdf", limit: 10, windowMs: 5 * 60_000 });
    const { appointmentId } = await params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) throw new ApiRequestError(400, "invalid-appointment", "La référence de consultation n’est pas valide.");

    const db = getFirebaseAdminDb();
    const [appointmentSnapshot, recordSnapshot, profile] = await Promise.all([
      db.collection("appointments").doc(appointmentId).get(),
      db.collection("electronicPatientRecords").doc(appointmentId).get(),
      db.collection("patientProfiles").doc(user.uid).get(),
    ]);
    if (!profile.exists || profile.get("role") !== "patient" || profile.get("profileComplete") !== true) throw new ApiRequestError(403, "patient-profile-required", "Accès patient NEXA requis.");
    if (!recordSnapshot.exists || recordSnapshot.get("patientUid") !== user.uid) throw new ApiRequestError(404, "record-not-found", "Le dossier médical est introuvable.");
    const standalone = recordSnapshot.get("recordType") === "STANDALONE";
    if (standalone) {
      if (recordSnapshot.get("recordId") !== appointmentId) throw new ApiRequestError(404, "record-not-found", "Le dossier médical est introuvable.");
    } else if (!appointmentSnapshot.exists || appointmentSnapshot.get("patientUid") !== user.uid) {
      throw new ApiRequestError(404, "record-not-found", "Le dossier de consultation est introuvable.");
    }
    const recordRef = db.collection("electronicPatientRecords").doc(appointmentId);
    const record = recordSnapshot.data() || {};
    if (record.patientUid !== user.uid || (!standalone && (record.appointmentId !== appointmentId || record.providerUid !== appointmentSnapshot.get("providerUid")))) {
      throw new ApiRequestError(404, "record-not-found", "Le dossier de consultation est introuvable.");
    }
    if (!FINAL_STATUSES.has(String(record.status || "").trim().toUpperCase())) throw new ApiRequestError(409, "record-not-finalized", "Le PDF sera disponible après la finalisation du dossier par le médecin.");

    const addendaSnapshot = await recordRef.collection("addenda").orderBy("createdAt", "desc").limit(100).get();
    const addenda = addendaSnapshot.docs.map((doc) => doc.data()).filter((item) =>
      item.patientUid === user.uid && item.providerUid === record.providerUid && (standalone ? item.recordId === appointmentId : item.appointmentId === appointmentId),
    );
    const content = record.clinicalContent && typeof record.clinicalContent === "object" && !Array.isArray(record.clinicalContent)
      ? record.clinicalContent as Record<string, unknown>
      : {};
    const vitals = content.patientVitals && typeof content.patientVitals === "object" && !Array.isArray(content.patientVitals)
      ? content.patientVitals as Record<string, unknown>
      : {};
    const medications = Array.isArray(content.medications) ? content.medications.slice(0, 50) as Record<string, unknown>[] : [];
    const labTests = Array.isArray(content.laboratoryTests) ? content.laboratoryTests.slice(0, 50) : [];
    const imagingExams = Array.isArray(content.imagingExams) ? content.imagingExams.slice(0, 50) : [];
    const attachments = Array.isArray(record.attachments) ? record.attachments.slice(0, 10) as Record<string, unknown>[] : [];
    const signature = record.signature && typeof record.signature === "object" ? record.signature as Record<string, unknown> : {};
    const lines = [
      "NEXA MEDICAL CENTER",
      "COMPTE RENDU MEDICAL",
      "",
      `Numero patient : ${cleanText(record.patientNumber, 40) || cleanText(profile.get("patientNumber"), 40) || "Non renseigne"}`,
      `Reference du dossier : ${cleanText(record.recordNumber, 100) || "Non renseignee"}`,
      `Professionnel : ${cleanText(record.providerName, 180) || "Professionnel NEXA"}`,
      `Specialite : ${cleanText(record.specialtyName, 160) || "Non renseignee"}`,
      `Date de finalisation : ${dateLabel(record.finalizedAt)}`,
      `Version : ${Number(record.version) || 1}`,
    ...(typeof record.documentHash === "string" && /^[a-f0-9]{64}$/i.test(record.documentHash) ? [`Empreinte du dossier : ${record.documentHash}`] : []),
      "",
    ];
    for (const [field, label] of TEXT_FIELDS) {
      const value = cleanText(content[field]);
      if (value) lines.push(label.toUpperCase(), value, "");
    }
    const vitalLines = Object.entries(VITAL_LABELS).flatMap(([key, label]) => {
      const value = vitals[key];
      if ((typeof value !== "string" && typeof value !== "number") || value === "") return [];
      const unit = key === "weight" ? cleanText(vitals.weightUnit, 10) : key === "height" ? cleanText(vitals.heightUnit, 10) : "";
      return [`${label}${unit ? ` (${unit})` : ""} : ${String(value).slice(0, 40)}`];
    });
    if (vitalLines.length) lines.push("SIGNES VITAUX", ...vitalLines, "");
    if (medications.length) {
      lines.push("MEDICAMENTS PRESCRITS");
      medications.forEach((item, index) => {
        const name = cleanText(item?.name, 180);
        if (!name) return;
        lines.push(`${index + 1}. ${name}`);
        const details = [item.dosage, item.form, item.route, item.duration].map((value) => cleanText(value, 120)).filter(Boolean);
        if (item.quantity != null && Number.isFinite(Number(item.quantity))) details.push(`Quantite : ${Number(item.quantity)}`);
        if (details.length) lines.push(`   ${details.join(" · ")}`);
        const instructions = cleanText(item.instructions, 300);
        if (instructions) lines.push(`   Instructions : ${instructions}`);
      });
      lines.push("");
    }
    if (labTests.length) lines.push("EXAMENS DE LABORATOIRE", ...labTests.map((item) => cleanText(item, 250)).filter(Boolean), "");
    if (imagingExams.length) lines.push("EXAMENS D’IMAGERIE", ...imagingExams.map((item) => cleanText(item, 250)).filter(Boolean), "");
    const attachmentLines = attachments.flatMap((item) => {
      const id = typeof item.id === "string" ? item.id : "";
      const contentType = cleanText(item.contentType, 100).toLowerCase();
      const size = Number(item.size);
      if (!/^[A-Za-z0-9_-]{10,80}$/.test(id) || !["application/pdf", "image/jpeg", "image/png"].includes(contentType) || !Number.isSafeInteger(size) || size < 1 || size > 15 * 1024 * 1024 || item.antivirusStatus !== "CLEAN" || !/^[a-f0-9]{64}$/.test(String(item.sha256Hash || ""))) return [];
      return [`${cleanText(item.originalFileName, 180) || "Pièce jointe clinique"} · ${(size / (1024 * 1024)).toFixed(2)} Mio`];
    });
    if (attachmentLines.length) lines.push("DOCUMENTS CLINIQUES JOINTS", ...attachmentLines, "Téléchargement sécurisé disponible dans votre espace patient.", "");
    lines.push(`Finalise par : ${cleanText(signature.name, 180) || cleanText(record.providerName, 180) || "Professionnel NEXA"}`);
    const signatureSpecialty = cleanText(signature.specialty, 160) || cleanText(record.specialtyName, 160);
    if (signatureSpecialty) lines.push(`Specialite : ${signatureSpecialty}`);
    if (signature.signedAt) lines.push(`Signe le : ${dateLabel(signature.signedAt)}`);
    if (addenda.length) {
      lines.push("", "CORRECTIONS AJOUTEES AU DOSSIER");
      for (const addendum of addenda) {
        lines.push(cleanText(addendum.reason, 500) || "Correction", cleanText(addendum.content, 5000));
        const addendumSignature = cleanText(addendum.signatureName, 180);
        if (addendumSignature) lines.push(`Ajoute par : ${addendumSignature}`);
        lines.push(`Date : ${dateLabel(addendum.createdAt)}`, "");
      }
    }

    const pdf = buildPdf(lines);
    await db.collection("clinicalAuditLogs").add({
      actorUid: user.uid,
      action: "clinical_record_pdf_downloaded",
      ...(standalone ? {} : { appointmentId }),
      recordId: appointmentId,
      version: Number(record.version) || 1,
      createdAt: FieldValue.serverTimestamp(),
    });
    const headers = corsHeaders(request);
    headers.set("Content-Type", "application/pdf");
    headers.set("Content-Disposition", `attachment; filename="nexa-compte-rendu-${(cleanText(record.recordNumber, 100).replace(/[^A-Za-z0-9_-]/g, "-") || appointmentId.slice(0, 10))}.pdf"`);
    headers.set("Cache-Control", "no-store, max-age=0");
    headers.set("X-Content-Type-Options", "nosniff");
    return new NextResponse(Uint8Array.from(pdf), { headers });
  } catch (error) {
    return failure(request, error);
  }
}
