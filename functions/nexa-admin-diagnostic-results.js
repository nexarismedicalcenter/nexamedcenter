"use strict";

const { createHash } = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { FieldPath } = require("firebase-admin/firestore");

const REGION = "us-east4";
const REVIEW_STATUSES = new Set(["RESULT_PENDING_REVIEW", "VALIDATED", "RESULT_AVAILABLE"]);
const RESULT_REVIEW_PAGE_SIZE = 25;

function parseDiagnosticResultCursor(value, status, ApiError) {
  if (value === undefined) return { after: null, createdAtMs: null, status };
  if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ApiError(400, "invalid-result-cursor", "Le repère de pagination des résultats n’est pas valide.");
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch {
    throw new ApiError(400, "invalid-result-cursor", "Le repère de pagination des résultats n’est pas valide.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !== "after,createdAtMs,status" || parsed.status !== status ||
    !Number.isSafeInteger(parsed.createdAtMs) ||
    (typeof parsed.after !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(parsed.after))) {
    throw new ApiError(400, "invalid-result-cursor", "Le repère de pagination des résultats n’est pas valide.");
  }
  return { after: parsed.after, createdAtMs: parsed.createdAtMs, status };
}

function encodeDiagnosticResultCursor(cursor) {
  return cursor.done ? null : Buffer.from(JSON.stringify({ after: cursor.after, createdAtMs: cursor.createdAtMs, status: cursor.status }), "utf8").toString("base64url");
}

function cleanText(value, maximum) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

function claimId(orderId, examLineId) {
  return createHash("sha256").update(orderId + ":" + examLineId).digest("hex");
}

function safeDate(value) {
  return value && typeof value.toDate === "function" ? value.toDate().toISOString() : null;
}

function allFilesClean(files) {
  return Array.isArray(files) && files.length > 0 && files.every((file) =>
    file && typeof file === "object" && file.antivirusStatus === "CLEAN");
}

module.exports = function createNexaAdminDiagnosticResultFunctions(dependencies) {
  const { db, FieldValue, storage, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger, createNexaNotification } = dependencies;

  const nexaAdminDiagnosticResults = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > 24_576 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 24_576)) {
      return fail(res, 413, "request-too-large", "La demande de revue est trop volumineuse.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      const admins = new Set(String(process.env.NEXA_ADMIN_UIDS || "").split(",").map((value) => value.trim()).filter(Boolean));
      if (!admins.size) throw new ApiError(503, "admin-access-not-configured", "L’accès administrateur NEXA n’est pas configuré.");
      if (!admins.has(user.uid)) throw new ApiError(403, "administrator-required", "Accès administrateur requis.");
      await enforceUserRateLimit(user.uid, "admin-diagnostic-results", 30, 60_000);

      const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}), "utf8");
      if (raw.byteLength > 24_576) throw new ApiError(413, "request-too-large", "La demande de revue est trop volumineuse.");
      let body;
      try { body = JSON.parse(raw.toString("utf8")); } catch { throw new ApiError(400, "invalid-request", "La demande de revue n’est pas valide."); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "invalid-request", "La demande de revue n’est pas valide.");
      const action = cleanText(body.action, 40).toUpperCase();

      if (action === "LIST") {
        const status = cleanText(body.status, 40) || "RESULT_PENDING_REVIEW";
        if (!REVIEW_STATUSES.has(status)) throw new ApiError(400, "invalid-result-status", "Le filtre de résultats n’est pas valide.");
        const cursor = parseDiagnosticResultCursor(body.cursor, status, ApiError);
        const collection = db.collection("diagnosticResults");
        let query = collection.where("status", "==", status)
          .orderBy("createdAt", "desc")
          .orderBy(FieldPath.documentId(), "asc");
        if (cursor.after) query = query.startAfter(new Date(cursor.createdAtMs), collection.doc(cursor.after));
        const snapshot = await query.limit(RESULT_REVIEW_PAGE_SIZE + 1).get();
        const docs = snapshot.docs.slice(0, RESULT_REVIEW_PAGE_SIZE);
        const lastDoc = docs[docs.length - 1];
        const lastCreatedAt = lastDoc?.get("createdAt");
        const next = {
          after: lastDoc ? lastDoc.id : cursor.after,
          createdAtMs: lastDoc && typeof lastCreatedAt?.toMillis === "function" ? lastCreatedAt.toMillis() : cursor.createdAtMs,
          status,
          done: snapshot.docs.length <= RESULT_REVIEW_PAGE_SIZE,
        };
        if (lastDoc && !Number.isSafeInteger(next.createdAtMs)) throw new ApiError(500, "result-cursor-unavailable", "La pagination des résultats ne peut pas continuer.");
        const results = docs.map((doc) => {
          const data = doc.data() || {};
          const files = Array.isArray(data.files) ? data.files.map((file) => ({
            id: cleanText(file?.id, 100), category: cleanText(file?.category, 40),
            fileName: cleanText(file?.fileName, 180), contentType: cleanText(file?.contentType, 100),
            size: Number(file?.size) || 0, antivirusStatus: cleanText(file?.antivirusStatus, 20),
          })) : [];
          return {
            id: doc.id, orderId: cleanText(data.orderId, 200), examLineId: cleanText(data.examLineId, 200),
            orderNumber: cleanText(data.orderNumber, 80), patientNumber: cleanText(data.patientNumber, 32),
            providerName: cleanText(data.providerName, 120), providerType: cleanText(data.providerType, 20),
            examName: cleanText(data.examName, 180), status: cleanText(data.status, 40),
            version: Number(data.version) || 1, comment: cleanText(data.comment, 1_000),
            performedAt: cleanText(data.performedAt, 10), createdAt: safeDate(data.createdAt),
            files, filesClean: allFilesClean(data.files),
          };
        });
        await db.collection("adminAuditLogs").doc().create({
          actorUid: user.uid, action: "admin_diagnostic_results_listed", status,
          resultCount: results.length, hasMore: !next.done, createdAt: FieldValue.serverTimestamp(),
        });
        return res.status(200).json({ ok: true, results, nextCursor: encodeDiagnosticResultCursor(next), hasMore: !next.done });
      }

      const resultId = cleanText(body.resultId, 200);
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(resultId)) throw new ApiError(400, "invalid-result-id", "La référence du résultat n’est pas valide.");
      const resultRef = db.collection("diagnosticResults").doc(resultId);

      if (action === "OPEN_FILE") {
        const fileId = cleanText(body.fileId, 100);
        if (!/^[A-Za-z0-9_-]{10,100}$/.test(fileId)) throw new ApiError(400, "invalid-result-file", "La référence du fichier n’est pas valide.");
        const initial = await resultRef.get();
        if (!initial.exists) throw new ApiError(404, "diagnostic-result-not-found", "Ce résultat est introuvable.");
        const data = initial.data() || {};
        if (!REVIEW_STATUSES.has(String(data.status || ""))) throw new ApiError(409, "diagnostic-result-not-reviewable", "Ce résultat n’est pas disponible pour la revue.");
        const file = Array.isArray(data.files) ? data.files.find((entry) => entry && typeof entry === "object" && entry.id === fileId) : null;
        const storagePath = cleanText(file?.storagePath, 600);
        if (!file || file.antivirusStatus !== "CLEAN" || !storagePath.startsWith("nexa-diagnostic-results/" + data.orderId + "/" + resultId + "/")) {
          throw new ApiError(409, "diagnostic-result-file-not-cleared", "Ce fichier n’a pas reçu un verdict de sécurité valide.");
        }
        const fileName = cleanText(file.fileName, 180).replace(/[\r\n"\\]/g, "_") || "resultat";
        const [url] = await storage.bucket().file(storagePath).getSignedUrl({
          action: "read", expires: Date.now() + 5 * 60_000,
          responseDisposition: 'inline; filename="' + fileName + '"',
        });
        await db.runTransaction(async (transaction) => {
          const fresh = await transaction.get(resultRef);
          const freshData = fresh.data() || {};
          const freshFiles = Array.isArray(freshData.files) ? freshData.files : [];
          if (!fresh.exists || !REVIEW_STATUSES.has(String(freshData.status || "")) ||
            !freshFiles.some((entry) => entry && entry.id === fileId && entry.antivirusStatus === "CLEAN" && entry.storagePath === storagePath)) {
            throw new ApiError(409, "diagnostic-result-file-changed", "Le fichier ou son état a changé. Actualisez la revue.");
          }
          const opened = freshData.adminViewedByUid === user.uid && Array.isArray(freshData.adminViewedFileIds) ? freshData.adminViewedFileIds : [];
          transaction.update(resultRef, {
            adminViewedAt: FieldValue.serverTimestamp(), adminViewedByUid: user.uid,
            adminViewedFileIds: [...new Set([...opened, fileId])],
          });
          transaction.create(db.collection("diagnosticResultAuditLogs").doc(), {
            actorUid: user.uid, action: "diagnostic_result_file_opened_by_admin",
            orderId: cleanText(data.orderId, 200), resultId, fileId, createdAt: FieldValue.serverTimestamp(),
          });
        });
        return res.status(200).json({ ok: true, url, expiresInSeconds: 300, file: {
          id: fileId, fileName, contentType: cleanText(file.contentType, 100),
          size: Number(file.size) || 0, category: cleanText(file.category, 40),
        } });
      }

      if (action === "REVIEW") {
        const decision = cleanText(body.decision, 40).toUpperCase();
        const reason = cleanText(body.reason, 1_000);
        if (!["VALIDATE", "REQUEST_CORRECTION", "NOT_PERFORMED"].includes(decision)) throw new ApiError(400, "invalid-result-review", "La décision de revue est invalide.");
        if (["REQUEST_CORRECTION", "NOT_PERFORMED"].includes(decision) && reason.length < 5) {
          throw new ApiError(400, "result-review-reason-required", "Un motif détaillé de cinq caractères au minimum est requis.");
        }
        const initial = await resultRef.get();
        if (!initial.exists) throw new ApiError(404, "diagnostic-result-not-found", "Ce résultat est introuvable.");
        const initialData = initial.data() || {};
        const orderId = cleanText(initialData.orderId, 200);
        const examLineId = cleanText(initialData.examLineId, 200);
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(orderId) || !/^[A-Za-z0-9_-]{1,200}$/.test(examLineId)) {
          throw new ApiError(409, "diagnostic-result-link-invalid", "Ce résultat n’est pas correctement relié à une commande.");
        }
        const orderRef = db.collection("nexaOrders").doc(orderId);
        const claimRef = db.collection("diagnosticResultClaims").doc(claimId(orderId, examLineId));
        const alertRef = db.collection("paymentSettlementAlerts").doc("diagnostic_result_not_performed_" + orderId + "_" + examLineId);
        const auditRef = db.collection("diagnosticResultAuditLogs").doc();
        const eventRef = db.collection("nexaOrderEvents").doc();
        let providerUid = "";
        let patientUid = "";
        let nextStatus = "";
        const outcome = await db.runTransaction(async (transaction) => {
          const [resultSnapshot, orderSnapshot, claimSnapshot, alertSnapshot] = await Promise.all([
            transaction.get(resultRef), transaction.get(orderRef), transaction.get(claimRef), transaction.get(alertRef),
          ]);
          if (!resultSnapshot.exists || !orderSnapshot.exists || !claimSnapshot.exists) throw new ApiError(404, "diagnostic-result-link-invalid", "Le résultat ou sa commande n’est plus disponible.");
          const current = resultSnapshot.data() || {};
          const order = orderSnapshot.data() || {};
          const claim = claimSnapshot.data() || {};
          const visibleCorrection = current.status === "RESULT_AVAILABLE" && decision === "REQUEST_CORRECTION";
          if (current.status !== "RESULT_PENDING_REVIEW" && !visibleCorrection) throw new ApiError(409, "diagnostic-result-transition-invalid", "Ce résultat ne peut pas recevoir cette décision.");
          if (decision === "VALIDATE" && current.status !== "RESULT_PENDING_REVIEW") throw new ApiError(409, "diagnostic-result-transition-invalid", "Seul un résultat en attente peut être validé.");
          if (claim.currentResultId !== resultId || claim.orderId !== current.orderId || claim.examLineId !== current.examLineId ||
            order.patientUid !== current.patientUid || order.providerUid !== current.providerUid || order.kind !== current.providerType) {
            throw new ApiError(409, "diagnostic-result-order-mismatch", "Le résultat, le patient, le centre et la commande ne correspondent plus.");
          }
          const files = Array.isArray(current.files) ? current.files : [];
          if (!allFilesClean(files) || files.some((file) =>
            !cleanText(file.storagePath, 600).startsWith("nexa-diagnostic-results/" + current.orderId + "/" + resultId + "/"))) {
            throw new ApiError(409, "diagnostic-result-file-not-cleared", "Chaque fichier doit être analysé et stocké dans la zone privée NEXA avant la revue.");
          }
          const opened = current.adminViewedByUid === user.uid && Array.isArray(current.adminViewedFileIds) ? new Set(current.adminViewedFileIds) : new Set();
          if (!current.adminViewedAt || current.adminViewedByUid !== user.uid || files.some((file) => !opened.has(String(file.id)))) {
            throw new ApiError(409, "result-files-must-be-viewed", "Ouvrez chaque fichier avec votre compte administrateur avant de décider.");
          }
          const items = Array.isArray(order.items) ? order.items : [];
          if (items.filter((item) => item && item.offerId === current.examLineId).length !== 1) throw new ApiError(409, "diagnostic-result-line-mismatch", "L’examen ne correspond pas exactement à la commande.");
          nextStatus = decision === "VALIDATE" ? "VALIDATED" : decision === "REQUEST_CORRECTION" ? "CORRECTION_REQUESTED" : "NOT_PERFORMED";
          providerUid = cleanText(current.providerUid, 200);
          patientUid = cleanText(current.patientUid, 200);
          const now = FieldValue.serverTimestamp();
          const updatedItems = items.map((item) => item.offerId === current.examLineId ? { ...item, resultStatus: nextStatus, resultId } : item);
          transaction.update(resultRef, {
            status: nextStatus, reviewAction: decision, reviewReason: reason || null, reviewedAt: now,
            reviewedByUid: user.uid, updatedAt: now, examPerformed: decision !== "NOT_PERFORMED",
            ...(visibleCorrection ? { patientTransferredAt: FieldValue.delete(), patientTransferredByUid: FieldValue.delete() } : {}),
          });
          transaction.update(orderRef, {
            items: updatedItems,
            ...(visibleCorrection ? { status: "EXAM_COMPLETED", completedAt: FieldValue.delete() } : {}),
            updatedAt: now,
          });
          transaction.update(claimRef, { status: nextStatus === "CORRECTION_REQUESTED" ? "CORRECTION_REQUESTED" : "SUBMITTED", updatedAt: now });
          if (decision === "NOT_PERFORMED" && order.paymentStatus === "PAID" && !alertSnapshot.exists) transaction.create(alertRef, {
            resourceType: current.providerType === "laboratory" ? "laboratory-order" : "imaging-order",
            resourceId: current.orderId, patientUid: current.patientUid,
            reason: String(current.providerType).toUpperCase() + "_EXAM_NOT_PERFORMED", status: "open", createdAt: now,
          });
          transaction.create(auditRef, {
            actorUid: user.uid, action: "diagnostic_result_" + decision.toLowerCase(),
            resource: "diagnosticResults/" + resultId, orderId: current.orderId, examLineId: current.examLineId,
            reason: reason || null, createdAt: now,
          });
          transaction.create(eventRef, { orderId: current.orderId, action: "DIAGNOSTIC_RESULT_" + decision, actorUid: user.uid, createdAt: now });
          return { orderId: cleanText(current.orderId, 200), examName: cleanText(current.examName, 180), version: Number(current.version) || 1, visibleCorrection };
        });
        const notify = async (uid, key, notification) => createNexaNotification(uid, key, notification).catch((error) =>
          logger.warn("NEXA diagnostic result notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
        if (providerUid && ["REQUEST_CORRECTION", "NOT_PERFORMED"].includes(decision)) await notify(providerUid, "diagnostic-result-review:" + resultId + ":" + nextStatus, {
          type: "diagnostic_result_review", title: decision === "REQUEST_CORRECTION" ? "Correction de résultat requise" : "Résultat marqué non réalisé",
          body: decision === "REQUEST_CORRECTION" ? "NEXA a demandé une correction. Consultez la commande dans votre espace professionnel." : "NEXA a marqué ce résultat comme non réalisé. Consultez la commande dans votre espace professionnel.",
          url: "/espace-professionnel.html",
        });
        if (patientUid && decision === "NOT_PERFORMED") await notify(patientUid, "diagnostic-result-not-performed:" + resultId, {
          type: "diagnostic_result_reconciliation", title: "Votre examen nécessite un suivi NEXA",
          body: "NEXA vérifie la suite à donner à cette commande. Ne payez pas une seconde fois; consultez votre espace patient.",
          url: "/espace-patient.html#commandes",
        });
        if (patientUid && outcome.visibleCorrection) await notify(patientUid, "diagnostic-result-correction-requested:" + resultId + ":" + nextStatus, {
          type: "diagnostic_result_correction", title: "Un résultat demande une correction",
          body: "NEXA a demandé une correction au centre. Le résultat concerné est temporairement indisponible dans votre espace.",
          url: "/espace-patient.html#resultats",
        });
        return res.status(200).json({ ok: true, resultId, status: nextStatus, patientVisible: false, ...outcome });
      }

      if (action === "TRANSFER") {
        let patientUid = "";
        let orderId = "";
        let examName = "";
        await db.runTransaction(async (transaction) => {
          const resultSnapshot = await transaction.get(resultRef);
          if (!resultSnapshot.exists) throw new ApiError(404, "diagnostic-result-not-found", "Ce résultat est introuvable.");
          const current = resultSnapshot.data() || {};
          const files = Array.isArray(current.files) ? current.files : [];
          if (current.status !== "VALIDATED" || current.examPerformed !== true || !allFilesClean(files) || files.some((file) =>
            !cleanText(file.storagePath, 600).startsWith("nexa-diagnostic-results/" + current.orderId + "/" + resultId + "/"))) {
            throw new ApiError(409, "diagnostic-result-not-transferable", "Le résultat doit être validé comme examen effectué avec tous les fichiers propres avant son transfert.");
          }
          orderId = cleanText(current.orderId, 200);
          const orderRef = db.collection("nexaOrders").doc(orderId);
          const claimRef = db.collection("diagnosticResultClaims").doc(claimId(String(current.orderId), String(current.examLineId)));
          const [orderSnapshot, claimSnapshot] = await Promise.all([transaction.get(orderRef), transaction.get(claimRef)]);
          const order = orderSnapshot.data() || {};
          const claim = claimSnapshot.data() || {};
          if (!orderSnapshot.exists || !claimSnapshot.exists || claim.currentResultId !== resultId ||
            order.patientUid !== current.patientUid || order.providerUid !== current.providerUid || order.kind !== current.providerType) {
            throw new ApiError(409, "diagnostic-result-order-mismatch", "Le patient, le centre ou la commande ne correspond plus au résultat.");
          }
          const items = Array.isArray(order.items) ? order.items : [];
          if (items.filter((item) => item && item.offerId === current.examLineId).length !== 1) throw new ApiError(409, "diagnostic-result-exam-mismatch", "L’examen ne correspond pas exactement à la commande.");
          const updatedItems = items.map((item) => item.offerId === current.examLineId ? { ...item, resultStatus: "RESULT_AVAILABLE", resultId } : item);
          const allResultsAvailable = updatedItems.every((item) => item.resultStatus === "RESULT_AVAILABLE");
          const now = FieldValue.serverTimestamp();
          transaction.update(resultRef, {
            status: "RESULT_AVAILABLE", patientTransferredAt: now, patientTransferredByUid: user.uid,
            updatedAt: now, adminViewedAt: FieldValue.delete(), adminViewedByUid: FieldValue.delete(), adminViewedFileIds: FieldValue.delete(),
          });
          transaction.update(orderRef, { items: updatedItems, ...(allResultsAvailable ? { status: "COMPLETED", completedAt: now } : {}), updatedAt: now });
          transaction.create(db.collection("diagnosticResultAuditLogs").doc(), {
            actorUid: user.uid, action: "diagnostic_result_transferred_to_patient", orderId: current.orderId,
            examLineId: current.examLineId, resultId, createdAt: now,
          });
          transaction.create(db.collection("nexaOrderEvents").doc(), {
            orderId: current.orderId, action: "DIAGNOSTIC_RESULT_AVAILABLE_TO_PATIENT", actorUid: user.uid, createdAt: now,
          });
          patientUid = cleanText(current.patientUid, 200);
          examName = cleanText(current.examName, 180);
        });
        if (patientUid) await createNexaNotification(patientUid, "diagnostic-result-available:" + resultId, {
          type: "diagnostic_result_available", title: "Un résultat médical est disponible",
          body: "Connectez-vous à votre espace NEXA pour consulter le résultat vérifié.",
          url: "/espace-patient.html#resultats",
        }).catch((error) => logger.warn("NEXA diagnostic result notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
        return res.status(200).json({ ok: true, resultId, status: "RESULT_AVAILABLE", orderId, examName });
      }

      throw new ApiError(400, "invalid-diagnostic-result-action", "Choisissez une action de revue valide.");
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA admin diagnostic result operation failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "admin-diagnostic-results-unavailable", "Les résultats ne sont pas accessibles pour le moment.");
    }
  });

  return { nexaAdminDiagnosticResults };
};
