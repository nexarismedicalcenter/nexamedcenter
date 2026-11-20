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
  const code = error instanceof ApiRequestError ? error.code : "pharmacy-products-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les produits de la pharmacie ne sont pas accessibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA provider pharmacy products failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

type DeliveryZone = { department: string; commune: string; feeHTG: number; etaLabel: string; active: boolean };

function deliveryConfiguration(input: Record<string, unknown>, coldChainRequired: boolean): { mode: "pickup" | "delivery" | "both"; zones: DeliveryZone[] } {
  const rawMode = text(input.deliveryMode, 20).toLowerCase();
  const mode = rawMode === "delivery" || rawMode === "both" ? rawMode : rawMode === "pickup" || !rawMode ? "pickup" : null;
  if (!mode) throw new ApiRequestError(400, "invalid-delivery-mode", "Choisissez retrait, livraison ou les deux modalités.");
  const rawZones = input.deliveryZones;
  if (rawZones !== undefined && !Array.isArray(rawZones)) throw new ApiRequestError(400, "invalid-delivery-zones", "Les zones de livraison ne sont pas valides.");
  if (Array.isArray(rawZones) && rawZones.length > 30) throw new ApiRequestError(400, "too-many-delivery-zones", "Une fiche peut contenir au maximum 30 zones de livraison.");
  const zones: DeliveryZone[] = (Array.isArray(rawZones) ? rawZones : []).map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ApiRequestError(400, "invalid-delivery-zone", "Une zone de livraison n’est pas valide.");
    const zone = raw as Record<string, unknown>;
    const department = text(zone.department, 80);
    const commune = text(zone.commune, 80);
    const feeHTG = zone.feeHTG;
    const etaLabel = text(zone.etaLabel, 80);
    if (!department || !commune || !etaLabel || !Number.isSafeInteger(feeHTG) || Number(feeHTG) < 0 || Number(feeHTG) > 100_000) {
      throw new ApiRequestError(400, "invalid-delivery-zone", "Chaque zone doit avoir un département, une commune, des frais entiers valides et un délai indicatif.");
    }
    return { department, commune, feeHTG: Number(feeHTG), etaLabel, active: zone.active !== false };
  });
  const keys = zones.map((zone) => `${zone.department}|${zone.commune}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/\s+/g, " "));
  if (new Set(keys).size !== keys.length) throw new ApiRequestError(400, "duplicate-delivery-zone", "Une zone département/commune ne peut être déclarée qu’une seule fois.");
  if (mode !== "pickup" && coldChainRequired) throw new ApiRequestError(400, "cold-chain-delivery-unavailable", "Un produit nécessitant la chaîne du froid est limité au retrait en pharmacie.");
  if (mode !== "pickup" && !zones.some((zone) => zone.active)) throw new ApiRequestError(400, "active-delivery-zone-required", "Ajoutez au moins une zone active pour proposer la livraison.");
  return { mode, zones };
}

async function verifiedPharmacy(request: Request) {
  const user = await requireFirebaseUser(request);
  await requireAppCheck(request);
  const profile = await getFirebaseAdminDb().collection("providerProfiles").doc(user.uid).get();
  if (!profile.exists || profile.get("type") !== "pharmacy" || profile.get("status") !== "verified" || profile.get("publiclyListed") !== true) {
    throw new ApiRequestError(403, "verified-pharmacy-required", "Cet espace est réservé aux pharmacies NEXA vérifiées et publiées.");
  }
  return user;
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const user = await verifiedPharmacy(request);
    const snapshot = await getFirebaseAdminDb().collection("pharmacyProducts").where("providerUid", "==", user.uid).limit(200).get();
    const products = snapshot.docs.map((doc) => {
      const data = doc.data();
      const inventory = expirePharmacyLots(data);
      return { id: doc.id, ...data, stock: inventory.stock, reservedStock: inventory.reservedStock, lots: inventory.lots };
    });
    return json(request, { ok: true, products });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const user = await verifiedPharmacy(request);
    await enforceUserRateLimit({ uid: user.uid, action: "pharmacy-product-write", limit: 30, windowMs: 5 * 60_000 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande n’est pas valide.");
    const input = body as Record<string, unknown>;
    const name = text(input.name, 180);
    const dci = text(input.dci, 180);
    const dosage = text(input.dosage, 120);
    const pharmaceuticalForm = text(input.pharmaceuticalForm, 100);
    const therapeuticClass = text(input.therapeuticClass, 120);
    const regulatoryCategory = text(input.regulatoryCategory, 40).toUpperCase();
    const price = input.price;
    const stock = input.stock;
    const prescriptionRequired = input.prescriptionRequired === true || ["PRESCRIPTION", "CONTROLLED", "NARCOTIC", "SENSITIVE"].includes(regulatoryCategory);
    const coldChainRequired = input.coldChainRequired === true;
    const delivery = deliveryConfiguration(input, coldChainRequired);
    const productId = text(input.productId, 200);
    const allowedCategories = new Set(["OTC", "PRESCRIPTION", "CONTROLLED", "NARCOTIC", "SENSITIVE"]);
    if (!name || !dci || !dosage || !pharmaceuticalForm || !therapeuticClass || !allowedCategories.has(regulatoryCategory) || !Number.isSafeInteger(price) || Number(price) < 1 || Number(price) > 10_000_000 || !Number.isSafeInteger(stock) || Number(stock) < 0 || Number(stock) > 1_000_000) {
      throw new ApiRequestError(400, "invalid-product", "Vérifiez le nom, la DCI, le dosage, la forme, la catégorie, le prix et le stock.");
    }
    if (regulatoryCategory !== "OTC" && input.prescriptionRequired !== true) throw new ApiRequestError(400, "prescription-flag-required", "Cette catégorie exige le marquage ordonnance obligatoire.");
    if (productId && (text(input.lotNumber, 80) || text(input.expirationDate, 20))) throw new ApiRequestError(400, "lot-receipt-route-required", "Ajoutez un nouveau lot depuis la fiche du produit.");
    if (!productId && Number(stock) > 0 && (!text(input.lotNumber, 80) || !text(input.expirationDate, 20))) {
      throw new ApiRequestError(400, "initial-lot-required", "Un numéro de lot et une date d’expiration sont obligatoires pour enregistrer le stock initial.");
    }

    const db = getFirebaseAdminDb();
    const productRef = productId ? db.collection("pharmacyProducts").doc(productId) : db.collection("pharmacyProducts").doc();
    const auditRef = db.collection("adminAuditLogs").doc();
    const initialMovementRef = db.collection("pharmacyStockMovements").doc(`${productRef.id}__initial_receipt`);
    const result = await db.runTransaction(async (transaction) => {
      const providerSnapshot = await transaction.get(db.collection("providerProfiles").doc(user.uid));
      const productSnapshot = productId ? await transaction.get(productRef) : null;
      if (!providerSnapshot.exists || providerSnapshot.get("type") !== "pharmacy" || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true) {
        throw new ApiRequestError(403, "verified-pharmacy-required", "Le profil pharmacie n’est plus autorisé.");
      }
      if (productId && (!productSnapshot?.exists || productSnapshot.get("providerUid") !== user.uid)) throw new ApiRequestError(404, "product-not-found", "Ce produit n’appartient pas à votre pharmacie.");
      const prior = productSnapshot?.data() || {};
      const priorLots = expirePharmacyLots({ lots: Array.isArray(prior.lots) ? prior.lots as ReturnType<typeof createPharmacyLot>[] : [] }).lots;
      if (productId && priorLots.length === 0 && Number(prior.reservedStock || 0) > 0) throw new ApiRequestError(409, "legacy-reservation-review-required", "Des commandes existantes ont des réservations sans lot. Faites rapprocher ces commandes avant de modifier le stock.");
      const lots = [...priorLots];
      let receivedLot: ReturnType<typeof createPharmacyLot> | null = null;
      if (!productId && Number(stock) > 0) {
        try {
          receivedLot = createPharmacyLot({
            lotNumber: input.lotNumber,
            expirationDate: input.expirationDate,
            quantityReceived: stock,
          });
        } catch {
          throw new ApiRequestError(400, "invalid-pharmacy-lot", "Vérifiez le numéro de lot, sa date d’expiration et la quantité reçue.");
        }
        lots.push(receivedLot);
      }
      const hadUntrackedStock = priorLots.length === 0 && Number(prior.stock || 0) > 0;
      const nextStock = getSellableStock({ lots });
      const nextReservedStock = getReservedStock({ lots });
      const now = FieldValue.serverTimestamp();
      const data = {
        providerUid: user.uid,
        name, dci, dosage, pharmaceuticalForm, therapeuticClass, regulatoryCategory,
        publicDescription: text(input.publicDescription, 700),
        manufacturer: text(input.manufacturer, 120),
        deliveryMode: delivery.mode,
        deliveryZones: delivery.zones,
        coldChainRequired,
        price: Number(price), stock: nextStock, reservedStock: nextReservedStock, lots, prescriptionRequired,
        ...(hadUntrackedStock ? { legacyStockUnreconciled: Number(prior.stock || 0) } : {}),
        publicationStatus: "PENDING_REVIEW", active: false, reviewReason: "",
        createdAt: prior.createdAt || now, updatedAt: now,
      };
      if (productId) transaction.set(productRef, data, { merge: true });
      else transaction.create(productRef, data);
      transaction.create(auditRef, {
        actorUid: user.uid,
        action: productId ? "pharmacy_product_submitted_for_review" : "pharmacy_product_created_for_review",
        resource: `pharmacyProducts/${productRef.id}`,
        createdAt: now,
      });
      if (receivedLot) {
        const lotAuditRef = db.collection("adminAuditLogs").doc();
        transaction.create(lotAuditRef, {
          actorUid: user.uid,
          action: "pharmacy_product_initial_lot_received",
          resource: `pharmacyProducts/${productRef.id}`,
          metadata: { lotNumber: receivedLot.lotNumber, expirationDate: receivedLot.expirationDate, quantityReceived: receivedLot.quantityReceived },
          createdAt: now,
        });
        transaction.create(initialMovementRef, {
          productId: productRef.id,
          providerUid: user.uid,
          movementType: "RECEIPT",
          direction: "IN",
          quantity: receivedLot.quantityReceived,
          lotAllocations: [{ lotNumber: receivedLot.lotNumber, quantity: receivedLot.quantityReceived }],
          actorUid: user.uid,
          reason: "INITIAL_STOCK",
          createdAt: now,
        });
      }
      return { id: productRef.id, publicationStatus: "PENDING_REVIEW" };
    });
    return json(request, { ok: true, product: result });
  } catch (error) { return fail(request, error); }
}

export async function DELETE(request: Request) {
  try {
    const user = await verifiedPharmacy(request);
    await enforceUserRateLimit({ uid: user.uid, action: "pharmacy-product-write", limit: 30, windowMs: 5 * 60_000 });
    const body = await request.json().catch(() => null);
    const productId = body && typeof body === "object" && !Array.isArray(body) ? text((body as Record<string, unknown>).productId, 200) : "";
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(productId)) throw new ApiRequestError(400, "invalid-product", "La référence du produit n’est pas valide.");
    const db = getFirebaseAdminDb();
    const productRef = db.collection("pharmacyProducts").doc(productId);
    const auditRef = db.collection("adminAuditLogs").doc();
    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(productRef);
      if (!snapshot.exists || snapshot.get("providerUid") !== user.uid) throw new ApiRequestError(404, "product-not-found", "Ce produit n’appartient pas à votre pharmacie.");
      if (Number(snapshot.get("reservedStock") || 0) > 0) throw new ApiRequestError(409, "product-stock-reserved", "Ce produit a des quantités réservées. Désactivez sa vente et contactez NEXA.");
      transaction.set(productRef, { active: false, publicationStatus: "ARCHIVED", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      transaction.create(auditRef, { actorUid: user.uid, action: "pharmacy_product_archived", resource: `pharmacyProducts/${productId}`, createdAt: FieldValue.serverTimestamp() });
    });
    return json(request, { ok: true, productId, publicationStatus: "ARCHIVED" });
  } catch (error) { return fail(request, error); }
}
