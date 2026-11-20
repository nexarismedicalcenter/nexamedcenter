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
  const code = error instanceof ApiRequestError ? error.code : "notification-preferences-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les préférences de notification ne sont pas disponibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA notification preferences failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    const snapshot = await getFirebaseAdminDb().collection("userNotificationPreferences").doc(user.uid).get();
    const from = process.env.NEXA_EMAIL_FROM?.trim() || "";
    const sender = from.match(/<([^<>]+)>/)?.[1] || from;
    return json(request, {
      ok: true,
      preferences: {
        emailEnabled: snapshot.get("emailEnabled") === true,
        pushEnabled: snapshot.get("pushEnabled") === true,
      },
      emailAvailable: Boolean(process.env.RESEND_API_KEY && /^[^<>\s@]+@nexarishaiti\.com$/i.test(sender)),
      pushAvailable: Boolean(process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY),
    });
  } catch (error) { return failure(request, error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "notification-preferences", limit: 15, windowMs: 60_000 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-notification-preferences", "Les préférences envoyées ne sont pas valides.");
    const input = body as Record<string, unknown>;
    const patch: Record<string, boolean> = {};
    if (typeof input.emailEnabled === "boolean") patch.emailEnabled = input.emailEnabled;
    if (typeof input.pushEnabled === "boolean") patch.pushEnabled = input.pushEnabled;
    if (!Object.keys(patch).length) throw new ApiRequestError(400, "invalid-notification-preferences", "Choisissez une préférence à mettre à jour.");

    const db = getFirebaseAdminDb();
    const preferencesRef = db.collection("userNotificationPreferences").doc(user.uid);
    const registrationsQuery = db.collection("notificationPushRegistrations").where("uid", "==", user.uid).limit(100);
    await db.runTransaction(async (transaction) => {
      const current = await transaction.get(preferencesRef);
      let registrations = null;
      if (patch.pushEnabled === true || patch.pushEnabled === false) registrations = await transaction.get(registrationsQuery);
      if (patch.pushEnabled === true && registrations?.empty) throw new ApiRequestError(409, "push-registration-required", "Activez d’abord les notifications push sur cet appareil.");
      if (patch.pushEnabled === false && registrations) registrations.docs.forEach((registration) => transaction.delete(registration.ref));
      transaction.set(preferencesRef, {
        emailEnabled: patch.emailEnabled ?? current.get("emailEnabled") === true,
        pushEnabled: patch.pushEnabled ?? current.get("pushEnabled") === true,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    return json(request, { ok: true, preferences: { emailEnabled: patch.emailEnabled, pushEnabled: patch.pushEnabled } });
  } catch (error) { return failure(request, error); }
}
