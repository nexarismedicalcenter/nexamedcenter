import type { Metadata } from "next";
import Link from "next/link";
import ProfessionalApplicationForm from "./professional-application-form";

export const metadata: Metadata = {
  title: "Rejoindre le réseau professionnel",
  description: "Déposez une demande pour rejoindre le réseau professionnel NEXA.",
  alternates: { canonical: "/professionnels/candidature" },
};

export default function ProfessionalApplicationPage() {
  return (
    <main className="auth-page">
      <div className="auth-topline"><Link className="brand brand-compact" href="/" aria-label="NEXA Medical Center, accueil"><span className="brand-mark" aria-hidden="true">N</span><span>NEXA <small>MEDICAL CENTER</small></span></Link><Link href="/">Retour à l’accueil</Link></div>
      <section className="auth-layout">
        <div className="auth-intro"><p className="eyebrow">Réseau professionnel NEXA</p><h1>Rejoignez nos partenaires.</h1><p>Présentez votre service. L’équipe NEXA examinera les informations avant de publier un profil.</p><p>Le personnel infirmier utilise un parcours d’affiliation distinct : <Link href="/professionnels/candidature/infirmier">candidature aux soins infirmiers à domicile</Link>.</p><p className="auth-privacy">Cette pré-demande ne recueille aucun document d’identité ou dossier médical. Les pièces justificatives seront demandées dans un espace sécurisé après validation de la politique de confidentialité.</p></div>
        <div className="auth-card"><div className="auth-card-heading"><p className="eyebrow">Pré-demande professionnelle</p><h2>Votre établissement ou votre pratique</h2><p>Un compte e-mail est nécessaire pour suivre le dossier.</p></div><ProfessionalApplicationForm /></div>
      </section>
    </main>
  );
}
