import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

const WIN_ANSI: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89,
  "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95,
  "–": 0x96, "—": 0x97, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
  "À": 0xc0, "Â": 0xc2, "Ç": 0xc7, "È": 0xc8, "É": 0xc9, "Ê": 0xca, "Ë": 0xcb, "Î": 0xce, "Ï": 0xcf,
  "Ô": 0xd4, "Ù": 0xd9, "Û": 0xdb, "Ü": 0xdc, "à": 0xe0, "â": 0xe2, "ç": 0xe7, "è": 0xe8, "é": 0xe9,
  "ê": 0xea, "ë": 0xeb, "î": 0xee, "ï": 0xef, "ô": 0xf4, "ù": 0xf9, "û": 0xfb, "ü": 0xfc, "°": 0xb0,
};

function winAnsi(value: string): string {
  return Array.from(value).map((char) => {
    if (char === "\r" || char === "\n") return " ";
    const code = char.charCodeAt(0);
    return code <= 0xff ? char : WIN_ANSI[char] ? String.fromCharCode(WIN_ANSI[char]) : "?";
  }).join("");
}

function escapePdf(value: string): string {
  return winAnsi(value).replace(/[\\()]/g, "\\$&");
}

function wrap(value: unknown, limit = 88): string[] {
  const words = String(value ?? "").split(/\s+/).filter(Boolean);
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
  const pageLines = Array.from({ length: Math.max(1, Math.ceil(normalized.length / 48)) }, (_, index) => normalized.slice(index * 48, (index + 1) * 48));
  const objects: string[] = [];
  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  const pageIds = pageLines.map((_, index) => 4 + index * 2);
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;
  pageLines.forEach((page, index) => {
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

export async function GET(request: Request, { params }: { params: Promise<{ prescriptionId: string }> }) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    const { prescriptionId } = await params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(prescriptionId)) throw new ApiRequestError(400, "invalid-prescription", "La référence de l’ordonnance n’est pas valide.");
    const db = getFirebaseAdminDb();
    const prescriptionSnapshot = await db.collection("clinicalPrescriptions").doc(prescriptionId).get();
    if (!prescriptionSnapshot.exists) throw new ApiRequestError(404, "prescription-not-found", "Ordonnance introuvable.");
    const prescription = prescriptionSnapshot.data() || {};
    const patientView = prescription.patientUid === user.uid;
    if (patientView && prescription.status !== "VALIDATED") throw new ApiRequestError(404, "prescription-not-found", "Ordonnance validée introuvable.");
    if (!patientView) {
      if (prescription.providerUid !== user.uid) throw new ApiRequestError(403, "forbidden", "Cette ordonnance ne vous est pas accessible.");
      const provider = await db.collection("providerProfiles").doc(user.uid).get();
      if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) throw new ApiRequestError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé.");
      if (prescription.status !== "VALIDATED") throw new ApiRequestError(409, "prescription-not-validated", "Seule une ordonnance validée peut être téléchargée.");
    }
    const patientProfile = await db.collection("patientProfiles").doc(String(prescription.patientUid || "_")).get();
    const patientData = patientProfile.data() || {};
    const date = prescription.validatedAt && typeof prescription.validatedAt === "object" && "toDate" in prescription.validatedAt
      ? (prescription.validatedAt.toDate() as Date)
      : new Date();
    const lines = [
      "NEXA MEDICAL CENTER",
      "ORDONNANCE MEDICALE",
      "",
      `Patient : ${typeof patientData.displayName === "string" ? patientData.displayName : "Patient NEXA"}`,
      `Numero patient : ${typeof patientData.patientNumber === "string" ? patientData.patientNumber : "Non renseigne"}`,
      `Medecin : ${prescription.providerName || "Medecin NEXA"}`,
      `Specialite : ${prescription.specialtyName || "Non renseignee"}`,
      `Date de validation : ${date.toLocaleDateString("fr-HT")}`,
      `Version : ${Number(prescription.version) || 1}`,
      `Reference rendez-vous : ${String(prescription.appointmentId || "")}`,
      "",
    ];
    const medications = Array.isArray(prescription.medications) ? prescription.medications as Record<string, unknown>[] : [];
    if (medications.length) {
      lines.push("MEDICAMENTS");
      medications.forEach((medication, index) => {
        lines.push(`${index + 1}. ${medication.name || "Medicament"}`);
        const details = [medication.dosage, medication.form, medication.route ? `Voie : ${medication.route}` : "", medication.quantity != null ? `Quantite : ${medication.quantity}` : "", medication.duration ? `Duree : ${medication.duration}` : ""].filter(Boolean).join(" · ");
        if (details) lines.push(`   ${details}`);
        if (medication.instructions) lines.push(`   Instructions : ${medication.instructions}`);
      });
      lines.push("");
    }
    const labExams = Array.isArray(prescription.labExams) ? prescription.labExams as string[] : [];
    if (labExams.length) lines.push("EXAMENS DE LABORATOIRE", ...labExams.map((exam, index) => `${index + 1}. ${exam}`), "");
    const imagingExams = Array.isArray(prescription.imagingExams) ? prescription.imagingExams as string[] : [];
    if (imagingExams.length) lines.push("EXAMENS D’IMAGERIE", ...imagingExams.map((exam, index) => `${index + 1}. ${exam}`), "");
    if (prescription.notes) lines.push("NOTES", String(prescription.notes), "");
    const signature = prescription.signature && typeof prescription.signature === "object" ? prescription.signature as Record<string, unknown> : {};
    lines.push(`Validation NEXA : ${signature.name || prescription.providerName || "Medecin NEXA"}`, String(signature.specialty || prescription.specialtyName || ""), "Ce document est une ordonnance validee dans NEXA.");
    const pdf = buildPdf(lines);
    const pdfBody = Uint8Array.from(pdf).buffer as ArrayBuffer;
    await db.collection("clinicalAuditLogs").add({ actorUid: user.uid, action: "clinical_prescription_pdf_downloaded", appointmentId: prescription.appointmentId, prescriptionId, version: Number(prescription.version) || 1, createdAt: FieldValue.serverTimestamp() });
    return new NextResponse(pdfBody, { headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="nexa-ordonnance-${prescriptionId.slice(0, 10)}.pdf"`,
      "Cache-Control": "no-store, max-age=0",
    } });
  } catch (error) {
    if (error instanceof ApiRequestError) return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store, max-age=0" } });
    console.error("NEXA prescription PDF generation failed", error instanceof Error ? error.name : "unknown-error");
    return NextResponse.json({ ok: false, error: "Le document PDF ne peut pas être généré." }, { status: 500, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
