import type { Metadata } from "next";
import Link from "next/link";
import ServiceNavigation from "@/components/service-navigation";

export const metadata: Metadata = { title: "Laboratoire et imagerie", description: "Accédez aux laboratoires et centres d’imagerie partenaires NEXA.", alternates: { canonical: "/examens" } };

export default function ExamsPage() {
  return (
    <main className="directory-page">
      <header className="directory-header"><Link className="brand brand-compact" href="/" aria-label="NEXA Medical Center, accueil"><span className="brand-mark" aria-hidden="true">N</span><span>NEXA <small>MEDICAL CENTER</small></span></Link><ServiceNavigation className="directory-nav" /><Link className="button button-primary" href="/connexion">Se connecter</Link></header>
      <section className="directory-intro"><p className="eyebrow">Examens médicaux</p><h1>Choisissez votre service.</h1><p>Consultez les professionnels partenaires de NEXA selon l’examen dont vous avez besoin.</p></section>
      <section className="service-grid section-wrap exam-service-grid">
        <article className="service-card"><span className="service-icon" aria-hidden="true">⌕</span><h2>Laboratoire</h2><p>Recherchez les laboratoires et examens disponibles dans votre département.</p><Link href="/laboratoires">Voir les laboratoires →</Link></article>
        <article className="service-card"><span className="service-icon" aria-hidden="true">◉</span><h2>Imagerie</h2><p>Repérez les centres d’imagerie publiés dans le réseau NEXA.</p><Link href="/imagerie">Voir les centres d’imagerie →</Link></article>
      </section>
      <footer className="directory-footer"><Link href="/conditions">Conditions</Link><Link href="/confidentialite">Confidentialité</Link><span>© 2026 NEXA Medical Center</span></footer>
    </main>
  );
}
