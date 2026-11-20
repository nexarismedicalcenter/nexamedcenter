"use client";

import { useState } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";

type Slot = { id: string; startsAt: string; endsAt: string };
type Appointment = { appointmentId: string; providerUid: string; status: string; paymentStatus: string };

export default function AppointmentManagement({ user, appointment, onUpdated }: { user: User; appointment: Appointment; onUpdated: () => void }) {
  const [editing, setEditing] = useState(false);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const canReschedule = appointment.status === "PENDING_PAYMENT" && appointment.paymentStatus === "PENDING";
  const canDismissExpired = appointment.status === "PAYMENT_EXPIRED" && appointment.paymentStatus === "EXPIRED";

  async function openRescheduling() {
    setEditing((value) => !value);
    setError(""); setNotice("");
    if (editing || slots.length || !appointment.providerUid) return;
    setBusy(true);
    try {
      const result = await fetch(`/api/providers/${encodeURIComponent(appointment.providerUid)}/availability`, { cache: "no-store" });
      const payload = await result.json() as { ok?: boolean; error?: string; slots?: Slot[] };
      if (!result.ok || payload.ok !== true) throw new Error(payload.error || "Les créneaux ne sont pas accessibles.");
      setSlots((payload.slots || []).filter((slot) => slot.id !== ""));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Les créneaux ne sont pas accessibles."); }
    finally { setBusy(false); }
  }

  async function reschedule() {
    if (!selectedSlot) { setError("Choisissez un nouveau créneau."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      await appointmentRequest(user, `/api/appointments/${encodeURIComponent(appointment.appointmentId)}/manage`, "POST", { action: "reschedule", slotId: selectedSlot });
      setNotice("Nouvel horaire réservé. Le délai de paiement repart pour 20 minutes.");
      window.setTimeout(onUpdated, 350);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le créneau n’a pas pu être modifié."); }
    finally { setBusy(false); }
  }

  async function dismissExpired() {
    if (!window.confirm("Masquer ce rendez-vous expiré de votre espace ? Il restera conservé dans l’historique NEXA et aucun paiement ni remboursement ne sera déclenché.")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await appointmentRequest(user, `/api/appointments/${encodeURIComponent(appointment.appointmentId)}/manage`, "POST", { action: "dismiss-expired" });
      setNotice("Le rendez-vous expiré a été masqué de votre espace.");
      window.setTimeout(onUpdated, 350);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le rendez-vous expiré n’a pas pu être masqué."); }
    finally { setBusy(false); }
  }

  if (!canReschedule && !canDismissExpired) return null;
  return <div className="appointment-management">
    <div className="appointment-management-actions">
      {canReschedule ? <button className="button button-outline" disabled={busy} onClick={() => void openRescheduling()} type="button">{editing ? "Fermer les créneaux" : "Modifier l’horaire"}</button> : null}
      {canDismissExpired ? <button className="button button-quiet" disabled={busy} onClick={() => void dismissExpired()} type="button">Masquer le rendez-vous expiré</button> : null}
    </div>
    {editing ? <div className="appointment-reschedule"><label>Choisissez un nouvel horaire<select value={selectedSlot} onChange={(event) => setSelectedSlot(event.target.value)}><option value="">Sélectionner un créneau</option>{slots.map((slot) => <option key={slot.id} value={slot.id}>{new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "full", timeStyle: "short" }).format(new Date(slot.startsAt))}</option>)}</select></label><button className="button button-primary" disabled={busy || !selectedSlot} onClick={() => void reschedule()} type="button">{busy ? "Mise à jour…" : "Confirmer le nouvel horaire"}</button>{!busy && !slots.length ? <small>Aucun autre créneau disponible pour le moment.</small> : null}</div> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}{notice ? <p className="form-notice" role="status">{notice}</p> : null}
  </div>;
}
