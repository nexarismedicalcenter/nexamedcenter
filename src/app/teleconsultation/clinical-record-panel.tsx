"use client";

import { FormEvent, useCallback, useEffect, useState, type ChangeEvent } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";
import PatientClinicalHistory from "./patient-clinical-history";

type ClinicalContent = {
  consultationReason?: string;
  relevantHistory?: string;
  allergies?: string;
  currentTreatments?: string;
  symptoms?: string;
  history?: string;
  clinicalObservations?: string;
  clinicalAssessment?: string;
  diagnoses?: string;
  carePlan?: string;
  recommendations?: string;
  followUp?: string;
  additionalNotes?: string;
  patientVitals?: Record<string, string | number | null>;
  medications?: Array<{ name?: string; dosage?: string; form?: string; route?: string; quantity?: number | null; instructions?: string; duration?: string }>;
  laboratoryTests?: string[];
  imagingExams?: string[];
};

type ClinicalAddendum = {
  id: string;
  reason: string;
  content: string;
  signatureName: string;
  createdAt: string | null;
};

type ClinicalAttachment = { id: string; originalFileName: string; contentType: string; size: number; uploadedAt: string };
type ClinicalRevision = { version: number; status: string; changeType: string; createdAt: string | null; clinicalContent: ClinicalContent; attachments: ClinicalAttachment[]; signature: { name?: string; specialty?: string; signedAt?: string } | null; documentHash: string | null };

type ClinicalRecord = {
  recordId?: string;
  recordType?: string;
  appointmentId: string;
  recordNumber: string;
  patientNumber: string;
  providerName: string;
  specialtyName: string;
  status: string;
  version: number;
  clinicalContent: ClinicalContent;
  attachments: ClinicalAttachment[];
  createdAt: string | null;
  updatedAt: string | null;
  finalizedAt: string | null;
  signature: { name?: string; specialty?: string; signedAt?: string } | null;
  documentHash: string | null;
  addendumCount: number;
  addenda: ClinicalAddendum[];
};

type PatientIdentity = { firstName: string; lastName: string; birthDate: string; sex: string };
type PatientMedicalProfile = {
  languages: string[];
  allergies: { yes: boolean; details: string } | null;
  diabetes: { diagnosed: boolean; sinceMonth: string } | null;
  hypertension: { diagnosed: boolean; sinceMonth: string } | null;
  tobacco: { yes: boolean; details: string } | null;
  alcohol: { yes: boolean; details: string } | null;
  coffee: { yes: boolean; details: string } | null;
  tea: { yes: boolean; details: string } | null;
  updatedAt: string | null;
};

type PatientRecordSummary = Pick<ClinicalRecord, "recordNumber" | "status" | "providerName" | "specialtyName" | "createdAt" | "finalizedAt">;

