import type { Metadata } from "next";
import Directory from "../directory";

export const metadata: Metadata = { title: "Laboratoires partenaires", description: "Découvrez les laboratoires vérifiés du réseau NEXA.", alternates: { canonical: "/laboratoires" } };

export default function LaboratoriesPage() {
  return <Directory type="laboratories" title="Laboratoires partenaires." description="Retrouvez les laboratoires publiés et vérifiés par NEXA." />;
}
