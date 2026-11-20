import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { hasActiveConsultationClinicalAccess } from "@/lib/clinical-record/access";
import { createUserNotification } from "@/lib/notifications.server";

const ELIGIBLE_STATUSES = new Set(["IN_PROGRESS", "COMPLETED"]);

type DoctorContext = { uid: string; name: string; specialty: string };
type PrescriptionContent = { medications: Record<string, unknown>[]; labExams: string[]; imagingExams: string[]; notes: string };

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "prescriptions-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les ordonnances de cette consultation ne sont pas accessibles pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA prescription request failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim().slice(0, max) : "";
}

function cleanContent(value: unknown): PrescriptionContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiRequestError(400, "invalid-prescription-content", "Le contenu de l’ordonnance n’est pas valide.");
  const input = value as Record<string, unknown>;
  const medications = Array.isArray(input.medications) ? input.medications.slice(0, 50).map((raw) => {
    const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const quantity = item.quantity === "" || item.quantity == null ? null : Number(item.quantity);
    if (quantity !== null && (!Number.isFinite(quantity) || quantity < 0 || quantity > 1_000_000)) throw new ApiRequestError(400, "invalid-medication-quantity", "Vérifiez les quantités de médicaments.");
    return {
      name: cleanText(item.name, 180),
      dosage: cleanText(item.dosage, 120),
      form: cleanText(item.form, 120),
      route: cleanText(item.route, 120),
      quantity,
      instructions: cleanText(item.instructions, 500),
      duration: cleanText(item.duration, 120),
    };
  }).filter((item) => item.name) : [];
  const exams = (raw: unknown) => Array.isArray(raw) ? raw.slice(0, 50).map((entry) => cleanText(entry, 250)).filter(Boolean) : [];
  return {
    medications,
    labExams: exams(input.labExams),
    imagingExams: exams(input.imagingExams),
    notes: cleanText(input.notes, 1000),
  };
}

function hasContent(content: PrescriptionContent): boolean {
  return Boolean(content.medications.length || content.labExams.length || content.imagingExams.length);
}

function iso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).toISOString();
  return typeof value === "string" ? value : null;
}

async function requireDoctor(request: Request): Promise<DoctorContext> {
  const user = await requireFirebaseUser(request);
  await requireAppCheck(request);
  const provider = await getFirebaseAdminDb().collection("providerProfiles").doc(user.uid).get();
  if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
    throw new ApiRequestError(403, "verified-doctor-required", "Cette action est réservée au médecin NEXA vérifié.");
  }
  const profile = provider.get("profile") && typeof provider.get("profile") === "object" ? provider.get("profile") as Record<string, unknown> : {};
  return { uid: user.uid, name: cleanText(profile.name || user.name || "Médecin NEXA", 180), specialty: cleanText(profile.specialty, 160) };
}