export default function ClinicalRecordPanel({ user, appointmentId, recordId }: { user: User; appointmentId?: string; recordId?: string }) {
  const [view, setView] = useState<"provider" | "patient" | "">("");
  const [record, setRecord] = useState<ClinicalRecord | null>(null);
  const [patientRecord, setPatientRecord] = useState<PatientRecordSummary | null>(null);
  const [patientIdentity, setPatientIdentity] = useState<PatientIdentity | null>(null);
  const [patientMedicalProfile, setPatientMedicalProfile] = useState<PatientMedicalProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [downloadingAttachment, setDownloadingAttachment] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [history, setHistory] = useState<ClinicalRevision[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const recordPath = recordId
    ? `/api/provider/clinical-records/${encodeURIComponent(recordId)}`
    : `/api/appointments/${encodeURIComponent(appointmentId || "")}/clinical-record`;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await appointmentRequest<{
        view: "provider" | "patient";
        record: ClinicalRecord | PatientRecordSummary | null;
        patientIdentity?: PatientIdentity;
        patientMedicalProfile?: PatientMedicalProfile | null;
      }>(user, recordPath);
      setView(result.view);
      if (result.view === "provider") {
        setRecord(result.record as ClinicalRecord | null);
        setPatientRecord(null);
        setPatientIdentity(result.patientIdentity || null);
        setPatientMedicalProfile(result.patientMedicalProfile || null);
      } else {
        setPatientRecord(result.record as PatientRecordSummary | null);
        setRecord(null);
        setPatientIdentity(null);
        setPatientMedicalProfile(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Le dossier n’est pas accessible.");
    } finally { setLoading(false); }
  }, [recordPath, user]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!record) return;
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const action = submitter?.value === "finalize" ? "finalize" : "saveDraft";
    if (action === "finalize" && !window.confirm("Après finalisation, le dossier ne pourra plus être modifié; une correction devra être ajoutée à son historique. Finaliser ce dossier ?")) return;
    const data = new FormData(form);
    const text = (field: string) => String(data.get(field) || "").trim();
    const numeric = (field: string) => text(field) ? Number(text(field)) : null;
    const lines = (field: string) => text(field).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 50);
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await appointmentRequest<{ record: ClinicalRecord }>(user, recordPath, "POST", {
        action,
        clinicalContent: {
          ...record.clinicalContent,
          consultationReason: text("consultationReason"),
          relevantHistory: text("relevantHistory"),
          allergies: text("allergies"),
          currentTreatments: text("currentTreatments"),
          symptoms: text("symptoms"),
          history: text("history"),
          clinicalObservations: text("clinicalObservations"),
          clinicalAssessment: text("clinicalAssessment"),
          diagnoses: text("diagnoses"),
          carePlan: text("carePlan"),
          recommendations: text("recommendations"),
          followUp: text("followUp"),
          additionalNotes: text("additionalNotes"),
          laboratoryTests: lines("laboratoryTests"),
          imagingExams: lines("imagingExams"),
          patientVitals: {
            systolic: numeric("systolic"), diastolic: numeric("diastolic"), heartRate: numeric("heartRate"),
            respiratoryRate: numeric("respiratoryRate"), spo2: numeric("spo2"), glycemia: numeric("glycemia"),
            temperature: numeric("temperature"), weight: numeric("weight"), height: numeric("height"),
            weightUnit: text("weightUnit") || "kg", heightUnit: text("heightUnit") || "cm",
          },
        },
      });
      setRecord(result.record);
      setHistory([]); setHistoryCursor(null);
      if (historyOpen) void loadHistory();
      setNotice(action === "finalize" ? "Dossier finalisé et verrouillé." : "Brouillon enregistré.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le dossier n’a pas pu être enregistré."); }
    finally { setBusy(false); }
  }

  async function addAddendum(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!record) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await appointmentRequest<{ record: ClinicalRecord }>(user, recordPath, "POST", {
        action: "addendum", reason: String(data.get("reason") || "").trim(), content: String(data.get("content") || "").trim(),
      });
      setRecord(result.record);
      form.reset();
      setNotice("Correction ajoutée à l’historique du dossier.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "La correction n’a pas pu être ajoutée."); }
    finally { setBusy(false); }
  }

  async function uploadAttachment(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || !record || locked) return;
    if (file.size < 1 || file.size > 15 * 1024 * 1024 || !["application/pdf", "image/jpeg", "image/png"].includes(file.type)) {
      setError("Choisissez un PDF, JPEG ou PNG de 15 Mio maximum.");
      return;
    }
    setAttachmentBusy(true); setError(""); setNotice("");
    let uploadId = "";
    try {
      const path = `${recordPath}/attachments`;
      const start = await appointmentRequest<{ uploadUrl: string; fields: Record<string, string>; uploadId: string }>(user, path, "POST", {
        action: "start", fileName: file.name, contentType: file.type, size: file.size,
      });
      uploadId = start.uploadId;
      const form = new FormData();
      for (const [key, value] of Object.entries(start.fields)) form.append(key, value);
      form.append("file", file);
      const upload = await fetch(start.uploadUrl, { method: "POST", body: form, cache: "no-store" });
      if (!upload.ok) throw new Error("Le fichier n’a pas été envoyé. Vérifiez votre connexion puis réessayez.");
      const finalized = await appointmentRequest<{ attachment: ClinicalAttachment; recordVersion: number }>(user, path, "POST", { action: "finalize", uploadId });
      setRecord((current) => current ? { ...current, attachments: [...(current.attachments || []), finalized.attachment], version: finalized.recordVersion } : current);
      setHistory([]); setHistoryCursor(null);
      if (historyOpen) void loadHistory();
      setNotice("Pièce jointe analysée et ajoutée au brouillon.");
    } catch (cause) {
      if (uploadId) await appointmentRequest(user, `${recordPath}/attachments`, "DELETE", { uploadId }).catch(() => undefined);
      setError(cause instanceof Error ? cause.message : "La pièce jointe ne peut pas être ajoutée.");
    } finally { setAttachmentBusy(false); }
  }

  async function removeAttachment(attachmentId: string) {
    if (!record || locked || !window.confirm("Retirer cette pièce jointe du brouillon ?")) return;
    setAttachmentBusy(true); setError(""); setNotice("");
    try {
      const result = await appointmentRequest<{ recordVersion: number }>(user, `${recordPath}/attachments`, "DELETE", { attachmentId });
      setRecord((current) => current ? { ...current, attachments: current.attachments.filter((attachment) => attachment.id !== attachmentId), version: result.recordVersion } : current);
      setHistory([]); setHistoryCursor(null);
      if (historyOpen) void loadHistory();
      setNotice("Pièce jointe retirée du brouillon.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "La pièce jointe n’a pas pu être retirée."); }
    finally { setAttachmentBusy(false); }
  }

  async function downloadAttachment(attachment: ClinicalAttachment) {
    setDownloadingAttachment(attachment.id); setError("");
    try {
      const result = await appointmentRequest<{ url: string }>(user, `${recordPath}/attachments?attachmentId=${encodeURIComponent(attachment.id)}`);
      const link = document.createElement("a");
      link.href = result.url;
      link.rel = "noopener noreferrer";
      link.click();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "La pièce jointe ne peut pas être téléchargée."); }
    finally { setDownloadingAttachment(""); }
  }

  async function loadHistory(beforeVersion?: number | null) {
    setHistoryLoading(true); setHistoryError("");
    try {
      const query = beforeVersion ? `?beforeVersion=${encodeURIComponent(String(beforeVersion))}` : "";
      const result = await appointmentRequest<{ versions: ClinicalRevision[]; nextBeforeVersion: number | null }>(
        user,
        `${recordPath}/versions${query}`,
      );
      setHistory((current) => beforeVersion ? [...current, ...result.versions] : result.versions);
      setHistoryCursor(result.nextBeforeVersion);
    } catch (cause) { setHistoryError(cause instanceof Error ? cause.message : "L’historique n’a pas pu être chargé."); }
    finally { setHistoryLoading(false); }
  }

  function toggleHistory() {
    const nextOpen = !historyOpen;
    setHistoryOpen(nextOpen);
    if (nextOpen && !history.length && !historyLoading) void loadHistory();
  }

  const locked = record ? ["FINALIZED", "SIGNED"].includes(record.status.toUpperCase()) : false;
  const vitals = record?.clinicalContent.patientVitals || {};

  return (
    <section className="clinical-record" aria-labelledby="clinical-record-title">
      <p className="eyebrow">{recordId ? "Dossier clinique autonome" : "Dossier de consultation"}</p>
      <h2 id="clinical-record-title">Compte rendu médical.</h2>
      {loading ? <p role="status">Chargement du dossier…</p> : null}
      {error ? <div className="form-error" role="alert">{error}<button className="button button-outline" disabled={busy} onClick={() => void load()} type="button">Réessayer</button></div> : null}
      {notice ? <p className="form-notice" role="status">{notice}</p> : null}
      {!loading && !error && view === "patient" ? <div className="clinical-record-summary">
        <strong>{patientRecord?.recordNumber || "Dossier non créé"}</strong>
        <p>{patientRecord ? `${patientRecord.providerName || "Professionnel NEXA"} · ${patientRecord.specialtyName || "Consultation"}` : "Le médecin créera le dossier pendant la consultation."}</p>
        <p>{patientRecord ? patientRecord.status === "FINALIZED" || patientRecord.status === "SIGNED" ? "Le dossier est finalisé." : "Le dossier est en préparation." : ""}</p>
        <p className="appointment-privacy">Après finalisation, le contenu détaillé et son impression sont disponibles dans votre espace patient.</p>
      </div> : null}
      {!loading && !error && view === "provider" && record ? <>
        <div className="clinical-record-meta"><span><small>N° patient</small><strong>{record.patientNumber}</strong></span><span><small>Référence</small><strong>{record.recordNumber}</strong></span><span><small>État</small><strong>{locked ? "Finalisé" : "Brouillon"}</strong></span></div>
        {!recordId ? <PatientMedicalSummary identity={patientIdentity} profile={patientMedicalProfile} /> : null}
        <PatientClinicalHistory user={user} appointmentId={appointmentId} recordId={recordId} />
        <section className="clinical-version-history" aria-labelledby="clinical-version-history-title">
          <button className="button button-outline" type="button" aria-expanded={historyOpen} onClick={toggleHistory} disabled={historyLoading && !history.length}>{historyLoading && !history.length ? "Chargement de l’historique…" : historyOpen ? "Masquer l’historique des versions" : "Consulter l’historique des versions"}</button>
          {historyOpen ? <div id="clinical-version-history-title">
            <h3>Historique immuable du dossier</h3>
            <p>Chaque sauvegarde, ajout ou retrait de document et finalisation crée une version. Une version ancienne ne peut pas remplacer le dossier courant.</p>
            {historyError ? <p className="form-error" role="alert">{historyError}<button className="button button-quiet" type="button" onClick={() => void loadHistory()}>Réessayer</button></p> : null}
            {history.map((revision) => <details key={revision.version} className="clinical-version-entry">
              <summary>Version {revision.version} · {revision.status === "FINALIZED" ? "Finalisée" : "Brouillon"} · {revision.createdAt ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(new Date(revision.createdAt)) : "Date non renseignée"} · {revision.changeType.replaceAll("_", " ")}</summary>
              <div className="clinical-version-content">
                <RecordField label="Motif" value={revision.clinicalContent.consultationReason} />
                <RecordField label="Antécédents pertinents" value={revision.clinicalContent.relevantHistory} />
                <RecordField label="Allergies" value={revision.clinicalContent.allergies} />
                <RecordField label="Symptômes" value={revision.clinicalContent.symptoms} />
                <RecordField label="Observations" value={revision.clinicalContent.clinicalObservations} />
                <RecordField label="Évaluation clinique" value={revision.clinicalContent.clinicalAssessment} />
                <RecordField label="Diagnostic(s)" value={revision.clinicalContent.diagnoses} />
                <RecordField label="Plan de soins" value={revision.clinicalContent.carePlan} />
                <RecordField label="Recommandations" value={revision.clinicalContent.recommendations} />
                {revision.attachments.length ? <div><strong>Pièces jointes à cette version</strong><ul>{revision.attachments.map((attachment) => <li key={attachment.id}>{attachment.originalFileName} · {(attachment.size / (1024 * 1024)).toFixed(2)} Mio</li>)}</ul><small>Cette liste est historique; un document retiré du brouillon n’est plus téléchargeable.</small></div> : null}
                {revision.documentHash ? <small>Empreinte : {revision.documentHash}</small> : null}
              </div>
            </details>)}
            {historyLoading && history.length ? <p role="status">Chargement des versions…</p> : null}
            {historyCursor ? <button className="button button-quiet" type="button" disabled={historyLoading} onClick={() => void loadHistory(historyCursor)}>Versions précédentes</button> : null}
            {!historyLoading && !history.length && !historyError ? <p>Aucune version archivée pour ce dossier.</p> : null}
          </div> : null}
        </section>
        {!locked ? <form key={record.status} className="auth-form clinical-record-form" onSubmit={(event) => void save(event)}>
          <div className="form-grid"><label>Motif de consultation<input name="consultationReason" defaultValue={record.clinicalContent.consultationReason || ""} maxLength={5000} /></label><label>Allergies<input name="allergies" defaultValue={record.clinicalContent.allergies || ""} maxLength={5000} /></label></div>
          <label>Antécédents pertinents<textarea name="relevantHistory" rows={3} defaultValue={record.clinicalContent.relevantHistory || ""} maxLength={5000} /></label>
          <label>Traitements en cours<textarea name="currentTreatments" rows={3} defaultValue={record.clinicalContent.currentTreatments || ""} maxLength={5000} /></label>
          <label>Symptômes rapportés<textarea name="symptoms" rows={3} defaultValue={record.clinicalContent.symptoms || ""} maxLength={5000} /></label>
          <label>Histoire de la maladie / anamnèse<textarea name="history" rows={3} defaultValue={record.clinicalContent.history || ""} maxLength={5000} /></label>
          <label>Observations cliniques<textarea name="clinicalObservations" rows={4} defaultValue={record.clinicalContent.clinicalObservations || ""} maxLength={5000} /></label>
          <label>Évaluation / impression clinique<textarea name="clinicalAssessment" rows={3} defaultValue={record.clinicalContent.clinicalAssessment || ""} maxLength={5000} /></label>
          <label>Diagnostic(s)<textarea name="diagnoses" rows={3} defaultValue={record.clinicalContent.diagnoses || ""} maxLength={5000} /></label>
          <label>Plan de soins et suivi<textarea name="carePlan" rows={3} defaultValue={record.clinicalContent.carePlan || ""} maxLength={5000} /></label>
          <label>Recommandations<textarea name="recommendations" rows={3} defaultValue={record.clinicalContent.recommendations || ""} maxLength={5000} /></label>
          <label>Suivi recommandé<textarea name="followUp" rows={3} defaultValue={record.clinicalContent.followUp || ""} maxLength={5000} /></label>
          <label>Notes complémentaires<textarea name="additionalNotes" rows={3} defaultValue={record.clinicalContent.additionalNotes || ""} maxLength={5000} /></label>
          <div className="form-grid"><label>Examens de laboratoire<textarea name="laboratoryTests" rows={3} defaultValue={(record.clinicalContent.laboratoryTests || []).join("\n")} maxLength={12_500} /><small>Un examen par ligne.</small></label><label>Examens d’imagerie<textarea name="imagingExams" rows={3} defaultValue={(record.clinicalContent.imagingExams || []).join("\n")} maxLength={12_500} /><small>Un examen par ligne.</small></label></div>
          <fieldset className="clinical-vitals"><legend>Signes vitaux</legend><div className="form-grid three-columns">
            <label>TA systolique (mmHg)<input name="systolic" type="number" min="0" max="1000" step="any" defaultValue={vitals.systolic ?? ""} /></label>
            <label>TA diastolique (mmHg)<input name="diastolic" type="number" min="0" max="1000" step="any" defaultValue={vitals.diastolic ?? ""} /></label>
            <label>Fréquence cardiaque (BPM)<input name="heartRate" type="number" min="0" max="1000" step="any" defaultValue={vitals.heartRate ?? ""} /></label>
            <label>Fréquence respiratoire (RPM)<input name="respiratoryRate" type="number" min="0" max="1000" step="any" defaultValue={vitals.respiratoryRate ?? ""} /></label>
            <label>SpO₂ (%)<input name="spo2" type="number" min="0" max="100" step="any" defaultValue={vitals.spo2 ?? ""} /></label>
            <label>Glycémie (mg/dl)<input name="glycemia" type="number" min="0" max="1000000" step="any" defaultValue={vitals.glycemia ?? ""} /></label>
            <label>Température (°C)<input name="temperature" type="number" min="0" max="100" step="any" defaultValue={vitals.temperature ?? ""} /></label>
            <label>Poids<input name="weight" type="number" min="0" max="1000000" step="any" defaultValue={vitals.weight ?? ""} /></label>
            <label>Unité du poids<select name="weightUnit" defaultValue={String(vitals.weightUnit || "kg")}><option value="kg">kg</option><option value="lb">lb</option></select></label>
            <label>Taille<input name="height" type="number" min="0" max="1000000" step="any" defaultValue={vitals.height ?? ""} /></label>
            <label>Unité de taille<select name="heightUnit" defaultValue={String(vitals.heightUnit || "cm")}><option value="cm">cm</option><option value="in">in</option></select></label>
          </div></fieldset>
          <section className="clinical-record-attachments" aria-labelledby="clinical-attachments-title">
            <h3 id="clinical-attachments-title">Documents cliniques</h3>
            <p>Ajoutez des PDF, JPEG ou PNG; chaque fichier est analysé avant son ajout au dossier. Maximum 10 fichiers de 15 Mio chacun.</p>
            <label>Ajouter un document<input type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" disabled={busy || attachmentBusy || (record.attachments || []).length >= 10} onChange={(event) => void uploadAttachment(event)} /></label>
            {(record.attachments || []).length ? <ul>{record.attachments.map((attachment) => <li key={attachment.id}><span>{attachment.originalFileName} · {(attachment.size / (1024 * 1024)).toFixed(2)} Mio</span><button className="button button-quiet" type="button" disabled={busy || attachmentBusy} onClick={() => void removeAttachment(attachment.id)}>Retirer</button></li>)}</ul> : <p>Aucune pièce jointe.</p>}
            {attachmentBusy ? <p role="status">Traitement sécurisé de la pièce jointe…</p> : null}
          </section>
          <div className="clinical-record-actions"><button className="button button-outline" disabled={busy || attachmentBusy} name="action" type="submit" value="saveDraft">{busy ? "Enregistrement…" : "Enregistrer le brouillon"}</button><button className="button button-primary" disabled={busy || attachmentBusy} name="action" type="submit" value="finalize">Finaliser le dossier</button></div>
        </form> : null}
        {locked ? <>
          <div className="clinical-record-readonly"><RecordField label="Motif de consultation" value={record.clinicalContent.consultationReason} /><RecordField label="Antécédents pertinents" value={record.clinicalContent.relevantHistory} /><RecordField label="Allergies" value={record.clinicalContent.allergies} /><RecordField label="Traitements en cours" value={record.clinicalContent.currentTreatments} /><RecordField label="Symptômes" value={record.clinicalContent.symptoms} /><RecordField label="Histoire / anamnèse" value={record.clinicalContent.history} /><RecordField label="Observations cliniques" value={record.clinicalContent.clinicalObservations} /><RecordField label="Évaluation clinique" value={record.clinicalContent.clinicalAssessment} /><RecordField label="Diagnostic(s)" value={record.clinicalContent.diagnoses} /><RecordField label="Plan de soins" value={record.clinicalContent.carePlan} /><RecordField label="Recommandations" value={record.clinicalContent.recommendations} /><RecordField label="Suivi recommandé" value={record.clinicalContent.followUp} /><RecordField label="Notes complémentaires" value={record.clinicalContent.additionalNotes} />
            {record.attachments?.length ? <section className="clinical-record-attachments"><h3>Pièces jointes</h3><ul>{record.attachments.map((attachment) => <li key={attachment.id}><span>{attachment.originalFileName}</span><button className="button button-quiet" type="button" disabled={Boolean(downloadingAttachment)} onClick={() => void downloadAttachment(attachment)}>{downloadingAttachment === attachment.id ? "Préparation…" : "Télécharger"}</button></li>)}</ul></section> : null}
            {record.clinicalContent.laboratoryTests?.length ? <RecordField label="Examens de laboratoire" value={record.clinicalContent.laboratoryTests.join("\n")} /> : null}
            {record.clinicalContent.imagingExams?.length ? <RecordField label="Examens d’imagerie" value={record.clinicalContent.imagingExams.join("\n")} /> : null}
            <p className="appointment-privacy">Finalisé par {record.signature?.name || record.providerName}{record.finalizedAt ? ` le ${new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(new Date(record.finalizedAt))}` : ""}. Le contenu est verrouillé; toute correction est ajoutée à l’historique.</p>
          </div>
          <div className="clinical-addenda"><h3>Historique des corrections</h3>{record.addenda.length ? <ul>{record.addenda.map((entry) => <li key={entry.id}><strong>{entry.reason || "Correction"}</strong><p>{entry.content}</p><small>{entry.signatureName}{entry.createdAt ? ` · ${new Intl.DateTimeFormat("fr-HT", { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.createdAt))}` : ""}</small></li>)}</ul> : <p>Aucune correction ajoutée.</p>}
            <form className="auth-form clinical-addendum-form" onSubmit={(event) => void addAddendum(event)}><h4>Ajouter une correction</h4><label>Motif<input name="reason" maxLength={500} /></label><label>Contenu de la correction<textarea name="content" rows={3} required maxLength={5000} /></label><button className="button button-outline" disabled={busy} type="submit">{busy ? "Ajout…" : "Ajouter à l’historique"}</button></form>
          </div>
        </> : null}
      </> : null}
    </section>
  );
}

