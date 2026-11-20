import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Conditions d’utilisation — document à valider",
  robots: { index: false, follow: false },
};

export default function TermsPage() {
  return (
    <main className="auth-page">
      <div className="auth-topline"><Link className="brand brand-compact" href="/" aria-label="NEXA Medical Center, accueil"><span className="brand-mark">N</span><span>NEXA <small>MEDICAL CENTER</small></span></Link><Link href="/inscription">Retour à l’inscription</Link></div>
      <article className="auth-single auth-card legal-draft">
        <p className="eyebrow">Document à valider avant production</p>
        <h1>Conditions d’utilisation</h1>
        <p>Ce document est un emplacement de travail. Les conditions officielles de NEXA Medical Center doivent être fournies et approuvées par l’entreprise avant tout lancement public.</p>
        <p>Aucun texte provisoire de cette page ne constitue une condition contractuelle finalisée.</p>
      </article>
    </main>
  );
}
