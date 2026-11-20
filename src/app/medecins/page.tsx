import type { Metadata } from "next";
import Directory from "../directory";

export const metadata: Metadata = { title: "Professionnels de santé", description: "Trouvez un professionnel de santé NEXA en Haïti.", alternates: { canonical: "/medecins" } };

export default function DoctorsPage() {
  return <Directory type="doctors" title="Trouvez un professionnel de santé." description="Consultez les profils des professionnels vérifiés qui ont choisi de rejoindre le réseau NEXA." />;
}
