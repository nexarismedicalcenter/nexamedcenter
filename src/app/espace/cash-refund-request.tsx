"use client";

import { useState } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";

type ResourceType = "appointment" | "pharmacy-order" | "laboratory-order" | "imaging-order";

export default function CashRefundRequest({
  user,
  resourceType,
  resourceId,
  alreadyRequested,
}: {
  user: User;
  resourceType: ResourceType;
  resourceId: string;
  alreadyRequested: boolean;
}) {
  const [requested, setRequested] = useState(alreadyRequested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await appointmentRequest(user, "/api/patient/refunds/cash", "POST", { resourceType, resourceId });
      setRequested(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "La demande ne peut pas être envoyée.");
    } finally {
      setBusy(false);
    }
  }

  return <div className="cash-refund-request">
    {requested ? <small role="status">Votre demande de remboursement en espèces a été transmise à l’administration NEXA.</small> : <>
      <button className="button button-outline" disabled={busy} onClick={() => void submit()} type="button">
        {busy ? "Envoi de la demande…" : "Demander un remboursement en espèces"}
      </button>
      <small>La remise sera traitée manuellement par NEXA. Les frais de transaction éventuels ne sont pas remboursables.</small>
    </>}
    {error ? <small className="form-error" role="alert">{error}</small> : null}
  </div>;
}
