"use client";

import Link from "next/link";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getFirebaseAuth } from "@/lib/firebase/client";
import { appointmentRequest } from "@/lib/appointments/client";
import { initializePatientProfile } from "@/lib/patients/client";
import AppointmentManagement from "./appointment-management";
import NotificationInbox from "./notification-inbox";
import PatientPrescriptions from "./patient-prescriptions";
import PatientOrders from "./patient-orders";
import PatientDiagnosticResults from "./patient-diagnostic-results";
import PatientClinicalRecordDetails from "./patient-clinical-record";
import PatientClinicalAccess from "./patient-clinical-access";
import PatientMedicalProfile from "./patient-medical-profile";
import PatientWallet from "./patient-wallet";
import CashRefundRequest from "./cash-refund-request";
import HomeVisitFeedbackForm from "./home-visit-feedback-form";
import HomeVisitRefundRetry from "./home-visit-refund-retry";
import { getHomeVisitServiceLabel } from "@/lib/home-visits";

type AppointmentSummary = {
  appointmentId: string;
  bookingType?: string;
  providerUid: string;
  providerName: string;
  startsAt: string;
  endsAt: string;
  durationMinutes?: number;
  homeVisitServiceId?: string;
  homeVisitDetails?: { department: string; commune: string; addressLine: string; contactPhone: string };
  homeVisitMissionStatus?: string;
  homeVisitMissionCode?: string;
  amount: number;
  currency: string;
  status: string;
  paymentStatus: string;
  refundMethod?: string;
  refundStatus?: string;
  requestedRefundMethod?: string;
  noShowOutcome?: string;
  refundRequired?: boolean;
  paymentRef?: string;
};

type ClinicalRecordSummary = {
  recordId: string;
  recordType?: "APPOINTMENT" | "STANDALONE";
  appointmentId?: string;
  recordNumber: string;
  status: string;
  providerName: string;
  specialtyName: string;
  createdAt: string | null;
  finalizedAt: string | null;
  addendumCount: number;
};

