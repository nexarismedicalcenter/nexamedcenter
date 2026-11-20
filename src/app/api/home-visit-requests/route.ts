import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "home-visit-request-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les demandes de visite à domicile ne sont pas disponibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA home visit requests failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function iso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return (value.toDate() as Date).toISOString();
  }
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
    const db = getFirebaseAdminDb();
    const snapshot = await db.collection("homeVisitRequests")
      .where("patientUid", "==", user.uid)
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();
    const requests = snapshot.docs.map((document) => {
      const item = document.data();
      return {
        requestId: document.id,
        status: typeof item.status === "string" ? item.status : "UNKNOWN",
        department: typeof item.department === "string" ? item.department : "",
        commune: typeof item.commune === "string" ? item.commune : "",
        addressLine: typeof item.addressLine === "string" ? item.addressLine : "",
        preferredDate: typeof item.preferredDate === "string" ? item.preferredDate : "",
        createdAt: iso(item.createdAt),
        updatedAt: iso(item.updatedAt),
      };
    });
    return json(request, { ok: true, requests });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    await requireFirebaseUser(request);
    await requireAppCheck(request);
    throw new ApiRequestError(410, "home-visit-flow-replaced", "Les nouvelles visites se réservent en choisissant un médecin, un créneau et un moyen de paiement dans Nexa - Care.");
  } catch (error) { return fail(request, error); }
}
