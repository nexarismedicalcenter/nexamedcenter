import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { configuredNursingPeriodRules, configuredNursingSettings, NURSING_SETTINGS_PATH, normalizeNursingPeriodRules, normalizeNursingZones, nursingProfileIsPublishable } from "@/lib/nursing/service-profile.server";

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "nursing-settings-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les paramètres de soins infirmiers ne sont pas accessibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA nursing settings failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-nursing-settings-read", limit: 30, windowMs: 60_000 });
    const db = getFirebaseAdminDb();
    const [settingsSnapshot, nursesSnapshot] = await Promise.all([
      db.doc(NURSING_SETTINGS_PATH).get(),
      db.collection("providerProfiles").where("type", "==", "nurse").limit(300).get(),
    ]);
    const zones = configuredNursingSettings(settingsSnapshot.data());
    const periodRules = configuredNursingPeriodRules(settingsSnapshot.data());
    const pendingProfiles = nursesSnapshot.docs
      .filter((doc) => doc.get("status") === "verified" && doc.get("nursingCredentialsVerified") === true && doc.get("serviceProfileStatus") === "PENDING_REVIEW")
      .map((doc) => {
        const profile = doc.get("profile") && typeof doc.get("profile") === "object" ? doc.get("profile") as Record<string, unknown> : {};
        const serviceProfile = doc.get("nursingServiceProfile") && typeof doc.get("nursingServiceProfile") === "object" ? doc.get("nursingServiceProfile") as Record<string, unknown> : {};
        return {
          uid: doc.id,
          name: clean(profile.name, 120),
          photoUrl: clean(profile.photoUrl, 1000),
          qualifications: Array.isArray(profile.nursingQualifications) ? profile.nursingQualifications.filter((value): value is string => typeof value === "string").slice(0, 8) : [],
          serviceProfile,
        };
      });
    return json(request, { ok: true, zones, periodRules, pendingProfiles });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-nursing-settings-write", limit: 20, windowMs: 5 * 60_000 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-nursing-action", "Action d’administration invalide.");
    const input = body as Record<string, unknown>;
    const db = getFirebaseAdminDb();
    if (input.action === "save-settings") {
      const zones = normalizeNursingZones(input.zones);
      const periodRules = normalizeNursingPeriodRules(input.periodRules);
      if (!zones) throw new ApiRequestError(400, "invalid-nursing-zones", "Vérifiez les communes, les identifiants de zone et les tarifs en HTG.");
      if (!periodRules) throw new ApiRequestError(400, "invalid-nursing-period-rules", "Vérifiez les jours, les heures et le jour de fin de chaque période infirmière.");
      await db.doc(NURSING_SETTINGS_PATH).set({ zones, periodRules, updatedBy: admin.uid, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await db.collection("adminAuditLogs").add({
        actorUid: admin.uid,
        action: "nursing_period_rules_zones_and_tariffs_updated",
        zoneCount: zones.length,
        configuredPeriods: Object.keys(periodRules),
        createdAt: FieldValue.serverTimestamp(),
      });
      return json(request, { ok: true, zones, periodRules });
    }

    if (input.action !== "review-profile") throw new ApiRequestError(400, "invalid-nursing-action", "Action d’administration invalide.");
    const uid = typeof input.uid === "string" ? input.uid.trim() : "";
    const decision = input.decision;
    const reason = clean(input.reason, 500);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(uid) || !["approve", "reject"].includes(String(decision))) {
      throw new ApiRequestError(400, "invalid-nursing-review", "Sélectionnez un profil infirmier et une décision valides.");
    }
    if (decision === "approve" && input.scopeVerified !== true) {
      throw new ApiRequestError(400, "nursing-scope-review-required", "Confirmez que les services choisis correspondent aux qualifications vérifiées avant l’approbation.");
    }
    if (decision === "reject" && !reason) throw new ApiRequestError(400, "nursing-review-reason-required", "Ajoutez le motif qui sera transmis au profil infirmier.");

    const settings = await db.doc(NURSING_SETTINGS_PATH).get();
    const zones = configuredNursingSettings(settings.data());
    const providerRef = db.collection("providerProfiles").doc(uid);
    await db.runTransaction(async (transaction) => {
      const provider = await transaction.get(providerRef);
      if (!provider.exists || provider.get("type") !== "nurse" || provider.get("status") !== "verified" || provider.get("nursingCredentialsVerified") !== true || provider.get("serviceProfileStatus") !== "PENDING_REVIEW") {
        throw new ApiRequestError(409, "nursing-profile-not-reviewable", "Ce profil n’est plus en attente de validation.");
      }
      if (decision === "approve" && !nursingProfileIsPublishable(provider.get("nursingServiceProfile"), zones)) {
        throw new ApiRequestError(409, "nursing-profile-incomplete", "Le profil ou un tarif de zone est incomplet. Demandez au professionnel de corriger le profil ou complétez les paramètres NEXA.");
      }
      transaction.set(providerRef, {
        serviceProfileStatus: decision === "approve" ? "APPROVED" : "REJECTED",
        publiclyListed: false,
        serviceProfileReviewReason: decision === "reject" ? reason : FieldValue.delete(),
        serviceProfileReviewedBy: admin.uid,
        serviceProfileReviewedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    await db.collection("adminAuditLogs").add({
      actorUid: admin.uid,
      action: decision === "approve" ? "nursing_service_profile_approved" : "nursing_service_profile_rejected",
      resource: `providerProfiles/${uid}`,
      ...(decision === "reject" ? { reason } : {}),
      createdAt: FieldValue.serverTimestamp(),
    });
    return json(request, { ok: true, uid, serviceProfileStatus: decision === "approve" ? "APPROVED" : "REJECTED" });
  } catch (error) { return fail(request, error); }
}
