import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { createUserNotification } from "@/lib/notifications.server";
import { cleanLabSupportText, isLabSupportStatus, LAB_SUPPORT_CATEGORIES, type LabSupportTicket } from "@/lib/lab-support";

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "admin-lab-support-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "La file de support n’est pas accessible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA admin lab support failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function asIso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return (value.toDate() as Date).toISOString();
  }
  return typeof value === "string" ? value : null;
}

function ticketSummary(id: string, data: Record<string, unknown>): LabSupportTicket {
  return {
    id,
    requesterUid: String(data.requesterUid || ""),
    category: LAB_SUPPORT_CATEGORIES.includes(data.category as (typeof LAB_SUPPORT_CATEGORIES)[number]) ? data.category as LabSupportTicket["category"] : "technique",
    subject: cleanLabSupportText(data.subject, 180),
    description: cleanLabSupportText(data.description, 3000),
    status: isLabSupportStatus(data.status) ? data.status : "OPEN",
    messageCount: Number.isSafeInteger(data.messageCount) ? Number(data.messageCount) : 0,
    createdAt: asIso(data.createdAt),
    updatedAt: asIso(data.updatedAt),
    lastReplyAt: asIso(data.lastReplyAt),
  };
}

async function includeMessages(ticketRef: FirebaseFirestore.DocumentReference, ticket: LabSupportTicket) {
  const snapshot = await ticketRef.collection("messages").orderBy("createdAt", "asc").limit(100).get();
  return {
    ...ticket,
    messages: snapshot.docs.map((doc) => ({
      id: doc.id,
      authorRole: "admin" as const,
      message: cleanLabSupportText(doc.get("message"), 3000),
      createdAt: asIso(doc.get("createdAt")),
    })),
  };
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    await requireNexaAdministrator(request);
    const db = getFirebaseAdminDb();
    const ticketId = cleanLabSupportText(new URL(request.url).searchParams.get("ticketId"), 200);
    if (ticketId) {
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(ticketId)) throw new ApiRequestError(400, "invalid-support-ticket", "Le numéro du ticket n’est pas valide.");
      const ref = db.collection("labSupportTickets").doc(ticketId);
      const snapshot = await ref.get();
      if (!snapshot.exists || snapshot.get("providerType") !== "laboratory") throw new ApiRequestError(404, "support-ticket-not-found", "Ce ticket n’est pas disponible.");
      return json(request, { ok: true, ticket: await includeMessages(ref, ticketSummary(snapshot.id, snapshot.data() || {})) });
    }
    const snapshot = await db.collection("labSupportTickets").where("providerType", "==", "laboratory").limit(100).get();
    const tickets = snapshot.docs.map((doc) => ticketSummary(doc.id, doc.data()));
    tickets.sort((a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""));
    return json(request, { ok: true, tickets });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande est invalide.");
    const input = body as Record<string, unknown>;
    const ticketId = cleanLabSupportText(input.ticketId, 200);
    const action = cleanLabSupportText(input.action, 30).toUpperCase();
    const message = cleanLabSupportText(input.message, 3000);
    const status = input.status;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(ticketId) || !["REPLY", "SET_STATUS"].includes(action)) throw new ApiRequestError(400, "invalid-support-action", "Le ticket ou l’action de support n’est pas valide.");
    if (action === "REPLY" && message.length < 2) throw new ApiRequestError(400, "support-reply-required", "Une réponse d’au moins deux caractères est requise.");
    if (action === "SET_STATUS" && !isLabSupportStatus(status)) throw new ApiRequestError(400, "invalid-support-status", "Le statut du ticket n’est pas valide.");

    const db = getFirebaseAdminDb();
    const ticketRef = db.collection("labSupportTickets").doc(ticketId);
    const messageRef = ticketRef.collection("messages").doc();
    const auditRef = db.collection("adminAuditLogs").doc();
    const result = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ticketRef);
      if (!snapshot.exists || snapshot.get("providerType") !== "laboratory") throw new ApiRequestError(404, "support-ticket-not-found", "Ce ticket n’est pas disponible.");
      const nextStatus = action === "REPLY" ? "IN_PROGRESS" : status as LabSupportTicket["status"];
      if (action === "REPLY") {
        const messageCount = Number(snapshot.get("messageCount") || 0);
        if (messageCount >= 100) throw new ApiRequestError(409, "support-reply-limit-reached", "La limite de réponses de ce ticket est atteinte.");
        transaction.create(messageRef, { authorUid: admin.uid, authorRole: "admin", message, createdAt: FieldValue.serverTimestamp() });
        transaction.update(ticketRef, {
          status: nextStatus,
          messageCount: messageCount + 1,
          lastReplyAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        transaction.update(ticketRef, { status: nextStatus, updatedAt: FieldValue.serverTimestamp() });
      }
      transaction.create(auditRef, {
        actorUid: admin.uid,
        action: action === "REPLY" ? "lab_support_ticket_replied" : "lab_support_ticket_status_changed",
        resource: `labSupportTickets/${ticketId}`,
        status: nextStatus,
        createdAt: FieldValue.serverTimestamp(),
      });
      return { requesterUid: String(snapshot.get("requesterUid") || ""), status: nextStatus };
    });

    if (result.requesterUid) await createUserNotification({
      uid: result.requesterUid,
      eventKey: `lab-support:${ticketId}:${auditRef.id}`,
      type: "lab_support_update",
      title: action === "REPLY" ? "Réponse du support NEXA" : "Mise à jour de votre ticket",
      body: action === "REPLY" ? "Le support NEXA a répondu à votre demande." : `Le statut du ticket est maintenant ${result.status}.`,
      url: "/professionnels/espace#support",
    });
    return json(request, { ok: true, ticketId, status: result.status });
  } catch (error) { return fail(request, error); }
}
