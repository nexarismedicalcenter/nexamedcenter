"use client";

import { onAuthStateChanged, type User } from "firebase/auth";
import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { appointmentRequest } from "@/lib/appointments/client";
import { getFirebaseAuth } from "@/lib/firebase/client";
import { initializePatientProfile } from "@/lib/patients/client";

type ProviderType = "laboratory" | "imaging";
type PrescriptionLine = string | { name?: string; label?: string };
type Offer = {
  id: string;
  providerUid: string;
  providerType: ProviderType;
  providerName: string;
  department: string;
  commune: string;
  address: string;
  phone: string;
  openingHours: string;
  name: string;
  category: string;
  description: string;
  specimenType: string;
  preparation: string;
  precautions: string;
  technique: string;
  resultDelay: string;
  instructions: string;
  price: number | null;
  requiresPrescription: boolean;
  appointmentRequired: boolean;
  homeSampling: boolean;
};
type CartOffer = Offer & { linkedPrescriptionId?: string; prescriptionLineId?: string };
type Prescription = { id: string; providerName: string; version: number; validatedAt: string | null; labExams: PrescriptionLine[]; imagingExams: PrescriptionLine[] };
type PendingDiagnosticOrder = { orderId: string; orderNumber: string; paymentRef: string; amount: number; transactionFee: number; totalAmount: number; transactionFeeRateBps: number; feeRecipient: string; currency: string; holdExpiresAt: number };

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").replace(/\s+/g, " ").trim();
}

function prescriptionHasOffer(prescription: Prescription, offer: Offer) {
  const lines = offer.providerType === "laboratory" ? prescription.labExams : prescription.imagingExams;
  return lines.some((line) => normalize(typeof line === "string" ? line : line.name || line.label || "") === normalize(offer.name));
}

function prescriptionHasLineOffer(prescription: Prescription, lineId: string, offer: Offer) {
  const match = /^(laboratory|imaging)-([1-9]\d{0,2})$/.exec(lineId);
  if (!match || match[1] !== offer.providerType) return false;
  const lines = offer.providerType === "laboratory" ? prescription.labExams : prescription.imagingExams;
  const value = lines[Number(match[2]) - 1];
  const name = typeof value === "string" ? value : value?.name || value?.label || "";
  return normalize(name) === normalize(offer.name);
}

