import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { HOME_VISIT_SERVICES } from "@/lib/home-visits";

type HomeVisitZone = { department: string; commune: string };

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "admin-home-visit-providers-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les paramètres des visites médicales à domicile ne sont pas disponibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA admin home-visit providers failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function parseZones(value: unknown): HomeVisitZone[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new ApiRequestError(400, "home-visit-zones-required", "Ajoutez entre une et vingt zones pour activer les visites à domicile.");
  const zones = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ApiRequestError(400, "invalid-home-visit-zone", "Une zone de visite n’est pas valide.");
    const zone = entry as Record<string, unknown>;
    const department = clean(zone.department, 80);
    const commune = clean(zone.commune, 80);
    if (!department || !commune) throw new ApiRequestError(400, "invalid-home-visit-zone", "Chaque zone doit inclure un département et une commune.");
    return { department, commune };
  });
  if (new Set(zones.map((zone) => `${zone.department.toLocaleLowerCase("fr-HT")}|${zone.commune.toLocaleLowerCase("fr-HT")}`)).size !== zones.length) {
    throw new ApiRequestError(400, "duplicate-home-visit-zone", "Retirez les zones en double.");
  }
  return zones;
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-home-visit-providers-list", limit: 60, windowMs: 5 * 60_000 });
    const snapshot = await getFirebaseAdminDb().collection("providerProfiles").where("type", "==", "doctor").limit(300).get();
    const providers = snapshot.docs.flatMap((doc) => {
      const data = doc.data();
      if (data.status !== "verified" || data.publiclyListed !== true || data.clinicalCredentialsVerified !== true) return [];
      const profile = data.profile && typeof data.profile === "object" ? data.profile as Record<string, unknown> : {};
      const zones = Array.isArray(profile.homeVisitZones) ? profile.homeVisitZones.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const zone = entry as Record<string, unknown>;
        const department = clean(zone.department, 80);
        const commune = clean(zone.commune, 80);
        return department && commune ? [{ department, commune }] : [];
      }) : [];
      return [{
        uid: doc.id,
        name: clean(profile.name, 120) || "Médecin NEXA",
        specialty: clean(profile.specialty, 100),
        enabled: profile.homeVisitEnabled === true,
        serviceTariffs: Object.fromEntries(HOME_VISIT_SERVICES.flatMap((service) => {
          const amount = Number((profile.homeVisitTariffs as Record<string, unknown> | undefined)?.[service.id]);
          return Number.isSafeInteger(amount) && amount > 0 ? [[service.id, amount]] : [];
        })),
        zones,
      }];
    }).sort((left, right) => left.name.localeCompare(right.name, "fr"));
    return json(request, { ok: true, providers });
  } catch (error) { return failure(request, error); }
}

export async function POST(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-home-visit-provider-save", limit: 60, windowMs: 5 * 60_000 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-home-visit-settings", "Les paramètres ne sont pas valides.");
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some((key) => !["uid", "enabled", "serviceTariffs", "zones"].includes(key))) throw new ApiRequestError(400, "unexpected-home-visit-setting", "Les paramètres contiennent un champ non pris en charge.");
    const uid = clean(input.uid, 128);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid) || typeof input.enabled !== "boolean") throw new ApiRequestError(400, "invalid-home-visit-settings", "Le médecin ou l’état du service n’est pas valide.");
    const zones = input.enabled ? parseZones(input.zones) : [];
    if (input.serviceTariffs === null || typeof input.serviceTariffs !== "object" || Array.isArray(input.serviceTariffs)) throw new ApiRequestError(400, "invalid-home-visit-tariffs", "Les tarifs par service ne sont pas valides.");
    const rawTariffs = input.serviceTariffs as Record<string, unknown>;
    if (Object.keys(rawTariffs).some((serviceId) => !HOME_VISIT_SERVICES.some((service) => service.id === serviceId))) throw new ApiRequestError(400, "invalid-home-visit-service", "Un service à domicile n’est pas reconnu.");
    const serviceTariffs = Object.fromEntries(Object.entries(rawTariffs).flatMap(([serviceId, value]) => {
      if (value === null || value === "") return [];
      if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 10_000_000) throw new ApiRequestError(400, "invalid-home-visit-fee", "Chaque tarif doit être un montant entier positif en HTG.");
      return [[serviceId, Number(value)]];
    }));
    if (input.enabled && Object.keys(serviceTariffs).length < 1) throw new ApiRequestError(400, "home-visit-service-required", "Configurez le tarif d’au moins un service avant d’activer les visites à domicile.");

    const db = getFirebaseAdminDb();
    const providerRef = db.collection("providerProfiles").doc(uid);
    const auditRef = db.collection("adminAuditLogs").doc();
    await db.runTransaction(async (transaction) => {
      const provider = await transaction.get(providerRef);
      if (!provider.exists || provider.get("type") !== "doctor" || provider.get("status") !== "verified" || provider.get("publiclyListed") !== true || provider.get("clinicalCredentialsVerified") !== true) {
        throw new ApiRequestError(409, "home-visit-provider-ineligible", "Seul un médecin vérifié et publié peut proposer des visites à domicile.");
      }
      transaction.set(providerRef, {
        profile: {
          homeVisitEnabled: input.enabled,
          homeVisitTariffs: serviceTariffs,
          homeVisitZones: zones,
        },
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.create(auditRef, {
        actorUid: admin.uid,
        action: input.enabled ? "home_visit_provider_settings_enabled" : "home_visit_provider_settings_disabled",
        resource: `providerProfiles/${uid}`,
        configuredServiceCount: Object.keys(serviceTariffs).length,
        serviceZoneCount: zones.length,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    return json(request, { ok: true, uid, enabled: input.enabled, serviceTariffs, zones });
  } catch (error) { return failure(request, error); }
}
