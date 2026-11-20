import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { createPharmacyLot, expirePharmacyLots, getReservedStock, getSellableStock } from "@/lib/pharmacy/stock";

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "pharmacy-lot-receipt-failed";
  const message = error instanceof ApiRequestError ? error.message : "Le lot n’a pas pu être enregistré.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA pharmacy lot receipt failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "pharmacy-product-write", limit: 30, windowMs: 5 * 60_000 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande n’est pas valide.");
    const input = body as Record<string, unknown>;
    const productId = text(input.productId, 200);
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(productId)) throw new ApiRequestError(400, "invalid-product", "La référence du produit n’est pas valide.");

    let lot: ReturnType<typeof createPharmacyLot>;
    try {
      lot = createPharmacyLot({ lotNumber: input.lotNumber, expirationDate: input.expirationDate, quantityReceived: input.quantityReceived });
    } catch {
      throw new ApiRequestError(400, "invalid-pharmacy-lot", "Vérifiez le numéro de lot, sa date d’expiration et la quantité reçue.");
    }

    const db = getFirebaseAdminDb();
    const providerRef = db.collection("providerProfiles").doc(user.uid);
    const productRef = db.collection("pharmacyProducts").doc(productId);
    const auditRef = db.collection("adminAuditLogs").doc();
    const movementRef = db.collection("pharmacyStockMovements").doc();
    const result = await db.runTransaction(async (transaction) => {
      const [providerSnapshot, productSnapshot] = await Promise.all([transaction.get(providerRef), transaction.get(productRef)]);
      if (!providerSnapshot.exists || providerSnapshot.get("type") !== "pharmacy" || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true) {
        throw new ApiRequestError(403, "verified-pharmacy-required", "Cet espace est réservé aux pharmacies NEXA vérifiées et publiées.");
      }
      if (!productSnapshot.exists || productSnapshot.get("providerUid") !== user.uid) throw new ApiRequestError(404, "product-not-found", "Ce produit n’appartient pas à votre pharmacie.");
      const prior = productSnapshot.data() || {};
      const lots = expirePharmacyLots({ lots: Array.isArray(prior.lots) ? prior.lots as ReturnType<typeof createPharmacyLot>[] : [] }).lots;
      if (lots.length === 0 && Number(prior.reservedStock || 0) > 0) throw new ApiRequestError(409, "legacy-reservation-review-required", "Des commandes existantes ont des réservations sans lot. Faites rapprocher ces commandes avant de recevoir un lot.");
      const normalizedLotNumber = lot.lotNumber.toLocaleLowerCase("fr");
      if (lots.some((candidate) => String(candidate.lotNumber || "").trim().toLocaleLowerCase("fr") === normalizedLotNumber)) {
        throw new ApiRequestError(409, "duplicate-pharmacy-lot", "Ce numéro de lot existe déjà pour ce produit.");
      }
      lots.push(lot);
      const now = FieldValue.serverTimestamp();
      const stock = getSellableStock({ lots });
      const reservedStock = getReservedStock({ lots });
      transaction.set(productRef, {
        lots,
        stock,
        reservedStock,
        ...(lots.length === 1 && Number(prior.stock || 0) > 0 ? { legacyStockUnreconciled: Number(prior.stock || 0) } : {}),
        updatedAt: now,
      }, { merge: true });
      transaction.create(auditRef, {
        actorUid: user.uid,
        action: "pharmacy_product_lot_received",
        resource: `pharmacyProducts/${productId}`,
        metadata: { lotNumber: lot.lotNumber, expirationDate: lot.expirationDate, quantityReceived: lot.quantityReceived },
        createdAt: now,
      });
      transaction.create(movementRef, {
        productId,
        providerUid: user.uid,
        movementType: "RECEIPT",
        direction: "IN",
        quantity: lot.quantityReceived,
        lotAllocations: [{ lotNumber: lot.lotNumber, quantity: lot.quantityReceived }],
        actorUid: user.uid,
        reason: "LOT_RECEIVED",
        createdAt: now,
      });
      return { productId, stock, reservedStock, lot };
    });
    return json(request, { ok: true, ...result });
  } catch (error) { return fail(request, error); }
}