function PatientMedicalSummary({ identity, profile }: { identity: PatientIdentity | null; profile: PatientMedicalProfile | null }) {
  const age = identity?.birthDate ? calculateAge(identity.birthDate) : null;
  const languageNames: Record<string, string> = { creole: "Créole haïtien", french: "Français", english: "Anglais", spanish: "Espagnol" };
  const yesNo = (answer: { yes: boolean; details: string } | null) => answer ? answer.yes ? `Oui${answer.details ? ` · ${answer.details}` : ""}` : "Non" : "Non renseigné";
  const condition = (answer: { diagnosed: boolean; sinceMonth: string } | null) => answer ? answer.diagnosed ? `Oui${answer.sinceMonth ? ` · depuis ${answer.sinceMonth}` : ""}` : "Non" : "Non renseigné";

  return <section className="clinical-record-readonly patient-intake-summary" aria-labelledby="patient-intake-summary-title">
    <h3 id="patient-intake-summary-title">Fiche médicale initiale</h3>
    <p>Informations déclarées par le patient. À confirmer directement avec lui.</p>
    <div className="clinical-record-meta">
      <span><small>Patient</small><strong>{identity ? [identity.firstName, identity.lastName].filter(Boolean).join(" ") || "Non renseigné" : "Non renseigné"}</strong></span>
      <span><small>Date de naissance / âge</small><strong>{identity?.birthDate || "Non renseignée"}{age !== null ? ` · ${age} ans` : ""}</strong></span>
      <span><small>Sexe</small><strong>{identity?.sex || "Non renseigné"}</strong></span>
    </div>
    {profile ? <div className="form-grid">
      <RecordField label="Langues préférées" value={profile.languages.map((language) => languageNames[language] || language).join(", ")} />
      <RecordField label="Allergies" value={yesNo(profile.allergies)} />
      <RecordField label="Diabète" value={condition(profile.diabetes)} />
      <RecordField label="Hypertension" value={condition(profile.hypertension)} />
      <RecordField label="Tabac" value={yesNo(profile.tobacco)} />
      <RecordField label="Alcool" value={yesNo(profile.alcohol)} />
      <RecordField label="Café" value={yesNo(profile.coffee)} />
      <RecordField label="Thé" value={yesNo(profile.tea)} />
      <small>Dernière mise à jour par le patient : {profile.updatedAt ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(new Date(profile.updatedAt)) : "date inconnue"}.</small>
    </div> : <p>Le patient n’a pas encore rempli cette fiche.</p>}
  </section>;
}

function calculateAge(birthDate: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return null;
  const [year, month, day] = birthDate.split("-").map(Number);
  const todayParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Port-au-Prince", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const todayYear = Number(todayParts.year);
  const todayMonth = Number(todayParts.month);
  const todayDay = Number(todayParts.day);
  let age = todayYear - year;
  const birthdayHasPassed = todayMonth > month || (todayMonth === month && todayDay >= day);
  if (!birthdayHasPassed) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

function RecordField({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === "string" && value.trim() ? value : "Non renseigné";
  return <div><strong>{label}</strong><p>{text}</p></div>;
}
