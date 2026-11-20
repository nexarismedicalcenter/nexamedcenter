import { connection, NextResponse } from "next/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { HOME_VISIT_SERVICES } from "@/lib/home-visits";

type CatalogType = "doctors" | "laboratories" | "imaging-centers" | "pharmacies";

type PublicDirectoryItem = {
  id: string;
  type: CatalogType;
  name: string;
  specialty?: string;
  specialties?: string[];
  bio?: string;
  address?: string;
  department?: string;
  commune?: string;
  phone?: string;
  languages?: string[];
  consultationModes?: string[];
  indicativeFee?: number;
  photoUrl?: string;
  services?: string[];
  openingHours?: string;
  homeVisitServices?: { id: string; label: string; tariffHTG: number }[];
  homeVisitZones?: { department: string; commune: string }[];
};

function clean(value: unknown, max = 160): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function publicProvider(id: string, value: Record<string, unknown>): PublicDirectoryItem | null {
  const typeMap: Record<string, CatalogType> = {
    doctor: "doctors",
    laboratory: "laboratories",
    imaging: "imaging-centers",
    pharmacy: "pharmacies",
  };
  const type = typeof value.type === "string" ? typeMap[value.type] : undefined;
  if (!type) return null;
  if (value.status !== "verified" || value.publiclyListed !== true) return null;

  const typeValue = type;
  if (typeValue === "doctors" && value.clinicalCredentialsVerified !== true) return null;
  const profile = value.profile && typeof value.profile === "object"
    ? value.profile as Record<string, unknown>
    : {};
  const name = clean(profile.name || profile.displayName || value.displayName, 120);
  if (!name) return null;

  const arrayText = (candidate: unknown, max: number): string[] =>
    Array.isArray(candidate)
      ? candidate.map((entry) => clean(entry, max)).filter(Boolean).slice(0, 12)
      : [];

  const item: PublicDirectoryItem = {
    id,
    type: typeValue,
    name,
    address: clean(profile.address, 200) || undefined,
    department: clean(profile.department, 80) || undefined,
    commune: clean(profile.commune, 80) || undefined,
    phone: clean(profile.publicPhone, 30) || undefined,
  };

  if (typeValue === "doctors") {
    item.specialty = clean(profile.specialty, 100) || undefined;
    item.specialties = arrayText(profile.specialties, 100);
    item.bio = clean(profile.publicBio, 500) || undefined;
    item.languages = arrayText(profile.languages, 40);
    item.consultationModes = arrayText(profile.consultationModes, 40);
    item.indicativeFee = Number.isFinite(Number(profile.indicativeFee))
      ? Math.max(0, Number(profile.indicativeFee))
      : undefined;
    item.photoUrl = clean(profile.photoUrl, 1000) || undefined;
    const rawHomeVisitTariffs = profile.homeVisitTariffs && typeof profile.homeVisitTariffs === "object" && !Array.isArray(profile.homeVisitTariffs)
      ? profile.homeVisitTariffs as Record<string, unknown>
      : {};
    const homeVisitServices = HOME_VISIT_SERVICES.flatMap((service) => {
      const tariffHTG = Number(rawHomeVisitTariffs[service.id]);
      return Number.isSafeInteger(tariffHTG) && tariffHTG > 0 ? [{ id: service.id, label: service.label, tariffHTG }] : [];
    });
    const homeVisitZones = Array.isArray(profile.homeVisitZones) ? profile.homeVisitZones.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const zone = entry as Record<string, unknown>;
      const department = clean(zone.department, 80);
      const commune = clean(zone.commune, 80);
      return department && commune ? [{ department, commune }] : [];
    }).slice(0, 20) : [];
    if (profile.homeVisitEnabled === true && homeVisitServices.length && homeVisitZones.length) {
      item.homeVisitServices = homeVisitServices;
      item.homeVisitZones = homeVisitZones;
    }
  } else {
    item.services = arrayText(profile.services, 100);
    item.openingHours = clean(profile.openingHours, 300) || undefined;
  }

  return item;
}

export async function GET(request: Request) {
  await connection();
  const search = new URL(request.url).searchParams;
  const type = search.get("type") as CatalogType | null;
  const service = search.get("service") || "";
  const serviceId = search.get("serviceId") || "";
  const homeVisitServiceIds = new Set<string>(HOME_VISIT_SERVICES.map((entry) => entry.id));
  const allowed: CatalogType[] = ["doctors", "laboratories", "imaging-centers", "pharmacies"];
  if (!type || !allowed.includes(type) || (service && (service !== "HOME_VISIT" || type !== "doctors")) || (serviceId && (!homeVisitServiceIds.has(serviceId) || service !== "HOME_VISIT"))) {
    return NextResponse.json(
      { ok: false, error: "Type de répertoire invalide." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const snapshot = await getFirebaseAdminDb()
      .collection("providerProfiles")
      .where("status", "==", "verified")
      .limit(300)
      .get();

    const normalize = (value: string) => value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("fr");
    const query = normalize(clean(search.get("q"), 100));
    const department = normalize(clean(search.get("department"), 80));
    const results = snapshot.docs
      .map((doc) => publicProvider(doc.id, doc.data() as Record<string, unknown>))
      .filter((item): item is PublicDirectoryItem => item !== null && item.type === type)
      .filter((item) => {
        const words = normalize([
          item.name,
          item.specialty,
          ...(item.specialties || []),
          ...(item.services || []),
          item.commune,
          item.department,
          ...(item.homeVisitServices || []).map((homeVisitService) => homeVisitService.label),
        ].filter(Boolean).join(" "));
        return (!query || words.includes(query)) &&
          (!department || normalize(item.department || "").includes(department)) &&
          (service !== "HOME_VISIT" || Boolean(item.homeVisitServices?.length && item.homeVisitZones?.length)) &&
          (!serviceId || Boolean(item.homeVisitServices?.some((homeVisitService) => homeVisitService.id === serviceId)));
      })
      .slice(0, 100);

    return NextResponse.json(
      { ok: true, results },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    console.error("Public catalog request failed", error instanceof Error ? error.name : "unknown-error");
    return NextResponse.json(
      { ok: false, error: "Le répertoire n’est pas disponible pour le moment." },
      { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
