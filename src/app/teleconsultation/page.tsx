import type { Metadata } from "next";
import { Suspense } from "react";
import TeleconsultationSession from "./session";

export const metadata: Metadata = {
  title: "Téléconsultation",
  description: "Ouvrez une séance vidéo NEXA sécurisée avec votre professionnel de santé.",
  robots: { index: false, follow: false },
};

export default function TeleconsultationPage() {
  return <Suspense fallback={<main className="appointment-page"><section className="appointment-shell" role="status">Ouverture de la séance…</section></main>}><TeleconsultationSession /></Suspense>;
}
