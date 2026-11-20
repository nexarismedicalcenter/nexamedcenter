import "server-only";

export const NURSING_SETTINGS_PATH = "nexaHomeCareSettings/nursing";

export const NURSING_SERVICE_CATALOG = [
  { id: "vital_signs", label: "Prise des signes vitaux", detail: "Tension, température, fréquence cardiaque, saturation et glycémie capillaire." },
  { id: "medication_administration", label: "Administration de médicaments", detail: "Injections et perfusions, selon prescription et qualification." },
  { id: "wound_care", label: "Soins de plaies", detail: "Pansements, escarres et suivi de cicatrisation." },
  { id: "sample_collection", label: "Prélèvements médicaux", detail: "Prélèvements sanguins et collecte d’échantillons." },
  { id: "postoperative_care", label: "Soins postopératoires", detail: "Surveillance, pansements et retrait selon prescription." },
  { id: "chronic_care", label: "Suivi des maladies chroniques", detail: "Suivi infirmier de patients atteints de maladies chroniques." },
  { id: "elderly_assistance", label: "Assistance aux personnes âgées", detail: "Mobilité, prévention des chutes et surveillance générale." },
  { id: "hygiene_comfort", label: "Soins d’hygiène et de confort", detail: "Aide à l’hygiène, à l’habillage et prévention des escarres." },
  { id: "medical_devices", label: "Gestion de dispositifs médicaux", detail: "Sondes, stomies et oxygénothérapie selon qualification." },
  { id: "therapeutic_education", label: "Éducation thérapeutique", detail: "Conseils de santé et suivi de l’observance." },
  { id: "palliative_care", label: "Accompagnement en soins palliatifs", detail: "Soins de confort et accompagnement du patient et de ses proches." },
] as const;

export const NURSING_PERIODS = ["DAY", "NIGHT", "WEEKEND"] as const;
export type NursingPeriod = typeof NURSING_PERIODS[number];

export type NursingPeriodRule = { daysOfWeek: number[]; startTime: string; endTime: string; endDayOffset: number };
export type NursingPeriodRules = Record<NursingPeriod, NursingPeriodRule>;

export const DEFAULT_NURSING_PERIOD_RULES: NursingPeriodRules = {
  DAY: { daysOfWeek: [1, 2, 3, 4, 5], startTime: "08:00", endTime: "16:00", endDayOffset: 0 },
  NIGHT: { daysOfWeek: [1, 2, 3, 4, 5], startTime: "16:00", endTime: "08:00", endDayOffset: 1 },
  WEEKEND: { daysOfWeek: [6], startTime: "08:00", endTime: "08:00", endDayOffset: 2 },
};

export type NursingZone = {
  id: string;
  department: string;
  commune: string;
  active: boolean;
  tariffs: Record<NursingPeriod, number | null>;
};

export type NursingWeekAvailability = { weekStart: string; periods: NursingPeriod[] };
export type NursingServiceProfile = {
  experienceStartYear: number;
  serviceIds: string[];
  zoneIds: string[];
  weeklyAvailability: NursingWeekAvailability[];
};

const serviceIds = new Set<string>(NURSING_SERVICE_CATALOG.map((service) => service.id));
const periodSet = new Set<string>(NURSING_PERIODS);

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function parseTariff(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 && amount <= 10_000_000 ? amount : null;
}

export function normalizeNursingZones(value: unknown): NursingZone[] | null {
  if (!Array.isArray(value) || value.length > 200) return null;
  const result: NursingZone[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    const id = cleanText(item.id, 40);
    const department = cleanText(item.department, 80);
    const commune = cleanText(item.commune, 80);
    if (!/^[a-zA-Z0-9-]{8,40}$/.test(id) || !department || !commune || ids.has(id)) return null;
    const tariffsRaw = item.tariffs && typeof item.tariffs === "object" && !Array.isArray(item.tariffs)
      ? item.tariffs as Record<string, unknown>
      : {};
    for (const period of NURSING_PERIODS) {
      const rawTariff = tariffsRaw[period];
      if (rawTariff !== null && rawTariff !== undefined && rawTariff !== "" && parseTariff(rawTariff) === null) return null;
    }
    ids.add(id);
    result.push({
      id,
      department,
      commune,
      active: item.active !== false,
      tariffs: {
        DAY: parseTariff(tariffsRaw.DAY),
        NIGHT: parseTariff(tariffsRaw.NIGHT),
        WEEKEND: parseTariff(tariffsRaw.WEEKEND),
      },
    });
  }
  return result;
}

function validMonday(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && date.getUTCDay() === 1;
}

