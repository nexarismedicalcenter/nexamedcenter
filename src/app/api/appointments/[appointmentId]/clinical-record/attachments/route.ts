import { createHash, randomBytes } from "node:crypto";
import { FieldValue, Timestamp, type Transaction } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { writeClinicalRecordRevision } from "@/lib/clinical-record/versions.server";
import { hasActiveConsultationClinicalAccess, hasActiveStandaloneClinicalAccess } from "@/lib/clinical-record/access";
import { getFirebaseAdminDb, getFirebaseAdminStorage } from "@/lib/firebase/admin";
import { RESULT_MAX_FILE_BYTES, RESULT_MIME_TYPES, scanDiagnosticResultFile } from "@/lib/diagnostic-results.server";

const SESSION_MS = 15 * 60_000;
const POLICY_MS = 10 * 60_000;
const CLEANUP_GRACE_MS = 15 * 60_000;
const MAX_ATTACHMENTS = 10;

type Context = { params: Promise<{ appointmentId: string }> };
type Attachment = { id: string; originalFileName: string; contentType: string; size: number; sha256Hash: string; storagePath: string; antivirusStatus: "CLEAN"; scannerVersion: string | null; uploadedAt: string };

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "clinical-attachment-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "La pièce jointe clinique n’est pas disponible pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA clinical attachment failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.replace(/[\\/\\:*?"<>|\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function timestamp(value: unknown): number {
  if (value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function") return Number(value.toMillis());
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).getTime();
  return typeof value === "number" ? value : Date.parse(String(value || ""));
}

async function doctor(request: Request) {
  const user = await requireFirebaseUser(request);
  await requireAppCheck(request);
  const provider = await getFirebaseAdminDb().collection("providerProfiles").doc(user.uid).get();
  if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
    throw new ApiRequestError(403, "verified-doctor-required", "Seul le médecin NEXA vérifié associé à la consultation peut gérer les pièces jointes.");
  }
  return user;
}

function validAppointment(value: string) { return /^[A-Za-z0-9_-]{10,200}$/.test(value); }

function publicAttachment(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : "";
  const contentType = typeof item.contentType === "string" ? item.contentType.toLowerCase() : "";
  const size = Number(item.size);
  const sha256Hash = typeof item.sha256Hash === "string" ? item.sha256Hash : "";
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(id) || !RESULT_MIME_TYPES.has(contentType) || !Number.isSafeInteger(size) || size < 1 || size > RESULT_MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(sha256Hash) || item.antivirusStatus !== "CLEAN") return null;
  return {
    id,
    originalFileName: clean(item.originalFileName, 180) || "Pièce jointe clinique",
    contentType,
    size,
    sha256Hash,
    storagePath: typeof item.storagePath === "string" ? item.storagePath : "",
    antivirusStatus: "CLEAN" as const,
    uploadedAt: typeof item.uploadedAt === "string" ? item.uploadedAt : "",
  };
}

async function readBody(request: Request) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 4_096) throw new ApiRequestError(413, "request-too-large", "La demande est trop volumineuse.");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-body");
    return parsed as Record<string, unknown>;
  } catch { throw new ApiRequestError(400, "invalid-request", "La demande n’est pas valide."); }
}

