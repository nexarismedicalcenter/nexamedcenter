import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

const LANGUAGES = new Set(["creole", "french", "english", "spanish"]);
const PROFILE_COLLECTION = "patientMedicalProfiles";

type YesNoDetail = { yes: boolean; details: string };
type ConditionDetail = { diagnosed: boolean; sinceMonth: string };
export type PatientMedicalProfile = {
  languages: string[];
  allergies: YesNoDetail;
  diabetes: ConditionDetail;
  hypertension: ConditionDetail;
  tobacco: YesNoDetail;
  alcohol: YesNoDetail;
  coffee: YesNoDetail;
  tea: YesNoDetail;
};

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "patient-medical-profile-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "La fiche médicale n’est pas accessible pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA patient medical profile request failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function cleanText(value: unknown, maximum: number, required: boolean): string {
  if (typeof value !== "string") throw new ApiRequestError(400, "invalid-medical-profile", "Vérifiez les informations de santé saisies.");
  const normalized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();
  if (normalized.length > maximum || (required && !normalized)) throw new ApiRequestError(400, "invalid-medical-profile", "Vérifiez les informations de santé saisies.");
  return normalized;
}

function parseYesNoDetail(value: unknown, requiredLabel: string): YesNoDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiRequestError(400, "invalid-medical-profile", `La réponse sur ${requiredLabel} est invalide.`);
  const item = value as Record<string, unknown>;
  if (typeof item.yes !== "boolean") throw new ApiRequestError(400, "invalid-medical-profile", `Indiquez si ${requiredLabel} s’applique.`);
  const details = cleanText(item.details ?? "", 500, item.yes);
  if (!item.yes && details) throw new ApiRequestError(400, "invalid-medical-profile", `Retirez les détails de ${requiredLabel} si la réponse est non.`);
  return { yes: item.yes, details };
}

function parseCondition(value: unknown, label: string): ConditionDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiRequestError(400, "invalid-medical-profile", `La réponse sur ${label} est invalide.`);
  const item = value as Record<string, unknown>;
  if (typeof item.diagnosed !== "boolean") throw new ApiRequestError(400, "invalid-medical-profile", `Indiquez si ${label} a été diagnostiqué.`);
  const sinceMonth = cleanText(item.sinceMonth ?? "", 7, item.diagnosed);
  if (item.diagnosed && !/^\d{4}-(0[1-9]|1[0-2])$/.test(sinceMonth)) throw new ApiRequestError(400, "invalid-medical-profile", `Indiquez le mois et l’année du diagnostic de ${label}.`);
  if (!item.diagnosed && sinceMonth) throw new ApiRequestError(400, "invalid-medical-profile", `Retirez la date de ${label} si la réponse est non.`);
  return { diagnosed: item.diagnosed, sinceMonth };
}

function parseProfile(value: unknown): PatientMedicalProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiRequestError(400, "invalid-medical-profile", "La fiche médicale n’est pas valide.");
  const source = value as Record<string, unknown>;
  const allowed = new Set(["languages", "allergies", "diabetes", "hypertension", "tobacco", "alcohol", "coffee", "tea"]);
  if (Object.keys(source).some((key) => !allowed.has(key))) throw new ApiRequestError(400, "invalid-medical-profile", "La fiche contient des champs inattendus.");
  if (!Array.isArray(source.languages) || source.languages.length < 1 || source.languages.length > LANGUAGES.size || source.languages.some((item) => typeof item !== "string" || !LANGUAGES.has(item)) || new Set(source.languages).size !== source.languages.length) {
    throw new ApiRequestError(400, "invalid-medical-profile", "Choisissez au moins une langue préférée parmi les langues proposées.");
  }
  return {
    languages: [...source.languages] as string[],
    allergies: parseYesNoDetail(source.allergies, "les allergies"),
    diabetes: parseCondition(source.diabetes, "le diabète"),
    hypertension: parseCondition(source.hypertension, "l’hypertension"),
    tobacco: parseYesNoDetail(source.tobacco, "le tabac"),
    alcohol: parseYesNoDetail(source.alcohol, "l’alcool"),
    coffee: parseYesNoDetail(source.coffee, "le café"),
    tea: parseYesNoDetail(source.tea, "le thé"),
  };
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "patient-medical-profile-read", limit: 20, windowMs: 5 * 60_000 });
    const db = getFirebaseAdminDb();
    const [patient, profile] = await Promise.all([
      db.collection("patientProfiles").doc(user.uid).get(),
      db.collection(PROFILE_COLLECTION).doc(user.uid).get(),
    ]);
    if (!patient.exists || patient.get("role") !== "patient") throw new ApiRequestError(403, "patient-profile-required", "Accès patient NEXA requis.");
    return json(request, {
      ok: true,
      profile: profile.exists ? {
        ...profile.data(),
        updatedAt: profile.get("updatedAt")?.toDate?.().toISOString?.() || null,
      } : null,
      identity: {
        firstName: typeof patient.get("firstName") === "string" ? patient.get("firstName") : "",
        lastName: typeof patient.get("lastName") === "string" ? patient.get("lastName") : "",
        birthDate: typeof patient.get("birthDate") === "string" ? patient.get("birthDate") : "",
        sex: typeof patient.get("sex") === "string" ? patient.get("sex") : "",
      },
    });
  } catch (error) { return failure(request, error); }
}

export async function PUT(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "patient-medical-profile-write", limit: 10, windowMs: 5 * 60_000 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-medical-profile", "La fiche médicale n’est pas valide.");
    const input = parseProfile((body as Record<string, unknown>).profile);
    const db = getFirebaseAdminDb();
    const patientRef = db.collection("patientProfiles").doc(user.uid);
    const profileRef = db.collection(PROFILE_COLLECTION).doc(user.uid);
    const auditRef = db.collection("clinicalAuditLogs").doc();
    await db.runTransaction(async (transaction) => {
      const patient = await transaction.get(patientRef);
      if (!patient.exists || patient.get("role") !== "patient") throw new ApiRequestError(403, "patient-profile-required", "Accès patient NEXA requis.");
      const existing = await transaction.get(profileRef);
      transaction.set(profileRef, {
        ...input,
        patientUid: user.uid,
        createdAt: existing.get("createdAt") || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.create(auditRef, {
        actorUid: user.uid,
        action: "patient_medical_profile_updated",
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    return json(request, { ok: true, saved: true }, 200);
  } catch (error) { return failure(request, error); }
}
