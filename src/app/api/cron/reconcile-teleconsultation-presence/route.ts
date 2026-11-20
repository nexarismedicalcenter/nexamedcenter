import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { reconcileStaleTeleconsultationPresence } from "@/lib/teleconsultation/presence.server";
import { reconcileExpiredTeleconsultationCalls } from "@/lib/teleconsultation/missed-calls.server";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET || "";
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!secret || token.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(secret));
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Le rapprochement de présence n’est pas configuré." }, { status: 503 });
  }
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Accès refusé." }, { status: 401 });
  }
  try {
    const db = getFirebaseAdminDb();
    const [presence, callAttempts] = await Promise.all([
      reconcileStaleTeleconsultationPresence(db),
      reconcileExpiredTeleconsultationCalls(db),
    ]);
    return NextResponse.json({ ok: true, presence, callAttempts }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    console.error("NEXA teleconsultation presence reconciliation failed", error instanceof Error ? error.name : "unknown-error");
    return NextResponse.json({ ok: false, error: "Les présences de téléconsultation n’ont pas pu être rapprochées." }, { status: 500, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