function publicPrescription(id: string, data: Record<string, unknown>) {
  return {
    id,
    appointmentId: data.appointmentId,
    patientUid: data.patientUid,
    providerUid: data.providerUid,
    providerName: data.providerName,
    specialtyName: data.specialtyName,
    medications: Array.isArray(data.medications) ? data.medications : [],
    labExams: Array.isArray(data.labExams) ? data.labExams : [],
    imagingExams: Array.isArray(data.imagingExams) ? data.imagingExams : [],
    notes: typeof data.notes === "string" ? data.notes : "",
    status: data.status,
    version: Number(data.version) || 1,
    versionGroupId: data.versionGroupId || id,
    previousVersionId: data.previousVersionId || null,
    replacedBy: data.replacedBy || null,
    validatedAt: iso(data.validatedAt),
    createdAt: iso(data.createdAt),
    signature: data.signature || null,
  };
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request, { params }: { params: Promise<{ appointmentId: string }> }) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    const { appointmentId } = await params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) throw new ApiRequestError(400, "invalid-appointment", "La référence de consultation n’est pas valide.");
    const db = getFirebaseAdminDb();
    const appointmentSnapshot = await db.collection("appointments").doc(appointmentId).get();
    if (!appointmentSnapshot.exists) throw new ApiRequestError(404, "appointment-not-found", "Consultation introuvable.");
    const appointment = appointmentSnapshot.data() || {};
    const patientView = appointment.patientUid === user.uid;
    if (!patientView && appointment.providerUid !== user.uid) throw new ApiRequestError(403, "forbidden", "Vous ne participez pas à cette consultation.");
    if (patientView) {
      const profile = await db.collection("patientProfiles").doc(user.uid).get();
      if (!profile.exists || profile.get("role") !== "patient") throw new ApiRequestError(403, "patient-profile-required", "Accès patient NEXA requis.");
    } else {
      await requireDoctor(request);
      if (!hasActiveConsultationClinicalAccess(appointment)) {
        throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée.");
      }
    }
    const snapshot = await db.collection("clinicalPrescriptions").where("appointmentId", "==", appointmentId).limit(100).get();
    const prescriptions = snapshot.docs
      .map((doc) => ({ id: doc.id, data: doc.data() }))
      .filter(({ data }) => patientView ? data.patientUid === user.uid && data.status === "VALIDATED" : data.providerUid === user.uid)
      .sort((left, right) => String(right.data.createdAt || "").localeCompare(String(left.data.createdAt || "")))
      .map(({ id, data }) => publicPrescription(id, data));
    return json(request, { ok: true, view: patientView ? "patient" : "provider", prescriptions });
  } catch (error) { return failure(request, error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ appointmentId: string }> }) {
  try {
    const doctor = await requireDoctor(request);
    await enforceUserRateLimit({ uid: doctor.uid, action: "clinical-prescription-write", limit: 30, windowMs: 5 * 60_000 });
    const { appointmentId } = await params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) throw new ApiRequestError(400, "invalid-appointment", "La référence de consultation n’est pas valide.");
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande n’est pas valide.");
    const input = body as Record<string, unknown>;
    const action = input.action;
    if (!["createDraft", "updateDraft", "validate", "correct"].includes(String(action))) throw new ApiRequestError(400, "invalid-prescription-action", "Action d’ordonnance invalide.");
    const content = action === "validate" ? null : cleanContent(input.content);
    if (action === "correct" && (!content || !hasContent(content))) throw new ApiRequestError(400, "prescription-empty", "Ajoutez au moins un médicament ou un examen.");
    const db = getFirebaseAdminDb();
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const providerRef = db.collection("providerProfiles").doc(doctor.uid);
    const auditRef = db.collection("clinicalAuditLogs").doc();
    const timestamp = FieldValue.serverTimestamp();
    let patientUid = "";
    let outputId = "";
    let outputStatus = "";
    let outputVersion = 1;
    let oldPrescriptionId = "";

    if (action === "createDraft") {
      if (!content) throw new ApiRequestError(400, "invalid-prescription-content", "Le contenu de l’ordonnance n’est pas valide.");
      const prescriptionRef = db.collection("clinicalPrescriptions").doc();
      await db.runTransaction(async (transaction) => {
        const [appointmentSnapshot, providerSnapshot] = await Promise.all([transaction.get(appointmentRef), transaction.get(providerRef)]);
        if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) throw new ApiRequestError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé.");
        if (!appointmentSnapshot.exists || appointmentSnapshot.get("providerUid") !== doctor.uid || appointmentSnapshot.get("providerType") !== "doctor" || appointmentSnapshot.get("paymentStatus") !== "PAID" || !ELIGIBLE_STATUSES.has(String(appointmentSnapshot.get("status") || "").toUpperCase())) throw new ApiRequestError(409, "prescription-not-eligible", "Une ordonnance ne peut être créée que pour une consultation payée et démarrée.");
        const appointment = appointmentSnapshot.data() || {};
        if (!hasActiveConsultationClinicalAccess(appointment)) throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée.");
        patientUid = String(appointment.patientUid || "");
        if (!patientUid) throw new ApiRequestError(409, "patient-required", "La consultation n’est pas associée à un patient.");
        outputId = prescriptionRef.id;
        outputStatus = "DRAFT";
        transaction.create(prescriptionRef, {
          appointmentId, patientUid, providerUid: doctor.uid,
          providerName: doctor.name, specialtyName: doctor.specialty,
          ...content,
          status: outputStatus, version: 1, versionGroupId: prescriptionRef.id,
          previousVersionId: null, replacedBy: null,
          signature: null, validatedAt: null,
          createdAt: timestamp, updatedAt: timestamp, createdBy: doctor.uid, updatedBy: doctor.uid,
        });
        transaction.create(auditRef, { actorUid: doctor.uid, action: "clinical_prescription_draft_created", appointmentId, prescriptionId: prescriptionRef.id, createdAt: timestamp });
      });
    } else {
      const prescriptionId = typeof input.prescriptionId === "string" ? input.prescriptionId.trim() : "";
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(prescriptionId)) throw new ApiRequestError(400, "invalid-prescription", "La référence de l’ordonnance n’est pas valide.");
      const oldRef = db.collection("clinicalPrescriptions").doc(prescriptionId);
      const nextRef = action === "correct" ? db.collection("clinicalPrescriptions").doc() : oldRef;
      await db.runTransaction(async (transaction) => {
        const [appointmentSnapshot, providerSnapshot, prescriptionSnapshot] = await Promise.all([transaction.get(appointmentRef), transaction.get(providerRef), transaction.get(oldRef)]);
        if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) throw new ApiRequestError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé.");
        if (!appointmentSnapshot.exists || appointmentSnapshot.get("providerUid") !== doctor.uid || appointmentSnapshot.get("providerType") !== "doctor" || appointmentSnapshot.get("paymentStatus") !== "PAID" || !ELIGIBLE_STATUSES.has(String(appointmentSnapshot.get("status") || "").toUpperCase())) throw new ApiRequestError(409, "prescription-not-eligible", "L’ordonnance ne peut être modifiée pour cette consultation.");
        if (!hasActiveConsultationClinicalAccess(appointmentSnapshot.data() || {})) throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée.");
        if (!prescriptionSnapshot.exists || prescriptionSnapshot.get("appointmentId") !== appointmentId || prescriptionSnapshot.get("providerUid") !== doctor.uid || prescriptionSnapshot.get("patientUid") !== appointmentSnapshot.get("patientUid")) throw new ApiRequestError(404, "prescription-not-found", "Cette ordonnance n’est pas accessible.");
        const old = prescriptionSnapshot.data() || {};
        patientUid = String(old.patientUid || "");
        oldPrescriptionId = prescriptionId;
        if (action === "updateDraft") {
          if (old.status !== "DRAFT" || !content) throw new ApiRequestError(409, "prescription-immutable", "Seul un brouillon peut être modifié.");
          outputId = prescriptionId; outputStatus = "DRAFT"; outputVersion = Number(old.version) || 1;
          transaction.set(oldRef, { ...content, updatedAt: timestamp, updatedBy: doctor.uid }, { merge: true });
          transaction.create(auditRef, { actorUid: doctor.uid, action: "clinical_prescription_draft_updated", appointmentId, prescriptionId, createdAt: timestamp });
          return;
        }
        if (action === "validate") {
          if (old.status !== "DRAFT" || !hasContent(old as PrescriptionContent)) throw new ApiRequestError(409, "prescription-empty", "Ajoutez au moins un médicament ou un examen avant validation.");
          outputId = prescriptionId; outputStatus = "VALIDATED"; outputVersion = Number(old.version) || 1;
          transaction.set(oldRef, {
            status: "VALIDATED", validatedAt: timestamp, updatedAt: timestamp, updatedBy: doctor.uid,
            signature: { uid: doctor.uid, name: doctor.name, specialty: doctor.specialty, signedAt: new Date().toISOString() },
          }, { merge: true });
          transaction.create(auditRef, { actorUid: doctor.uid, action: "clinical_prescription_validated", appointmentId, prescriptionId, version: outputVersion, createdAt: timestamp });
          return;
        }
        if (old.status !== "VALIDATED" || !content || !hasContent(content)) throw new ApiRequestError(409, "prescription-not-correctable", "Seule une ordonnance validée peut être remplacée par une nouvelle version.");
        outputId = nextRef.id; outputStatus = "VALIDATED"; outputVersion = Math.max(1, Number(old.version) || 1) + 1;
        transaction.set(oldRef, { status: "REPLACED", replacedBy: nextRef.id, updatedAt: timestamp }, { merge: true });
        transaction.create(nextRef, {
          ...old, ...content,
          status: "VALIDATED", version: outputVersion, versionGroupId: old.versionGroupId || prescriptionId,
          previousVersionId: prescriptionId, replacedBy: null,
          validatedAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
          signature: { uid: doctor.uid, name: doctor.name, specialty: doctor.specialty, signedAt: new Date().toISOString() },
          createdBy: doctor.uid, updatedBy: doctor.uid,
        });
        transaction.create(auditRef, { actorUid: doctor.uid, action: "clinical_prescription_corrected", appointmentId, prescriptionId: nextRef.id, previousPrescriptionId: prescriptionId, version: outputVersion, createdAt: timestamp });
      });
    }

    if (["validate", "correct"].includes(String(action)) && patientUid) {
      await createUserNotification({
        uid: patientUid,
        eventKey: `prescription:${outputId}:validated`,
        type: action === "correct" ? "prescription_corrected" : "prescription_received",
        title: action === "correct" ? "Ordonnance mise à jour" : "Ordonnance reçue",
        body: action === "correct" ? `Une nouvelle version (${outputVersion}) de votre ordonnance est disponible.` : "Votre médecin vous a transmis une ordonnance.",
        url: "/espace",
        appointmentId,
      });
    }
    return json(request, { ok: true, prescriptionId: outputId, previousPrescriptionId: oldPrescriptionId || null, status: outputStatus, version: outputVersion });
  } catch (error) { return failure(request, error); }
}
