import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

const PAGE_SIZE = 30;
const ACCOUNT_TYPES = new Set(["patients", "providers"]);

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "admin-accounts-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les comptes NEXA ne sont pas disponibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA admin accounts failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* no CORS for disallowed origins */ }
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
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-account-list", limit: 60, windowMs: 5 * 60_000 });
    const url = new URL(request.url);
    const type = url.searchParams.get("type") || "patients";
    const cursor = url.searchParams.get("cursor") || "";
    if (!ACCOUNT_TYPES.has(type)) throw new ApiRequestError(400, "invalid-account-type", "Choisissez une catégorie de comptes valide.");
    if (cursor && (cursor.length > 128 || cursor.includes("/"))) {
      throw new ApiRequestError(400, "invalid-account-cursor", "Le repère de pagination n’est pas valide.");
    }

    const db = getFirebaseAdminDb();
    let query = db.collection(type === "patients" ? "patientProfiles" : "providerProfiles")
      .orderBy(FieldPath.documentId());
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.limit(PAGE_SIZE + 1).get();
    const hasMore = snapshot.docs.length > PAGE_SIZE;
    const page = snapshot.docs.slice(0, PAGE_SIZE);
    const accounts = page.map((doc) => {
      const data = doc.data();
      const profile = data.profile && typeof data.profile === "object" ? data.profile as Record<string, unknown> : {};
      if (type === "patients") {
        return {
          uid: doc.id,
          type: "patient",
          name: typeof data.displayName === "string" ? data.displayName.slice(0, 160) : "",
          email: typeof data.email === "string" ? data.email.slice(0, 254) : "",
          phone: typeof data.phone === "string" ? data.phone.slice(0, 30) : "",
          patientNumber: typeof data.patientNumber === "string" ? data.patientNumber.slice(0, 24) : "",
          profileComplete: data.profileComplete === true,
          createdAt: iso(data.createdAt),
        };
      }
      return {
        uid: doc.id,
        type: typeof data.type === "string" ? data.type.slice(0, 24) : "provider",
        name: typeof profile.name === "string" ? profile.name.slice(0, 160) : "",
        email: "",
        phone: typeof profile.publicPhone === "string" ? profile.publicPhone.slice(0, 30) : "",
        patientNumber: "",
        status: typeof data.status === "string" ? data.status.slice(0, 24) : "unknown",
        publiclyListed: data.publiclyListed === true,
        department: typeof profile.department === "string" ? profile.department.slice(0, 80) : "",
        commune: typeof profile.commune === "string" ? profile.commune.slice(0, 80) : "",
        specialty: typeof profile.specialty === "string" ? profile.specialty.slice(0, 100) : "",
        createdAt: iso(data.createdAt || data.verifiedAt),
      };
    });

    const auditRef = db.collection("adminAuditLogs").doc();
    await auditRef.create({
      actorUid: admin.uid,
      action: "admin_account_listed",
      accountType: type,
      resultCount: page.length,
      createdAt: FieldValue.serverTimestamp(),
    });
    return json(request, {
      ok: true,
      accounts,
      nextCursor: hasMore ? page[page.length - 1]?.id || null : null,
    });
  } catch (error) { return failure(request, error); }
}
