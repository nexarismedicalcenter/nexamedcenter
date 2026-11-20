import { connection, NextResponse } from "next/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

type DiagnosticProviderType = "laboratory" | "imaging";

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function GET(request: Request) {
  await connection();
  const params = new URL(request.url).searchParams;
  const requestedType = clean(params.get("type"), 20);
  if (requestedType && requestedType !== "laboratory" && requestedType !== "imaging") {
    return NextResponse.json({ ok: false, error: "Type de partenaire invalide." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const db = getFirebaseAdminDb();
    const snapshot = await db.collection("diagnosticOffers").where("publicationStatus", "==", "PUBLISHED").where("active", "==", true).limit(500).get();
    const candidates: (Record<string, unknown> & { id: string })[] = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const providerIds = [...new Set(candidates.map((offer) => String(offer.providerUid || "")).filter(Boolean))].slice(0, 300);
    const providers = providerIds.length ? await db.getAll(...providerIds.map((uid) => db.collection("providerProfiles").doc(uid))) : [];
    const providerById = new Map(providers.filter((provider) => provider.exists && provider.get("status") === "verified" && provider.get("publiclyListed") === true).map((provider) => [provider.id, provider.data() || {}]));
    const offers = candidates.flatMap((offer) => {
      const providerType = offer.providerType as DiagnosticProviderType;
      if ((providerType !== "laboratory" && providerType !== "imaging") || (requestedType && providerType !== requestedType)) return [];
      const provider = providerById.get(String(offer.providerUid || ""));
      if (!provider || provider.type !== providerType) return [];
      const profile = provider.profile && typeof provider.profile === "object" ? provider.profile as Record<string, unknown> : {};
      return [{
        id: offer.id,
        providerUid: String(offer.providerUid),
        providerType,
        providerName: clean(profile.name || profile.displayName || provider.displayName, 120) || "Partenaire NEXA",
        department: clean(profile.department, 80),
        commune: clean(profile.commune, 80),
        address: clean(profile.address, 200),
        phone: clean(profile.publicPhone, 30),
        openingHours: clean(profile.openingHours, 300),
        name: clean(offer.name, 180),
        category: clean(offer.category, 120),
        catalogExamId: clean(offer.catalogExamId, 120),
        description: clean(offer.description, 500),
        specimenType: clean(offer.specimenType, 120),
        preparation: clean(offer.preparation, 1000),
        precautions: clean(offer.precautions, 1000),
        technique: clean(offer.technique, 180),
        resultDelay: clean(offer.resultDelay, 160),
        instructions: clean(offer.instructions, 1200),
        price: Number.isSafeInteger(offer.price) && Number(offer.price) >= 0 ? Number(offer.price) : null,
        requiresPrescription: offer.requiresPrescription === true,
        appointmentRequired: offer.appointmentRequired === true,
        homeSampling: offer.homeSampling === true,
      }];
    });
    return NextResponse.json({ ok: true, offers }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    console.error("NEXA diagnostic offers request failed", error instanceof Error ? error.name : "unknown-error");
    return NextResponse.json({ ok: false, error: "Les offres des centres ne sont pas disponibles pour le moment." }, { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
