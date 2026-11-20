import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { hasActiveConsultationClinicalAccess } from "@/lib/clinical-record/access";

type Context = { params: Promise<{ appointmentId: string }> };
const TEXT_FIELDS = ["consultationReason", "history", "relevantHistory", "allergies", "currentTreatments", "symptoms", "clinicalObservations", "clinicalAssessment", "diagnoses", "carePlan", "recommendations", "followUp", "additionalNotes"] as const;

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "clinical-record-history-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "L’historique du dossier n’est pas accessible pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA clinical record history failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function iso(value: unknown) {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).toISOString();
  return typeof value === "string" ? value : null;
}

function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

function projectContent(value: unknown) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const result: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) result[field] = cleanText(source[field], 5000);
  const rawVitals = source.patientVitals && typeof source.patientVitals === "object" && !Array.isArray(source.patientVitals) ? source.patientVitals as Record<string, unknown> : {};
  const vitals: Record<string, unknown> = {};
  for (const field of ["systolic", "diastolic", "heartRate", "respiratoryRate", "spo2", "glycemia", "temperature", "weight", "height"] as const) {
    const value = rawVitals[field];
    vitals[field] = typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  vitals.weightUnit = cleanText(rawVitals.weightUnit, 10) || "kg";
  vitals.heightUnit = cleanText(rawVitals.heightUnit, 10) || "cm";
  result.patientVitals = vitals;
  result.medications = Array.isArray(source.medications) ? source.medications.slice(0, 50).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const name = cleanText(item.name, 180);
    if (!name) return [];
    return [{ name, dosage: cleanText(item.dosage, 120), form: cleanText(item.form, 120), route: cleanText(item.route, 120), quantity: typeof item.quantity === "number" && Number.isFinite(item.quantity) ? item.quantity : null, instructions: cleanText(item.instructions, 300), duration: cleanText(item.duration, 120) }];
  }) : [];
  for (const field of ["laboratoryTests", "imagingExams"] as const) result[field] = Array.isArray(source[field]) ? (source[field] as unknown[]).slice(0, 50).map((item) => cleanText(item, 250)).filter(Boolean) : [];
  return result;
}

function attachmentSummaries(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id : "";
    const contentType = typeof item.contentType === "string" ? item.contentType.toLowerCase() : "";
    const size = Number(item.size);
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(id) || !["application/pdf", "image/jpeg", "image/png"].includes(contentType) || !Number.isSafeInteger(size) || size < 1 || size > 15 * 1024 * 1024 || item.antivirusStatus !== "CLEAN" || !/^[a-f0-9]{64}$/.test(String(item.sha256Hash || ""))) return [];
    return [{ id, originalFileName: cleanText(item.originalFileName, 180) || "Pièce jointe clinique", contentType, size, uploadedAt: cleanText(item.uploadedAt, 80) }];
  });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request, context: Context) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "clinical-record-history-read", limit: 15, windowMs: 5 * 60_000 });
    const { appointmentId } = await context.params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) throw new ApiRequestError(400, "invalid-appointment", "La référence de consultation n’est pas valide.");
    const url = new URL(request.url);
    const beforeVersion = url.searchParams.has("beforeVersion") ? Number(url.searchParams.get("beforeVersion")) : null;
    if (beforeVersion !== null && (!Number.isSafeInteger(beforeVersion) || beforeVersion < 2)) throw new ApiRequestError(400, "invalid-version-cursor", "Le repère d’historique n’est pas valide.");
    const limitValue = Number(url.searchParams.get("limit") || 20);
    const limit = Number.isSafeInteger(limitValue) ? Math.min(Math.max(limitValue, 1), 50) : 20;
    const db = getFirebaseAdminDb();
    const [appointment, record, provider] = await Promise.all([
      db.collection("appointments").doc(appointmentId).get(),
      db.collection("electronicPatientRecords").doc(appointmentId).get(),
      db.collection("providerProfiles").doc(user.uid).get(),
    ]);
    if (!appointment.exists || !record.exists || appointment.get("providerUid") !== user.uid || appointment.get("providerType") !== "doctor" || appointment.get("paymentStatus") !== "PAID" || !provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
      throw new ApiRequestError(404, "clinical-record-not-found", "L’historique de ce dossier n’est pas disponible.");
    }
    if (!hasActiveConsultationClinicalAccess(appointment.data() || {})) {
      throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation d’accès à l’historique clinique est expirée.");
    }
    const recordData = record.data() || {};
    if (recordData.appointmentId !== appointmentId || recordData.providerUid !== user.uid || recordData.patientUid !== appointment.get("patientUid")) throw new ApiRequestError(404, "clinical-record-not-found", "L’historique de ce dossier n’est pas disponible.");
    const revisionCollection = record.ref.collection("versions");
    const query = beforeVersion === null
      ? revisionCollection.orderBy("version", "desc")
      : revisionCollection.where("version", "<", beforeVersion).orderBy("version", "desc");
    const snapshot = await query.limit(limit).get();
    const versions = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        version: Number(data.version) || 0,
        status: cleanText(data.status, 30),
        changeType: cleanText(data.changeType, 40),
        createdAt: iso(data.createdAt),
        clinicalContent: projectContent(data.clinicalContent),
        attachments: attachmentSummaries(data.attachments),
        signature: data.signature && typeof data.signature === "object" ? {
          name: cleanText((data.signature as Record<string, unknown>).name, 180),
          specialty: cleanText((data.signature as Record<string, unknown>).specialty, 160),
          signedAt: cleanText((data.signature as Record<string, unknown>).signedAt, 80),
        } : null,
        documentHash: typeof data.documentHash === "string" && /^[a-f0-9]{64}$/.test(data.documentHash) ? data.documentHash : null,
      };
    });
    await db.collection("clinicalAuditLogs").add({ actorUid: user.uid, action: "clinical_record_versions_accessed", appointmentId, recordId: appointmentId, versionCount: versions.length, createdAt: FieldValue.serverTimestamp() });
    const lastVersion = versions.at(-1)?.version || 0;
    return json(request, { ok: true, versions, nextBeforeVersion: versions.length === limit && lastVersion > 1 ? lastVersion : null });
  } catch (error) { return fail(request, error); }
}
