import type { Metadata } from "next";
import Link from "next/link";
import ServiceNavigation from "@/components/service-navigation";
import HomeVisitDirectory from "./visites-directory";

export const metadata: Metadata = {
  title: "Médecins à domicile | Nexa - Care",
  description: "Choisissez un médecin NEXA vérifié, une heure disponible et une commune desservie pour une visite médicale à domicile.",
  alternates: { canonical: "/care/visites-a-domicile" },
};

export default function HomeVisitsPage() {
  return <main className="directory-page">
    <header className="directory-header">
      <Link className="brand brand-compact" href="/" aria-label="NEXA Medical Center, accueil"><span className="brand-mark" aria-hidden="true">N</span><span>NEXA <small>MEDICAL CENTER</small></span></Link>
      <ServiceNavigation className="directory-nav" />
      <Link className="button button-primary" href="/connexion">Se connecter</Link>
    </header>
    <section className="directory-intro">
      <p className="eyebrow">Nexa - Care · Visites à domicile</p>
      <h1>Un médecin vient à votre domicile.</h1>
      <p>Choisissez un médecin vérifié qui dessert votre commune. Chaque réservation occupe une heure et est confirmée après paiement.</p>
    </section>
    <HomeVisitDirectory />
    <footer className="directory-footer"><Link href="/care">Retour à Nexa - Care</Link><Link href="/conditions">Conditions</Link><Link href="/confidentialite">Confidentialité</Link><span>© 2026 NEXA Medical Center</span></footer>
  </main>;
}
