import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { createUserNotification } from "@/lib/notifications.server";

const PAGE_SIZE = 30;
const VALID_STATUSES = new Set(["PENDING_REVIEW", "CONTACTED", "CONFIRMED", "UNAVAILABLE"]);

function decodeCursor(value: string): { seconds: number; nanoseconds: number; id: string } | null {
  if (!value) return null;
  if (value.length > 512) throw new ApiRequestError(400, "invalid-home-visit-cursor", "Le repère de pagination n’est pas valide.");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (!Number.isSafeInteger(parsed.seconds) || !Number.isSafeInteger(parsed.nanoseconds) || Number(parsed.nanoseconds) < 0 || Number(parsed.nanoseconds) >= 1_000_000_000 || typeof parsed.id !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(parsed.id)) throw new Error("invalid cursor");
    return { seconds: Number(parsed.seconds), nanoseconds: Number(parsed.nanoseconds), id: parsed.id };
  } catch {
    throw new ApiRequestError(400, "invalid-home-visit-cursor", "Le repère de pagination n’est pas valide.");
  }
}

function encodeCursor(timestamp: Timestamp, id: string) {
  return Buffer.from(JSON.stringify({ seconds: timestamp.seconds, nanoseconds: timestamp.nanoseconds, id }), "utf8").toString("base64url");
}

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request); headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "admin-home-visit-requests-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "La file des visites à domicile n’est pas disponible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA admin home visit requests failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function iso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).toISOString();
  return typeof value === "string" ? value : null;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > 4_096) throw new ApiRequestError(413, "request-too-large", "La demande dépasse la taille autorisée.");
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > 4_096) throw new ApiRequestError(413, "request-too-large", "La demande dépasse la taille autorisée.");
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new ApiRequestError(400, "invalid-request", "La demande est invalide."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande est invalide.");
  return body as Record<string, unknown>;
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-home-visit-list", limit: 60, windowMs: 5 * 60_000 });
    const cursor = decodeCursor(new URL(request.url).searchParams.get("cursor") || "");
    const db = getFirebaseAdminDb();
    let query = db.collection("homeVisitRequests").orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc");
    if (cursor) query = query.startAfter(new Timestamp(cursor.seconds, cursor.nanoseconds), cursor.id);
    const snapshot = await query.limit(PAGE_SIZE + 1).get();
    const hasMore = snapshot.docs.length > PAGE_SIZE;
    const page = snapshot.docs.slice(0, PAGE_SIZE);
    const requests = page.map((document) => {
      const item = document.data();
      return {
        requestId: document.id,
        patientNumber: typeof item.patientNumber === "string" ? item.patientNumber.slice(0, 11) : "",
        patientName: typeof item.patientName === "string" ? item.patientName.slice(0, 160) : "",
        contactPhone: typeof item.contactPhone === "string" ? item.contactPhone.slice(0, 24) : "",
        department: typeof item.department === "string" ? item.department.slice(0, 100) : "",
        commune: typeof item.commune === "string" ? item.commune.slice(0, 100) : "",
        addressLine: typeof item.addressLine === "string" ? item.addressLine.slice(0, 220) : "",
        preferredDate: typeof item.preferredDate === "string" ? item.preferredDate.slice(0, 10) : "",
        status: typeof item.status === "string" && VALID_STATUSES.has(item.status) ? item.status : "UNKNOWN",
        createdAt: iso(item.createdAt),
        updatedAt: iso(item.updatedAt),
      };
    });
    await db.collection("adminAuditLogs").add({
      actorUid: admin.uid,
      action: "admin_home_visit_requests_listed",
      resultCount: page.length,
      createdAt: FieldValue.serverTimestamp(),
    });
    const last = page[page.length - 1];
    const lastCreatedAt = last?.get("createdAt");
    return json(request, {
      ok: true,
      requests,
      nextCursor: hasMore && last && lastCreatedAt instanceof Timestamp ? encodeCursor(lastCreatedAt, last.id) : null,
    });
  } catch (error) { return failure(request, error); }
}

export async function POST(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-home-visit-update", limit: 60, windowMs: 5 * 60_000 });
    const body = await readBody(request);
    if (Object.keys(body).some((key) => !["requestId", "status"].includes(key))) throw new ApiRequestError(400, "unexpected-request-field", "La mise à jour contient un champ non pris en charge.");
    const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
    const status = typeof body.status === "string" ? body.status : "";
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(requestId) || !["CONTACTED", "CONFIRMED", "UNAVAILABLE"].includes(status)) {
      throw new ApiRequestError(400, "invalid-home-visit-update", "La demande ou son nouveau statut n’est pas valide.");
    }

    const db = getFirebaseAdminDb();
    const requestRef = db.collection("homeVisitRequests").doc(requestId);
    const auditRef = db.collection("adminAuditLogs").doc();
    const result = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(requestRef);
      if (!snapshot.exists) throw new ApiRequestError(404, "home-visit-request-not-found", "Cette demande n’existe pas.");
      const currentStatus = String(snapshot.get("status") || "UNKNOWN");
      const patientUid = typeof snapshot.get("patientUid") === "string" ? String(snapshot.get("patientUid")) : "";
      if (!patientUid) throw new ApiRequestError(409, "home-visit-patient-unavailable", "Le profil patient lié à cette demande n’est pas disponible.");
      if (currentStatus === status) return { status, alreadyInStatus: true, patientUid };
      const allowed = currentStatus === "PENDING_REVIEW"
        ? new Set(["CONTACTED", "CONFIRMED", "UNAVAILABLE"])
        : currentStatus === "CONTACTED"
          ? new Set(["CONFIRMED", "UNAVAILABLE"])
          : new Set<string>();
      if (!allowed.has(status)) throw new ApiRequestError(409, "home-visit-status-conflict", "Cette demande a déjà été clôturée ou son statut vient de changer.");
      const now = FieldValue.serverTimestamp();
      transaction.update(requestRef, {
        status,
        updatedAt: now,
        lastReviewedBy: admin.uid,
        ...(status === "CONFIRMED" ? { confirmedAt: now } : {}),
        ...(status === "UNAVAILABLE" ? { closedAt: now } : {}),
      });
      transaction.create(auditRef, {
        actorUid: admin.uid,
        action: `home_visit_request_${status.toLowerCase()}`,
        resource: `homeVisitRequests/${requestId}`,
        previousStatus: currentStatus,
        status,
        createdAt: now,
      });
      return { status, alreadyInStatus: false, patientUid };
    });
    if (!result.alreadyInStatus) await createUserNotification({
      uid: result.patientUid,
      eventKey: `home-visit:${requestId}:${status}`,
      type: "home_visit_request_status",
      title: "Mise à jour de votre demande de visite",
      body: "NEXA a mis à jour votre demande de visite à domicile. Connectez-vous pour consulter son statut.",
      url: "/care",
    });
    return json(request, { ok: true, requestId, status: result.status, alreadyInStatus: result.alreadyInStatus });
  } catch (error) { return failure(request, error); }
}
