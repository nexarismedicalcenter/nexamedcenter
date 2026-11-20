"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import Link from "next/link";
import { appointmentRequest } from "@/lib/appointments/client";

type ResultFile = { id: string; category: string; fileName: string; contentType: string; size: number };
type DiagnosticResult = {
  id: string; source: "NEXA_PARTNER" | "PATIENT_UPLOAD"; orderNumber?: string; examName: string; providerName: string;
  providerType: string; version: number; performedAt: string | null; transferredAt: string | null;
  followUpStatus?: string; files: ResultFile[];
  followUpActions?: Array<{ id: string; type: string; content: string; providerName: string; providerUid: string; slotId: string; recordId: string; recordNumber: string; startsAt: string | null; createdAt: string | null }>;
};
type PrescribedExam = {
  prescriptionId: string; appointmentId: string; examType: "laboratory" | "imaging"; examIndex: number;
  examName: string; providerName: string; specialtyName: string;
};
type UploadPolicy = { fileId: string; category: string; fileName: string; contentType: string; expectedSize: number; uploadUrl: string; fields: Record<string, string> };
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const ACCEPTED_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

function examKey(exam: PrescribedExam) { return `${exam.prescriptionId}:${exam.examType}:${exam.examIndex}`; }

export default function PatientDiagnosticResults({ user }: { user: User }) {
  const [results, setResults] = useState<DiagnosticResult[]>([]);
  const [uploadableExams, setUploadableExams] = useState<PrescribedExam[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Record<string, File[]>>({});
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const payload = await appointmentRequest<{ results: DiagnosticResult[]; uploadableExams: PrescribedExam[] }>(user, "/api/patient/diagnostic-results");
      setResults(payload.results || []);
      setUploadableExams(payload.uploadableExams || []);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Les résultats ne peuvent pas être chargés."); }
    finally { setLoading(false); }
  }, [user]);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);

  async function openFile(result: DiagnosticResult, file: ResultFile) {
    const id = `${result.id}:${file.id}`;
    setBusyId(id); setError(""); setNotice("");
    try {
      const payload = await appointmentRequest<{ url: string }>(user, `/api/patient/diagnostic-results/${encodeURIComponent(result.id)}/files/${encodeURIComponent(file.id)}`);
      const target = new URL(payload.url);
      if (target.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))) throw new Error("Le lien sécurisé du résultat n’est pas valide.");
      if (target.protocol === "https:" && target.hostname !== "storage.googleapis.com" && !target.hostname.endsWith(".storage.googleapis.com")) throw new Error("Le lien sécurisé du résultat n’est pas valide.");
      window.location.assign(target.toString());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Ce fichier ne peut pas être ouvert."); }
    finally { setBusyId(""); }
  }

  function chooseFiles(exam: PrescribedExam, files: FileList | null) {
    if (!files) return;
    const selected = Array.from(files);
    if (selected.length > 20 || selected.some((file) => !ACCEPTED_MIME_TYPES.has(file.type) || file.size < 1 || file.size > MAX_FILE_BYTES)) {
      setError("Choisissez jusqu’à 20 fichiers PDF, JPEG ou PNG de 15 Mio maximum chacun.");
      return;
    }
    const key = examKey(exam);
    setSelectedFiles((current) => ({ ...current, [key]: selected }));
    setError(""); setNotice("");
  }

  async function submitResult(event: FormEvent<HTMLFormElement>, exam: PrescribedExam) {
    event.preventDefault();
    const key = examKey(exam);
    const files = selectedFiles[key] || [];
    if (!files.length) { setError("Ajoutez au moins un fichier de résultat."); return; }
    if (!confirmed[key]) { setError("Confirmez que ces documents correspondent à votre examen prescrit."); return; }
    setBusyId(key); setError(""); setNotice("");
    let uploadSessionId = "";
    try {
      const category = exam.examType === "laboratory" ? "LAB_RESULT" : "IMAGING";
      const started = await appointmentRequest<{ uploadSessionId: string; files: UploadPolicy[] }>(user, "/api/patient/diagnostic-results/uploads", "POST", {
        prescriptionId: exam.prescriptionId,
        examType: exam.examType,
        examIndex: exam.examIndex,
        confirmMatch: true,
        files: files.map((file) => ({ fileName: file.name, contentType: file.type, size: file.size, category })),
      });
      uploadSessionId = started.uploadSessionId;
      await Promise.all(started.files.map(async (policy, index) => {
        const target = new URL(policy.uploadUrl);
        const localUpload = process.env.NODE_ENV !== "production" && target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
        if (!localUpload && (target.protocol !== "https:" || (target.hostname !== "storage.googleapis.com" && !target.hostname.endsWith(".storage.googleapis.com")))) throw new Error("Le lien sécurisé de téléversement n’est pas valide.");
        const form = new FormData();
        Object.entries(policy.fields).forEach(([name, value]) => form.append(name, value));
        form.append("file", files[index], policy.fileName);
        const response = await fetch(target, { method: "POST", body: form, cache: "no-store" });
        if (!response.ok) throw new Error(`Le fichier ${index + 1} n’a pas été téléversé. Vérifiez votre connexion puis réessayez.`);
      }));
      const submitted = await appointmentRequest<{ message: string }>(user, "/api/patient/diagnostic-results/submit", "POST", { uploadSessionId });
      setNotice(submitted.message);
      setSelectedFiles((current) => ({ ...current, [key]: [] }));
      setConfirmed((current) => ({ ...current, [key]: false }));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Le résultat n’a pas pu être transmis.");
      if (uploadSessionId) await appointmentRequest(user, "/api/patient/diagnostic-results/uploads", "DELETE", { uploadSessionId }).catch(() => undefined);
    } finally { setBusyId(""); }
  }

  return <section className="patient-appointments" id="resultats" aria-labelledby="patient-diagnostic-results-heading">
    <div className="diagnostic-orders-heading"><h2 id="patient-diagnostic-results-heading">Mes résultats médicaux</h2><button className="button button-quiet" disabled={loading || Boolean(busyId)} onClick={() => void load()} type="button">Actualiser</button></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}{notice ? <p className="form-notice" role="status">{notice}</p> : null}
    {uploadableExams.length ? <section className="patient-result-upload-list" aria-labelledby="patient-result-upload-heading">
      <h3 id="patient-result-upload-heading">Déposer un résultat prescrit</h3>
      <p>Les documents seront transmis uniquement au médecin qui a établi l’ordonnance, après une analyse de sécurité.</p>
      <ul>{uploadableExams.map((exam) => {
        const key = examKey(exam);
        const files = selectedFiles[key] || [];
        return <li key={key}><form className="diagnostic-result-form" onSubmit={(event) => void submitResult(event, exam)}>
          <strong>{exam.examName}</strong><span>Prescrit par {exam.providerName}{exam.specialtyName ? ` · ${exam.specialtyName}` : ""} · {exam.examType === "laboratory" ? "Laboratoire" : "Imagerie"}</span>
          <label>Fichiers du résultat<input accept="application/pdf,image/jpeg,image/png" disabled={Boolean(busyId)} multiple onChange={(event) => chooseFiles(exam, event.currentTarget.files)} type="file" /></label>
          {files.length ? <ul className="diagnostic-result-files">{files.map((file) => <li key={`${file.name}:${file.size}:${file.lastModified}`}><span>{file.name} · {(file.size / (1024 * 1024)).toFixed(2)} Mio</span><button className="button button-quiet" disabled={Boolean(busyId)} onClick={() => setSelectedFiles((current) => ({ ...current, [key]: (current[key] || []).filter((item) => item !== file) }))} type="button">Retirer</button></li>)}</ul> : null}
          <label className="diagnostic-result-confirm"><input checked={confirmed[key] === true} disabled={Boolean(busyId)} onChange={(event) => setConfirmed((current) => ({ ...current, [key]: event.target.checked }))} type="checkbox" />Je confirme que ces documents concernent bien mon examen et mon dossier.</label>
          <button className="button button-primary" disabled={Boolean(busyId)} type="submit">{busyId === key ? "Analyse et transmission sécurisées…" : "Transmettre au médecin prescripteur"}</button>
        </form></li>;
      })}</ul>
    </section> : null}
    {loading ? <p role="status">Chargement de vos résultats…</p> : results.length ? <ul>{results.map((result) => <li key={result.id}><div><strong>{result.examName}</strong><span>{result.source === "NEXA_PARTNER" ? `${result.providerName} · ${result.orderNumber || "Commande NEXA"}` : result.providerName}</span>
      {result.source === "NEXA_PARTNER" ? <small>{result.performedAt ? `Réalisé le ${new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium" }).format(new Date(`${result.performedAt}T12:00:00-04:00`))}` : "Examen vérifié par NEXA"} · Version {result.version}</small> : <small>Déposé par vous et transmis au médecin prescripteur</small>}
      <small>{result.source === "NEXA_PARTNER" ? "Validé et transmis par NEXA le" : "Déposé le"} {result.transferredAt ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(new Date(result.transferredAt)) : "—"}</small>
      {result.files.map((file) => <button className="button button-outline" disabled={Boolean(busyId)} key={file.id} onClick={() => void openFile(result, file)} type="button">{busyId === `${result.id}:${file.id}` ? "Ouverture sécurisée…" : `Ouvrir le document · ${file.category}`}</button>)}
      {result.followUpActions?.length ? <div className="patient-result-follow-up" aria-label="Suivi du médecin prescripteur">{result.followUpActions.map((action) => <article key={action.id}>
        <strong>{action.type === "NOTE" ? "Note de suivi médicale" : action.type === "PRESCRIPTION" ? "Nouvelle ordonnance disponible" : action.type === "APPOINTMENT" ? "Rendez-vous de suivi proposé" : "Suivi médical"}</strong>
        {action.providerName ? <small>{action.providerName}{action.createdAt ? ` · ${new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(new Date(action.createdAt))}` : ""}</small> : null}
        {action.content ? <p>{action.content}</p> : null}
        {action.type === "NOTE" && action.recordId ? <Link href="/espace#dossiers-cliniques">Voir le compte rendu signé{action.recordNumber ? ` · ${action.recordNumber}` : ""}</Link> : null}
        {action.type === "PRESCRIPTION" ? <Link href="/espace#ordonnances">Voir Mes ordonnances</Link> : null}
        {action.type === "APPOINTMENT" && action.startsAt ? <><small>Créneau proposé : {new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "full", timeStyle: "short" }).format(new Date(action.startsAt))}</small>{action.providerUid && action.slotId ? <Link className="button button-outline" href={`/rendez-vous/${encodeURIComponent(action.providerUid)}?slotId=${encodeURIComponent(action.slotId)}`}>Voir le créneau et payer</Link> : null}</> : null}
      </article>)}</div> : null}
    </div></li>)}</ul> : !uploadableExams.length ? <p>Aucun résultat médical ni examen prescrit en attente de document.</p> : null}
    <p className="appointment-privacy">Les documents restent privés. Chaque fichier est analysé avant accès; les liens temporaires expirent après quelques minutes.</p>
  </section>;
}
