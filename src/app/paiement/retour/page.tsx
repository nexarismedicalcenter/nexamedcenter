import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import ServiceNavigation from "@/components/service-navigation";
import MoncashReturnStatus from "./status";

export const metadata: Metadata = {
  title: "Vérification du paiement MonCash",
  description: "Vérifiez le statut de votre paiement NEXA Medical Center.",
  robots: { index: false, follow: false },
};

async function PaymentReturnContent({ searchParams }: { searchParams: Promise<{ paymentRef?: string | string[] }> }) {
  const params = await searchParams;
  const paymentRef = Array.isArray(params.paymentRef) ? params.paymentRef[0] || "" : params.paymentRef || "";
  return <MoncashReturnStatus paymentRef={paymentRef} />;
}

export default function MoncashReturnPage({ searchParams }: { searchParams: Promise<{ paymentRef?: string | string[] }> }) {
  return (
    <main className="payment-return-page">
      <header className="directory-header">
        <Link className="brand brand-compact" href="/" aria-label="NEXA Medical Center, accueil">
          <span className="brand-mark" aria-hidden="true">N</span>
          <span>NEXA <small>MEDICAL CENTER</small></span>
        </Link>
        <ServiceNavigation className="directory-nav" />
        <Link href="/espace">Mon espace</Link>
      </header>
      <section className="payment-return-card" aria-labelledby="payment-return-title">
        <p className="eyebrow">Paiement MonCash</p>
        <h1 id="payment-return-title">Vérifions votre transaction.</h1>
        <p className="payment-return-intro">Le retour de MonCash ne suffit pas à confirmer un paiement. NEXA vérifie la transaction auprès du service de paiement avant de mettre votre commande ou rendez-vous à jour.</p>
        <Suspense fallback={<div className="payment-return-status" role="status">Chargement de la vérification sécurisée…</div>}>
          <PaymentReturnContent searchParams={searchParams} />
        </Suspense>
        <p className="payment-return-support">Si le statut reste en attente, gardez votre reçu MonCash et contactez l’équipe NEXA. Ne transmettez pas de renseignements médicaux dans une demande de paiement.</p>
      </section>
      <footer className="directory-footer"><Link href="/">Accueil NEXA</Link><Link href="/confidentialite">Confidentialité</Link><span>© NEXA Medical Center</span></footer>
    </main>
  );
}
