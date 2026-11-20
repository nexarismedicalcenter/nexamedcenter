"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";

type ProviderSlot = { id: string; startsAt: string; endsAt: string; status: string };

function formatSlot(value: string) {
  return new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "full", timeStyle: "short" }).format(new Date(value));
}

export default function FollowUpProposal({ user, appointmentId }: { user: User; appointmentId: string }) {
  const [slots, setSlots] = useState<ProviderSlot[]>([]);
  const [slotId, setSlotId] = useState("");
  const [note, setNote] = useState("");
  const [proposedSlotIds, setProposedSlotIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void appointmentRequest<{ slots: ProviderSlot[] }>(user, "/api/provider/availability")
      .then((result) => {
        if (!active) return;
        const available = (result.slots || []).filter((slot) => slot.status === "available" && Date.parse(slot.startsAt) > Date.now());
        setSlots(available);
        setSlotId(available[0]?.id || "");
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Les disponibilités ne sont pas accessibles."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [user]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!slotId || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await appointmentRequest<{ created: boolean; startsAt: string }>(
        user,
        `/api/appointments/${encodeURIComponent(appointmentId)}/follow-up-proposals`,
        "POST",
        { slotId, note: note.trim() },
      );
      setProposedSlotIds((current) => current.includes(slotId) ? current : [...current, slotId]);
      setNotice(result.created
        ? `Proposition envoyée pour le ${formatSlot(result.startsAt)}. Le créneau reste disponible jusqu’à sa réservation.`
        : "Cette proposition de suivi avait déjà été envoyée au patient.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "La proposition n’a pas été envoyée."); }
    finally { setBusy(false); }
  }

  return <section className="follow-up-proposal" aria-labelledby="follow-up-proposal-title">
    <h2 id="follow-up-proposal-title">Proposer un rendez-vous de suivi</h2>
    <p>Le patient recevra une notification et pourra régler ce rendez-vous s’il est toujours libre. Le paiement confirme le rendez-vous et le médecin ne pourra plus le refuser.</p>
    {loading ? <p role="status">Chargement de vos créneaux…</p> : slots.length ? <form onSubmit={(event) => void submit(event)}>
      <label>Créneau proposé<select required value={slotId} onChange={(event) => setSlotId(event.target.value)}><option value="" disabled>Choisissez un créneau</option>{slots.map((slot) => <option disabled={proposedSlotIds.includes(slot.id)} key={slot.id} value={slot.id}>{formatSlot(slot.startsAt)}{proposedSlotIds.includes(slot.id) ? " · déjà proposé" : ""}</option>)}</select></label>
      <label>Message au patient (facultatif)<textarea maxLength={300} onChange={(event) => setNote(event.target.value)} placeholder="Ne saisissez pas de diagnostic ni de détail médical ici." rows={3} value={note} /></label>
      <button className="button button-primary" disabled={busy || !slotId || proposedSlotIds.includes(slotId)} type="submit">{busy ? "Envoi…" : "Envoyer la proposition"}</button>
    </form> : <p>Aucun créneau libre n’est publié. Ajoutez d’abord des disponibilités dans votre espace professionnel.</p>}
    {error ? <p className="form-error" role="alert">{error}</p> : null}{notice ? <p className="form-notice" role="status">{notice}</p> : null}
  </section>;
}
