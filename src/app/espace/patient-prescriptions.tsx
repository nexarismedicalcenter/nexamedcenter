"use client";

import { useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { getToken } from "firebase/app-check";
import { appointmentRequest } from "@/lib/appointments/client";
import { getFirebaseAppCheck } from "@/lib/firebase/client";

type PrescriptionItem = {
  id: string;
  appointmentId: string;
  providerName: string;
  specialtyName: string;
  medications: { name: string; dosage?: string; form?: string; route?: string; duration?: string; instructions?: string }[];
  labExams: string[];
  imagingExams: string[];
  notes: string;
  version: number;
  validatedAt: string | null;
};
type AvailabilityOffer = {
  id: string;
  type: "medication" | "laboratory" | "imaging";
  route: string;
  name: string;
  providerName: string;
  commune: string;
  department: string;
  price: number | null;
  dosage?: string;
  form?: string;
  stock?: number;
  appointmentRequired?: boolean;
};
type AvailabilityLine = { id: string; type: AvailabilityOffer["type"]; label: string; status: "DISPONIBLE" | "NON_DISPONIBLE"; offers: AvailabilityOffer[] };
type AvailabilityResult = { lines: AvailabilityLine[] };

export default function PatientPrescriptions({ user }: { user: User }) {
  const [prescriptions, setPrescriptions] = useState<PrescriptionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [availabilityBusyId, setAvailabilityBusyId] = useState("");
  const [availability, setAvailability] = useState<Record<string, AvailabilityResult>>({});
  const [availabilityErrors, setAvailabilityErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await appointmentRequest<{ prescriptions: PrescriptionItem[] }>(user, "/api/patient/prescriptions");
      setPrescriptions(result.prescriptions || []);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Les ordonnances sont indisponibles."); }
    finally { setLoading(false); }
  }, [user]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function download(item: PrescriptionItem) {
    setBusyId(item.id); setError("");
    try {
      const headers = new Headers({ Authorization: `Bearer ${await user.getIdToken()}` });
      const appCheck = getFirebaseAppCheck();
      if (process.env.NODE_ENV === "production" && !appCheck) throw new Error("La protection App Check de NEXA n’est pas configurée.");
      if (appCheck) headers.set("X-Firebase-AppCheck", (await getToken(appCheck)).token);
      const response = await fetch(`/api/prescriptions/${encodeURIComponent(item.id)}/pdf`, { headers, cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || "Le PDF n’a pas pu être téléchargé.");
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `nexa-ordonnance-v${item.version}.pdf`; anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le PDF n’a pas pu être téléchargé."); }
    finally { setBusyId(""); }
  }

  async function checkAvailability(item: PrescriptionItem) {
    setAvailabilityBusyId(item.id);
    setAvailabilityErrors((current) => ({ ...current, [item.id]: "" }));
    try {
      const result = await appointmentRequest<AvailabilityResult>(user, `/api/patient/prescriptions/${encodeURIComponent(item.id)}/availability`);
      setAvailability((current) => ({ ...current, [item.id]: result }));
    } catch (cause) {
      setAvailabilityErrors((current) => ({ ...current, [item.id]: cause instanceof Error ? cause.message : "Les disponibilités sont indisponibles." }));
    } finally { setAvailabilityBusyId(""); }
  }

  return <section className="patient-appointments" aria-labelledby="patient-prescriptions-heading">
    <h2 id="patient-prescriptions-heading">Mes ordonnances</h2>
    {loading ? <p role="status">Chargement des ordonnances…</p> : error ? <div><p className="form-error" role="alert">{error}</p><button className="button button-outline" onClick={() => void load()} type="button">Réessayer</button></div> : prescriptions.length ? <div className="prescription-list">{prescriptions.map((item) => <article className="prescription-card prescription-patient-card" key={item.id}>
      <div><strong>Ordonnance · Version {item.version}</strong><small>{item.providerName}{item.specialtyName ? ` · ${item.specialtyName}` : ""}{item.validatedAt ? ` · ${new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium" }).format(new Date(item.validatedAt))}` : ""}</small></div>
      {item.medications.length ? <div><h3>Médicaments</h3><ul>{item.medications.map((medicine, index) => <li key={`${medicine.name}-${index}`}><strong>{medicine.name}</strong><span>{[medicine.dosage, medicine.form, medicine.route, medicine.duration].filter(Boolean).join(" · ")}</span>{medicine.instructions ? <small>{medicine.instructions}</small> : null}</li>)}</ul></div> : null}
      {item.labExams.length ? <div><h3>Laboratoire</h3><p>{item.labExams.join(" · ")}</p></div> : null}
      {item.imagingExams.length ? <div><h3>Imagerie</h3><p>{item.imagingExams.join(" · ")}</p></div> : null}
      {item.notes ? <div><h3>Notes du médecin</h3><p>{item.notes}</p></div> : null}
      <div className="prescription-availability">
        <button className="button button-outline" disabled={availabilityBusyId === item.id} onClick={() => void checkAvailability(item)} type="button">{availabilityBusyId === item.id ? "Recherche des disponibilités…" : availability[item.id] ? "Actualiser les disponibilités" : "Voir les disponibilités près de moi"}</button>
        {availabilityErrors[item.id] ? <p className="form-error" role="alert">{availabilityErrors[item.id]}</p> : null}
        {availability[item.id] ? <div className="prescription-availability-results" aria-live="polite">
          {availability[item.id].lines.map((line) => <section className="prescription-availability-line" key={line.id}>
            <h3>{line.label} <span>{line.status === "DISPONIBLE" ? "· Disponible" : "· Aucune correspondance trouvée"}</span></h3>
            {line.offers.length ? <ul>{line.offers.map((offer) => <li key={`${line.id}-${offer.id}`}>
              <strong>{offer.providerName}</strong>
              <span>{offer.name}{offer.dosage ? ` · ${offer.dosage}` : ""}{offer.form ? ` · ${offer.form}` : ""}{offer.commune || offer.department ? ` · ${[offer.commune, offer.department].filter(Boolean).join(", ")}` : ""}{offer.price !== null ? ` · ${new Intl.NumberFormat("fr-HT").format(offer.price)} HTG` : " · Prix à confirmer"}{typeof offer.stock === "number" ? ` · ${offer.stock} en stock` : ""}</span>
              {offer.appointmentRequired ? <small>Cette offre demande un rendez-vous avec le centre. Contactez-le avant de commander.</small> : null}
              <a className="button button-outline" href={`${offer.route}?${new URLSearchParams({ q: offer.name, prescriptionId: item.id, prescriptionLineId: line.id })}`}>Ouvrir Nexa - {offer.type === "medication" ? "Pharma" : offer.type === "laboratory" ? "Lab" : "Imaging"}</a>
            </li>)}</ul> : line.status === "NON_DISPONIBLE" ? <p>Votre ordonnance reste disponible. Vous pouvez réessayer plus tard.</p> : null}
          </section>)}
        </div> : null}
      </div>
      <button className="button button-outline" disabled={busyId === item.id} onClick={() => void download(item)} type="button">{busyId === item.id ? "Téléchargement…" : "Télécharger le PDF"}</button>
    </article>)}</div> : <p>Aucune ordonnance validée pour le moment.</p>}
  </section>;
}
