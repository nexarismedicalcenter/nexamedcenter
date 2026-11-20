import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

function json(request: Request, body: Record<string, unknown>) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "notifications-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les notifications ne sont pas accessibles pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA notifications request failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
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
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    const snapshot = await getFirebaseAdminDb().collection("userNotifications")
      .where("uid", "==", user.uid)
      .orderBy("createdAt", "desc")
      .limit(60)
      .get();
    const notifications = snapshot.docs.map((doc) => {
      const item = doc.data();
      return {
        id: doc.id,
        type: typeof item.type === "string" ? item.type : "information",
        title: typeof item.title === "string" ? item.title : "Notification NEXA",
        body: typeof item.body === "string" ? item.body : "",
        url: typeof item.url === "string" && item.url.startsWith("/") && !item.url.startsWith("//") ? item.url : "/espace",
        read: item.read === true,
        createdAt: iso(item.createdAt),
      };
    });
    return json(request, { ok: true, notifications });
  } catch (error) { return failure(request, error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    const body = await request.json().catch(() => null);
    const id = body && typeof body === "object" && !Array.isArray(body) && typeof body.id === "string" ? body.id.trim() : "";
    if (!/^[a-f0-9]{64}$/.test(id)) throw new ApiRequestError(400, "invalid-notification", "La notification n’est pas valide.");
    const ref = getFirebaseAdminDb().collection("userNotifications").doc(id);
    await getFirebaseAdminDb().runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.get("uid") !== user.uid) throw new ApiRequestError(404, "notification-not-found", "La notification n’est pas accessible.");
      if (snapshot.get("read") !== true) transaction.update(ref, { read: true, readAt: FieldValue.serverTimestamp() });
    });
    return json(request, { ok: true, id, read: true });
  } catch (error) { return failure(request, error); }
}
