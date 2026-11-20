import { createHash, randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb, getFirebaseAdminStorage } from "@/lib/firebase/admin";
import { scanDiagnosticResultFile } from "@/lib/diagnostic-results.server";

const MAX_DOCUMENTS = 20;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const SESSION_MS = 15 * 60_000;
const POLICY_MS = 10 * 60_000;
const CLEANUP_GRACE_MS = 25 * 60_000;
const CONTRACT_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "diagnostic-partner-contract-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les documents du partenaire ne sont pas accessibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA diagnostic partner contract failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function clean(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().replace(/[\\/\r\n\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").slice(0, maxLength) : "";
}

function cleanContentType(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase().slice(0, 60) : "";
}

function validUid(value: string) { return /^[A-Za-z0-9_-]{10,128}$/.test(value); }

function timestampMillis(value: unknown) {
  if (!value || typeof value !== "object" || !("toMillis" in value) || typeof value.toMillis !== "function") return null;
  const result = Number(value.toMillis());
  return Number.isFinite(result) ? result : null;
}

function safeDocument(data: Record<string, unknown>, id: string) {
  return {
    id,
    name: clean(data.name, 180) || "Justificatif",
    contentType: clean(data.contentType, 60),
    size: Number(data.size) || 0,
    uploadedByUid: clean(data.uploadedByUid, 128),
    uploadedAt: data.uploadedAt && typeof data.uploadedAt === "object" && "toDate" in data.uploadedAt && typeof data.uploadedAt.toDate === "function"
      ? (data.uploadedAt.toDate() as Date).toISOString()
      : null,
    antivirusStatus: data.antivirusStatus === "CLEAN" ? "CLEAN" : "UNVERIFIED",
  };
}

function validStoredDocument(data: Record<string, unknown>, providerUid: string, documentId: string) {
  return data.antivirusStatus === "CLEAN" &&
    data.storagePath === `nexa-diagnostic-partner-contracts/${providerUid}/${documentId}` &&
    CONTRACT_TYPES.has(String(data.contentType || "")) &&
    Number.isSafeInteger(data.size) && Number(data.size) >= 1 && Number(data.size) <= MAX_FILE_BYTES;
}