async function verifyEditableRecord(db: ReturnType<typeof getFirebaseAdminDb>, transaction: Transaction, appointmentId: string, uid: string) {
  const appointmentRef = db.collection("appointments").doc(appointmentId);
  const recordRef = db.collection("electronicPatientRecords").doc(appointmentId);
  const providerRef = db.collection("providerProfiles").doc(uid);
  const [appointment, record, provider] = await Promise.all([transaction.get(appointmentRef), transaction.get(recordRef), transaction.get(providerRef)]);
  if (record.exists && record.get("recordType") === "STANDALONE") {
    if (record.get("providerUid") !== uid || !provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
      throw new ApiRequestError(404, "clinical-record-not-found", "Ce dossier clinique n’est pas accessible.");
    }
    if (!hasActiveStandaloneClinicalAccess(record.data() || {})) {
      throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation patient a expiré ou a été révoquée.");
    }
    if (String(record.get("status") || "").toUpperCase() !== "DRAFT") throw new ApiRequestError(409, "record-immutable", "Le dossier est finalisé. Il n’est plus possible d’y ajouter ou retirer des pièces jointes.");
    return { appointmentRef, recordRef, record };
  }
  if (!appointment.exists || appointment.get("providerUid") !== uid || appointment.get("providerType") !== "doctor" || appointment.get("paymentStatus") !== "PAID" || !["IN_PROGRESS", "COMPLETED"].includes(String(appointment.get("status") || "").toUpperCase())) {
    throw new ApiRequestError(404, "appointment-not-found", "Cette consultation n’est pas accessible.");
  }
  if (!hasActiveConsultationClinicalAccess(appointment.data() || {})) {
    throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée. Une nouvelle autorisation est nécessaire.");
  }
  if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
    throw new ApiRequestError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé à gérer les pièces jointes.");
  }
  if (!record.exists || record.get("providerUid") !== uid || record.get("patientUid") !== appointment.get("patientUid") || record.get("appointmentId") !== appointmentId) {
    throw new ApiRequestError(404, "record-not-found", "Le dossier de consultation n’est pas disponible.");
  }
  if (String(record.get("status") || "").toUpperCase() !== "DRAFT") throw new ApiRequestError(409, "record-immutable", "Le dossier est finalisé. Il n’est plus possible d’y ajouter ou retirer des pièces jointes.");
  return { appointmentRef, recordRef, record };
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request, context: Context) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "clinical-attachment-read", limit: 20, windowMs: 5 * 60_000 });
    const { appointmentId } = await context.params;
    const attachmentId = new URL(request.url).searchParams.get("attachmentId") || "";
    if (!validAppointment(appointmentId) || !/^[A-Za-z0-9_-]{10,80}$/.test(attachmentId)) throw new ApiRequestError(400, "invalid-clinical-attachment", "La référence de la pièce jointe n’est pas valide.");
    const db = getFirebaseAdminDb();
    const [appointmentSnapshot, recordSnapshot] = await Promise.all([
      db.collection("appointments").doc(appointmentId).get(),
      db.collection("electronicPatientRecords").doc(appointmentId).get(),
    ]);
    const appointment = appointmentSnapshot.data() || {};
    const record = recordSnapshot.data() || {};
    if (!recordSnapshot.exists) throw new ApiRequestError(404, "clinical-attachment-not-found", "Cette pièce jointe n’est pas disponible.");
    const standalone = record.recordType === "STANDALONE";
    const isPatient = record.patientUid === user.uid;
    if (standalone) {
      if (record.recordId !== appointmentId || !record.patientUid || !record.providerUid) throw new ApiRequestError(404, "clinical-attachment-not-found", "Cette pièce jointe n’est pas disponible.");
    } else if (!appointmentSnapshot.exists || record.appointmentId !== appointmentId || record.providerUid !== appointment.providerUid || record.patientUid !== appointment.patientUid) {
      throw new ApiRequestError(404, "clinical-attachment-not-found", "Cette pièce jointe n’est pas disponible.");
    }
    if (isPatient) {
      const patient = await db.collection("patientProfiles").doc(user.uid).get();
      if (!patient.exists || patient.get("role") !== "patient" || record.patientUid !== user.uid || !["FINALIZED", "SIGNED"].includes(String(record.status || "").toUpperCase())) {
        throw new ApiRequestError(404, "clinical-attachment-not-found", "Cette pièce jointe n’est pas disponible.");
      }
    } else {
      const provider = await db.collection("providerProfiles").doc(user.uid).get();
      if (record.providerUid !== user.uid || (!standalone && (appointment.providerUid !== user.uid || appointment.providerType !== "doctor" || appointment.paymentStatus !== "PAID")) || !provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
        throw new ApiRequestError(404, "clinical-attachment-not-found", "Cette pièce jointe n’est pas disponible.");
      }
      if (!standalone && !hasActiveConsultationClinicalAccess(appointment)) {
        throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée. Une nouvelle autorisation est nécessaire.");
      }
      if (standalone && !hasActiveStandaloneClinicalAccess(record)) {
        throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation patient a expiré ou a été révoquée.");
      }
    }
    const attachments = Array.isArray(record.attachments) ? record.attachments : [];
    const attachment = attachments.map(publicAttachment).find((item) => item?.id === attachmentId) || null;
    if (!attachment || attachment.storagePath !== `nexa-clinical-records/${appointmentId}/${attachmentId}`) throw new ApiRequestError(404, "clinical-attachment-not-found", "Cette pièce jointe n’est pas disponible.");
    const file = getFirebaseAdminStorage().bucket().file(attachment.storagePath);
    const [metadata] = await file.getMetadata();
    const custom = metadata.metadata && typeof metadata.metadata === "object" ? metadata.metadata as Record<string, string> : {};
    const downloadToken = Object.entries(custom).find(([key]) => key.toLowerCase() === "firebasestoragedownloadtokens")?.[1] || "";
    if (String(metadata.contentType || "").toLowerCase() !== attachment.contentType || Number(metadata.size || 0) !== attachment.size || custom.nexaAntivirusStatus !== "CLEAN" || custom.nexaSha256 !== attachment.sha256Hash || downloadToken.length > 0) {
      throw new ApiRequestError(409, "clinical-attachment-object-invalid", "Le fichier ne correspond plus aux vérifications de sécurité.");
    }
    const fileName = attachment.originalFileName.replace(/[\r\n"\\]/g, "_").slice(0, 120) || "piece-jointe-clinique";
    const [url] = await file.getSignedUrl({ action: "read", expires: Date.now() + 5 * 60_000, responseDisposition: `attachment; filename="${fileName}"` });
    await db.collection("clinicalAuditLogs").add({
      actorUid: user.uid,
      action: "clinical_record_attachment_accessed",
      appointmentId,
      recordId: appointmentId,
      attachmentId,
      createdAt: FieldValue.serverTimestamp(),
    });
    return json(request, { ok: true, url, expiresInSeconds: 300, attachment: { id: attachment.id, originalFileName: attachment.originalFileName, contentType: attachment.contentType, size: attachment.size } });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request, context: Context) {
  let ownsScanLock = false;
  let sessionId = "";
  let quarantinePath = "";
  let finalPath = "";
  let userUid = "";
  let db: ReturnType<typeof getFirebaseAdminDb> | null = null;
  try {
    const user = await doctor(request);
    userUid = user.uid;
    await enforceUserRateLimit({ uid: user.uid, action: "clinical-attachment-write", limit: 15, windowMs: 10 * 60_000 });
    const { appointmentId } = await context.params;
    if (!validAppointment(appointmentId)) throw new ApiRequestError(400, "invalid-appointment", "La référence de consultation n’est pas valide.");
    const body = await readBody(request);
    const action = String(body.action || "");
    db = getFirebaseAdminDb();
    const bucket = getFirebaseAdminStorage().bucket();

    if (action === "start") {
      const originalFileName = clean(body.fileName, 180);
      const contentType = typeof body.contentType === "string" ? body.contentType.toLowerCase() : "";
      const size = Number(body.size);
      if (!originalFileName || !RESULT_MIME_TYPES.has(contentType) || !Number.isSafeInteger(size) || size < 1 || size > RESULT_MAX_FILE_BYTES) {
        throw new ApiRequestError(400, "invalid-clinical-attachment", "Choisissez un PDF, JPEG ou PNG de 15 Mio maximum.");
      }
      const sessionRef = db.collection("clinicalRecordUploadSessions").doc(randomBytes(18).toString("base64url"));
      sessionId = sessionRef.id;
      const expiresAtMs = Date.now() + SESSION_MS;
      quarantinePath = `nexa-clinical-record-quarantine/${appointmentId}/${sessionId}`;
      await db.runTransaction(async (transaction) => {
        const { record } = await verifyEditableRecord(db!, transaction, appointmentId, user.uid);
        const attachments = Array.isArray(record.get("attachments")) ? record.get("attachments") as Record<string, unknown>[] : [];
        if (attachments.length >= MAX_ATTACHMENTS) throw new ApiRequestError(409, "clinical-attachment-limit", `Un dossier peut contenir au maximum ${MAX_ATTACHMENTS} pièces jointes.`);
        const pending = await transaction.get(db!.collection("clinicalRecordUploadSessions").where("appointmentId", "==", appointmentId).where("providerUid", "==", user.uid).where("status", "==", "OPEN").limit(10));
        if (pending.size >= 3) throw new ApiRequestError(409, "clinical-attachment-upload-limit", "Terminez ou annulez les dépôts déjà ouverts avant d’en commencer un autre.");
        transaction.create(sessionRef, {
          appointmentId,
          patientUid: record.get("patientUid"),
          providerUid: user.uid,
          originalFileName,
          contentType,
          expectedSize: size,
          storagePath: quarantinePath,
          status: "OPEN",
          createdAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(expiresAtMs),
          cleanupAfterMs: expiresAtMs + CLEANUP_GRACE_MS,
          cleanupAfterAt: Timestamp.fromMillis(expiresAtMs + CLEANUP_GRACE_MS),
        });
      });
      let policy: { url: string; fields: Record<string, string> };
      try {
        [policy] = await bucket.file(quarantinePath).generateSignedPostPolicyV4({
          expires: Date.now() + POLICY_MS,
          fields: {
            "Content-Type": contentType,
            success_action_status: "201",
            "x-goog-if-generation-match": "0",
            "x-goog-meta-firebasestoragedownloadtokens": "",
          },
          conditions: [
            ["content-length-range", 1, RESULT_MAX_FILE_BYTES],
            ["eq", "$key", quarantinePath],
            ["eq", "$Content-Type", contentType],
            ["eq", "$success_action_status", "201"],
            ["eq", "$x-goog-if-generation-match", "0"],
            ["eq", "$x-goog-meta-firebasestoragedownloadtokens", ""],
          ],
        });
      } catch {
        await sessionRef.set({ status: "FAILED", closedAt: FieldValue.serverTimestamp() }, { merge: true });
        throw new ApiRequestError(503, "secure-upload-unavailable", "Le téléversement sécurisé est indisponible. Le dossier n’a pas été modifié.");
      }
      return json(request, { ok: true, uploadId: sessionId, uploadUrl: policy.url, fields: policy.fields, expiresAt: expiresAtMs });
    }

    if (action !== "finalize") throw new ApiRequestError(400, "invalid-attachment-action", "Action de pièce jointe invalide.");
    sessionId = typeof body.uploadId === "string" ? body.uploadId.trim() : "";
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(sessionId)) throw new ApiRequestError(400, "invalid-upload-session", "La session de dépôt n’est pas valide.");
    const sessionRef = db.collection("clinicalRecordUploadSessions").doc(sessionId);
    const sessionPreview = await sessionRef.get();
    if (!sessionPreview.exists || sessionPreview.get("appointmentId") !== appointmentId || sessionPreview.get("providerUid") !== user.uid || sessionPreview.get("status") !== "OPEN") {
      throw new ApiRequestError(404, "upload-session-not-found", "Cette session de dépôt n’est plus disponible.");
    }
    if (timestamp(sessionPreview.get("expiresAt")) <= Date.now()) throw new ApiRequestError(410, "upload-session-expired", "La session de dépôt a expiré. Sélectionnez de nouveau le fichier.");
    const expectedPath = `nexa-clinical-record-quarantine/${appointmentId}/${sessionId}`;
    if (sessionPreview.get("storagePath") !== expectedPath) throw new ApiRequestError(409, "upload-session-path-invalid", "Le fichier ne correspond pas à cette consultation.");
    quarantinePath = expectedPath;
    const claim = await db.runTransaction(async (transaction) => {
      const { recordRef, record } = await verifyEditableRecord(db!, transaction, appointmentId, user.uid);
      const freshSession = await transaction.get(sessionRef);
      if (!freshSession.exists || freshSession.get("status") !== "OPEN" || freshSession.get("providerUid") !== user.uid || freshSession.get("appointmentId") !== appointmentId || timestamp(freshSession.get("expiresAt")) <= Date.now()) {
        throw new ApiRequestError(409, "upload-session-locked", "La session de dépôt est expirée, annulée ou déjà utilisée.");
      }
      const attachments = Array.isArray(record.get("attachments")) ? record.get("attachments") as unknown[] : [];
      if (attachments.length >= MAX_ATTACHMENTS) throw new ApiRequestError(409, "clinical-attachment-limit", `Un dossier peut contenir au maximum ${MAX_ATTACHMENTS} pièces jointes.`);
      transaction.update(sessionRef, { status: "SCANNING", scanningStartedAt: FieldValue.serverTimestamp() });
      return {
        recordRef,
        originalFileName: String(freshSession.get("originalFileName") || "").slice(0, 180),
        contentType: String(freshSession.get("contentType") || "").toLowerCase(),
        expectedSize: Number(freshSession.get("expectedSize")),
      };
    });
    ownsScanLock = true;

    const object = bucket.file(quarantinePath);
    const [exists] = await object.exists();
    if (!exists) throw new ApiRequestError(400, "clinical-attachment-file-missing", "Le fichier n’a pas été téléversé. Réessayez.");
    const [metadata] = await object.getMetadata();
    const size = Number(metadata.size || 0);
    const contentType = String(metadata.contentType || "").toLowerCase();
    const custom = metadata.metadata && typeof metadata.metadata === "object" ? metadata.metadata as Record<string, unknown> : {};
    const downloadToken = Object.entries(custom).find(([key]) => key.toLowerCase() === "firebasestoragedownloadtokens")?.[1];
    if (contentType !== claim.contentType || size !== claim.expectedSize || size < 1 || size > RESULT_MAX_FILE_BYTES || (typeof downloadToken === "string" && downloadToken.length > 0)) {
      throw new ApiRequestError(400, "clinical-attachment-metadata-invalid", "Le fichier ne correspond pas au format ou à la taille annoncés.");
    }
    const [contents] = await object.download();
    const scan = await scanDiagnosticResultFile({ fileBuffer: contents, contentType });
    const sha256Hash = createHash("sha256").update(contents).digest("hex");
    const attachmentId = randomBytes(18).toString("base64url");
    finalPath = `nexa-clinical-records/${appointmentId}/${attachmentId}`;
    await object.move(finalPath);
    const finalObject = bucket.file(finalPath);
    await finalObject.setMetadata({
      contentType,
      cacheControl: "private, no-store",
      metadata: { nexaAntivirusStatus: "CLEAN", nexaAntivirusScannerVersion: scan.scannerVersion || "unknown", nexaSha256: sha256Hash, firebaseStorageDownloadTokens: "" },
    });
    const uploadedAt = new Date().toISOString();
    const attachment: Attachment = {
      id: attachmentId,
      originalFileName: claim.originalFileName,
      contentType,
      size,
      sha256Hash,
      storagePath: finalPath,
      antivirusStatus: "CLEAN",
      scannerVersion: scan.scannerVersion,
      uploadedAt,
    };
    const auditRef = db.collection("clinicalAuditLogs").doc();
    await db.runTransaction(async (transaction) => {
      const { recordRef } = await verifyEditableRecord(db!, transaction, appointmentId, user.uid);
      const session = await transaction.get(sessionRef);
      const record = await transaction.get(recordRef);
      if (!session.exists || session.get("status") !== "SCANNING" || session.get("providerUid") !== user.uid || session.get("appointmentId") !== appointmentId || !record.exists) {
        throw new ApiRequestError(409, "clinical-attachment-session-conflict", "La session de dépôt n’est plus active.");
      }
      const attachments = Array.isArray(record.get("attachments")) ? record.get("attachments") as Record<string, unknown>[] : [];
      if (attachments.length >= MAX_ATTACHMENTS) throw new ApiRequestError(409, "clinical-attachment-limit", `Un dossier peut contenir au maximum ${MAX_ATTACHMENTS} pièces jointes.`);
      const next = [...attachments, attachment];
      const version = (Number(record.get("version")) || 1) + 1;
      await writeClinicalRecordRevision(transaction, recordRef, {
        version: Number(record.get("version")) || 1,
        status: String(record.get("status") || "DRAFT"),
        clinicalContent: record.get("clinicalContent") || {},
        attachments,
        actorUid: typeof record.get("updatedBy") === "string" ? String(record.get("updatedBy")) : user.uid,
        createdAt: record.get("updatedAt"),
        changeType: "INITIAL",
      }, {
        version,
        status: "DRAFT",
        clinicalContent: record.get("clinicalContent") || {},
        attachments: next,
        actorUid: user.uid,
        changeType: "ATTACHMENT_ADDED",
      });
      transaction.update(recordRef, { attachments: next, version, updatedAt: FieldValue.serverTimestamp(), updatedBy: user.uid });
      transaction.update(sessionRef, { status: "SUBMITTED", attachmentId, closedAt: FieldValue.serverTimestamp() });
      transaction.create(auditRef, {
        actorUid: user.uid,
        action: "clinical_record_attachment_added",
        appointmentId,
        recordId: appointmentId,
        attachmentId,
        contentType,
        size,
        scannerVersion: scan.scannerVersion,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    ownsScanLock = false;
    return json(request, { ok: true, attachment: { id: attachment.id, originalFileName: attachment.originalFileName, contentType, size, sha256Hash, uploadedAt }, recordVersion: (Number((await claim.recordRef.get()).get("version")) || 1) });
  } catch (error) {
    if (ownsScanLock && db) {
      const bucket = getFirebaseAdminStorage().bucket();
      await Promise.allSettled([quarantinePath, finalPath].filter(Boolean).map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
      if (sessionId && userUid) await db.collection("clinicalRecordUploadSessions").doc(sessionId).set({ status: error instanceof ApiRequestError && error.code === "malware-detected" ? "REJECTED" : "FAILED", closedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => undefined);
    }
    return fail(request, error);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const user = await doctor(request);
    await enforceUserRateLimit({ uid: user.uid, action: "clinical-attachment-cancel", limit: 12, windowMs: 10 * 60_000 });
    const { appointmentId } = await context.params;
    if (!validAppointment(appointmentId)) throw new ApiRequestError(400, "invalid-appointment", "La référence de consultation n’est pas valide.");
    const body = await readBody(request);
    const uploadId = typeof body.uploadId === "string" ? body.uploadId.trim() : "";
    const db = getFirebaseAdminDb();
    if (uploadId) {
      if (!/^[A-Za-z0-9_-]{10,80}$/.test(uploadId)) throw new ApiRequestError(400, "invalid-upload-session", "La session de dépôt n’est pas valide.");
      const sessionRef = db.collection("clinicalRecordUploadSessions").doc(uploadId);
      const expectedPath = `nexa-clinical-record-quarantine/${appointmentId}/${uploadId}`;
      await db.runTransaction(async (transaction) => {
        const session = await transaction.get(sessionRef);
        if (!session.exists || session.get("appointmentId") !== appointmentId || session.get("providerUid") !== user.uid || session.get("storagePath") !== expectedPath || session.get("status") !== "OPEN") {
          throw new ApiRequestError(404, "upload-session-not-found", "Cette session de dépôt ne peut pas être annulée.");
        }
        transaction.update(sessionRef, { status: "CANCELLED", closedAt: FieldValue.serverTimestamp() });
      });
      return json(request, { ok: true, uploadId, status: "CANCELLED" });
    }

    const attachmentId = typeof body.attachmentId === "string" ? body.attachmentId.trim() : "";
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(attachmentId)) throw new ApiRequestError(400, "invalid-clinical-attachment", "La référence de la pièce jointe n’est pas valide.");
    const recordRef = db.collection("electronicPatientRecords").doc(appointmentId);
    const deletionRef = db.collection("clinicalRecordAttachmentDeletionQueue").doc(randomBytes(18).toString("base64url"));
    const auditRef = db.collection("clinicalAuditLogs").doc();
    let storagePath = "";
    let recordVersion = 1;
    await db.runTransaction(async (transaction) => {
      const { record } = await verifyEditableRecord(db, transaction, appointmentId, user.uid);
      const current = Array.isArray(record.get("attachments")) ? record.get("attachments") as Record<string, unknown>[] : [];
      const attachment = current.map(publicAttachment).find((item) => item?.id === attachmentId) || null;
      if (!attachment || attachment.storagePath !== `nexa-clinical-records/${appointmentId}/${attachmentId}`) throw new ApiRequestError(404, "clinical-attachment-not-found", "Cette pièce jointe n’est pas disponible.");
      storagePath = attachment.storagePath;
      const next = current.filter((item) => !item || typeof item !== "object" || (item as Record<string, unknown>).id !== attachmentId);
      const version = (Number(record.get("version")) || 1) + 1;
      recordVersion = version;
      await writeClinicalRecordRevision(transaction, recordRef, {
        version: Number(record.get("version")) || 1,
        status: String(record.get("status") || "DRAFT"),
        clinicalContent: record.get("clinicalContent") || {},
        attachments: current,
        actorUid: typeof record.get("updatedBy") === "string" ? String(record.get("updatedBy")) : user.uid,
        createdAt: record.get("updatedAt"),
        changeType: "INITIAL",
      }, {
        version,
        status: "DRAFT",
        clinicalContent: record.get("clinicalContent") || {},
        attachments: next,
        actorUid: user.uid,
        changeType: "ATTACHMENT_REMOVED",
      });
      transaction.update(recordRef, { attachments: next, version, updatedAt: FieldValue.serverTimestamp(), updatedBy: user.uid });
      transaction.create(deletionRef, { appointmentId, attachmentId, storagePath, status: "PENDING", cleanupAfterAt: Timestamp.now(), createdAt: FieldValue.serverTimestamp() });
      transaction.create(auditRef, { actorUid: user.uid, action: "clinical_record_attachment_removed", appointmentId, recordId: appointmentId, attachmentId, createdAt: FieldValue.serverTimestamp() });
    });
    try {
      await getFirebaseAdminStorage().bucket().file(storagePath).delete({ ignoreNotFound: true });
      await deletionRef.set({ status: "DONE", completedAt: FieldValue.serverTimestamp() }, { merge: true });
    } catch (error) {
      console.error("NEXA clinical attachment deletion queued", error instanceof Error ? error.name : "unknown-error");
    }
    return json(request, { ok: true, attachmentId, removed: true, recordVersion });
  } catch (error) { return fail(request, error); }
}
