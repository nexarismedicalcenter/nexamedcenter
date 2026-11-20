"use strict";

const { onRequest } = require("firebase-functions/v2/https");

const REGION = "us-east4";
const CATEGORIES = new Set(["commande", "examen", "resultat", "paiement", "remboursement", "decaissement", "compte", "technique"]);
const STATUSES = new Set(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]);

function cleanText(value, maximum) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

function requestBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  if (!Buffer.isBuffer(req.rawBody)) return null;
  try {
    const value = JSON.parse(req.rawBody.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function asIso(value) {
  if (value && typeof value.toDate === "function") return value.toDate().toISOString();
  return typeof value === "string" ? value : null;
}

function ticketSummary(id, data) {
  return {
    id,
    requesterUid: String(data.requesterUid || ""),
    category: CATEGORIES.has(data.category) ? data.category : "technique",
    subject: cleanText(data.subject, 180),
    description: cleanText(data.description, 3000),
    status: STATUSES.has(data.status) ? data.status : "OPEN",
    messageCount: Number.isSafeInteger(data.messageCount) && data.messageCount >= 0 ? data.messageCount : 0,
    createdAt: asIso(data.createdAt),
    updatedAt: asIso(data.updatedAt),
    lastReplyAt: asIso(data.lastReplyAt),
  };
}

function ticketMessages(snapshot) {
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    authorRole: doc.get("authorRole") === "admin" ? "admin" : "system",
    message: cleanText(doc.get("message"), 3000),
    createdAt: asIso(doc.get("createdAt")),
  }));
}

