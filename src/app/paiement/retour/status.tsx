"use client";

import Link from "next/link";
import { onAuthStateChanged, type User } from "firebase/auth";
import { getToken } from "firebase/app-check";
import { useCallback, useEffect, useState } from "react";
import { getFirebaseAppCheck, getFirebaseAuth } from "@/lib/firebase/client";

type PaymentStatus = "paid" | "pending" | "creating" | "creation_uncertain" | "creation_failed";
type ViewState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "status"; status: PaymentStatus };
const paymentStatuses = new Set<PaymentStatus>(["paid", "pending", "creating", "creation_uncertain", "creation_failed"]);

function statusMessage(status: PaymentStatus): string {
  switch (status) {
    case "paid": return "Paiement confirmé. Votre espace sera mis à jour avec les informations de votre rendez-vous ou commande.";
    case "pending": return "MonCash n’a pas encore confirmé le paiement. La vérification peut prendre quelques instants.";
    case "creating": return "La demande de paiement est encore en cours de préparation.";
    case "creation_uncertain": return "Le service de paiement doit réconcilier cette tentative. Ne recommencez pas le paiement; contactez l’équipe NEXA avec votre reçu.";
    case "creation_failed": return "Le paiement n’a pas pu être préparé. Aucun statut de paiement confirmé n’a été reçu.";
  }
}

async function fetchPaymentStatus(user: User, paymentRef: string): Promise<ViewState> {
  try {
    const headers = new Headers({
      Authorization: `Bearer ${await user.getIdToken()}`,
      "Content-Type": "application/json",
    });
    const appCheck = getFirebaseAppCheck();
    if (process.env.NODE_ENV === "production" && !appCheck) {
      throw new Error("La vérification sécurisée du paiement n’est pas disponible.");
    }
    if (appCheck) headers.set("X-Firebase-AppCheck", (await getToken(appCheck)).token);
    const response = await fetch("/api/payments/moncash/status", {
      method: "POST",
      headers,
      body: JSON.stringify({ paymentRef }),
      cache: "no-store",
    });
    const payload = await response.json() as { ok?: boolean; status?: string; error?: string };
    if (!response.ok || payload.ok !== true || !payload.status || !paymentStatuses.has(payload.status as PaymentStatus)) {
      throw new Error(payload.error || "La transaction n’a pas pu être vérifiée. Réessayez dans un instant.");
    }
    return { kind: "status", status: payload.status as PaymentStatus };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : "La transaction n’a pas pu être vérifiée." };
  }
}

export default function MoncashReturnStatus({ paymentRef }: { paymentRef: string }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [view, setView] = useState<ViewState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    try {
      unsubscribe = onAuthStateChanged(getFirebaseAuth(), (currentUser) => {
        setUser(currentUser);
        setAuthReady(true);
        if (currentUser && paymentRef) {
          setView({ kind: "loading" });
          void fetchPaymentStatus(currentUser, paymentRef).then((result) => {
            if (active) setView(result);
          });
        } else if (!currentUser) setView({ kind: "error", message: "Connectez-vous pour vérifier le statut de la transaction." });
      });
    } catch {
      const timer = window.setTimeout(() => {
        if (active) {
          setAuthReady(true);
          setView({ kind: "error", message: "La connexion sécurisée à votre compte n’a pas pu être ouverte." });
        }
      }, 0);
      return () => {
        active = false;
        window.clearTimeout(timer);
      };
    }
    return () => {
      active = false;
      unsubscribe();
    };
  }, [paymentRef]);

  const verifyAgain = useCallback(async () => {
    if (!user || !paymentRef) return;
    setView({ kind: "loading" });
    setView(await fetchPaymentStatus(user, paymentRef));
  }, [paymentRef, user]);

  if (!paymentRef && authReady) {
    return <div className="payment-return-status"><p role="alert">La référence de paiement est absente de ce lien.</p><Link className="button button-outline" href="/espace">Retourner à mon espace</Link></div>;
  }

  if (!authReady || view.kind === "loading") {
    return <div className="payment-return-status" role="status" aria-live="polite"><span className="payment-return-spinner" aria-hidden="true" />Vérification sécurisée en cours…</div>;
  }

  if (!user) {
    const next = `/paiement/retour?paymentRef=${encodeURIComponent(paymentRef)}`;
    return <div className="payment-return-status"><p>Connectez-vous au compte utilisé pour préparer ce paiement afin de vérifier son statut.</p><Link className="button button-primary" href={`/connexion?next=${encodeURIComponent(next)}`}>Se connecter pour vérifier</Link></div>;
  }

  if (view.kind === "status") {
    const paid = view.status === "paid";
    const uncertain = view.status === "creation_uncertain";
    return (
      <div className={`payment-return-status ${paid ? "is-paid" : uncertain ? "is-uncertain" : "is-pending"}`} aria-live="polite">
        <span className="payment-return-icon" aria-hidden="true">{paid ? "✓" : uncertain ? "!" : "…"}</span>
        <h2>{paid ? "Paiement confirmé" : uncertain ? "Vérification requise" : "Paiement en attente"}</h2>
        <p>{statusMessage(view.status)}</p>
        {paid ? <Link className="button button-primary" href="/espace">Ouvrir mon espace</Link> : <button className="button button-outline" onClick={verifyAgain} type="button">Vérifier à nouveau</button>}
      </div>
    );
  }

  return (
    <div className="payment-return-status" aria-live="polite">
      <p role="alert">{view.message}</p>
      {paymentRef && <button className="button button-outline" onClick={verifyAgain} type="button">Réessayer la vérification</button>}
      {!paymentRef && <Link className="button button-outline" href="/espace">Retourner à mon espace</Link>}
    </div>
  );
}
