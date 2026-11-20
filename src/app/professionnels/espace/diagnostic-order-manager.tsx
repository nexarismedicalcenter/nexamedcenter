"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";

type ProviderType = "laboratory" | "imaging";
type Order = {
  id: string;
  orderNumber: string;
  patientNumber: string;
  items: { name: string; category?: string; price: number; preparation?: string; specimenType?: string; technique?: string; requiresPrescription?: boolean }[];
  amount: number;
  currency: string;
  paymentStatus: string;
  status: string;
  requiresPrescription: boolean;
  createdAt: string | null;
};
type Prescription = { providerName: string; specialtyName: string; version: number; validatedAt: string | null; exams: string[] };

const statusLabels: Record<string, string> = {
  PENDING_PAYMENT: "Paiement en attente",
  PAYMENT_EXPIRED: "Paiement expiré",
  PAID: "Payée · à accepter",
  ACCEPTED: "Acceptée · patient attendu",
  PATIENT_PRESENTED: "Présence confirmée",
  SAMPLE_COLLECTED: "Prélèvement effectué",
  SAMPLE_RECEIVED: "Échantillon reçu",
  ANALYSIS_IN_PROGRESS: "Analyse en cours",
  EXAM_IN_PROGRESS: "Examen en cours",
  EXAM_COMPLETED: "Examen effectué · résultat à transmettre à NEXA",
  COMPLETED: "Terminée · résultat remis au patient",
  PROVIDER_REFUSED: "Refusée · remboursement à rapprocher",
};

const nextActions: Record<ProviderType, Record<string, string>> = {
  laboratory: { ACCEPTED: "Confirmer la présence", PATIENT_PRESENTED: "Confirmer le prélèvement", SAMPLE_COLLECTED: "Confirmer la réception", SAMPLE_RECEIVED: "Démarrer l’analyse", ANALYSIS_IN_PROGRESS: "Marquer l’examen effectué" },
  imaging: { ACCEPTED: "Confirmer la présence", PATIENT_PRESENTED: "Démarrer l’examen", EXAM_IN_PROGRESS: "Marquer l’examen effectué" },
};

