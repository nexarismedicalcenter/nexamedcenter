import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

const providerTypes = new Set(["doctor", "nurse", "laboratory", "imaging", "pharmacy"]);
const nursingQualifications = new Set([
  "general_nursing",
  "intensive_care",
  "geriatrics",
  "pediatrics",
  "palliative_care",
  "community_health",
  "anesthesia",
  "instrumentation",
]);

function text(body: Record<string, unknown>, key: string, max: number): string | null {
  const value = body[key];
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : null;
}

function response(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "application-submit-failed";
  const message = error instanceof ApiRequestError ? error.message : "La candidature ne peut pas être envoyée pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("Professional application failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* no CORS for disallowed origins */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    if (!user.email) throw new ApiRequestError(400, "email-required", "Une adresse e-mail est nécessaire pour déposer une candidature.");

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La requête est invalide.");
    const input = body as Record<string, unknown>;
    const providerType = text(input, "providerType", 20);
    const name = text(input, "name", 120);
    const phone = text(input, "phone", 30);
    const department = text(input, "department", 80);
    const commune = text(input, "commune", 80);
    const specialty = typeof input.specialty === "string" ? input.specialty.trim().slice(0, 100) : "";
    const publicBio = typeof input.publicBio === "string" ? input.publicBio.trim().slice(0, 300) : "";
    const indicativeFee = input.indicativeFee;
    const submittedNursingQualifications = Array.isArray(input.nursingQualifications) ? input.nursingQualifications : [];
    const selectedNursingQualifications = submittedNursingQualifications.filter((value): value is string => typeof value === "string");
    if (!providerType || !providerTypes.has(providerType) || !name || !phone || !department || !commune) {
      throw new ApiRequestError(400, "invalid-application", "Vérifiez le type de service et les renseignements obligatoires.");
    }
    if (providerType === "doctor" && !specialty) throw new ApiRequestError(400, "specialty-required", "La spécialité médicale est obligatoire.");
    if (providerType === "nurse" && (
      selectedNursingQualifications.length < 1 || selectedNursingQualifications.length > nursingQualifications.size ||
      selectedNursingQualifications.length !== submittedNursingQualifications.length ||
      new Set(selectedNursingQualifications).size !== selectedNursingQualifications.length ||
      selectedNursingQualifications.some((qualification) => !nursingQualifications.has(qualification))
    )) {
      throw new ApiRequestError(400, "nursing-qualification-required", "Choisissez au moins une qualification infirmière valide.");
    }
    if (providerType === "doctor" && (!Number.isSafeInteger(indicativeFee) || Number(indicativeFee) < 1 || Number(indicativeFee) > 10_000_000)) {
      throw new ApiRequestError(400, "consultation-fee-required", "Saisissez un tarif de consultation entier en HTG, entre 1 et 10 000 000.");
    }
    if (!/^\+?[0-9\s().-]{7,30}$/.test(phone)) throw new ApiRequestError(400, "invalid-phone", "Le numéro de téléphone n’est pas valide.");
    if (input.termsAccepted !== true) throw new ApiRequestError(400, "terms-required", "Vous devez accepter les conditions et la politique de confidentialité.");

    const db = getFirebaseAdminDb();
    const applicationRef = db.collection("professionalApplications").doc(user.uid);
    const providerRef = db.collection("providerProfiles").doc(user.uid);
    const result = await db.runTransaction(async (transaction) => {
      const [applicationSnapshot, providerSnapshot] = await Promise.all([
        transaction.get(applicationRef),
        transaction.get(providerRef),
      ]);
      if (providerSnapshot.exists && providerSnapshot.get("status") === "verified") {
        throw new ApiRequestError(409, "provider-already-verified", "Ce compte dispose déjà d’un profil professionnel vérifié.");
      }
      const existingStatus = String(applicationSnapshot.get("status") || "").toLowerCase();
      if (existingStatus === "pending") return { applicationId: applicationRef.id, alreadySubmitted: true };

      const profile = {
        name,
        specialty: providerType === "doctor" ? specialty : "",
        publicBio,
        publicPhone: phone,
        department,
        commune,
        ...(providerType === "doctor" ? { indicativeFee: Number(indicativeFee) } : {}),
        ...(providerType === "nurse" ? { nursingQualifications: selectedNursingQualifications } : {}),
      };
      transaction.set(applicationRef, {
        uid: user.uid,
        email: user.email,
        providerType,
        profile,
        status: "pending",
        termsAccepted: true,
        submittedAt: FieldValue.serverTimestamp(),
        reviewedAt: null,
        reviewedBy: null,
        reviewNote: null,
      });
      return { applicationId: applicationRef.id, alreadySubmitted: false };
    });

    return response(request, { ok: true, ...result, status: "pending" });
  } catch (error) {
    return failure(request, error);
  }
}
