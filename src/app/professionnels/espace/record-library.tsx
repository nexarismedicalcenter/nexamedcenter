"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "firebase/auth";
import type { FormEvent } from "react";
import { appointmentRequest } from "@/lib/appointments/client";

type ProviderRecord = {
  recordId: string;
  appointmentId: string;
  recordType: "APPOINTMENT" | "STANDALONE";
  recordNumber: string;
  patientNumber: string;
  patientName: string;
  createdAt: string | null;
  status: string;
  type: string;
  specialtyName: string;
};

const statusLabels: Record<string, string> = { DRAFT: "Brouillon", FINALIZED: "Finalisé", SIGNED: "Signé" };

export default function ProviderRecordLibrary({ user }: { user: User }) {
  const router = useRouter();
  const [records, setRecords] = useState<ProviderRecord[]>([]);
  const [search, setSearch] = useState("");
  const [patientNumber, setPatientNumber] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await appointmentRequest<{ records: ProviderRecord[] }>(user, "/api/provider/clinical-records");
      setRecords(result.records || []);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Les dossiers ne peuvent pas être chargés."); }
    finally { setLoading(false); }
  }, [user]);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);

  const needle = search.trim().toLocaleLowerCase("fr");
  const filtered = records.filter((record) => [record.patientName, record.patientNumber, record.recordNumber].some((value) => value.toLocaleLowerCase("fr").includes(needle)));

  async function createStandaloneRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true); setError("");
    try {
      const result = await appointmentRequest<{ recordId: string }>(user, "/api/provider/clinical-records", "POST", { patientNumber: patientNumber.trim().toUpperCase(), accessCode: accessCode.trim() });
      setPatientNumber("");
      setAccessCode("");
      router.push(`/professionnels/espace/dossiers/${encodeURIComponent(result.recordId)}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le dossier ne peut pas être créé."); }
    finally { setCreating(false); }
  }

  return <section className="provider-slots provider-record-library" aria-labelledby="provider-record-library-title">
    <div className="provider-record-library-heading"><div><h2 id="provider-record-library-title">Dossiers cliniques</h2><p>Cette liste contient uniquement vos dossiers NEXA, liés à une consultation ou créés directement par vous.</p></div><button className="button button-quiet" disabled={loading} onClick={() => void load()} type="button">Actualiser</button></div>
    <form className="availability-form provider-standalone-record-form" onSubmit={(event) => void createStandaloneRecord(event)}>
      <label>Numéro patient NEXA<input required inputMode="text" autoCapitalize="characters" pattern="NMC-[0-9]{7}" maxLength={11} placeholder="NMC-0000001" value={patientNumber} onChange={(event) => setPatientNumber(event.target.value.toUpperCase())} /></label>
      <label>Code d’autorisation communiqué par le patient<input required autoComplete="off" inputMode="text" minLength={32} maxLength={32} pattern="[A-Za-z0-9_-]{32}" value={accessCode} onChange={(event) => setAccessCode(event.target.value)} /></label>
      <button className="button button-primary" type="submit" disabled={creating}>{creating ? "Création…" : "Créer un dossier"}</button>
      <small>Le numéro NMC seul ne donne aucun accès. Le patient doit choisir votre profil et vous transmettre un code valable 30 minutes. Le dossier sera accessible pendant 24 heures après l’autorisation.</small>
    </form>
    <label>Rechercher un patient ou un numéro<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    {error ? <p role="alert" className="form-error">{error}</p> : null}
    {loading ? <p role="status">Chargement des dossiers…</p> : filtered.length ? <ul>{filtered.map((record) => <li key={record.recordId}>
      <span><strong>{record.patientName}</strong><small>{record.patientNumber || "N° patient indisponible"} · {record.recordNumber} · {record.specialtyName || record.type || "Consultation"} · {statusLabels[record.status] || record.status}</small><small>{record.createdAt ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium" }).format(new Date(record.createdAt)) : "Date indisponible"}</small></span>
      <Link className="button button-outline" href={record.recordType === "STANDALONE" ? `/professionnels/espace/dossiers/${encodeURIComponent(record.recordId)}` : `/teleconsultation?appointmentId=${encodeURIComponent(record.appointmentId)}`}>Ouvrir le dossier</Link>
    </li>)}</ul> : <p>{search ? "Aucun dossier ne correspond à cette recherche." : "Aucun dossier rédigé pour le moment."}</p>}
  </section>;
}
