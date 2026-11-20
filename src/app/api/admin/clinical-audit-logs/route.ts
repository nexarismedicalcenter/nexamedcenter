import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

const PAGE_SIZE = 40;

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "admin-clinical-audit-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le journal d’accès clinique n’est pas disponible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA clinical audit read failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* no CORS for disallowed origins */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function decodeCursor(value: string): { seconds: number; nanoseconds: number; id: string } | null {
  if (!value) return null;
  if (value.length > 512) throw new ApiRequestError(400, "invalid-clinical-audit-cursor", "Le repère de pagination n’est pas valide.");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (!Number.isSafeInteger(parsed.seconds) || !Number.isSafeInteger(parsed.nanoseconds) || Number(parsed.nanoseconds) < 0 || Number(parsed.nanoseconds) >= 1_000_000_000 || typeof parsed.id !== "string" || !parsed.id || parsed.id.includes("/") || parsed.id.length > 128) throw new Error("invalid cursor");
    return { seconds: Number(parsed.seconds), nanoseconds: Number(parsed.nanoseconds), id: parsed.id };
  } catch {
    throw new ApiRequestError(400, "invalid-clinical-audit-cursor", "Le repère de pagination n’est pas valide.");
  }
}

function encodeCursor(timestamp: Timestamp, id: string) {
  return Buffer.from(JSON.stringify({ seconds: timestamp.seconds, nanoseconds: timestamp.nanoseconds, id }), "utf8").toString("base64url");
}

function iso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).toISOString();
  return typeof value === "string" ? value : null;
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-clinical-audit-list", limit: 60, windowMs: 5 * 60_000 });
    const cursor = decodeCursor(new URL(request.url).searchParams.get("cursor") || "");
    const db = getFirebaseAdminDb();
    let query = db.collection("clinicalAuditLogs").orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc");
    if (cursor) query = query.startAfter(new Timestamp(cursor.seconds, cursor.nanoseconds), cursor.id);
    const snapshot = await query.limit(PAGE_SIZE + 1).get();
    const hasMore = snapshot.docs.length > PAGE_SIZE;
    const page = snapshot.docs.slice(0, PAGE_SIZE);
    const events = page.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        actorUid: typeof data.actorUid === "string" ? data.actorUid.slice(0, 128) : "",
        action: typeof data.action === "string" ? data.action.slice(0, 120) : "Action inconnue",
        appointmentId: typeof data.appointmentId === "string" ? data.appointmentId.slice(0, 200) : "",
        recordId: typeof data.recordId === "string" ? data.recordId.slice(0, 200) : "",
        prescriptionId: typeof data.prescriptionId === "string" ? data.prescriptionId.slice(0, 200) : "",
        orderId: typeof data.orderId === "string" ? data.orderId.slice(0, 200) : "",
        version: Number.isSafeInteger(data.version) ? Number(data.version) : null,
        createdAt: iso(data.createdAt),
      };
    });
    const auditRef = db.collection("adminAuditLogs").doc();
    await auditRef.create({
      actorUid: admin.uid,
      action: "admin_clinical_audit_listed",
      resultCount: page.length,
      createdAt: FieldValue.serverTimestamp(),
    });
    const last = page[page.length - 1];
    const lastTimestamp = last?.get("createdAt");
    return json(request, {
      ok: true,
      events,
      nextCursor: hasMore && last && lastTimestamp instanceof Timestamp ? encodeCursor(lastTimestamp, last.id) : null,
    });
  } catch (error) { return failure(request, error); }
}
