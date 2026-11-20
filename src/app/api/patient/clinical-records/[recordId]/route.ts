import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

type Context = { params: Promise<{ recordId: string }> };
const FINAL = new Set(["FINALIZED", "SIGNED"]);
const TEXT_FIELDS = ["consultationReason", "history", "relevantHistory", "allergies", "currentTreatments", "symptoms", "clinicalObservations", "clinicalAssessment", "diagnoses", "carePlan", "recommendations", "followUp", "additionalNotes"] as const;

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request); headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "patient-record-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le dossier médical n’est pas accessible pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA standalone patient record failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function clean(value: unknown, max: number) { return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : ""; }
function iso(value: unknown): string | null { if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).toISOString(); return typeof value === "string" ? value : null; }

function projectContent(value: unknown) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const result: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) result[field] = clean(source[field], 5_000);
  const sourceVitals = source.patientVitals && typeof source.patientVitals === "object" && !Array.isArray(source.patientVitals) ? source.patientVitals as Record<string, unknown> : {};
  const vitals: Record<string, number | string | null> = {};
  for (const field of ["systolic", "diastolic", "heartRate", "respiratoryRate", "spo2", "glycemia", "temperature", "weight", "height"]) vitals[field] = typeof sourceVitals[field] === "number" && Number.isFinite(sourceVitals[field]) ? sourceVitals[field] as number : null;
  vitals.weightUnit = clean(sourceVitals.weightUnit, 10) || "kg"; vitals.heightUnit = clean(sourceVitals.heightUnit, 10) || "cm"; result.patientVitals = vitals;
  result.medications = Array.isArray(source.medications) ? source.medications.slice(0, 50).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>; const name = clean(item.name, 180); if (!name) return [];
    return [{ name, dosage: clean(item.dosage, 120), form: clean(item.form, 120), route: clean(item.route, 120), quantity: typeof item.quantity === "number" && Number.isFinite(item.quantity) ? item.quantity : null, instructions: clean(item.instructions, 300), duration: clean(item.duration, 120) }];
  }) : [];
  for (const field of ["laboratoryTests", "imagingExams"] as const) result[field] = Array.isArray(source[field]) ? source[field].slice(0, 50).map((item) => clean(item, 250)).filter(Boolean) : [];
  return result;
}

function attachments(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (item.antivirusStatus !== "CLEAN" || !/^[A-Za-z0-9_-]{10,80}$/.test(String(item.id || "")) || !["application/pdf", "image/jpeg", "image/png"].includes(String(item.contentType || "").toLowerCase()) || !Number.isSafeInteger(Number(item.size)) || Number(item.size) < 1 || Number(item.size) > 15 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(String(item.sha256Hash || ""))) return [];
    return [{ id: item.id, originalFileName: clean(item.originalFileName, 180) || "Pièce jointe clinique", contentType: String(item.contentType).toLowerCase(), size: Number(item.size), uploadedAt: clean(item.uploadedAt, 80) }];
  });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request, context: Context) {
  try {
    const user = await requireFirebaseUser(request); await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "standalone-patient-record-read", limit: 30, windowMs: 5 * 60_000 });
    const profile = await getFirebaseAdminDb().collection("patientProfiles").doc(user.uid).get();
    if (!profile.exists || profile.get("role") !== "patient" || profile.get("profileComplete") !== true) throw new ApiRequestError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
    const { recordId } = await context.params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(recordId)) throw new ApiRequestError(400, "invalid-record-id", "La référence du dossier n’est pas valide.");
    const db = getFirebaseAdminDb(); const ref = db.collection("electronicPatientRecords").doc(recordId); const snapshot = await ref.get();
    if (!snapshot.exists || snapshot.get("recordType") !== "STANDALONE" || snapshot.get("recordId") !== recordId || snapshot.get("patientUid") !== user.uid) throw new ApiRequestError(404, "clinical-record-not-found", "Ce dossier médical n’est pas disponible.");
    const data = snapshot.data() || {}; const finalized = FINAL.has(String(data.status || "").toUpperCase());
    const addenda = finalized ? await ref.collection("addenda").orderBy("createdAt", "desc").limit(100).get() : null;
    await db.collection("clinicalAuditLogs").add({ actorUid: user.uid, action: "patient_standalone_clinical_record_accessed", recordId, createdAt: FieldValue.serverTimestamp() });
    return json(request, { ok: true, view: "patient", record: {
      recordId, recordType: "STANDALONE", recordNumber: clean(data.recordNumber, 100), status: clean(data.status, 30),
      providerName: clean(data.providerName, 180), specialtyName: clean(data.specialtyName, 160), createdAt: iso(data.createdAt), finalizedAt: iso(data.finalizedAt),
      ...(finalized ? {
        clinicalContent: projectContent(data.clinicalContent), attachments: attachments(data.attachments),
        signature: data.signature && typeof data.signature === "object" ? { name: clean((data.signature as Record<string, unknown>).name, 180), specialty: clean((data.signature as Record<string, unknown>).specialty, 160), signedAt: clean((data.signature as Record<string, unknown>).signedAt, 80) } : null,
        addenda: (addenda?.docs || []).flatMap((doc) => {
          const item = doc.data();
          return item.patientUid === user.uid && item.providerUid === data.providerUid && item.recordId === recordId
            ? [{ id: doc.id, reason: clean(item.reason, 500), content: clean(item.content, 5_000), signatureName: clean(item.signatureName, 180), createdAt: iso(item.createdAt) }]
            : [];
        }),
      } : {}),
    } });
  } catch (error) { return fail(request, error); }
}
