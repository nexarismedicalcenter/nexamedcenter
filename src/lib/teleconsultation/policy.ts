export const NEXA_TELECONSULTATION_DURATION_MINUTES = 25;

function timestamp(value: unknown): number {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return (value.toDate() as Date).getTime();
  }
  if (typeof value === "number") return value;
  return Date.parse(String(value || ""));
}

export function getTeleconsultationDurationMinutes(appointment: Record<string, unknown>): number {
  const rights = appointment.consultationRights && typeof appointment.consultationRights === "object"
    ? appointment.consultationRights as Record<string, unknown>
    : {};
  const requestedDuration = [Number(rights.durationMinutes), Number(rights.videoMinutes)]
    .find((value) => Number.isFinite(value) && value > 0);
  if (requestedDuration) return Math.round(requestedDuration);

  const startsAt = timestamp(appointment.startsAt);
  const endsAt = timestamp(appointment.endsAt);
  if (Number.isFinite(startsAt) && Number.isFinite(endsAt) && endsAt > startsAt) {
    return Math.max(1, Math.round((endsAt - startsAt) / 60_000));
  }
  return 10;
}
