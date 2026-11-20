import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import {
  recordTeleconsultationPresence,
  TeleconsultationPresenceError,
  type VideoPresenceAction,
} from "@/lib/teleconsultation/presence.server";

function response(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError || error instanceof TeleconsultationPresenceError
    ? error.status
    : 500;
  const code = error instanceof ApiRequestError || error instanceof TeleconsultationPresenceError
    ? error.code
    : "video-presence-unavailable";
  const message = error instanceof ApiRequestError || error instanceof TeleconsultationPresenceError
    ? error.message
    : "Le suivi de la séance est momentanément indisponible.";
  if (!(error instanceof ApiRequestError) && !(error instanceof TeleconsultationPresenceError)) {
    console.error("NEXA teleconsultation presence failed", error instanceof Error ? error.name : "unknown-error");
  }
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    const body = await request.json().catch(() => null);
    const appointmentId = body && typeof body === "object" && !Array.isArray(body) && typeof body.appointmentId === "string"
      ? body.appointmentId.trim().slice(0, 200)
      : "";
    const action = body && typeof body === "object" && !Array.isArray(body) ? body.action : null;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) {
      throw new TeleconsultationPresenceError(400, "appointment-required", "Un rendez-vous valide est requis.");
    }
    if (action !== "join" && action !== "heartbeat" && action !== "leave") {
      throw new TeleconsultationPresenceError(400, "invalid-presence-action", "L’action de présence n’est pas valide.");
    }

    const presence = await recordTeleconsultationPresence(
      getFirebaseAdminDb(),
      { appointmentId, uid: user.uid, action: action as VideoPresenceAction },
    );
    return response(request, {
      ok: !presence.expired,
      ...presence,
      ...(presence.expired ? {
        code: "video-quota-exhausted",
        error: "La durée vidéo incluse dans cette consultation est terminée.",
      } : {}),
    }, presence.expired ? 409 : 200);
  } catch (error) {
    return failure(request, error);
  }
}
