import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { writeClinicalRecordRevision } from "@/lib/clinical-record/versions.server";
import { hasActiveStandaloneClinicalAccess } from "@/lib/clinical-record/access";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

type Context = { params: Promise<{ recordId: string }> };
const FINAL_STATUSES = new Set(["FINALIZED", "SIGNED"]);
const TEXT_FIELDS = ["consultationReason", "history", "relevantHistory", "allergies", "currentTreatments", "symptoms", "clinicalObservations", "clinicalAssessment", "diagnoses", "carePlan", "recommendations", "followUp", "additionalNotes"] as const;

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request); headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "standalone-clinical-record-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le dossier clinique n’est pas accessible pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA standalone clinical record failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

function iso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).toISOString();
  return typeof value === "string" ? value : null;
}

function cleanContent(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiRequestError(400, "invalid-clinical-content", "Le contenu du dossier n’est pas valide.");
  const input = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) result[field] = clean(input[field], 5_000);
  const sourceVitals = input.patientVitals && typeof input.patientVitals === "object" && !Array.isArray(input.patientVitals) ? input.patientVitals as Record<string, unknown> : {};
  const vitals: Record<string, unknown> = {};
  for (const field of ["systolic", "diastolic", "heartRate", "respiratoryRate", "spo2", "glycemia", "temperature", "weight", "height"]) {
    const raw = sourceVitals[field];
    if (raw === "" || raw === null || raw === undefined) { vitals[field] = null; continue; }
    const number = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(number) || Math.abs(number) > 1_000_000) throw new ApiRequestError(400, "invalid-patient-vitals", "Vérifiez les signes vitaux saisis.");
    vitals[field] = number;
  }
  vitals.weightUnit = clean(sourceVitals.weightUnit, 10) || "kg";
  vitals.heightUnit = clean(sourceVitals.heightUnit, 10) || "cm";
  result.patientVitals = vitals;
  result.medications = Array.isArray(input.medications) ? input.medications.slice(0, 50).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    const name = clean(item.name, 180);
    if (!name) return [];
    const quantity = item.quantity === "" || item.quantity == null ? null : Number(item.quantity);
    if (quantity !== null && (!Number.isFinite(quantity) || quantity < 0 || quantity > 1_000_000)) throw new ApiRequestError(400, "invalid-medication-quantity", "Vérifiez les quantités de médicaments.");
    return [{ name, dosage: clean(item.dosage, 120), form: clean(item.form, 120), route: clean(item.route, 120), quantity, instructions: clean(item.instructions, 300), duration: clean(item.duration, 120) }];
  }) : [];
  for (const field of ["laboratoryTests", "imagingExams"] as const) result[field] = Array.isArray(input[field]) ? input[field].slice(0, 50).map((item) => clean(item, 250)).filter(Boolean) : [];
  return result;
}

function publicAttachments(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (item.antivirusStatus !== "CLEAN" || !/^[A-Za-z0-9_-]{10,80}$/.test(String(item.id || "")) || !["application/pdf", "image/jpeg", "image/png"].includes(String(item.contentType || "").toLowerCase()) || !/^[a-f0-9]{64}$/.test(String(item.sha256Hash || ""))) return [];
    return [{ id: item.id, originalFileName: clean(item.originalFileName, 180), contentType: String(item.contentType).toLowerCase(), size: Number(item.size) || 0, uploadedAt: clean(item.uploadedAt, 80) }];
  });
}

async function requireDoctor(uid: string) {
  const db = getFirebaseAdminDb();
  const provider = await db.collection("providerProfiles").doc(uid).get();
  if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) throw new ApiRequestError(403, "verified-doctor-required", "La bibliothèque des dossiers est réservée aux médecins NEXA vérifiés.");
  const profile = provider.get("profile") && typeof provider.get("profile") === "object" ? provider.get("profile") as Record<string, unknown> : {};
  return { name: clean(profile.name, 180) || "Médecin NEXA", specialty: clean(profile.specialty, 160) };
}

function validId(value: string) { return /^[A-Za-z0-9_-]{10,200}$/.test(value); }

