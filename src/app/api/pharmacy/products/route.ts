import { connection, NextResponse } from "next/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { isPharmacyDeliveryEnabled } from "@/lib/pharmacy/delivery-config.server";
import { getAvailableSellableStock } from "@/lib/pharmacy/stock";

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

export async function GET(request: Request) {
  await connection();
  try {
    const search = new URL(request.url).searchParams;
    const query = clean(search.get("q"), 100).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr");
    const providerUid = clean(search.get("pharmacyId"), 128);
    const deliveryEnabled = isPharmacyDeliveryEnabled();
    let productsQuery = getFirebaseAdminDb().collection("pharmacyProducts").where("publicationStatus", "==", "PUBLISHED");
    if (providerUid) productsQuery = productsQuery.where("providerUid", "==", providerUid);
    const snapshot = await productsQuery.limit(250).get();
    const providerIds = [...new Set(snapshot.docs.map((doc) => String(doc.get("providerUid") || "")).filter(Boolean))];
    const providers = providerIds.length
      ? await getFirebaseAdminDb().getAll(...providerIds.map((uid) => getFirebaseAdminDb().collection("providerProfiles").doc(uid)))
      : [];
    const providerMap = new Map(providers.map((doc) => {
      const profile = doc.get("profile") && typeof doc.get("profile") === "object" ? doc.get("profile") as Record<string, unknown> : {};
      return [doc.id, { valid: doc.exists && doc.get("type") === "pharmacy" && doc.get("status") === "verified" && doc.get("publiclyListed") === true, name: clean(profile.name, 120) || "Pharmacie NEXA", commune: clean(profile.commune, 80), department: clean(profile.department, 80) }] as const;
    }));
    const products = snapshot.docs.map((doc) => {
      const data = doc.data();
      const providerUid = String(data.providerUid || "");
      const provider = providerMap.get(providerUid);
      const availableStock = getAvailableSellableStock(data);
      return {
        id: doc.id,
        providerUid,
        pharmacyName: provider?.name || "Pharmacie NEXA",
        commune: provider?.commune || "",
        department: provider?.department || "",
        name: clean(data.name, 180),
        dci: clean(data.dci, 180),
        dosage: clean(data.dosage, 120),
        pharmaceuticalForm: clean(data.pharmaceuticalForm, 100),
        description: clean(data.publicDescription, 700),
        manufacturer: clean(data.manufacturer, 120),
        price: Number.isSafeInteger(data.price) ? Number(data.price) : 0,
        stock: availableStock,
        active: data.active === true,
        prescriptionRequired: data.prescriptionRequired === true,
        deliveryMode: deliveryEnabled && ["delivery", "both"].includes(String(data.deliveryMode)) ? String(data.deliveryMode) : "pickup",
        deliveryZones: deliveryEnabled && Array.isArray(data.deliveryZones) ? data.deliveryZones.filter((zone) => zone && typeof zone === "object" && (zone as Record<string, unknown>).active !== false).map((zone) => {
          const value = zone as Record<string, unknown>;
          return { department: clean(value.department, 80), commune: clean(value.commune, 80), feeHTG: Number.isSafeInteger(value.feeHTG) ? Number(value.feeHTG) : 0, etaLabel: clean(value.etaLabel, 80) };
        }).filter((zone) => zone.department && zone.commune) : [],
        coldChainRequired: data.coldChainRequired === true,
      };
    }).filter((product) => {
      const provider = providerMap.get(product.providerUid);
      const haystack = `${product.name} ${product.dci} ${product.dosage} ${product.pharmaceuticalForm} ${product.pharmacyName} ${product.commune} ${product.department}`
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr");
      return provider?.valid === true && product.active && product.price > 0 && (!query || haystack.includes(query));
    }).sort((left, right) => left.name.localeCompare(right.name, "fr")).slice(0, 100);

    return NextResponse.json({ ok: true, deliveryEnabled, products }, { headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=60" } });
  } catch (error) {
    console.error("NEXA pharmacy catalog failed", error instanceof Error ? error.name : "unknown-error");
    return NextResponse.json({ ok: false, error: "Le catalogue pharmacie est indisponible." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
