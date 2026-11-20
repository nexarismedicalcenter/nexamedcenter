"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";

type DiagnosticProviderType = "laboratory" | "imaging";
type Offer = {
  id: string;
  name: string;
  category: string;
  catalogExamId: string;
  description: string;
  specimenType: string;
  preparation: string;
  precautions: string;
  technique: string;
  resultDelay: string;
  instructions: string;
  price: number;
  requiresPrescription: boolean;
  appointmentRequired: boolean;
  homeSampling: boolean;
  requestedAvailability: boolean;
  publicationStatus: string;
  reviewReason: string;
  providerType: DiagnosticProviderType;
};
type OfferForm = Omit<Offer, "id" | "publicationStatus" | "reviewReason" | "providerType">;

const blank: OfferForm = {
  name: "", category: "", catalogExamId: "", description: "", specimenType: "", preparation: "", precautions: "", technique: "", resultDelay: "", instructions: "", price: 0, requiresPrescription: false, appointmentRequired: false, homeSampling: false, requestedAvailability: true,
};

const statusLabels: Record<string, string> = {
  PENDING_REVIEW: "En attente de revue NEXA",
  NEEDS_CORRECTION: "Correction demandée",
  PUBLISHED: "Publié",
  REJECTED: "Refusé",
  SUSPENDED: "Suspendu",
  ARCHIVED: "Archivé",
};

