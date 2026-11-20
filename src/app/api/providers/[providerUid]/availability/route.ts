import { NextResponse } from "next/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { HOME_VISIT_SERVICES } from "@/lib/home-visits";
import { NEXA_TELECONSULTATION_DURATION_MINUTES } from "@/lib/teleconsultation/policy";

const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_LOOKAHEAD_DAYS = 90;
const SERVICE_TYPES = new Set(["TELECONSULTATION", "HOME_VISIT"]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ providerUid: string }> },
) {
  const { providerUid } = await params;
  if (!UID_PATTERN.test(providerUid)) {
    return NextResponse.json({ ok: false, error: "Professionnel introuvable." }, { status: 404 });
  }

  const serviceType = new URL(request.url).searchParams.get("serviceType") || "TELECONSULTATION";
  if (!SERVICE_TYPES.has(serviceType)) return NextResponse.json({ ok: false, error: "Type de service invalide." }, { status: 400 });

  const db = getFirebaseAdminDb();
  const providerSnapshot = await db.collection("providerProfiles").doc(providerUid).get();
  const provider = providerSnapshot.data() || {};
  const profile = provider.profile && typeof provider.profile === "object"
    ? provider.profile as Record<string, unknown>
    : {};
  const homeVisitTariffs = profile.homeVisitTariffs && typeof profile.homeVisitTariffs === "object" && !Array.isArray(profile.homeVisitTariffs)
    ? Object.fromEntries(HOME_VISIT_SERVICES.flatMap((service) => {
      const amount = Number((profile.homeVisitTariffs as Record<string, unknown>)[service.id]);
      return Number.isSafeInteger(amount) && amount > 0 ? [[service.id, amount]] : [];
    })) as Record<string, number>
    : {};
  const homeVisitZones = Array.isArray(profile.homeVisitZones) ? profile.homeVisitZones.filter((zone) =>
    zone && typeof zone === "object" && typeof (zone as Record<string, unknown>).department === "string" && typeof (zone as Record<string, unknown>).commune === "string",
  ).map((zone) => {
    const entry = zone as Record<string, unknown>;
    return { department: String(entry.department).slice(0, 80), commune: String(entry.commune).slice(0, 80) };
  }).slice(0, 20) : [];
  if (
    !providerSnapshot.exists || provider.status !== "verified" ||
    provider.type !== "doctor" || provider.publiclyListed !== true || provider.clinicalCredentialsVerified !== true
  ) {
    return NextResponse.json({ ok: false, error: "Professionnel introuvable." }, { status: 404 });
  }
  if (serviceType === "HOME_VISIT" && (profile.homeVisitEnabled !== true || !Object.keys(homeVisitTariffs).length || !homeVisitZones.length)) {
    return NextResponse.json({ ok: false, error: "Les visites à domicile ne sont pas configurées pour ce médecin." }, { status: 404 });
  }

  const now = new Date();
  const until = new Date(now.getTime() + MAX_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
  const buildSlotsQuery = (status: string) => {
    let query = db.collection("providerAvailabilitySlots").where("providerUid", "==", providerUid);
    if (serviceType === "HOME_VISIT") query = query.where("serviceType", "==", serviceType);
    return query.where("status", "==", status).where("startsAt", ">=", now.toISOString()).where("startsAt", "<=", until.toISOString()).orderBy("startsAt").limit(100);
  };
  const [availableSnapshot, expiredHoldSnapshot] = await Promise.all([
    buildSlotsQuery("available").get(),
    buildSlotsQuery("held").get(),
  ]);
  const slots = [
    ...availableSnapshot.docs,
    ...expiredHoldSnapshot.docs.filter((slot) => Number(slot.get("holdExpiresAt")) <= now.getTime()),
  ].filter((slot) => String(slot.get("serviceType") || "TELECONSULTATION") === serviceType)
    .sort((left, right) => String(left.get("startsAt")).localeCompare(String(right.get("startsAt")))).slice(0, 100);

  return NextResponse.json({
    ok: true,
    provider: {
      id: providerUid,
      name: typeof profile.name === "string" ? profile.name.slice(0, 120) : "",
      specialty: typeof profile.specialty === "string" ? profile.specialty.slice(0, 100) : "",
      department: typeof profile.department === "string" ? profile.department.slice(0, 80) : "",
      commune: typeof profile.commune === "string" ? profile.commune.slice(0, 80) : "",
      indicativeFee: Number.isSafeInteger(profile.indicativeFee) ? profile.indicativeFee : null,
      ...(serviceType === "HOME_VISIT" ? { homeVisitTariffs, homeVisitZones } : {}),
      consultationDurationMinutes: serviceType === "HOME_VISIT" ? 60 : NEXA_TELECONSULTATION_DURATION_MINUTES,
      serviceType,
    },
    slots: slots.map((slot) => ({
      id: slot.id,
      startsAt: String(slot.get("startsAt") || ""),
      endsAt: String(slot.get("endsAt") || ""),
    })),
  }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
