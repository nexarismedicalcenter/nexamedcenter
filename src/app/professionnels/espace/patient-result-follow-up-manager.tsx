"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";

type ResultFile = { id: string; category: string; fileName: string; contentType: string; size: number };
type PatientResult = {
  id: string; examName: string; examType: string; createdAt: string | null;
  patient: { name: string; patientNumber: string; sex: string; age: number | null };
  files: ResultFile[];
};
type MedicalProfile = {
  languages: string[];
  allergies: { yes: boolean; details: string };
  diabetes: { diagnosed: boolean; sinceMonth: string };
  hypertension: { diagnosed: boolean; sinceMonth: string };
  tobacco: { yes: boolean; details: string };
  alcohol: { yes: boolean; details: string };
  coffee: { yes: boolean; details: string };
  tea: { yes: boolean; details: string };
};
type ClinicalNote = { recordId: string; recordNumber: string; providerName: string; specialtyName: string; finalizedAt: string | null; clinicalContent: Record<string, unknown>; addenda: Array<{ reason: string; content: string; createdAt: string | null }> };
type FollowUpDetail = {
  result: { id: string; examName: string; examType: string; createdAt: string | null };
  patient: PatientResult["patient"];
  medicalProfile: MedicalProfile | null;
  history: { records: ClinicalNote[]; nextCursor: string | null };
  followUpActions: Array<{ id: string; type: string; content: string; createdAt: string | null; providerName: string }>;
  allowedActions: string[];
};
type ProviderSlot = { id: string; startsAt: string; endsAt: string; status: string };

function dateLabel(value: string | null) {
  if (!value) return "Date non renseignée";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date non renseignée" : new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(date);
}

function yesNo(value: { yes: boolean; details: string } | undefined) {
  if (!value) return "Non renseigné";
  return value.yes ? `Oui${value.details ? ` · ${value.details}` : ""}` : "Non";
}

