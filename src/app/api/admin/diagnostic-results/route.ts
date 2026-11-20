import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { cleanResultText } from "@/lib/diagnostic-results.server";
import { createUserNotification } from "@/lib/notifications.server";

const REVIEW_STATUSES = new Set(["RESULT_PENDING_REVIEW", "VALIDATED", "RESULT_AVAILABLE"]);

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "admin-diagnostic-results-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les résultats ne sont pas accessibles pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA admin diagnostic results failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function allFilesClean(files: unknown): files is Record<string, unknown>[] {
  return Array.isArray(files) && files.length > 0 && files.every((file) => file && typeof file === "object" && (file as Record<string, unknown>).antivirusStatus === "CLEAN");
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    await requireNexaAdministrator(request);
    const requestedStatus = new URL(request.url).searchParams.get("status") || "RESULT_PENDING_REVIEW";
    if (!REVIEW_STATUSES.has(requestedStatus)) throw new ApiRequestError(400, "invalid-result-status", "Le filtre de résultats n’est pas valide.");
    const snapshot = await getFirebaseAdminDb().collection("diagnosticResults").where("status", "==", requestedStatus).orderBy("createdAt", "desc").limit(100).get();
    const results = snapshot.docs.map((doc) => {
      const data = doc.data();
      const files = Array.isArray(data.files) ? data.files.map((file) => ({
        id: cleanResultText(file.id, 100),
        category: cleanResultText(file.category, 40),
        fileName: cleanResultText(file.fileName, 180),
        contentType: cleanResultText(file.contentType, 100),
        size: Number(file.size) || 0,
        antivirusStatus: cleanResultText(file.antivirusStatus, 20),
      })) : [];
      return {
        id: doc.id,
        orderId: cleanResultText(data.orderId, 200),
        examLineId: cleanResultText(data.examLineId, 200),
        orderNumber: cleanResultText(data.orderNumber, 80),
        patientNumber: cleanResultText(data.patientNumber, 32),
        providerName: cleanResultText(data.providerName, 120),
        providerType: cleanResultText(data.providerType, 20),
        examName: cleanResultText(data.examName, 180),
        status: cleanResultText(data.status, 40),
        version: Number(data.version) || 1,
        comment: cleanResultText(data.comment, 1000),
        performedAt: cleanResultText(data.performedAt, 10),
        createdAt: data.createdAt && typeof data.createdAt.toDate === "function" ? data.createdAt.toDate().toISOString() : null,
        files,
        filesClean: allFilesClean(data.files),
      };
    });
    return json(request, { ok: true, results });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La décision de revue n’est pas valide.");
    const input = body as Record<string, unknown>;
    const resultId = cleanResultText(input.resultId, 200);
    const action = cleanResultText(input.action, 40).toUpperCase();
    const reason = cleanResultText(input.reason, 1000);
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(resultId) || !["VALIDATE", "REQUEST_CORRECTION", "NOT_PERFORMED"].includes(action)) throw new ApiRequestError(400, "invalid-result-review", "La référence ou la décision est invalide.");
    if (["REQUEST_CORRECTION", "NOT_PERFORMED"].includes(action) && reason.length < 5) throw new ApiRequestError(400, "result-review-reason-required", "Un motif détaillé de cinq caractères au minimum est requis.");

    const db = getFirebaseAdminDb();
    const resultRef = db.collection("diagnosticResults").doc(resultId);
    const initial = await resultRef.get();
    if (!initial.exists) throw new ApiRequestError(404, "diagnostic-result-not-found", "Ce résultat est introuvable.");
    const initialData = initial.data() || {};
    const orderId = cleanResultText(initialData.orderId, 200);
    const examLineId = cleanResultText(initialData.examLineId, 200);
    if (!orderId || !examLineId) throw new ApiRequestError(409, "diagnostic-result-link-invalid", "Ce résultat n’est pas correctement relié à une commande.");
    const orderRef = db.collection("nexaOrders").doc(orderId);
    const claimRef = db.collection("diagnosticResultClaims").doc(createHash("sha256").update(`${orderId}:${examLineId}`).digest("hex"));
    const alertRef = db.collection("paymentSettlementAlerts").doc(`diagnostic_result_not_performed_${orderId}_${examLineId}`);
    const auditRef = db.collection("diagnosticResultAuditLogs").doc();
    const eventRef = db.collection("nexaOrderEvents").doc();
    let providerUid = "";
    let patientUid = "";
    let nextStatus = "";
    const result = await db.runTransaction(async (transaction) => {
      const [resultSnapshot, orderSnapshot, claimSnapshot, alertSnapshot] = await Promise.all([transaction.get(resultRef), transaction.get(orderRef), transaction.get(claimRef), transaction.get(alertRef)]);
      if (!resultSnapshot.exists || !orderSnapshot.exists || !claimSnapshot.exists) throw new ApiRequestError(404, "diagnostic-result-link-invalid", "Le résultat ou sa commande n’est plus disponible.");
      const current = resultSnapshot.data() || {};
      const order = orderSnapshot.data() || {};
      const claim = claimSnapshot.data() || {};
      const visibleCorrection = current.status === "RESULT_AVAILABLE" && action === "REQUEST_CORRECTION";
      if (current.status !== "RESULT_PENDING_REVIEW" && !visibleCorrection) throw new ApiRequestError(409, "diagnostic-result-transition-invalid", "Ce résultat ne peut pas recevoir cette décision.");
      if (action === "VALIDATE" && current.status !== "RESULT_PENDING_REVIEW") throw new ApiRequestError(409, "diagnostic-result-transition-invalid", "Seul un résultat en attente peut être validé.");
      if (claim.currentResultId !== resultId || claim.orderId !== current.orderId || claim.examLineId !== current.examLineId || order.patientUid !== current.patientUid || order.providerUid !== current.providerUid || order.kind !== current.providerType) throw new ApiRequestError(409, "diagnostic-result-order-mismatch", "Le résultat, le patient, le centre et la commande ne correspondent plus.");
      if (!allFilesClean(current.files) || current.files.some((file) => {
        const path = cleanResultText(file.storagePath, 600);
        return !path.startsWith(`nexa-diagnostic-results/${current.orderId}/${resultId}/`);
      })) throw new ApiRequestError(409, "diagnostic-result-file-not-cleared", "Chaque fichier doit être analysé et stocké dans la zone privée NEXA avant la revue.");
      const viewedBySameAdmin = current.adminViewedByUid === admin.uid && Array.isArray(current.adminViewedFileIds);
      const viewedIds = new Set(viewedBySameAdmin ? current.adminViewedFileIds as string[] : []);
      if (!current.adminViewedAt || current.adminViewedByUid !== admin.uid || current.files.some((file: Record<string, unknown>) => !viewedIds.has(String(file.id)))) throw new ApiRequestError(409, "result-files-must-be-viewed", "Ouvrez chaque fichier avec votre compte administrateur avant de décider.");
      const items = Array.isArray(order.items) ? order.items as Record<string, unknown>[] : [];
      if (items.filter((item) => item.offerId === current.examLineId).length !== 1) throw new ApiRequestError(409, "diagnostic-result-line-mismatch", "L’examen ne correspond pas exactement à la commande.");

      nextStatus = action === "VALIDATE" ? "VALIDATED" : action === "REQUEST_CORRECTION" ? "CORRECTION_REQUESTED" : "NOT_PERFORMED";
      providerUid = String(current.providerUid || "");
      patientUid = String(current.patientUid || "");
      const now = FieldValue.serverTimestamp();
      const nextItems = items.map((item) => item.offerId === current.examLineId ? { ...item, resultStatus: nextStatus, resultId } : item);
      transaction.update(resultRef, { status: nextStatus, reviewAction: action, reviewReason: reason || null, reviewedAt: now, reviewedByUid: admin.uid, updatedAt: now, examPerformed: action !== "NOT_PERFORMED", ...(visibleCorrection ? { patientTransferredAt: FieldValue.delete(), patientTransferredByUid: FieldValue.delete() } : {}) });
      transaction.update(orderRef, { items: nextItems, ...(visibleCorrection ? { status: "EXAM_COMPLETED", completedAt: FieldValue.delete() } : {}), updatedAt: now });
      transaction.update(claimRef, { status: nextStatus === "CORRECTION_REQUESTED" ? "CORRECTION_REQUESTED" : "SUBMITTED", updatedAt: now });
      if (action === "NOT_PERFORMED" && order.paymentStatus === "PAID" && !alertSnapshot.exists) transaction.create(alertRef, {
        resourceType: current.providerType === "laboratory" ? "laboratory-order" : "imaging-order",
        resourceId: current.orderId,
        patientUid: current.patientUid,
        reason: `${String(current.providerType).toUpperCase()}_EXAM_NOT_PERFORMED`,
        status: "open",
        createdAt: now,
      });
      transaction.create(auditRef, { actorUid: admin.uid, action: `diagnostic_result_${action.toLowerCase()}`, resource: `diagnosticResults/${resultId}`, orderId: current.orderId, examLineId: current.examLineId, reason: reason || null, createdAt: now });
      transaction.create(eventRef, { orderId: current.orderId, action: `DIAGNOSTIC_RESULT_${action}`, actorUid: admin.uid, createdAt: now });
      return { orderId: String(current.orderId), examName: cleanResultText(current.examName, 180), version: Number(current.version) || 1, visibleCorrection };
    });
    if (providerUid && ["REQUEST_CORRECTION", "NOT_PERFORMED"].includes(action)) await createUserNotification({
      uid: providerUid,
      eventKey: `diagnostic-result-review:${resultId}:${nextStatus}`,
      type: "diagnostic_result_review",
      title: action === "REQUEST_CORRECTION" ? "Correction de résultat requise" : "Résultat marqué non réalisé",
      body: action === "REQUEST_CORRECTION" ? "NEXA a demandé une correction. Consultez la commande dans votre espace partenaire." : "NEXA a marqué ce résultat comme non réalisé. Consultez la commande dans votre espace partenaire.",
      url: "/professionnels/espace",
    });
    if (patientUid && action === "NOT_PERFORMED") await createUserNotification({
      uid: patientUid,
      eventKey: `diagnostic-result-not-performed:${resultId}`,
      type: "diagnostic_result_reconciliation",
      title: "Votre examen nécessite un suivi NEXA",
      body: "NEXA vérifie la suite à donner à cette commande. Ne payez pas une seconde fois; consultez votre espace patient.",
      url: "/espace#commandes",
    });
    if (patientUid && result.visibleCorrection) await createUserNotification({
      uid: patientUid,
      eventKey: `diagnostic-result-correction-requested:${resultId}:${nextStatus}`,
      type: "diagnostic_result_correction",
      title: "Un résultat demande une correction",
      body: "NEXA a demandé une correction au centre. Le résultat concerné est temporairement indisponible dans votre espace.",
      url: "/espace#resultats",
    });
    return json(request, { ok: true, resultId, status: nextStatus, patientVisible: false, ...result });
  } catch (error) { return fail(request, error); }
}
