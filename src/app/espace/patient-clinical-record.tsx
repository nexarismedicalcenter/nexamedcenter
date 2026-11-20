"use client";

import { useState, type MouseEvent } from "react";
import type { User } from "firebase/auth";
import { getToken } from "firebase/app-check";
import { appointmentRequest } from "@/lib/appointments/client";
import { getFirebaseAppCheck } from "@/lib/firebase/client";

type ClinicalContent = {
  consultationReason?: string;
  history?: string;
  relevantHistory?: string;
  allergies?: string;
  currentTreatments?: string;
  symptoms?: string;
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

type PatientClinicalRecord = {
  recordId?: string;
  recordNumber: string;
  status: string;
  providerName: string;
  specialtyName: string;
  finalizedAt: string | null;
  clinicalContent?: ClinicalContent;
  attachments?: Array<{ id: string; originalFileName: string; contentType: string; size: number; uploadedAt: string }>;
  signature?: { name?: string; specialty?: string; signedAt?: string } | null;
  addenda?: Array<{ id: string; reason: string; content: string; signatureName: string; createdAt: string | null }>;
};

const TEXT_FIELDS: Array<[keyof ClinicalContent, string]> = [
  ["consultationReason", "Motif de consultation"],
  ["history", "Histoire / anamnèse"],
  ["relevantHistory", "Antécédents pertinents"],
  ["allergies", "Allergies"],
  ["currentTreatments", "Traitements en cours"],
  ["symptoms", "Symptômes"],
  ["clinicalObservations", "Observations cliniques"],
  ["clinicalAssessment", "Évaluation clinique"],
  ["diagnoses", "Diagnostic(s)"],
  ["carePlan", "Plan de soins"],
  ["recommendations", "Recommandations"],
  ["followUp", "Suivi"],
  ["additionalNotes", "Notes complémentaires"],
];

const VITAL_LABELS: Record<string, string> = {
  systolic: "TA systolique (mmHg)", diastolic: "TA diastolique (mmHg)", heartRate: "Fréquence cardiaque (BPM)",
  respiratoryRate: "Fréquence respiratoire (RPM)", spo2: "SpO₂ (%)", glycemia: "Glycémie (mg/dl)",
  temperature: "Température (°C)", weight: "Poids", height: "Taille",
};

function formatDate(value: string | null | undefined) {
  if (!value) return "Date non renseignée";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date non renseignée" : new Intl.DateTimeFormat("fr-HT", {
    timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short",
  }).format(date);
}

