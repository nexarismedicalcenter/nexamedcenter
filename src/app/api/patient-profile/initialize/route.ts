import { NextResponse } from "next/server";
import { corsHeaders, ApiRequestError, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import {
  ensurePatientProfile,
  PatientNumberCapacityError,
  PatientNumberIntegrityError,
  type PatientRegistration,
} from "@/lib/patients/ensure-patient-profile";

function jsonResponse(
  request: Request,
  body: Record<string, unknown>,
  status = 200,
): NextResponse {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function errorResponse(request: Request, error: unknown): NextResponse {
  let status = 500;
  let code = "profile-initialization-failed";
  let message = "Impossible de finaliser le profil pour le moment.";
  if (error instanceof ApiRequestError) {
    status = error.status;
    code = error.code;
    message = error.message;
  }
  if (error instanceof PatientNumberCapacityError) {
    status = 503;
    code = "patient-number-capacity";
    message = "Le service d’inscription est temporairement indisponible.";
  }
  if (error instanceof PatientNumberIntegrityError) {
    status = 503;
    code = "patient-number-unavailable";
    message = "Le service d’inscription est temporairement indisponible.";
  }
  if (status === 500) {
    console.error(
      "Patient profile initialization failed",
      error instanceof Error ? error.name : "unknown-error",
    );
  }

  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try {
    corsHeaders(request).forEach((value, key) => headers.set(key, value));
  } catch {
    // A disallowed origin receives no CORS permission headers.
  }
  return NextResponse.json(
    {
      ok: false,
      code,
      error: message,
    },
    { status, headers },
  );
}

function readText(
  source: Record<string, unknown>,
  key: string,
  maximum: number,
  required = true,
): string | null {
  const value = source[key];
  if (value === undefined || value === null || value === "") {
    return required ? null : "";
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maximum) return null;
  return normalized;
}

function parseRegistration(value: unknown): PatientRegistration | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  const registrationKeys = [
    "firstName", "lastName", "birthDate", "phone", "sex", "addressLine",
    "country", "department", "commune", "termsAccepted",
  ];
  if (!registrationKeys.some((key) => key in body)) return undefined;

  const firstName = readText(body, "firstName", 80);
  const lastName = readText(body, "lastName", 80);
  const birthDate = readText(body, "birthDate", 10);
  const phone = readText(body, "phone", 24);
  if (body.sex !== undefined && body.sex !== null && typeof body.sex !== "string") {
    throw new ApiRequestError(400, "invalid-sex", "La valeur du champ sexe n’est pas valide.");
  }
  const sexValue = typeof body.sex === "string" ? readText(body, "sex", 32, false) : "";
  if (sexValue === null) {
    throw new ApiRequestError(400, "invalid-sex", "La valeur du champ sexe n’est pas valide.");
  }
  const sex = sexValue || "Non communiqué";
  const addressLine = readText(body, "addressLine", 180);
  const country = readText(body, "country", 80);
  const department = readText(body, "department", 100);
  const commune = readText(body, "commune", 100);

  if (
    !firstName || !lastName || !birthDate || !phone || !addressLine ||
    !country || !department || !commune || body.termsAccepted !== true
  ) {
    throw new ApiRequestError(400, "invalid-registration", "Vérifiez les champs obligatoires et acceptez les conditions.");
  }

  const parsedBirthDate = new Date(`${birthDate}T00:00:00.000Z`);
  if (
    Number.isNaN(parsedBirthDate.getTime()) ||
    parsedBirthDate.toISOString().slice(0, 10) !== birthDate ||
    parsedBirthDate.getTime() > Date.now()
  ) {
    throw new ApiRequestError(400, "invalid-birth-date", "La date de naissance n’est pas valide.");
  }
  if (!/^\+?[0-9\s().-]{7,24}$/.test(phone)) {
    throw new ApiRequestError(400, "invalid-phone", "Le numéro de téléphone n’est pas valide.");
  }
  if (!new Set(["Femme", "Homme", "Autre", "Non communiqué"]).has(sex)) {
    throw new ApiRequestError(400, "invalid-sex", "La valeur du champ sexe n’est pas valide.");
  }

  return {
    firstName,
    lastName,
    birthDate,
    phone,
    sex,
    addressLine,
    country,
    department,
    commune,
    emailMarketingConsent: body.emailMarketingConsent === true,
    termsAccepted: true,
  };
}

export async function OPTIONS(request: Request) {
  try {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  } catch (error) {
    const status = error instanceof ApiRequestError ? error.status : 403;
    return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiRequestError(400, "invalid-request", "La requête est invalide.");
    }

    const registration = parseRegistration(body);
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    if (!user.email) {
      throw new ApiRequestError(400, "email-required", "Une adresse e-mail est requise pour ce compte.");
    }

    const result = await ensurePatientProfile(
      getFirebaseAdminDb(),
      { uid: user.uid, email: user.email },
      registration,
    );
    return jsonResponse(request, { ok: true, ...result });
  } catch (error) {
    return errorResponse(request, error);
  }
}
