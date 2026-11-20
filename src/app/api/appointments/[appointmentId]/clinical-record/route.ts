import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { writeClinicalRecordRevision } from "@/lib/clinical-record/versions.server";
import { getConsultationClinicalAccessWindow, hasActiveConsultationClinicalAccess } from "@/lib/clinical-record/access";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

const FINAL_STATUSES = new Set(["FINALIZED", "SIGNED"]);
const EDITABLE_APPOINTMENT_STATUSES = new Set(["IN_PROGRESS", "COMPLETED"]);
const TEXT_FIELDS = [
  "consultationReason", "history", "relevantHistory", "allergies", "currentTreatments",
  "symptoms", "clinicalObservations", "clinicalAssessment", "diagnoses", "carePlan",
  "recommendations", "followUp", "additionalNotes",
] as const;

type ClinicalContent = Record<string, unknown>;
type DoctorContext = { uid: string; name: string; specialty: string };

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "clinical-record-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le dossier de consultation n’est pas accessible pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA clinical record request failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim().slice(0, maxLength);
}

function cleanContent(value: unknown): ClinicalContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiRequestError(400, "invalid-clinical-content", "Le contenu du dossier n’est pas valide.");
  }
  const input = value as Record<string, unknown>;
  const result: ClinicalContent = {};
  for (const field of TEXT_FIELDS) {
    result[field] = cleanText(input[field], 5000);
  }

  const sourceVitals = input.patientVitals && typeof input.patientVitals === "object" && !Array.isArray(input.patientVitals)
    ? input.patientVitals as Record<string, unknown>
    : {};
  const vitals: Record<string, unknown> = {};
  for (const field of ["systolic", "diastolic", "heartRate", "respiratoryRate", "spo2", "glycemia", "temperature", "weight", "height"] as const) {
    const raw = sourceVitals[field];
    if (raw === "" || raw === null || raw === undefined) { vitals[field] = null; continue; }
    const number = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(number) || Math.abs(number) > 1_000_000) {
      throw new ApiRequestError(400, "invalid-patient-vitals", "Vérifiez les signes vitaux saisis.");
    }
    vitals[field] = number;
  }
  if (Object.hasOwn(sourceVitals, "weightUnit")) vitals.weightUnit = cleanText(sourceVitals.weightUnit, 10) || "kg";
  if (Object.hasOwn(sourceVitals, "heightUnit")) vitals.heightUnit = cleanText(sourceVitals.heightUnit, 10) || "cm";
  result.patientVitals = vitals;

  for (const field of ["medications", "laboratoryTests", "imagingExams"] as const) {
    const raw = input[field];
    if (field === "medications") {
      result.medications = Array.isArray(raw) ? raw.slice(0, 50).map((entry) => {
        const item = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
        const quantity = item.quantity === "" || item.quantity == null ? null : Number(item.quantity);
        return {
          name: cleanText(item.name, 180), dosage: cleanText(item.dosage, 120),
          form: cleanText(item.form, 120), route: cleanText(item.route, 120),
          quantity: quantity !== null && Number.isFinite(quantity) ? quantity : null,
          instructions: cleanText(item.instructions, 300), duration: cleanText(item.duration, 120),
        };
      }).filter((item) => item.name) : [];
      continue;
    }
    result[field] = Array.isArray(raw)
      ? raw.slice(0, 50).map((item) => cleanText(item, 250)).filter(Boolean)
      : [];
  }
  return result;
}

function iso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return (value.toDate() as Date).toISOString();
  }
  return typeof value === "string" ? value : null;
}

function isFinal(status: unknown): boolean {
  return FINAL_STATUSES.has(String(status || "").trim().toUpperCase());
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
    return [{
      id,
      originalFileName: cleanText(item.originalFileName, 180) || "Pièce jointe clinique",
      contentType,
      size,
      uploadedAt: cleanText(item.uploadedAt, 80),
    }];
  });
}

