"use strict";

const { onRequest } = require("firebase-functions/v2/https");

const REGION = "us-east4";
const ORDER_KINDS = new Set(["laboratory", "imaging"]);
const PAGE_SIZE = 25;
const MAX_BODY_BYTES = 4_096;

function cleanText(value, maximum) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum)
    : "";
}

function safeDate(value) {
  return value && typeof value.toDate === "function" ? value.toDate().toISOString() : null;
}

function safeAmount(value) {
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0;
}

module.exports = function createNexaAdminDiagnosticOrderFunctions(dependencies) {
  const {
    db, FieldValue, ApiError, requireUser, requireAppCheckToken,
    enforceUserRateLimit, setCors, fail, logger,
  } = dependencies;

  const nexaAdminDiagnosticOrders = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") {
      res.set("Allow", "POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if ((Number(req.get("Content-Length")) || 0) > MAX_BODY_BYTES ||
      (Buffer.isBuffer(req.rawBody) && req.rawBody.length > MAX_BODY_BYTES)) {
      return fail(res, 413, "request-too-large", "La demande est trop volumineuse.");
    }

    try {
      const admin = await requireUser(req);
      await requireAppCheckToken(req);
      const administrators = new Set(String(process.env.NEXA_ADMIN_UIDS || "").split(",").map((value) => value.trim()).filter(Boolean));
      if (!administrators.size) throw new ApiError(503, "admin-access-not-configured", "L’accès administrateur NEXA n’est pas configuré.");
      if (!administrators.has(admin.uid)) throw new ApiError(403, "administrator-required", "Accès administrateur requis.");
      await enforceUserRateLimit(admin.uid, "admin-diagnostic-orders", 30, 60_000);

      const raw = Buffer.isBuffer(req.rawBody)
        ? req.rawBody
        : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body || {}), "utf8");
      if (raw.byteLength > MAX_BODY_BYTES) throw new ApiError(413, "request-too-large", "La demande est trop volumineuse.");
      let body;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new ApiError(400, "invalid-request", "La demande n’est pas valide.");
      }
      if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some((key) => !["action", "type", "cursor"].includes(key))) {
        throw new ApiError(400, "invalid-request", "La demande n’est pas valide.");
      }

      const action = cleanText(body.action, 20).toUpperCase();
      if (action !== "LIST") throw new ApiError(400, "invalid-action", "L’action demandée n’est pas valide.");
      const type = cleanText(body.type, 20) || "all";
      if (!["all", ...ORDER_KINDS].includes(type)) throw new ApiError(400, "invalid-order-type", "Le filtre de commandes n’est pas valide.");
      const cursor = body.cursor === undefined ? "" : cleanText(body.cursor, 200);
      if (body.cursor !== undefined && (!cursor || !/^[A-Za-z0-9_-]{10,200}$/.test(cursor))) {
        throw new ApiError(400, "invalid-order-cursor", "Le repère de pagination n’est pas valide.");
      }

      let query = db.collection("nexaOrders");
      if (type === "all") query = query.where("kind", "in", Array.from(ORDER_KINDS));
      else query = query.where("kind", "==", type);
      query = query.orderBy("createdAt", "desc");

      if (cursor) {
        const cursorSnapshot = await db.collection("nexaOrders").doc(cursor).get();
        if (!cursorSnapshot.exists || !ORDER_KINDS.has(String(cursorSnapshot.get("kind") || "")) ||
          !cursorSnapshot.get("createdAt") ||
          (type !== "all" && cursorSnapshot.get("kind") !== type)) {
          throw new ApiError(400, "invalid-order-cursor", "Le repère de pagination n’appartient pas à cette file.");
        }
        query = query.startAfter(cursorSnapshot);
      }

      const snapshot = await query.limit(PAGE_SIZE + 1).get();
      const hasMore = snapshot.docs.length > PAGE_SIZE;
      const page = snapshot.docs.slice(0, PAGE_SIZE);
      const orders = page.map((document) => {
        const data = document.data() || {};
        const amount = safeAmount(data.amount);
        const transactionFee = safeAmount(data.transactionFee);
        return {
          orderNumber: cleanText(data.orderNumber, 80) || "Référence indisponible",
          kind: cleanText(data.kind, 20),
          providerName: cleanText(data.providerName, 120) || "Partenaire NEXA",
          status: cleanText(data.status, 40) || "UNKNOWN",
          paymentStatus: cleanText(data.paymentStatus, 40) || "UNKNOWN",
          settlementStatus: cleanText(data.settlementStatus, 40) || "UNKNOWN",
          paymentMethod: cleanText(data.paymentMethod, 30) || "UNKNOWN",
          itemCount: Array.isArray(data.items) ? data.items.length : 0,
          amount,
          transactionFee,
          totalAmount: safeAmount(data.totalAmount) || amount + transactionFee,
          currency: "HTG",
          createdAt: safeDate(data.createdAt),
        };
      });

      await db.collection("adminAuditLogs").doc().create({
        actorUid: admin.uid,
        action: "admin_diagnostic_orders_listed",
        type,
        orderCount: orders.length,
        createdAt: FieldValue.serverTimestamp(),
      });
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({
        ok: true,
        orders,
        hasMore,
        nextCursor: hasMore && page.length ? page[page.length - 1].id : null,
      });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA diagnostic orders admin list failed", {
        errorName: error instanceof Error ? error.name : "unknown-error",
      });
      return fail(res, 500, "admin-diagnostic-orders-unavailable", "Les commandes diagnostic ne sont pas disponibles.");
    }
  });

  return { nexaAdminDiagnosticOrders };
};
