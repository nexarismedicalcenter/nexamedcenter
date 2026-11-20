import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { DEFAULT_TRANSACTION_FEE, TRANSACTION_FEE_SETTINGS_PATH } from "@/lib/payments/transaction-fees.server";

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request); headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "payment-settings-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les paramètres de frais ne sont pas accessibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA payment settings failed", error instanceof Error ? error.name : "unknown-error");
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
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-payment-settings-read", limit: 30, windowMs: 60_000 });
    const snapshot = await getFirebaseAdminDb().doc(TRANSACTION_FEE_SETTINGS_PATH).get();
    const raw = (snapshot.get("allServices") || snapshot.get("teleconsultation")) as Record<string, unknown> | undefined;
    const policy = raw && Number.isSafeInteger(Number(raw.rateBps)) && Number(raw.rateBps) >= 0 && Number(raw.rateBps) <= 10_000
      ? { active: raw.active === true, rateBps: Number(raw.rateBps) }
      : DEFAULT_TRANSACTION_FEE;
    const fee = { ...policy, percentage: policy.rateBps / 100, recipient: "NEXARIS" };
    return json(request, { ok: true, fees: { allServices: fee, teleconsultation: fee } });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-payment-settings-write", limit: 10, windowMs: 60_000 });
    const body = await request.json().catch(() => null);
    const rawEntry = body && typeof body === "object" && !Array.isArray(body) ? ((body as Record<string, unknown>).allServices || (body as Record<string, unknown>).teleconsultation) : null;
    const entry = rawEntry && typeof rawEntry === "object" && !Array.isArray(rawEntry)
      ? rawEntry as Record<string, unknown>
      : null;
    if (!entry || typeof entry.active !== "boolean") throw new ApiRequestError(400, "invalid-fee-policy", "Le statut des frais de transaction est requis.");
    const percentage = Number(entry.percentage);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100 || Math.round(percentage * 100) !== percentage * 100) {
      throw new ApiRequestError(400, "invalid-fee-rate", "Le taux doit être compris entre 0 et 100 %, avec au plus deux décimales.");
    }
    const rateBps = Math.round(percentage * 100);
    const db = getFirebaseAdminDb(); const now = FieldValue.serverTimestamp();
    await db.doc(TRANSACTION_FEE_SETTINGS_PATH).set({
      allServices: { active: entry.active, rateBps, updatedBy: admin.uid, updatedAt: now },
      teleconsultation: { active: entry.active, rateBps, updatedBy: admin.uid, updatedAt: now },
      updatedBy: admin.uid, updatedAt: now,
    }, { merge: true });
    await db.collection("adminAuditLogs").add({ actorUid: admin.uid, action: "all_service_transaction_fee_updated", rateBps, active: entry.active, feeRecipient: "NEXARIS", createdAt: now });
    const fee = { active: entry.active, rateBps, percentage, recipient: "NEXARIS" };
    return json(request, { ok: true, fees: { allServices: fee, teleconsultation: fee } });
  } catch (error) { return fail(request, error); }
}
