"use client";

import Link from "next/link";
import ServiceNavigation from "@/components/service-navigation";
import { onAuthStateChanged, type User } from "firebase/auth";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { appointmentRequest } from "@/lib/appointments/client";
import { getFirebaseAuth } from "@/lib/firebase/client";

type DeliveryZone = { department: string; commune: string; feeHTG: number; etaLabel: string };
type Product = { id: string; providerUid: string; pharmacyName: string; commune: string; department: string; name: string; dci: string; dosage: string; pharmaceuticalForm: string; description: string; manufacturer: string; price: number; stock: number; prescriptionRequired: boolean; deliveryMode: "pickup" | "delivery" | "both"; deliveryZones: DeliveryZone[]; coldChainRequired: boolean };
type Prescription = { id: string; providerName: string; specialtyName: string; medications: { name: string; dosage?: string }[]; validatedAt: string | null; version: number };
type CartLine = { product: Product; quantity: number; prescriptionId?: string; prescriptionLineId?: string };
type PendingOrder = { orderId: string; paymentRef: string; orderNumber: string; amount: number; transactionFee: number; totalAmount: number; transactionFeeRateBps: number; feeRecipient: string; currency: string; holdExpiresAt: number };

const blankDeliveryAddress = { recipientName: "", phone: "", department: "", commune: "", addressLine: "", instructions: "" };
function normalizeLocation(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("fr").replace(/\s+/g, " "); }

