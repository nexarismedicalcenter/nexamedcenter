import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import {
  normalizeTeleconsultationSharePolicy,
  TELECONSULTATION_SHARE_SETTINGS_PATH,
} from "@/lib/payments/teleconsultation-share.server";

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "teleconsultation-share-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le partage des téléconsultations n’est pas accessible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA teleconsultation share settings failed", error instanceof Error ? error.name : "unknown-error");
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
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-teleconsultation-share-read", limit: 30, windowMs: 60_000 });
    const snapshot = await getFirebaseAdminDb().doc(TELECONSULTATION_SHARE_SETTINGS_PATH).get();
    const policy = normalizeTeleconsultationSharePolicy(snapshot.data());
    return json(request, {
      ok: true,
      share: policy ? {
        ...policy,
        doctorPercentage: policy.doctorRateBps / 100,
        nexarisPercentage: policy.nexarisRateBps / 100,
        basisConfirmed: false,
      } : null,
    });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-teleconsultation-share-write", limit: 10, windowMs: 60_000 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-share-policy", "Les deux taux du partage sont obligatoires.");
    const input = body as Record<string, unknown>;
    const hasDoctorPercentage = typeof input.doctorPercentage === "number" || (typeof input.doctorPercentage === "string" && input.doctorPercentage.trim() !== "");
    const hasNexarisPercentage = typeof input.nexarisPercentage === "number" || (typeof input.nexarisPercentage === "string" && input.nexarisPercentage.trim() !== "");
    const doctorPercentage = Number(input.doctorPercentage);
    const nexarisPercentage = Number(input.nexarisPercentage);
    const percentagesAreValid = hasDoctorPercentage && hasNexarisPercentage && [doctorPercentage, nexarisPercentage].every((value) =>
      Number.isFinite(value) && value >= 0 && value <= 100 && Math.round(value * 100) === value * 100,
    );
    const doctorRateBps = Math.round(doctorPercentage * 100);
    const nexarisRateBps = Math.round(nexarisPercentage * 100);
    if (!percentagesAreValid || doctorRateBps + nexarisRateBps !== 10_000) {
      throw new ApiRequestError(400, "invalid-share-rates", "Les taux doivent avoir au plus deux décimales et totaliser exactement 100 %.");
    }
    const policy = {
      doctorRateBps,
      nexarisRateBps,
    };
    const db = getFirebaseAdminDb();
    const now = FieldValue.serverTimestamp();
    await db.doc(TELECONSULTATION_SHARE_SETTINGS_PATH).set({ ...policy, updatedBy: admin.uid, updatedAt: now });
    await db.collection("adminAuditLogs").add({
      actorUid: admin.uid,
      action: "teleconsultation_share_policy_updated",
      doctorRateBps: policy.doctorRateBps,
      nexarisRateBps: policy.nexarisRateBps,
      createdAt: now,
    });
    return json(request, {
      ok: true,
      share: {
        ...policy,
        doctorPercentage,
        nexarisPercentage,
        basisConfirmed: false,
      },
    });
  } catch (error) { return fail(request, error); }
}
