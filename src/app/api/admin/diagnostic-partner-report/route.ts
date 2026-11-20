import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

const RESULT_STATUSES = [
  "RESULT_PENDING_REVIEW",
  "CORRECTION_REQUESTED",
  "VALIDATED",
  "RESULT_AVAILABLE",
  "NOT_PERFORMED",
] as const;

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "admin-diagnostic-partner-report-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le rapport partenaire n’est pas disponible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA admin diagnostic partner report failed", error instanceof Error ? error.name : "unknown-error");
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
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-diagnostic-partner-report", limit: 30, windowMs: 60_000 });
    const providerUid = new URL(request.url).searchParams.get("providerUid")?.trim() || "";
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(providerUid)) throw new ApiRequestError(400, "invalid-diagnostic-provider", "Sélectionnez un partenaire NEXA valide.");

    const db = getFirebaseAdminDb();
    const providerSnapshot = await db.collection("providerProfiles").doc(providerUid).get();
    const type = providerSnapshot.get("type");
    if (!providerSnapshot.exists || !["laboratory", "imaging"].includes(String(type))) {
      throw new ApiRequestError(404, "diagnostic-provider-not-found", "Ce laboratoire ou centre d’imagerie NEXA est introuvable.");
    }

    const resultCounts = await Promise.all(RESULT_STATUSES.map(async (status) => {
      const count = await db.collection("diagnosticResults")
        .where("providerUid", "==", providerUid)
        .where("providerType", "==", type)
        .where("status", "==", status)
        .count()
        .get();
      return [status, count.data().count] as const;
    }));
    const assignedOrders = await db.collection("nexaOrders")
      .where("providerUid", "==", providerUid)
      .where("kind", "==", type)
      .count()
      .get();
    const counts = Object.fromEntries(resultCounts) as Record<(typeof RESULT_STATUSES)[number], number>;
    const profile = providerSnapshot.get("profile") as Record<string, unknown> | undefined;
    const report = {
      providerUid,
      providerName: typeof profile?.name === "string" ? profile.name.slice(0, 160) : "Partenaire NEXA",
      providerType: type,
      providerStatus: typeof providerSnapshot.get("status") === "string" ? providerSnapshot.get("status") : "unknown",
      ordersAssigned: assignedOrders.data().count,
      resultsPendingReview: counts.RESULT_PENDING_REVIEW,
      correctionsPending: counts.CORRECTION_REQUESTED,
      examsValidated: counts.VALIDATED,
      resultsAvailable: counts.RESULT_AVAILABLE,
      examsPerformed: counts.VALIDATED + counts.RESULT_AVAILABLE,
      examsNotPerformed: counts.NOT_PERFORMED,
    };

    await db.collection("adminAuditLogs").doc().create({
      actorUid: admin.uid,
      action: "diagnostic_partner_report_viewed",
      resource: `providerProfiles/${providerUid}`,
      providerType: type,
      ordersAssigned: report.ordersAssigned,
      resultsPendingReview: report.resultsPendingReview,
      correctionsPending: report.correctionsPending,
      createdAt: FieldValue.serverTimestamp(),
    });
    return json(request, { ok: true, report });
  } catch (error) { return failure(request, error); }
}
