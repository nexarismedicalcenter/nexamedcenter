import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { cleanLabSupportText, LAB_SUPPORT_CATEGORIES, type LabSupportTicket } from "@/lib/lab-support";

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "lab-support-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le support laboratoire n’est pas disponible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA lab support failed", error instanceof Error ? error.name : "unknown-error");
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
    status: data.status === "IN_PROGRESS" || data.status === "RESOLVED" || data.status === "CLOSED" ? data.status : "OPEN",
    messageCount: Number.isSafeInteger(data.messageCount) ? Number(data.messageCount) : 0,
    createdAt: asIso(data.createdAt),
    updatedAt: asIso(data.updatedAt),
    lastReplyAt: asIso(data.lastReplyAt),
  };
}

async function requireVerifiedLaboratory(uid: string) {
  const snapshot = await getFirebaseAdminDb().collection("providerProfiles").doc(uid).get();
  if (!snapshot.exists || snapshot.get("type") !== "laboratory" || snapshot.get("status") !== "verified") {
    throw new ApiRequestError(403, "verified-laboratory-required", "Le support est réservé aux laboratoires NEXA vérifiés.");
  }
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "lab-support-list", limit: 30, windowMs: 60_000 });
    await requireVerifiedLaboratory(user.uid);
    const db = getFirebaseAdminDb();
    const ticketId = cleanLabSupportText(new URL(request.url).searchParams.get("ticketId"), 200);
    if (ticketId) {
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(ticketId)) throw new ApiRequestError(400, "invalid-support-ticket", "Le numéro du ticket n’est pas valide.");
      const ref = db.collection("labSupportTickets").doc(ticketId);
      const snapshot = await ref.get();
      if (!snapshot.exists || snapshot.get("requesterUid") !== user.uid || snapshot.get("providerType") !== "laboratory") throw new ApiRequestError(404, "support-ticket-not-found", "Ce ticket n’est pas disponible.");
      const messages = await ref.collection("messages").orderBy("createdAt", "asc").limit(100).get();
      await db.collection("adminAuditLogs").doc().set({
        actorUid: user.uid,
        action: "lab_support_ticket_viewed",
        resource: `labSupportTickets/${ticketId}`,
        createdAt: FieldValue.serverTimestamp(),
      });
      return json(request, {
        ok: true,
        ticket: {
          ...ticketSummary(snapshot.id, snapshot.data() || {}),
          messages: messages.docs.map((doc) => ({
            id: doc.id,
            authorRole: "admin" as const,
            message: cleanLabSupportText(doc.get("message"), 3000),
            createdAt: asIso(doc.get("createdAt")),
          })),
        },
      });
    }
    const snapshot = await db.collection("labSupportTickets").where("requesterUid", "==", user.uid).limit(100).get();
    const tickets = snapshot.docs.map((doc) => ticketSummary(doc.id, doc.data()));
    tickets.sort((a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""));
    await db.collection("adminAuditLogs").doc().set({
      actorUid: user.uid,
      action: "lab_support_tickets_listed",
      resource: `providerProfiles/${user.uid}`,
      resultCount: tickets.length,
      createdAt: FieldValue.serverTimestamp(),
    });
    return json(request, { ok: true, tickets });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "lab-support-create", limit: 5, windowMs: 10 * 60_000 });
    await requireVerifiedLaboratory(user.uid);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande est invalide.");
    const input = body as Record<string, unknown>;
    const category = cleanLabSupportText(input.category, 40).toLowerCase();
    const subject = cleanLabSupportText(input.subject, 180);
    const description = cleanLabSupportText(input.description, 3000);
    if (!LAB_SUPPORT_CATEGORIES.includes(category as LabSupportTicket["category"]) || subject.length < 4 || description.length < 10) {
      throw new ApiRequestError(400, "invalid-ticket", "Catégorie, sujet et description valides requis.");
    }
    const db = getFirebaseAdminDb();
    const ticketRef = db.collection("labSupportTickets").doc();
    const auditRef = db.collection("adminAuditLogs").doc();
    await db.runTransaction(async (transaction) => {
      const now = FieldValue.serverTimestamp();
      transaction.create(ticketRef, {
        requesterUid: user.uid,
        providerType: "laboratory",
        category,
        subject,
        description,
        status: "OPEN",
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
        lastReplyAt: null,
      });
      transaction.create(auditRef, {
        actorUid: user.uid,
        action: "lab_support_ticket_created",
        resource: `labSupportTickets/${ticketRef.id}`,
        category,
        createdAt: now,
      });
    });
    return json(request, { ok: true, ticketId: ticketRef.id, status: "OPEN" }, 201);
  } catch (error) { return fail(request, error); }
}
