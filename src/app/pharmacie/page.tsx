import type { Metadata } from "next";
import { Suspense } from "react";
import PharmacyStorefront from "./storefront";

export const metadata: Metadata = { title: "Pharmacies partenaires", description: "Trouvez les pharmacies vérifiées du réseau NEXA.", alternates: { canonical: "/pharmacie" } };

export default function PharmaciesPage() {
  return <Suspense fallback={<main className="directory-page"><p role="status">Chargement du catalogue pharmacie…</p></main>}><PharmacyStorefront /></Suspense>;
}
