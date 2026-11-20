"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { Filter, Timestamp } = require("firebase-admin/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

const REGION = "us-east4";
const SESSION_MINUTES = 20;
const CLEANUP_GRACE_MS = 15 * 60_000;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 20;
const MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
const CLEANUP_STATES = ["OPEN", "SCANNING", "FAILED", "CANCELLING", "SCAN_FAILED", "REJECTED", "EXPIRED"];
const ALLOWED_CATEGORIES = {
  laboratory: new Set(["LAB_RESULT", "SUPPLEMENTAL"]),
  imaging: new Set(["IMAGING", "RADIOLOGY_REPORT", "SUPPLEMENTAL"]),
};

function cleanText(value, maximum) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

function validId(value, minimum = 10, maximum = 200) {
  return typeof value === "string" && new RegExp("^[A-Za-z0-9_-]{" + minimum + "," + maximum + "}$").test(value);
}

function resultClaimId(orderId, examLineId) {
  return createHash("sha256").update(orderId + ":" + examLineId).digest("hex");
}

function getBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  if (!Buffer.isBuffer(req.rawBody)) return null;
  try {
    const body = JSON.parse(req.rawBody.toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch { return null; }
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return 0;
}

function normalizeRequirements(value, providerType, ApiError, status = 409) {
  const defaults = {
    requiredCategories: [providerType === "laboratory" ? "LAB_RESULT" : "IMAGING"],
    allowSupplemental: true,
    allowMultiplePerCategory: true,
    maxFiles: MAX_FILES,
    maxFileBytes: MAX_FILE_BYTES,
    allowedMimeTypes: [...MIME_TYPES],
  };
  if (value === undefined || value === null) return defaults;
  const invalid = () => new ApiError(status, "invalid-result-requirements", "Les exigences de fichiers configurées pour cet examen ne sont pas valides.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const categories = [...new Set(Array.isArray(value.requiredCategories)
    ? value.requiredCategories.map((item) => cleanText(item, 40).toUpperCase()) : [])];
  const allowedMimeTypes = [...new Set(Array.isArray(value.allowedMimeTypes)
    ? value.allowedMimeTypes.map((item) => cleanText(item, 100).toLowerCase()) : [])];
  const maxFiles = Number(value.maxFiles);
  const maxFileBytes = Number(value.maxFileBytes);
  const hasPrimary = providerType === "laboratory"
    ? categories.includes("LAB_RESULT")
    : categories.some((item) => item === "IMAGING" || item === "RADIOLOGY_REPORT");
  if (!ALLOWED_CATEGORIES[providerType] || !categories.length || categories.some((item) => !ALLOWED_CATEGORIES[providerType].has(item)) ||
    !hasPrimary || typeof value.allowSupplemental !== "boolean" || typeof value.allowMultiplePerCategory !== "boolean" ||
    (!value.allowSupplemental && categories.includes("SUPPLEMENTAL")) || !allowedMimeTypes.length ||
    allowedMimeTypes.some((item) => !MIME_TYPES.has(item)) || !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_FILES ||
    !Number.isInteger(maxFileBytes) || maxFileBytes < 1_048_576 || maxFileBytes > MAX_FILE_BYTES) throw invalid();
  return { requiredCategories: categories, allowSupplemental: value.allowSupplemental,
    allowMultiplePerCategory: value.allowMultiplePerCategory, maxFiles, maxFileBytes, allowedMimeTypes };
}

function validateFiles(value, providerType, requirements, ApiError) {
  if (!Array.isArray(value) || value.length < 1 || value.length > requirements.maxFiles) {
    throw new ApiError(400, "invalid-result-file-count", "Le nombre de fichiers ne respecte pas les exigences de cet examen.");
  }
  const files = value.map((entry) => {
    const item = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
    const category = cleanText(item.category, 40).toUpperCase();
    const contentType = cleanText(item.contentType, 100).toLowerCase();
    const size = Number(item.size);
    const fileName = cleanText(item.fileName, 180).replace(/[\\/\r\n"]/g, "_");
    if (!ALLOWED_CATEGORIES[providerType].has(category) || (category === "SUPPLEMENTAL" && !requirements.allowSupplemental) ||
      !requirements.allowedMimeTypes.includes(contentType) || !Number.isSafeInteger(size) || size < 1 ||
      size > requirements.maxFileBytes || !fileName) {
      throw new ApiError(400, "invalid-result-file", "Chaque fichier doit respecter le format, la catégorie et la taille autorisés.");
    }
    return { category, fileName, contentType, size };
  });
  const counts = new Map();
  for (const file of files) {
    const count = (counts.get(file.category) || 0) + 1;
    if (!requirements.allowMultiplePerCategory && count > 1) throw new ApiError(400, "multiple-result-files-not-allowed", "Un seul fichier par catégorie est autorisé pour cet examen.");
    counts.set(file.category, count);
  }
  if (requirements.requiredCategories.some((category) => !counts.has(category))) {
    throw new ApiError(400, "required-result-file-missing", "Ajoutez un fichier pour chaque catégorie obligatoire de cet examen.");
  }
  return files;
}

function safePerformedAt(value, ApiError) {
  const date = cleanText(value, 10);
  if (!date) return null;
  const parsed = new Date(date + "T12:00:00.000Z");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Port-au-Prince" }).format(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || date > today) {
    throw new ApiError(400, "invalid-performed-date", "La date de réalisation de l’examen n’est pas valide.");
  }
  return date;
}

async function scannerToken(audience, localScanner, ApiError) {
  if (localScanner) return "";
  let response;
  try {
    const identityUrl = new URL("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity");
    identityUrl.searchParams.set("audience", audience);
    identityUrl.searchParams.set("format", "full");
    response = await fetch(identityUrl, { headers: { "Metadata-Flavor": "Google" }, cache: "no-store", signal: AbortSignal.timeout(5_000) });
  } catch {
    throw new ApiError(503, "scanner-identity-unavailable", "L’identité de l’analyse de sécurité n’est pas disponible.");
  }
  if (!response.ok) throw new ApiError(503, "scanner-identity-unavailable", "L’identité de l’analyse de sécurité n’est pas disponible.");
  const token = (await response.text()).trim();
  if (!token || token.length > 20_000) throw new ApiError(503, "scanner-identity-unavailable", "L’identité de l’analyse de sécurité n’est pas disponible.");
  return token;
}

async function scanFile(fileBuffer, contentType, ApiError) {
  const configuredUrl = process.env.NEXA_MALWARE_SCANNER_URL || "";
  const audience = process.env.NEXA_MALWARE_SCANNER_AUDIENCE || "";
  let target;
  try { target = new URL(configuredUrl); } catch {
    throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité n’est pas configurée. Aucun résultat n’a été transmis.");
  }
  const local = process.env.NODE_ENV !== "production" && target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if ((target.protocol !== "https:" && !local) || target.username || target.password || target.search || target.hash || !["", "/"].includes(target.pathname)) {
    throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité n’est pas configurée. Aucun résultat n’a été transmis.");
  }
  if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length < 1 || fileBuffer.length > MAX_FILE_BYTES || !MIME_TYPES.has(contentType)) {
    throw new ApiError(400, "invalid-result-file", "Le fichier ne respecte pas les limites de sécurité NEXA.");
  }
  if (!local) {
    let parsedAudience;
    try { parsedAudience = new URL(audience); } catch { /* fail closed below */ }
    if (!parsedAudience || parsedAudience.origin !== target.origin || !["", "/"].includes(parsedAudience.pathname) ||
      parsedAudience.search || parsedAudience.hash || parsedAudience.username || parsedAudience.password) {
      throw new ApiError(503, "scanner-audience-not-configured", "L’identité de l’analyse de sécurité n’est pas configurée.");
    }
  }
  const token = await scannerToken(audience, local, ApiError);
  let response;
  try {
    response = await fetch(new URL("/scan", target.origin), {
      method: "POST", headers: { "Content-Type": contentType, ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: new Blob([new Uint8Array(fileBuffer)], { type: contentType }), cache: "no-store", signal: AbortSignal.timeout(40_000),
    });
  } catch {
    throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité est temporairement indisponible. Aucun résultat n’a été transmis.");
  }
  const verdict = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 413 || response.status === 415) throw new ApiError(400, "invalid-result-file", "Le fichier ne correspond pas à son type ou dépasse la taille permise.");
    throw new ApiError(503, "malware-scanner-unavailable", "L’analyse de sécurité est temporairement indisponible.");
  }
  if (verdict.status === "INFECTED") throw new ApiError(422, "malware-detected", "Un fichier a été bloqué par l’analyse antivirus.");
  if (verdict.status !== "CLEAN") throw new ApiError(503, "malware-scanner-invalid-response", "L’analyse de sécurité n’a pas confirmé que le fichier est propre.");
  return { scannerVersion: typeof verdict.scannerVersion === "string" ? verdict.scannerVersion.slice(0, 80) : null };
}

