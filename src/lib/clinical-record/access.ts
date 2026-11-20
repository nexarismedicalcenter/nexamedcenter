export const CONSULTATION_CLINICAL_ACCESS_DURATION_MS = 24 * 60 * 60 * 1_000;

function timestamp(value: unknown): number {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return (value.toDate() as Date).getTime();
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return Date.parse(String(value || ""));
}

export function getConsultationClinicalAccessWindow(appointment: Record<string, unknown>) {
  if (appointment.paymentStatus !== "PAID") {
    return null;
  }
  const homeVisitClosed = appointment.bookingType === "home_visit" && appointment.homeVisitMissionStatus === "COMPLETED" && String(appointment.status || "").toUpperCase() === "COMPLETED";
  if (homeVisitClosed) {
    const closedAtMs = timestamp(appointment.homeVisitMissionClosedAt);
    if (!Number.isFinite(closedAtMs) || closedAtMs <= 0) return null;
    return { startedAtMs: closedAtMs, expiresAtMs: closedAtMs + CONSULTATION_CLINICAL_ACCESS_DURATION_MS };
  }
  if (!["IN_PROGRESS", "COMPLETED"].includes(String(appointment.status || "").toUpperCase())) return null;
  // The provider opening the room is not the start of a clinical encounter.
  // Access begins only when both participants have actually joined the call.
  const startedAtMs = timestamp(appointment.effectiveConsultationStartedAt);
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;
  return {
    startedAtMs,
    expiresAtMs: startedAtMs + CONSULTATION_CLINICAL_ACCESS_DURATION_MS,
  };
}

export function hasActiveConsultationClinicalAccess(appointment: Record<string, unknown>, nowMs = Date.now()): boolean {
  const window = getConsultationClinicalAccessWindow(appointment);
  return Boolean(window && nowMs >= window.startedAtMs && nowMs < window.expiresAtMs);
}

export function hasActiveStandaloneClinicalAccess(record: Record<string, unknown>, nowMs = Date.now()): boolean {
  const grantedAtMs = timestamp(record.accessGrantedAt);
  const expiresAtMs = timestamp(record.accessExpiresAt);
  return record.accessRevoked !== true && Number.isFinite(grantedAtMs) && Number.isFinite(expiresAtMs) &&
    grantedAtMs > 0 && nowMs >= grantedAtMs && nowMs < expiresAtMs;
}
