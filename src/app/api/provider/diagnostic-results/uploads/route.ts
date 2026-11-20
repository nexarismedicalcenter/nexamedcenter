import { createHash, randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb, getFirebaseAdminStorage } from "@/lib/firebase/admin";
import { cleanResultText, normalizeDiagnosticResultRequirements, RESULT_MAX_FILE_BYTES, validateResultFiles, type DiagnosticProviderType } from "@/lib/diagnostic-results.server";

const SESSION_MINUTES = 20;
const UPLOAD_POLICY_CLEANUP_GRACE_MS = 15 * 60_000;

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "diagnostic-result-upload-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le dépôt sécurisé du résultat n’est pas disponible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA diagnostic result upload session failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function resultClaimId(orderId: string, examLineId: string) {
  return createHash("sha256").update(`${orderId}:${examLineId}`).digest("hex");
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "diagnostic-result-upload-start", limit: 5, windowMs: 10 * 60_000 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande de dépôt n’est pas valide.");
    const input = body as Record<string, unknown>;
    const orderId = cleanResultText(input.orderId, 200);
    const examLineId = cleanResultText(input.examLineId, 200);
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(orderId) || !/^[A-Za-z0-9_-]{10,200}$/.test(examLineId)) throw new ApiRequestError(400, "invalid-diagnostic-order", "La commande ou l’examen sélectionné n’est pas valide.");
    if (input.confirmMatch !== true) throw new ApiRequestError(400, "result-confirmation-required", "Confirmez que les fichiers correspondent au patient, à l’examen et à la commande affichés.");

    const db = getFirebaseAdminDb();
    const providerRef = db.collection("providerProfiles").doc(user.uid);
    const orderRef = db.collection("nexaOrders").doc(orderId);
    const claimRef = db.collection("diagnosticResultClaims").doc(resultClaimId(orderId, examLineId));
    const sessionRef = db.collection("diagnosticResultUploadSessions").doc();
    const resultRef = db.collection("diagnosticResults").doc();
    const auditRef = db.collection("diagnosticResultAuditLogs").doc();
    const expiresAtMs = Date.now() + SESSION_MINUTES * 60_000;
    const claim = await db.runTransaction(async (transaction) => {
      const [providerSnapshot, orderSnapshot, claimSnapshot] = await Promise.all([
        transaction.get(providerRef), transaction.get(orderRef), transaction.get(claimRef),
      ]);
      if (!providerSnapshot.exists || !["laboratory", "imaging"].includes(String(providerSnapshot.get("type"))) || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true) {
        throw new ApiRequestError(403, "verified-diagnostic-provider-required", "Le dépôt de résultats est réservé aux laboratoires et centres d’imagerie NEXA vérifiés.");
      }
      const providerType = providerSnapshot.get("type") as DiagnosticProviderType;
      if (!orderSnapshot.exists || orderSnapshot.get("providerUid") !== user.uid || orderSnapshot.get("kind") !== providerType) throw new ApiRequestError(404, "diagnostic-order-not-found", "Cette commande n’est pas accessible à votre centre.");
      const order = orderSnapshot.data() || {};
      if (!["PAID", "FREE"].includes(String(order.paymentStatus)) || order.settlementStatus !== "CONFIRMED") throw new ApiRequestError(409, "diagnostic-order-not-settled", "Le paiement de cette commande n’est pas rapproché par NEXA.");
      if (!["EXAM_COMPLETED", "COMPLETED"].includes(String(order.status))) throw new ApiRequestError(409, "diagnostic-exam-not-completed", "Confirmez d’abord que l’examen est effectué avant de transmettre son résultat.");
      const items = Array.isArray(order.items) ? order.items as Record<string, unknown>[] : [];
      const line = items.find((item) => item.offerId === examLineId);
      if (!line || items.filter((item) => item.offerId === examLineId).length !== 1) throw new ApiRequestError(404, "diagnostic-exam-line-not-found", "Cet examen ne correspond pas à la commande.");
      const resultRequirements = normalizeDiagnosticResultRequirements(line.resultRequirements, providerType, 409);

      let previousResultRef = null;
      let previousResult: Record<string, unknown> | null = null;
      const claimData = claimSnapshot.data() || {};
      if (claimData.status === "OPEN" && claimData.sessionId) {
        const activeSessionRef = db.collection("diagnosticResultUploadSessions").doc(String(claimData.sessionId));
        const activeSessionSnapshot = await transaction.get(activeSessionRef);
        const activeExpiry = activeSessionSnapshot.get("expiresAt") as Timestamp | undefined;
        if (activeSessionSnapshot.exists && activeSessionSnapshot.get("status") === "OPEN" && (activeExpiry?.toMillis() || 0) > Date.now()) {
          throw new ApiRequestError(409, "result-upload-already-open", "Un dépôt est déjà en cours pour cet examen. Terminez-le ou réessayez après son expiration.");
        }
      }
      if (typeof claimData.currentResultId === "string") {
        previousResultRef = db.collection("diagnosticResults").doc(claimData.currentResultId);
        const previousSnapshot = await transaction.get(previousResultRef);
        if (previousSnapshot.exists) previousResult = previousSnapshot.data() || {};
        if (previousResult && previousResult.status !== "CORRECTION_REQUESTED") {
          throw new ApiRequestError(409, "diagnostic-result-already-submitted", "Un résultat existe déjà pour cet examen. NEXA doit demander une correction avant un nouveau dépôt.");
        }
      }

      const files = validateResultFiles(input.files, providerType, resultRequirements).map((file, index) => {
        const extension = file.contentType === "application/pdf" ? "pdf" : file.contentType === "image/jpeg" ? "jpg" : "png";
        const id = randomBytes(18).toString("base64url");
        const storagePath = `nexa-result-quarantine/${sessionRef.id}/${id}`;
        return { id, category: file.category, fileName: `${file.category.toLowerCase()}-${index + 1}.${extension}`, contentType: file.contentType, expectedSize: file.size, storagePath };
      });
      const version = previousResult ? (Number(previousResult.version) || 1) + 1 : 1;
      const now = FieldValue.serverTimestamp();
      transaction.create(sessionRef, {
        providerUid: user.uid,
        providerType,
        orderId,
        examLineId,
        patientUid: order.patientUid,
        claimId: claimRef.id,
        resultId: resultRef.id,
        previousResultId: previousResult ? claimData.currentResultId : null,
        version,
        resultRequirements,
        files,
        status: "OPEN",
        createdAt: now,
        expiresAt: Timestamp.fromMillis(expiresAtMs),
      });
      transaction.set(claimRef, {
        orderId,
        examLineId,
        providerUid: user.uid,
        providerType,
        sessionId: sessionRef.id,
        resultId: resultRef.id,
        status: "OPEN",
        updatedAt: now,
        expiresAt: Timestamp.fromMillis(expiresAtMs),
        ...(claimData.currentResultId ? { currentResultId: claimData.currentResultId } : {}),
      }, { merge: true });
      transaction.create(auditRef, { actorUid: user.uid, action: "diagnostic_result_upload_started", orderId, examLineId, providerType, createdAt: now });
      return { providerType, order, line, resultRequirements, patientNumber: order.patientNumber, providerName: order.providerName || "Partenaire NEXA", files, version, resultId: resultRef.id, sessionId: sessionRef.id, expiresAtMs };
    });

    let uploads: Record<string, unknown>[];
    try {
      const bucket = getFirebaseAdminStorage().bucket();
      uploads = await Promise.all(claim.files.map(async (file) => {
        const [policy] = await bucket.file(file.storagePath).generateSignedPostPolicyV4({
          expires: Date.now() + 10 * 60_000,
          fields: {
            "Content-Type": file.contentType,
            success_action_status: "201",
            "x-goog-if-generation-match": "0",
            "x-goog-meta-firebasestoragedownloadtokens": "",
          },
          conditions: [
            ["content-length-range", 1, RESULT_MAX_FILE_BYTES],
            ["eq", "$key", file.storagePath],
            ["eq", "$Content-Type", file.contentType],
            ["eq", "$success_action_status", "201"],
            ["eq", "$x-goog-if-generation-match", "0"],
            ["eq", "$x-goog-meta-firebasestoragedownloadtokens", ""],
          ],
        });
        return { fileId: file.id, category: file.category, fileName: file.fileName, contentType: file.contentType, expectedSize: file.expectedSize, uploadUrl: policy.url, fields: policy.fields };
      }));
    } catch {
      await db.runTransaction(async (transaction) => {
        const [sessionSnapshot, claimSnapshot] = await Promise.all([transaction.get(sessionRef), transaction.get(claimRef)]);
        if (sessionSnapshot.exists && sessionSnapshot.get("providerUid") === user.uid && sessionSnapshot.get("status") === "OPEN") transaction.update(sessionRef, { status: "FAILED", closedAt: FieldValue.serverTimestamp(), expiresAt: Timestamp.now() });
        if (claimSnapshot.exists && claimSnapshot.get("sessionId") === sessionRef.id) transaction.update(claimRef, { status: "AVAILABLE", sessionId: FieldValue.delete(), expiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
      });
      throw new ApiRequestError(503, "secure-upload-unavailable", "Le téléversement sécurisé n’est pas disponible. Aucun résultat n’a été transmis; réessayez plus tard.");
    }
    return json(request, {
      ok: true,
      uploadSessionId: claim.sessionId,
      resultId: claim.resultId,
      expiresAt: claim.expiresAtMs,
      order: { id: orderId, examLineId, examName: cleanResultText(claim.line.name, 180), providerType: claim.providerType, patientNumber: cleanResultText(claim.patientNumber, 32), orderNumber: cleanResultText(claim.order.orderNumber, 80), providerName: cleanResultText(claim.providerName, 120) },
      files: uploads,
    });
  } catch (error) { return fail(request, error); }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "diagnostic-result-upload-cancel", limit: 10, windowMs: 10 * 60_000 });
    const body = await request.json().catch(() => null);
    const sessionId = body && typeof body === "object" && !Array.isArray(body) ? cleanResultText((body as Record<string, unknown>).uploadSessionId, 80) : "";
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(sessionId)) throw new ApiRequestError(400, "invalid-upload-session", "La session de dépôt n’est pas valide.");
    const db = getFirebaseAdminDb();
    const sessionRef = db.collection("diagnosticResultUploadSessions").doc(sessionId);
    const sessionSnapshot = await sessionRef.get();
    if (!sessionSnapshot.exists || sessionSnapshot.get("providerUid") !== user.uid || sessionSnapshot.get("status") !== "OPEN") throw new ApiRequestError(404, "upload-session-not-found", "Cette session de dépôt n’est plus disponible.");
    const claimId = cleanResultText(sessionSnapshot.get("claimId"), 100);
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(claimId)) throw new ApiRequestError(409, "upload-session-claim-invalid", "La session de dépôt n’est plus correctement reliée à son examen.");
    const claimRef = db.collection("diagnosticResultClaims").doc(claimId);
    const cancelable = await db.runTransaction(async (transaction) => {
      const [freshSession, claimSnapshot] = await Promise.all([transaction.get(sessionRef), transaction.get(claimRef)]);
      if (!freshSession.exists || freshSession.get("providerUid") !== user.uid || freshSession.get("status") !== "OPEN" || !claimSnapshot.exists || claimSnapshot.get("sessionId") !== sessionId || claimSnapshot.get("status") !== "OPEN") return null;
      const cleanupAfter = Timestamp.fromMillis(Date.now() + UPLOAD_POLICY_CLEANUP_GRACE_MS);
      transaction.update(sessionRef, { status: "CANCELLING", expiresAt: cleanupAfter, cancelRequestedAt: FieldValue.serverTimestamp() });
      transaction.update(claimRef, {
        status: claimSnapshot.get("currentResultId") ? "SUBMITTED" : "AVAILABLE",
        sessionId: FieldValue.delete(),
        expiresAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return {
        orderId: freshSession.get("orderId"),
        examLineId: freshSession.get("examLineId"),
        files: Array.isArray(freshSession.get("files")) ? freshSession.get("files") as { id?: unknown; storagePath?: unknown }[] : [],
      };
    });
    if (!cancelable) throw new ApiRequestError(409, "upload-session-not-cancelable", "La session a déjà été utilisée, annulée ou expirée.");
    const paths = cancelable.files.map((file) => typeof file.id === "string" && file.storagePath === `nexa-result-quarantine/${sessionId}/${file.id}` ? file.storagePath : "").filter(Boolean);
    const bucket = getFirebaseAdminStorage().bucket();
    const deleted = await Promise.allSettled(paths.map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
    if (deleted.some((result) => result.status === "rejected")) throw new ApiRequestError(503, "upload-session-cleanup-pending", "La demande d’annulation est enregistrée. Le nettoyage sécurisé va se terminer automatiquement.");
    await db.runTransaction(async (transaction) => {
      const [freshSession, claimSnapshot] = await Promise.all([transaction.get(sessionRef), transaction.get(claimRef)]);
      if (!freshSession.exists || freshSession.get("providerUid") !== user.uid || freshSession.get("status") !== "CANCELLING") return;
      transaction.update(sessionRef, { cancelCompletedAt: FieldValue.serverTimestamp() });
      if (claimSnapshot.exists && claimSnapshot.get("sessionId") === sessionId) transaction.update(claimRef, {
        status: claimSnapshot.get("currentResultId") ? "SUBMITTED" : "AVAILABLE",
        sessionId: FieldValue.delete(),
        expiresAt: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.create(db.collection("diagnosticResultAuditLogs").doc(), { actorUid: user.uid, action: "diagnostic_result_upload_cancelled", orderId: cancelable.orderId, examLineId: cancelable.examLineId, createdAt: FieldValue.serverTimestamp() });
    });
    return json(request, { ok: true, uploadSessionId: sessionId, status: "CANCELLING", cleanupAfter: Date.now() + UPLOAD_POLICY_CLEANUP_GRACE_MS });
  } catch (error) { return fail(request, error); }
}