async function requireDoctor(request: Request): Promise<DoctorContext> {
  const user = await requireFirebaseUser(request);
  await requireAppCheck(request);
  const provider = await getFirebaseAdminDb().collection("providerProfiles").doc(user.uid).get();
  if (
    !provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" ||
    provider.get("clinicalCredentialsVerified") !== true
  ) throw new ApiRequestError(403, "verified-doctor-required", "Le dossier est réservé au médecin NEXA vérifié associé à la consultation.");
  const profile = provider.get("profile") && typeof provider.get("profile") === "object"
    ? provider.get("profile") as Record<string, unknown>
    : {};
  return {
    uid: user.uid,
    name: cleanText(profile.name || user.name || "Médecin NEXA", 180),
    specialty: cleanText(profile.specialty, 160),
  };
}

async function ensureRecord(appointmentId: string, doctor: DoctorContext) {
  const db = getFirebaseAdminDb();
  const appointmentRef = db.collection("appointments").doc(appointmentId);
  const providerRef = db.collection("providerProfiles").doc(doctor.uid);
  const recordRef = db.collection("electronicPatientRecords").doc(appointmentId);
  const auditRef = db.collection("clinicalAuditLogs").doc();
  await db.runTransaction(async (transaction) => {
    const appointmentSnapshot = await transaction.get(appointmentRef);
    if (!appointmentSnapshot.exists || appointmentSnapshot.get("providerUid") !== doctor.uid || appointmentSnapshot.get("providerType") !== "doctor") {
      throw new ApiRequestError(404, "appointment-not-found", "Cette consultation n’est pas accessible.");
    }
    const appointment = appointmentSnapshot.data() || {};
    const providerSnapshot = await transaction.get(providerRef);
    if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) {
      throw new ApiRequestError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à accéder aux dossiers.");
    }
    if (appointment.paymentStatus !== "PAID") throw new ApiRequestError(409, "appointment-not-paid", "Le paiement confirmé est requis avant d’ouvrir le dossier.");
    if (!EDITABLE_APPOINTMENT_STATUSES.has(String(appointment.status || "").toUpperCase())) {
      throw new ApiRequestError(409, "appointment-not-active", "Le dossier sera ouvert lorsque la séance aura démarré.");
    }
    if (!hasActiveConsultationClinicalAccess(appointment)) {
      throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée. Une nouvelle autorisation est nécessaire.");
    }
    const patientUid = String(appointment.patientUid || "");
    if (!patientUid) throw new ApiRequestError(409, "patient-required", "Cette consultation n’est pas associée à un patient.");
    const patientRef = db.collection("patientProfiles").doc(patientUid);
    const [patientSnapshot, recordSnapshot] = await Promise.all([transaction.get(patientRef), transaction.get(recordRef)]);
    if (!patientSnapshot.exists || patientSnapshot.get("role") !== "patient" || typeof patientSnapshot.get("patientNumber") !== "string") {
      throw new ApiRequestError(409, "patient-profile-incomplete", "Le profil patient associé à la consultation n’est pas complet.");
    }
    if (recordSnapshot.exists) {
      if (recordSnapshot.get("patientUid") !== patientUid || recordSnapshot.get("providerUid") !== doctor.uid || recordSnapshot.get("appointmentId") !== appointmentId) {
        throw new ApiRequestError(409, "record-link-conflict", "Le dossier lié à cette consultation ne peut pas être ouvert.");
      }
      return;
    }

    const year = new Date().getUTCFullYear();
    const initialContent = cleanContent({ consultationReason: appointment.reason || "" });
    await writeClinicalRecordRevision(transaction, recordRef, null, {
      version: 1,
      status: "DRAFT",
      clinicalContent: initialContent,
      attachments: [],
      actorUid: doctor.uid,
      changeType: "INITIAL",
    });
    transaction.create(recordRef, {
      appointmentId,
      patientUid,
      patientNumber: patientSnapshot.get("patientNumber"),
      providerUid: doctor.uid,
      providerName: doctor.name,
      specialtyName: doctor.specialty,
      recordNumber: `DEP-${year}-${appointmentId.toUpperCase()}`,
      status: "DRAFT",
      version: 1,
      clinicalContent: initialContent,
      addendumCount: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdBy: doctor.uid,
      updatedBy: doctor.uid,
    });
    transaction.set(appointmentRef, {
      electronicPatientRecordId: appointmentId,
      electronicPatientRecordCreatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.create(auditRef, {
      actorUid: doctor.uid,
      action: "clinical_record_created",
      appointmentId,
      recordId: appointmentId,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  return recordRef;
}

async function loadRecord(recordId: string) {
  const db = getFirebaseAdminDb();
  const recordRef = db.collection("electronicPatientRecords").doc(recordId);
  const snapshot = await recordRef.get();
  if (!snapshot.exists) throw new ApiRequestError(404, "record-not-found", "Le dossier de consultation est introuvable.");
  const addendaSnapshot = await recordRef.collection("addenda").orderBy("createdAt", "desc").limit(100).get();
  const data = snapshot.data() || {};
  return {
    appointmentId: data.appointmentId,
    recordNumber: data.recordNumber,
    patientNumber: data.patientNumber,
    providerName: data.providerName,
    specialtyName: data.specialtyName,
    status: data.status,
    version: Number(data.version) || 1,
    clinicalContent: data.clinicalContent || {},
    attachments: attachmentSummaries(data.attachments),
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
    finalizedAt: iso(data.finalizedAt),
    signature: data.signature || null,
    documentHash: data.documentHash || null,
    addendumCount: Number(data.addendumCount) || 0,
    addenda: addendaSnapshot.docs.map((doc) => {
      const addendum = doc.data();
      return {
        id: doc.id,
        reason: addendum.reason,
        content: addendum.content,
        signatureName: addendum.signatureName,
        createdAt: iso(addendum.createdAt),
      };
    }),
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
    if (appointment.patientUid === user.uid) {
      await enforceUserRateLimit({ uid: user.uid, action: "clinical-record-read", limit: 30, windowMs: 5 * 60_000 });
      const profile = await db.collection("patientProfiles").doc(user.uid).get();
      if (!profile.exists || profile.get("role") !== "patient") throw new ApiRequestError(403, "patient-profile-required", "Accès patient NEXA requis.");
      const recordRef = db.collection("electronicPatientRecords").doc(appointmentId);
      const recordSnapshot = await recordRef.get();
      if (!recordSnapshot.exists) return json(request, { ok: true, view: "patient", record: null });
      const data = recordSnapshot.data() || {};
      if (
        data.patientUid !== user.uid || data.appointmentId !== appointmentId ||
        data.providerUid !== appointment.providerUid
      ) throw new ApiRequestError(404, "record-not-found", "Le dossier de consultation est introuvable.");
      const finalized = isFinal(data.status);
      const addendaSnapshot = finalized
        ? await recordRef.collection("addenda").orderBy("createdAt", "desc").limit(100).get()
        : null;
      const auditRef = db.collection("clinicalAuditLogs").doc();
      await auditRef.create({
        actorUid: user.uid,
        action: "patient_clinical_record_accessed",
        appointmentId,
        recordId: appointmentId,
        createdAt: FieldValue.serverTimestamp(),
      });
      return json(request, {
        ok: true,
        view: "patient",
        record: {
          recordNumber: data.recordNumber,
          status: data.status,
          providerName: data.providerName,
          specialtyName: data.specialtyName,
          createdAt: iso(data.createdAt),
          finalizedAt: iso(data.finalizedAt),
          ...(finalized ? {
            clinicalContent: cleanContent(data.clinicalContent),
            attachments: attachmentSummaries(data.attachments),
            signature: data.signature && typeof data.signature === "object" ? {
              name: cleanText((data.signature as Record<string, unknown>).name, 180),
              specialty: cleanText((data.signature as Record<string, unknown>).specialty, 160),
              signedAt: cleanText((data.signature as Record<string, unknown>).signedAt, 80),
            } : null,
            addenda: (addendaSnapshot?.docs || [])
              .map((doc) => {
                const addendum = doc.data() as Record<string, unknown>;
                return {
                  id: doc.id,
                  patientUid: addendum.patientUid,
                  providerUid: addendum.providerUid,
                  appointmentId: addendum.appointmentId,
                  reason: addendum.reason,
                  content: addendum.content,
                  signatureName: addendum.signatureName,
                  createdAt: addendum.createdAt,
                };
              })
              .filter((addendum) => addendum.patientUid === user.uid && addendum.providerUid === appointment.providerUid && addendum.appointmentId === appointmentId)
              .map((addendum) => ({
                id: addendum.id,
                reason: cleanText(addendum.reason, 500),
                content: cleanText(addendum.content, 5000),
                signatureName: cleanText(addendum.signatureName, 180),
                createdAt: iso(addendum.createdAt),
              })),
          } : {}),
        },
      });
    }

    const doctor = await requireDoctor(request);
    if (appointment.providerUid !== user.uid) throw new ApiRequestError(403, "forbidden", "Vous ne participez pas à cette consultation.");
    const recordRef = await ensureRecord(appointmentId, doctor);
    if (!recordRef) throw new ApiRequestError(404, "record-not-found", "Le dossier de consultation est introuvable.");
    const accessWindow = getConsultationClinicalAccessWindow(appointment);
    const patientUid = String(appointment.patientUid || "");
    const [patientSnapshot, medicalProfileSnapshot] = await Promise.all([
      db.collection("patientProfiles").doc(patientUid).get(),
      db.collection("patientMedicalProfiles").doc(patientUid).get(),
    ]);
    if (!hasActiveConsultationClinicalAccess(appointment)) throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée. Une nouvelle autorisation est nécessaire.");
    const patientData = patientSnapshot.data() || {};
    const medicalProfile = medicalProfileSnapshot.data() || {};
    const medicalData = {
      languages: Array.isArray(medicalProfile.languages) ? medicalProfile.languages.filter((value): value is string => typeof value === "string") : [],
      allergies: medicalProfile.allergies && typeof medicalProfile.allergies === "object" ? {
        yes: (medicalProfile.allergies as Record<string, unknown>).yes === true,
        details: cleanText((medicalProfile.allergies as Record<string, unknown>).details, 500),
      } : null,
      diabetes: medicalProfile.diabetes && typeof medicalProfile.diabetes === "object" ? {
        diagnosed: (medicalProfile.diabetes as Record<string, unknown>).diagnosed === true,
        sinceMonth: cleanText((medicalProfile.diabetes as Record<string, unknown>).sinceMonth, 7),
      } : null,
      hypertension: medicalProfile.hypertension && typeof medicalProfile.hypertension === "object" ? {
        diagnosed: (medicalProfile.hypertension as Record<string, unknown>).diagnosed === true,
        sinceMonth: cleanText((medicalProfile.hypertension as Record<string, unknown>).sinceMonth, 7),
      } : null,
      tobacco: medicalProfile.tobacco && typeof medicalProfile.tobacco === "object" ? {
        yes: (medicalProfile.tobacco as Record<string, unknown>).yes === true,
        details: cleanText((medicalProfile.tobacco as Record<string, unknown>).details, 500),
      } : null,
      alcohol: medicalProfile.alcohol && typeof medicalProfile.alcohol === "object" ? {
        yes: (medicalProfile.alcohol as Record<string, unknown>).yes === true,
        details: cleanText((medicalProfile.alcohol as Record<string, unknown>).details, 500),
      } : null,
      coffee: medicalProfile.coffee && typeof medicalProfile.coffee === "object" ? {
        yes: (medicalProfile.coffee as Record<string, unknown>).yes === true,
        details: cleanText((medicalProfile.coffee as Record<string, unknown>).details, 500),
      } : null,
      tea: medicalProfile.tea && typeof medicalProfile.tea === "object" ? {
        yes: (medicalProfile.tea as Record<string, unknown>).yes === true,
        details: cleanText((medicalProfile.tea as Record<string, unknown>).details, 500),
      } : null,
      updatedAt: iso(medicalProfile.updatedAt),
    };
    await db.collection("clinicalAuditLogs").doc().create({
      actorUid: doctor.uid,
      action: "doctor_patient_medical_profile_accessed",
      appointmentId,
      createdAt: FieldValue.serverTimestamp(),
    });
    return json(request, {
      ok: true,
      view: "provider",
      clinicalAccessExpiresAt: accessWindow ? new Date(accessWindow.expiresAtMs).toISOString() : null,
      patientIdentity: {
        firstName: cleanText(patientData.firstName, 80),
        lastName: cleanText(patientData.lastName, 80),
        birthDate: cleanText(patientData.birthDate, 10),
        sex: cleanText(patientData.sex, 32),
      },
      patientMedicalProfile: medicalProfileSnapshot.exists ? medicalData : null,
      record: await loadRecord(appointmentId),
    });
  } catch (error) { return failure(request, error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ appointmentId: string }> }) {
  try {
    const doctor = await requireDoctor(request);
    await enforceUserRateLimit({ uid: doctor.uid, action: "clinical-record-write", limit: 30, windowMs: 5 * 60_000 });
    const { appointmentId } = await params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) throw new ApiRequestError(400, "invalid-appointment", "La référence de consultation n’est pas valide.");
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 100_000) throw new ApiRequestError(413, "clinical-record-too-large", "Le dossier transmis est trop volumineux.");
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande n’est pas valide.");
    const input = body as Record<string, unknown>;
    const action = input.action;
    if (!["saveDraft", "finalize", "addendum"].includes(String(action))) throw new ApiRequestError(400, "invalid-record-action", "Choisissez une action valide pour le dossier.");
    const recordRef = await ensureRecord(appointmentId, doctor);
    if (!recordRef) throw new ApiRequestError(404, "record-not-found", "Le dossier de consultation est introuvable.");
    const db = getFirebaseAdminDb();
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const auditRef = db.collection("clinicalAuditLogs").doc();
    const signatureName = doctor.name || "Médecin NEXA";

    if (action === "saveDraft" || action === "finalize") {
      const content = cleanContent(input.clinicalContent);
      if (action === "finalize" && !["consultationReason", "clinicalObservations", "clinicalAssessment", "carePlan"].some((field) => Boolean(content[field]))) {
        throw new ApiRequestError(400, "clinical-content-required", "Ajoutez le motif, les observations, l’évaluation ou la conduite à tenir avant de finaliser le dossier.");
      }
      await db.runTransaction(async (transaction) => {
        const providerRef = db.collection("providerProfiles").doc(doctor.uid);
        const [appointmentSnapshot, recordSnapshot, providerSnapshot] = await Promise.all([transaction.get(appointmentRef), transaction.get(recordRef), transaction.get(providerRef)]);
        if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) {
          throw new ApiRequestError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à accéder aux dossiers.");
        }
        if (!appointmentSnapshot.exists || appointmentSnapshot.get("providerUid") !== doctor.uid || appointmentSnapshot.get("providerType") !== "doctor" || appointmentSnapshot.get("paymentStatus") !== "PAID") {
          throw new ApiRequestError(404, "appointment-not-found", "Cette consultation n’est pas accessible.");
        }
        if (!EDITABLE_APPOINTMENT_STATUSES.has(String(appointmentSnapshot.get("status") || "").toUpperCase())) {
          throw new ApiRequestError(409, "appointment-not-active", "Le dossier ne peut être modifié avant le démarrage de la séance.");
        }
        if (!hasActiveConsultationClinicalAccess(appointmentSnapshot.data() || {})) {
          throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée. Une nouvelle autorisation est nécessaire.");
        }
        if (!recordSnapshot.exists || recordSnapshot.get("providerUid") !== doctor.uid || recordSnapshot.get("patientUid") !== appointmentSnapshot.get("patientUid")) {
          throw new ApiRequestError(404, "record-not-found", "Le dossier de consultation est introuvable.");
        }
        const data = recordSnapshot.data() || {};
        if (isFinal(data.status)) throw new ApiRequestError(409, "record-immutable", "Ce dossier est finalisé. Ajoutez une correction à son historique.");
        const version = (Number(data.version) || 1) + 1;
        const update: Record<string, unknown> = {
          clinicalContent: content,
          status: action === "finalize" ? "FINALIZED" : "DRAFT",
          version,
          updatedBy: doctor.uid,
          updatedAt: FieldValue.serverTimestamp(),
        };
        if (action === "finalize") {
          const signedAt = new Date().toISOString();
          update.signedAt = FieldValue.serverTimestamp();
          update.finalizedAt = FieldValue.serverTimestamp();
          update.signature = { uid: doctor.uid, name: signatureName, specialty: doctor.specialty, signedAt };
          update.documentHash = createHash("sha256").update(JSON.stringify({
            appointmentId,
            providerUid: doctor.uid,
            patientUid: data.patientUid,
            version,
            content,
            attachments: attachmentSummaries(data.attachments)
              .map((attachment) => ({ ...attachment }))
              .sort((left, right) => left.id.localeCompare(right.id)),
            signatureName,
            signedAt,
          })).digest("hex");
        }
        await writeClinicalRecordRevision(transaction, recordRef, {
          version: Number(data.version) || 1,
          status: String(data.status || "DRAFT"),
          clinicalContent: data.clinicalContent || {},
          attachments: Array.isArray(data.attachments) ? data.attachments : [],
          actorUid: typeof data.updatedBy === "string" ? data.updatedBy : doctor.uid,
          createdAt: data.updatedAt,
          changeType: "INITIAL",
          ...(data.signature ? { signature: data.signature } : {}),
          ...(typeof data.documentHash === "string" ? { documentHash: data.documentHash } : {}),
        }, {
          version,
          status: action === "finalize" ? "FINALIZED" : "DRAFT",
          clinicalContent: content,
          attachments: Array.isArray(data.attachments) ? data.attachments : [],
          actorUid: doctor.uid,
          changeType: action === "finalize" ? "FINALIZED" : "DRAFT_SAVED",
          ...(action === "finalize" && update.signature ? { signature: update.signature } : {}),
          ...(action === "finalize" && typeof update.documentHash === "string" ? { documentHash: update.documentHash } : {}),
        });
        transaction.set(recordRef, update, { merge: true });
        transaction.create(auditRef, {
          actorUid: doctor.uid,
          action: action === "finalize" ? "clinical_record_finalized" : "clinical_record_draft_updated",
          appointmentId,
          recordId: appointmentId,
          version,
          createdAt: FieldValue.serverTimestamp(),
        });
      });
    } else {
      const content = cleanText(input.content, 5000);
      const reason = cleanText(input.reason, 500);
      if (!content) throw new ApiRequestError(400, "addendum-content-required", "Le contenu de la correction est requis.");
      const addendumRef = recordRef.collection("addenda").doc();
      await db.runTransaction(async (transaction) => {
        const providerRef = db.collection("providerProfiles").doc(doctor.uid);
        const [appointmentSnapshot, recordSnapshot, providerSnapshot] = await Promise.all([transaction.get(appointmentRef), transaction.get(recordRef), transaction.get(providerRef)]);
        if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) {
          throw new ApiRequestError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à accéder aux dossiers.");
        }
        if (!appointmentSnapshot.exists || appointmentSnapshot.get("providerUid") !== doctor.uid || appointmentSnapshot.get("providerType") !== "doctor" || appointmentSnapshot.get("paymentStatus") !== "PAID") {
          throw new ApiRequestError(404, "appointment-not-found", "Cette consultation n’est pas accessible.");
        }
        if (!hasActiveConsultationClinicalAccess(appointmentSnapshot.data() || {})) {
          throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée. Une nouvelle autorisation est nécessaire.");
        }
        if (!recordSnapshot.exists || recordSnapshot.get("providerUid") !== doctor.uid || recordSnapshot.get("patientUid") !== appointmentSnapshot.get("patientUid") || !isFinal(recordSnapshot.get("status"))) {
          throw new ApiRequestError(409, "record-not-finalized", "Finalisez le dossier avant d’ajouter une correction.");
        }
        transaction.create(addendumRef, {
          appointmentId,
          providerUid: doctor.uid,
          patientUid: recordSnapshot.get("patientUid"),
          reason,
          content,
          signatureName,
          createdAt: FieldValue.serverTimestamp(),
        });
        transaction.set(recordRef, {
          addendumCount: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: doctor.uid,
        }, { merge: true });
        transaction.create(auditRef, {
          actorUid: doctor.uid,
          action: "clinical_record_addendum_created",
          appointmentId,
          recordId: appointmentId,
          createdAt: FieldValue.serverTimestamp(),
        });
      });
    }

    return json(request, { ok: true, record: await loadRecord(appointmentId) });
  } catch (error) { return failure(request, error); }
}
