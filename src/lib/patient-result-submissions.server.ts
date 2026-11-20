import "server-only";

import { createHash } from "node:crypto";
import { ApiRequestError } from "@/lib/auth/server";
import { RESULT_MAX_FILE_BYTES, validateResultFiles, type DiagnosticResultFileInput } from "@/lib/diagnostic-results.server";

export type PatientResultExamType = "laboratory" | "imaging";

export function cleanPatientResultText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

export function patientResultClaimId(prescriptionId: string, examType: PatientResultExamType, examIndex: number): string {
  return createHash("sha256").update(`${prescriptionId}:${examType}:${examIndex}`).digest("hex");
}

export function readPatientResultExam(value: Record<string, unknown>, examType: PatientResultExamType, examIndex: number): string {
  if (!Number.isSafeInteger(examIndex) || examIndex < 0 || examIndex > 49) {
    throw new ApiRequestError(400, "invalid-prescribed-exam", "L’examen prescrit sélectionné n’est pas valide.");
  }
  const exams = value[examType === "laboratory" ? "labExams" : "imagingExams"];
  const examName = Array.isArray(exams) ? cleanPatientResultText(exams[examIndex], 250) : "";
  if (!examName) throw new ApiRequestError(404, "prescribed-exam-not-found", "Cet examen ne fait pas partie d’une ordonnance active.");
  return examName;
}

export function validatePatientResultFiles(value: unknown, examType: PatientResultExamType): DiagnosticResultFileInput[] {
  const providerType = examType === "laboratory" ? "laboratory" : "imaging";
  const category = examType === "laboratory" ? "LAB_RESULT" : "IMAGING";
  const files = validateResultFiles(value, providerType, {
    requiredCategories: [category], allowSupplemental: true, allowMultiplePerCategory: true,
    maxFiles: 20, maxFileBytes: RESULT_MAX_FILE_BYTES,
    allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"],
  });
  if (files.some((file) => file.category !== category && file.category !== "SUPPLEMENTAL")) {
    throw new ApiRequestError(400, "invalid-result-file-category", "La catégorie du fichier ne correspond pas à l’examen prescrit.");
  }
  return files;
}

export function getPatientAge(birthDate: unknown, now = new Date()): number | null {
  const value = cleanPatientResultText(birthDate, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  const haiti = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Port-au-Prince", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const parts = Object.fromEntries(haiti.map((part) => [part.type, part.value]));
  let age = Number(parts.year) - Number(value.slice(0, 4));
  const currentMonth = Number(parts.month);
  const birthMonth = Number(value.slice(5, 7));
  const currentDay = Number(parts.day);
  const birthDay = Number(value.slice(8, 10));
  if (currentMonth < birthMonth || (currentMonth === birthMonth && currentDay < birthDay)) age -= 1;
  return age >= 0 && age <= 130 ? age : null;
}

export function isoPatientResultDate(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return (value.toDate() as Date).toISOString();
  }
  return typeof value === "string" ? value : null;
}