async function readBody(request: Request) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 4_096) throw new ApiRequestError(413, "request-too-large", "La demande dépasse la taille autorisée.");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-body");
    return parsed as Record<string, unknown>;
  } catch { throw new ApiRequestError(400, "invalid-request", "La demande n’est pas valide."); }
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-diagnostic-partner-contract-read", limit: 60, windowMs: 60_000 });
    const params = new URL(request.url).searchParams;
    const providerUid = params.get("providerUid")?.trim() || "";
    const documentId = params.get("documentId")?.trim() || "";
    if (!validUid(providerUid)) throw new ApiRequestError(400, "invalid-diagnostic-partner", "Le partenaire diagnostic n’est pas valide.");
    if (documentId && !/^[A-Za-z0-9_-]{10,80}$/.test(documentId)) throw new ApiRequestError(400, "invalid-contract-document", "Le document n’est pas valide.");

    const db = getFirebaseAdminDb();
    const providerRef = db.collection("providerProfiles").doc(providerUid);
    const provider = await providerRef.get();
    if (!provider.exists || !["laboratory", "imaging"].includes(String(provider.get("type") || ""))) throw new ApiRequestError(404, "diagnostic-partner-not-found", "Ce partenaire diagnostic n’existe pas.");
    const documentsRef = providerRef.collection("contractDocuments");
    if (documentId) {
      const snapshot = await documentsRef.doc(documentId).get();
      const data = snapshot.data() || {};
      const expectedPath = `nexa-diagnostic-partner-contracts/${providerUid}/${documentId}`;
      if (!snapshot.exists || !validStoredDocument(data, providerUid, documentId)) {
        throw new ApiRequestError(404, "contract-document-not-found", "Le justificatif privé n’est pas disponible.");
      }
      const [fileExists] = await getFirebaseAdminStorage().bucket().file(expectedPath).exists();
      if (!fileExists) throw new ApiRequestError(404, "contract-document-not-found", "Le justificatif privé n’est pas disponible.");
      const fileName = clean(data.name, 180).replace(/["\\\r\n]/g, "_") || "justificatif";
      const [downloadUrl] = await getFirebaseAdminStorage().bucket().file(expectedPath).getSignedUrl({
        action: "read",
        expires: Date.now() + 5 * 60_000,
        responseDisposition: `attachment; filename="${fileName}"`,
      });
      await db.collection("adminAuditLogs").add({ actorUid: admin.uid, action: "diagnostic_partner_contract_download_link_created", resource: `providerProfiles/${providerUid}/contractDocuments/${documentId}`, createdAt: FieldValue.serverTimestamp() });
      return json(request, { ok: true, downloadUrl, expiresInSeconds: 300 });
    }

    const snapshot = await documentsRef.orderBy("uploadedAt", "desc").limit(MAX_DOCUMENTS).get();
    const documents = snapshot.docs.flatMap((doc) => validStoredDocument(doc.data(), providerUid, doc.id) ? [safeDocument(doc.data(), doc.id)] : []);
    await db.collection("adminAuditLogs").add({ actorUid: admin.uid, action: "diagnostic_partner_contract_documents_listed", resource: `providerProfiles/${providerUid}/contractDocuments`, count: documents.length, createdAt: FieldValue.serverTimestamp() });
    return json(request, { ok: true, providerUid, documents, remainingSlots: Math.max(0, MAX_DOCUMENTS - snapshot.size) });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  let sessionId = "";
  let quarantinePath = "";
  let finalPath = "";
  let db: ReturnType<typeof getFirebaseAdminDb> | null = null;
  let ownsScanLock = false;
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-diagnostic-partner-contract-write", limit: 12, windowMs: 10 * 60_000 });
    const body = await readBody(request);
    const action = clean(body.action, 20).toLowerCase();
    db = getFirebaseAdminDb();

    if (action === "start") {
      const providerUid = clean(body.providerUid, 128);
      const name = clean(body.fileName, 180);
      const contentType = cleanContentType(body.contentType);
      const size = Number(body.size);
      if (!validUid(providerUid) || !name || !CONTRACT_TYPES.has(contentType) || !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) {
        throw new ApiRequestError(400, "invalid-contract-upload", "Choisissez un PDF, JPG ou PNG de 10 Mio maximum.");
      }
      const providerRef = db.collection("providerProfiles").doc(providerUid);
      const provider = await providerRef.get();
      if (!provider.exists || !["laboratory", "imaging"].includes(String(provider.get("type") || ""))) throw new ApiRequestError(404, "diagnostic-partner-not-found", "Ce partenaire laboratoire ou imagerie n’existe pas.");
      const currentDocs = await providerRef.collection("contractDocuments").limit(MAX_DOCUMENTS + 1).get();
      const currentCount = currentDocs.size;
      if (currentCount >= MAX_DOCUMENTS) throw new ApiRequestError(409, "contract-document-limit", `Un partenaire peut avoir au maximum ${MAX_DOCUMENTS} justificatifs.`);

      const sessionRef = db.collection("diagnosticPartnerContractUploadSessions").doc(randomBytes(18).toString("base64url"));
      sessionId = sessionRef.id;
      const expiresAt = Date.now() + SESSION_MS;
      quarantinePath = `nexa-diagnostic-partner-contract-quarantine/${providerUid}/${sessionId}`;
      await sessionRef.create({
        providerUid,
        createdByUid: admin.uid,
        fileName: name,
        contentType,
        expectedSize: size,
        storagePath: quarantinePath,
        status: "OPEN",
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(expiresAt),
        cleanupAfterAt: Timestamp.fromMillis(expiresAt + CLEANUP_GRACE_MS),
      });

      let policy: { url: string; fields: Record<string, string> };
      try {
        [policy] = await getFirebaseAdminStorage().bucket().file(quarantinePath).generateSignedPostPolicyV4({
          expires: Date.now() + POLICY_MS,
          fields: {
            "Content-Type": contentType,
            success_action_status: "201",
            "x-goog-if-generation-match": "0",
            "x-goog-meta-firebasestoragedownloadtokens": "",
            "x-goog-meta-nexa-admin-uid": admin.uid,
            "x-goog-meta-nexa-provider-uid": providerUid,
            "x-goog-meta-nexa-upload-session-id": sessionId,
          },
          conditions: [
            ["content-length-range", 1, size],
            ["eq", "$key", quarantinePath],
            ["eq", "$Content-Type", contentType],
            ["eq", "$success_action_status", "201"],
            ["eq", "$x-goog-if-generation-match", "0"],
            ["eq", "$x-goog-meta-firebasestoragedownloadtokens", ""],
            ["eq", "$x-goog-meta-nexa-admin-uid", admin.uid],
            ["eq", "$x-goog-meta-nexa-provider-uid", providerUid],
            ["eq", "$x-goog-meta-nexa-upload-session-id", sessionId],
          ],
        });
      } catch {
        await sessionRef.set({ status: "FAILED", closedAt: FieldValue.serverTimestamp(), cleanupAfterAt: Timestamp.fromMillis(expiresAt + CLEANUP_GRACE_MS) }, { merge: true });
        throw new ApiRequestError(503, "secure-upload-unavailable", "Le téléversement sécurisé n’est pas disponible actuellement.");
      }
      return json(request, { ok: true, uploadId: sessionId, uploadUrl: policy.url, fields: policy.fields, expiresAt }, 201);
    }

    if (action !== "finalize") throw new ApiRequestError(400, "invalid-contract-action", "L’action de téléversement n’est pas valide.");
    sessionId = clean(body.uploadId, 80);
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(sessionId)) throw new ApiRequestError(400, "invalid-contract-upload-session", "La session de justificatif n’est pas valide.");
    const sessionRef = db.collection("diagnosticPartnerContractUploadSessions").doc(sessionId);
    const preview = await sessionRef.get();
    if (preview.exists && preview.get("createdByUid") === admin.uid && preview.get("status") === "SUBMITTED") {
      const providerUid = clean(preview.get("providerUid"), 128);
      const documentId = clean(preview.get("documentId"), 80);
      if (validUid(providerUid) && /^[A-Za-z0-9_-]{10,80}$/.test(documentId)) {
        const document = await db.collection("providerProfiles").doc(providerUid).collection("contractDocuments").doc(documentId).get();
        if (document.exists) return json(request, { ok: true, document: safeDocument(document.data() || {}, document.id) });
      }
    }
    const previewExpiry = preview.exists ? timestampMillis(preview.get("expiresAt")) : null;
    if (!preview.exists || preview.get("createdByUid") !== admin.uid || preview.get("status") !== "OPEN" || previewExpiry === null || previewExpiry <= Date.now()) {
      throw new ApiRequestError(404, "contract-upload-session-not-found", "Cette session de téléversement n’est plus disponible.");
    }
    const providerUid = clean(preview.get("providerUid"), 128);
    const expectedPath = `nexa-diagnostic-partner-contract-quarantine/${providerUid}/${sessionId}`;
    if (!validUid(providerUid) || preview.get("storagePath") !== expectedPath) throw new ApiRequestError(409, "contract-upload-path-invalid", "Le fichier ne correspond pas à ce partenaire.");
    quarantinePath = expectedPath;

    const claim = await db.runTransaction(async (transaction) => {
      const session = await transaction.get(sessionRef);
      const expiresAt = session.exists ? timestampMillis(session.get("expiresAt")) : null;
      if (!session.exists || session.get("createdByUid") !== admin.uid || session.get("providerUid") !== providerUid || session.get("status") !== "OPEN" || expiresAt === null || expiresAt <= Date.now()) {
        throw new ApiRequestError(409, "contract-upload-session-locked", "La session a expiré ou a déjà été utilisée.");
      }
      transaction.update(sessionRef, { status: "SCANNING", scanningStartedAt: FieldValue.serverTimestamp() });
      return {
        fileName: clean(session.get("fileName"), 180) || "Justificatif",
        contentType: cleanContentType(session.get("contentType")),
        expectedSize: Number(session.get("expectedSize")),
      };
    });
    ownsScanLock = true;

    const bucket = getFirebaseAdminStorage().bucket();
    const quarantineObject = bucket.file(quarantinePath);
    const [exists] = await quarantineObject.exists();
    if (!exists) throw new ApiRequestError(400, "contract-upload-file-missing", "Le fichier n’a pas été téléversé. Réessayez.");
    const [metadata] = await quarantineObject.getMetadata();
    const size = Number(metadata.size || 0);
    const contentType = String(metadata.contentType || "").toLowerCase();
    const custom = metadata.metadata && typeof metadata.metadata === "object" ? Object.fromEntries(Object.entries(metadata.metadata as Record<string, unknown>).map(([key, value]) => [key.toLowerCase().replace(/^x-goog-meta-/, "").replace(/[^a-z0-9]/g, ""), value])) : {};
    if (contentType !== claim.contentType || size !== claim.expectedSize || size < 1 || size > MAX_FILE_BYTES || !CONTRACT_TYPES.has(contentType) || custom.nexaadminuid !== admin.uid || custom.nexaprovideruid !== providerUid || custom.nexauploadsessionid !== sessionId || (typeof custom.firebasestoragedownloadtokens === "string" && custom.firebasestoragedownloadtokens)) {
      throw new ApiRequestError(400, "contract-upload-metadata-invalid", "Le fichier ne correspond pas au format, à la taille ou à la session annoncés.");
    }
    const [contents] = await quarantineObject.download();
    const scan = await scanDiagnosticResultFile({ fileBuffer: contents, contentType });
    const sha256Hash = createHash("sha256").update(contents).digest("hex");
    const documentId = randomBytes(18).toString("base64url");
    finalPath = `nexa-diagnostic-partner-contracts/${providerUid}/${documentId}`;
    await sessionRef.update({ finalStoragePath: finalPath, finalDocumentId: documentId });
    await quarantineObject.move(finalPath);
    await bucket.file(finalPath).setMetadata({
      contentType,
      cacheControl: "private, no-store",
      metadata: { nexaAntivirusStatus: "CLEAN", nexaAntivirusScannerVersion: scan.scannerVersion || "unknown", nexaSha256: sha256Hash, firebaseStorageDownloadTokens: "" },
    });

    const providerRef = db.collection("providerProfiles").doc(providerUid);
    const documentRef = providerRef.collection("contractDocuments").doc(documentId);
    const auditRef = db.collection("adminAuditLogs").doc();
    const uploadedAt = FieldValue.serverTimestamp();
    await db.runTransaction(async (transaction) => {
      const documentsQuery = providerRef.collection("contractDocuments").limit(MAX_DOCUMENTS + 1);
      const [session, provider, documents] = await Promise.all([transaction.get(sessionRef), transaction.get(providerRef), transaction.get(documentsQuery)]);
      if (!session.exists || session.get("status") !== "SCANNING" || session.get("createdByUid") !== admin.uid || session.get("providerUid") !== providerUid || !provider.exists || !["laboratory", "imaging"].includes(String(provider.get("type") || ""))) {
        throw new ApiRequestError(409, "contract-upload-session-conflict", "La session ou le partenaire n’est plus disponible.");
      }
      const count = documents.size;
      if (count >= MAX_DOCUMENTS) throw new ApiRequestError(409, "contract-document-limit", `Un partenaire peut avoir au maximum ${MAX_DOCUMENTS} justificatifs.`);
      transaction.create(documentRef, {
        name: claim.fileName,
        contentType,
        size,
        sha256Hash,
        storagePath: finalPath,
        antivirusStatus: "CLEAN",
        scannerVersion: scan.scannerVersion,
        uploadedByUid: admin.uid,
        uploadedAt,
      });
      transaction.update(providerRef, { contractDocumentCount: count + 1, updatedAt: FieldValue.serverTimestamp(), updatedByUid: admin.uid });
      transaction.update(sessionRef, { status: "SUBMITTED", documentId, closedAt: FieldValue.serverTimestamp(), cleanupAfterAt: FieldValue.delete() });
      transaction.create(auditRef, { actorUid: admin.uid, action: "diagnostic_partner_contract_document_added", resource: `providerProfiles/${providerUid}/contractDocuments/${documentId}`, contentType, size, createdAt: FieldValue.serverTimestamp() });
    });
    ownsScanLock = false;
    return json(request, { ok: true, document: { id: documentId, name: claim.fileName, contentType, size, uploadedByUid: admin.uid, uploadedAt: new Date().toISOString(), antivirusStatus: "CLEAN" } }, 201);
  } catch (error) {
    if (ownsScanLock && db) {
      const bucket = getFirebaseAdminStorage().bucket();
      await Promise.allSettled([quarantinePath, finalPath].filter(Boolean).map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
      if (sessionId) await db.collection("diagnosticPartnerContractUploadSessions").doc(sessionId).set({ status: error instanceof ApiRequestError && error.code === "malware-detected" ? "REJECTED" : "FAILED", closedAt: FieldValue.serverTimestamp(), cleanupAfterAt: Timestamp.fromMillis(Date.now() + CLEANUP_GRACE_MS) }, { merge: true }).catch(() => undefined);
    }
    return fail(request, error);
  }
}