export default function PatientClinicalRecordDetails({ user, appointmentId, recordId, standalone = false }: { user: User; appointmentId?: string; recordId: string; standalone?: boolean }) {
  const recordKey = recordId || appointmentId || "";
  const detailPath = standalone
    ? `/api/patient/clinical-records/${encodeURIComponent(recordKey)}`
    : `/api/appointments/${encodeURIComponent(appointmentId || recordKey)}/clinical-record`;
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [record, setRecord] = useState<PatientClinicalRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [downloadingAttachment, setDownloadingAttachment] = useState("");

  async function toggleDetails() {
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (!nextExpanded || loaded || loading) return;
    setLoading(true);
    setError("");
    try {
      const result = await appointmentRequest<{ view: "patient"; record: PatientClinicalRecord | null }>(
        user,
        detailPath,
      );
      if (result.view !== "patient") throw new Error("Ce dossier n’est pas accessible depuis l’espace patient.");
      setRecord(result.record);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Le dossier détaillé ne peut pas être chargé.");
      setExpanded(false);
    } finally {
      setLoading(false);
    }
  }

  function printRecord(event: MouseEvent<HTMLButtonElement>) {
    const article = event.currentTarget.closest(".patient-clinical-record");
    if (!article) return;
    document.body.classList.add("printing-patient-record");
    article.classList.add("print-current");
    const cleanup = () => {
      document.body.classList.remove("printing-patient-record");
      article.classList.remove("print-current");
    };
    window.addEventListener("afterprint", cleanup, { once: true });
    window.print();
  }

  async function downloadPdf() {
    setPdfLoading(true);
    setError("");
    try {
      const headers = new Headers({ Authorization: `Bearer ${await user.getIdToken()}` });
      const appCheck = getFirebaseAppCheck();
      if (process.env.NODE_ENV === "production" && !appCheck) throw new Error("La protection App Check de NEXA n’est pas configurée.");
      if (appCheck) headers.set("X-Firebase-AppCheck", (await getToken(appCheck)).token);
      const response = await fetch(standalone
        ? `/api/patient/clinical-records/${encodeURIComponent(recordKey)}/pdf`
        : `/api/appointments/${encodeURIComponent(appointmentId || recordKey)}/clinical-record/pdf`, { headers, cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || "Le PDF du dossier n’a pas pu être téléchargé.");
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      const safeRecordNumber = (record?.recordNumber || recordKey.slice(0, 10)).replace(/[^A-Za-z0-9_-]/g, "-");
      anchor.download = `nexa-compte-rendu-${safeRecordNumber}.pdf`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Le PDF du dossier n’a pas pu être téléchargé.");
    } finally {
      setPdfLoading(false);
    }
  }

  async function downloadAttachment(attachment: NonNullable<PatientClinicalRecord["attachments"]>[number]) {
    setDownloadingAttachment(attachment.id);
    setError("");
    try {
      const result = await appointmentRequest<{ url: string }>(
        user,
        standalone
          ? `/api/patient/clinical-records/${encodeURIComponent(recordKey)}/attachments?attachmentId=${encodeURIComponent(attachment.id)}`
          : `/api/appointments/${encodeURIComponent(appointmentId || recordKey)}/clinical-record/attachments?attachmentId=${encodeURIComponent(attachment.id)}`,
      );
      const anchor = document.createElement("a");
      anchor.href = result.url;
      anchor.rel = "noopener noreferrer";
      anchor.click();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "La pièce jointe n’a pas pu être téléchargée.");
    } finally {
      setDownloadingAttachment("");
    }
  }

  const finalized = record && ["FINALIZED", "SIGNED"].includes(record.status.toUpperCase());
  const content = record?.clinicalContent;
  const vitals = Object.entries(content?.patientVitals || {}).filter(([key, value]) => key in VITAL_LABELS && value !== null && value !== "");
  const medications = (content?.medications || []).filter((item) => item.name);
  const laboratoryTests = content?.laboratoryTests || [];
  const imagingExams = content?.imagingExams || [];

  return <div className="patient-record-details">
    <button className="button button-outline" disabled={loading} type="button" aria-expanded={expanded} aria-controls={`patient-record-${recordKey}`} onClick={() => void toggleDetails()}>
      {loading ? "Chargement du dossier…" : expanded ? "Masquer le dossier" : "Afficher le dossier détaillé"}
    </button>
    {error ? <p className="form-error" role="alert">{error}<button className="button button-quiet" type="button" onClick={() => { setLoaded(false); void toggleDetails(); }}>Réessayer</button></p> : null}
    <div id={`patient-record-${recordKey}`} className="patient-record-details-content" role="region" aria-label="Dossier médical détaillé" hidden={!expanded || !loaded}>
      {expanded && loaded ? !record ? <p>Le dossier n’est pas encore disponible.</p> : !finalized ? <p>Le médecin prépare encore ce dossier. Son contenu sera accessible après sa finalisation.</p> : <article className="patient-clinical-record">
        <header>
          <p className="eyebrow">NEXA Medical Center · Compte rendu médical</p>
          <h3>{record.recordNumber || "Dossier de consultation"}</h3>
          <p>{record.providerName || "Professionnel NEXA"}{record.specialtyName ? ` · ${record.specialtyName}` : ""}</p>
          <p>Finalisé le {formatDate(record.finalizedAt)}</p>
        </header>
        <div className="clinical-record-readonly">
          {TEXT_FIELDS.map(([field, label]) => <RecordField key={field} label={label} value={content?.[field]} />)}
          {vitals.length ? <section className="patient-record-block"><h4>Signes vitaux</h4><dl>{vitals.map(([key, value]) => <div key={key}><dt>{VITAL_LABELS[key]}{key === "weight" && content?.patientVitals?.weightUnit ? ` (${content.patientVitals.weightUnit})` : key === "height" && content?.patientVitals?.heightUnit ? ` (${content.patientVitals.heightUnit})` : ""}</dt><dd>{String(value)}</dd></div>)}</dl></section> : null}
          {medications.length ? <section className="patient-record-block"><h4>Médicaments prescrits</h4><ul>{medications.map((item, index) => <li key={`${item.name}-${index}`}><strong>{item.name}</strong>{item.dosage ? ` · ${item.dosage}` : ""}{item.form ? ` · ${item.form}` : ""}{item.route ? ` · ${item.route}` : ""}{item.duration ? ` · ${item.duration}` : ""}{item.quantity != null ? ` · Quantité : ${item.quantity}` : ""}{item.instructions ? <p>{item.instructions}</p> : null}</li>)}</ul></section> : null}
          {laboratoryTests.length ? <ListField label="Examens de laboratoire" items={laboratoryTests} /> : null}
          {imagingExams.length ? <ListField label="Examens d’imagerie" items={imagingExams} /> : null}
        </div>
        <p className="patient-record-signature">Finalisé par {record.signature?.name || record.providerName || "Professionnel NEXA"}{record.signature?.specialty ? ` · ${record.signature.specialty}` : ""}{record.signature?.signedAt ? ` · signé le ${formatDate(record.signature.signedAt)}` : ""}.</p>
        {record.attachments?.length ? <section className="patient-record-attachments"><h4>Documents joints au dossier</h4><ul>{record.attachments.map((attachment) => <li key={attachment.id}><span>{attachment.originalFileName} · {(attachment.size / (1024 * 1024)).toFixed(2)} Mio</span><button className="button button-quiet" type="button" disabled={Boolean(downloadingAttachment)} onClick={() => void downloadAttachment(attachment)}>{downloadingAttachment === attachment.id ? "Préparation…" : "Télécharger"}</button></li>)}</ul><p>Chaque accès est vérifié et journalisé. Les liens de téléchargement expirent après cinq minutes.</p></section> : null}
        {record.addenda?.length ? <section className="patient-record-addenda"><h4>Corrections ajoutées au dossier</h4><ul>{record.addenda.map((addendum) => <li key={addendum.id}><strong>{addendum.reason || "Correction"}</strong><p>{addendum.content}</p><small>{addendum.signatureName}{addendum.createdAt ? ` · ${formatDate(addendum.createdAt)}` : ""}</small></li>)}</ul></section> : null}
        <div className="clinical-record-actions patient-record-print-button">
          <button className="button button-primary" disabled={pdfLoading} type="button" onClick={() => void downloadPdf()}>{pdfLoading ? "Génération du PDF…" : "Télécharger le compte rendu PDF"}</button>
          <button className="button button-outline" type="button" onClick={printRecord}>Imprimer cette page</button>
        </div>
      </article> : null}
    </div>
  </div>;
}

function RecordField({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  return <div><strong>{label}</strong><p>{text}</p></div>;
}

function ListField({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return <section className="patient-record-block"><h4>{label}</h4><ul>{items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></section>;
}
