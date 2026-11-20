import { FieldPath, Timestamp, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

const PAGE_SIZE = 40;
const MAX_CURSOR_LENGTH = 2_048;
type Marker = { seconds: number; nanoseconds: number; id: string };
type Cursor = { uid: string; adminAudit: Marker | null; diagnosticResults: Marker | null; clinicalAudit: Marker | null };
type Activity = {
  id: string;
  action: string;
  resource: string;
  createdAt: string;
  source: "adminAudit" | "diagnosticResults" | "clinicalAudit";
  marker: Marker;
};

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "provider-activity-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "L’historique des activités n’est pas disponible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA provider activity history failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function parseMarker(value: unknown): Marker | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid marker");
  const marker = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(marker.seconds) ||
    !Number.isSafeInteger(marker.nanoseconds) ||
    Number(marker.nanoseconds) < 0 ||
    Number(marker.nanoseconds) >= 1_000_000_000 ||
    typeof marker.id !== "string" ||
    !/^[A-Za-z0-9_-]{1,150}$/.test(marker.id)
  ) throw new Error("invalid marker");
  return { seconds: Number(marker.seconds), nanoseconds: Number(marker.nanoseconds), id: marker.id };
}

function decodeCursor(value: string, uid: string): Cursor | null {
  if (!value) return null;
  if (value.length > MAX_CURSOR_LENGTH) throw new ApiRequestError(400, "invalid-provider-activity-cursor", "Le repère de pagination n’est pas valide.");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.version !== 1 || parsed.uid !== uid) throw new Error("cursor owner mismatch");
    return {
      uid,
      adminAudit: parseMarker(parsed.adminAudit),
      diagnosticResults: parseMarker(parsed.diagnosticResults),
      clinicalAudit: parseMarker(parsed.clinicalAudit),
    };
  } catch {
    throw new ApiRequestError(400, "invalid-provider-activity-cursor", "Le repère de pagination n’est pas valide.");
  }
}

function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify({ version: 1, ...cursor }), "utf8").toString("base64url");
}

function readActivity(
  snapshot: QueryDocumentSnapshot,
  source: Activity["source"],
): Activity | null {
  const data = snapshot.data();
  if (!(data.createdAt instanceof Timestamp) || typeof data.action !== "string") return null;
  if (source === "clinicalAudit" && data.action !== "diagnostic_prescription_viewed") return null;
  const rawResource = source !== "clinicalAudit" && typeof data.resource === "string"
    ? data.resource
    : source === "diagnosticResults" && typeof data.orderId === "string" && /^[A-Za-z0-9_-]{1,150}$/.test(data.orderId)
      ? `nexaOrders/${data.orderId}`
      : "";
  const resource = /^(nexaOrders|diagnosticOffers|labSupportTickets)\/[A-Za-z0-9_-]{1,150}$/.test(rawResource)
    ? rawResource.slice(0, 240)
    : "";
  return {
    id: `${source}:${snapshot.id}`,
    action: data.action.slice(0, 120),
    resource,
    createdAt: data.createdAt.toDate().toISOString(),
    source,
    marker: {
      seconds: data.createdAt.seconds,
      nanoseconds: data.createdAt.nanoseconds,
      id: snapshot.id,
    },
  };
}

async function readPage(
  collection: "adminAuditLogs" | "diagnosticResultAuditLogs",
  uid: string,
  marker: Marker | null,
  providerType: "laboratory" | "imaging",
) {
  const db = getFirebaseAdminDb();
  let query = db.collection(collection)
    .where("actorUid", "==", uid)
    .orderBy("createdAt", "desc")
    .orderBy(FieldPath.documentId(), "desc");
  if (collection === "diagnosticResultAuditLogs") query = db.collection(collection)
    .where("actorUid", "==", uid)
    .where("providerType", "==", providerType)
    .orderBy("createdAt", "desc")
    .orderBy(FieldPath.documentId(), "desc");
  if (marker) query = query.startAfter(new Timestamp(marker.seconds, marker.nanoseconds), marker.id);
  const snapshot = await query.limit(PAGE_SIZE + 1).get();
  const source: Activity["source"] = collection === "adminAuditLogs" ? "adminAudit" : "diagnosticResults";
  return snapshot.docs.map((doc) => readActivity(doc, source)).filter((item): item is Activity => item !== null);
}

async function readClinicalAuditPage(uid: string, marker: Marker | null, providerType: "laboratory" | "imaging") {
  let query = getFirebaseAdminDb().collection("clinicalAuditLogs")
    .where("actorUid", "==", uid)
    .where("providerType", "==", providerType)
    .orderBy("createdAt", "desc")
    .orderBy(FieldPath.documentId(), "desc");
  if (marker) query = query.startAfter(new Timestamp(marker.seconds, marker.nanoseconds), marker.id);
  const snapshot = await query.limit(PAGE_SIZE + 1).get();
  return snapshot.docs.map((doc) => readActivity(doc, "clinicalAudit")).filter((item): item is Activity => item !== null);
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "provider-activity-history", limit: 30, windowMs: 60_000 });
    const profile = await getFirebaseAdminDb().collection("providerProfiles").doc(user.uid).get();
    const type = profile.get("type");
    if (!profile.exists || !["laboratory", "imaging"].includes(String(type)) || profile.get("status") !== "verified" || profile.get("publiclyListed") !== true) {
      throw new ApiRequestError(403, "verified-diagnostic-provider-required", "L’historique est réservé aux laboratoires et centres d’imagerie NEXA vérifiés.");
    }

    const cursor = decodeCursor(new URL(request.url).searchParams.get("cursor") || "", user.uid);
    const providerType = type as "laboratory" | "imaging";
    const [adminEvents, resultEvents, clinicalEvents] = await Promise.all([
      readPage("adminAuditLogs", user.uid, cursor?.adminAudit || null, providerType),
      readPage("diagnosticResultAuditLogs", user.uid, cursor?.diagnosticResults || null, providerType),
      readClinicalAuditPage(user.uid, cursor?.clinicalAudit || null, providerType),
    ]);
    const events = [...adminEvents, ...resultEvents, ...clinicalEvents].sort((left, right) => {
      const secondsDifference = right.marker.seconds - left.marker.seconds;
      if (secondsDifference !== 0) return secondsDifference;
      const nanosecondsDifference = right.marker.nanoseconds - left.marker.nanoseconds;
      if (nanosecondsDifference !== 0) return nanosecondsDifference;
      if (left.source !== right.source) return left.source.localeCompare(right.source);
      return right.marker.id.localeCompare(left.marker.id);
    });
    const hasMore = events.length > PAGE_SIZE;
    const page = events.slice(0, PAGE_SIZE);
    const next: Cursor = {
      uid: user.uid,
      adminAudit: cursor?.adminAudit || null,
      diagnosticResults: cursor?.diagnosticResults || null,
      clinicalAudit: cursor?.clinicalAudit || null,
    };
    for (const event of page) {
      if (event.source === "adminAudit") next.adminAudit = event.marker;
      else if (event.source === "diagnosticResults") next.diagnosticResults = event.marker;
      else next.clinicalAudit = event.marker;
    }
    return json(request, {
      ok: true,
      events: page.map(({ id, action, resource, createdAt }) => ({ id, action, resource, createdAt })),
      hasMore,
      nextCursor: hasMore ? encodeCursor(next) : null,
    });
  } catch (error) { return failure(request, error); }
}
