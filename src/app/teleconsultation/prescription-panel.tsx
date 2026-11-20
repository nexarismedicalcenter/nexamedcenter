"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { getToken } from "firebase/app-check";
import { appointmentRequest } from "@/lib/appointments/client";
import { getFirebaseAppCheck } from "@/lib/firebase/client";

type Medication = { name: string; dosage: string; form: string; route: string; quantity: string; duration: string; instructions: string };
type Prescription = {
  id: string;
  appointmentId: string;
  providerName: string;
  specialtyName: string;
  medications: Medication[];
  labExams: string[];
  imagingExams: string[];
  notes: string;
  status: string;
  version: number;
  previousVersionId?: string | null;
  validatedAt: string | null;
  signature?: { name?: string; specialty?: string; signedAt?: string } | null;
};

const emptyMedication = (): Medication => ({ name: "", dosage: "", form: "", route: "", quantity: "", duration: "", instructions: "" });
const emptyContent = () => ({ medications: [] as Medication[], labExams: [] as string[], imagingExams: [] as string[], notes: "" });

export default function PrescriptionPanel({ user, appointmentId }: { user: User; appointmentId: string }) {
  const [view, setView] = useState<"provider" | "patient" | "">("");
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [editing, setEditing] = useState<"draft" | "correct" | "">("");
  const [content, setContent] = useState(emptyContent);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await appointmentRequest<{ view: "provider" | "patient"; prescriptions: Prescription[] }>(user, `/api/appointments/${encodeURIComponent(appointmentId)}/prescriptions`);
      setView(result.view);
      setPrescriptions(result.prescriptions || []);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Les ordonnances ne sont pas accessibles."); }
    finally { setLoading(false); }
  }, [appointmentId, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selected = prescriptions.find((item) => item.id === selectedId) || null;

  async function createDraft() {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await appointmentRequest<{ prescriptionId: string }>(user, `/api/appointments/${encodeURIComponent(appointmentId)}/prescriptions`, "POST", { action: "createDraft", content: emptyContent() });
      await load();
      setSelectedId(result.prescriptionId);
      setEditing("draft");
      setContent(emptyContent());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le brouillon n’a pas pu être créé."); }
    finally { setBusy(false); }
  }

  function beginDraft(prescription: Prescription) {
    setSelectedId(prescription.id);
    setEditing("draft");
    setContent({ medications: (prescription.medications || []).map((item) => ({ ...emptyMedication(), ...item, quantity: item.quantity == null ? "" : String(item.quantity) })), labExams: prescription.labExams || [], imagingExams: prescription.imagingExams || [], notes: prescription.notes || "" });
    setError(""); setNotice("");
  }

  function beginCorrection(prescription: Prescription) {
    setSelectedId(prescription.id);
    setEditing("correct");
    setContent({ medications: (prescription.medications || []).map((item) => ({ ...emptyMedication(), ...item, quantity: item.quantity == null ? "" : String(item.quantity) })), labExams: prescription.labExams || [], imagingExams: prescription.imagingExams || [], notes: prescription.notes || "" });
    setError(""); setNotice("");
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true); setError(""); setNotice("");
    const clean = {
      medications: content.medications.filter((item) => item.name.trim()).map((item) => ({ ...item, quantity: item.quantity ? Number(item.quantity) : null })),
      labExams: content.labExams.map((item) => item.trim()).filter(Boolean),
      imagingExams: content.imagingExams.map((item) => item.trim()).filter(Boolean),
      notes: content.notes.trim(),
    };
    try {
      await appointmentRequest(user, `/api/appointments/${encodeURIComponent(appointmentId)}/prescriptions`, "POST", editing === "draft"
        ? { action: "updateDraft", prescriptionId: selected.id, content: clean }
        : { action: "correct", prescriptionId: selected.id, content: clean });
      setEditing("");
      setNotice(editing === "draft" ? "Brouillon enregistré." : "Nouvelle version validée et transmise au patient.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "L’ordonnance n’a pas pu être enregistrée."); }
    finally { setBusy(false); }
  }

  async function validate() {
    if (!selected) return;
    setBusy(true); setError(""); setNotice("");
    const clean = {
      medications: content.medications.filter((item) => item.name.trim()).map((item) => ({ ...item, quantity: item.quantity ? Number(item.quantity) : null })),
      labExams: content.labExams.map((item) => item.trim()).filter(Boolean),
      imagingExams: content.imagingExams.map((item) => item.trim()).filter(Boolean),
      notes: content.notes.trim(),
    };
    try {
      await appointmentRequest(user, `/api/appointments/${encodeURIComponent(appointmentId)}/prescriptions`, "POST", { action: "updateDraft", prescriptionId: selected.id, content: clean });
      await appointmentRequest(user, `/api/appointments/${encodeURIComponent(appointmentId)}/prescriptions`, "POST", { action: "validate", prescriptionId: selected.id });
      setEditing("");
      setNotice("Ordonnance validée et transmise au patient.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "L’ordonnance n’a pas pu être validée."); }
    finally { setBusy(false); }
  }

  async function downloadPdf(prescription: Prescription) {
    setBusy(true); setError("");
    try {
      const headers = new Headers({ Authorization: `Bearer ${await user.getIdToken()}` });
      const appCheck = getFirebaseAppCheck();
      if (process.env.NODE_ENV === "production" && !appCheck) throw new Error("La protection App Check de NEXA n’est pas configurée.");
      if (appCheck) headers.set("X-Firebase-AppCheck", (await getToken(appCheck)).token);
      const response = await fetch(`/api/prescriptions/${encodeURIComponent(prescription.id)}/pdf`, { headers, cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || "Le document n’a pas pu être téléchargé.");
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `nexa-ordonnance-v${prescription.version}.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le PDF n’a pas pu être téléchargé."); }
    finally { setBusy(false); }
  }

  function updateMedication(index: number, field: keyof Medication, value: string) {
    setContent((current) => ({ ...current, medications: current.medications.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item) }));
  }

  return <section className="prescription-panel" aria-labelledby="prescription-panel-heading">
    <p className="eyebrow">Prescription</p><h2 id="prescription-panel-heading">Ordonnances.</h2>
    {loading ? <p role="status">Chargement des ordonnances…</p> : null}
    {error ? <div className="form-error" role="alert">{error}<button className="button button-outline" disabled={busy} onClick={() => void load()} type="button">Réessayer</button></div> : null}
    {notice ? <p className="form-notice" role="status">{notice}</p> : null}
    {!loading && view === "provider" ? <>
      <div className="prescription-list">{prescriptions.length ? prescriptions.map((prescription) => <article className="prescription-card" key={prescription.id}>
        <div><strong>Version {prescription.version} · {prescription.status === "VALIDATED" ? "Validée" : prescription.status === "REPLACED" ? "Remplacée" : "Brouillon"}</strong><small>{prescription.providerName}{prescription.validatedAt ? ` · ${new Intl.DateTimeFormat("fr-HT", { dateStyle: "medium" }).format(new Date(prescription.validatedAt))}` : ""}</small></div>
        <div className="prescription-actions">{prescription.status === "DRAFT" ? <button className="button button-outline" disabled={busy} onClick={() => beginDraft(prescription)} type="button">Modifier le brouillon</button> : null}{prescription.status === "VALIDATED" ? <><button className="button button-outline" disabled={busy} onClick={() => beginCorrection(prescription)} type="button">Créer une version corrigée</button><button className="button button-quiet" disabled={busy} onClick={() => void downloadPdf(prescription)} type="button">Télécharger le PDF</button></> : null}</div>
      </article>) : <p>Aucune ordonnance pour cette consultation.</p>}</div>
      {!editing ? <button className="button button-outline" disabled={busy} onClick={() => void createDraft()} type="button">Créer une ordonnance</button> : <form className="auth-form prescription-form" onSubmit={(event) => void saveDraft(event)}>
        <h3>{editing === "draft" ? "Brouillon d’ordonnance" : "Nouvelle version corrigée"}</h3>
        <div className="prescription-medications"><strong>Médicaments</strong>{content.medications.map((medication, index) => <fieldset className="prescription-medication" key={index}><legend>Médicament {index + 1}</legend><div className="form-grid two-columns"><label>Nom<input value={medication.name} onChange={(event) => updateMedication(index, "name", event.target.value)} maxLength={180} /></label><label>Dosage<input value={medication.dosage} onChange={(event) => updateMedication(index, "dosage", event.target.value)} maxLength={120} /></label><label>Forme<input value={medication.form} onChange={(event) => updateMedication(index, "form", event.target.value)} maxLength={120} /></label><label>Voie<input value={medication.route} onChange={(event) => updateMedication(index, "route", event.target.value)} maxLength={120} /></label><label>Quantité<input type="number" min="0" max="1000000" value={medication.quantity} onChange={(event) => updateMedication(index, "quantity", event.target.value)} /></label><label>Durée<input value={medication.duration} onChange={(event) => updateMedication(index, "duration", event.target.value)} maxLength={120} /></label></div><label>Instructions<textarea value={medication.instructions} onChange={(event) => updateMedication(index, "instructions", event.target.value)} rows={2} maxLength={500} /></label><button className="button button-quiet" onClick={() => setContent((current) => ({ ...current, medications: current.medications.filter((_, itemIndex) => itemIndex !== index) }))} type="button">Retirer</button></fieldset>)}<button className="button button-outline" onClick={() => setContent((current) => ({ ...current, medications: [...current.medications, emptyMedication()] }))} type="button">Ajouter un médicament</button></div>
        <label>Examens de laboratoire<textarea rows={3} value={content.labExams.join("\n")} onChange={(event) => setContent((current) => ({ ...current, labExams: event.target.value.split("\n") }))} maxLength={5000} /></label>
        <label>Examens d’imagerie<textarea rows={3} value={content.imagingExams.join("\n")} onChange={(event) => setContent((current) => ({ ...current, imagingExams: event.target.value.split("\n") }))} maxLength={5000} /></label>
        <label>Notes<textarea rows={3} value={content.notes} onChange={(event) => setContent((current) => ({ ...current, notes: event.target.value }))} maxLength={1000} /></label>
        <div className="prescription-actions"><button className="button button-outline" disabled={busy} type="submit">{busy ? "Enregistrement…" : editing === "draft" ? "Enregistrer le brouillon" : "Valider la nouvelle version"}</button>{editing === "draft" ? <button className="button button-primary" disabled={busy} onClick={() => void validate()} type="button">Valider et transmettre</button> : null}<button className="button button-quiet" disabled={busy} onClick={() => setEditing("")} type="button">Fermer</button></div>
      </form>}
    </> : null}
    {!loading && view === "patient" ? <div className="prescription-list">{prescriptions.length ? prescriptions.map((prescription) => <article className="prescription-card prescription-patient-card" key={prescription.id}>
      <div><strong>Ordonnance · Version {prescription.version}</strong><small>{prescription.providerName} · {prescription.specialtyName || "Consultation"}{prescription.validatedAt ? ` · ${new Intl.DateTimeFormat("fr-HT", { dateStyle: "medium" }).format(new Date(prescription.validatedAt))}` : ""}</small></div>
      {prescription.medications.length ? <div><h3>Médicaments</h3><ul>{prescription.medications.map((medication, index) => <li key={`${medication.name}-${index}`}><strong>{medication.name}</strong><span>{[medication.dosage, medication.form, medication.route, medication.duration].filter(Boolean).join(" · ")}</span>{medication.instructions ? <small>{medication.instructions}</small> : null}</li>)}</ul></div> : null}
      {prescription.labExams.length ? <div><h3>Laboratoire</h3><p>{prescription.labExams.join(" · ")}</p></div> : null}
      {prescription.imagingExams.length ? <div><h3>Imagerie</h3><p>{prescription.imagingExams.join(" · ")}</p></div> : null}
      {prescription.notes ? <div><h3>Notes du médecin</h3><p>{prescription.notes}</p></div> : null}
      <button className="button button-outline" disabled={busy} onClick={() => void downloadPdf(prescription)} type="button">Télécharger l’ordonnance PDF</button>
    </article>) : <p>Aucune ordonnance validée pour cette consultation.</p>}</div> : null}
  </section>;
}
