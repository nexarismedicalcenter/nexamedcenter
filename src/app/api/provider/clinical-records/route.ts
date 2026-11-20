import { createHash } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { writeClinicalRecordRevision } from "@/lib/clinical-record/versions.server";
import { CONSULTATION_CLINICAL_ACCESS_DURATION_MS, hasActiveConsultationClinicalAccess, hasActiveStandaloneClinicalAccess } from "@/lib/clinical-record/access";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "provider-clinical-records-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "La bibliothèque des dossiers n’est pas accessible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA provider clinical record list failed", error instanceof Error ? error.name : "unknown-error");
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

function timestamp(value: unknown): number {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).getTime();
  if (value instanceof Date) return value.getTime();
  return typeof value === "number" ? value : Date.parse(String(value || ""));
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

async function requireVerifiedDoctor(uid: string) {
  const provider = await getFirebaseAdminDb().collection("providerProfiles").doc(uid).get();
  if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
    throw new ApiRequestError(403, "verified-doctor-required", "La bibliothèque des dossiers est réservée aux médecins NEXA vérifiés.");
  }
  const profile = provider.get("profile") && typeof provider.get("profile") === "object" ? provider.get("profile") as Record<string, unknown> : {};
  return {
    name: clean(profile.name, 180) || "Médecin NEXA",
    specialty: clean(profile.specialty, 160),
  };
}