module.exports = function createNexaDiagnosticProviderFunctions(dependencies) {
  const { db, FieldValue, storage, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger, createNexaNotification } = dependencies;
  const bucket = storage.bucket(process.env.NEXA_STORAGE_BUCKET || "nexaris-1339d.firebasestorage.app");

  function withCors(req, res) {
    if (!setCors(req, res)) { fail(res, 403, "origin-not-allowed", "Origine non autorisée."); return false; }
    if (req.method === "OPTIONS") { res.status(204).end(); return false; }
    return true;
  }

  const nexaDiagnosticProviderOrders = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!withCors(req, res)) return;
    if (!["GET", "POST"].includes(req.method)) { res.set("Allow", "GET, POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if (req.method === "POST" && ((Number(req.get("Content-Length")) || 0) > 8_192 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 8_192))) {
      return fail(res, 413, "request-too-large", "La demande de commande est trop volumineuse.");
    }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      const providerRef = db.collection("providerProfiles").doc(user.uid);
      const provider = await providerRef.get();
      const type = String(provider.get("type") || "");
      if (!provider.exists || !["laboratory", "imaging"].includes(type) || provider.get("status") !== "verified" || provider.get("publiclyListed") !== true) {
        throw new ApiError(403, "verified-diagnostic-provider-required", "La gestion des commandes est réservée aux centres NEXA vérifiés.");
      }
      await enforceUserRateLimit(user.uid, req.method === "GET" ? "diagnostic-orders-read" : "diagnostic-order-update", req.method === "GET" ? 60 : 30, 60_000);
      res.set("Cache-Control", "no-store, max-age=0");

      if (req.method === "GET") {
        const cursor = cleanText(req.query.cursor, 200);
        const search = cleanText(req.query.q, 100).toUpperCase();
        if (cursor && !validId(cursor)) throw new ApiError(400, "invalid-diagnostic-order-cursor", "Le repère de pagination n’est pas valide.");
        if (search && !/^[A-Z0-9_-]{3,100}$/.test(search)) throw new ApiError(400, "invalid-diagnostic-order-search", "Recherchez avec un numéro complet de commande ou de patient NMC.");
        let query = db.collection("nexaOrders").where("providerUid", "==", user.uid).where("kind", "==", type)
          .where("paymentStatus", "in", ["PAID", "FREE"]).where("settlementStatus", "==", "CONFIRMED").orderBy("createdAt", "desc");
        if (search) query = query.where(Filter.or(Filter.where("orderNumber", "==", search), Filter.where("patientNumber", "==", search)));
        if (cursor) {
          const cursorSnapshot = await db.collection("nexaOrders").doc(cursor).get();
          const cursorOrder = cursorSnapshot.data() || {};
          if (!cursorSnapshot.exists || !cursorOrder.createdAt || cursorOrder.providerUid !== user.uid || cursorOrder.kind !== type ||
            !["PAID", "FREE"].includes(String(cursorOrder.paymentStatus)) || cursorOrder.settlementStatus !== "CONFIRMED" ||
            (search && cursorOrder.orderNumber !== search && cursorOrder.patientNumber !== search)) {
            throw new ApiError(400, "invalid-diagnostic-order-cursor", "Le repère de page n’appartient pas à cette recherche.");
          }
          query = query.startAfter(cursorSnapshot);
        }
        const snapshot = await query.limit(51).get();
        const documents = snapshot.docs.slice(0, 50);
        const correctionIds = [...new Set(documents.flatMap((doc) => Array.isArray(doc.get("items"))
          ? doc.get("items").flatMap((item) => item && item.resultStatus === "CORRECTION_REQUESTED" && validId(item.resultId) ? [item.resultId] : [])
          : []))];
        const correctionSnapshots = [];
        for (let offset = 0; offset < correctionIds.length; offset += 100) {
          correctionSnapshots.push(...await db.getAll(...correctionIds.slice(offset, offset + 100).map((id) => db.collection("diagnosticResults").doc(id))));
        }
        const correctionResults = new Map(correctionSnapshots.map((item) => [item.id, item]));
        const orders = documents.map((doc) => {
          const data = doc.data() || {};
          const items = Array.isArray(data.items) ? data.items.flatMap((raw) => {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
            const item = raw;
            const resultSnapshot = item.resultStatus === "CORRECTION_REQUESTED" ? correctionResults.get(String(item.resultId || "")) : null;
            const resultData = resultSnapshot?.data() || {};
            const correctionMatches = resultSnapshot?.exists === true && resultData.providerUid === user.uid &&
              resultData.providerType === type && resultData.orderId === doc.id && resultData.examLineId === item.offerId &&
              resultData.status === "CORRECTION_REQUESTED";
            return [{
              offerId: cleanText(item.offerId, 200), name: cleanText(item.name, 180) || "Examen médical",
              quantity: Number.isSafeInteger(item.quantity) && item.quantity > 0 ? item.quantity : 1,
              price: Number.isSafeInteger(item.price) && item.price >= 0 ? item.price : null,
              resultStatus: cleanText(item.resultStatus, 40), resultId: cleanText(item.resultId, 200),
              correctionReason: correctionMatches ? cleanText(resultData.reviewReason, 1_000) : "",
              resultRequirements: item.resultRequirements === undefined || item.resultRequirements === null
                ? null : normalizeRequirements(item.resultRequirements, type, ApiError),
            }];
          }) : [];
          const orderNumber = cleanText(data.orderNumber, 80) || "NMC-" + (type === "laboratory" ? "LAB" : "IMG") + "-" + doc.id.slice(-8).toUpperCase();
          return { id: doc.id, orderNumber, patientNumber: cleanText(data.patientNumber, 32) || "Patient NEXA",
            providerName: cleanText(data.providerName, 120) || "Partenaire NEXA", items,
            amount: Number.isSafeInteger(data.amount) && data.amount >= 0 ? data.amount : 0,
            currency: cleanText(data.currency, 8) || "HTG", paymentStatus: cleanText(data.paymentStatus, 30),
            settlementStatus: cleanText(data.settlementStatus, 30), status: cleanText(data.status, 50) || "UNKNOWN",
            requiresPrescription: Boolean(data.prescriptionId),
            createdAt: data.createdAt && typeof data.createdAt.toDate === "function" ? data.createdAt.toDate().toISOString() : null };
        });
        await db.collection("adminAuditLogs").doc().create({ actorUid: user.uid, action: type + "_orders_listed",
          resource: "providerProfiles/" + user.uid, resultCount: orders.length, hasMore: snapshot.docs.length > 50,
          searchApplied: Boolean(search), createdAt: FieldValue.serverTimestamp() });
        return res.status(200).json({ ok: true, providerType: type,
          providerName: cleanText(provider.get("profile")?.name || provider.get("profile")?.displayName || provider.get("displayName"), 120) || "Centre NEXA",
          orders, hasMore: snapshot.docs.length > 50, nextCursor: snapshot.docs.length > 50 ? documents.at(-1)?.id || null : null });
      }

      const body = getBody(req);
      const orderId = cleanText(body?.orderId, 200);
      const action = cleanText(body?.action, 30);
      const reason = cleanText(body?.reason, 500);
      if (!body || !validId(orderId) || !["accept", "refuse", "advance"].includes(action)) {
        throw new ApiError(400, "invalid-diagnostic-order-action", "La commande ou l’action n’est pas valide.");
      }
      if (action === "refuse" && reason.length < 5) throw new ApiError(400, "refusal-reason-required", "Indiquez un motif d’au moins cinq caractères.");
      const orderRef = db.collection("nexaOrders").doc(orderId);
      const alertRef = db.collection("paymentSettlementAlerts").doc("diagnostic_refusal_" + orderId);
      const eventRef = db.collection("nexaOrderEvents").doc();
      const auditRef = db.collection("adminAuditLogs").doc();
      let result;
      await db.runTransaction(async (transaction) => {
        const [freshProvider, orderSnapshot, alertSnapshot] = await Promise.all([
          transaction.get(providerRef), transaction.get(orderRef), transaction.get(alertRef),
        ]);
        if (!freshProvider.exists || freshProvider.get("type") !== type || freshProvider.get("status") !== "verified" || freshProvider.get("publiclyListed") !== true) {
          throw new ApiError(403, "provider-no-longer-authorized", "Le profil partenaire n’est plus autorisé à traiter des commandes.");
        }
        if (!orderSnapshot.exists || orderSnapshot.get("providerUid") !== user.uid || orderSnapshot.get("kind") !== type) {
          throw new ApiError(404, "diagnostic-order-not-found", "Cette commande n’est pas accessible à votre centre.");
        }
        const order = orderSnapshot.data() || {};
        if (!["PAID", "FREE"].includes(String(order.paymentStatus)) || order.settlementStatus !== "CONFIRMED") {
          throw new ApiError(409, "diagnostic-order-not-settled", "Le règlement de cette commande doit être confirmé par NEXA.");
        }
        const current = String(order.status || "");
        let next = "";
        if (action === "refuse") {
          if (!["PAID", "ACCEPTED"].includes(current)) throw new ApiError(409, "diagnostic-order-transition-invalid", "Cette commande ne peut plus être refusée à cette étape.");
          next = "PROVIDER_REFUSED";
        } else if (action === "accept") {
          if (current !== "PAID") throw new ApiError(409, "diagnostic-order-transition-invalid", "Seule une commande réglée peut être acceptée.");
          next = "ACCEPTED";
        } else {
          const transitions = type === "laboratory"
            ? { ACCEPTED: "PATIENT_PRESENTED", PATIENT_PRESENTED: "SAMPLE_COLLECTED", SAMPLE_COLLECTED: "SAMPLE_RECEIVED", SAMPLE_RECEIVED: "ANALYSIS_IN_PROGRESS", ANALYSIS_IN_PROGRESS: "EXAM_COMPLETED" }
            : { ACCEPTED: "PATIENT_PRESENTED", PATIENT_PRESENTED: "EXAM_IN_PROGRESS", EXAM_IN_PROGRESS: "EXAM_COMPLETED" };
          next = transitions[current] || "";
          if (!next) throw new ApiError(409, "diagnostic-order-transition-invalid", "Cette commande ne peut pas passer à l’étape suivante.");
        }
        const now = FieldValue.serverTimestamp();
        transaction.set(orderRef, {
          status: next,
          ...(action === "refuse" ? { refundRequired: order.paymentStatus === "PAID", refundStatus: order.paymentStatus === "PAID" ? "PENDING_REVIEW" : "NOT_APPLICABLE", refusalReason: reason } : {}),
          ...(next === "ACCEPTED" ? { acceptedAt: now } : {}),
          ...(next === "PATIENT_PRESENTED" ? { patientPresentedAt: now } : {}),
          ...(next === "SAMPLE_COLLECTED" ? { sampleCollectedAt: now } : {}),
          ...(next === "SAMPLE_RECEIVED" ? { sampleReceivedAt: now } : {}),
          ...(next === "ANALYSIS_IN_PROGRESS" || next === "EXAM_IN_PROGRESS" ? { examinationStartedAt: now } : {}),
          ...(next === "EXAM_COMPLETED" ? { examinationCompletedAt: now } : {}),
          updatedAt: now,
        }, { merge: true });
        if (action === "refuse" && order.paymentStatus === "PAID" && !alertSnapshot.exists) transaction.create(alertRef, {
          resourceType: type === "laboratory" ? "laboratory-order" : "imaging-order", resourceId: orderId,
          patientUid: order.patientUid || null, reason: type.toUpperCase() + "_PROVIDER_REFUSED_AFTER_PAYMENT",
          status: "open", createdAt: now,
        });
        transaction.create(eventRef, { orderId, fromStatus: current, toStatus: next,
          action: action === "advance" ? "ADVANCE" : action.toUpperCase(), actorUid: user.uid,
          ...(action === "refuse" ? { reason } : {}), createdAt: now });
        transaction.create(auditRef, { actorUid: user.uid, action: type + "_order_" + action,
          resource: "nexaOrders/" + orderId, createdAt: now });
        result = { patientUid: cleanText(order.patientUid, 200), status: next, paymentStatus: String(order.paymentStatus || "") };
      });
      if (result.patientUid && typeof createNexaNotification === "function") {
        const messages = {
          ACCEPTED: { title: "Commande d’examen acceptée", body: "Le centre a accepté votre demande. Consultez les consignes NEXA." },
          PATIENT_PRESENTED: { title: "Présence confirmée", body: "Le centre a confirmé votre arrivée." },
          SAMPLE_COLLECTED: { title: "Prélèvement effectué", body: "Le laboratoire a confirmé le prélèvement." },
          SAMPLE_RECEIVED: { title: "Échantillon reçu", body: "Le laboratoire a reçu l’échantillon pour analyse." },
          ANALYSIS_IN_PROGRESS: { title: "Analyse en cours", body: "Le laboratoire a commencé l’analyse." },
          EXAM_IN_PROGRESS: { title: "Examen en cours", body: "Le centre a commencé l’examen d’imagerie." },
          EXAM_COMPLETED: { title: "Examen réalisé", body: "Le résultat sera disponible dans votre espace après vérification par NEXA." },
          PROVIDER_REFUSED: { title: "Commande refusée", body: result.paymentStatus === "PAID" ? "NEXA doit vérifier le remboursement; ne payez pas à nouveau." : "Le centre a refusé cette demande gratuite." },
        };
        const message = messages[result.status];
        if (message) await createNexaNotification(result.patientUid, "diagnostic-order:" + orderId + ":" + result.status, {
          type: result.status === "PROVIDER_REFUSED" ? "diagnostic_order_refund_review" : "diagnostic_order_status",
          ...message, url: "/espace-patient.html#commandes",
        }).catch((error) => logger.warn("NEXA diagnostic order notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
      }
      return res.status(200).json({ ok: true, orderId, status: result.status });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA diagnostic provider orders failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "diagnostic-orders-unavailable", "Les commandes de ce centre ne sont pas accessibles.");
    }
  });

  const nexaDiagnosticResultUploadSessions = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!withCors(req, res)) return;
    if (!["POST", "DELETE"].includes(req.method)) { res.set("Allow", "POST, DELETE, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > 32_768 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 32_768)) {
      return fail(res, 413, "request-too-large", "La demande de dépôt est trop volumineuse.");
    }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, req.method === "POST" ? "diagnostic-result-upload-start" : "diagnostic-result-upload-cancel", req.method === "POST" ? 5 : 10, 10 * 60_000);
      const body = getBody(req);
      if (!body) throw new ApiError(400, "invalid-request", "La demande de dépôt n’est pas valide.");

      if (req.method === "POST") {
        const orderId = cleanText(body.orderId, 200);
        const examLineId = cleanText(body.examLineId, 200);
        if (!validId(orderId) || !validId(examLineId) || body.confirmMatch !== true) {
          throw new ApiError(400, "invalid-diagnostic-order", "Confirmez la commande et l’examen sélectionnés.");
        }
        const orderRef = db.collection("nexaOrders").doc(orderId);
        const providerRef = db.collection("providerProfiles").doc(user.uid);
        const claimRef = db.collection("diagnosticResultClaims").doc(resultClaimId(orderId, examLineId));
        const sessionRef = db.collection("diagnosticResultUploadSessions").doc();
        const resultRef = db.collection("diagnosticResults").doc();
        const expiresAtMs = Date.now() + SESSION_MINUTES * 60_000;
        const session = await db.runTransaction(async (transaction) => {
          const [provider, orderSnapshot, claimSnapshot] = await Promise.all([
            transaction.get(providerRef), transaction.get(orderRef), transaction.get(claimRef),
          ]);
          const providerType = String(provider.get("type") || "");
          if (!provider.exists || !["laboratory", "imaging"].includes(providerType) || provider.get("status") !== "verified" || provider.get("publiclyListed") !== true) {
            throw new ApiError(403, "verified-diagnostic-provider-required", "Le dépôt est réservé aux centres NEXA vérifiés.");
          }
          if (!orderSnapshot.exists || orderSnapshot.get("providerUid") !== user.uid || orderSnapshot.get("kind") !== providerType) {
            throw new ApiError(404, "diagnostic-order-not-found", "Cette commande n’est pas accessible à votre centre.");
          }
          const order = orderSnapshot.data() || {};
          if (!["PAID", "FREE"].includes(String(order.paymentStatus)) || order.settlementStatus !== "CONFIRMED") {
            throw new ApiError(409, "diagnostic-order-not-settled", "Le paiement de cette commande n’est pas rapproché par NEXA.");
          }
          if (!["EXAM_COMPLETED", "COMPLETED"].includes(String(order.status))) {
            throw new ApiError(409, "diagnostic-exam-not-completed", "Confirmez d’abord que l’examen est effectué.");
          }
          const items = Array.isArray(order.items) ? order.items : [];
          const lines = items.filter((item) => item && item.offerId === examLineId);
          if (lines.length !== 1) throw new ApiError(404, "diagnostic-exam-line-not-found", "Cet examen ne correspond pas à la commande.");
          const requirements = normalizeRequirements(lines[0].resultRequirements, providerType, ApiError);
          const suppliedFiles = validateFiles(body.files, providerType, requirements, ApiError);
          const claim = claimSnapshot.data() || {};
          if (claim.status === "OPEN" && claim.sessionId) {
            const active = await transaction.get(db.collection("diagnosticResultUploadSessions").doc(String(claim.sessionId)));
            if (active.exists && active.get("status") === "OPEN" && timestampMillis(active.get("expiresAt")) > Date.now()) {
              throw new ApiError(409, "result-upload-already-open", "Un dépôt est déjà en cours pour cet examen.");
            }
          }
          let previousResult = null;
          const previousResultId = typeof claim.currentResultId === "string" ? claim.currentResultId : "";
          if (previousResultId) {
            const previous = await transaction.get(db.collection("diagnosticResults").doc(previousResultId));
            if (!previous.exists) throw new ApiError(409, "diagnostic-result-state-invalid", "Le résultat précédent doit être vérifié par NEXA.");
            previousResult = previous.data() || {};
            if (previousResult.status !== "CORRECTION_REQUESTED") {
              throw new ApiError(409, "diagnostic-result-already-submitted", "NEXA doit demander une correction avant un nouveau dépôt.");
            }
          }
          const files = suppliedFiles.map((file, index) => {
            const extension = file.contentType === "application/pdf" ? "pdf" : file.contentType === "image/jpeg" ? "jpg" : "png";
            const id = randomBytes(18).toString("base64url");
            return { id, category: file.category, fileName: file.category.toLowerCase() + "-" + (index + 1) + "." + extension,
              contentType: file.contentType, expectedSize: file.size, storagePath: "nexa-result-quarantine/" + sessionRef.id + "/" + id };
          });
          const version = previousResult ? (Number(previousResult.version) || 1) + 1 : 1;
          const now = FieldValue.serverTimestamp();
          transaction.create(sessionRef, {
            providerUid: user.uid, providerType, orderId, examLineId, patientUid: order.patientUid,
            claimId: claimRef.id, resultId: resultRef.id, previousResultId: previousResult ? previousResultId : null,
            version, resultRequirements: requirements, files, status: "OPEN", cleanupComplete: false,
            createdAt: now, expiresAt: Timestamp.fromMillis(expiresAtMs),
          });
          transaction.set(claimRef, {
            orderId, examLineId, providerUid: user.uid, providerType, sessionId: sessionRef.id,
            resultId: resultRef.id, status: "OPEN", updatedAt: now, expiresAt: Timestamp.fromMillis(expiresAtMs),
            ...(claim.currentResultId ? { currentResultId: claim.currentResultId } : {}),
          }, { merge: true });
          transaction.create(db.collection("diagnosticResultAuditLogs").doc(), {
            actorUid: user.uid, action: "diagnostic_result_upload_started", orderId, examLineId, providerType, createdAt: now,
          });
          return { providerType, order, line: lines[0], files, version, resultId: resultRef.id, sessionId: sessionRef.id, expiresAtMs };
        });

        let uploads;
        try {
          uploads = await Promise.all(session.files.map(async (file) => {
            const [policy] = await bucket.file(file.storagePath).generateSignedPostPolicyV4({
              expires: Date.now() + 10 * 60_000,
              fields: { "Content-Type": file.contentType, success_action_status: "201", "x-goog-if-generation-match": "0", "x-goog-meta-firebasestoragedownloadtokens": "" },
              conditions: [["content-length-range", 1, MAX_FILE_BYTES], ["eq", "$key", file.storagePath],
                ["eq", "$Content-Type", file.contentType], ["eq", "$success_action_status", "201"],
                ["eq", "$x-goog-if-generation-match", "0"], ["eq", "$x-goog-meta-firebasestoragedownloadtokens", ""]],
            });
            return { fileId: file.id, category: file.category, fileName: file.fileName, contentType: file.contentType,
              expectedSize: file.expectedSize, uploadUrl: policy.url, fields: policy.fields };
          }));
        } catch {
          await db.runTransaction(async (transaction) => {
            const [freshSession, freshClaim] = await Promise.all([transaction.get(sessionRef), transaction.get(claimRef)]);
            if (freshSession.exists && freshSession.get("status") === "OPEN") transaction.update(sessionRef, {
              status: "FAILED", expiresAt: Timestamp.now(), closedAt: FieldValue.serverTimestamp(),
            });
            if (freshClaim.exists && freshClaim.get("sessionId") === sessionRef.id) transaction.update(claimRef, {
              status: freshClaim.get("currentResultId") ? "SUBMITTED" : "AVAILABLE", sessionId: FieldValue.delete(),
              expiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp(),
            });
          });
          throw new ApiError(503, "secure-upload-unavailable", "Le téléversement sécurisé est indisponible. Aucun résultat n’a été transmis.");
        }
        res.set("Cache-Control", "no-store, max-age=0");
        return res.status(200).json({ ok: true, uploadSessionId: session.sessionId, resultId: session.resultId,
          expiresAt: session.expiresAtMs,
          order: { id: orderId, examLineId, examName: cleanText(session.line.name, 180), providerType: session.providerType,
            patientNumber: cleanText(session.order.patientNumber, 32), orderNumber: cleanText(session.order.orderNumber, 80),
            providerName: cleanText(session.order.providerName, 120) }, files: uploads });
      }

      const sessionId = cleanText(body.uploadSessionId, 80);
      if (!validId(sessionId, 10, 80)) throw new ApiError(400, "invalid-upload-session", "La session de dépôt n’est pas valide.");
      const sessionRef = db.collection("diagnosticResultUploadSessions").doc(sessionId);
      const sessionSnapshot = await sessionRef.get();
      if (!sessionSnapshot.exists || sessionSnapshot.get("providerUid") !== user.uid || sessionSnapshot.get("status") !== "OPEN") {
        throw new ApiError(404, "upload-session-not-found", "Cette session de dépôt n’est plus disponible.");
      }
      const claimId = cleanText(sessionSnapshot.get("claimId"), 100);
      if (!validId(claimId, 10, 100)) throw new ApiError(409, "upload-session-claim-invalid", "La session n’est plus correctement reliée à son examen.");
      const claimRef = db.collection("diagnosticResultClaims").doc(claimId);
      const cleanupAfter = Timestamp.fromMillis(Date.now() + CLEANUP_GRACE_MS);
      const files = await db.runTransaction(async (transaction) => {
        const [freshSession, claim] = await Promise.all([transaction.get(sessionRef), transaction.get(claimRef)]);
        if (!freshSession.exists || freshSession.get("providerUid") !== user.uid || freshSession.get("status") !== "OPEN" ||
          !claim.exists || claim.get("sessionId") !== sessionId || claim.get("status") !== "OPEN") {
          throw new ApiError(409, "upload-session-not-cancelable", "La session a déjà été utilisée, annulée ou expirée.");
        }
        transaction.update(sessionRef, { status: "CANCELLING", expiresAt: cleanupAfter, cancelRequestedAt: FieldValue.serverTimestamp() });
        transaction.update(claimRef, {
          status: claim.get("currentResultId") ? "SUBMITTED" : "AVAILABLE", sessionId: FieldValue.delete(),
          expiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp(),
        });
        return Array.isArray(freshSession.get("files")) ? freshSession.get("files") : [];
      });
      const paths = files.filter((file) => file && validId(file.id, 10, 80) && file.storagePath === "nexa-result-quarantine/" + sessionId + "/" + file.id).map((file) => file.storagePath);
      const deleted = await Promise.allSettled(paths.map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
      await db.runTransaction(async (transaction) => {
        const fresh = await transaction.get(sessionRef);
        if (fresh.exists && fresh.get("providerUid") === user.uid && fresh.get("status") === "CANCELLING") {
          transaction.update(sessionRef, { cleanupComplete: deleted.every((result) => result.status === "fulfilled"),
            ...(deleted.every((result) => result.status === "fulfilled") ? { cancelCompletedAt: FieldValue.serverTimestamp() } : {}) });
          if (deleted.every((result) => result.status === "fulfilled")) transaction.create(db.collection("diagnosticResultAuditLogs").doc(), {
            actorUid: user.uid, action: "diagnostic_result_upload_cancelled", orderId: cleanText(fresh.get("orderId"), 200),
            examLineId: cleanText(fresh.get("examLineId"), 200), createdAt: FieldValue.serverTimestamp(),
          });
        }
      });
      if (deleted.some((result) => result.status === "rejected")) throw new ApiError(503, "upload-session-cleanup-pending", "L’annulation est enregistrée; le nettoyage sécurisé va se terminer automatiquement.");
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, uploadSessionId: sessionId, status: "CANCELLING" });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA diagnostic result upload session failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "diagnostic-result-upload-unavailable", "Le dépôt sécurisé du résultat n’est pas disponible.");
    }
  });

  const nexaDiagnosticResultSubmit = onRequest({ region: REGION, timeoutSeconds: 300, memory: "1GiB", maxInstances: 4 }, async (req, res) => {
    if (!withCors(req, res)) return;
    if (req.method !== "POST") { res.set("Allow", "POST, OPTIONS"); return fail(res, 405, "method-not-allowed", "Méthode non autorisée."); }
    if ((Number(req.get("Content-Length")) || 0) > 8_192 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 8_192)) {
      return fail(res, 413, "request-too-large", "La demande de transmission est trop volumineuse.");
    }
    let userUid = "";
    let sessionId = "";
    let ownsScanLock = false;
    let submitted = false;
    let quarantinePaths = [];
    const movedPaths = [];
    try {
      const user = await requireUser(req);
      userUid = user.uid;
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "diagnostic-result-submit", 5, 10 * 60_000);
      const body = getBody(req);
      if (!body) throw new ApiError(400, "invalid-request", "La demande de transmission n’est pas valide.");
      sessionId = cleanText(body.uploadSessionId, 80);
      const comment = cleanText(body.comment, 1_000);
      const performedAt = safePerformedAt(body.performedAt, ApiError);
      if (!validId(sessionId, 10, 80)) throw new ApiError(400, "invalid-upload-session", "La session de dépôt n’est pas valide.");
      const sessionRef = db.collection("diagnosticResultUploadSessions").doc(sessionId);
      const initialSession = await sessionRef.get();
      if (!initialSession.exists || initialSession.get("providerUid") !== user.uid || initialSession.get("status") !== "OPEN") {
        throw new ApiError(403, "upload-session-invalid", "La session a expiré ou n’est pas autorisée.");
      }
      const initial = initialSession.data() || {};
      const sessionFiles = Array.isArray(initial.files) ? initial.files : [];
      if (sessionFiles.length < 1 || sessionFiles.length > MAX_FILES || sessionFiles.some((file) =>
        !file || !validId(file.id, 10, 80) || file.storagePath !== "nexa-result-quarantine/" + sessionId + "/" + file.id)) {
        throw new ApiError(409, "upload-session-files-invalid", "Les fichiers attendus pour cette session ne sont pas valides.");
      }
      quarantinePaths = sessionFiles.map((file) => file.storagePath);
      if (timestampMillis(initial.expiresAt) <= Date.now()) throw new ApiError(403, "upload-session-expired", "La session de dépôt a expiré.");
      const providerType = String(initial.providerType || "");
      if (!["laboratory", "imaging"].includes(providerType)) throw new ApiError(409, "upload-session-provider-invalid", "Le type du centre n’est plus valide.");
      const providerRef = db.collection("providerProfiles").doc(user.uid);
      const orderRef = db.collection("nexaOrders").doc(cleanText(initial.orderId, 200));
      const claimRef = db.collection("diagnosticResultClaims").doc(cleanText(initial.claimId, 100));
      const resultRef = db.collection("diagnosticResults").doc(cleanText(initial.resultId, 200));
      const [provider, orderSnapshot, claimSnapshot] = await Promise.all([providerRef.get(), orderRef.get(), claimRef.get()]);
      if (!provider.exists || provider.get("type") !== providerType || provider.get("status") !== "verified" || provider.get("publiclyListed") !== true) {
        throw new ApiError(403, "provider-no-longer-authorized", "Le centre n’est plus autorisé à transmettre des résultats.");
      }
      if (!orderSnapshot.exists || orderSnapshot.get("providerUid") !== user.uid || orderSnapshot.get("kind") !== providerType) {
        throw new ApiError(404, "diagnostic-order-not-found", "La commande n’est plus affectée à votre centre.");
      }
      const order = orderSnapshot.data() || {};
      if (!["PAID", "FREE"].includes(String(order.paymentStatus)) || order.settlementStatus !== "CONFIRMED" ||
        !["EXAM_COMPLETED", "COMPLETED"].includes(String(order.status))) {
        throw new ApiError(409, "diagnostic-order-no-longer-eligible", "La commande ne peut plus recevoir de résultat.");
      }
      if (!claimSnapshot.exists || claimSnapshot.get("sessionId") !== sessionId || claimSnapshot.get("status") !== "OPEN") {
        throw new ApiError(409, "diagnostic-result-claim-lost", "La session de résultat n’est plus active.");
      }
      const orderItems = Array.isArray(order.items) ? order.items : [];
      const lines = orderItems.filter((item) => item && item.offerId === initial.examLineId);
      if (lines.length !== 1) throw new ApiError(409, "diagnostic-exam-line-changed", "L’examen ne correspond plus exactement à cette commande.");
      const requirements = normalizeRequirements(lines[0].resultRequirements, providerType, ApiError);
      const savedRequirements = normalizeRequirements(initial.resultRequirements || requirements, providerType, ApiError);
      if (JSON.stringify(requirements) !== JSON.stringify(savedRequirements)) throw new ApiError(409, "diagnostic-result-requirements-changed", "Les exigences de dépôt ont changé; recherchez à nouveau la commande.");
      validateFiles(sessionFiles.map((file) => ({ category: file.category, fileName: file.fileName, contentType: file.contentType, size: file.expectedSize })), providerType, requirements, ApiError);

      await db.runTransaction(async (transaction) => {
        const [freshProvider, freshOrder, freshSession, freshClaim] = await Promise.all([
          transaction.get(providerRef), transaction.get(orderRef), transaction.get(sessionRef), transaction.get(claimRef),
        ]);
        const freshOrderData = freshOrder.data() || {};
        if (!freshSession.exists || freshSession.get("status") !== "OPEN" || freshSession.get("providerUid") !== user.uid || timestampMillis(freshSession.get("expiresAt")) <= Date.now()) {
          throw new ApiError(409, "diagnostic-result-session-locked", "Cette session est déjà utilisée, annulée ou expirée.");
        }
        if (!freshClaim.exists || freshClaim.get("sessionId") !== sessionId || freshClaim.get("status") !== "OPEN") throw new ApiError(409, "diagnostic-result-claim-lost", "La session n’est plus active.");
        if (!freshProvider.exists || freshProvider.get("type") !== providerType || freshProvider.get("status") !== "verified" || freshProvider.get("publiclyListed") !== true ||
          !freshOrder.exists || freshOrderData.providerUid !== user.uid || freshOrderData.kind !== providerType || !["PAID", "FREE"].includes(String(freshOrderData.paymentStatus)) ||
          freshOrderData.settlementStatus !== "CONFIRMED" || !["EXAM_COMPLETED", "COMPLETED"].includes(String(freshOrderData.status))) {
          throw new ApiError(409, "diagnostic-order-changed", "Le centre ou la commande n’est plus autorisé à recevoir ce résultat.");
        }
        transaction.update(sessionRef, { status: "SCANNING", scanningStartedAt: FieldValue.serverTimestamp() });
        transaction.update(claimRef, { status: "SCANNING", updatedAt: FieldValue.serverTimestamp() });
      });
      ownsScanLock = true;

      const storedFiles = await Promise.all(sessionFiles.map(async (file) => {
        const object = bucket.file(file.storagePath);
        const [exists] = await object.exists();
        if (!exists) throw new ApiError(400, "result-file-missing", "Un fichier sélectionné n’a pas été téléversé.");
        const [metadata] = await object.getMetadata();
        const size = Number(metadata.size || 0);
        const contentType = String(metadata.contentType || "").toLowerCase();
        const custom = metadata.metadata && typeof metadata.metadata === "object" ? metadata.metadata : {};
        const tokenEntry = Object.entries(custom).find(([key]) => key.toLowerCase() === "firebasestoragedownloadtokens");
        if (contentType !== file.contentType || size !== file.expectedSize || size < 1 || size > requirements.maxFileBytes ||
          (tokenEntry && typeof tokenEntry[1] === "string" && tokenEntry[1].length > 0)) {
          throw new ApiError(400, "result-file-metadata-invalid", "Un fichier ne correspond pas à son type ou à sa taille prévue.");
        }
        return { ...file, size, contentType, md5Hash: typeof metadata.md5Hash === "string" ? metadata.md5Hash : null };
      }));
      const hashes = new Set();
      for (const file of storedFiles) {
        if (file.md5Hash && hashes.has(file.md5Hash)) throw new ApiError(409, "duplicate-result-file", "Le même fichier a été sélectionné plusieurs fois.");
        if (file.md5Hash) hashes.add(file.md5Hash);
      }
      const scanResults = new Array(storedFiles.length);
      let cursor = 0;
      let scanFailure = null;
      const worker = async () => {
        while (!scanFailure) {
          const index = cursor++;
          if (index >= storedFiles.length) return;
          try {
            const [contents] = await bucket.file(storedFiles[index].storagePath).download();
            scanResults[index] = await scanFile(contents, storedFiles[index].contentType, ApiError);
          } catch (error) { scanFailure ||= error; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, storedFiles.length) }, () => worker()));
      if (scanFailure) throw scanFailure;

      const resultId = cleanText(initial.resultId, 200);
      if (!validId(resultId) || (await resultRef.get()).exists) throw new ApiError(409, "diagnostic-result-already-submitted", "Un résultat a déjà été transmis pour cette session.");
      const resultFiles = [];
      for (let index = 0; index < storedFiles.length; index += 1) {
        const file = storedFiles[index];
        const destination = "nexa-diagnostic-results/" + initial.orderId + "/" + resultId + "/" + file.id;
        await bucket.file(file.storagePath).move(destination);
        movedPaths.push(destination);
        await bucket.file(destination).setMetadata({ contentType: file.contentType, cacheControl: "private, no-store",
          metadata: { nexaScanStatus: "CLEAN", firebaseStorageDownloadTokens: "" } });
        resultFiles.push({ id: file.id, category: file.category, storagePath: destination, fileName: file.fileName,
          contentType: file.contentType, size: file.size, md5Hash: file.md5Hash, antivirusStatus: "CLEAN",
          antivirusScannerVersion: scanResults[index].scannerVersion, antivirusScannedAt: new Date().toISOString() });
      }

      const previousResultId = typeof initial.previousResultId === "string" ? initial.previousResultId : "";
      const previousResultRef = previousResultId ? db.collection("diagnosticResults").doc(previousResultId) : null;
      await db.runTransaction(async (transaction) => {
        const reads = [transaction.get(providerRef), transaction.get(orderRef), transaction.get(sessionRef), transaction.get(claimRef), transaction.get(resultRef)];
        if (previousResultRef) reads.push(transaction.get(previousResultRef));
        const [freshProvider, freshOrder, freshSession, freshClaim, freshResult, previousResult] = await Promise.all(reads);
        const freshOrderData = freshOrder.data() || {};
        const freshSessionData = freshSession.data() || {};
        if (!freshProvider.exists || freshProvider.get("type") !== providerType || freshProvider.get("status") !== "verified" || freshProvider.get("publiclyListed") !== true ||
          !freshOrder.exists || freshOrderData.providerUid !== user.uid || freshOrderData.kind !== providerType || !["PAID", "FREE"].includes(String(freshOrderData.paymentStatus)) ||
          freshOrderData.settlementStatus !== "CONFIRMED" || !["EXAM_COMPLETED", "COMPLETED"].includes(String(freshOrderData.status))) {
          throw new ApiError(409, "diagnostic-order-changed", "Le centre ou la commande a changé pendant l’analyse.");
        }
        if (!freshSession.exists || freshSessionData.status !== "SCANNING" || freshSessionData.providerUid !== user.uid || !freshClaim.exists ||
          freshClaim.get("sessionId") !== sessionId || freshClaim.get("status") !== "SCANNING" || freshResult.exists) {
          throw new ApiError(409, "diagnostic-result-session-conflict", "La session a expiré ou a déjà été utilisée.");
        }
        if (previousResultRef && (!previousResult?.exists || previousResult.get("status") !== "CORRECTION_REQUESTED" || freshClaim.get("currentResultId") !== previousResultId)) {
          throw new ApiError(409, "diagnostic-result-correction-stale", "La demande de correction a déjà été traitée.");
        }
        if (!previousResultRef && typeof freshClaim.get("currentResultId") === "string") throw new ApiError(409, "diagnostic-result-already-submitted", "Un résultat existe déjà pour cet examen.");
        const items = Array.isArray(freshOrderData.items) ? freshOrderData.items : [];
        const matchingItems = items.filter((item) => item && item.offerId === freshSessionData.examLineId);
        if (matchingItems.length !== 1) throw new ApiError(409, "diagnostic-exam-line-changed", "L’examen ne correspond plus exactement à cette commande.");
        const freshRequirements = normalizeRequirements(matchingItems[0].resultRequirements, providerType, ApiError);
        if (JSON.stringify(freshRequirements) !== JSON.stringify(requirements)) throw new ApiError(409, "diagnostic-result-requirements-changed", "Les exigences ont changé pendant le dépôt.");
        const updatedItems = items.map((item) => item.offerId === freshSessionData.examLineId
          ? { ...item, resultStatus: "RESULT_PENDING_REVIEW", resultId } : item);
        const now = FieldValue.serverTimestamp();
        transaction.create(resultRef, {
          orderId: freshSessionData.orderId, examLineId: freshSessionData.examLineId,
          patientUid: freshOrderData.patientUid, patientNumber: cleanText(freshOrderData.patientNumber, 32),
          orderNumber: cleanText(freshOrderData.orderNumber, 80), providerName: cleanText(freshOrderData.providerName, 120),
          providerUid: user.uid, providerType,
          examName: cleanText(matchingItems[0].name, 180) || "Examen médical", files: resultFiles, comment: comment || null,
          performedAt, version: Number(freshSessionData.version) || 1, previousResultId: previousResultId || null,
          status: "RESULT_PENDING_REVIEW", createdAt: now, updatedAt: now, reviewedAt: null, reviewedByUid: null,
          patientTransferredAt: null, adminViewedFileIds: [],
        });
        transaction.update(sessionRef, { status: "SUBMITTED", submittedAt: now, cleanupComplete: true });
        transaction.update(claimRef, { status: "SUBMITTED", currentResultId: resultId, resultId,
          sessionId: FieldValue.delete(), expiresAt: FieldValue.delete(), updatedAt: now });
        transaction.update(orderRef, { items: updatedItems, updatedAt: now });
        if (previousResultRef) transaction.update(previousResultRef, { status: "SUPERSEDED", replacedByResultId: resultId, supersededAt: now, updatedAt: now });
        transaction.create(db.collection("diagnosticResultAuditLogs").doc(), {
          actorUid: user.uid, action: previousResultRef ? "diagnostic_result_correction_submitted" : "diagnostic_result_submitted",
          orderId: freshSessionData.orderId, examLineId: freshSessionData.examLineId, resultId,
          version: Number(freshSessionData.version) || 1, fileCount: resultFiles.length, createdAt: now,
        });
        transaction.create(db.collection("nexaOrderEvents").doc(), {
          orderId: freshSessionData.orderId, action: "DIAGNOSTIC_RESULT_SUBMITTED_FOR_REVIEW", actorUid: user.uid, createdAt: now,
        });
      });
      submitted = true;
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, resultId, status: "RESULT_PENDING_REVIEW", message: "Le résultat est transmis à la revue sécurisée NEXA. Il sera visible au patient après validation." });
    } catch (error) {
      if (ownsScanLock && !submitted && sessionId && userUid) {
        const cleanup = await Promise.allSettled([...quarantinePaths, ...movedPaths].map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
        const cleanupComplete = cleanup.every((result) => result.status === "fulfilled");
        const status = error instanceof ApiError && error.code === "malware-detected" ? "REJECTED" : "SCAN_FAILED";
        try {
          const sessionRef = db.collection("diagnosticResultUploadSessions").doc(sessionId);
          const session = await sessionRef.get();
          if (session.exists && session.get("providerUid") === userUid && session.get("status") === "SCANNING") {
            const claimRef = db.collection("diagnosticResultClaims").doc(cleanText(session.get("claimId"), 100));
            await db.runTransaction(async (transaction) => {
              const [freshSession, claim] = await Promise.all([transaction.get(sessionRef), transaction.get(claimRef)]);
              if (!freshSession.exists || freshSession.get("providerUid") !== userUid || freshSession.get("status") !== "SCANNING") return;
              transaction.update(sessionRef, { status, cleanupComplete, closedAt: FieldValue.serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + CLEANUP_GRACE_MS) });
              if (claim.exists && claim.get("sessionId") === sessionId) transaction.update(claimRef, {
                status: claim.get("currentResultId") ? "SUBMITTED" : "AVAILABLE", sessionId: FieldValue.delete(),
                expiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp(),
              });
            });
          }
        } catch (cleanupError) {
          logger.warn("NEXA diagnostic result session cleanup deferred", { errorName: cleanupError instanceof Error ? cleanupError.name : "unknown-error" });
        }
      }
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA diagnostic result submit failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      res.set("Cache-Control", "no-store, max-age=0");
      return fail(res, 500, "diagnostic-result-submit-failed", "Le résultat n’a pas pu être transmis à la revue NEXA.");
    }
  });

  const nexaCleanupDiagnosticResultUploads = onSchedule({ schedule: "every 15 minutes", region: REGION, timeZone: "America/Port-au-Prince" }, async () => {
    const now = Timestamp.now();
    const sessions = await db.collection("diagnosticResultUploadSessions").where("status", "in", CLEANUP_STATES)
      .orderBy("expiresAt", "asc").limit(500).get();
    for (const doc of sessions.docs) {
      if (doc.get("cleanupComplete") === true) continue;
      if (timestampMillis(doc.get("expiresAt")) > now.toMillis()) continue;
      const data = doc.data() || {};
      const state = String(data.status || "");
      const files = Array.isArray(data.files) ? data.files : [];
      const quarantine = files.filter((file) => file && validId(file.id, 10, 80) && file.storagePath === "nexa-result-quarantine/" + doc.id + "/" + file.id).map((file) => file.storagePath);
      const safeOrderId = cleanText(data.orderId, 200);
      const safeResultId = cleanText(data.resultId, 200);
      const finalPrefix = "nexa-diagnostic-results/" + safeOrderId + "/" + safeResultId + "/";
      const failedFinal = ["SCANNING", "SCAN_FAILED", "REJECTED"].includes(state) && validId(safeOrderId) && validId(safeResultId)
        ? files.filter((file) => file && validId(file.id, 10, 80)).map((file) => finalPrefix + file.id) : [];
      const deleted = await Promise.allSettled([...quarantine, ...failedFinal].map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
      if (deleted.some((result) => result.status === "rejected")) continue;
      const claimId = cleanText(data.claimId, 100);
      const claimRef = validId(claimId, 10, 100) ? db.collection("diagnosticResultClaims").doc(claimId) : null;
      await db.runTransaction(async (transaction) => {
        const reads = [transaction.get(doc.ref)];
        if (claimRef) reads.push(transaction.get(claimRef));
        const [session, claim] = await Promise.all(reads);
        if (!session.exists || timestampMillis(session.get("expiresAt")) > now.toMillis() || session.get("cleanupComplete") === true) return;
        const currentState = String(session.get("status") || "");
        if (!CLEANUP_STATES.includes(currentState)) return;
        transaction.update(doc.ref, { cleanupComplete: true, cleanupCompletedAt: FieldValue.serverTimestamp(),
          ...(currentState === "OPEN" || currentState === "SCANNING" ? { status: "EXPIRED", closedAt: FieldValue.serverTimestamp() } : {}) });
        if (claimRef && claim.exists && claim.get("sessionId") === doc.id && ["OPEN", "SCANNING"].includes(String(claim.get("status") || ""))) {
          transaction.update(claimRef, { status: claim.get("currentResultId") ? "SUBMITTED" : "AVAILABLE",
            sessionId: FieldValue.delete(), expiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
        }
      });
    }
  });

  return { nexaDiagnosticProviderOrders, nexaDiagnosticResultUploadSessions, nexaDiagnosticResultSubmit, nexaCleanupDiagnosticResultUploads };
};

module.exports.normalizeRequirements = normalizeRequirements;
