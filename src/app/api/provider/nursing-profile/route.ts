import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { configuredNursingPeriodRules, configuredNursingSettings, NURSING_SETTINGS_PATH, normalizeNursingServiceProfile, nursingProfileHasConfiguredTariffs } from "@/lib/nursing/service-profile.server";

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "nursing-profile-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le profil infirmier n’est pas accessible pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA nursing profile failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

async function requireVerifiedNurse(request: Request) {
  const user = await requireFirebaseUser(request);
  await requireAppCheck(request);
  const provider = await getFirebaseAdminDb().collection("providerProfiles").doc(user.uid).get();
  if (!provider.exists || provider.get("type") !== "nurse" || provider.get("status") !== "verified" || provider.get("nursingCredentialsVerified") !== true) {
    throw new ApiRequestError(403, "verified-nurse-required", "Seul un profil infirmier NEXA dont les qualifications ont été vérifiées peut compléter ces informations.");
  }
  return { user, provider };
}

function haitiDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Port-au-Prince", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function startOfHaitiWeek(date: string): string {
  const day = new Date(`${date}T12:00:00.000Z`);
  const daysSinceMonday = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - daysSinceMonday);
  return day.toISOString().slice(0, 10);
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const { provider } = await requireVerifiedNurse(request);
    const db = getFirebaseAdminDb();
    const settingsSnapshot = await db.doc(NURSING_SETTINGS_PATH).get();
    const settings = settingsSnapshot.data();
    const zones = configuredNursingSettings(settings).filter((zone) => zone.active);
    const periodRules = configuredNursingPeriodRules(settings);
    const profile = provider.get("nursingServiceProfile") || null;
    return json(request, {
      ok: true,
      profile,
      zones,
      periodRules,
      serviceProfileStatus: String(provider.get("serviceProfileStatus") || "INCOMPLETE"),
      serviceProfileReviewReason: typeof provider.get("serviceProfileReviewReason") === "string" ? provider.get("serviceProfileReviewReason") : "",
      experienceYears: profile && typeof profile === "object" && Number.isSafeInteger(Number((profile as Record<string, unknown>).experienceStartYear))
        ? Math.max(0, new Date().getUTCFullYear() - Number((profile as Record<string, unknown>).experienceStartYear))
        : null,
      currentYear: new Date().getUTCFullYear(),
      qualifications: Array.isArray(provider.get("profile.nursingQualifications")) ? provider.get("profile.nursingQualifications") : [],
    });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const { user, provider } = await requireVerifiedNurse(request);
    await enforceUserRateLimit({ uid: user.uid, action: "save-nursing-service-profile", limit: 12, windowMs: 5 * 60_000 });
    const body = await request.json().catch(() => null);
    const profile = normalizeNursingServiceProfile(body, new Date().getUTCFullYear());
    if (!profile) throw new ApiRequestError(400, "invalid-nursing-service-profile", "Complétez une année d’expérience, au moins un service, une zone et une disponibilité hebdomadaire valide.");

    const db = getFirebaseAdminDb();
    const settingsSnapshot = await db.doc(NURSING_SETTINGS_PATH).get();
    const zones = configuredNursingSettings(settingsSnapshot.data());
    const activeZoneIds = new Set(zones.filter((zone) => zone.active).map((zone) => zone.id));
    if (profile.zoneIds.some((id) => !activeZoneIds.has(id))) {
      throw new ApiRequestError(409, "nursing-zone-unavailable", "Une des zones sélectionnées n’est plus proposée par NEXA. Actualisez la page et choisissez une zone active.");
    }

    const today = haitiDate();
    const thisWeek = startOfHaitiWeek(today);
    const lastAllowedWeek = new Date(`${thisWeek}T12:00:00.000Z`);
    lastAllowedWeek.setUTCDate(lastAllowedWeek.getUTCDate() + 26 * 7);
    if (profile.weeklyAvailability.some((week) => week.weekStart < thisWeek || week.weekStart > lastAllowedWeek.toISOString().slice(0, 10))) {
      throw new ApiRequestError(400, "nursing-week-out-of-range", "Choisissez une semaine à partir de cette semaine et dans les six prochains mois.");
    }

    const tariffsConfigured = nursingProfileHasConfiguredTariffs(profile, zones);
    const serviceProfileStatus = tariffsConfigured ? "PENDING_REVIEW" : "INCOMPLETE";
    const providerRef = db.collection("providerProfiles").doc(user.uid);
    await db.runTransaction(async (transaction) => {
      const fresh = await transaction.get(providerRef);
      if (!fresh.exists || fresh.get("type") !== "nurse" || fresh.get("status") !== "verified" || fresh.get("nursingCredentialsVerified") !== true) {
        throw new ApiRequestError(403, "verified-nurse-required", "Le statut de votre profil a changé. Contactez l’administration NEXA.");
      }
      transaction.set(providerRef, {
        nursingServiceProfile: profile,
        serviceProfileStatus,
        publiclyListed: false,
        serviceProfileReviewReason: FieldValue.delete(),
        serviceProfileReviewedAt: FieldValue.delete(),
        serviceProfileReviewedBy: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    await db.collection("adminAuditLogs").add({
      actorUid: user.uid,
      action: "nursing_service_profile_saved",
      resource: `providerProfiles/${provider.id}`,
      status: serviceProfileStatus,
      createdAt: FieldValue.serverTimestamp(),
    });
    return json(request, {
      ok: true,
      profile,
      serviceProfileStatus,
      message: tariffsConfigured
        ? "Votre profil est transmis à NEXA pour vérification avant sa publication."
        : "Votre profil est enregistré. NEXA doit d’abord configurer les tarifs des zones sélectionnées; il restera invisible jusque-là.",
    });
  } catch (error) { return fail(request, error); }
}
