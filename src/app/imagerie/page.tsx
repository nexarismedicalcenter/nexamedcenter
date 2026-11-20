import type { Metadata } from "next";
import Directory from "../directory";

export const metadata: Metadata = { title: "Centres d’imagerie", description: "Découvrez les centres d’imagerie vérifiés du réseau NEXA.", alternates: { canonical: "/imagerie" } };

export default function ImagingPage() {
  return <Directory type="imaging-centers" title="Centres d’imagerie." description="Consultez les centres d’imagerie publiés et vérifiés par NEXA." />;
}
