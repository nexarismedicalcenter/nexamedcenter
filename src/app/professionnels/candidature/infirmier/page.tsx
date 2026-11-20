import type { Metadata } from "next";
import Link from "next/link";
import ProfessionalApplicationForm from "../professional-application-form";

export const metadata: Metadata = {
  title: "Affiliation infirmière à domicile",
  description: "Déposez une demande distincte pour rejoindre les soins infirmiers à domicile Nexa - Care.",
  alternates: { canonical: "/professionnels/candidature/infirmier" },
};

export default function NursingApplicationPage() {
  return (
    <main className="auth-page">
      <div className="auth-topline"><Link className="brand brand-compact" href="/" aria-label="NEXA Medical Center, accueil"><span className="brand-mark" aria-hidden="true">N</span><span>NEXA <small>MEDICAL CENTER</small></span></Link><Link href="/professionnels/candidature">Autres affiliations professionnelles</Link></div>
      <section className="auth-layout">
        <div className="auth-intro"><p className="eyebrow">Nexa - Care · Soins infirmiers</p><h1>Demande d’affiliation infirmière.</h1><p>Ce parcours est distinct des candidatures médicales et des établissements. NEXA vérifie les qualifications déclarées avant d’approuver l’affiliation.</p><p className="auth-privacy">Après approbation, le profil de service devra être complété avant toute publication ou réservation. Le rôle infirmier ne peut pas prescrire de médicaments. Aucun document n’est téléversé dans cette pré-demande.</p></div>
        <div className="auth-card"><div className="auth-card-heading"><p className="eyebrow">Candidature infirmière</p><h2>Votre pratique à domicile</h2><p>Un compte e-mail est nécessaire pour suivre la demande.</p></div><ProfessionalApplicationForm fixedProviderType="nurse" /></div>
      </section>
    </main>
  );
}
