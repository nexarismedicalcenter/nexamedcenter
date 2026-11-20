import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb, getFirebaseAdminStorage } from "@/lib/firebase/admin";
import { cleanResultText, normalizeDiagnosticResultRequirements, RESULT_MAX_FILE_BYTES, scanDiagnosticResultFile, validateResultFiles, type DiagnosticProviderType } from "@/lib/diagnostic-results.server";

export const maxDuration = 300;

type SessionFile = { id: string; category: string; fileName: string; contentType: string; expectedSize: number; storagePath: string };

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "diagnostic-result-submit-failed";
  const message = error instanceof ApiRequestError ? error.message : "Le résultat n’a pas pu être transmis à la revue NEXA.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA diagnostic result submit failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function timestampMillis(value: unknown) {
  return value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function" ? Number(value.toMillis()) : 0;
}

function safePerformedAt(value: unknown) {
  const date = cleanResultText(value, 10);
  if (!date) return null;
  const parsed = new Date(`${date}T12:00:00.000Z`);
  const todayInHaiti = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Port-au-Prince" }).format(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || date > todayInHaiti) {
    throw new ApiRequestError(400, "invalid-performed-date", "La date de réalisation de l’examen n’est pas valide.");
  }
  return date;
}

async function closeSession(db: FirebaseFirestore.Firestore, sessionId: string, providerUid: string, status: "SCAN_FAILED" | "REJECTED") {
  const sessionRef = db.collection("diagnosticResultUploadSessions").doc(sessionId);
  const sessionSnapshot = await sessionRef.get();
  if (!sessionSnapshot.exists || sessionSnapshot.get("providerUid") !== providerUid || sessionSnapshot.get("status") !== "SCANNING") return;
  const claimRef = db.collection("diagnosticResultClaims").doc(String(sessionSnapshot.get("claimId")));
  await db.runTransaction(async (transaction) => {
    const [freshSession, freshClaim] = await Promise.all([transaction.get(sessionRef), transaction.get(claimRef)]);
    if (!freshSession.exists || freshSession.get("providerUid") !== providerUid || freshSession.get("status") !== "SCANNING") return;
    transaction.update(sessionRef, { status, closedAt: FieldValue.serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + 15 * 60_000) });
    if (freshClaim.exists && freshClaim.get("sessionId") === sessionId) transaction.update(claimRef, {
      status: freshClaim.get("currentResultId") ? "SUBMITTED" : "AVAILABLE",
      sessionId: FieldValue.delete(),
      expiresAt: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request) {
  let db: ReturnType<typeof getFirebaseAdminDb> | null = null;
  let bucket: ReturnType<ReturnType<typeof getFirebaseAdminStorage>["bucket"]> | null = null;
  let userUid = "";
  let sessionId = "";
  const movedPaths: string[] = [];
  let quarantinedPaths: string[] = [];
  let submitted = false;
  let ownsScanLock = false;
  try {
    const user = await requireFirebaseUser(request);
    userUid = user.uid;
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "diagnostic-result-submit", limit: 5, windowMs: 10 * 60_000 });
    db = getFirebaseAdminDb();
    bucket = getFirebaseAdminStorage().bucket();
    const activeDb = db;
    const activeBucket = bucket;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande de transmission n’est pas valide.");
    const input = body as Record<string, unknown>;
    sessionId = cleanResultText(input.uploadSessionId, 80);
    const comment = cleanResultText(input.comment, 1000);
    const performedAt = safePerformedAt(input.performedAt);
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(sessionId)) throw new ApiRequestError(400, "invalid-upload-session", "La session de dépôt n’est pas valide.");
    const sessionRef = db.collection("diagnosticResultUploadSessions").doc(sessionId);
    const sessionSnapshot = await sessionRef.get();
    if (!sessionSnapshot.exists || sessionSnapshot.get("providerUid") !== user.uid || sessionSnapshot.get("status") !== "OPEN") {
      throw new ApiRequestError(403, "upload-session-invalid", "La session de dépôt est expirée ou non autorisée. Recherchez à nouveau la commande.");
    }
    const session = sessionSnapshot.data() || {};
    const files = Array.isArray(session.files) ? session.files as SessionFile[] : [];
    if (files.length >= 1 && files.length <= 20 && files.every((file) => /^[A-Za-z0-9_-]{10,80}$/.test(file.id) && file.storagePath === `nexa-result-quarantine/${sessionId}/${file.id}`)) {
      quarantinedPaths = files.map((file) => file.storagePath);
    }
    if (timestampMillis(session.expiresAt) <= Date.now()) throw new ApiRequestError(403, "upload-session-expired", "La session de dépôt a expiré. Recherchez à nouveau la commande.");
    const providerType = session.providerType as DiagnosticProviderType;
    if (!["laboratory", "imaging"].includes(providerType)) throw new ApiRequestError(409, "upload-session-provider-invalid", "Le type de centre de cette session n’est plus valide.");
    const providerRef = db.collection("providerProfiles").doc(user.uid);
    const orderRef = db.collection("nexaOrders").doc(cleanResultText(session.orderId, 200));
    const claimRef = db.collection("diagnosticResultClaims").doc(cleanResultText(session.claimId, 100));
    const resultRef = db.collection("diagnosticResults").doc(cleanResultText(session.resultId, 200));
    if (files.length < 1 || files.length > 20 || files.some((file) => !/^[A-Za-z0-9_-]{10,80}$/.test(file.id) || file.storagePath !== `nexa-result-quarantine/${sessionId}/${file.id}`)) {
      throw new ApiRequestError(409, "upload-session-files-invalid", "Les fichiers attendus pour cette session ne sont pas valides.");
    }

    const [providerSnapshot, orderSnapshot, claimSnapshot] = await Promise.all([providerRef.get(), orderRef.get(), claimRef.get()]);
    if (!providerSnapshot.exists || providerSnapshot.get("type") !== providerType || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true) throw new ApiRequestError(403, "provider-no-longer-authorized", "Le profil du centre n’est plus autorisé à transmettre des résultats.");
    if (!orderSnapshot.exists || orderSnapshot.get("providerUid") !== user.uid || orderSnapshot.get("kind") !== providerType) throw new ApiRequestError(404, "diagnostic-order-not-found", "Cette commande n’est plus affectée à votre centre.");
    const order = orderSnapshot.data() || {};
    if (!["PAID", "FREE"].includes(String(order.paymentStatus)) || order.settlementStatus !== "CONFIRMED" || !["EXAM_COMPLETED", "COMPLETED"].includes(String(order.status))) throw new ApiRequestError(409, "diagnostic-order-no-longer-eligible", "La commande ne peut plus recevoir de résultat.");
    if (!claimSnapshot.exists || claimSnapshot.get("sessionId") !== sessionId || claimSnapshot.get("status") !== "OPEN") throw new ApiRequestError(409, "diagnostic-result-claim-lost", "La session de résultat n’est plus active.");
    const orderItems = Array.isArray(order.items) ? order.items as Record<string, unknown>[] : [];
    const orderLine = orderItems.find((item) => item.offerId === session.examLineId);
    if (!orderLine) throw new ApiRequestError(409, "diagnostic-exam-line-changed", "L’examen ne correspond plus exactement à cette commande.");
    const resultRequirements = normalizeDiagnosticResultRequirements(orderLine.resultRequirements, providerType, 409);
    const sessionRequirements = normalizeDiagnosticResultRequirements(session.resultRequirements ?? resultRequirements, providerType, 409);
    if (JSON.stringify(sessionRequirements) !== JSON.stringify(resultRequirements)) throw new ApiRequestError(409, "diagnostic-result-requirements-changed", "Les exigences de dépôt ont changé. Recherchez à nouveau la commande.");
    validateResultFiles(files.map((file) => ({ category: file.category, fileName: file.fileName, contentType: file.contentType, size: file.expectedSize })), providerType, resultRequirements);
    if (orderItems.filter((item) => item.offerId === session.examLineId).length !== 1) throw new ApiRequestError(409, "diagnostic-exam-line-changed", "L’examen ne correspond plus exactement à la commande.");

    await db.runTransaction(async (transaction) => {
      const [freshProvider, freshOrder, freshSession, freshClaim] = await Promise.all([
        transaction.get(providerRef), transaction.get(orderRef), transaction.get(sessionRef), transaction.get(claimRef),
      ]);
      const freshOrderData = freshOrder.data() || {};
      const freshSessionData = freshSession.data() || {};
      if (!freshSession.exists || freshSessionData.status !== "OPEN" || freshSessionData.providerUid !== user.uid || timestampMillis(freshSessionData.expiresAt) <= Date.now()) throw new ApiRequestError(409, "diagnostic-result-session-locked", "Cette session de dépôt est déjà utilisée, annulée ou expirée.");
      if (!freshClaim.exists || freshClaim.get("sessionId") !== sessionId || freshClaim.get("status") !== "OPEN") throw new ApiRequestError(409, "diagnostic-result-claim-lost", "La session de résultat n’est plus active.");
      if (!freshProvider.exists || freshProvider.get("type") !== providerType || freshProvider.get("status") !== "verified" || freshProvider.get("publiclyListed") !== true || !freshOrder.exists || freshOrderData.providerUid !== user.uid || freshOrderData.kind !== providerType || !["PAID", "FREE"].includes(String(freshOrderData.paymentStatus)) || freshOrderData.settlementStatus !== "CONFIRMED" || !["EXAM_COMPLETED", "COMPLETED"].includes(String(freshOrderData.status))) throw new ApiRequestError(409, "diagnostic-order-changed", "Le centre ou la commande n’est plus autorisé à recevoir ce résultat.");
      transaction.update(sessionRef, { status: "SCANNING", scanningStartedAt: FieldValue.serverTimestamp() });
      transaction.update(claimRef, { status: "SCANNING", updatedAt: FieldValue.serverTimestamp() });
    });
    ownsScanLock = true;

    const storedFiles = await Promise.all(files.map(async (file) => {
      const object = activeBucket.file(file.storagePath);
      const [exists] = await object.exists();
      if (!exists) throw new ApiRequestError(400, "result-file-missing", "Un fichier sélectionné n’a pas été téléversé.");
      const [metadata] = await object.getMetadata();
      const size = Number(metadata.size || 0);
      const contentType = String(metadata.contentType || "").toLowerCase();
      const custom = metadata.metadata && typeof metadata.metadata === "object" ? metadata.metadata as Record<string, unknown> : {};
      const downloadToken = Object.entries(custom).find(([key]) => key.toLowerCase() === "firebasestoragedownloadtokens")?.[1];
      if (contentType !== file.contentType || size !== file.expectedSize || size < 1 || size > Math.min(RESULT_MAX_FILE_BYTES, resultRequirements.maxFileBytes) || (typeof downloadToken === "string" && downloadToken.length > 0)) {
        throw new ApiRequestError(400, "result-file-metadata-invalid", "Un fichier ne correspond pas à son type ou sa taille attendue.");
      }
      return { ...file, size, contentType, md5Hash: typeof metadata.md5Hash === "string" ? metadata.md5Hash : null };
    }));
    const duplicateHashes = new Set<string>();
    for (const file of storedFiles) {
      if (file.md5Hash && duplicateHashes.has(file.md5Hash)) throw new ApiRequestError(409, "duplicate-result-file", "Le même fichier a été sélectionné plusieurs fois.");
      if (file.md5Hash) duplicateHashes.add(file.md5Hash);
    }

    const scanResults = new Array<{ scannerVersion: string | null }>(storedFiles.length);
    let cursor = 0;
    let scanFailure: unknown;
    const scanWorker = async () => {
      while (!scanFailure) {
        const index = cursor;
        cursor += 1;
        if (index >= storedFiles.length) return;
        try {
          const [contents] = await activeBucket.file(storedFiles[index].storagePath).download();
          scanResults[index] = await scanDiagnosticResultFile({ fileBuffer: contents, contentType: storedFiles[index].contentType });
        } catch (error) {
          scanFailure ||= error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, storedFiles.length) }, () => scanWorker()));
    if (scanFailure) throw scanFailure;

    const resultId = cleanResultText(session.resultId, 200);
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(resultId) || (await resultRef.get()).exists) throw new ApiRequestError(409, "diagnostic-result-already-submitted", "Un résultat a déjà été transmis pour cette session.");
    const resultFiles = [] as Record<string, unknown>[];
    for (let index = 0; index < storedFiles.length; index += 1) {
      const file = storedFiles[index];
      const destination = `nexa-diagnostic-results/${session.orderId}/${resultId}/${file.id}`;
      await activeBucket.file(file.storagePath).move(destination);
      movedPaths.push(destination);
      await activeBucket.file(destination).setMetadata({
        contentType: file.contentType,
        cacheControl: "private, no-store",
        metadata: { nexaScanStatus: "CLEAN", firebaseStorageDownloadTokens: "" },
      });
      resultFiles.push({ id: file.id, category: file.category, storagePath: destination, fileName: file.fileName, contentType: file.contentType, size: file.size, md5Hash: file.md5Hash, antivirusStatus: "CLEAN", antivirusScannerVersion: scanResults[index].scannerVersion, antivirusScannedAt: new Date().toISOString() });
    }

    const previousResultId = typeof session.previousResultId === "string" ? session.previousResultId : "";
    const previousResultRef = previousResultId ? activeDb.collection("diagnosticResults").doc(previousResultId) : null;
    await activeDb.runTransaction(async (transaction) => {
      const reads = [transaction.get(providerRef), transaction.get(orderRef), transaction.get(sessionRef), transaction.get(claimRef), transaction.get(resultRef)];
      if (previousResultRef) reads.push(transaction.get(previousResultRef));
      const [freshProvider, freshOrder, freshSession, freshClaim, freshResult, freshPrevious] = await Promise.all(reads);
      const freshOrderData = freshOrder.data() || {};
      const freshSessionData = freshSession.data() || {};
      if (!freshProvider.exists || freshProvider.get("type") !== providerType || freshProvider.get("status") !== "verified" || freshProvider.get("publiclyListed") !== true || !freshOrder.exists || freshOrderData.providerUid !== user.uid || freshOrderData.kind !== providerType || !["PAID", "FREE"].includes(String(freshOrderData.paymentStatus)) || freshOrderData.settlementStatus !== "CONFIRMED" || !["EXAM_COMPLETED", "COMPLETED"].includes(String(freshOrderData.status))) throw new ApiRequestError(409, "diagnostic-order-changed", "Le centre ou la commande a changé pendant l’analyse.");
      if (!freshSession.exists || freshSessionData.status !== "SCANNING" || freshSessionData.providerUid !== user.uid || freshClaim.get("sessionId") !== sessionId || freshClaim.get("status") !== "SCANNING" || freshResult.exists) throw new ApiRequestError(409, "diagnostic-result-session-conflict", "La session a expiré ou a déjà été utilisée.");
      if (previousResultRef && (!freshPrevious?.exists || freshPrevious.get("status") !== "CORRECTION_REQUESTED" || freshClaim.get("currentResultId") !== previousResultId)) throw new ApiRequestError(409, "diagnostic-result-correction-stale", "La demande de correction a déjà été traitée.");
      if (!previousResultRef && typeof freshClaim.get("currentResultId") === "string") throw new ApiRequestError(409, "diagnostic-result-already-submitted", "Un résultat existe déjà pour cet examen.");

      const freshItems = Array.isArray(freshOrderData.items) ? freshOrderData.items as Record<string, unknown>[] : [];
      if (freshItems.filter((item) => item.offerId === freshSessionData.examLineId).length !== 1) throw new ApiRequestError(409, "diagnostic-exam-line-changed", "L’examen ne correspond plus exactement à cette commande.");
      const freshLine = freshItems.find((item) => item.offerId === freshSessionData.examLineId);
      if (!freshLine || JSON.stringify(normalizeDiagnosticResultRequirements(freshLine.resultRequirements, providerType, 409)) !== JSON.stringify(resultRequirements)) throw new ApiRequestError(409, "diagnostic-result-requirements-changed", "Les exigences de dépôt ont changé. Recherchez à nouveau la commande.");
      const currentItems = freshItems.map((item) => item.offerId === freshSessionData.examLineId ? { ...item, resultStatus: "RESULT_PENDING_REVIEW", resultId } : item);
      const now = FieldValue.serverTimestamp();
      transaction.create(resultRef, {
        orderId: freshSessionData.orderId,
        examLineId: freshSessionData.examLineId,
        patientUid: freshOrderData.patientUid,
        patientNumber: cleanResultText(freshOrderData.patientNumber, 32),
        orderNumber: cleanResultText(freshOrderData.orderNumber, 80),
        providerName: cleanResultText(freshOrderData.providerName, 120),
        providerUid: user.uid,
        providerType,
        examName: cleanResultText(currentItems.find((item) => item.offerId === freshSessionData.examLineId)?.name, 180) || "Examen médical",
        files: resultFiles,
        comment: comment || null,
        performedAt,
        version: Number(freshSessionData.version) || 1,
        previousResultId: previousResultId || null,
        status: "RESULT_PENDING_REVIEW",
        createdAt: now,
        updatedAt: now,
        reviewedAt: null,
        reviewedByUid: null,
        patientTransferredAt: null,
        adminViewedFileIds: [],
      });
      transaction.update(sessionRef, { status: "SUBMITTED", submittedAt: now });
      transaction.update(claimRef, { status: "SUBMITTED", currentResultId: resultId, resultId, sessionId: FieldValue.delete(), expiresAt: FieldValue.delete(), updatedAt: now });
      transaction.update(orderRef, { items: currentItems, updatedAt: now });
      if (previousResultRef) transaction.update(previousResultRef, { status: "SUPERSEDED", replacedByResultId: resultId, supersededAt: now, updatedAt: now });
      transaction.create(activeDb.collection("diagnosticResultAuditLogs").doc(), { actorUid: user.uid, action: previousResultRef ? "diagnostic_result_correction_submitted" : "diagnostic_result_submitted", orderId: freshSessionData.orderId, examLineId: freshSessionData.examLineId, resultId, version: Number(freshSessionData.version) || 1, fileCount: resultFiles.length, createdAt: now });
      transaction.create(activeDb.collection("nexaOrderEvents").doc(), { orderId: freshSessionData.orderId, action: "DIAGNOSTIC_RESULT_SUBMITTED_FOR_REVIEW", actorUid: user.uid, createdAt: now });
    });
    submitted = true;
    return json(request, { ok: true, resultId, status: "RESULT_PENDING_REVIEW", message: "Le résultat a été transmis à la revue sécurisée NEXA. Il sera visible au patient après validation." });
  } catch (error) {
    if (!submitted && ownsScanLock && userUid && sessionId) {
      if (bucket) await Promise.allSettled([...quarantinedPaths, ...movedPaths].map((path) => bucket?.file(path).delete({ ignoreNotFound: true })));
      const status = error instanceof ApiRequestError && error.code === "malware-detected" ? "REJECTED" : "SCAN_FAILED";
      try { if (db) await closeSession(db, sessionId, userUid, status); }
      catch (cleanupError) { console.error("NEXA result quarantine cleanup failed", cleanupError instanceof Error ? cleanupError.name : "unknown-error"); }
    }
    return fail(request, error);
  }
}
