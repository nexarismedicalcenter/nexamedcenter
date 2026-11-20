import "server-only";

export type PrescriptionOfferType = "medication" | "laboratory" | "imaging";
export type PatientLocation = { department: string; commune: string };
export type PrescriptionAvailabilityLine = {
  id: string;
  type: PrescriptionOfferType;
  label: string;
  dosage?: string;
  form?: string;
  quantity?: number;
  offers: Record<string, unknown>[];
};

export function cleanAvailabilityText(value: unknown, max = 180): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

export function normalizeAvailabilityText(value: unknown): string {
  return cleanAvailabilityText(value, 500).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeOrderComparableText(value: unknown): string {
  return cleanAvailabilityText(value, 500).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/\s+/g, " ");
}

export function compatibleAvailabilityText(requested: unknown, candidate: unknown): boolean {
  const wanted = new Set(normalizeAvailabilityText(requested).split(/\s+/).filter((token) => token.length >= 2));
  const available = new Set(normalizeAvailabilityText(candidate).split(/\s+/).filter(Boolean));
  return wanted.size > 0 && [...wanted].every((token) => available.has(token));
}

function objectLine(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function buildPrescriptionAvailabilityLines(prescription: Record<string, unknown>): PrescriptionAvailabilityLine[] {
  const medications = Array.isArray(prescription.medications) ? prescription.medications : [];
  const labs = Array.isArray(prescription.labExams) ? prescription.labExams : [];
  const imaging = Array.isArray(prescription.imagingExams) ? prescription.imagingExams : [];
  return [
    ...medications.map((raw, index) => {
      const item = objectLine(raw);
      return {
        id: `medication-${index + 1}`,
        type: "medication" as const,
        label: cleanAvailabilityText(item.name || item.medication_text, 180),
        dosage: cleanAvailabilityText(item.dosage, 100),
        form: cleanAvailabilityText(item.form || item.pharmaceuticalForm, 100),
        quantity: Number.isSafeInteger(item.quantity) && Number(item.quantity) > 0 ? Math.min(Number(item.quantity), 20) : 1,
        offers: [],
      };
    }),
    ...labs.map((raw, index) => {
      const item = typeof raw === "string" ? { name: raw } : objectLine(raw);
      return { id: `laboratory-${index + 1}`, type: "laboratory" as const, label: cleanAvailabilityText(item.name || item.label, 180), offers: [] };
    }),
    ...imaging.map((raw, index) => {
      const item = typeof raw === "string" ? { name: raw } : objectLine(raw);
      return { id: `imaging-${index + 1}`, type: "imaging" as const, label: cleanAvailabilityText(item.name || item.label, 180), offers: [] };
    }),
  ].filter((line) => line.label);
}

export function isMedicationAvailabilityMatch(line: PrescriptionAvailabilityLine, product: Record<string, unknown>): boolean {
  if (line.type !== "medication" || !line.label) return false;
  const requestedName = normalizeOrderComparableText(line.label);
  if (!requestedName || (requestedName !== normalizeOrderComparableText(product.name) && requestedName !== normalizeOrderComparableText(product.dci))) return false;
  const requestedDosage = normalizeOrderComparableText(line.dosage);
  const offeredDosage = normalizeOrderComparableText(product.dosage);
  if (!requestedDosage || !offeredDosage || requestedDosage !== offeredDosage) return false;
  const requestedForm = normalizeAvailabilityText(line.form);
  const offeredForm = normalizeAvailabilityText(product.pharmaceuticalForm || product.form);
  if (requestedForm && (!offeredForm || !compatibleAvailabilityText(requestedForm, offeredForm))) return false;
  return true;
}

export function isDiagnosticAvailabilityMatch(line: PrescriptionAvailabilityLine, offer: Record<string, unknown>): boolean {
  if ((line.type !== "laboratory" && line.type !== "imaging") || !line.label) return false;
  return normalizeOrderComparableText(line.label) === normalizeOrderComparableText(offer.name);
}

export function rankAvailabilityLocation(patient: PatientLocation, provider: PatientLocation): number {
  const patientDepartment = normalizeAvailabilityText(patient.department);
  const patientCommune = normalizeAvailabilityText(patient.commune);
  const providerDepartment = normalizeAvailabilityText(provider.department);
  const providerCommune = normalizeAvailabilityText(provider.commune);
  if (patientCommune && providerCommune && patientCommune === providerCommune && patientDepartment === providerDepartment) return 0;
  if (patientDepartment && providerDepartment && patientDepartment === providerDepartment) return 1;
  return 2;
}

export function getPrescriptionExpiryMillis(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") {
    const millis = Number(value.toMillis());
    return Number.isFinite(millis) ? millis : 0;
  }
  const millis = typeof value === "string" || value instanceof Date ? Date.parse(value as string) : NaN;
  return Number.isFinite(millis) ? millis : 0;
}

export function isPrescriptionPastExpiry(prescription: Record<string, unknown>, now = Date.now()): boolean {
  const expiresAt = getPrescriptionExpiryMillis(prescription.expiresAt);
  return expiresAt !== null && expiresAt <= now;
}

export function normalizePatientLocation(value: Record<string, unknown>): PatientLocation {
  return {
    department: cleanAvailabilityText(value.department, 80),
    commune: cleanAvailabilityText(value.commune, 80),
  };
}