export default function DiagnosticOrderManager({ user, providerType }: { user: User; providerType: ProviderType }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [prescriptions, setPrescriptions] = useState<Record<string, Prescription>>({});
  const [refusalReasons, setRefusalReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchRevision, setSearchRevision] = useState(0);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (searchTerm) params.set("q", searchTerm);
      const result = await appointmentRequest<{ orders: Order[]; nextCursor?: string | null }>(user, `/api/provider/diagnostic-orders${params.size ? `?${params}` : ""}`);
      setOrders(result.orders || []); setNextCursor(result.nextCursor || null); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Les commandes ne peuvent pas être chargées."); }
    finally { setLoading(false); }
  }, [searchTerm, user]);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load, searchRevision]);

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearchTerm(searchDraft.trim());
    setOrders([]); setNextCursor(null); setLoading(true); setError(""); setSearchRevision((value) => value + 1);
  }

  function clearSearch() {
    setSearchDraft(""); setSearchTerm(""); setOrders([]); setNextCursor(null); setLoading(true); setError(""); setSearchRevision((value) => value + 1);
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true); setError("");
    try {
      const params = new URLSearchParams({ cursor: nextCursor });
      if (searchTerm) params.set("q", searchTerm);
      const result = await appointmentRequest<{ orders: Order[]; nextCursor?: string | null }>(user, `/api/provider/diagnostic-orders?${params}`);
      setOrders((current) => {
        const existingIds = new Set(current.map((order) => order.id));
        return [...current, ...(result.orders || []).filter((order) => !existingIds.has(order.id))];
      });
      setNextCursor(result.nextCursor || null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Les commandes précédentes ne peuvent pas être chargées."); }
    finally { setLoadingMore(false); }
  }

  async function update(order: Order, action: "accept" | "refuse" | "advance") {
    const reason = refusalReasons[order.id]?.trim() || "";
    if (action === "refuse" && reason.length < 5) { setError("Indiquez le motif du refus pour permettre à NEXA de rapprocher le remboursement."); return; }
    if (action === "refuse" && !window.confirm("Refuser cette commande ? NEXA devra rapprocher le remboursement MonCash.")) return;
    setBusyId(order.id); setError(""); setNotice("");
    try {
      await appointmentRequest(user, "/api/provider/diagnostic-orders", "POST", { orderId: order.id, action, ...(action === "refuse" ? { reason } : {}) });
      setNotice(action === "refuse" ? "Le refus est transmis à NEXA pour rapprochement." : "L’étape de la commande est mise à jour.");
      setRefusalReasons((current) => ({ ...current, [order.id]: "" }));
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "La commande n’a pas pu être mise à jour."); }
    finally { setBusyId(""); }
  }

  async function viewPrescription(order: Order) {
    setBusyId(order.id); setError("");
    try {
      const result = await appointmentRequest<{ prescription: Prescription }>(user, `/api/provider/diagnostic-orders/${encodeURIComponent(order.id)}/prescription`);
      setPrescriptions((current) => ({ ...current, [order.id]: result.prescription }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "L’ordonnance n’est pas accessible."); }
    finally { setBusyId(""); }
  }

  return <section className="diagnostic-orders" aria-labelledby="diagnostic-orders-heading">
    <div className="diagnostic-orders-heading"><h3 id="diagnostic-orders-heading">Commandes {providerType === "laboratory" ? "laboratoire" : "imagerie"}</h3><button className="button button-quiet" disabled={loading || Boolean(busyId)} onClick={() => void load()} type="button">Actualiser</button></div>
    <form className="diagnostic-order-search" onSubmit={search} role="search">
      <label>Numéro de commande ou numéro patient NMC<input autoComplete="off" maxLength={100} onChange={(event) => setSearchDraft(event.target.value)} placeholder="NMC-LAB-0008 ou NMC-0000009" value={searchDraft} /></label>
      <button className="button button-primary" disabled={loading || loadingMore || Boolean(busyId)} type="submit">Rechercher</button>
      {searchTerm || searchDraft ? <button className="button button-quiet" disabled={loading || loadingMore || Boolean(busyId)} onClick={clearSearch} type="button">Effacer</button> : null}
      <p>La recherche porte sur le numéro complet de commande ou le numéro patient NMC.</p>
    </form>
    {error ? <p className="form-error" role="alert">{error}</p> : null}{notice ? <p className="form-notice" role="status">{notice}</p> : null}
    {loading ? <p role="status">Chargement des commandes…</p> : orders.length ? <div className="diagnostic-order-list">{orders.map((order) => <article className="diagnostic-order-card" key={order.id}>
      <div className="diagnostic-order-top"><div><strong>{order.orderNumber}</strong><span>Patient {order.patientNumber} · {order.createdAt ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(new Date(order.createdAt)) : "Date à confirmer"}</span><small>{statusLabels[order.status] || order.status}</small></div><strong>{order.paymentStatus === "FREE" ? "Gratuit" : `${new Intl.NumberFormat("fr-HT").format(order.amount)} ${order.currency}`}</strong></div>
      <ul>{order.items.map((item, index) => <li key={`${item.name}-${index}`}><strong>{item.name}</strong>{item.category ? <span>{item.category}</span> : null}{item.specimenType ? <span>Prélèvement : {item.specimenType}</span> : null}{item.technique ? <span>Technique : {item.technique}</span> : null}{item.preparation ? <span>Préparation : {item.preparation}</span> : null}</li>)}</ul>
      {order.requiresPrescription ? <div className="diagnostic-order-rx"><p>Une ordonnance NEXA validée est associée.</p>{prescriptions[order.id] ? <div><strong>Prescription de {prescriptions[order.id].providerName}{prescriptions[order.id].specialtyName ? ` · ${prescriptions[order.id].specialtyName}` : ""}</strong><ul>{prescriptions[order.id].exams.map((exam, index) => <li key={`${exam}-${index}`}>{exam}</li>)}</ul><small>La consultation de l’ordonnance est journalisée.</small></div> : <button className="button button-outline" disabled={Boolean(busyId)} onClick={() => void viewPrescription(order)} type="button">{busyId === order.id ? "Ouverture…" : "Voir les examens prescrits"}</button>}</div> : null}
      {order.status === "PAID" || order.status === "ACCEPTED" ? <div className="diagnostic-order-actions">{order.status === "PAID" ? <button className="button button-primary" disabled={Boolean(busyId)} onClick={() => void update(order, "accept")} type="button">Accepter</button> : null}{nextActions[providerType][order.status] ? <button className="button button-outline" disabled={Boolean(busyId)} onClick={() => void update(order, "advance")} type="button">{nextActions[providerType][order.status]}</button> : null}<label>Motif de refus<input maxLength={500} value={refusalReasons[order.id] || ""} onChange={(event) => setRefusalReasons((current) => ({ ...current, [order.id]: event.target.value }))} /></label><button className="button button-quiet" disabled={Boolean(busyId) || (refusalReasons[order.id]?.trim().length || 0) < 5} onClick={() => void update(order, "refuse")} type="button">Refuser · signaler à NEXA</button></div> : null}
      {order.status !== "PAID" && order.status !== "ACCEPTED" && nextActions[providerType][order.status] ? <button className="button button-outline" disabled={Boolean(busyId)} onClick={() => void update(order, "advance")} type="button">{nextActions[providerType][order.status]}</button> : null}
    </article>)}</div> : <p>{searchTerm ? "Aucune commande ne correspond à ce numéro." : "Aucune commande réglée ou gratuite à traiter."}</p>}
    {!loading && nextCursor ? <button className="button button-outline" disabled={loadingMore || Boolean(busyId)} onClick={() => void loadMore()} type="button">{loadingMore ? "Chargement des commandes précédentes…" : "Charger les commandes précédentes"}</button> : null}
    <p className="appointment-privacy">Les commandes réglées par MonCash sont rapprochées par NEXA. Aucun renseignement patient n’est transmis à Smart Cut.</p>
  </section>;
}
