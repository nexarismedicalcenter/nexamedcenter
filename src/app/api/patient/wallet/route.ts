import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "patient-wallet-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Votre portefeuille NEXA n’est pas accessible pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA patient wallet failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* no CORS for disallowed origins */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function iso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).toISOString();
  return null;
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "patient-wallet-read", limit: 60, windowMs: 60_000 });
    const db = getFirebaseAdminDb();
    const profile = await db.collection("patientProfiles").doc(user.uid).get();
    if (!profile.exists || profile.get("role") !== "patient" || profile.get("profileComplete") !== true) {
      throw new ApiRequestError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
    }
    const [wallet, ledger] = await Promise.all([
      db.collection("nexaPatientWallets").doc(user.uid).get(),
      db.collection("nexaWalletLedger").where("userUid", "==", user.uid).orderBy("createdAt", "desc").limit(25).get(),
    ]);
    const availableMinor = Number(wallet.get("availableMinor") || 0);
    const reservedMinor = Number(wallet.get("reservedMinor") || 0);
    if (!Number.isSafeInteger(availableMinor) || availableMinor < 0 || !Number.isSafeInteger(reservedMinor) || reservedMinor < 0) {
      throw new ApiRequestError(503, "wallet-state-invalid", "Le solde du portefeuille doit être vérifié par NEXA.");
    }
    const entries = ledger.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        type: data.type === "REFUND" ? "REFUND" : data.type === "APPOINTMENT_PAYMENT" ? "APPOINTMENT_PAYMENT" : typeof data.type === "string" && data.type.endsWith("_ORDER_PAYMENT") ? "ORDER_PAYMENT" : "OTHER",
        direction: data.direction === "DEBIT" ? "DEBIT" : "CREDIT",
        amount: Number.isSafeInteger(data.amountMinor) && Number(data.amountMinor) >= 0 ? Number(data.amountMinor) / 100 : 0,
        currency: "HTG",
        status: typeof data.status === "string" ? data.status.slice(0, 24) : "UNKNOWN",
        createdAt: iso(data.createdAt),
      };
    });
    return json(request, {
      ok: true,
      wallet: {
        currency: "HTG",
        available: availableMinor / 100,
        reserved: reservedMinor / 100,
        status: wallet.exists && wallet.get("status") === "SUSPENDED" ? "SUSPENDED" : "ACTIVE",
      },
      entries,
    });
  } catch (error) { return fail(request, error); }
}
