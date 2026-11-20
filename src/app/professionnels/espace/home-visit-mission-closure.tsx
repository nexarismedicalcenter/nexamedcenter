"use client";

import { useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";

export default function HomeVisitMissionClosure({ user, appointmentId, onClosed }: { user: User; appointmentId: string; onClosed: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await appointmentRequest(user, `/api/appointments/${encodeURIComponent(appointmentId)}/home-visit-close`, "POST", { code });
      onClosed();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "La mission ne peut pas être clôturée.");
    } finally { setBusy(false); }
  }

  return <form className="home-visit-close-form" onSubmit={(event) => void submit(event)}>
    <label>Code remis par le patient<input autoComplete="one-time-code" inputMode="numeric" maxLength={8} pattern="[0-9]{8}" required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))} /></label>
    <button className="button button-primary" disabled={busy || code.length !== 8} type="submit">{busy ? "Vérification…" : "Valider et clôturer la mission"}</button>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </form>;
}