export default function DiagnosticOfferManager({ user, providerType }: { user: User; providerType: DiagnosticProviderType }) {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [form, setForm] = useState<OfferForm>(blank);
  const [editingId, setEditingId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const organization = providerType === "laboratory" ? "laboratoire" : "centre d’imagerie";

  const load = useCallback(async () => {
    try {
      const result = await appointmentRequest<{ offers: Offer[] }>(user, "/api/provider/diagnostic-offers");
      setOffers(result.offers || []);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Les offres ne peuvent pas être chargées."); }
    finally { setLoading(false); }
  }, [user]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function edit(offer: Offer) {
    setEditingId(offer.id);
    setForm({
      name: offer.name, category: offer.category, catalogExamId: offer.catalogExamId, description: offer.description,
      specimenType: offer.specimenType, preparation: offer.preparation, precautions: offer.precautions, technique: offer.technique,
      resultDelay: offer.resultDelay, instructions: offer.instructions, price: offer.price, requiresPrescription: offer.requiresPrescription,
      appointmentRequired: offer.appointmentRequired, homeSampling: offer.homeSampling, requestedAvailability: offer.requestedAvailability,
    });
    setError(""); setNotice("");
  }

  function clearForm() { setEditingId(""); setForm(blank); }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      await appointmentRequest(user, "/api/provider/diagnostic-offers", "POST", { ...form, ...(editingId ? { offerId: editingId } : {}) });
      setNotice("La fiche a été envoyée à NEXA pour revue. Elle sera visible après approbation.");
      clearForm();
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "L’offre n’a pas pu être enregistrée."); }
    finally { setBusy(false); }
  }

  async function archive(offer: Offer) {
    if (!window.confirm(`Archiver « ${offer.name} » ?`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await appointmentRequest(user, "/api/provider/diagnostic-offers", "DELETE", { offerId: offer.id });
      if (editingId === offer.id) clearForm();
      setNotice("L’offre est archivée et retirée du catalogue public.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "L’offre n’a pas pu être archivée."); }
    finally { setBusy(false); }
  }

  return <section className="diagnostic-offers" aria-labelledby="diagnostic-offers-heading">
    <div className="diagnostic-offers-heading"><p className="eyebrow">Espace partenaire NEXA</p><h2 id="diagnostic-offers-heading">Offres de {organization}.</h2><p>Les tarifs, consignes et offres de service passent par une revue NEXA. Aucun dossier ou résultat médical ne doit être ajouté ici.</p></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}{notice ? <p className="form-notice" role="status">{notice}</p> : null}
    <form className="auth-form diagnostic-offer-form" onSubmit={(event) => void save(event)}>
      <h3>{editingId ? "Modifier l’offre" : "Ajouter une offre"}</h3>
      <div className="form-grid two-columns">
        <label>Nom de l’examen ou du service<input required maxLength={180} value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label>
        <label>Catégorie<input maxLength={120} value={form.category} onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))} /></label>
        <label>Identifiant du référentiel, si connu<input maxLength={120} value={form.catalogExamId} onChange={(event) => setForm((current) => ({ ...current, catalogExamId: event.target.value }))} /></label>
        <label>Prix (HTG)<input required min="0" max="10000000" step="1" type="number" value={form.price} onChange={(event) => setForm((current) => ({ ...current, price: Number(event.target.value) }))} /></label>
        {providerType === "laboratory" ? <label>Type de prélèvement<input maxLength={120} placeholder="Sang, urine…" value={form.specimenType} onChange={(event) => setForm((current) => ({ ...current, specimenType: event.target.value }))} /></label> : <label>Technique ou modalité<input maxLength={180} placeholder="Radiographie, échographie…" value={form.technique} onChange={(event) => setForm((current) => ({ ...current, technique: event.target.value }))} /></label>}
        <label>Délai indicatif de résultat<input maxLength={160} placeholder="Ex. 24 à 48 heures" value={form.resultDelay} onChange={(event) => setForm((current) => ({ ...current, resultDelay: event.target.value }))} /></label>
      </div>
      <label>Description publique<textarea rows={3} maxLength={500} value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label>
      <label>Préparation du patient<textarea rows={3} maxLength={1000} value={form.preparation} onChange={(event) => setForm((current) => ({ ...current, preparation: event.target.value }))} /></label>
      {providerType === "imaging" ? <label>Précautions<textarea rows={2} maxLength={1000} value={form.precautions} onChange={(event) => setForm((current) => ({ ...current, precautions: event.target.value }))} /></label> : null}
      <label>Consignes et modalités<textarea rows={3} maxLength={1200} value={form.instructions} onChange={(event) => setForm((current) => ({ ...current, instructions: event.target.value }))} /></label>
      <div className="diagnostic-offer-options">
        <label><input checked={form.requiresPrescription} onChange={(event) => setForm((current) => ({ ...current, requiresPrescription: event.target.checked }))} type="checkbox" />Une ordonnance validée est requise</label>
        <label><input checked={form.appointmentRequired} onChange={(event) => setForm((current) => ({ ...current, appointmentRequired: event.target.checked }))} type="checkbox" />Le patient doit prendre rendez-vous</label>
        {providerType === "laboratory" ? <label><input checked={form.homeSampling} onChange={(event) => setForm((current) => ({ ...current, homeSampling: event.target.checked }))} type="checkbox" />Prélèvement à domicile proposé</label> : null}
        <label><input checked={form.requestedAvailability} onChange={(event) => setForm((current) => ({ ...current, requestedAvailability: event.target.checked }))} type="checkbox" />Offre disponible à la publication</label>
      </div>
      <div className="prescription-actions"><button className="button button-primary" disabled={busy} type="submit">{busy ? "Enregistrement…" : editingId ? "Envoyer les changements en revue" : "Envoyer pour revue"}</button>{editingId ? <button className="button button-outline" disabled={busy} onClick={clearForm} type="button">Annuler la modification</button> : null}</div>
    </form>
    <div className="diagnostic-offer-list"><h3>Vos offres</h3>{loading ? <p role="status">Chargement des offres…</p> : offers.length ? offers.map((offer) => <article className="diagnostic-offer-card" key={offer.id}><div><strong>{offer.name}</strong><span>{offer.category || (offer.providerType === "laboratory" ? "Analyse de laboratoire" : "Examen d’imagerie")} · {new Intl.NumberFormat("fr-HT").format(offer.price)} HTG</span><small>{statusLabels[offer.publicationStatus] || offer.publicationStatus}{offer.requestedAvailability ? " · Disponibilité demandée" : " · Indisponible"}</small>{offer.preparation ? <small>Préparation : {offer.preparation}</small> : null}{offer.reviewReason ? <small>Note de revue : {offer.reviewReason}</small> : null}{offer.requiresPrescription ? <small>Ordonnance requise</small> : null}</div><div className="prescription-actions"><button className="button button-outline" disabled={busy} onClick={() => edit(offer)} type="button">Modifier</button><button className="button button-quiet" disabled={busy || offer.publicationStatus === "ARCHIVED"} onClick={() => void archive(offer)} type="button">Archiver</button></div></article>) : <p>Aucune offre enregistrée pour ce profil.</p>}</div>
  </section>;
}
