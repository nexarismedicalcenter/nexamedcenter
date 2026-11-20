"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";
import { cleanLabSupportText, LAB_SUPPORT_CATEGORIES, type LabSupportCategory, type LabSupportTicket } from "@/lib/lab-support";

const categoryLabels: Record<LabSupportCategory, string> = {
  commande: "Commande",
  examen: "Examen",
  resultat: "Résultat",
  paiement: "Paiement",
  remboursement: "Remboursement",
  decaissement: "Décaissement",
  compte: "Compte",
  technique: "Problème technique",
};

const statusLabels: Record<string, string> = {
  OPEN: "Ouvert",
  IN_PROGRESS: "En cours",
  RESOLVED: "Résolu",
  CLOSED: "Fermé",
};

export default function LabSupport({ user }: { user: User }) {
  const [tickets, setTickets] = useState<LabSupportTicket[]>([]);
  const [category, setCategory] = useState<LabSupportCategory>("commande");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [details, setDetails] = useState<LabSupportTicket | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await appointmentRequest<{ tickets: LabSupportTicket[] }>(user, "/api/lab-support/tickets");
      setTickets(result.tickets || []);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Les tickets ne peuvent pas être chargés."); }
    finally { setLoading(false); }
  }, [user]);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);

  async function createTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (cleanLabSupportText(subject, 180).length < 4 || cleanLabSupportText(description, 3000).length < 10) {
      setError("Le sujet doit contenir au moins 4 caractères et la description au moins 10."); return;
    }
    setBusy(true); setError(""); setNotice("");
    try {
      await appointmentRequest(user, "/api/lab-support/tickets", "POST", { category, subject, description });
      setSubject(""); setDescription(""); setDetails(null);
      setNotice("Votre demande a été transmise au support NEXA.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le ticket n’a pas pu être créé."); }
    finally { setBusy(false); }
  }

  async function showTicket(ticketId: string) {
    setBusy(true); setError("");
    try {
      const result = await appointmentRequest<{ ticket: LabSupportTicket }>(user, `/api/lab-support/tickets?ticketId=${encodeURIComponent(ticketId)}`);
      setDetails(result.ticket);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Les réponses ne peuvent pas être chargées."); }
    finally { setBusy(false); }
  }

  return <section className="provider-slots lab-support-panel" id="support" aria-labelledby="lab-support-title">
    <h2 id="lab-support-title">Support laboratoire NEXA</h2>
    <p className="appointment-privacy">N’inscrivez aucun nom de patient, diagnostic ni renseignement médical dans un ticket. Utilisez uniquement la référence de commande ou d’examen nécessaire.</p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}{notice ? <p className="form-notice" role="status">{notice}</p> : null}
    <form className="lab-support-form" onSubmit={(event) => void createTicket(event)}>
      <label>Catégorie<select disabled={busy} onChange={(event) => setCategory(event.target.value as LabSupportCategory)} value={category}>{LAB_SUPPORT_CATEGORIES.map((value) => <option key={value} value={value}>{categoryLabels[value]}</option>)}</select></label>
      <label>Sujet<input maxLength={180} minLength={4} required value={subject} disabled={busy} onChange={(event) => setSubject(event.target.value)} /></label>
      <label>Description<textarea maxLength={3000} minLength={10} required rows={4} value={description} disabled={busy} onChange={(event) => setDescription(event.target.value)} /></label>
      <button className="button button-primary" disabled={busy} type="submit">{busy ? "Envoi…" : "Créer un ticket"}</button>
    </form>
    <div className="lab-support-list" aria-live="polite">
      <h3>Mes demandes</h3>
      {loading ? <p role="status">Chargement des tickets…</p> : tickets.length ? <ul>{tickets.map((ticket) => <li key={ticket.id}>
        <span><strong>{ticket.subject}</strong><small>{categoryLabels[ticket.category]} · {statusLabels[ticket.status] || ticket.status}{ticket.messageCount ? ` · ${ticket.messageCount} réponse(s)` : ""}</small></span>
        <button className="button button-quiet" disabled={busy} onClick={() => void showTicket(ticket.id)} type="button">Afficher l’historique</button>
      </li>)}</ul> : <p>Aucun ticket support.</p>}
      {details ? <article className="lab-support-detail"><h4>{details.subject}</h4><p>{details.description}</p>{details.messages?.length ? <ol>{details.messages.map((message) => <li key={message.id}><strong>Support NEXA</strong><p>{message.message}</p><small>{message.createdAt ? new Intl.DateTimeFormat("fr-HT", { dateStyle: "medium", timeStyle: "short" }).format(new Date(message.createdAt)) : "Date indisponible"}</small></li>)}</ol> : <p>Aucune réponse pour le moment.</p>}</article> : null}
    </div>
  </section>;
}
