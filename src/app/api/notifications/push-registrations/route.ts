import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "push-registration-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les notifications push ne sont pas disponibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA push registration failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function registrationId(fid: string) {
  return createHash("sha256").update(fid).digest("hex");
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "push-registration-add", limit: 12, windowMs: 60 * 60_000 });
    const body = await request.json().catch(() => null);
    const fid = body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).fid === "string"
      ? ((body as Record<string, unknown>).fid as string).trim()
      : "";
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(fid)) throw new ApiRequestError(400, "invalid-push-registration", "L’inscription de notification du navigateur n’est pas valide.");
    const db = getFirebaseAdminDb();
    const ref = db.collection("notificationPushRegistrations").doc(registrationId(fid));
    await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists && existing.get("uid") !== user.uid) throw new ApiRequestError(409, "push-registration-owner-conflict", "Cette inscription push appartient déjà à un autre compte.");
      transaction.set(ref, {
        uid: user.uid,
        fid,
        platform: "web",
        createdAt: existing.get("createdAt") || FieldValue.serverTimestamp(),
        lastSeenAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    return json(request, { ok: true, registered: true });
  } catch (error) { return failure(request, error); }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "push-registration-remove", limit: 12, windowMs: 60 * 60_000 });
    const body = await request.json().catch(() => null);
    const fid = body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).fid === "string"
      ? ((body as Record<string, unknown>).fid as string).trim()
      : "";
    const db = getFirebaseAdminDb();
    let removed = 0;
    if (fid) {
      if (!/^[A-Za-z0-9_-]{16,256}$/.test(fid)) throw new ApiRequestError(400, "invalid-push-registration", "L’inscription push n’est pas valide.");
      const ref = db.collection("notificationPushRegistrations").doc(registrationId(fid));
      await db.runTransaction(async (transaction) => {
        const existing = await transaction.get(ref);
        if (existing.exists && existing.get("uid") === user.uid) {
          transaction.delete(ref);
          removed = 1;
        }
      });
    } else {
      const registrationsQuery = db.collection("notificationPushRegistrations").where("uid", "==", user.uid).limit(100);
      await db.runTransaction(async (transaction) => {
        const registrations = await transaction.get(registrationsQuery);
        registrations.docs.forEach((registration) => transaction.delete(registration.ref));
        removed = registrations.size;
      });
    }
    return json(request, { ok: true, removed });
  } catch (error) { return failure(request, error); }
}
