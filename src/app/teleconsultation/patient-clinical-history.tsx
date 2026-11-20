"use client";

import { useState } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";

type Content = {
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
  medications?: Array<{ name?: string; dosage?: string; form?: string; route?: string; quantity?: number | null; instructions?: string; duration?: string }>;
  laboratoryTests?: string[];
  imagingExams?: string[];
  patientVitals?: Record<string, number | string | null>;
};
type PriorRecord = {
  recordId: string;
  recordNumber: string;
  recordType: "APPOINTMENT" | "STANDALONE";
  providerName: string;
  specialtyName: string;
  finalizedAt: string | null;
  signature: { name: string; specialty: string; signedAt: string };
  clinicalContent: Content;
  addenda: Array<{ reason: string; content: string; signatureName: string; createdAt: string | null }>;
};
type HistoryResponse = { records: PriorRecord[]; nextCursor: string | null };

export default function PatientClinicalHistory({ user, appointmentId, recordId }: { user: User; appointmentId?: string; recordId?: string }) {
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<PriorRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const endpoint = recordId
    ? `/api/provider/clinical-records/${encodeURIComponent(recordId)}/history`
    : `/api/appointments/${encodeURIComponent(appointmentId || "")}/clinical-history`;

  async function load(cursor?: string) {
    if (loading) return;
    setLoading(true); setError("");
    try {
      const path = cursor ? `${endpoint}?cursor=${encodeURIComponent(cursor)}` : endpoint;
      const result = await appointmentRequest<HistoryResponse>(user, path);
      setRecords((current) => cursor ? [...current, ...result.records] : result.records);
      setNextCursor(result.nextCursor || null);
      setLoaded(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Les notes antérieures ne sont pas accessibles.");
    } finally { setLoading(false); }
  }

  function toggle() {
    const willOpen = !open;
    setOpen(willOpen);
    if (willOpen && !loaded && !loading) void load();
  }

  return <section className="clinical-version-history patient-clinical-history">
    <button className="button button-outline" type="button" aria-expanded={open} aria-controls="prior-clinical-history" onClick={toggle}>
      {open ? "Masquer les notes antérieures autorisées" : "Consulter les notes antérieures autorisées"}
    </button>
    {open ? <div id="prior-clinical-history">
      <h3>Historique clinique du patient</h3>
      <p>Seules les notes finalisées d’autres médecins apparaissent ici. Cette lecture est limitée à l’autorisation active et journalisée.</p>
      {loading && !records.length ? <p role="status">Chargement des notes antérieures…</p> : null}
      {error ? <p className="form-error" role="alert">{error}<button className="button button-quiet" type="button" disabled={loading} onClick={() => void load(nextCursor || undefined)}>Réessayer</button></p> : null}
      {records.length ? <div className="clinical-history-records">{records.map((record) => <details className="clinical-version-entry" key={record.recordId}>
        <summary>{record.finalizedAt ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(new Date(record.finalizedAt)) : "Date non renseignée"} · {record.providerName}{record.specialtyName ? ` · ${record.specialtyName}` : ""}</summary>
        <div className="clinical-version-content">
          <p><small>{record.recordType === "STANDALONE" ? "Dossier autonome" : "Consultation"} · {record.recordNumber} · Signé par {record.signature.name || record.providerName}{record.signature.specialty ? ` (${record.signature.specialty})` : ""}</small></p>
          <HistoryField label="Motif de consultation" value={record.clinicalContent.consultationReason} />
          <HistoryField label="Antécédents pertinents" value={record.clinicalContent.relevantHistory} />
          <HistoryField label="Allergies" value={record.clinicalContent.allergies} />
          <HistoryField label="Traitements en cours" value={record.clinicalContent.currentTreatments} />
          <HistoryField label="Symptômes" value={record.clinicalContent.symptoms} />
          <HistoryField label="Histoire / anamnèse" value={record.clinicalContent.history} />
          <HistoryField label="Observations cliniques" value={record.clinicalContent.clinicalObservations} />
          <HistoryField label="Évaluation clinique" value={record.clinicalContent.clinicalAssessment} />
          <HistoryField label="Diagnostic(s)" value={record.clinicalContent.diagnoses} />
          <HistoryField label="Plan de soins" value={record.clinicalContent.carePlan} />
          <HistoryField label="Recommandations et suivi" value={[record.clinicalContent.recommendations, record.clinicalContent.followUp].filter(Boolean).join("\n")} />
          <HistoryField label="Notes complémentaires" value={record.clinicalContent.additionalNotes} />
          {record.clinicalContent.medications?.length ? <div><strong>Médicaments prescrits</strong><ul>{record.clinicalContent.medications.map((item, index) => <li key={`${item.name}-${index}`}>{[item.name, item.dosage, item.form, item.route, item.quantity ? `Quantité : ${item.quantity}` : "", item.duration, item.instructions].filter(Boolean).join(" · ")}</li>)}</ul></div> : null}
          {record.clinicalContent.laboratoryTests?.length ? <HistoryField label="Examens de laboratoire" value={record.clinicalContent.laboratoryTests.join("\n")} /> : null}
          {record.clinicalContent.imagingExams?.length ? <HistoryField label="Examens d’imagerie" value={record.clinicalContent.imagingExams.join("\n")} /> : null}
          <Vitals values={record.clinicalContent.patientVitals} />
          {record.addenda.length ? <div><strong>Corrections signées</strong><ul>{record.addenda.map((addendum, index) => <li key={`${record.recordId}-addendum-${index}`}><p>{addendum.reason || "Correction"}{addendum.createdAt ? ` · ${new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(new Date(addendum.createdAt))}` : ""}</p><p>{addendum.content}</p><small>{addendum.signatureName}</small></li>)}</ul></div> : null}
        </div>
      </details>)}</div> : null}
      {!loading && loaded && !records.length && !error ? <p>Aucune note antérieure finalisée n’est disponible.</p> : null}
      {nextCursor ? <button className="button button-quiet" type="button" disabled={loading} onClick={() => void load(nextCursor)}>{loading ? "Chargement…" : "Charger les notes précédentes"}</button> : null}
    </div> : null}
  </section>;
}

function HistoryField({ label, value }: { label: string; value: unknown }) {
  if (typeof value !== "string" || !value.trim()) return null;
  return <div><strong>{label}</strong><p>{value}</p></div>;
}

function Vitals({ values }: { values?: Record<string, number | string | null> }) {
  if (!values) return null;
  const labels: Record<string, string> = { systolic: "TA systolique", diastolic: "TA diastolique", heartRate: "Pouls", respiratoryRate: "Fréquence respiratoire", spo2: "SpO₂", glycemia: "Glycémie", temperature: "Température", weight: "Poids", height: "Taille" };
  const entries = Object.entries(labels).flatMap(([key, label]) => {
    const value = values[key];
    if (typeof value !== "number") return [];
    const unit = key === "systolic" || key === "diastolic" ? "mmHg" : key === "heartRate" ? "BPM" : key === "respiratoryRate" ? "RPM" : key === "spo2" ? "%" : key === "glycemia" ? "mg/dl" : key === "temperature" ? "°C" : key === "weight" ? String(values.weightUnit || "kg") : key === "height" ? String(values.heightUnit || "cm") : "";
    return [`${label} : ${value}${unit ? ` ${unit}` : ""}`];
  });
  return entries.length ? <div><strong>Signes vitaux consignés</strong><p>{entries.join(" · ")}</p></div> : null;
}
