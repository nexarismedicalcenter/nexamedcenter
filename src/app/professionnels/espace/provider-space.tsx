"use client";

import Link from "next/link";
import { onAuthStateChanged, type User } from "firebase/auth";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { appointmentRequest } from "@/lib/appointments/client";
import { haitiLocalDateTimeToIso } from "@/lib/appointments/time";
import { getFirebaseAuth } from "@/lib/firebase/client";
import NotificationInbox from "@/app/espace/notification-inbox";
import PharmacyProductManager from "./pharmacy-product-manager";
import DiagnosticOfferManager from "./diagnostic-offer-manager";
import DiagnosticOrderManager from "./diagnostic-order-manager";
import DiagnosticResultManager from "./diagnostic-result-manager";
import PatientResultFollowUpManager from "./patient-result-follow-up-manager";
import ProviderActivityHistory from "./provider-activity-history";
import LabSupport from "./lab-support";
import ProviderRecordLibrary from "./record-library";
import NursingServiceProfileForm from "./nursing-service-profile-form";
import { NEXA_TELECONSULTATION_DURATION_MINUTES } from "@/lib/teleconsultation/policy";
import { getHomeVisitServiceLabel } from "@/lib/home-visits";
import HomeVisitMissionClosure from "./home-visit-mission-closure";
import HomeVisitClinicalTools from "./home-visit-clinical-tools";

type ProviderSlot = { id: string; startsAt: string; endsAt: string; status: string; serviceType?: "TELECONSULTATION" | "HOME_VISIT" };
type ProviderAppointment = { appointmentId: string; bookingType: string; patientName: string; startsAt: string; endsAt: string; durationMinutes: number; homeVisitServiceId?: string; homeVisitDetails?: { department: string; commune: string; addressLine: string; contactPhone: string }; homeVisitMissionStatus?: string; clinicalAccessExpiresAt: string | null; amount: number; status: string; paymentStatus: string; noShowOutcome?: string; noShowAt?: string };
type ProviderType = "doctor" | "nurse" | "pharmacy" | "laboratory" | "imaging";