export default function DiagnosticCatalog({ providerType }: { providerType: ProviderType }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q")?.slice(0, 100) || "";
  const initialPrescriptionIdValue = searchParams.get("prescriptionId")?.slice(0, 200) || "";
  const initialPrescriptionId = /^[A-Za-z0-9_-]{10,200}$/.test(initialPrescriptionIdValue) ? initialPrescriptionIdValue : "";
  const initialPrescriptionLineIdValue = searchParams.get("prescriptionLineId") || "";
  const initialPrescriptionLineId = /^(laboratory|imaging)-[1-9]\d{0,2}$/.test(initialPrescriptionLineIdValue) && initialPrescriptionLineIdValue.startsWith(`${providerType}-`)
    ? initialPrescriptionLineIdValue
    : "";
  const [user, setUser] = useState<User | null>(null);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [cart, setCart] = useState<Record<string, CartOffer>>({});
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [prescriptionId, setPrescriptionId] = useState(initialPrescriptionId);
  const [loadedPrescriptionsUid, setLoadedPrescriptionsUid] = useState("");
  const [orderRequestId, setOrderRequestId] = useState("");
  const [queryInput, setQueryInput] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<"MONCASH" | "SMART_WALLET">("MONCASH");
  const [pendingOrder, setPendingOrder] = useState<PendingDiagnosticOrder | null>(null);
  const [reload, setReload] = useState(0);
  const isLaboratory = providerType === "laboratory";
  const cartOffers = useMemo(() => Object.values(cart), [cart]);
  const needsPrescription = cartOffers.some((offer) => offer.requiresPrescription || Boolean(offer.prescriptionLineId));
  const prescriptionsLoading = Boolean(user && needsPrescription && loadedPrescriptionsUid !== user.uid);
  const visiblePrescriptions = loadedPrescriptionsUid === user?.uid ? prescriptions : [];
  const validCartPrescriptions = visiblePrescriptions.filter((prescription) => cartOffers.every((offer) => {
    if (offer.prescriptionLineId && prescription.id === offer.linkedPrescriptionId) return prescriptionHasLineOffer(prescription, offer.prescriptionLineId, offer);
    return !offer.requiresPrescription || prescriptionHasOffer(prescription, offer);
  }));
  const cartTotal = cartOffers.reduce((sum, offer) => sum + (Number(offer.price) || 0), 0);
  const cartProviderUid = cartOffers[0]?.providerUid || "";
  const returnPath = isLaboratory ? "/laboratoires" : "/imagerie";

  useEffect(() => onAuthStateChanged(getFirebaseAuth(), setUser), []);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true); setError("");
      try {
        const response = await fetch(`/api/diagnostic-offers?type=${providerType}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as { ok?: boolean; offers?: Offer[]; error?: string };
        if (!response.ok || payload.ok !== true) throw new Error(payload.error || "Le catalogue des examens est indisponible.");
        setOffers(payload.offers || []);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Le catalogue des examens est indisponible.");
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [providerType, reload]);

  useEffect(() => {
    if (!user || !needsPrescription || loadedPrescriptionsUid === user.uid) return;
    let active = true;
    initializePatientProfile(user)
      .then((profile) => {
        if (!active) return;
        if (!profile.profileComplete) {
          router.replace(`/inscription?completer=1&next=${encodeURIComponent(returnPath)}`);
          return;
        }
        return appointmentRequest<{ prescriptions: Prescription[] }>(user, "/api/patient/prescriptions")
          .then((result) => { if (active) { setPrescriptions(result.prescriptions || []); setLoadedPrescriptionsUid(user.uid); } });
      })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Les ordonnances validées ne sont pas accessibles."); });
    return () => { active = false; };
  }, [loadedPrescriptionsUid, needsPrescription, returnPath, router, user]);

  const normalizedQuery = query.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr");
  const visibleOffers = offers.filter((offer) => !normalizedQuery || [offer.name, offer.category, offer.providerName, offer.commune, offer.department, offer.technique, offer.specimenType].join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").includes(normalizedQuery));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQuery(queryInput.trim());
  }

  function addToCart(offer: Offer) {
    if (!user) { router.push(`/connexion?next=${encodeURIComponent(returnPath)}`); return; }
    if (offer.appointmentRequired || offer.price === null) return;
    if (cartProviderUid && cartProviderUid !== offer.providerUid) { setError("Une commande doit concerner un seul centre. Videz le panier avant de choisir un autre partenaire."); return; }
    setError(""); setNotice(""); setOrderRequestId(window.crypto.randomUUID());
    const linkedLine = initialPrescriptionId && initialPrescriptionLineId && prescriptionId === initialPrescriptionId
      ? { linkedPrescriptionId: initialPrescriptionId, prescriptionLineId: initialPrescriptionLineId }
      : {};
    setCart((current) => ({ ...current, [offer.id]: { ...offer, ...linkedLine } }));
  }

  function selectPrescription(id: string) {
    setPrescriptionId(id);
    setOrderRequestId("");
    setCart((current) => Object.fromEntries(Object.entries(current).map(([offerId, offer]) => {
      if (offer.linkedPrescriptionId && offer.linkedPrescriptionId !== id) {
        const unlinked = { ...offer };
        delete unlinked.linkedPrescriptionId;
        delete unlinked.prescriptionLineId;
        return [offerId, unlinked];
      }
      return [offerId, offer];
    })));
  }

  function removeFromCart(offerId: string) {
    setOrderRequestId(window.crypto.randomUUID());
    setCart((current) => { const next = { ...current }; delete next[offerId]; return next; });
    setPrescriptionId("");
  }

  async function checkout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) { router.push(`/connexion?next=${encodeURIComponent(returnPath)}`); return; }
    if (!cartOffers.length) return;
    if (needsPrescription && !validCartPrescriptions.some((prescription) => prescription.id === prescriptionId)) { setError("Sélectionnez une ordonnance NEXA validée qui contient exactement les examens prescrits."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const profile = await initializePatientProfile(user);
      if (!profile.profileComplete) { router.push(`/inscription?completer=1&next=${encodeURIComponent(returnPath)}`); return; }
      const stableOrderRequestId = orderRequestId || window.crypto.randomUUID();
      if (!orderRequestId) setOrderRequestId(stableOrderRequestId);
      const result = await appointmentRequest<{ orderId: string; orderNumber: string; paymentRequired: boolean; paymentRef?: string; amount: number; transactionFee: number; totalAmount: number; transactionFeeRateBps: number; feeRecipient: string; currency: string; holdExpiresAt: number }>(user, "/api/diagnostics/orders", "POST", {
        offerIds: cartOffers.map((offer) => offer.id),
        ...(needsPrescription ? { prescriptionId } : {}),
        ...(needsPrescription ? { prescriptionLineIds: Object.fromEntries(cartOffers.flatMap((offer) => offer.prescriptionLineId && offer.linkedPrescriptionId === prescriptionId ? [[offer.id, offer.prescriptionLineId]] : [])) } : {}),
        orderRequestId: stableOrderRequestId,
      });
      if (!result.paymentRequired || !result.paymentRef) {
        setCart({}); setPrescriptionId(""); setOrderRequestId("");
        setNotice(`Commande ${result.orderNumber} confirmée. Consultez « Mes commandes » dans votre espace patient.`);
        return;
      }
      setPendingOrder({
        orderId: result.orderId,
        orderNumber: result.orderNumber,
        paymentRef: result.paymentRef,
        amount: result.amount,
        transactionFee: result.transactionFee,
        totalAmount: result.totalAmount,
        transactionFeeRateBps: result.transactionFeeRateBps,
        feeRecipient: result.feeRecipient,
        currency: result.currency,
        holdExpiresAt: result.holdExpiresAt,
      });
      setNotice("Vérifiez le montant et les frais de transaction avant de confirmer le paiement.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "La commande ne peut pas être finalisée.";
      setError(message);
      if (message.includes("Terminez votre inscription patient")) router.push(`/inscription?completer=1&next=${encodeURIComponent(returnPath)}`);
    } finally { setBusy(false); }
  }

  async function confirmPendingPayment() {
    if (!user || !pendingOrder) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (paymentMethod === "SMART_WALLET") {
        const payment = await appointmentRequest<{ status: string; paymentMethod: string }>(user, `/api/patient/orders/${encodeURIComponent(pendingOrder.orderId)}/pay-wallet`, "POST", {});
        if (payment.paymentMethod === "MONCASH") { router.push(`/paiement/retour?paymentRef=${encodeURIComponent(pendingOrder.paymentRef)}`); return; }
        setCart({}); setPrescriptionId(""); setOrderRequestId(""); setPendingOrder(null);
        setNotice(`Commande ${pendingOrder.orderNumber} confirmée et payée avec votre portefeuille NEXA. Consultez « Mes commandes » dans votre espace patient.`);
        return;
      }
      const payment = await appointmentRequest<{ status: string; checkoutUrl?: string }>(user, "/api/payments/moncash/create", "POST", { paymentRef: pendingOrder.paymentRef });
      if (payment.status === "paid") { router.push(`/paiement/retour?paymentRef=${encodeURIComponent(pendingOrder.paymentRef)}`); return; }
      const url = new URL(payment.checkoutUrl || "");
      if (url.protocol !== "https:" || url.hostname !== "moncashbutton.digicelgroup.com") throw new Error("Le lien MonCash n’est pas valide. La commande est enregistrée; reprenez le paiement dans votre espace patient.");
      setCart({}); setPrescriptionId(""); setOrderRequestId(""); setPendingOrder(null);
      window.location.assign(url.toString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Le paiement ne peut pas être finalisé.");
    } finally { setBusy(false); }
  }

  return <section className="diagnostic-catalog" aria-labelledby="diagnostic-catalog-heading">
    <div className="diagnostic-catalog-intro"><p className="eyebrow">Offres approuvées par NEXA</p><h2 id="diagnostic-catalog-heading">{isLaboratory ? "Examens de laboratoire" : "Examens d’imagerie"}</h2><p>Les prix, modalités et disponibilités sont déclarés par des partenaires vérifiés et revus par NEXA. Confirmez les consignes directement auprès du centre avant votre visite.</p></div>
    <form className="directory-filters diagnostic-catalog-search" onSubmit={submit} role="search"><label>Rechercher un examen ou un centre<input value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="Nom, catégorie, ville ou centre" /></label><button className="button button-primary" type="submit">Rechercher</button></form>
    {error ? <div className="directory-state directory-error" role="alert"><p>{error}</p><button className="button button-outline" onClick={() => setReload((value) => value + 1)} type="button">Réessayer</button></div> : null}
    {notice ? <p className="form-notice diagnostic-order-notice" role="status">{notice} <a href="/espace#commandes">Ouvrir mon espace patient</a></p> : null}
    <div className="diagnostic-catalog-results" aria-live="polite"><div className="directory-results-heading"><h3>{loading ? "Chargement des offres…" : `${visibleOffers.length} offre${visibleOffers.length === 1 ? "" : "s"}`}</h3><p>Seules les offres publiées et les coordonnées publiques du partenaire sont affichées.</p></div>
      {loading ? <p role="status">Chargement du catalogue NEXA…</p> : visibleOffers.length ? <div className="directory-grid">{visibleOffers.map((offer) => <article className="directory-card diagnostic-catalog-card" key={offer.id}>
        <div className="directory-card-top"><span className="directory-avatar" aria-hidden="true">{offer.providerName.slice(0, 1).toLocaleUpperCase("fr")}</span><span className="directory-verified">Partenaire vérifié</span></div>
        <p className="directory-specialty">{offer.category || (isLaboratory ? "Laboratoire" : "Imagerie")}</p><h3>{offer.name}</h3><p>{offer.providerName}</p>
        <p className="directory-location">{[offer.commune, offer.department].filter(Boolean).join(" · ") || offer.address || "Haïti"}</p>
        {offer.description ? <p>{offer.description}</p> : null}{offer.specimenType ? <p className="directory-meta">Prélèvement : {offer.specimenType}</p> : null}{offer.technique ? <p className="directory-meta">Technique : {offer.technique}</p> : null}
        {offer.preparation ? <p className="diagnostic-catalog-detail"><strong>Préparation</strong>{offer.preparation}</p> : null}{offer.precautions ? <p className="diagnostic-catalog-detail"><strong>Précautions</strong>{offer.precautions}</p> : null}
        {offer.resultDelay ? <p className="directory-meta">Délai indicatif : {offer.resultDelay}</p> : null}{offer.openingHours ? <p className="directory-hours">{offer.openingHours}</p> : null}
        {offer.price !== null ? <p className="directory-fee">{new Intl.NumberFormat("fr-HT").format(offer.price)} HTG</p> : <p className="directory-meta">Prix à confirmer auprès du centre</p>}
        <ul className="diagnostic-catalog-flags">{offer.requiresPrescription ? <li>Ordonnance requise</li> : null}{offer.appointmentRequired ? <li>Rendez-vous requis</li> : null}{offer.homeSampling ? <li>Prélèvement à domicile à confirmer directement avec le centre; cette commande ne le réserve pas.</li> : null}</ul>
        {offer.instructions ? <p className="diagnostic-catalog-detail"><strong>Consignes du centre</strong>{offer.instructions}</p> : null}
        {offer.phone ? <a className="button button-outline" href={`tel:${encodeURIComponent(offer.phone)}`}>Appeler le centre</a> : null}
        {offer.appointmentRequired ? <small className="diagnostic-order-unavailable">Appelez le centre pour convenir d’un rendez-vous avant la commande.</small> : <button className="button button-primary" disabled={offer.price === null || busy || Boolean(cartProviderUid && cartProviderUid !== offer.providerUid) || Boolean(cart[offer.id])} onClick={() => addToCart(offer)} type="button">{cart[offer.id] ? "Ajouté à la commande" : "Ajouter à la commande"}</button>}
      </article>)}</div> : <div className="directory-state"><h3>{query ? "Aucun résultat pour cette recherche" : "Aucune offre publiée pour le moment"}</h3><p>Essayez un autre terme ou revenez plus tard.</p></div>}
    </div>
    <aside className="diagnostic-order-cart" aria-labelledby="diagnostic-order-cart-heading"><p className="eyebrow">Commande d’examens</p><h3 id="diagnostic-order-cart-heading">Votre sélection</h3>{pendingOrder ? <>
      <p>Commande {pendingOrder.orderNumber} · {cartOffers[0]?.providerName || "Centre NEXA"}</p>
      <div className="pharmacy-cart-total"><span>Montant des examens</span><strong>{new Intl.NumberFormat("fr-HT").format(pendingOrder.amount)} {pendingOrder.currency}</strong></div>
      <div className="pharmacy-cart-total"><span>Frais de transaction ({(pendingOrder.transactionFeeRateBps / 100).toLocaleString("fr-HT")} %)</span><strong>{new Intl.NumberFormat("fr-HT").format(pendingOrder.transactionFee)} {pendingOrder.currency}</strong></div>
      <div className="pharmacy-cart-total"><span>Total à payer</span><strong>{new Intl.NumberFormat("fr-HT").format(pendingOrder.totalAmount)} {pendingOrder.currency}</strong></div>
      <small>Les frais sont attribués à {pendingOrder.feeRecipient}. Le montant remboursable, le cas échéant, porte sur les examens.</small>
      <fieldset className="diagnostic-payment-method"><legend>Confirmez le mode de paiement</legend><label><input checked={paymentMethod === "MONCASH"} disabled={busy} name="diagnostic-payment-method" onChange={() => setPaymentMethod("MONCASH")} type="radio" /> MonCash · {new Intl.NumberFormat("fr-HT").format(pendingOrder.totalAmount)} {pendingOrder.currency}</label><label><input checked={paymentMethod === "SMART_WALLET"} disabled={busy} name="diagnostic-payment-method" onChange={() => setPaymentMethod("SMART_WALLET")} type="radio" /> Portefeuille NEXA · {new Intl.NumberFormat("fr-HT").format(pendingOrder.totalAmount)} {pendingOrder.currency}</label><small>La retenue expire le {new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "short", timeStyle: "short" }).format(new Date(pendingOrder.holdExpiresAt))}.</small></fieldset>
      <button className="button button-primary" disabled={busy} onClick={() => void confirmPendingPayment()} type="button">{busy ? "Paiement en cours…" : paymentMethod === "SMART_WALLET" ? "Confirmer et payer avec le portefeuille" : "Confirmer et continuer vers MonCash"}</button>
      <Link className="button button-quiet" href="/espace#commandes">Ouvrir mes commandes</Link>
    </> : cartOffers.length ? <><p>{cartOffers[0].providerName} · une seule commande par centre</p><ul>{cartOffers.map((offer) => <li key={offer.id}><span>{offer.name}</span><strong>{new Intl.NumberFormat("fr-HT").format(Number(offer.price) || 0)} HTG</strong><button className="button button-quiet" disabled={busy} onClick={() => removeFromCart(offer.id)} type="button">Retirer</button></li>)}</ul><div className="pharmacy-cart-total"><span>Montant des examens</span><strong>{new Intl.NumberFormat("fr-HT").format(cartTotal)} HTG</strong></div>
      {needsPrescription ? <label>Ordonnance NEXA validée<select required value={prescriptionId} disabled={prescriptionsLoading || !validCartPrescriptions.length} onChange={(event) => selectPrescription(event.target.value)}><option value="">{prescriptionsLoading ? "Chargement des ordonnances…" : validCartPrescriptions.length ? "Sélectionnez une ordonnance" : "Aucune ordonnance correspondante"}</option>{validCartPrescriptions.map((prescription) => <option key={prescription.id} value={prescription.id}>Version {prescription.version} · {prescription.providerName}{prescription.validatedAt ? ` · ${new Intl.DateTimeFormat("fr-HT", { dateStyle: "medium" }).format(new Date(prescription.validatedAt))}` : ""}</option>)}</select></label> : null}
      {cartTotal > 0 ? <fieldset className="diagnostic-payment-method"><legend>Mode de paiement</legend><label><input checked={paymentMethod === "MONCASH"} disabled={busy} name="diagnostic-payment-method" onChange={() => setPaymentMethod("MONCASH")} type="radio" /> MonCash</label><label><input checked={paymentMethod === "SMART_WALLET"} disabled={busy} name="diagnostic-payment-method" onChange={() => setPaymentMethod("SMART_WALLET")} type="radio" /> Portefeuille NEXA</label><small>Le portefeuille doit disposer du solde nécessaire. NEXA vérifie le paiement avant de confirmer la commande.</small></fieldset> : null}
      <form onSubmit={(event) => void checkout(event)}><button className="button button-primary" disabled={busy || !user || (needsPrescription && !validCartPrescriptions.some((prescription) => prescription.id === prescriptionId))} type="submit">{busy ? "Préparation du paiement…" : !user ? "Connectez-vous pour continuer" : cartTotal ? "Préparer la commande et afficher le total" : "Confirmer la commande gratuite"}</button></form>
      <button className="button button-quiet" disabled={busy} onClick={() => { setCart({}); setPrescriptionId(""); setOrderRequestId(""); }} type="button">Vider la sélection</button>
      <small>Les prix et l’accès à l’offre sont vérifiés de nouveau par NEXA avant la confirmation. Les rendez-vous obligatoires se prennent directement auprès du centre.</small></> : <p>Ajoutez un ou plusieurs examens d’un même centre pour commencer.</p>}</aside>
  </section>;
}