module.exports = function createNexaLabSupportFunctions(dependencies) {
  const { db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger, createNexaNotification } = dependencies;

  async function requireVerifiedLaboratory(uid) {
    const provider = await db.collection("providerProfiles").doc(uid).get();
    if (!provider.exists || provider.get("type") !== "laboratory" || provider.get("status") !== "verified") {
      throw new ApiError(403, "verified-laboratory-required", "Le support est réservé aux laboratoires NEXA vérifiés.");
    }
  }

  async function requireAdministrator(user) {
    const administrators = new Set(String(process.env.NEXA_ADMIN_UIDS || "").split(",").map((value) => value.trim()).filter(Boolean));
    if (!administrators.size) throw new ApiError(503, "admin-access-not-configured", "L’accès administrateur NEXA n’est pas configuré.");
    if (!administrators.has(user.uid)) throw new ApiError(403, "administrator-required", "Accès administrateur requis.");
  }

  const nexaLabSupportTickets = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) {
      res.set("Allow", "GET, POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if (req.method === "POST" && ((Number(req.get("Content-Length")) || 0) > 8_192 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 8_192))) {
      return fail(res, 413, "request-too-large", "La demande de support est trop volumineuse.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, req.method === "GET" ? "lab-support-list" : "lab-support-create", req.method === "GET" ? 30 : 5, req.method === "GET" ? 60_000 : 10 * 60_000);
      await requireVerifiedLaboratory(user.uid);
      res.set("Cache-Control", "no-store, max-age=0");

      if (req.method === "GET") {
        const ticketId = cleanText(req.query?.ticketId, 200);
        if (ticketId) {
          if (!/^[A-Za-z0-9_-]{10,200}$/.test(ticketId)) throw new ApiError(400, "invalid-support-ticket", "Le numéro du ticket n’est pas valide.");
          const ref = db.collection("labSupportTickets").doc(ticketId);
          const snapshot = await ref.get();
          if (!snapshot.exists || snapshot.get("requesterUid") !== user.uid || snapshot.get("providerType") !== "laboratory") {
            throw new ApiError(404, "support-ticket-not-found", "Ce ticket n’est pas disponible.");
          }
          const messages = await ref.collection("messages").orderBy("createdAt", "asc").limit(100).get();
          await db.collection("adminAuditLogs").doc().create({
            actorUid: user.uid, action: "lab_support_ticket_viewed", resource: `labSupportTickets/${ticketId}`, createdAt: FieldValue.serverTimestamp(),
          });
          return res.status(200).json({ ok: true, ticket: { ...ticketSummary(snapshot.id, snapshot.data() || {}), messages: ticketMessages(messages) } });
        }
        const snapshot = await db.collection("labSupportTickets").where("requesterUid", "==", user.uid).limit(100).get();
        const tickets = snapshot.docs.map((doc) => ticketSummary(doc.id, doc.data() || {}));
        tickets.sort((a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""));
        await db.collection("adminAuditLogs").doc().create({
          actorUid: user.uid, action: "lab_support_tickets_listed", resource: `providerProfiles/${user.uid}`, resultCount: tickets.length, createdAt: FieldValue.serverTimestamp(),
        });
        return res.status(200).json({ ok: true, tickets });
      }

      const body = requestBody(req);
      const category = cleanText(body?.category, 40).toLowerCase();
      const subject = cleanText(body?.subject, 180);
      const description = cleanText(body?.description, 3000);
      if (!CATEGORIES.has(category) || subject.length < 4 || description.length < 10) {
        throw new ApiError(400, "invalid-ticket", "Catégorie, sujet et description valides requis.");
      }
      const ticketRef = db.collection("labSupportTickets").doc();
      const auditRef = db.collection("adminAuditLogs").doc();
      await db.runTransaction(async (transaction) => {
        const now = FieldValue.serverTimestamp();
        transaction.create(ticketRef, {
          requesterUid: user.uid, providerType: "laboratory", category, subject, description,
          status: "OPEN", messageCount: 0, createdAt: now, updatedAt: now, lastReplyAt: null,
        });
        transaction.create(auditRef, {
          actorUid: user.uid, action: "lab_support_ticket_created", resource: `labSupportTickets/${ticketRef.id}`, category, createdAt: now,
        });
      });
      return res.status(201).json({ ok: true, ticketId: ticketRef.id, status: "OPEN" });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA lab support request failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "lab-support-unavailable", "Le support laboratoire n’est pas disponible pour le moment.");
    }
  });

  const nexaAdminLabSupport = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) {
      res.set("Allow", "GET, POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if (req.method === "POST" && ((Number(req.get("Content-Length")) || 0) > 8_192 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 8_192))) {
      return fail(res, 413, "request-too-large", "La réponse de support est trop volumineuse.");
    }

    try {
      const admin = await requireUser(req);
      await requireAppCheckToken(req);
      await requireAdministrator(admin);
      await enforceUserRateLimit(admin.uid, req.method === "GET" ? "admin-lab-support-read" : "admin-lab-support-write", req.method === "GET" ? 60 : 30, 60_000);
      res.set("Cache-Control", "no-store, max-age=0");

      if (req.method === "GET") {
        const ticketId = cleanText(req.query?.ticketId, 200);
        if (ticketId) {
          if (!/^[A-Za-z0-9_-]{10,200}$/.test(ticketId)) throw new ApiError(400, "invalid-support-ticket", "Le numéro du ticket n’est pas valide.");
          const ref = db.collection("labSupportTickets").doc(ticketId);
          const snapshot = await ref.get();
          if (!snapshot.exists || snapshot.get("providerType") !== "laboratory") throw new ApiError(404, "support-ticket-not-found", "Ce ticket n’est pas disponible.");
          const messages = await ref.collection("messages").orderBy("createdAt", "asc").limit(100).get();
          await db.collection("adminAuditLogs").doc().create({
            actorUid: admin.uid, action: "lab_support_ticket_admin_viewed", resource: `labSupportTickets/${ticketId}`, createdAt: FieldValue.serverTimestamp(),
          });
          return res.status(200).json({ ok: true, ticket: { ...ticketSummary(snapshot.id, snapshot.data() || {}), messages: ticketMessages(messages) } });
        }
        const snapshot = await db.collection("labSupportTickets").where("providerType", "==", "laboratory").limit(100).get();
        const tickets = snapshot.docs.map((doc) => ticketSummary(doc.id, doc.data() || {}));
        tickets.sort((a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""));
        await db.collection("adminAuditLogs").doc().create({
          actorUid: admin.uid, action: "lab_support_tickets_admin_listed", resultCount: tickets.length, createdAt: FieldValue.serverTimestamp(),
        });
        return res.status(200).json({ ok: true, tickets });
      }

      const body = requestBody(req);
      const ticketId = cleanText(body?.ticketId, 200);
      const action = cleanText(body?.action, 30).toUpperCase();
      const message = cleanText(body?.message, 3000);
      const status = body?.status;
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(ticketId) || !["REPLY", "SET_STATUS"].includes(action)) {
        throw new ApiError(400, "invalid-support-action", "Le ticket ou l’action de support n’est pas valide.");
      }
      if (action === "REPLY" && message.length < 2) throw new ApiError(400, "support-reply-required", "Une réponse d’au moins deux caractères est requise.");
      if (action === "SET_STATUS" && !STATUSES.has(status)) throw new ApiError(400, "invalid-support-status", "Le statut du ticket n’est pas valide.");

      const ticketRef = db.collection("labSupportTickets").doc(ticketId);
      const messageRef = ticketRef.collection("messages").doc();
      const auditRef = db.collection("adminAuditLogs").doc();
      const result = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ticketRef);
        if (!snapshot.exists || snapshot.get("providerType") !== "laboratory") throw new ApiError(404, "support-ticket-not-found", "Ce ticket n’est pas disponible.");
        const nextStatus = action === "REPLY" ? "IN_PROGRESS" : status;
        const now = FieldValue.serverTimestamp();
        if (action === "REPLY") {
          const messageCount = Number(snapshot.get("messageCount") || 0);
          if (!Number.isSafeInteger(messageCount) || messageCount >= 100) throw new ApiError(409, "support-reply-limit-reached", "La limite de réponses de ce ticket est atteinte.");
          transaction.create(messageRef, { authorUid: admin.uid, authorRole: "admin", message, createdAt: now });
          transaction.update(ticketRef, { status: nextStatus, messageCount: messageCount + 1, lastReplyAt: now, updatedAt: now });
        } else {
          transaction.update(ticketRef, { status: nextStatus, updatedAt: now });
        }
        transaction.create(auditRef, {
          actorUid: admin.uid, action: action === "REPLY" ? "lab_support_ticket_replied" : "lab_support_ticket_status_changed",
          resource: `labSupportTickets/${ticketId}`, status: nextStatus, createdAt: now,
        });
        return { requesterUid: String(snapshot.get("requesterUid") || ""), status: nextStatus };
      });

      if (result.requesterUid) {
        await createNexaNotification(result.requesterUid, `lab-support:${ticketId}:${auditRef.id}`, {
          type: "lab_support_update",
          title: action === "REPLY" ? "Réponse du support NEXA" : "Mise à jour de votre ticket",
          body: action === "REPLY" ? "Le support NEXA a répondu à votre demande." : `Le statut du ticket est maintenant ${result.status}.`,
          url: "/espace-centre.html#support",
        });
      }
      return res.status(200).json({ ok: true, ticketId, status: result.status });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA admin lab support request failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "admin-lab-support-unavailable", "La file de support n’est pas accessible.");
    }
  });

  return { nexaLabSupportTickets, nexaAdminLabSupport };
};
