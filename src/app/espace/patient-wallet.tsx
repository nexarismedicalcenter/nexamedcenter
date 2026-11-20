"use client";

import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";

type WalletEntry = {
  id: string;
  type: string;
  direction: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: string | null;
};

type WalletData = {
  currency: string;
  available: number;
  reserved: number;
  status: string;
};

export default function PatientWallet({ user }: { user: User }) {
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [entries, setEntries] = useState<WalletEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    appointmentRequest<{ wallet: WalletData; entries: WalletEntry[] }>(user, "/api/patient/wallet")
      .then((result) => {
        if (!active) return;
        setWallet(result.wallet);
        setEntries(result.entries || []);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Le portefeuille NEXA est indisponible.");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [user]);

  return <section className="patient-appointments" aria-labelledby="patient-wallet-heading">
    <h2 id="patient-wallet-heading">Portefeuille NEXA</h2>
    {loading ? <p role="status">Chargement du portefeuille…</p> : error ? <p className="form-error" role="alert">{error}</p> : wallet ? <>
      <p><strong>Solde disponible : {new Intl.NumberFormat("fr-HT", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(wallet.available)} {wallet.currency}</strong></p>
      {wallet.reserved > 0 ? <p>Montant réservé : {new Intl.NumberFormat("fr-HT", { maximumFractionDigits: 2 }).format(wallet.reserved)} {wallet.currency}</p> : null}
      <p className="appointment-privacy">Les remboursements NEXA approuvés apparaissent ici. Le solde peut servir à régler les consultations, commandes de pharmacie et commandes d’examens NEXA qui proposent cette méthode.</p>
      {entries.length ? <ul aria-label="Mouvements du portefeuille">{entries.map((entry) => <li key={entry.id}><div><strong>{entry.type === "REFUND" ? "Remboursement NEXA" : entry.type === "APPOINTMENT_PAYMENT" ? "Paiement d’une consultation" : entry.type === "ORDER_PAYMENT" ? "Paiement d’une commande" : "Mouvement du portefeuille"}</strong><span>{entry.direction === "CREDIT" ? "+" : "−"}{new Intl.NumberFormat("fr-HT", { maximumFractionDigits: 2 }).format(entry.amount)} {entry.currency}</span><small>{entry.createdAt ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.createdAt)) : "Date à confirmer"} · {entry.status === "COMPLETED" ? "Terminé" : "En cours"}</small></div></li>)}</ul> : <p>Aucun mouvement enregistré.</p>}
    </> : null}
  </section>;
}
