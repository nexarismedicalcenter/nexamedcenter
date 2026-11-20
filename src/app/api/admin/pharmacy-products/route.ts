import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { createUserNotification } from "@/lib/notifications.server";
import { expirePharmacyLots, getAvailableSellableStock } from "@/lib/pharmacy/stock";

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "admin-pharmacy-products-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les produits pharmacie ne sont pas accessibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA admin pharmacy products failed", error instanceof Error ? error.name : "unknown-error");
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
    await requireNexaAdministrator(request);
    const snapshot = await getFirebaseAdminDb().collection("pharmacyProducts").where("publicationStatus", "==", "PENDING_REVIEW").limit(100).get();
    const products = snapshot.docs.map((doc) => {
      const data = doc.data();
      const inventory = expirePharmacyLots(data);
      return {
        id: doc.id, providerUid: data.providerUid,
        name: data.name, dci: data.dci, dosage: data.dosage,
        pharmaceuticalForm: data.pharmaceuticalForm, therapeuticClass: data.therapeuticClass,
        regulatoryCategory: data.regulatoryCategory, prescriptionRequired: data.prescriptionRequired === true,
        publicDescription: data.publicDescription || "", manufacturer: data.manufacturer || "",
        deliveryMode: ["delivery", "both"].includes(String(data.deliveryMode)) ? String(data.deliveryMode) : "pickup",
        deliveryZones: Array.isArray(data.deliveryZones) ? data.deliveryZones : [],
        coldChainRequired: data.coldChainRequired === true,
        price: data.price, stock: inventory.stock, reservedStock: inventory.reservedStock,
        availableStock: getAvailableSellableStock(inventory),
        lots: inventory.lots.map((lot) => ({ lotNumber: lot.lotNumber, expirationDate: lot.expirationDate, quantityAvailable: lot.quantityAvailable, reservedQuantity: lot.reservedQuantity || 0, status: lot.status || "ACTIVE" })),
        reviewReason: data.reviewReason || "",
      };
    });
    return json(request, { ok: true, products });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande est invalide.");
    const input = body as Record<string, unknown>;
    const productId = typeof input.productId === "string" ? input.productId.trim() : "";
    const action = typeof input.action === "string" ? input.action.trim().toUpperCase() : "";
    const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(productId) || !["PUBLISH", "REJECT", "SUSPEND", "REQUEST_CORRECTION", "ARCHIVE"].includes(action)) {
      throw new ApiRequestError(400, "invalid-product-review", "Le produit ou la décision de revue n’est pas valide.");
    }
    if (action !== "PUBLISH" && !reason) throw new ApiRequestError(400, "review-reason-required", "Un motif est obligatoire pour cette décision.");
    const db = getFirebaseAdminDb();
    const productRef = db.collection("pharmacyProducts").doc(productId);
    const auditRef = db.collection("adminAuditLogs").doc();
    const result = await db.runTransaction(async (transaction) => {
      const productSnapshot = await transaction.get(productRef);
      if (!productSnapshot.exists) throw new ApiRequestError(404, "product-not-found", "Produit introuvable.");
      const product = productSnapshot.data() || {};
      const inventory = expirePharmacyLots(product);
      const providerRef = db.collection("providerProfiles").doc(String(product.providerUid || "_"));
      const providerSnapshot = await transaction.get(providerRef);
      if (action === "PUBLISH" && (!providerSnapshot.exists || providerSnapshot.get("type") !== "pharmacy" || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true)) {
        throw new ApiRequestError(409, "pharmacy-not-publishable", "La pharmacie propriétaire n’est plus vérifiée et publiée.");
      }
      if (action === "PUBLISH" && (!product.name || !product.dci || !product.dosage || !product.pharmaceuticalForm || !product.therapeuticClass || !Number.isSafeInteger(product.price) || Number(product.price) < 1 || inventory.stock < inventory.reservedStock || getAvailableSellableStock(inventory) < 1)) {
        throw new ApiRequestError(409, "product-review-incomplete", "La fiche doit contenir les informations médicament, un prix valide et au moins une unité non réservée dans un lot actif et non expiré.");
      }
      if (action === "PUBLISH" && product.deliveryMode !== undefined && !["pickup", "delivery", "both"].includes(String(product.deliveryMode))) {
        throw new ApiRequestError(409, "product-delivery-mode-invalid", "La modalité de livraison de la fiche doit être corrigée avant publication.");
      }
      if (action === "PUBLISH" && ["delivery", "both"].includes(String(product.deliveryMode || "pickup"))) {
        const zones = Array.isArray(product.deliveryZones) ? product.deliveryZones as Record<string, unknown>[] : [];
        if (product.coldChainRequired === true || !zones.some((zone) => zone.active !== false && typeof zone.department === "string" && zone.department.trim() && typeof zone.commune === "string" && zone.commune.trim() && typeof zone.etaLabel === "string" && zone.etaLabel.trim() && Number.isSafeInteger(zone.feeHTG) && Number(zone.feeHTG) >= 0)) {
          throw new ApiRequestError(409, "product-delivery-zones-incomplete", "Une livraison à domicile exige une zone active avec frais et délai valides; les produits de chaîne du froid restent au retrait.");
        }
      }
      const status = action === "PUBLISH" ? "PUBLISHED" : action === "REQUEST_CORRECTION" ? "NEEDS_CORRECTION" : action === "SUSPEND" ? "SUSPENDED" : action === "ARCHIVE" ? "ARCHIVED" : "REJECTED";
      transaction.set(productRef, {
        lots: inventory.lots,
        stock: inventory.stock,
        reservedStock: inventory.reservedStock,
        publicationStatus: status,
        active: action === "PUBLISH",
        reviewReason: action === "PUBLISH" ? "" : reason,
        reviewedByUid: admin.uid,
        reviewedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      transaction.create(auditRef, {
        actorUid: admin.uid,
        action: `pharmacy_product_${action.toLowerCase()}`,
        resource: `pharmacyProducts/${productId}`,
        createdAt: FieldValue.serverTimestamp(),
      });
      return { providerUid: String(product.providerUid || ""), status };
    });

    if (result.providerUid) await createUserNotification({
      uid: result.providerUid,
      eventKey: `pharmacy-product-review:${productId}:${auditRef.id}`,
      type: "pharmacy_product_review",
      title: result.status === "PUBLISHED" ? "Produit publié" : result.status === "NEEDS_CORRECTION" ? "Correction demandée" : result.status === "SUSPENDED" ? "Produit suspendu" : result.status === "ARCHIVED" ? "Produit archivé" : "Produit refusé",
      body: result.status === "PUBLISHED" ? "Votre produit est visible dans le catalogue NEXA." : reason,
      url: "/professionnels/espace",
    });
    return json(request, { ok: true, productId, publicationStatus: result.status });
  } catch (error) { return fail(request, error); }
}