async function loadRecord(recordId: string, providerUid: string) {
  const db = getFirebaseAdminDb();
  const ref = db.collection("electronicPatientRecords").doc(recordId);
  const snapshot = await ref.get();
  if (!snapshot.exists || snapshot.get("recordType") !== "STANDALONE" || snapshot.get("providerUid") !== providerUid) throw new ApiRequestError(404, "clinical-record-not-found", "Ce dossier clinique n’est pas accessible.");
  const data = snapshot.data() || {};
  if (!hasActiveStandaloneClinicalAccess(data)) throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation patient a expiré ou a été révoquée. Un nouveau code est nécessaire.");
  const addenda = await ref.collection("addenda").orderBy("createdAt", "desc").limit(100).get();
  return {
    recordId,
    appointmentId: "",
    recordType: "STANDALONE",
    recordNumber: clean(data.recordNumber, 100),
    patientNumber: clean(data.patientNumber, 32),
    patientName: clean(data.patientName, 100),
    providerName: clean(data.providerName, 180),
    specialtyName: clean(data.specialtyName, 160),
    status: clean(data.status, 30),
    version: Number(data.version) || 1,
    clinicalContent: data.clinicalContent || {},
    attachments: publicAttachments(data.attachments),
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
    accessExpiresAt: iso(data.accessExpiresAt),
    finalizedAt: iso(data.finalizedAt),
    signature: data.signature || null,
    documentHash: data.documentHash || null,
    addendumCount: Number(data.addendumCount) || 0,
    addenda: addenda.docs.map((doc) => {
      const entry = doc.data();
      return { id: doc.id, reason: clean(entry.reason, 500), content: clean(entry.content, 5_000), signatureName: clean(entry.signatureName, 180), createdAt: iso(entry.createdAt) };
    }),
  };
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request, context: Context) {
  try {
    const user = await requireFirebaseUser(request); await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "standalone-clinical-record-read", limit: 30, windowMs: 5 * 60_000 });
    await requireDoctor(user.uid);
    const { recordId } = await context.params;
    if (!validId(recordId)) throw new ApiRequestError(400, "invalid-record-id", "La référence du dossier n’est pas valide.");
    const record = await loadRecord(recordId, user.uid);
    await getFirebaseAdminDb().collection("clinicalAuditLogs").add({ actorUid: user.uid, action: "standalone_clinical_record_accessed", recordId, createdAt: FieldValue.serverTimestamp() });
    return json(request, { ok: true, view: "provider", record });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request, context: Context) {
  try {
    const user = await requireFirebaseUser(request); await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "standalone-clinical-record-write", limit: 30, windowMs: 5 * 60_000 });
    const doctor = await requireDoctor(user.uid);
    const { recordId } = await context.params;
    if (!validId(recordId)) throw new ApiRequestError(400, "invalid-record-id", "La référence du dossier n’est pas valide.");
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 100_000) throw new ApiRequestError(413, "clinical-record-too-large", "Le dossier transmis est trop volumineux.");
    let input: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(raw); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-body"); input = parsed as Record<string, unknown>; }
    catch { throw new ApiRequestError(400, "invalid-request", "La demande n’est pas valide."); }
    const action = String(input.action || "");
    if (!["saveDraft", "finalize", "addendum"].includes(action)) throw new ApiRequestError(400, "invalid-record-action", "Choisissez une action valide pour le dossier.");
    const db = getFirebaseAdminDb();
    const recordRef = db.collection("electronicPatientRecords").doc(recordId);
    const providerRef = db.collection("providerProfiles").doc(user.uid);
    const auditRef = db.collection("clinicalAuditLogs").doc();

    if (action === "saveDraft" || action === "finalize") {
      const content = cleanContent(input.clinicalContent);
      if (action === "finalize" && !["consultationReason", "clinicalObservations", "clinicalAssessment", "carePlan"].some((field) => Boolean(content[field]))) throw new ApiRequestError(400, "clinical-content-required", "Ajoutez le motif, les observations, l’évaluation ou la conduite à tenir avant de finaliser le dossier.");
      await db.runTransaction(async (transaction) => {
        const [record, provider] = await Promise.all([transaction.get(recordRef), transaction.get(providerRef)]);
        if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) throw new ApiRequestError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à modifier les dossiers.");
        if (!record.exists || record.get("recordType") !== "STANDALONE" || record.get("providerUid") !== user.uid) throw new ApiRequestError(404, "clinical-record-not-found", "Ce dossier clinique n’est pas accessible.");
        const data = record.data() || {};
        if (!hasActiveStandaloneClinicalAccess(data)) throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation patient a expiré ou a été révoquée. Un nouveau code est nécessaire.");
        if (FINAL_STATUSES.has(String(data.status || "").toUpperCase())) throw new ApiRequestError(409, "record-immutable", "Ce dossier est finalisé. Ajoutez une correction à son historique.");
        const version = (Number(data.version) || 1) + 1;
        const signedAt = new Date().toISOString();
        const signature = action === "finalize" ? { uid: user.uid, name: doctor.name, specialty: doctor.specialty, signedAt } : undefined;
        const documentHash = action === "finalize" ? createHash("sha256").update(JSON.stringify({ recordId, providerUid: user.uid, patientUid: data.patientUid, version, content, signature })).digest("hex") : undefined;
        await writeClinicalRecordRevision(transaction, recordRef, {
          version: Number(data.version) || 1, status: String(data.status || "DRAFT"), clinicalContent: data.clinicalContent || {}, attachments: Array.isArray(data.attachments) ? data.attachments : [], actorUid: typeof data.updatedBy === "string" ? data.updatedBy : user.uid, createdAt: data.updatedAt, changeType: "INITIAL", ...(data.signature ? { signature: data.signature } : {}), ...(typeof data.documentHash === "string" ? { documentHash: data.documentHash } : {}),
        }, {
          version, status: action === "finalize" ? "FINALIZED" : "DRAFT", clinicalContent: content, attachments: Array.isArray(data.attachments) ? data.attachments : [], actorUid: user.uid, changeType: action === "finalize" ? "FINALIZED" : "DRAFT_SAVED", ...(signature ? { signature } : {}), ...(documentHash ? { documentHash } : {}),
        });
        transaction.set(recordRef, {
          clinicalContent: content, status: action === "finalize" ? "FINALIZED" : "DRAFT", version, updatedBy: user.uid,
          updatedAt: FieldValue.serverTimestamp(), ...(action === "finalize" ? { signedAt: FieldValue.serverTimestamp(), finalizedAt: FieldValue.serverTimestamp(), signature, documentHash } : {}),
        }, { merge: true });
        transaction.create(auditRef, { actorUid: user.uid, action: action === "finalize" ? "standalone_clinical_record_finalized" : "standalone_clinical_record_draft_updated", recordId, version, createdAt: FieldValue.serverTimestamp() });
      });
    } else {
      const content = clean(input.content, 5_000); const reason = clean(input.reason, 500);
      if (!content) throw new ApiRequestError(400, "addendum-content-required", "Le contenu de la correction est requis.");
      const addendumRef = recordRef.collection("addenda").doc();
      await db.runTransaction(async (transaction) => {
        const [record, provider] = await Promise.all([transaction.get(recordRef), transaction.get(providerRef)]);
        if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) throw new ApiRequestError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à modifier les dossiers.");
        if (!record.exists || record.get("recordType") !== "STANDALONE" || record.get("providerUid") !== user.uid || !FINAL_STATUSES.has(String(record.get("status") || "").toUpperCase())) throw new ApiRequestError(409, "record-not-finalized", "Finalisez votre dossier avant d’ajouter une correction.");
        if (!hasActiveStandaloneClinicalAccess(record.data() || {})) throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation patient a expiré ou a été révoquée. Un nouveau code est nécessaire.");
        transaction.create(addendumRef, { recordId, providerUid: user.uid, patientUid: record.get("patientUid"), reason, content, signatureName: doctor.name, createdAt: FieldValue.serverTimestamp() });
        transaction.set(recordRef, { addendumCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp(), updatedBy: user.uid }, { merge: true });
        transaction.create(auditRef, { actorUid: user.uid, action: "standalone_clinical_record_addendum_created", recordId, createdAt: FieldValue.serverTimestamp() });
      });
    }
    return json(request, { ok: true, record: await loadRecord(recordId, user.uid) });
  } catch (error) { return fail(request, error); }
}