export async function GET(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "provider-clinical-record-library", limit: 20, windowMs: 5 * 60_000 });
    const db = getFirebaseAdminDb();
    await requireVerifiedDoctor(user.uid);
    const patientFilter = clean(new URL(request.url).searchParams.get("patientUid"), 128);
    if (patientFilter && !/^[A-Za-z0-9_-]{1,128}$/.test(patientFilter)) throw new ApiRequestError(400, "invalid-patient-filter", "Le filtre patient n’est pas valide.");
    const snapshot = await db.collection("electronicPatientRecords").where("providerUid", "==", user.uid).limit(200).get();
    const candidates = snapshot.docs.filter((doc) => !patientFilter || doc.get("patientUid") === patientFilter);
    const appointmentCandidates = candidates.filter((doc) => doc.get("recordType") !== "STANDALONE" && typeof doc.get("appointmentId") === "string");
    const appointments = await Promise.all(appointmentCandidates.map((doc) => db.collection("appointments").doc(String(doc.get("appointmentId"))).get()));
    const appointmentByRecordId = new Map(appointmentCandidates.map((doc, index) => [doc.id, appointments[index]]));
    const records = candidates.flatMap((doc) => {
      const data = doc.data();
      if (data.recordType === "STANDALONE") {
        if (!data.patientUid || !data.patientNumber || !data.recordNumber) return [];
        if (!hasActiveStandaloneClinicalAccess(data)) return [];
        return [{
          recordId: doc.id,
          appointmentId: "",
          recordType: "STANDALONE",
          recordNumber: clean(data.recordNumber, 100) || doc.id,
          patientNumber: clean(data.patientNumber, 32),
          patientName: clean(data.patientName, 100) || "Patient NEXA",
          createdAt: iso(data.createdAt),
          status: clean(data.status, 30) || "DRAFT",
          type: "Dossier clinique",
          specialtyName: clean(data.specialtyName, 120),
        }];
      }
      const appointment = appointmentByRecordId.get(doc.id);
      if (!appointment || !appointment.exists || appointment.get("providerUid") !== user.uid || appointment.get("providerType") !== "doctor" || appointment.get("patientUid") !== data.patientUid || data.appointmentId !== appointment.id) return [];
      if (!hasActiveConsultationClinicalAccess(appointment.data() || {})) return [];
      return [{
        recordId: doc.id,
        appointmentId: appointment.id,
        recordType: "APPOINTMENT",
        recordNumber: clean(data.recordNumber, 100) || appointment.id,
        patientNumber: clean(data.patientNumber, 32),
        patientName: clean(data.patientName, 100) || "Patient NEXA",
        createdAt: iso(data.createdAt),
        status: clean(data.status, 30) || "DRAFT",
        type: clean(data.type, 40),
        specialtyName: clean(data.specialtyName, 120),
      }];
    }).sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""));
    await db.collection("clinicalAuditLogs").doc().create({
      actorUid: user.uid,
      action: "provider_clinical_record_library_accessed",
      recordCount: records.length,
      patientFilterApplied: Boolean(patientFilter),
      createdAt: FieldValue.serverTimestamp(),
    });
    return json(request, { ok: true, records });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "provider-clinical-record-create", limit: 8, windowMs: 10 * 60_000 });
    const doctor = await requireVerifiedDoctor(user.uid);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 2_000) throw new ApiRequestError(413, "request-too-large", "La demande est trop volumineuse.");
    let input: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-body");
      input = parsed as Record<string, unknown>;
    } catch { throw new ApiRequestError(400, "invalid-request", "La demande n’est pas valide."); }
    const patientNumber = clean(input.patientNumber, 32).toUpperCase();
    if (!/^NMC-\d{7}$/.test(patientNumber)) throw new ApiRequestError(400, "invalid-patient-number", "Saisissez un numéro de patient NEXA au format NMC-0000001.");
    const accessCode = clean(input.accessCode, 64);
    if (!/^[A-Za-z0-9_-]{32}$/.test(accessCode)) throw new ApiRequestError(400, "patient-authorization-required", "Un code d’autorisation patient valide est requis. Le numéro NMC seul ne donne aucun accès.");

    const db = getFirebaseAdminDb();
    const indexRef = db.collection("patientNumberIndex").doc(patientNumber);
    const counterRef = db.collection("systemCounters").doc("clinicalRecordNumbers");
    const recordRef = db.collection("electronicPatientRecords").doc();
    const auditRef = db.collection("clinicalAuditLogs").doc();
    const codeHash = createHash("sha256").update(accessCode).digest("hex");
    const codeIndexRef = db.collection("clinicalAccessCodeIndex").doc(codeHash);
    let recordNumber = "";
    let patientName = "";
    let recordId = recordRef.id;
    let claimedAccessExpiresAt = 0;
    await db.runTransaction(async (transaction) => {
      const codeIndex = await transaction.get(codeIndexRef);
      if (!codeIndex.exists || codeIndex.get("providerUid") !== user.uid || !["ISSUED", "CLAIMED"].includes(String(codeIndex.get("status") || ""))) {
        throw new ApiRequestError(404, "patient-authorization-not-found", "Cette autorisation patient n’est pas disponible.");
      }
      const grantId = typeof codeIndex.get("grantId") === "string" ? codeIndex.get("grantId") as string : "";
      if (!/^[0-9a-f-]{36}$/i.test(grantId)) throw new ApiRequestError(404, "patient-authorization-not-found", "Cette autorisation patient n’est pas disponible.");
      const grantRef = db.collection("clinicalAccessGrants").doc(grantId);
      const [grant, index, provider] = await Promise.all([
        transaction.get(grantRef), transaction.get(indexRef), transaction.get(db.collection("providerProfiles").doc(user.uid)),
      ]);
      if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
        throw new ApiRequestError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à créer un dossier.");
      }
      if (!index.exists || typeof index.get("uid") !== "string") throw new ApiRequestError(404, "patient-not-found", "Aucun patient NEXA ne correspond à ce numéro.");
      const patientUid = String(index.get("uid"));
      if (!grant.exists || grant.get("patientUid") !== patientUid || grant.get("patientNumber") !== patientNumber || grant.get("providerUid") !== user.uid || grant.get("accessCodeHash") !== codeHash) {
        throw new ApiRequestError(404, "patient-authorization-not-found", "Cette autorisation patient ne correspond pas au numéro indiqué.");
      }
      if (codeIndex.get("status") === "CLAIMED") {
        if (grant.get("status") !== "CLAIMED" || grant.get("claimedBy") !== user.uid || typeof grant.get("claimedRecordId") !== "string") {
          throw new ApiRequestError(409, "patient-authorization-used", "Cette autorisation a déjà été utilisée.");
        }
        const existingRecordRef = db.collection("electronicPatientRecords").doc(String(grant.get("claimedRecordId")));
        const existingRecord = await transaction.get(existingRecordRef);
        if (!existingRecord.exists || existingRecord.get("accessGrantId") !== grantId || !hasActiveStandaloneClinicalAccess(existingRecord.data() || {})) {
          throw new ApiRequestError(403, "clinical-access-expired", "Cette autorisation clinique a expiré ou a été révoquée. Demandez un nouveau code au patient.");
        }
        recordId = existingRecordRef.id;
        recordNumber = String(existingRecord.get("recordNumber") || "");
        patientName = String(existingRecord.get("patientName") || "Patient NEXA");
        claimedAccessExpiresAt = timestamp(existingRecord.get("accessExpiresAt"));
        return;
      }
      if (grant.get("status") !== "ISSUED" || timestamp(grant.get("expiresAt")) <= Date.now()) {
        throw new ApiRequestError(409, "patient-authorization-expired", "Le code patient a expiré. Demandez une nouvelle autorisation.");
      }
      const patientRef = db.collection("patientProfiles").doc(patientUid);
      const [patient, counter] = await Promise.all([transaction.get(patientRef), transaction.get(counterRef)]);
      if (!patient.exists || patient.get("role") !== "patient" || patient.get("profileComplete") !== true || patient.get("patientNumber") !== patientNumber) {
        throw new ApiRequestError(404, "patient-not-found", "Aucun profil patient complet ne correspond à ce numéro.");
      }
      const accessGrantedAtMs = Date.now();
      claimedAccessExpiresAt = accessGrantedAtMs + CONSULTATION_CLINICAL_ACCESS_DURATION_MS;
      const last = counter.exists ? counter.get("lastIssuedNumber") : 0;
      if (typeof last !== "number" || !Number.isSafeInteger(last) || last < 0 || last >= 9_999_999) throw new ApiRequestError(503, "record-number-unavailable", "La numérotation des dossiers est indisponible.");
      const sequence = last + 1;
      recordNumber = `NEXA-${new Date().getUTCFullYear()}-${String(sequence).padStart(7, "0")}`;
      const profile = patient.data() || {};
      patientName = clean(profile.displayName || `${profile.firstName || ""} ${profile.lastName || ""}`.trim(), 100) || "Patient NEXA";
      const initialContent = {};
      await writeClinicalRecordRevision(transaction, recordRef, null, {
        version: 1, status: "DRAFT", clinicalContent: initialContent, attachments: [], actorUid: user.uid, changeType: "INITIAL",
      });
      transaction.set(counterRef, { lastIssuedNumber: sequence, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      transaction.create(recordRef, {
        recordId: recordRef.id,
        recordType: "STANDALONE",
        patientUid,
        patientNumber,
        patientName,
        providerUid: user.uid,
        providerName: doctor.name,
        specialtyName: doctor.specialty,
        recordNumber,
        status: "DRAFT",
        version: 1,
        clinicalContent: initialContent,
        attachments: [],
        addendumCount: 0,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        createdBy: user.uid,
        updatedBy: user.uid,
        accessGrantId: grantId,
        accessGrantedAt: Timestamp.fromMillis(accessGrantedAtMs),
        accessExpiresAt: Timestamp.fromMillis(claimedAccessExpiresAt),
        accessRevoked: false,
      });
      transaction.set(grantRef, {
        status: "CLAIMED",
        claimedBy: user.uid,
        claimedRecordId: recordRef.id,
        claimedAt: FieldValue.serverTimestamp(),
        accessExpiresAt: Timestamp.fromMillis(claimedAccessExpiresAt),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.set(codeIndexRef, { status: "CLAIMED", claimedAt: FieldValue.serverTimestamp(), claimedRecordId: recordRef.id }, { merge: true });
      transaction.create(auditRef, {
        actorUid: user.uid,
        action: "standalone_clinical_record_created",
        recordId: recordRef.id,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    return json(request, {
      ok: true,
      recordId,
      recordNumber,
      patientNumber,
      patientName,
      status: "DRAFT",
      accessExpiresAt: claimedAccessExpiresAt ? new Date(claimedAccessExpiresAt).toISOString() : null,
    }, 201);
  } catch (error) { return fail(request, error); }
}
