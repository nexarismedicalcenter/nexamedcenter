import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { hasActiveStandaloneClinicalAccess } from "@/lib/clinical-record/access";

type Context = { params: Promise<{ recordId: string }> };
const CONTENT_FIELDS = ["consultationReason", "history", "relevantHistory", "allergies", "currentTreatments", "symptoms", "clinicalObservations", "clinicalAssessment", "diagnoses", "carePlan", "recommendations", "followUp", "additionalNotes"] as const;
function clean(value: unknown, max: number) { return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : ""; }
function iso(value: unknown) { if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).toISOString(); return typeof value === "string" ? value : null; }
function json(request: Request, body: Record<string, unknown>, status = 200) { const headers = corsHeaders(request); headers.set("Cache-Control", "no-store, max-age=0"); return NextResponse.json(body, { status, headers }); }
function projectContent(value: unknown) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; const result: Record<string, unknown> = {};
  for (const field of CONTENT_FIELDS) result[field] = clean(source[field], 5_000);
  const vitals = source.patientVitals && typeof source.patientVitals === "object" && !Array.isArray(source.patientVitals) ? source.patientVitals as Record<string, unknown> : {};
  result.patientVitals = Object.fromEntries(["systolic", "diastolic", "heartRate", "respiratoryRate", "spo2", "glycemia", "temperature", "weight", "height", "weightUnit", "heightUnit"].map((field) => [field, typeof vitals[field] === "number" ? vitals[field] : clean(vitals[field], 10)]));
  result.medications = Array.isArray(source.medications) ? source.medications.slice(0, 50).filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))).map((item) => ({ name: clean(item.name, 180), dosage: clean(item.dosage, 120), instructions: clean(item.instructions, 300) })) : [];
  for (const field of ["laboratoryTests", "imagingExams"] as const) result[field] = Array.isArray(source[field]) ? source[field].slice(0, 50).map((item) => clean(item, 250)).filter(Boolean) : [];
  return result;
}

export async function OPTIONS(request: Request) { try { return new Response(null, { status: 204, headers: corsHeaders(request) }); } catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); } }

export async function GET(request: Request, context: Context) {
  try {
    const user = await requireFirebaseUser(request); await requireAppCheck(request); await enforceUserRateLimit({ uid: user.uid, action: "standalone-clinical-history-read", limit: 15, windowMs: 5 * 60_000 });
    const { recordId } = await context.params; if (!/^[A-Za-z0-9_-]{10,200}$/.test(recordId)) throw new ApiRequestError(400, "invalid-record-id", "La référence du dossier n’est pas valide.");
    const db = getFirebaseAdminDb();
    const [provider, record] = await Promise.all([db.collection("providerProfiles").doc(user.uid).get(), db.collection("electronicPatientRecords").doc(recordId).get()]);
    if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true || !record.exists || record.get("recordType") !== "STANDALONE" || record.get("providerUid") !== user.uid) throw new ApiRequestError(404, "clinical-record-not-found", "L’historique de ce dossier n’est pas disponible.");
    if (!hasActiveStandaloneClinicalAccess(record.data() || {})) throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation patient a expiré ou a été révoquée.");
    const url = new URL(request.url); const beforeVersion = url.searchParams.has("beforeVersion") ? Number(url.searchParams.get("beforeVersion")) : null;
    if (beforeVersion !== null && (!Number.isSafeInteger(beforeVersion) || beforeVersion < 2)) throw new ApiRequestError(400, "invalid-version-cursor", "Le repère d’historique n’est pas valide.");
    const parsedLimit = Number(url.searchParams.get("limit") || 20); const limit = Number.isSafeInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 50) : 20;
    const revisions = record.ref.collection("versions"); const query = beforeVersion === null ? revisions.orderBy("version", "desc") : revisions.where("version", "<", beforeVersion).orderBy("version", "desc");
    const snapshot = await query.limit(limit).get();
    const versions = snapshot.docs.map((doc) => { const data = doc.data(); return {
      version: Number(data.version) || 0, status: clean(data.status, 30), changeType: clean(data.changeType, 40), createdAt: iso(data.createdAt),
      clinicalContent: projectContent(data.clinicalContent), attachments: Array.isArray(data.attachments) ? data.attachments.slice(0, 10).flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const item = entry as Record<string, unknown>;
        const id = typeof item.id === "string" ? item.id : "";
        if (!/^[A-Za-z0-9_-]{10,80}$/.test(id) || item.antivirusStatus !== "CLEAN" || !/^[a-f0-9]{64}$/.test(String(item.sha256Hash || ""))) return [];
        return [{ id, originalFileName: clean(item.originalFileName, 180), size: Number(item.size) || 0 }];
      }) : [],
      signature: data.signature && typeof data.signature === "object" ? { name: clean((data.signature as Record<string, unknown>).name, 180), specialty: clean((data.signature as Record<string, unknown>).specialty, 160), signedAt: clean((data.signature as Record<string, unknown>).signedAt, 80) } : null,
      documentHash: typeof data.documentHash === "string" && /^[a-f0-9]{64}$/.test(data.documentHash) ? data.documentHash : null,
    }; });
    await db.collection("clinicalAuditLogs").add({ actorUid: user.uid, action: "standalone_clinical_record_versions_accessed", recordId, versionCount: versions.length, createdAt: FieldValue.serverTimestamp() });
    const last = versions.at(-1)?.version || 0; return json(request, { ok: true, versions, nextBeforeVersion: versions.length === limit && last > 1 ? last : null });
  } catch (error) {
    const status = error instanceof ApiRequestError ? error.status : 500; const code = error instanceof ApiRequestError ? error.code : "clinical-record-history-unavailable"; const message = error instanceof ApiRequestError ? error.message : "L’historique du dossier n’est pas accessible pour le moment.";
    if (!(error instanceof ApiRequestError)) console.error("NEXA standalone clinical history failed", error instanceof Error ? error.name : "unknown-error");
    const headers = new Headers({ "Cache-Control": "no-store, max-age=0" }); try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
    return NextResponse.json({ ok: false, code, error: message }, { status, headers });
  }
}
