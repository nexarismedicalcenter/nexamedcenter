import type { Metadata } from "next";
import ProviderSpace from "./provider-space";

export const metadata: Metadata = {
  title: "Espace professionnel",
  description: "Gérez les disponibilités de votre profil professionnel NEXA.",
  robots: { index: false, follow: false },
};

export default function ProviderSpacePage() {
  return <ProviderSpace />;
}