export default function PatientResultFollowUpManager({ user }: { user: User }) {
  const [results, setResults] = useState<PatientResult[]>([]);
  const [detail, setDetail] = useState<FollowUpDetail | null>(null);
  const [slots, setSlots] = useState<ProviderSlot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState("");
  const [note, setNote] = useState("");
  const [medicine, setMedicine] = useState({ name: "", dosage: "", form: "", route: "", quantity: "", duration: "", instructions: "", notes: "" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const payload = await appointmentRequest<{ results: PatientResult[] }>(user, "/api/provider/patient-result-submissions");
      setResults(payload.results || []);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Les résultats patients ne sont pas disponibles."); }
    finally { setLoading(false); }
  }, [user]);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);

  async function openDossier(result: PatientResult) {
    setBusy(true); setError(""); setNotice("");
    try {
      const payload = await appointmentRequest<FollowUpDetail>(user, `/api/provider/patient-result-submissions/${encodeURIComponent(result.id)}`);
      setDetail(payload);
      const availability = await appointmentRequest<{ slots: ProviderSlot[] }>(user, "/api/provider/availability");
      setSlots((availability.slots || []).filter((slot) => slot.status === "available"));
      setSelectedSlot("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le dossier patient n’est pas accessible."); }
    finally { setBusy(false); }
  }

  async function openFile(result: PatientResult, file: ResultFile) {
    setBusy(true); setError(""); setNotice("");
    try {
      const payload = await appointmentRequest<{ url: string }>(user, `/api/provider/patient-result-submissions/${encodeURIComponent(result.id)}/files/${encodeURIComponent(file.id)}`);
      const target = new URL(payload.url);
      if (target.protocol !== "https:" || (target.hostname !== "storage.googleapis.com" && !target.hostname.endsWith(".storage.googleapis.com"))) throw new Error("Le lien sécurisé du résultat n’est pas valide.");
      window.location.assign(target.toString());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le document ne peut pas être ouvert."); }
    finally { setBusy(false); }
  }

  async function submitAction(action: "note" | "prescription" | "appointment" | "close", payload: Record<string, unknown> = {}) {
    if (!detail) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await appointmentRequest<{ followUpStatus?: string }>(user, `/api/provider/patient-result-submissions/${encodeURIComponent(detail.result.id)}/actions`, "POST", { action, ...payload });
      setNotice(action === "note" ? "La note de suivi a été ajoutée au dossier." : action === "prescription" ? "L’ordonnance a été transmise au patient." : action === "appointment" ? "La proposition de rendez-vous a été transmise au patient." : "L’accès de suivi est fermé.");
      if (action === "close") setDetail(null);
      else {
        const refreshed = await appointmentRequest<FollowUpDetail>(user, `/api/provider/patient-result-submissions/${encodeURIComponent(detail.result.id)}`);
        setDetail(refreshed);
        setNote("");
        if (action === "prescription") setMedicine({ name: "", dosage: "", form: "", route: "", quantity: "", duration: "", instructions: "", notes: "" });
      }
      await load();
      if (result.followUpStatus === "CLOSED") setDetail(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "L’action n’a pas pu être enregistrée."); }
    finally { setBusy(false); }
  }

  function submitNote(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void submitAction("note", { note }); }
  function submitPrescription(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitAction("prescription", { medication: { ...medicine, quantity: medicine.quantity === "" ? null : Number(medicine.quantity) }, notes: medicine.notes });
  }

  const profile = detail?.medicalProfile;
  return <section className="provider-slots patient-result-follow-up-manager" id="resultats-patient" aria-labelledby="provider-patient-results-heading">
    <div className="diagnostic-orders-heading"><h2 id="provider-patient-results-heading">Résultats disponibles des patients</h2><button className="button button-quiet" disabled={loading || busy} onClick={() => void load()} type="button">Actualiser</button></div>
    <p>Cette liste contient uniquement les résultats déposés par des patients suivis par votre profil médical.</p>
    {error ? <p className="form-error" role="alert">{error}</p> : null}{notice ? <p className="form-notice" role="status">{notice}</p> : null}
    {loading ? <p role="status">Chargement des résultats…</p> : results.length ? <ul>{results.map((result) => <li key={result.id}><div>
      <strong>{result.examName}</strong><span>{result.patient.name} · {result.patient.patientNumber} · {result.patient.sex} · {result.patient.age === null ? "Âge non renseigné" : `${result.patient.age} ans`}</span>
      <small>{result.examType === "laboratory" ? "Laboratoire" : "Imagerie"} · Déposé le {dateLabel(result.createdAt)}</small>
      <div className="provider-appointment-actions">{result.files.map((file) => <button className="button button-outline" disabled={busy} key={file.id} onClick={() => void openFile(result, file)} type="button">Ouvrir le document · {file.category}</button>)}<button className="button button-primary" disabled={busy} onClick={() => void openDossier(result)} type="button">Ouvrir le dossier et assurer le suivi</button></div>
    </div></li>)}</ul> : <p>Aucun résultat patient en attente de suivi.</p>}
    {detail ? <article className="patient-result-dossier">
      <div className="diagnostic-orders-heading"><div><p className="eyebrow">Dossier de suivi médical</p><h3>{detail.patient.name} · {detail.patient.patientNumber}</h3><p>{detail.patient.sex} · {detail.patient.age === null ? "Âge non renseigné" : `${detail.patient.age} ans`} · {detail.result.examName}</p></div><button className="button button-quiet" disabled={busy} onClick={() => setDetail(null)} type="button">Fermer</button></div>
      <section><h4>Fiche médicale du patient</h4>{profile ? <dl className="patient-medical-summary">
        <div><dt>Langues</dt><dd>{profile.languages.join(", ") || "Non renseigné"}</dd></div>
        <div><dt>Allergies</dt><dd>{yesNo(profile.allergies)}</dd></div>
        <div><dt>Diabète</dt><dd>{profile.diabetes.diagnosed ? `Oui · depuis ${profile.diabetes.sinceMonth}` : "Non"}</dd></div>
        <div><dt>Hypertension</dt><dd>{profile.hypertension.diagnosed ? `Oui · depuis ${profile.hypertension.sinceMonth}` : "Non"}</dd></div>
        <div><dt>Tabac</dt><dd>{yesNo(profile.tobacco)}</dd></div><div><dt>Alcool</dt><dd>{yesNo(profile.alcohol)}</dd></div>
        <div><dt>Café</dt><dd>{yesNo(profile.coffee)}</dd></div><div><dt>Thé</dt><dd>{yesNo(profile.tea)}</dd></div>
      </dl> : <p>Aucune fiche médicale initiale n’a été renseignée.</p>}</section>
      <section><h4>Notes signées des autres médecins</h4>{detail.history.records.length ? <ul>{detail.history.records.map((record) => <li key={record.recordId}><strong>{record.providerName}{record.specialtyName ? ` · ${record.specialtyName}` : ""}</strong><small>Finalisée le {dateLabel(record.finalizedAt)}</small>{Object.entries(record.clinicalContent || {}).filter(([key, value]) => key !== "patientVitals" && key !== "medications" && key !== "laboratoryTests" && key !== "imagingExams" && typeof value === "string" && value.trim()).map(([key, value]) => <p key={key}><strong>{key}</strong> — {String(value)}</p>)}{record.addenda.map((addendum, index) => <p key={`${record.recordId}-addendum-${index}`}><strong>Correction {dateLabel(addendum.createdAt)}:</strong> {addendum.content}</p>)}</li>)}</ul> : <p>Aucune note signée d’un autre médecin n’est disponible dans ce dossier.</p>}</section>
      {detail.followUpActions.length ? <section><h4>Actions de suivi déjà réalisées</h4><ul>{detail.followUpActions.map((action) => <li key={action.id}><strong>{action.type === "NOTE" ? "Note ajoutée" : action.type === "PRESCRIPTION" ? "Ordonnance transmise" : "Rendez-vous proposé"}</strong>{action.content ? <p>{action.content}</p> : null}<small>{dateLabel(action.createdAt)}</small></li>)}</ul></section> : null}
      <section className="patient-result-actions"><h4>Suivi du résultat</h4>
        <form onSubmit={submitNote}><label>Ajouter une note de suivi<textarea maxLength={5000} required value={note} onChange={(event) => setNote(event.target.value)} /></label><button className="button button-outline" disabled={busy || !note.trim()} type="submit">Ajouter la note au dossier</button></form>
        <form onSubmit={submitPrescription}><label>Médicament prescrit<input maxLength={180} required value={medicine.name} onChange={(event) => setMedicine((current) => ({ ...current, name: event.target.value }))} /></label><div className="patient-medication-grid"><label>Dosage<input maxLength={120} value={medicine.dosage} onChange={(event) => setMedicine((current) => ({ ...current, dosage: event.target.value }))} /></label><label>Forme<input maxLength={120} value={medicine.form} onChange={(event) => setMedicine((current) => ({ ...current, form: event.target.value }))} /></label><label>Voie<input maxLength={120} value={medicine.route} onChange={(event) => setMedicine((current) => ({ ...current, route: event.target.value }))} /></label><label>Durée<input maxLength={120} value={medicine.duration} onChange={(event) => setMedicine((current) => ({ ...current, duration: event.target.value }))} /></label><label>Quantité<input min="0" step="1" type="number" value={medicine.quantity} onChange={(event) => setMedicine((current) => ({ ...current, quantity: event.target.value }))} /></label></div><label>Instructions<textarea maxLength={500} value={medicine.instructions} onChange={(event) => setMedicine((current) => ({ ...current, instructions: event.target.value }))} /></label><label>Note sur l’ordonnance<textarea maxLength={1000} value={medicine.notes} onChange={(event) => setMedicine((current) => ({ ...current, notes: event.target.value }))} /></label><button className="button button-outline" disabled={busy || !medicine.name.trim()} type="submit">Valider et envoyer l’ordonnance</button></form>
        <form onSubmit={(event) => { event.preventDefault(); void submitAction("appointment", { slotId: selectedSlot }); }}><label>Proposer un rendez-vous de suivi<select required value={selectedSlot} onChange={(event) => setSelectedSlot(event.target.value)}><option value="">Choisir un créneau</option>{slots.map((slot) => <option key={slot.id} value={slot.id}>{dateLabel(slot.startsAt)}</option>)}</select></label><button className="button button-outline" disabled={busy || !selectedSlot} type="submit">Envoyer la proposition</button></form>
        <button className="button button-quiet" disabled={busy} onClick={() => { if (window.confirm("Fermer l’accès de suivi à ce résultat?")) void submitAction("close"); }} type="button">Terminer le suivi et fermer l’accès</button>
      </section>
    </article> : null}
    <p className="appointment-privacy">L’accès au résultat et à l’historique est réservé au médecin prescripteur. Chaque consultation et chaque action sont journalisées. Fermez l’accès lorsque le suivi est terminé.</p>
  </section>;
}
