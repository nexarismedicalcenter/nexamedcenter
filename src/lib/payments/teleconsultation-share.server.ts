import "server-only";

export const TELECONSULTATION_SHARE_SETTINGS_PATH = "nexaPaymentSettings/teleconsultationShare";

export type TeleconsultationSharePolicy = {
  doctorRateBps: number;
  nexarisRateBps: number;
};

export function normalizeTeleconsultationSharePolicy(value: unknown): TeleconsultationSharePolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const policy = value as Record<string, unknown>;
  const doctorRateBps = Number(policy.doctorRateBps);
  const nexarisRateBps = Number(policy.nexarisRateBps);
  if (
    !Number.isSafeInteger(doctorRateBps) || !Number.isSafeInteger(nexarisRateBps) ||
    doctorRateBps < 0 || doctorRateBps > 10_000 || nexarisRateBps < 0 || nexarisRateBps > 10_000 ||
    doctorRateBps + nexarisRateBps !== 10_000
  ) return null;
  return { doctorRateBps, nexarisRateBps };
}
