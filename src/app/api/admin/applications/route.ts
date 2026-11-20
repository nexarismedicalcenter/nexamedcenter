import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "admin-applications-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les candidatures ne sont pas disponibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA admin applications failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* no CORS for disallowed origins */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function isoDate(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("toDate" in value) || typeof value.toDate !== "function") return null;
  return (value.toDate() as Date).toISOString();
}

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

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    await requireNexaAdministrator(request);
    const snapshot = await getFirebaseAdminDb()
      .collection("professionalApplications")
      .where("status", "==", "pending")
      .limit(100)
      .get();
    const applications = snapshot.docs.map((doc) => {
      const data = doc.data();
      const profile = data.profile && typeof data.profile === "object" ? data.profile as Record<string, unknown> : {};
      return {
        uid: doc.id,
        providerType: typeof data.providerType === "string" ? data.providerType : "",
        name: typeof profile.name === "string" ? profile.name.slice(0, 120) : "",
        specialty: typeof profile.specialty === "string" ? profile.specialty.slice(0, 100) : "",
        nursingQualifications: Array.isArray(profile.nursingQualifications)
          ? profile.nursingQualifications.filter((value): value is string => typeof value === "string" && nursingQualifications.has(value))
          : [],
        indicativeFee: Number.isSafeInteger(profile.indicativeFee) ? profile.indicativeFee : null,
        phone: typeof profile.publicPhone === "string" ? profile.publicPhone.slice(0, 30) : "",
        email: typeof data.email === "string" ? data.email.slice(0, 254) : "",
        department: typeof profile.department === "string" ? profile.department.slice(0, 80) : "",
        commune: typeof profile.commune === "string" ? profile.commune.slice(0, 80) : "",
        publicBio: typeof profile.publicBio === "string" ? profile.publicBio.slice(0, 300) : "",
        submittedAt: isoDate(data.submittedAt),
        status: "pending",
      };
    });
    return json(request, { ok: true, applications });
  } catch (error) {
    return failure(request, error);
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La requête est invalide.");
    const input = body as Record<string, unknown>;
    const uid = typeof input.uid === "string" ? input.uid.trim().slice(0, 128) : "";
    const decision = input.decision;
    const reviewNote = typeof input.reviewNote === "string" ? input.reviewNote.trim().slice(0, 500) : "";
    if (!uid || !["approved", "rejected"].includes(String(decision))) throw new ApiRequestError(400, "invalid-review", "La décision de revue n’est pas valide.");

    const db = getFirebaseAdminDb();
    const applicationRef = db.collection("professionalApplications").doc(uid);
    const providerRef = db.collection("providerProfiles").doc(uid);
    const auditRef = db.collection("adminAuditLogs").doc();
    const status = decision === "approved" ? "verified" : "rejected";
    const result = await db.runTransaction(async (transaction) => {
      const applicationSnapshot = await transaction.get(applicationRef);
      if (!applicationSnapshot.exists) throw new ApiRequestError(404, "application-not-found", "Cette candidature n’existe pas.");
      const application = applicationSnapshot.data() || {};
      const profile = application.profile && typeof application.profile === "object" ? application.profile as Record<string, unknown> : {};
      const type = String(application.providerType || "");
      if (!new Set(["doctor", "nurse", "laboratory", "imaging", "pharmacy"]).has(type)) throw new ApiRequestError(409, "invalid-application-type", "Le type de candidature doit être corrigé avant sa validation.");
      const requiresCredentialReview = type === "doctor" || type === "nurse";
      const submittedNursingQualifications = Array.isArray(profile.nursingQualifications)
        ? profile.nursingQualifications.filter((value): value is string => typeof value === "string")
        : [];
      if (status === "verified" && type === "nurse" && (
        submittedNursingQualifications.length < 1 ||
        submittedNursingQualifications.length > nursingQualifications.size ||
        new Set(submittedNursingQualifications).size !== submittedNursingQualifications.length ||
        submittedNursingQualifications.some((qualification) => !nursingQualifications.has(qualification))
      )) {
        throw new ApiRequestError(409, "nursing-qualification-invalid", "Les qualifications infirmières déclarées doivent être corrigées avant l’approbation.");
      }
      if (status === "verified" && requiresCredentialReview && input.credentialsVerified !== true) {
        throw new ApiRequestError(400, "professional-credentials-review-required", type === "nurse"
          ? "Confirmez la vérification des qualifications infirmières avant d’approuver cette candidature."
          : "Confirmez la vérification des qualifications professionnelles avant d’approuver ce médecin.");
      }
      const requestedFee = input.indicativeFee;
      const approvedFee = Number.isSafeInteger(requestedFee) ? requestedFee : profile.indicativeFee;
      if (status === "verified" && type === "doctor" && (!Number.isSafeInteger(approvedFee) || Number(approvedFee) < 1 || Number(approvedFee) > 10_000_000)) {
        throw new ApiRequestError(400, "consultation-fee-required", "Confirmez un tarif entier en HTG entre 1 et 10 000 000 avant d’approuver ce médecin.");
      }

      if (application.status !== "pending") {
        if (application.status === status) return { status, alreadyReviewed: true };
        throw new ApiRequestError(409, "application-already-reviewed", "Cette candidature a déjà reçu une décision différente.");
      }

      transaction.set(applicationRef, {
        status,
        reviewNote: reviewNote || null,
        reviewedAt: FieldValue.serverTimestamp(),
        reviewedBy: admin.uid,
      }, { merge: true });
      if (status === "verified") {
        transaction.set(providerRef, {
          uid,
          type,
          status: "verified",
          publiclyListed: type !== "nurse",
          ...(type === "doctor" ? { clinicalCredentialsVerified: true } : {}),
          ...(type === "nurse" ? { nursingCredentialsVerified: true, serviceProfileStatus: "INCOMPLETE" } : {}),
          profile: {
            name: typeof profile.name === "string" ? profile.name : "",
            specialty: typeof profile.specialty === "string" ? profile.specialty : "",
            publicBio: typeof profile.publicBio === "string" ? profile.publicBio : "",
            publicPhone: typeof profile.publicPhone === "string" ? profile.publicPhone : "",
            department: typeof profile.department === "string" ? profile.department : "",
            commune: typeof profile.commune === "string" ? profile.commune : "",
            ...(type === "doctor" ? { indicativeFee: Number(approvedFee) } : {}),
            ...(type === "nurse" ? { nursingQualifications: submittedNursingQualifications } : {}),
          },
          verifiedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      transaction.create(auditRef, {
        actorUid: admin.uid,
        action: status === "verified" ? "professional_application_approved" : "professional_application_rejected",
        resource: `professionalApplications/${uid}`,
        createdAt: FieldValue.serverTimestamp(),
      });
      return { status, alreadyReviewed: false };
    });
    return json(request, { ok: true, uid, ...result });
  } catch (error) {
    return failure(request, error);
  }
}
