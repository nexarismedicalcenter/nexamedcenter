"use client";

import { useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import type { FormEvent } from "react";
import { appointmentRequest } from "@/lib/appointments/client";

type Doctor = { id: string; name: string; specialty?: string };
type Grant = { grantId: string; providerName: string; status: string; issuedAt: string | null; expiresAt: string | null; accessExpiresAt: string | null };

const statusLabels: Record<string, string> = {
  ISSUED: "Code émis · en attente d’utilisation",
  CLAIMED: "Accès actif",
  EXPIRED: "Expiré",
  REVOKED: "Révoqué",
};

function dateLabel(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(date);
}

export default function PatientClinicalAccess({ user }: { user: User }) {
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [providerUid, setProviderUid] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [codeExpiresAt, setCodeExpiresAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadGrants = useCallback(async () => {
    const result = await appointmentRequest<{ grants: Grant[] }>(user, "/api/patient/clinical-access");
    setGrants(result.grants || []);
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [catalogResponse, grantResult] = await Promise.all([
          fetch("/api/catalog?type=doctors", { cache: "no-store" }),
          appointmentRequest<{ grants: Grant[] }>(user, "/api/patient/clinical-access"),
        ]);
        const catalog = await catalogResponse.json() as { ok?: boolean; results?: Doctor[] };
        if (!catalogResponse.ok || catalog.ok !== true) throw new Error("Les médecins vérifiés ne sont pas disponibles.");
        if (cancelled) return;
        setDoctors(catalog.results || []);
        setGrants(grantResult.grants || []);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Les autorisations cliniques ne sont pas disponibles.");
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [user]);

  async function issueAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!providerUid) { setError("Choisissez le médecin qui recevra l’autorisation."); return; }
    setBusy(true); setError(""); setNotice(""); setAccessCode("");
    try {
      const result = await appointmentRequest<{ accessCode: string; expiresAt: string }>(user, "/api/patient/clinical-access", "POST", { providerUid });
      setAccessCode(result.accessCode);
      setCodeExpiresAt(result.expiresAt);
      setNotice("Le code est prêt. Il peut être utilisé une seule fois par le médecin choisi.");
      await loadGrants();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le code d’autorisation n’a pas pu être créé."); }
    finally { setBusy(false); }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(accessCode);
      setNotice("Le code a été copié.");
    } catch { setError("La copie automatique est indisponible. Sélectionnez puis copiez le code."); }
  }

  async function revoke(grantId: string) {
    if (!window.confirm("Révoquer cette autorisation clinique? Le médecin perdra immédiatement l’accès lié à ce code.")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await appointmentRequest(user, "/api/patient/clinical-access", "DELETE", { grantId });
      await loadGrants();
      setNotice("L’autorisation a été révoquée.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "L’autorisation n’a pas pu être révoquée."); }
    finally { setBusy(false); }
  }

  return <section className="patient-appointments" aria-labelledby="patient-clinical-access-heading">
    <h2 id="patient-clinical-access-heading">Autoriser un médecin à consulter votre dossier</h2>
    <p>Votre numéro NMC seul ne donne aucun accès. Choisissez un médecin vérifié et transmettez-lui le code unique. Le code expire après 30 minutes; après utilisation, l’accès clinique dure 24 heures et peut être révoqué ici.</p>
    <form className="availability-form" onSubmit={(event) => void issueAccess(event)}>
      <label>Médecin destinataire<select required value={providerUid} onChange={(event) => setProviderUid(event.target.value)}><option value="">Choisir un médecin</option>{doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}{doctor.specialty ? ` · ${doctor.specialty}` : ""}</option>)}</select></label>
      <button className="button button-primary" type="submit" disabled={busy || loading || !doctors.length}>{busy ? "Création…" : "Créer un code d’accès"}</button>
    </form>
    {accessCode ? <div className="form-notice" role="status"><strong>Code à transmettre au médecin choisi</strong><output className="patient-access-code">{accessCode}</output><button className="button button-outline" type="button" onClick={() => void copyCode()}>Copier le code</button><small>Valable jusqu’au {dateLabel(codeExpiresAt)}. Le code ne sera plus affiché après avoir quitté cette page.</small></div> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p className="form-notice" role="status">{notice}</p> : null}
    <h3>Autorisations accordées</h3>
    {loading ? <p role="status">Chargement des autorisations…</p> : grants.length ? <ul>{grants.map((grant) => <li key={grant.grantId}>
      <span><strong>{grant.providerName}</strong><small>{statusLabels[grant.status] || grant.status}</small>{grant.status === "ISSUED" ? <small>Code valable jusqu’au {dateLabel(grant.expiresAt)}</small> : null}{grant.status === "CLAIMED" ? <small>Accès jusqu’au {dateLabel(grant.accessExpiresAt)}</small> : null}</span>
      {grant.status === "ISSUED" || grant.status === "CLAIMED" ? <button className="button button-quiet" type="button" disabled={busy} onClick={() => void revoke(grant.grantId)}>Révoquer</button> : null}
    </li>)}</ul> : <p>Aucune autorisation en cours.</p>}
  </section>;
}
