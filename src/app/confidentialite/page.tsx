import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Confidentialité — document à valider",
  robots: { index: false, follow: false },
};

export default function PrivacyPage() {
  return (
    <main className="auth-page">
      <div className="auth-topline"><Link className="brand brand-compact" href="/" aria-label="NEXA Medical Center, accueil"><span className="brand-mark">N</span><span>NEXA <small>MEDICAL CENTER</small></span></Link><Link href="/inscription">Retour à l’inscription</Link></div>
      <article className="auth-single auth-card legal-draft">
        <p className="eyebrow">Document à valider avant production</p>
        <h1>Politique de confidentialité</h1>
        <p>Cette page attend la politique officielle de NEXA Medical Center, notamment les finalités, durées de conservation, droits des personnes, contacts et prestataires traitant les données de santé.</p>
        <p>Dans cette version de travail, les notifications restent consultables dans l’espace NEXA. Les alertes push et e-mail sont facultatives, activées par l’utilisateur et ne doivent contenir aucun détail médical; un identifiant d’installation du navigateur est conservé pour l’envoi push. L’e-mail est transmis à Resend uniquement lorsque ce service est configuré et que l’utilisateur l’a activé. Ces traitements, leurs durées et les droits associés doivent être intégrés à la politique définitive avant publication.</p>
        <p>Elle ne doit pas être publiée comme politique définitive tant que l’entreprise n’a pas validé ces éléments.</p>
      </article>
    </main>
  );
}