export function normalizeNursingServiceProfile(value: unknown, currentYear = new Date().getUTCFullYear()): NursingServiceProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const experienceStartYear = Number(raw.experienceStartYear);
  const serviceIdsRaw = Array.isArray(raw.serviceIds) ? raw.serviceIds : [];
  const zoneIdsRaw = Array.isArray(raw.zoneIds) ? raw.zoneIds : [];
  const weeksRaw = Array.isArray(raw.weeklyAvailability) ? raw.weeklyAvailability : [];
  if (!Number.isSafeInteger(experienceStartYear) || experienceStartYear < 1950 || experienceStartYear > currentYear) return null;
  if (serviceIdsRaw.length < 1 || serviceIdsRaw.length > NURSING_SERVICE_CATALOG.length || serviceIdsRaw.some((id) => typeof id !== "string" || !serviceIds.has(id)) || new Set(serviceIdsRaw).size !== serviceIdsRaw.length) return null;
  if (zoneIdsRaw.length < 1 || zoneIdsRaw.length > 200 || zoneIdsRaw.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9-]{8,40}$/.test(id)) || new Set(zoneIdsRaw).size !== zoneIdsRaw.length) return null;
  if (weeksRaw.length < 1 || weeksRaw.length > 52) return null;
  const weeklyAvailability: NursingWeekAvailability[] = [];
  const weekStarts = new Set<string>();
  for (const rawWeek of weeksRaw) {
    if (!rawWeek || typeof rawWeek !== "object" || Array.isArray(rawWeek)) return null;
    const week = rawWeek as Record<string, unknown>;
    if (!validMonday(week.weekStart) || !Array.isArray(week.periods) || week.periods.length < 1 || week.periods.length > 3) return null;
    if (weekStarts.has(week.weekStart) || week.periods.some((period) => typeof period !== "string" || !periodSet.has(period)) || new Set(week.periods).size !== week.periods.length) return null;
    weekStarts.add(week.weekStart);
    weeklyAvailability.push({ weekStart: week.weekStart, periods: week.periods as NursingPeriod[] });
  }
  weeklyAvailability.sort((left, right) => left.weekStart.localeCompare(right.weekStart));
  return { experienceStartYear, serviceIds: serviceIdsRaw as string[], zoneIds: zoneIdsRaw as string[], weeklyAvailability };
}

export function normalizeNursingPeriodRules(value: unknown): NursingPeriodRules | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const result = {} as NursingPeriodRules;
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  for (const period of NURSING_PERIODS) {
    const candidate = raw[period];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const rule = candidate as Record<string, unknown>;
    if (!Array.isArray(rule.daysOfWeek) || rule.daysOfWeek.length < 1 || rule.daysOfWeek.length > 7 ||
        rule.daysOfWeek.some((day) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6) ||
        new Set(rule.daysOfWeek).size !== rule.daysOfWeek.length ||
        typeof rule.startTime !== "string" || !timePattern.test(rule.startTime) ||
        typeof rule.endTime !== "string" || !timePattern.test(rule.endTime) ||
        !Number.isInteger(rule.endDayOffset) || Number(rule.endDayOffset) < 0 || Number(rule.endDayOffset) > 2 ||
        (rule.endDayOffset === 0 && rule.endTime <= rule.startTime)) return null;
    result[period] = {
      daysOfWeek: [...rule.daysOfWeek as number[]].sort((a, b) => a - b),
      startTime: rule.startTime,
      endTime: rule.endTime,
      endDayOffset: Number(rule.endDayOffset),
    };
  }
  return result;
}

export function configuredNursingPeriodRules(raw: unknown): NursingPeriodRules {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).periodRules : null;
  return normalizeNursingPeriodRules(source) || DEFAULT_NURSING_PERIOD_RULES;
}

export function configuredNursingSettings(raw: unknown): NursingZone[] {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>).zones : [];
  return normalizeNursingZones(source) || [];
}

export function nursingProfileHasConfiguredTariffs(profile: NursingServiceProfile, zones: NursingZone[]): boolean {
  const zoneById = new Map(zones.filter((zone) => zone.active).map((zone) => [zone.id, zone]));
  return profile.zoneIds.every((id) => {
    const zone = zoneById.get(id);
    return Boolean(zone && profile.weeklyAvailability.every((week) => week.periods.every((period) => zone.tariffs[period] !== null)));
  });
}

export function nursingProfileIsPublishable(value: unknown, zones: NursingZone[], currentYear = new Date().getUTCFullYear()): value is NursingServiceProfile {
  const profile = normalizeNursingServiceProfile(value, currentYear);
  if (!profile || !nursingProfileHasConfiguredTariffs(profile, zones)) return false;
  const activeZones = new Set(zones.filter((zone) => zone.active).map((zone) => zone.id));
  return profile.zoneIds.every((id) => activeZones.has(id));
}