export default function PatientSpace() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [patientNumber, setPatientNumber] = useState("");
  const [appointments, setAppointments] = useState<AppointmentSummary[]>([]);
  const [clinicalRecords, setClinicalRecords] = useState<ClinicalRecordSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [walletPaymentId, setWalletPaymentId] = useState("");
  const [walletPaymentError, setWalletPaymentError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => setCurrentTime(Date.now()), 0);
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 30_000);
    return () => { window.clearTimeout(initialTimer); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    const auth = getFirebaseAuth();
    return onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (!currentUser) {
        router.replace("/connexion");
        return;
      }

      try {
        const profile = await initializePatientProfile(currentUser);
        if (!profile.profileComplete) {
          router.replace("/inscription?completer=1");
          return;
        }
        setPatientNumber(profile.patientNumber);
        const [appointmentResult, recordResult] = await Promise.all([
          appointmentRequest<{ appointments: AppointmentSummary[] }>(currentUser, "/api/appointments"),
          appointmentRequest<{ records: ClinicalRecordSummary[] }>(currentUser, "/api/patient/clinical-records"),
        ]);
        setAppointments(appointmentResult.appointments || []);
        setClinicalRecords(recordResult.records || []);
        setError("");
      } catch {
        setError("Votre espace ne peut pas être chargé pour le moment.");
      } finally {
        setLoading(false);
      }
    });
  }, [router]);

  async function handleSignOut() {
    await signOut(getFirebaseAuth());
    router.replace("/");
  }

  async function resumePayment(paymentRef: string) {
    if (!user) return;
    setError("");
    try {
      const result = await appointmentRequest<{ status: string; checkoutUrl?: string }>(user, "/api/payments/moncash/create", "POST", { paymentRef });
      if (result.status === "paid") {
        router.push(`/paiement/retour?paymentRef=${encodeURIComponent(paymentRef)}`);
        return;
      }
      const checkoutUrl = new URL(result.checkoutUrl || "");
      if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "moncashbutton.digicelgroup.com") throw new Error("Le lien MonCash n’est pas valide.");
      window.location.assign(checkoutUrl.toString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Le paiement ne peut pas être repris.");
    }
  }

  async function payAppointmentWithWallet(appointmentId: string) {
    if (!user) return;
    setWalletPaymentId(appointmentId); setWalletPaymentError("");
    try {
      await appointmentRequest(user, `/api/appointments/${encodeURIComponent(appointmentId)}/pay-wallet`, "POST", {});
      window.location.reload();
    } catch (cause) {
      setWalletPaymentError(cause instanceof Error ? cause.message : "Le portefeuille NEXA n’a pas pu payer ce rendez-vous.");
    } finally { setWalletPaymentId(""); }
  }

  const appointmentStatus: Record<string, string> = {
    PENDING_PAYMENT: "Paiement en attente",
    CONFIRMED: "Confirmé",
    PAYMENT_EXPIRED: "Réservation expirée",
    PAYMENT_CONFLICT_REFUND_REQUIRED: "Paiement à régulariser avec NEXA",
    PROVIDER_NO_SHOW_REFUND_REQUIRED: "Absence du médecin · remboursement en cours",
    PATIENT_NO_SHOW_RETAINED: "Téléconsultation manquée",
    REFUNDED: "Remboursé dans le portefeuille NEXA",
    DOCTOR_ACCEPTED: "Confirmé par le médecin",
    IN_PROGRESS: "Séance en cours",
    COMPLETED: "Terminé",
    PROVIDER_REFUSED: "Téléconsultation refusée · remboursement en cours",
  };
  const recordStatus: Record<string, string> = {
    DRAFT: "En préparation par le médecin",
    TO_FINALIZE: "En attente de finalisation",
    SIGNED: "Finalisé",
    FINALIZED: "Finalisé",
  };
  const homeVisitMissionLabels: Record<string, string> = {
    AWAITING_PAYMENT: "En attente de paiement",
    SCHEDULED: "Payée · visite à réaliser",
    AWAITING_PROVIDER_CODE: "Confirmation reçue · clôture du médecin en attente",
    ADMIN_REVIEW_REQUIRED: "Vérification NEXA requise",
    PROVIDER_ABSENT_REFUND_REQUIRED: "Absence signalée · remboursement en cours",
    REFUNDED: "Prix du service remboursé",
    COMPLETED: "Mission clôturée",
  };

  return (
    <main className="dashboard-page">
      <div className="auth-topline"><Link className="brand brand-compact" href="/" aria-label="NEXA Medical Center, accueil"><span className="brand-mark">N</span><span>NEXA <small>MEDICAL CENTER</small></span></Link><button className="button button-quiet" disabled={!user} onClick={handleSignOut} type="button">Se déconnecter</button></div>
      <section className="dashboard-shell dashboard-card">
        {loading ? <p role="status">Chargement de votre espace…</p> : error ? <div><h1>Un problème est survenu.</h1><p>{error}</p><button className="button button-primary" onClick={() => window.location.reload()} type="button">Réessayer</button></div> : (
          <>
            <p className="eyebrow">Espace patient NEXA</p>
            <h1>Bonjour{user?.displayName ? `, ${user.displayName.split(" ")[0]}` : ""}.</h1>
            <p>Votre compte patient est prêt. Votre numéro personnel reste associé à votre profil NEXA.</p>
            <div className="dashboard-number"><span>Votre numéro patient</span><strong>{patientNumber}</strong></div>
            <p>Ce numéro permet à l’équipe autorisée de retrouver votre dossier. Il ne remplace pas vos identifiants de connexion.</p>
            {user ? <PatientMedicalProfile user={user} /> : null}
            {user ? <PatientWallet user={user} /> : null}
            {user ? <NotificationInbox user={user} /> : null}
            {user ? <PatientPrescriptions user={user} /> : null}
            {user ? <PatientOrders user={user} /> : null}
            {user ? <PatientDiagnosticResults user={user} /> : null}
            {user ? <PatientClinicalAccess user={user} /> : null}
            <section className="patient-appointments" aria-labelledby="patient-appointments-heading">
              <h2 id="patient-appointments-heading">Mes rendez-vous</h2>
              {walletPaymentError ? <p className="form-error" role="alert">{walletPaymentError}</p> : null}
              {appointments.length ? <ul>{appointments.map((appointment) => <li className={appointment.bookingType === "home_visit" ? "home-visit-appointment-item" : undefined} key={appointment.appointmentId}>
                <div><strong>{appointment.providerName}</strong><span>{appointment.startsAt ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(new Date(appointment.startsAt)) : "Horaire à confirmer"}</span>{appointment.bookingType === "home_visit" ? <small>{getHomeVisitServiceLabel(appointment.homeVisitServiceId)} · visite médicale à domicile · 1 heure</small> : appointment.bookingType === "doctor_proposed_appointment" ? <small>Rendez-vous proposé par votre médecin</small> : appointment.durationMinutes ? <small>Téléconsultation · {appointment.durationMinutes} minutes</small> : null}{appointment.bookingType === "home_visit" && appointment.homeVisitDetails ? <small>Adresse : {[appointment.homeVisitDetails.addressLine, appointment.homeVisitDetails.commune, appointment.homeVisitDetails.department].filter(Boolean).join(", ")} · Tél. {appointment.homeVisitDetails.contactPhone}</small> : null}<small>{appointment.status === "REFUNDED" && appointment.refundMethod === "CASH_MANUAL" ? "Remboursement en espèces enregistré par NEXA" : appointment.status === "REFUNDED" && appointment.refundMethod === "NEXA_WALLET" ? "Remboursé dans le portefeuille NEXA" : appointmentStatus[appointment.status] || appointment.status}</small>{appointment.homeVisitMissionCode ? <div className="home-visit-mission-code"><strong>Code de clôture : {appointment.homeVisitMissionCode}</strong><small>Donnez ce code au médecin uniquement après sa visite et après avoir confirmé sa présence.</small></div> : null}{appointment.bookingType === "home_visit" && appointment.paymentStatus === "PAID" ? <small>État de la mission : {appointment.status === "REFUNDED" ? appointment.refundMethod === "CASH_MANUAL" ? "Absence confirmée · remboursement en espèces effectué" : "Absence confirmée · prix du service remboursé au Wallet" : homeVisitMissionLabels[appointment.homeVisitMissionStatus || ""] || "À suivre par NEXA"}. Les frais de transaction restent acquis à NEXARIS; un éventuel remboursement porte sur le prix du service.</small> : null}{appointment.noShowOutcome === "PROVIDER_UNRESPONSIVE" ? <small>Le prix du service est crédité au portefeuille NEXA; les frais de transaction ne sont pas remboursés.</small> : null}{appointment.noShowOutcome === "PATIENT_UNRESPONSIVE" ? <small>Le montant du service reste à NEXA après deux appels initiés par le médecin et restés sans réponse de votre part.</small> : null}{appointment.status === "PAYMENT_CONFLICT_REFUND_REQUIRED" ? <small>Ne relancez pas le paiement. NEXA doit vérifier le règlement et le remboursement avec le prestataire.</small> : null}{appointment.status === "REFUNDED" ? <small>{appointment.refundMethod === "NEXA_WALLET" ? "Le montant a été crédité dans votre portefeuille NEXA." : appointment.refundMethod === "MONCASH_EXTERNAL" ? "Le remboursement externe MonCash a été confirmé par NEXA." : "NEXA a enregistré le remboursement."}</small> : null}{appointment.status === "PAYMENT_CONFLICT_REFUND_REQUIRED" && appointment.paymentStatus === "PAID" && appointment.refundRequired ? <CashRefundRequest user={user!} resourceType="appointment" resourceId={appointment.appointmentId} alreadyRequested={appointment.requestedRefundMethod === "CASH_MANUAL"} /> : null}</div>
                {user && appointment.bookingType === "home_visit" && appointment.paymentStatus === "PAID" && appointment.status === "CONFIRMED" && appointment.homeVisitMissionStatus === "SCHEDULED" && currentTime >= Date.parse(appointment.endsAt) ? <HomeVisitFeedbackForm user={user} appointmentId={appointment.appointmentId} onSubmitted={() => window.location.reload()} /> : null}
                {appointment.bookingType === "home_visit" && appointment.homeVisitMissionStatus === "ADMIN_REVIEW_REQUIRED" ? <p role="status">Votre formulaire a été transmis à NEXA pour vérification. Le code de clôture reste désactivé.</p> : null}
                {appointment.bookingType === "home_visit" && appointment.status === "PROVIDER_NO_SHOW_REFUND_REQUIRED" && appointment.requestedRefundMethod === "CASH_MANUAL" && appointment.refundStatus === "PENDING_MANUAL_CASH" ? <p role="status">Votre demande de remboursement en espèces est en attente de traitement par l’administration NEXA. Aucun remboursement n’a été crédité au Wallet. Les frais de transaction ne sont pas remboursés.</p> : null}
                {user && appointment.bookingType === "home_visit" && appointment.status === "PROVIDER_NO_SHOW_REFUND_REQUIRED" && appointment.refundStatus === "PENDING_AUTO_REFUND" ? <HomeVisitRefundRetry user={user} appointmentId={appointment.appointmentId} /> : null}
                <div className="provider-appointment-actions">{appointment.paymentRef ? <><button className="button button-primary" onClick={() => void resumePayment(appointment.paymentRef!)} type="button">Continuer avec MonCash</button><button className="button button-outline" disabled={Boolean(walletPaymentId)} onClick={() => void payAppointmentWithWallet(appointment.appointmentId)} type="button">{walletPaymentId === appointment.appointmentId ? "Paiement en cours…" : "Payer avec le portefeuille NEXA"}</button></> : appointment.bookingType !== "home_visit" && appointment.status === "IN_PROGRESS" ? <Link className="button button-primary" href={`/teleconsultation?appointmentId=${encodeURIComponent(appointment.appointmentId)}`}>Ouvrir la séance</Link> : appointment.bookingType !== "home_visit" && appointment.status === "DOCTOR_ACCEPTED" && currentTime >= Date.parse(appointment.startsAt) ? <Link className="button button-primary" href={`/teleconsultation?appointmentId=${encodeURIComponent(appointment.appointmentId)}`}>Rejoindre la salle d’attente</Link> : appointment.bookingType !== "home_visit" && appointment.status === "DOCTOR_ACCEPTED" ? <small>La salle d’attente ouvrira à l’heure prévue.</small> : null}{appointment.status === "PAYMENT_EXPIRED" ? <Link className="button button-outline" href={appointment.bookingType === "home_visit" ? "/care/visites-a-domicile" : appointment.providerUid ? `/rendez-vous/${encodeURIComponent(appointment.providerUid)}` : "/medecins"}>Choisir un nouveau créneau</Link> : null}{user && appointment.bookingType !== "home_visit" ? <AppointmentManagement user={user} appointment={appointment} onUpdated={() => window.location.reload()} /> : null}</div>
              </li>)}</ul> : <p>Vous n’avez pas encore de rendez-vous.</p>}
            </section>
            <section className="patient-appointments" id="dossiers-cliniques" aria-labelledby="patient-records-heading">
              <h2 id="patient-records-heading">Mes dossiers de consultation</h2>
              {clinicalRecords.length ? <ul>{clinicalRecords.map((record) => <li key={record.recordId}><div><strong>{record.providerName || "Professionnel NEXA"}</strong><span>{record.specialtyName || (record.recordType === "STANDALONE" ? "Dossier clinique" : "Consultation")} · {record.createdAt ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium" }).format(new Date(record.createdAt)) : "Date à confirmer"}</span><small>{recordStatus[record.status] || record.status}</small>{record.addendumCount ? <small>{record.addendumCount} correction(s) ajoutée(s) après finalisation</small> : null}{user ? <PatientClinicalRecordDetails user={user} appointmentId={record.appointmentId} recordId={record.recordId} standalone={record.recordType === "STANDALONE"} /> : null}</div><span className="record-number">{record.recordNumber}</span></li>)}</ul> : <p>Aucun dossier clinique NEXA n’est encore disponible.</p>}
              <p className="appointment-privacy">Seuls les dossiers finalisés sont consultables ici. Vous pouvez les imprimer ou les enregistrer en PDF depuis votre navigateur.</p>
            </section>
            <div className="dashboard-toolbar"><Link className="button button-primary" href="/medecins">Trouver un professionnel</Link><Link className="button button-outline" href="/">Retour à l’accueil</Link></div>
          </>
        )}
      </section>
    </main>
  );
}
