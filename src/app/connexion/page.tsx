import type { Metadata } from "next";
import Link from "next/link";
import LoginForm from "./login-form";

export const metadata: Metadata = {
  title: "Connexion à votre espace patient",
  description: "Connectez-vous à votre espace patient NEXA Medical Center.",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <main className="auth-page">
      <div className="auth-topline"><Link className="brand brand-compact" href="/" aria-label="NEXA Medical Center, accueil"><span className="brand-mark">N</span><span>NEXA <small>MEDICAL CENTER</small></span></Link><Link href="/">Retour à l’accueil</Link></div>
      <section className="auth-single">
        <div className="auth-intro"><p className="eyebrow">Espace patient</p><h1>Ravi de vous retrouver.</h1><p>Connectez-vous pour retrouver votre espace et votre numéro patient NEXA.</p></div>
        <div className="auth-card"><LoginForm /></div>
      </section>
    </main>
  );
}
