import { NextResponse } from "next/server";
import { corsHeaders, ApiRequestError, requireNexaAdministrator } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

function response(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "admin-overview-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le tableau de bord ne peut pas être chargé.";
  if (!(error instanceof ApiRequestError)) {
    console.error("NEXA admin overview failed", error instanceof Error ? error.name : "unknown-error");
  }
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try {
    corsHeaders(request).forEach((value, key) => headers.set(key, value));
  } catch {
    // Requests from origins outside the allowlist receive no CORS permission.
  }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  } catch (error) {
    const status = error instanceof ApiRequestError ? error.status : 403;
    return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
  }
}

export async function GET(request: Request) {
  try {
    await requireNexaAdministrator(request);
    const db = getFirebaseAdminDb();
    const collections = ["patientProfiles", "providerProfiles", "professionalApplications", "appointments", "nexaOrders", "diagnosticOffers", "homeVisitRequests"];
    const [counts, openAlertCount] = await Promise.all([
      Promise.all(collections.map(async (name) => {
      const aggregate = await db.collection(name).count().get();
      return [name, aggregate.data().count] as const;
      })),
      db.collection("paymentSettlementAlerts").where("status", "in", ["open", "in_review"]).count().get(),
    ]);
    return response(request, { ok: true, counts: { ...Object.fromEntries(counts), paymentSettlementAlerts: openAlertCount.data().count } });
  } catch (error) {
    return failure(request, error);
  }
}
