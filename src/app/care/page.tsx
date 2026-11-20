import type { Metadata } from "next";
import Link from "next/link";
import ServiceNavigation from "@/components/service-navigation";

export const metadata: Metadata = {
  title: "Nexa - Care",
  description: "Rendez-vous, téléconsultations et informations sur les visites à domicile avec NEXA Medical Center.",
  alternates: { canonical: "/care" },
};

export default function CarePage() {
  return (
    <main className="directory-page">
      <header className="directory-header">
        <Link className="brand brand-compact" href="/" aria-label="NEXA Medical Center, accueil">
          <span className="brand-mark" aria-hidden="true">N</span><span>NEXA <small>MEDICAL CENTER</small></span>
        </Link>
        <ServiceNavigation className="directory-nav" />
        <Link className="button button-primary" href="/connexion">Se connecter</Link>
      </header>
      <section className="directory-intro">
        <p className="eyebrow">Nexa - Care</p>
        <h1>Les soins adaptés à votre parcours.</h1>
        <p>Choisissez le mode de prise en charge qui correspond à votre besoin.</p>
      </section>
      <section className="service-grid section-wrap" aria-label="Services Nexa - Care">
        <article className="service-card">
          <span className="service-icon" aria-hidden="true">✚</span>
          <h2>Rendez-vous et téléconsultations</h2>
          <p>Consultez les professionnels disponibles, choisissez un créneau et poursuivez votre parcours de consultation NEXA.</p>
          <Link href="/medecins">Trouver un professionnel <span aria-hidden="true">→</span></Link>
        </article>
        <article className="service-card">
          <span className="service-icon" aria-hidden="true">⌂</span>
          <h2>Visites à domicile</h2>
          <p>Choisissez un médecin vérifié, consultez les communes desservies et réservez une heure disponible avec paiement sécurisé.</p>
          <Link href="/care/visites-a-domicile">Trouver un médecin à domicile <span aria-hidden="true">→</span></Link>
        </article>
      </section>
      <footer className="directory-footer">
        <Link href="/conditions">Conditions</Link><Link href="/confidentialite">Confidentialité</Link><span>© 2026 NEXA Medical Center</span>
      </footer>
    </main>
  );
}