export default function PharmacyStorefront() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q")?.slice(0, 100) || "";
  const initialPrescriptionIdValue = searchParams.get("prescriptionId")?.slice(0, 200) || "";
  const initialPrescriptionId = /^[A-Za-z0-9_-]{10,200}$/.test(initialPrescriptionIdValue) ? initialPrescriptionIdValue : "";
  const initialPrescriptionLineIdValue = searchParams.get("prescriptionLineId") || "";
  const initialPrescriptionLineId = /^medication-[1-9]\d{0,2}$/.test(initialPrescriptionLineIdValue) ? initialPrescriptionLineIdValue : "";
  const [user, setUser] = useState<User | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [deliveryEnabled, setDeliveryEnabled] = useState(false);
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [prescriptionId, setPrescriptionId] = useState(initialPrescriptionId);
  const [deliveryMethod, setDeliveryMethod] = useState<"pickup" | "delivery">("pickup");
  const [deliveryAddress, setDeliveryAddress] = useState(blankDeliveryAddress);
  const [queryInput, setQueryInput] = useState(initialQuery);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadedPrescriptionsUid, setLoadedPrescriptionsUid] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingOrder, setPendingOrder] = useState<PendingOrder | null>(null);

  useEffect(() => onAuthStateChanged(getFirebaseAuth(), setUser), []);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true); setError("");
      const params = new URLSearchParams();
      if (query) params.set("q", query);
      try {
        const response = await fetch(`/api/pharmacy/products${params.size ? `?${params}` : ""}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as { ok?: boolean; deliveryEnabled?: boolean; products?: Product[]; error?: string };
        if (!response.ok || payload.ok !== true) throw new Error(payload.error || "Le catalogue pharmacie est indisponible.");
        setProducts(payload.products || []);
        setDeliveryEnabled(payload.deliveryEnabled === true);
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Le catalogue pharmacie est indisponible."); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [query]);

  const cartLines = useMemo(() => Object.values(cart), [cart]);
  const pharmacyUid = cartLines[0]?.product.providerUid || "";
  const cartTotal = cartLines.reduce((sum, line) => sum + line.product.price * line.quantity, 0);
  const homeDeliveryEligible = deliveryEnabled && cartLines.length > 0 && cartLines.every((line) => ["delivery", "both"].includes(line.product.deliveryMode) && !line.product.coldChainRequired);
  const deliveryIsSelected = homeDeliveryEligible && deliveryMethod === "delivery";
  const matchingDeliveryZones = cartLines.map((line) => line.product.deliveryZones.find((zone) => normalizeLocation(zone.department) === normalizeLocation(deliveryAddress.department) && normalizeLocation(zone.commune) === normalizeLocation(deliveryAddress.commune)));
  const deliveryZoneAvailable = homeDeliveryEligible && Boolean(deliveryAddress.department.trim() && deliveryAddress.commune.trim()) && matchingDeliveryZones.every(Boolean);
  const deliveryFee = deliveryZoneAvailable ? Math.max(0, ...matchingDeliveryZones.map((zone) => Number(zone?.feeHTG) || 0)) : 0;
  const deliveryEta = [...new Set(matchingDeliveryZones.flatMap((zone) => zone?.etaLabel ? [zone.etaLabel] : []))].join(", ");
  const orderTotal = cartTotal + (deliveryIsSelected ? deliveryFee : 0);
  const needsPrescription = cartLines.some((line) => line.product.prescriptionRequired);
  const prescriptionsLoading = Boolean(user && needsPrescription && loadedPrescriptionsUid !== user.uid);
  const visiblePrescriptions = loadedPrescriptionsUid === user?.uid ? prescriptions : [];

  useEffect(() => {
    if (!user || !needsPrescription || loadedPrescriptionsUid === user.uid) return;
    let active = true;
    appointmentRequest<{ prescriptions: Prescription[] }>(user, "/api/patient/prescriptions")
      .then((result) => { if (active) { setPrescriptions(result.prescriptions || []); setLoadedPrescriptionsUid(user.uid); } })
      .catch((cause: unknown) => { if (active) { setError(cause instanceof Error ? cause.message : "Vos ordonnances validées ne sont pas accessibles."); setLoadedPrescriptionsUid(user.uid); } });
    return () => { active = false; };
  }, [loadedPrescriptionsUid, needsPrescription, user]);

  function add(product: Product) {
    if (!user) { router.push(`/connexion?next=${encodeURIComponent("/pharmacie")}`); return; }
    if (pendingOrder) { setError("Finalisez ou reprenez la commande en attente dans votre espace patient avant d’en créer une autre."); return; }
    if (pharmacyUid && pharmacyUid !== product.providerUid) { setError("Une commande est limitée à une pharmacie. Terminez ou videz ce panier avant de choisir une autre pharmacie."); return; }
    setError(""); setNotice("");
    setCart((current) => {
      const prior = current[product.id];
      const quantity = prior ? Math.min(product.stock, prior.quantity + 1) : 1;
      const linkedLine = product.prescriptionRequired && initialPrescriptionId && initialPrescriptionLineId && prescriptionId === initialPrescriptionId
        ? { prescriptionId: initialPrescriptionId, prescriptionLineId: initialPrescriptionLineId }
        : {};
      return { ...current, [product.id]: { product, quantity, ...linkedLine, ...(prior?.prescriptionLineId ? { prescriptionId: prior.prescriptionId, prescriptionLineId: prior.prescriptionLineId } : {}) } };
    });
  }

  function adjust(productId: string, delta: number) {
    setCart((current) => {
      const line = current[productId];
      if (!line) return current;
      const quantity = Math.min(line.product.stock, line.quantity + delta);
      if (quantity <= 0) { const next = { ...current }; delete next[productId]; return next; }
      return { ...current, [productId]: { ...line, quantity } };
    });
  }

  async function checkout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) { router.push(`/connexion?next=${encodeURIComponent("/pharmacie")}`); return; }
    if (!cartLines.length) return;
    if (deliveryIsSelected && (!deliveryZoneAvailable || !deliveryAddress.recipientName.trim() || !deliveryAddress.phone.trim() || !deliveryAddress.addressLine.trim())) { setError("Renseignez une adresse complète dans une zone desservie, puis réessayez."); return; }
    if (needsPrescription && !prescriptionId) { setError("Sélectionnez une ordonnance NEXA validée pour les médicaments qui l’exigent."); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const order = await appointmentRequest<PendingOrder>(user, "/api/pharmacy/orders", "POST", {
        pharmacyId: pharmacyUid,
        deliveryMethod: deliveryIsSelected ? "delivery" : "pickup",
        ...(deliveryIsSelected ? { deliveryAddress } : {}),
        items: cartLines.map((line) => ({
          productId: line.product.id,
          quantity: line.quantity,
          ...(line.prescriptionLineId && line.prescriptionId === prescriptionId ? { prescriptionLineId: line.prescriptionLineId } : {}),
        })),
        ...(needsPrescription || cartLines.some((line) => line.prescriptionLineId && line.prescriptionId === prescriptionId) ? { prescriptionId } : {}),
      });
      setCart({}); setPrescriptionId("");
      setDeliveryMethod("pickup"); setDeliveryAddress(blankDeliveryAddress);
      setPendingOrder(order);
      setNotice("Votre commande est retenue temporairement. Choisissez MonCash ou le portefeuille NEXA avant l’expiration.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "La commande ne peut pas être finalisée.";
      setError(message);
      if (message.includes("Terminez votre inscription patient")) router.push("/inscription?completer=1");
    } finally { setBusy(false); }
  }

  async function payPendingWithMoncash() {
    if (!user || !pendingOrder) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const payment = await appointmentRequest<{ status: string; checkoutUrl?: string }>(user, "/api/payments/moncash/create", "POST", { paymentRef: pendingOrder.paymentRef });
      if (payment.status === "paid") { router.push(`/paiement/retour?paymentRef=${encodeURIComponent(pendingOrder.paymentRef)}`); return; }
      const url = new URL(payment.checkoutUrl || "");
      if (url.protocol !== "https:" || url.hostname !== "moncashbutton.digicelgroup.com") throw new Error("Le lien MonCash n’est pas valide. Votre commande est enregistrée; reprenez le paiement depuis votre espace patient.");
      window.location.assign(url.toString());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le paiement MonCash ne peut pas démarrer."); }
    finally { setBusy(false); }
  }

  async function payPendingWithWallet() {
    if (!user || !pendingOrder) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await appointmentRequest<{ paymentMethod: string }>(user, `/api/patient/orders/${encodeURIComponent(pendingOrder.orderId)}/pay-wallet`, "POST", {});
      if (result.paymentMethod === "MONCASH") { router.push(`/paiement/retour?paymentRef=${encodeURIComponent(pendingOrder.paymentRef)}`); return; }
      setPendingOrder(null);
      router.push("/espace#commandes");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le portefeuille NEXA ne peut pas payer cette commande."); }
    finally { setBusy(false); }
  }

  return <main className="directory-page pharmacy-storefront">
    <header className="directory-header"><Link className="brand brand-compact" href="/" aria-label="NEXA Medical Center, accueil"><span className="brand-mark" aria-hidden="true">N</span><span>NEXA <small>MEDICAL CENTER</small></span></Link><ServiceNavigation className="directory-nav" />{user ? <Link className="button button-primary" href="/espace">Mon espace{cartLines.length ? ` · Panier ${cartLines.length}` : ""}</Link> : <Link className="button button-primary" href={`/connexion?next=${encodeURIComponent("/pharmacie")}`}>Se connecter</Link>}</header>
    <section className="directory-intro"><p className="eyebrow">Catalogue partenaire NEXA</p><h1>Pharmacie.</h1><p>Produits publiés par les pharmacies NEXA vérifiées. Les médicaments qui exigent une ordonnance ne peuvent être commandés qu’avec une ordonnance NEXA validée correspondante.</p></section>
    <form className="directory-filters pharmacy-search" role="search" onSubmit={(event) => { event.preventDefault(); setQuery(queryInput.trim()); }}><label>Rechercher un produit<input value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="Nom, DCI, dosage ou pharmacie" /></label><button className="button button-primary" type="submit">Rechercher</button></form>
    {error ? <div className="directory-state directory-error" role="alert"><p>{error}</p></div> : null}{notice ? <p className="form-notice pharmacy-store-notice" role="status">{notice}</p> : null}
    <section className="pharmacy-store-layout" aria-label="Catalogue et panier pharmacie">
      <div className="pharmacy-catalog"><div className="directory-results-heading"><h2>{loading ? "Chargement du catalogue…" : `${products.length} produit${products.length === 1 ? "" : "s"}`}</h2><p>{deliveryEnabled ? "Retrait ou livraison selon les zones publiées par la pharmacie. Les stocks et prix sont revérifiés avant le paiement." : "Les commandes sont actuellement à retirer auprès de la pharmacie partenaire. Les stocks et prix sont revérifiés avant le paiement."}</p></div>
        {loading ? <p role="status">Chargement des produits NEXA…</p> : products.length ? <div className="directory-grid">{products.map((product) => <article className="directory-card pharmacy-product-public" key={product.id}><div className="directory-card-top"><span className="directory-avatar" aria-hidden="true">{product.name.slice(0, 1).toLocaleUpperCase("fr")}</span><span className="directory-verified">{product.stock > 0 ? "En stock" : "Indisponible"}</span></div><h3>{product.name}</h3><p className="directory-specialty">{product.dci} · {product.dosage} · {product.pharmaceuticalForm}</p><p>{product.pharmacyName}{product.commune ? ` · ${product.commune}` : ""}</p>{product.description ? <p>{product.description}</p> : null}{product.manufacturer ? <p className="directory-meta">Fabricant : {product.manufacturer}</p> : null}<p className="directory-fee">{new Intl.NumberFormat("fr-HT").format(product.price)} HTG</p>{product.prescriptionRequired ? <p className="pharmacy-rx-note">Ordonnance NEXA obligatoire</p> : null}<button className="button button-outline" disabled={product.stock <= 0 || busy || Boolean(pendingOrder)} onClick={() => add(product)} type="button">{user ? pendingOrder ? "Commande en attente" : "Ajouter au panier" : "Se connecter pour commander"}</button></article>)}</div> : <div className="directory-state"><h3>{error ? "Catalogue indisponible" : "Aucun produit publié"}</h3><p>Réessayez plus tard ou recherchez un autre produit.</p></div>}
      </div>
      <aside className="pharmacy-cart" aria-labelledby="pharmacy-cart-heading">
        <p className="eyebrow">Commande</p>
        <h2 id="pharmacy-cart-heading">Votre panier</h2>
        {pendingOrder ? <>
          <p>Commande {pendingOrder.orderNumber} réservée.</p>
          <div className="pharmacy-cart-total"><span>Montant des produits et livraison</span><strong>{new Intl.NumberFormat("fr-HT").format(pendingOrder.amount)} {pendingOrder.currency}</strong></div>
          <div className="pharmacy-cart-total"><span>Frais de transaction ({(pendingOrder.transactionFeeRateBps / 100).toLocaleString("fr-HT")} %)</span><strong>{new Intl.NumberFormat("fr-HT").format(pendingOrder.transactionFee)} {pendingOrder.currency}</strong></div>
          <div className="pharmacy-cart-total"><span>Total à payer</span><strong>{new Intl.NumberFormat("fr-HT").format(pendingOrder.totalAmount)} {pendingOrder.currency}</strong></div>
          <small>Les frais de transaction sont attribués à {pendingOrder.feeRecipient}. En cas de remboursement, le montant remboursable porte sur les produits et la livraison.</small>
          <p>La retenue expire le {new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "short", timeStyle: "short" }).format(new Date(pendingOrder.holdExpiresAt))}.</p>
          <button className="button button-primary" disabled={busy} onClick={() => void payPendingWithMoncash()} type="button">Continuer vers MonCash</button>
          <button className="button button-outline" disabled={busy} onClick={() => void payPendingWithWallet()} type="button">Payer avec le portefeuille NEXA</button>
          <Link className="button button-quiet" href="/espace#commandes">Ouvrir mes commandes</Link>
        </> : cartLines.length ? <>
          <p className="pharmacy-cart-provider">{cartLines[0].product.pharmacyName}</p>
          <ul>{cartLines.map((line) => <li key={line.product.id}>
            <div><strong>{line.product.name}</strong><span>{line.quantity} × {new Intl.NumberFormat("fr-HT").format(line.product.price)} HTG</span></div>
            <div className="pharmacy-cart-quantity"><button aria-label={`Retirer une unité de ${line.product.name}`} onClick={() => adjust(line.product.id, -1)} type="button">−</button><span>{line.quantity}</span><button aria-label={`Ajouter une unité de ${line.product.name}`} disabled={line.quantity >= line.product.stock} onClick={() => adjust(line.product.id, 1)} type="button">+</button></div>
          </li>)}</ul>
          {deliveryEnabled ? <fieldset className="pharmacy-delivery-choice">
            <legend>Mode de réception</legend>
            <label><input checked={!deliveryIsSelected} name="deliveryMethod" onChange={() => setDeliveryMethod("pickup")} type="radio" /> Retrait en pharmacie</label>
            {homeDeliveryEligible ? <label><input checked={deliveryIsSelected} name="deliveryMethod" onChange={() => setDeliveryMethod("delivery")} type="radio" /> Livraison à domicile</label> : null}
          </fieldset> : <p className="pharmacy-delivery-choice">Retrait en pharmacie uniquement pour le moment.</p>}
          {deliveryIsSelected ? <div className="pharmacy-delivery-fields">
            <p>La pharmacie doit desservir le département et la commune saisis pour chaque produit du panier.</p>
            <label>Nom du destinataire<input autoComplete="name" maxLength={120} required value={deliveryAddress.recipientName} onChange={(event) => setDeliveryAddress((current) => ({ ...current, recipientName: event.target.value }))} /></label>
            <label>Téléphone<input autoComplete="tel" maxLength={32} required type="tel" value={deliveryAddress.phone} onChange={(event) => setDeliveryAddress((current) => ({ ...current, phone: event.target.value }))} /></label>
            <div className="form-grid two-columns">
              <label>Département<input autoComplete="address-level1" maxLength={80} required value={deliveryAddress.department} onChange={(event) => setDeliveryAddress((current) => ({ ...current, department: event.target.value }))} /></label>
              <label>Commune<input autoComplete="address-level2" maxLength={80} required value={deliveryAddress.commune} onChange={(event) => setDeliveryAddress((current) => ({ ...current, commune: event.target.value }))} /></label>
            </div>
            <label>Adresse détaillée<input autoComplete="street-address" maxLength={300} required value={deliveryAddress.addressLine} onChange={(event) => setDeliveryAddress((current) => ({ ...current, addressLine: event.target.value }))} /></label>
            <label>Instructions facultatives<textarea maxLength={300} rows={2} value={deliveryAddress.instructions} onChange={(event) => setDeliveryAddress((current) => ({ ...current, instructions: event.target.value }))} /></label>
            {deliveryAddress.department.trim() && deliveryAddress.commune.trim() ? <p role="status">{deliveryZoneAvailable ? `Zone desservie · ${new Intl.NumberFormat("fr-HT").format(deliveryFee)} HTG · délai indicatif : ${deliveryEta}` : "Cette adresse ne correspond pas encore à une zone de livraison active pour tous les produits."}</p> : null}
          </div> : null}
          <div className="pharmacy-cart-total"><span>Sous-total</span><strong>{new Intl.NumberFormat("fr-HT").format(cartTotal)} HTG</strong></div>
          {deliveryIsSelected ? <div className="pharmacy-cart-total"><span>Livraison</span><strong>{deliveryZoneAvailable ? `${new Intl.NumberFormat("fr-HT").format(deliveryFee)} HTG` : "À confirmer"}</strong></div> : null}
          <div className="pharmacy-cart-total"><span>Total</span><strong>{new Intl.NumberFormat("fr-HT").format(orderTotal)} HTG</strong></div>
          {needsPrescription ? <label>Ordonnance validée<select required value={prescriptionId} onChange={(event) => setPrescriptionId(event.target.value)} disabled={prescriptionsLoading || !visiblePrescriptions.length}><option value="">{prescriptionsLoading ? "Chargement…" : visiblePrescriptions.length ? "Sélectionnez une ordonnance" : "Aucune ordonnance validée disponible"}</option>{visiblePrescriptions.map((prescription) => <option key={prescription.id} value={prescription.id}>Version {prescription.version} · {prescription.providerName}{prescription.validatedAt ? ` · ${new Intl.DateTimeFormat("fr-HT", { dateStyle: "medium" }).format(new Date(prescription.validatedAt))}` : ""}</option>)}</select></label> : null}
          <form onSubmit={(event) => void checkout(event)}><button className="button button-primary" disabled={busy || !user || (needsPrescription && !prescriptionId) || (deliveryIsSelected && !deliveryZoneAvailable)} type="submit">{busy ? "Préparation de la commande…" : !user ? "Connectez-vous pour continuer" : "Réserver le panier"}</button></form>
          <button className="button button-quiet pharmacy-empty-cart" disabled={busy} onClick={() => { setCart({}); setPrescriptionId(""); setDeliveryMethod("pickup"); setDeliveryAddress(blankDeliveryAddress); }} type="button">Vider le panier</button>
          <small>Le panier reste sur cette page. Le serveur revalide la zone, les frais, le stock et le prix avant de réserver.</small>
        </> : <p>Ajoutez des produits d’une pharmacie au panier. Le panier reste dans cette page et n’est pas enregistré dans le navigateur.</p>}
      </aside>
    </section>
    {deliveryEnabled ? <p className="appointment-privacy">Pour une livraison, l’adresse et le téléphone saisis sont enregistrés avec la commande et transmis à la pharmacie qui la traite afin d’effectuer la remise.</p> : null}
    <footer className="directory-footer"><Link href="/conditions">Conditions</Link><Link href="/confidentialite">Confidentialité</Link><span>© 2026 NEXA Medical Center</span></footer>
  </main>;
}
