"use client";

import { FormEvent, useState } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";
import { haitiLocalDateTimeToIso } from "@/lib/appointments/time";

const ratingOptions = [
  ["punctuality", "Ponctualité"],
  ["professionalism", "Professionnalisme"],
  ["listening", "Écoute"],
  ["explanations", "Clarté des explications"],
  ["satisfaction", "Satisfaction globale"],
] as const;

export default function HomeVisitFeedbackForm({ user, appointmentId, onSubmitted }: { user: User; appointmentId: string; onSubmitted: () => void }) {
  const [providerPresent, setProviderPresent] = useState("");
  const [identityMatched, setIdentityMatched] = useState("");
  const [serviceCompletion, setServiceCompletion] = useState("COMPLETED");
  const [examPerformed, setExamPerformed] = useState(false);
  const [prescriptionProvided, setPrescriptionProvided] = useState(false);
  const [additionalExamsRecommended, setAdditionalExamsRecommended] = useState(false);
  const [questionsAnswered, setQuestionsAnswered] = useState(false);
  const [visitStartedAt, setVisitStartedAt] = useState("");
  const [visitEndedAt, setVisitEndedAt] = useState("");
  const [ratings, setRatings] = useState<Record<string, string>>({});
  const [comment, setComment] = useState("");
  const [signatureName, setSignatureName] = useState(user.displayName || "");
  const [signerRole, setSignerRole] = useState("PATIENT");
  const [signatureConsent, setSignatureConsent] = useState(false);
  const [refundMethod, setRefundMethod] = useState<"NEXA_WALLET" | "CASH_MANUAL">("NEXA_WALLET");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (providerPresent === "") return setError("Indiquez si le médecin s’est présenté.");
    const present = providerPresent === "yes";
    const started = present ? haitiLocalDateTimeToIso(visitStartedAt) : null;
    const ended = present ? haitiLocalDateTimeToIso(visitEndedAt) : null;
    if (present && (!started || !ended)) return setError("Saisissez les heures de début et de fin selon l’heure d’Haïti.");
    setBusy(true); setError("");
    try {
      await appointmentRequest(user, `/api/appointments/${encodeURIComponent(appointmentId)}/home-visit-feedback`, "POST", {
        providerPresent: present,
        identityMatched: present ? identityMatched === "yes" : false,
        serviceCompletion: present ? serviceCompletion : "NOT_COMPLETED",
        examPerformed: present && examPerformed,
        prescriptionProvided: present && prescriptionProvided,
        additionalExamsRecommended: present && additionalExamsRecommended,
        questionsAnswered: present && questionsAnswered,
        visitStartedAt: started,
        visitEndedAt: ended,
        ratings: present ? Object.fromEntries(Object.entries(ratings).map(([key, value]) => [key, Number(value)])) : {},
        comment,
        signatureName,
        signerRole,
        patientConfirmed: true,
        signatureConsent,
        refundMethod,
      });
      onSubmitted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Le formulaire n’a pas pu être transmis.");
    } finally { setBusy(false); }
  }

  return <form className="auth-form home-visit-feedback" onSubmit={(event) => void submit(event)}>
    <h3>Confirmer la visite à domicile</h3>
    <p>Ce formulaire est enregistré dans votre dossier privé. Ne partagez le code de clôture qu’après avoir vérifié la présence du médecin.</p>
    <label>Le médecin s’est-il présenté ?<select required value={providerPresent} onChange={(event) => { setProviderPresent(event.target.value); if (event.target.value !== "no") setRefundMethod("NEXA_WALLET"); }}><option value="">Choisir</option><option value="yes">Oui</option><option value="no">Non</option></select></label>
    {providerPresent === "yes" ? <>
      <label>L’identité du médecin correspondait-elle au professionnel réservé ?<select required value={identityMatched} onChange={(event) => setIdentityMatched(event.target.value)}><option value="">Choisir</option><option value="yes">Oui</option><option value="no">Non</option></select></label>
      <label>État du service<select required value={serviceCompletion} onChange={(event) => setServiceCompletion(event.target.value)}><option value="COMPLETED">Service complet</option><option value="PARTIAL">Service partiel</option><option value="NOT_COMPLETED">Service non réalisé</option></select></label>
      <div className="form-grid two-columns"><label>Début de la visite (heure d’Haïti)<input required type="datetime-local" value={visitStartedAt} onChange={(event) => setVisitStartedAt(event.target.value)} /></label><label>Fin de la visite (heure d’Haïti)<input required type="datetime-local" value={visitEndedAt} onChange={(event) => setVisitEndedAt(event.target.value)} /></label></div>
      {serviceCompletion !== "NOT_COMPLETED" ? <>
        <fieldset className="nursing-services-fieldset"><legend>Déroulement</legend>
          <label><input checked={examPerformed} onChange={(event) => setExamPerformed(event.target.checked)} type="checkbox" /> Un examen a été réalisé</label>
          <label><input checked={prescriptionProvided} onChange={(event) => setPrescriptionProvided(event.target.checked)} type="checkbox" /> Une ordonnance a été remise</label>
          <label><input checked={additionalExamsRecommended} onChange={(event) => setAdditionalExamsRecommended(event.target.checked)} type="checkbox" /> Des examens complémentaires ont été recommandés</label>
          <label><input checked={questionsAnswered} onChange={(event) => setQuestionsAnswered(event.target.checked)} type="checkbox" /> Mes questions ont reçu une réponse</label>
        </fieldset>
      </> : <p role="status">La visite sera transmise à NEXA pour vérification. Aucun code de clôture ne sera activé.</p>}
      <fieldset className="nursing-services-fieldset"><legend>Évaluation (1 à 5)</legend>{ratingOptions.map(([key, label]) => <label key={key}>{label}<select required value={ratings[key] || ""} onChange={(event) => setRatings((current) => ({ ...current, [key]: event.target.value }))}><option value="">Choisir</option>{[1, 2, 3, 4, 5].map((rating) => <option key={rating} value={rating}>{rating}</option>)}</select></label>)}</fieldset>
    </> : providerPresent === "no" ? <>
      <label>Mode de remboursement souhaité<select value={refundMethod} onChange={(event) => setRefundMethod(event.target.value as "NEXA_WALLET" | "CASH_MANUAL")}><option value="NEXA_WALLET">Portefeuille NEXA (par défaut)</option><option value="CASH_MANUAL">Demander un remboursement manuel en espèces</option></select></label>
      <p role="status">Le remboursement porte sur le prix du service; les frais de transaction ne sont pas remboursés.{refundMethod === "CASH_MANUAL" ? " NEXA examinera la demande et l’administration devra remettre les espèces puis enregistrer le reçu. Aucun crédit Wallet ne sera fait en parallèle." : " Le prix du service sera crédité dans votre portefeuille NEXA après vérification."}</p>
    </> : null}
    <label>Commentaire facultatif<textarea maxLength={500} value={comment} onChange={(event) => setComment(event.target.value)} /></label>
    <div className="form-grid two-columns"><label>Nom du signataire<input autoComplete="name" maxLength={160} required value={signatureName} onChange={(event) => setSignatureName(event.target.value)} /></label><label>Vous signez en tant que<select value={signerRole} onChange={(event) => setSignerRole(event.target.value)}><option value="PATIENT">Patient</option><option value="REPRESENTATIVE">Représentant</option></select></label></div>
    <label className="home-visit-signature-consent"><input required type="checkbox" checked={signatureConsent} onChange={(event) => setSignatureConsent(event.target.checked)} /> Je confirme les réponses ci-dessus et accepte que mon nom soit conservé comme signature électronique de ce formulaire.</label>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <button className="button button-primary" disabled={busy} type="submit">{busy ? "Transmission sécurisée…" : "Envoyer la confirmation"}</button>
  </form>;
}
