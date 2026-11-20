"use client";

import Link from "next/link";
import ServiceNavigation from "@/components/service-navigation";
import { onAuthStateChanged, type User } from "firebase/auth";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { appointmentRequest } from "@/lib/appointments/client";
import { getFirebaseAuth } from "@/lib/firebase/client";
import { initializePatientProfile } from "@/lib/patients/client";
import { NEXA_TELECONSULTATION_DURATION_MINUTES } from "@/lib/teleconsultation/policy";
import { getHomeVisitServiceLabel, HOME_VISIT_SERVICES } from "@/lib/home-visits";

type Provider = { id: string; name: string; specialty: string; department: string; commune: string; indicativeFee: number | null; consultationDurationMinutes: number; homeVisitTariffs?: Record<string, number>; homeVisitZones?: { department: string; commune: string }[]; serviceType?: string };
type Slot = { id: string; startsAt: string; endsAt: string };
type Booking = { appointmentId: string; paymentRef: string; amount: number; durationMinutes: number; transactionFee: number; totalAmount: number; transactionFeeRate: number; feeRecipient: string; currency: string; holdExpiresAt: string };

function formatSlot(value: string) {
  return new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "full", timeStyle: "short" }).format(new Date(value));
}

export default function AppointmentBooking({ providerUid }: { providerUid: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const suggestedSlotId = searchParams.get("slotId") || "";
  const followUpProposalId = searchParams.get("proposalId") || "";
  const serviceType = searchParams.get("serviceType") === "HOME_VISIT" ? "HOME_VISIT" : "TELECONSULTATION";
  const isHomeVisit = serviceType === "HOME_VISIT";
  const requestedHomeVisitServiceId = searchParams.get("serviceId") || HOME_VISIT_SERVICES[0].id;
  const homeVisitServiceId = HOME_VISIT_SERVICES.some((service) => service.id === requestedHomeVisitServiceId) ? requestedHomeVisitServiceId : "";
  const homeVisitServiceLabel = getHomeVisitServiceLabel(homeVisitServiceId);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedSlotId, setSelectedSlotId] = useState("");
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [booking, setBooking] = useState<Booking | null>(null);
  const [walletState, setWalletState] = useState<{ uid: string; available: number } | null>(null);
  const [visitDepartment, setVisitDepartment] = useState("");
  const [visitCommune, setVisitCommune] = useState("");
  const [visitAddress, setVisitAddress] = useState("");
  const [visitPhone, setVisitPhone] = useState("");

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(getFirebaseAuth(), setUser);
    return unsubscribe;
  }, []);

  useEffect(() => {
    let active = true;
    if (user) appointmentRequest<{ wallet: { available: number } }>(user, "/api/patient/wallet")
      .then((result) => { if (active) setWalletState({ uid: user.uid, available: result.wallet.available }); })
      .catch(() => { if (active) setWalletState(null); });
    return () => { active = false; };
  }, [user]);

  const loadAvailability = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/providers/${encodeURIComponent(providerUid)}/availability?serviceType=${serviceType}`, { cache: "no-store", signal });
      const payload = await response.json() as { ok?: boolean; provider?: Provider; slots?: Slot[]; error?: string };
      if (!response.ok || !payload.ok || !payload.provider) throw new Error(payload.error || "Ce profil n’est pas disponible.");
      if (signal?.aborted) return;
      setProvider(payload.provider);
      if (isHomeVisit && payload.provider.homeVisitZones?.length) {
        setVisitDepartment((current) => current || payload.provider!.homeVisitZones![0].department);
        setVisitCommune((current) => current || payload.provider!.homeVisitZones![0].commune);
      }
      setSlots(payload.slots || []);
      setSelectedSlotId((payload.slots || []).some((slot) => slot.id === suggestedSlotId) ? suggestedSlotId : "");
      setError("");
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : "Les disponibilités ne sont pas accessibles.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [providerUid, serviceType, isHomeVisit, suggestedSlotId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadAvailability(controller.signal);
    return () => controller.abort();
  }, [loadAvailability]);

  const selectedSlot = useMemo(() => slots.find((slot) => slot.id === selectedSlotId) || null, [selectedSlotId, slots]);
  const walletAvailable = walletState && user && walletState.uid === user.uid ? walletState.available : null;
  const returnParams = new URLSearchParams();
  if (suggestedSlotId) returnParams.set("slotId", suggestedSlotId);
  if (followUpProposalId) returnParams.set("proposalId", followUpProposalId);
  if (isHomeVisit) returnParams.set("serviceType", "HOME_VISIT");
  if (isHomeVisit && homeVisitServiceId) returnParams.set("serviceId", homeVisitServiceId);
  const returnQuery = returnParams.toString();
  const returnPath = `/rendez-vous/${encodeURIComponent(providerUid)}${returnQuery ? `?${returnQuery}` : ""}`;
  const displayedSlots = followUpProposalId ? slots.filter((slot) => slot.id === suggestedSlotId) : slots;

  async function startMoncashPayment(activeBooking: Booking) {
    const payment = await appointmentRequest<{ status: string; checkoutUrl?: string }>(user!, "/api/payments/moncash/create", "POST", { paymentRef: activeBooking.paymentRef });
    if (payment.status === "paid") {
      router.push(`/paiement/retour?paymentRef=${encodeURIComponent(activeBooking.paymentRef)}`);
      return;
    }
    let checkoutUrl: URL;
    try { checkoutUrl = new URL(payment.checkoutUrl || ""); } catch { throw new Error("Le lien MonCash n’est pas disponible. Vous pouvez réessayer pendant la réservation temporaire."); }
    if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "moncashbutton.digicelgroup.com") {
      throw new Error("Le lien de paiement n’a pas pu être validé. Contactez NEXA avant de réessayer.");
    }
    window.location.assign(checkoutUrl.toString());
  }

  async function bookSelectedSlot() {
    setError(""); setNotice("");
    if (!selectedSlot) { setError("Choisissez un créneau disponible."); return; }
    if (isHomeVisit && (!visitDepartment || !visitCommune || !visitAddress.trim() || !visitPhone.trim())) { setError("Renseignez la commune, l’adresse précise et le téléphone de contact."); return; }
    if (!user) {
      router.push(`/connexion?next=${encodeURIComponent(returnPath)}`);
      return;
    }
    setBusy(true);
    try {
      const profile = await initializePatientProfile(user);
      if (!profile.profileComplete) {
        router.push(`/inscription?completer=1&next=${encodeURIComponent(returnPath)}`);
        return;
      }
      const result = await appointmentRequest<Booking & { status: string }>(user, "/api/appointments", "POST", {
        slotId: selectedSlot.id,
        bookingType: isHomeVisit ? "home_visit" : "teleconsultation",
        ...(isHomeVisit ? { homeVisitServiceId, homeVisitDetails: { department: visitDepartment, commune: visitCommune, addressLine: visitAddress, contactPhone: visitPhone } } : {}),
        ...(!isHomeVisit && followUpProposalId ? { proposalId: followUpProposalId } : {}),
      });
      const nextBooking = { appointmentId: result.appointmentId, paymentRef: result.paymentRef, amount: result.amount, durationMinutes: result.durationMinutes, transactionFee: result.transactionFee, totalAmount: result.totalAmount, transactionFeeRate: result.transactionFeeRate, feeRecipient: result.feeRecipient, currency: result.currency, holdExpiresAt: result.holdExpiresAt };
      setBooking(nextBooking);
      sessionStorage.setItem("nexa_pending_appointment_payment", JSON.stringify(nextBooking));
      setNotice("Le créneau est réservé temporairement. Choisissez une méthode de paiement avant son expiration.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "La réservation n’a pas abouti.");
    } finally { setBusy(false); }
  }

  async function retryPayment() {
    if (!booking || !user) return;
    setBusy(true); setError(""); setNotice("");
    try { await startMoncashPayment(booking); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Le paiement n’a pas pu démarrer."); }
    finally { setBusy(false); }
  }

  async function payWithWallet() {
    if (!booking || !user) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await appointmentRequest<{ status: string; appointmentStatus: string }>(user, `/api/appointments/${encodeURIComponent(booking.appointmentId)}/pay-wallet`, "POST", {});
      sessionStorage.removeItem("nexa_pending_appointment_payment");
      if (result.appointmentStatus === "PAYMENT_CONFLICT_REFUND_REQUIRED") {
        setNotice("Le paiement a été débité, mais le créneau doit être vérifié. NEXA examinera le remboursement; ne payez pas une seconde fois.");
        return;
      }
      router.push("/espace");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le portefeuille NEXA n’a pas pu payer ce rendez-vous."); }
    finally { setBusy(false); }
  }

  const serviceAmount = isHomeVisit ? provider?.homeVisitTariffs?.[homeVisitServiceId] : provider?.indicativeFee;
  const fee = serviceAmount ? `${new Intl.NumberFormat("fr-HT").format(serviceAmount)} HTG` : "Non configuré";

  return (
    <main className="appointment-page">
      <header className="directory-header">
        <Link className="brand brand-compact" href="/" aria-label="NEXA Medical Center, accueil"><span className="brand-mark" aria-hidden="true">N</span><span>NEXA <small>MEDICAL CENTER</small></span></Link>
        <ServiceNavigation className="directory-nav" />
        <Link className="button button-outline" href={isHomeVisit ? "/care/visites-a-domicile" : "/medecins"}>{isHomeVisit ? "Retour aux visites à domicile" : "Retour aux professionnels"}</Link>
      </header>
      <section className="appointment-shell">
        <p className="eyebrow">{isHomeVisit ? "Nexa - Care · Visite médicale" : "Rendez-vous NEXA"}</p>
        <h1>{isHomeVisit ? "Réservez une visite à domicile." : followUpProposalId ? "Confirmez le rendez-vous proposé." : "Choisissez un créneau."}</h1>
        {followUpProposalId && displayedSlots.length ? <p className="appointment-alert" role="status">Votre médecin vous propose ce rendez-vous. Il sera confirmé après paiement.</p> : null}
        {!followUpProposalId && suggestedSlotId && slots.some((slot) => slot.id === suggestedSlotId) ? <p className="appointment-alert" role="status">Votre médecin vous a suggéré le créneau sélectionné. Il sera confirmé après réservation et paiement.</p> : null}
        {suggestedSlotId && !loading && !slots.some((slot) => slot.id === suggestedSlotId) ? <p className="appointment-privacy" role="status">Le créneau proposé n’est plus disponible. Contactez votre médecin pour demander une nouvelle proposition.</p> : null}
        {provider ? <div className="appointment-provider"><h2>{provider.name}</h2><p>{[provider.specialty, provider.commune, provider.department].filter(Boolean).join(" · ")}</p><p>{isHomeVisit ? `${homeVisitServiceLabel} · visite médicale à domicile · 1 heure` : `Téléconsultation · ${provider.consultationDurationMinutes || NEXA_TELECONSULTATION_DURATION_MINUTES} minutes`}</p><strong>{isHomeVisit ? "Tarif du soin" : "Tarif de consultation"} : {fee}</strong></div> : null}
        {loading ? <p role="status">Chargement des disponibilités…</p> : null}
        {error && !booking ? <div className="directory-state directory-error" role="alert"><p>{error}</p><button className="button button-outline" onClick={() => { setLoading(true); void loadAvailability(); }} type="button">Réessayer</button></div> : null}
        {!loading && !error && displayedSlots.length === 0 ? <div className="directory-state"><h2>{followUpProposalId ? "Ce rendez-vous n’est plus disponible" : "Aucun créneau disponible"}</h2><p>{followUpProposalId ? "Contactez votre médecin pour convenir d’un autre horaire." : "Ce professionnel n’a pas encore publié de disponibilité. Revenez plus tard."}</p></div> : null}
        {displayedSlots.length > 0 && !booking ? <>
          {isHomeVisit && provider?.homeVisitZones?.length ? <div className="home-visit-form"><label>Commune desservie<select required value={`${visitDepartment}|${visitCommune}`} onChange={(event) => { const [department, commune] = event.target.value.split("|"); setVisitDepartment(department || ""); setVisitCommune(commune || ""); }}>{provider.homeVisitZones.map((zone) => <option key={`${zone.department}|${zone.commune}`} value={`${zone.department}|${zone.commune}`}>{zone.commune} · {zone.department}</option>)}</select></label><label>Adresse précise<textarea autoComplete="street-address" maxLength={220} required rows={2} value={visitAddress} onChange={(event) => setVisitAddress(event.target.value)} /></label><label>Téléphone où le médecin peut vous joindre<input autoComplete="tel" inputMode="tel" maxLength={24} required type="tel" value={visitPhone} onChange={(event) => setVisitPhone(event.target.value)} /></label><p className="appointment-privacy">Ne saisissez pas de motif médical ici. Le médecin recevra l’adresse et le téléphone uniquement après confirmation du paiement.</p></div> : null}
          <fieldset className="appointment-slots">
            <legend>Disponibilités — heure d’Haïti</legend>
            {displayedSlots.map((slot) => <label className={`appointment-slot${selectedSlotId === slot.id ? " is-selected" : ""}`} key={slot.id}><input checked={selectedSlotId === slot.id} name="appointment-slot" onChange={() => setSelectedSlotId(slot.id)} type="radio" /><span>{formatSlot(slot.startsAt)}</span></label>)}
          </fieldset>
          <p className="appointment-privacy">{isHomeVisit ? "Une réservation payée est confirmée et ne peut pas être refusée. Vous paierez par MonCash ou avec le portefeuille NEXA." : "Aucun motif médical n’est demandé sur ce formulaire. Après la réservation temporaire, vous pourrez payer par MonCash ou avec le portefeuille NEXA."}</p>
          <button className="button button-primary" disabled={busy || !selectedSlotId || !serviceAmount} onClick={() => void bookSelectedSlot()} type="button">{busy ? "Préparation…" : `Réserver ce créneau · ${fee}`}</button>
          {!serviceAmount ? <p className="appointment-alert" role="status">La réservation en ligne n’est pas encore activée pour ce profil.</p> : null}
        </> : null}
        {booking ? <section className="appointment-payment" aria-live="polite"><h2>Finalisez votre paiement</h2><dl className="appointment-payment-breakdown"><div><dt>{isHomeVisit ? `${homeVisitServiceLabel} · visite à domicile · 1 heure` : `Téléconsultation · ${booking.durationMinutes || NEXA_TELECONSULTATION_DURATION_MINUTES} minutes`}</dt><dd>{new Intl.NumberFormat("fr-HT").format(booking.amount)} {booking.currency}</dd></div><div><dt>Frais de transaction ({booking.transactionFeeRate} %)</dt><dd>{new Intl.NumberFormat("fr-HT").format(booking.transactionFee)} {booking.currency}</dd></div><div><dt>Total à payer</dt><dd><strong>{new Intl.NumberFormat("fr-HT").format(booking.totalAmount)} {booking.currency}</strong></dd></div></dl><p>Les frais de transaction sont attribués à Nexaris. En cas de remboursement, le montant crédité au Wallet NEXA correspond au tarif du service; les frais de transaction ne sont pas remboursés.</p><p>Ce créneau reste retenu jusqu’au {formatSlot(booking.holdExpiresAt)}.</p>{notice ? <p className="appointment-alert" role="status">{notice}</p> : null}{error ? <p className="form-error" role="alert">{error}</p> : null}<button className="button button-primary" disabled={busy} onClick={() => void retryPayment()} type="button">{busy ? "Ouverture de MonCash…" : "Continuer vers MonCash"}</button><button className="button button-outline" disabled={busy || walletAvailable === null || walletAvailable < booking.totalAmount} onClick={() => void payWithWallet()} type="button">{busy ? "Vérification…" : "Payer avec le portefeuille NEXA"}</button>{walletAvailable === null ? <small role="status">Solde NEXA indisponible. Consultez votre espace patient ou choisissez MonCash.</small> : <small>Solde disponible : {new Intl.NumberFormat("fr-HT", { maximumFractionDigits: 2 }).format(walletAvailable)} HTG{walletAvailable < booking.totalAmount ? " · solde insuffisant" : ""}</small>}</section> : null}
        <p className="appointment-emergency">Ce service ne remplace pas les soins d’urgence. En cas d’urgence médicale, contactez les services d’urgence locaux.</p>
      </section>
      <footer className="directory-footer"><Link href="/conditions">Conditions</Link><Link href="/confidentialite">Confidentialité</Link><span>© 2026 NEXA Medical Center</span></footer>
    </main>
  );
}
