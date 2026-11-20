import type { Metadata } from "next";
import Link from "next/link";
import PatientRegistrationForm from "./patient-registration-form";

export const metadata: Metadata = {
  title: "Créer un compte patient | NEXA Medical Center",
  description: "Créez votre espace patient sécurisé NEXA Medical Center.",
  robots: { index: false, follow: false },
};

export default function PatientRegistrationPage() {
  return (
    <main className="auth-page">
      <div className="auth-topline"><Link className="brand brand-compact" href="/" aria-label="NEXA Medical Center, accueil"><span className="brand-mark">N</span><span>NEXA <small>MEDICAL CENTER</small></span></Link><Link href="/">Retour à l’accueil</Link></div>
      <section className="auth-layout">
        <div className="auth-intro">
          <p className="eyebrow">Votre santé, votre espace</p>
          <h1>Créez votre compte patient.</h1>
          <p>Votre numéro patient NEXA est attribué automatiquement dès la création de votre compte.</p>
          <div className="identity-preview"><span>Votre numéro</span><strong>NMC-0000001</strong><small>Exemple de format</small></div>
          <p className="auth-privacy">Votre numéro patient n’est ni un mot de passe ni un moyen de connexion. Gardez vos identifiants de compte confidentiels.</p>
        </div>
        <div className="auth-card">
          <div className="auth-card-heading"><p className="eyebrow">Inscription patient</p><h2>Quelques renseignements pour commencer</h2><p>Les champs marqués d’une étoile sont obligatoires.</p></div>
          <PatientRegistrationForm />
        </div>
      </section>
    </main>
  );
}