export default function ProviderSpace() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [providerType, setProviderType] = useState<ProviderType | "">("");
  const [slots, setSlots] = useState<ProviderSlot[]>([]);
  const [appointments, setAppointments] = useState<ProviderAppointment[]>([]);
  const [startsAt, setStartsAt] = useState("");
  const [slotServiceType, setSlotServiceType] = useState<"TELECONSULTATION" | "HOME_VISIT">("TELECONSULTATION");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [currentTime, setCurrentTime] = useState(0);

  const loadSlots = useCallback(async (activeUser: User) => {
    const [result, appointmentResult] = await Promise.all([
      appointmentRequest<{ slots: ProviderSlot[] }>(activeUser, "/api/provider/availability"),
      appointmentRequest<{ appointments: ProviderAppointment[] }>(activeUser, "/api/provider/appointments"),
    ]);
    setSlots(result.slots || []);
    setAppointments(appointmentResult.appointments || []);
  }, []);

  useEffect(() => onAuthStateChanged(getFirebaseAuth(), (currentUser) => {
    setUser(currentUser);
    if (!currentUser) {
      router.replace(`/connexion?next=${encodeURIComponent("/professionnels/espace")}`);
      return;
    }
    setLoading(true); setError("");
    void (async () => {
      try {
        const result = await appointmentRequest<{ provider: { type: ProviderType } }>(currentUser, "/api/provider/profile");
        setProviderType(result.provider.type);
        if (result.provider.type === "doctor") await loadSlots(currentUser);
        else { setSlots([]); setAppointments([]); }
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Votre espace professionnel n’est pas disponible."); }
      finally { setLoading(false); }
    })();
  }), [loadSlots, router]);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 30_000);
    const initialTimer = window.setTimeout(() => setCurrentTime(Date.now()), 0);
    return () => { window.clearInterval(timer); window.clearTimeout(initialTimer); };
  }, []);

  async function addSlot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user || !startsAt) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const isoStart = haitiLocalDateTimeToIso(startsAt);
      if (!isoStart) throw new Error("Cette heure n’existe pas dans le fuseau d’Haïti. Choisissez une autre heure.");
      const result = await appointmentRequest<{ created: number; duplicates: number }>(user, "/api/provider/availability", "POST", { startsAt: [isoStart], serviceType: slotServiceType });
      setNotice(result.created ? slotServiceType === "HOME_VISIT" ? "Le créneau d’une heure pour une visite à domicile est publié." : "Le créneau de téléconsultation est publié." : "Ce créneau était déjà publié pour ce service.");
      setStartsAt("");
      await loadSlots(user);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le créneau n’a pas pu être publié."); }
    finally { setBusy(false); }
  }

  async function removeSlot(slotId: string) {
    if (!user) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await appointmentRequest(user, "/api/provider/availability", "DELETE", { slotId });
      setNotice("Le créneau a été retiré.");
      await loadSlots(user);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le créneau n’a pas pu être retiré."); }
    finally { setBusy(false); }
  }

  async function updateAppointment(appointment: ProviderAppointment, action: "accept" | "start" | "complete" | "refuse") {
    if (!user) return;
    if (action === "refuse" && !window.confirm("Refuser cette téléconsultation? Le montant du service sera crédité au portefeuille NEXA du patient; les frais de transaction ne sont pas remboursés.")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await appointmentRequest<{ status: string; refundedAmount?: number }>(user, "/api/provider/appointments", "POST", { appointmentId: appointment.appointmentId, action });
      if (action === "start") {
        router.push(`/teleconsultation?appointmentId=${encodeURIComponent(appointment.appointmentId)}`);
        return;
      }
      setNotice(action === "accept" ? "Le rendez-vous est accepté." : action === "refuse" ? `La téléconsultation est refusée; ${new Intl.NumberFormat("fr-HT").format(result.refundedAmount || 0)} HTG ont été crédités au patient.` : "La séance est terminée.");
      await loadSlots(user);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le rendez-vous n’a pas pu être mis à jour."); }
    finally { setBusy(false); }
  }

  const statusLabels: Record<string, string> = {
    PENDING_PAYMENT: "Paiement en attente",
    CONFIRMED: "Payé · à accepter",
    DOCTOR_ACCEPTED: "Accepté · prêt à démarrer à l’heure prévue",
    IN_PROGRESS: "Séance en cours",
    COMPLETED: "Terminé",
    REFUNDED: "Remboursée au patient",
    PROVIDER_REFUSED: "Téléconsultation refusée · remboursement en cours",
    PROVIDER_NO_SHOW_REFUND_REQUIRED: "Absence du médecin · remboursement en cours",
    PATIENT_NO_SHOW_RETAINED: "Patient absent · montant conservé par NEXA, aucun versement médecin",
    PAYMENT_EXPIRED: "Réservation expirée",
    PAYMENT_CONFLICT_REFUND_REQUIRED: "Règlement à rapprocher par NEXA",
  };

  return (
    <main className="appointment-page">
      <header className="directory-header"><Link className="brand brand-compact" href="/" aria-label="NEXA Medical Center, accueil"><span className="brand-mark" aria-hidden="true">N</span><span>NEXA <small>MEDICAL CENTER</small></span></Link><Link className="button button-outline" href="/">Retour à l’accueil</Link></header>
      <section className="appointment-shell">
        <p className="eyebrow">Espace professionnel NEXA</p><h1>{providerType === "nurse" ? "Votre affiliation infirmière." : providerType === "pharmacy" ? "Votre catalogue pharmacie." : providerType === "doctor" ? "Vos disponibilités." : "Votre espace partenaire."}</h1>
        <p className="appointment-intro">{providerType === "nurse" ? "Complétez votre profil de soins infirmiers à domicile. NEXA vérifie les services, les zones et les disponibilités avant toute publication." : providerType === "pharmacy" ? "Gérez les fiches de médicaments de votre pharmacie. Chaque fiche est vérifiée par NEXA avant d’être proposée aux patients." : providerType === "doctor" ? `Publiez des créneaux distincts : ${NEXA_TELECONSULTATION_DURATION_MINUTES} minutes pour une téléconsultation ou une heure pour une visite à domicile. Les horaires sont affichés selon le fuseau d’Haïti. Un créneau réservé ne peut plus être retiré depuis cette page.` : providerType === "laboratory" || providerType === "imaging" ? "Gérez les examens et services de votre établissement. NEXA vérifie chaque offre avant sa publication." : "Votre espace professionnel charge les outils disponibles pour ce profil."}</p>
        {error ? <p className="form-error" role="alert">{error}</p> : null}{notice ? <p className="form-notice" role="status">{notice}</p> : null}
        {user && providerType === "nurse" ? <NursingServiceProfileForm user={user} /> : null}
        {user ? <NotificationInbox user={user} /> : null}
        {user && providerType === "doctor" ? <><ProviderRecordLibrary user={user} /><PatientResultFollowUpManager user={user} /></> : null}
        {user && providerType === "pharmacy" ? <PharmacyProductManager user={user} /> : null}
        {user && (providerType === "laboratory" || providerType === "imaging") ? <><DiagnosticOrderManager user={user} providerType={providerType} /><DiagnosticResultManager user={user} providerType={providerType} /><DiagnosticOfferManager user={user} providerType={providerType} /><ProviderActivityHistory user={user} /></> : null}
        {user && providerType === "laboratory" ? <LabSupport user={user} /> : null}
        {providerType === "doctor" ? <>
        <form className="availability-form" onSubmit={addSlot}><label>Service<select value={slotServiceType} onChange={(event) => setSlotServiceType(event.target.value as "TELECONSULTATION" | "HOME_VISIT")}><option value="TELECONSULTATION">Téléconsultation · 30 minutes réservées</option><option value="HOME_VISIT">Visite médicale à domicile · 1 heure</option></select></label><label>Début du créneau (heure d’Haïti)<input required type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} /></label><button className="button button-primary" disabled={busy || !user} type="submit">{busy ? "Enregistrement…" : `Publier ${slotServiceType === "HOME_VISIT" ? "1 heure" : "30 minutes"}`}</button></form>
        <section className="provider-slots" aria-labelledby="provider-appointments-title"><h2 id="provider-appointments-title">Rendez-vous</h2>{loading ? <p role="status">Chargement des rendez-vous…</p> : appointments.length ? <ul>{appointments.map((appointment) => {
          const canStart = currentTime >= Date.parse(appointment.startsAt) && currentTime <= Date.parse(appointment.endsAt) + 15 * 60_000;
          const clinicalAccessActive = Boolean(currentTime > 0 && appointment.clinicalAccessExpiresAt && currentTime < Date.parse(appointment.clinicalAccessExpiresAt));
          const isHomeVisit = appointment.bookingType === "home_visit";
          const missionStatusLabels: Record<string, string> = { SCHEDULED: "Visite payée · à réaliser", AWAITING_PROVIDER_CODE: "Patient confirmé · code de clôture requis", ADMIN_REVIEW_REQUIRED: "Vérification NEXA requise", PROVIDER_ABSENT_REFUND_REQUIRED: "Absence signalée · remboursement en cours", REFUNDED: "Prix du service remboursé au patient", COMPLETED: "Mission clôturée" };
          return <li key={appointment.appointmentId}><span><strong>{appointment.patientName}</strong><small>{formatSlot(appointment.startsAt)} · {isHomeVisit ? `${getHomeVisitServiceLabel(appointment.homeVisitServiceId)} · visite à domicile · 1 heure` : `téléconsultation ${appointment.durationMinutes || NEXA_TELECONSULTATION_DURATION_MINUTES} min`} · {new Intl.NumberFormat("fr-HT").format(appointment.amount)} HTG</small>{isHomeVisit && appointment.homeVisitDetails ? <small>Adresse : {[appointment.homeVisitDetails.addressLine, appointment.homeVisitDetails.commune, appointment.homeVisitDetails.department].filter(Boolean).join(", ")} · Tél. {appointment.homeVisitDetails.contactPhone}</small> : null}<small>{isHomeVisit ? missionStatusLabels[appointment.homeVisitMissionStatus || ""] || statusLabels[appointment.status] || appointment.status : statusLabels[appointment.status] || appointment.status}</small>{isHomeVisit && appointment.homeVisitMissionStatus === "ADMIN_REVIEW_REQUIRED" ? <small>Le formulaire patient indique un point à vérifier. Le code de clôture ne peut pas être utilisé; contactez NEXA.</small> : null}{isHomeVisit && appointment.homeVisitMissionStatus === "COMPLETED" ? <small>{clinicalAccessActive ? "Le dossier clinique peut être complété pendant 24 heures après la clôture." : "La période d’accès clinique de 24 heures est terminée."}</small> : null}{appointment.noShowOutcome === "PROVIDER_UNRESPONSIVE" ? <small>Deux appels initiés par le patient sont restés sans réponse de votre part. Le prix du service est remboursé au patient; les frais de transaction restent à NEXA.</small> : null}</span><div className="provider-appointment-actions">{isHomeVisit && appointment.homeVisitMissionStatus === "AWAITING_PROVIDER_CODE" && user ? <HomeVisitMissionClosure user={user} appointmentId={appointment.appointmentId} onClosed={() => void loadSlots(user)} /> : null}{isHomeVisit && appointment.status === "COMPLETED" && clinicalAccessActive && user ? <HomeVisitClinicalTools user={user} appointmentId={appointment.appointmentId} /> : null}{!isHomeVisit && appointment.status === "CONFIRMED" ? <><button className="button button-outline" disabled={busy} onClick={() => void updateAppointment(appointment, "accept")} type="button">Accepter</button>{appointment.bookingType === "teleconsultation" ? <button className="button button-quiet" disabled={busy} onClick={() => void updateAppointment(appointment, "refuse")} type="button">Refuser</button> : null}</> : null}{!isHomeVisit && appointment.status === "DOCTOR_ACCEPTED" ? <button className="button button-primary" disabled={busy || !canStart} onClick={() => void updateAppointment(appointment, "start")} type="button">{canStart ? "Démarrer" : "À l’heure prévue"}</button> : null}{!isHomeVisit && appointment.status === "IN_PROGRESS" ? <><Link className="button button-outline" href={`/teleconsultation?appointmentId=${encodeURIComponent(appointment.appointmentId)}`}>Ouvrir la séance</Link><button className="button button-primary" disabled={busy} onClick={() => void updateAppointment(appointment, "complete")} type="button">Terminer</button></> : null}{!isHomeVisit && appointment.status === "COMPLETED" ? clinicalAccessActive ? <Link className="button button-outline" href={`/teleconsultation?appointmentId=${encodeURIComponent(appointment.appointmentId)}`}>Ouvrir le dossier</Link> : <small>Accès clinique expiré</small> : null}</div></li>;
        })}</ul> : <p>Aucun rendez-vous enregistré.</p>}</section>
        <section className="provider-slots" aria-labelledby="provider-slots-title"><h2 id="provider-slots-title">Créneaux à venir</h2>{loading ? <p role="status">Chargement des disponibilités…</p> : slots.length ? <ul>{slots.map((slot) => <li key={slot.id}><span><strong>{formatSlot(slot.startsAt)}</strong><small>{slot.serviceType === "HOME_VISIT" ? "Visite à domicile · 1 heure" : `Téléconsultation · 30 minutes`}</small><small>{slot.status === "available" ? "Disponible" : slot.status === "held" ? "Réservation en cours" : slot.status === "booked" ? "Réservé" : slot.status}</small></span>{slot.status === "available" ? <button className="button button-outline" disabled={busy} onClick={() => void removeSlot(slot.id)} type="button">Retirer</button> : null}</li>)}</ul> : <p>Aucun créneau publié pour les 90 prochains jours.</p>}</section>
        <p className="appointment-privacy">La console NEXA ne gère pas encore les annulations, les remboursements ni les notifications de changement. Le dossier d’une téléconsultation se complète dans sa salle dédiée; après la clôture d’une visite à domicile, l’évaluation médicale et l’ordonnance restent accessibles au médecin pendant 24 heures.</p>
        </> : null}
      </section>
      <footer className="directory-footer"><Link href="/conditions">Conditions</Link><Link href="/confidentialite">Confidentialité</Link><span>© 2026 NEXA Medical Center</span></footer>
    </main>
  );
}

function formatSlot(value: string) {
  return new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "full", timeStyle: "short" }).format(new Date(value));
}
