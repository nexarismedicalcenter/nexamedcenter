"use client";

import Link from "next/link";
import { onAuthStateChanged, type User } from "firebase/auth";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { appointmentRequest } from "@/lib/appointments/client";
import { getFirebaseAuth } from "@/lib/firebase/client";

type HomeVisitRequest = {
  requestId: string;
  status: string;
  department: string;
  commune: string;
  preferredDate: string;
  createdAt: string | null;
};

const statusLabels: Record<string, string> = {
  PENDING_REVIEW: "À examiner par NEXA",
  CONTACTED: "NEXA a pris contact",
  CONFIRMED: "Visite organisée par NEXA",
  UNAVAILABLE: "NEXA ne peut pas organiser cette visite",
};

function todayInHaiti() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Port-au-Prince", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export default function HomeVisitRequestForm() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authUnavailable, setAuthUnavailable] = useState(false);
  const [requests, setRequests] = useState<HomeVisitRequest[]>([]);
  const [department, setDepartment] = useState("");
  const [commune, setCommune] = useState("");
  const [addressLine, setAddressLine] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [preferredDate, setPreferredDate] = useState("");
  const [requestAcknowledged, setRequestAcknowledged] = useState(false);
  const [loadingRequests, setLoadingRequests] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    void Promise.resolve().then(() => {
      if (!active) return;
      try {
        unsubscribe = onAuthStateChanged(getFirebaseAuth(), (currentUser) => {
          setUser(currentUser);
          setAuthLoading(false);
          if (currentUser) setLoadingRequests(true);
          if (!currentUser) setRequests([]);
        });
      } catch {
        if (active) { setAuthUnavailable(true); setAuthLoading(false); }
      }
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  const loadRequests = useCallback(async (currentUser: User) => {
    setLoadingRequests(true);
    try {
      const result = await appointmentRequest<{ requests: HomeVisitRequest[] }>(currentUser, "/api/home-visit-requests");
      setRequests(result.requests || []);
    } catch {
      setRequests([]);
    } finally { setLoadingRequests(false); }
  }, []);

  useEffect(() => {
    if (!user) return;
    let active = true;
    void appointmentRequest<{ requests: HomeVisitRequest[] }>(user, "/api/home-visit-requests").then((result) => {
      if (active) setRequests(result.requests || []);
    }).catch(() => {
      if (active) setRequests([]);
    }).finally(() => { if (active) setLoadingRequests(false); });
    return () => { active = false; };
  }, [user]);

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) return;
    setSubmitting(true); setError(""); setNotice("");
    try {
      await appointmentRequest(user, "/api/home-visit-requests", "POST", {
        department, commune, addressLine, contactPhone, preferredDate,
        requestAcknowledged,
      });
      setDepartment(""); setCommune(""); setAddressLine(""); setContactPhone("");
      setPreferredDate(""); setRequestAcknowledged(false);
      setNotice("Votre demande a été envoyée. NEXA vous contactera pour confirmer la faisabilité, le créneau et le tarif. Aucun rendez-vous ni paiement n’est confirmé par ce formulaire.");
      await loadRequests(user);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "La demande n’a pas pu être envoyée.");
    } finally { setSubmitting(false); }
  }

  return (
    <div className="home-visit-request">
      {authLoading ? <p role="status">Vérification de votre session…</p> : authUnavailable ? (
        <p className="form-error" role="status">Le service de connexion NEXA n’est pas configuré sur cet environnement. Réessayez plus tard.</p>
      ) : !user ? (
        <div className="home-visit-signin">
          <p>Connectez-vous à votre espace patient pour envoyer une demande de visite.</p>
          <Link className="button button-primary" href={`/connexion?next=${encodeURIComponent("/care")}`}>Se connecter</Link>
          <Link className="button button-outline" href="/inscription">Créer un compte patient</Link>
        </div>
      ) : (
        <>
          <p className="appointment-privacy">NEXA examine votre demande et vous contacte avant de confirmer. Ce formulaire ne demande aucun renseignement médical.</p>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          {notice ? <p className="form-success" role="status">{notice}</p> : null}
          <form className="home-visit-form" onSubmit={(event) => void submitRequest(event)}>
            <div className="form-grid two-columns">
              <label>Département<input autoComplete="address-level1" maxLength={100} required value={department} onChange={(event) => setDepartment(event.target.value)} /></label>
              <label>Commune<input autoComplete="address-level2" maxLength={100} required value={commune} onChange={(event) => setCommune(event.target.value)} /></label>
            </div>
            <label>Adresse précise de la visite<textarea autoComplete="street-address" maxLength={220} required rows={2} value={addressLine} onChange={(event) => setAddressLine(event.target.value)} /></label>
            <label>Téléphone où NEXA peut vous joindre<input autoComplete="tel" inputMode="tel" maxLength={24} required type="tel" value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} /></label>
            <label>Date souhaitée<input min={todayInHaiti()} required type="date" value={preferredDate} onChange={(event) => setPreferredDate(event.target.value)} /></label>
            <label className="home-visit-acknowledgement"><input checked={requestAcknowledged} onChange={(event) => setRequestAcknowledged(event.target.checked)} required type="checkbox" />Je comprends que ceci est une demande. NEXA doit me contacter pour confirmer la visite, le créneau et le tarif; aucun rendez-vous ni paiement n’est confirmé à l’envoi.</label>
            <button className="button button-primary" disabled={submitting} type="submit">{submitting ? "Envoi en cours…" : "Envoyer ma demande à NEXA"}</button>
          </form>
          <section className="home-visit-history" aria-labelledby="home-visit-history-title">
            <h3 id="home-visit-history-title">Mes demandes</h3>
            {loadingRequests ? <p role="status">Chargement de vos demandes…</p> : requests.length ? <ul>{requests.map((item) => <li key={item.requestId}><div><strong>{statusLabels[item.status] || "Statut en cours de vérification"}</strong><span>{item.preferredDate ? `Date souhaitée : ${new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "long" }).format(new Date(`${item.preferredDate}T12:00:00Z`))}` : "Date souhaitée non renseignée"}</span><small>{[item.commune, item.department].filter(Boolean).join(" · ")}</small></div></li>)}</ul> : <p>Vous n’avez encore envoyé aucune demande de visite à domicile.</p>}
          </section>
        </>
      )}
    </div>
  );
}
