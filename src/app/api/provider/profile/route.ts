import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "provider-profile-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le profil professionnel n’est pas accessible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA provider profile failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    const snapshot = await getFirebaseAdminDb().collection("providerProfiles").doc(user.uid).get();
    if (!snapshot.exists || snapshot.get("status") !== "verified") {
      throw new ApiRequestError(403, "verified-provider-required", "Votre profil doit être vérifié et publié pour ouvrir un espace professionnel.");
    }
    const type = snapshot.get("type");
    if (!new Set(["doctor", "nurse", "pharmacy", "laboratory", "imaging"]).has(String(type))) throw new ApiRequestError(403, "provider-type-invalid", "Le type de profil professionnel n’est pas valide.");
    if (type === "doctor" && snapshot.get("clinicalCredentialsVerified") !== true) throw new ApiRequestError(403, "doctor-credentials-required", "Les qualifications du médecin doivent être attestées avant l’accès à cet espace.");
    if (type === "nurse" && snapshot.get("nursingCredentialsVerified") !== true) throw new ApiRequestError(403, "nursing-credentials-required", "Les qualifications infirmières doivent être attestées avant l’accès à cet espace.");
    if (type !== "nurse" && snapshot.get("publiclyListed") !== true) {
      throw new ApiRequestError(403, "verified-provider-required", "Votre profil doit être vérifié et publié pour ouvrir un espace professionnel.");
    }
    const rawProfile = snapshot.get("profile");
    const profile = rawProfile && typeof rawProfile === "object" ? rawProfile as Record<string, unknown> : {};
    return json(request, { ok: true, provider: {
      uid: user.uid,
      type,
      name: typeof profile.name === "string" ? profile.name.slice(0, 120) : "Professionnel NEXA",
      ...(type === "nurse" ? { serviceProfileStatus: String(snapshot.get("serviceProfileStatus") || "INCOMPLETE") } : {}),
    } });
  } catch (error) { return fail(request, error); }
}
