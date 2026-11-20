"use client";

import { useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";

type ActivityEvent = { id: string; action: string; resource: string; createdAt: string };

const actionLabels: Record<string, string> = {
  diagnostic_offer_created: "Offre d’examen créée",
  diagnostic_offer_updated: "Offre d’examen modifiée",
  diagnostic_offer_archived: "Offre d’examen archivée",
  diagnostic_result_upload_started: "Dépôt d’un résultat commencé",
  diagnostic_result_submitted: "Résultat transmis à NEXA",
  diagnostic_result_correction_submitted: "Correction transmise à NEXA",
  diagnostic_result_upload_cancelled: "Dépôt annulé",
  diagnostic_prescription_viewed: "Ordonnance liée consultée",
  lab_support_ticket_created: "Demande de support créée",
  lab_support_ticket_viewed: "Demande de support consultée",
  lab_support_tickets_listed: "Liste des demandes de support consultée",
  diagnostic_offers_listed: "Liste des offres consultée",
};

function activityLabel(action: string) {
  if (actionLabels[action]) return actionLabels[action];
  if (/^(laboratory|imaging)_order_accept$/.test(action)) return "Commande acceptée";
  if (/^(laboratory|imaging)_order_refuse$/.test(action)) return "Commande refusée";
  if (/^(laboratory|imaging)_order_advance$/.test(action)) return "Étape de commande avancée";
  if (/^(laboratory|imaging)_orders_listed$/.test(action)) return "Liste des commandes consultée";
  return action.replaceAll("_", " ");
}

function activityDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date indisponible"
    : new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(date);
}

export default function ProviderActivityHistory({ user }: { user: User }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await appointmentRequest<{ events: ActivityEvent[]; nextCursor: string | null }>(user, "/api/provider/activity-history");
      setEvents(result.events || []);
      setCursor(result.nextCursor || null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "L’historique des activités n’est pas disponible.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadFirstPage(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadFirstPage]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const result = await appointmentRequest<{ events: ActivityEvent[]; nextCursor: string | null }>(
        user,
        `/api/provider/activity-history?cursor=${encodeURIComponent(cursor)}`,
      );
      setEvents((current) => {
        const existing = new Set(current.map((event) => event.id));
        return [...current, ...(result.events || []).filter((event) => !existing.has(event.id))];
      });
      setCursor(result.nextCursor || null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "La suite de l’historique n’est pas disponible.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="provider-slots provider-activity-history" aria-labelledby="provider-activity-heading">
      <div className="diagnostic-orders-heading">
        <h2 id="provider-activity-heading">Historique de mes activités</h2>
        <button className="button button-quiet" disabled={loading || loadingMore} onClick={() => void loadFirstPage()} type="button">Actualiser</button>
      </div>
      <p className="appointment-privacy">Cet historique liste vos actions sur les commandes, les résultats, les offres et le support. Il n’affiche pas les renseignements médicaux du patient.</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {loading ? <p role="status">Chargement de l’historique…</p> : events.length ? (
        <ol className="provider-activity-list" aria-live="polite">
          {events.map((event) => (
            <li key={event.id}>
              <strong>{activityLabel(event.action)}</strong>
              <small>{activityDate(event.createdAt)}{event.resource ? ` · ${event.resource}` : ""}</small>
            </li>
          ))}
        </ol>
      ) : <p>Aucune activité enregistrée.</p>}
      {!loading && cursor ? <button className="button button-outline" disabled={loadingMore} onClick={() => void loadMore()} type="button">{loadingMore ? "Chargement…" : "Charger la suite de l’historique"}</button> : null}
    </section>
  );
}
