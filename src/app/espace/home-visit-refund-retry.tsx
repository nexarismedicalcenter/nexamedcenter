"use client";

import { useState } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";

export default function HomeVisitRefundRetry({ user, appointmentId }: { user: User; appointmentId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function retry() {
    setBusy(true); setError("");
    try {
      await appointmentRequest(user, `/api/appointments/${encodeURIComponent(appointmentId)}/home-visit-feedback`, "POST", { retryNoShowRefund: true });
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Le remboursement est toujours en attente.");
    } finally { setBusy(false); }
  }

  return <div className="home-visit-refund-retry"><button className="button button-outline" disabled={busy} onClick={() => void retry()} type="button">{busy ? "Reprise du remboursement…" : "Vérifier le remboursement Wallet"}</button>{error ? <small role="alert">{error}</small> : null}</div>;
}
