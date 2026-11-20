import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

const PAGE_SIZE = 50;

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "admin-pharmacy-stock-movements-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le journal de stock pharmacie n’est pas accessible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA admin pharmacy stock movements failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function timestamp(value: unknown): string | null {
  if (!value || typeof value !== "object" || !("toDate" in value) || typeof value.toDate !== "function") return null;
  const date = (value.toDate as () => Date)();
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    const cursorId = new URL(request.url).searchParams.get("cursor")?.trim() || "";
    if (cursorId && !/^[A-Za-z0-9_-]{10,200}$/.test(cursorId)) throw new ApiRequestError(400, "invalid-cursor", "Le curseur du journal n’est pas valide.");

    const db = getFirebaseAdminDb();
    let query = db.collection("pharmacyStockMovements").orderBy("createdAt", "desc").limit(PAGE_SIZE + 1);
    if (cursorId) {
      const cursor = await db.collection("pharmacyStockMovements").doc(cursorId).get();
      if (!cursor.exists) throw new ApiRequestError(400, "invalid-cursor", "La page demandée n’est plus disponible.");
      query = query.startAfter(cursor);
    }
    const snapshot = await query.get();
    const hasMore = snapshot.docs.length > PAGE_SIZE;
    const page = snapshot.docs.slice(0, PAGE_SIZE);
    const movements = page.map((doc) => {
      const data = doc.data();
      const rawAllocations = Array.isArray(data.lotAllocations) ? data.lotAllocations : [];
      return {
        id: doc.id,
        productId: typeof data.productId === "string" ? data.productId : "",
        providerUid: typeof data.providerUid === "string" ? data.providerUid : "",
        orderId: typeof data.orderId === "string" ? data.orderId : "",
        movementType: typeof data.movementType === "string" ? data.movementType : "UNKNOWN",
        direction: typeof data.direction === "string" ? data.direction : "UNKNOWN",
        quantity: Number.isSafeInteger(data.quantity) && Number(data.quantity) >= 0 ? Number(data.quantity) : 0,
        lotAllocations: rawAllocations.slice(0, 100).flatMap((raw) => {
          if (!raw || typeof raw !== "object") return [];
          const lot = raw as Record<string, unknown>;
          if (typeof lot.lotNumber !== "string" || !Number.isSafeInteger(lot.quantity) || Number(lot.quantity) < 0) return [];
          return [{ lotNumber: lot.lotNumber.slice(0, 80), quantity: Number(lot.quantity) }];
        }),
        actorUid: typeof data.actorUid === "string" ? data.actorUid : "",
        reason: typeof data.reason === "string" ? data.reason : "",
        createdAt: timestamp(data.createdAt),
      };
    });
    const auditRef = db.collection("adminAuditLogs").doc();
    await auditRef.create({
      actorUid: admin.uid,
      action: "admin_pharmacy_stock_movements_viewed",
      resource: "pharmacyStockMovements",
      metadata: { count: movements.length },
      createdAt: FieldValue.serverTimestamp(),
    });
    return json(request, { ok: true, movements, nextCursor: hasMore ? page.at(-1)?.id || null : null });
  } catch (error) { return fail(request, error); }
}
