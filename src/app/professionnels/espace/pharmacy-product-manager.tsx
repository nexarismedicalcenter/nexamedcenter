"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";
import PharmacyOrderManager from "./pharmacy-order-manager";

type Product = {
  id: string;
  name: string;
  dci: string;
  dosage: string;
  pharmaceuticalForm: string;
  therapeuticClass: string;
  regulatoryCategory: string;
  prescriptionRequired: boolean;
  publicDescription?: string;
  manufacturer?: string;
  deliveryMode: "pickup" | "delivery" | "both";
  deliveryZones: { department: string; commune: string; feeHTG: number; etaLabel: string; active: boolean }[];
  coldChainRequired: boolean;
  price: number;
  stock: number;
  reservedStock?: number;
  lots?: { lotNumber: string; expirationDate: string; quantityReceived: number; quantityAvailable: number; reservedQuantity?: number; status?: string }[];
  legacyStockUnreconciled?: number;
  publicationStatus: string;
  reviewReason?: string;
};

type ProductForm = Omit<Product, "id" | "publicationStatus" | "reservedStock" | "reviewReason">;
const blank: ProductForm = { name: "", dci: "", dosage: "", pharmaceuticalForm: "", therapeuticClass: "", regulatoryCategory: "OTC", prescriptionRequired: false, publicDescription: "", manufacturer: "", deliveryMode: "pickup", deliveryZones: [], coldChainRequired: false, price: 0, stock: 0 };
type LotForm = { lotNumber: string; expirationDate: string; quantityReceived: string };
const blankLot: LotForm = { lotNumber: "", expirationDate: "", quantityReceived: "" };

function parseDeliveryZones(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [department, commune, feeText, ...etaParts] = line.split("|").map((part) => part.trim());
    const feeHTG = Number(feeText);
    const etaLabel = etaParts.join("|").trim();
    if (!department || !commune || !feeText || !etaLabel || !Number.isSafeInteger(feeHTG) || feeHTG < 0) throw new Error("Chaque zone doit suivre : Département | Commune | frais HTG | délai indicatif.");
    return { department, commune, feeHTG, etaLabel, active: true };
  });
}

const statusLabels: Record<string, string> = {
  PENDING_REVIEW: "En attente de revue NEXA",
  NEEDS_CORRECTION: "Correction demandée",
  PUBLISHED: "Publié",
  REJECTED: "Refusé",
  SUSPENDED: "Suspendu",
  ARCHIVED: "Archivé",
};

export default function PharmacyProductManager({ user }: { user: User }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [form, setForm] = useState<ProductForm>(blank);
  const [initialLotNumber, setInitialLotNumber] = useState("");
  const [initialLotExpiration, setInitialLotExpiration] = useState("");
  const [lotForms, setLotForms] = useState<Record<string, LotForm>>({});
  const [deliveryZonesText, setDeliveryZonesText] = useState("");
  const [editingId, setEditingId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await appointmentRequest<{ products: Product[] }>(user, "/api/provider/pharmacy-products");
      setProducts(result.products || []);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le catalogue ne peut pas être chargé."); }
    finally { setLoading(false); }
  }, [user]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function edit(product: Product) {
    setEditingId(product.id);
    setForm({ name: product.name, dci: product.dci, dosage: product.dosage, pharmaceuticalForm: product.pharmaceuticalForm, therapeuticClass: product.therapeuticClass, regulatoryCategory: product.regulatoryCategory, prescriptionRequired: product.prescriptionRequired, publicDescription: product.publicDescription || "", manufacturer: product.manufacturer || "", deliveryMode: product.deliveryMode || "pickup", deliveryZones: product.deliveryZones || [], coldChainRequired: product.coldChainRequired === true, price: product.price, stock: product.stock });
    setDeliveryZonesText((product.deliveryZones || []).map((zone) => `${zone.department} | ${zone.commune} | ${zone.feeHTG} | ${zone.etaLabel}`).join("\n"));
    setNotice(""); setError("");
  }

  function clearForm() { setEditingId(""); setForm(blank); setDeliveryZonesText(""); setInitialLotNumber(""); setInitialLotExpiration(""); }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try {
      const deliveryZones = parseDeliveryZones(deliveryZonesText);
      const result = await appointmentRequest<{ product: { id: string } }>(user, "/api/provider/pharmacy-products", "POST", { ...form, deliveryZones, ...(!editingId ? { lotNumber: initialLotNumber, expirationDate: initialLotExpiration } : {}), ...(editingId ? { productId: editingId } : {}) });
      setNotice("Fiche envoyée à NEXA pour revue. Elle apparaîtra au catalogue après approbation.");
      clearForm();
      await load();
      if (!result.product?.id) throw new Error("La référence du produit n’a pas été retournée.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le produit n’a pas pu être enregistré."); }
    finally { setBusy(false); }
  }

  async function receiveLot(product: Product) {
    const lot = lotForms[product.id] || blankLot;
    setBusy(true); setError(""); setNotice("");
    try {
      await appointmentRequest(user, "/api/provider/pharmacy-products/receive-lot", "POST", {
        productId: product.id,
        lotNumber: lot.lotNumber,
        expirationDate: lot.expirationDate,
        quantityReceived: Number(lot.quantityReceived),
      });
      setLotForms((current) => ({ ...current, [product.id]: blankLot }));
      setNotice(`Le lot reçu pour « ${product.name} » est enregistré.`);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le lot n’a pas pu être enregistré."); }
    finally { setBusy(false); }
  }

  async function archive(product: Product) {
    if (!window.confirm(`Archiver « ${product.name} » ?`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await appointmentRequest(user, "/api/provider/pharmacy-products", "DELETE", { productId: product.id });
      setNotice("Le produit est archivé et retiré du catalogue.");
      if (editingId === product.id) clearForm();
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le produit n’a pas pu être archivé."); }
    finally { setBusy(false); }
  }

  return <section className="pharmacy-workspace" aria-labelledby="pharmacy-products-heading">
    <div className="pharmacy-workspace-heading"><p className="eyebrow">Espace partenaire</p><h2 id="pharmacy-products-heading">Catalogue pharmacie.</h2><p>Les nouveaux produits et les modifications passent par la revue NEXA avant publication. Aucun fichier médical ni renseignement patient n’est demandé dans cette fiche.</p></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}{notice ? <p className="form-notice" role="status">{notice}</p> : null}
    <PharmacyOrderManager user={user} />
    <form className="auth-form pharmacy-product-form" onSubmit={(event) => void save(event)}>
      <h3>{editingId ? "Modifier le produit" : "Ajouter un produit"}</h3>
      <div className="form-grid two-columns">
        <label>Nom du produit<input required maxLength={180} value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label>
        <label>DCI / principe actif<input required maxLength={180} value={form.dci} onChange={(event) => setForm((current) => ({ ...current, dci: event.target.value }))} /></label>
        <label>Dosage<input required maxLength={120} placeholder="Ex. 500 mg" value={form.dosage} onChange={(event) => setForm((current) => ({ ...current, dosage: event.target.value }))} /></label>
        <label>Forme pharmaceutique<input required maxLength={100} placeholder="Comprimé, sirop…" value={form.pharmaceuticalForm} onChange={(event) => setForm((current) => ({ ...current, pharmaceuticalForm: event.target.value }))} /></label>
        <label>Classe thérapeutique<input required maxLength={120} value={form.therapeuticClass} onChange={(event) => setForm((current) => ({ ...current, therapeuticClass: event.target.value }))} /></label>
        <label>Catégorie réglementaire<select value={form.regulatoryCategory} onChange={(event) => { const regulatoryCategory = event.target.value; setForm((current) => ({ ...current, regulatoryCategory, prescriptionRequired: regulatoryCategory !== "OTC" || current.prescriptionRequired })); }}><option value="OTC">Vente libre (OTC)</option><option value="PRESCRIPTION">Ordonnance requise</option><option value="CONTROLLED">Produit contrôlé</option><option value="NARCOTIC">Stupéfiant</option><option value="SENSITIVE">Produit sensible</option></select></label>
        <label>Prix (HTG)<input required min="1" max="10000000" step="1" type="number" value={form.price || ""} onChange={(event) => setForm((current) => ({ ...current, price: Number(event.target.value) }))} /></label>
        <label>{editingId ? "Stock des lots valides" : "Quantité du lot initial"}<input required min="0" max="1000000" step="1" readOnly={Boolean(editingId)} type="number" value={form.stock} onChange={(event) => setForm((current) => ({ ...current, stock: Number(event.target.value) }))} /></label>
        {!editingId && form.stock > 0 ? <>
          <label>Numéro du lot initial<input required maxLength={80} value={initialLotNumber} onChange={(event) => setInitialLotNumber(event.target.value)} /></label>
          <label>Date d’expiration du lot initial<input required type="date" value={initialLotExpiration} onChange={(event) => setInitialLotExpiration(event.target.value)} /></label>
        </> : null}
        <label>Fabricant<input maxLength={120} value={form.manufacturer || ""} onChange={(event) => setForm((current) => ({ ...current, manufacturer: event.target.value }))} /></label>
      </div>
      <label>Description publique<textarea rows={3} maxLength={700} value={form.publicDescription || ""} onChange={(event) => setForm((current) => ({ ...current, publicDescription: event.target.value }))} /></label>
      <label className="pharmacy-prescription-check"><input checked={form.prescriptionRequired} disabled={form.regulatoryCategory !== "OTC"} onChange={(event) => setForm((current) => ({ ...current, prescriptionRequired: event.target.checked }))} type="checkbox" />La délivrance exige une ordonnance valide.</label>
      <div className="form-grid two-columns"><label>Modalités de réception<select value={form.deliveryMode} onChange={(event) => setForm((current) => ({ ...current, deliveryMode: event.target.value as ProductForm["deliveryMode"] }))}><option value="pickup">Retrait en pharmacie</option><option value="delivery" disabled={form.coldChainRequired}>Livraison à domicile</option><option value="both" disabled={form.coldChainRequired}>Retrait et livraison</option></select></label><label className="pharmacy-prescription-check"><input checked={form.coldChainRequired} onChange={(event) => setForm((current) => ({ ...current, coldChainRequired: event.target.checked, deliveryMode: event.target.checked ? "pickup" : current.deliveryMode }))} type="checkbox" />Produit nécessitant la chaîne du froid</label></div>
      {form.deliveryMode !== "pickup" ? <label>Zones de livraison<textarea required rows={4} maxLength={5000} placeholder={"Ouest | Port-au-Prince | 250 | 24 à 48 h\nOuest | Delmas | 200 | Le jour même"} value={deliveryZonesText} onChange={(event) => setDeliveryZonesText(event.target.value)} /><small>Une zone par ligne : Département | Commune | frais entiers HTG | délai indicatif. Les produits de chaîne du froid restent au retrait.</small></label> : null}
      <div className="prescription-actions"><button className="button button-primary" disabled={busy} type="submit">{busy ? "Enregistrement…" : editingId ? "Envoyer les changements en revue" : "Envoyer pour revue"}</button>{editingId ? <button className="button button-outline" disabled={busy} onClick={clearForm} type="button">Annuler la modification</button> : null}</div>
    </form>
    <div className="pharmacy-product-list"><h3>Vos produits</h3>{loading ? <p role="status">Chargement du catalogue…</p> : products.length ? products.map((product) => {
      const lotForm = lotForms[product.id] || blankLot;
      return <article className="pharmacy-product-card" key={product.id}>
        <div><strong>{product.name}</strong><span>{product.dci} · {product.dosage} · {product.pharmaceuticalForm}</span><small>{statusLabels[product.publicationStatus] || product.publicationStatus} · {new Intl.NumberFormat("fr-HT").format(product.price)} HTG · Stock des lots valides {product.stock}{product.reservedStock ? ` (${product.reservedStock} réservé)` : ""}</small><small>{product.deliveryMode === "delivery" ? "Livraison" : product.deliveryMode === "both" ? "Retrait et livraison" : "Retrait"}{product.coldChainRequired ? " · Chaîne du froid" : ""}{product.deliveryZones?.length ? ` · ${product.deliveryZones.filter((zone) => zone.active).length} zone(s)` : ""}</small>{product.lots?.length ? <small>Lots : {product.lots.map((lot) => `${lot.lotNumber} · expire ${lot.expirationDate} · ${lot.quantityAvailable} disponible(s)${lot.status && lot.status !== "ACTIVE" ? ` · ${lot.status}` : ""}`).join(" ; ")}</small> : null}{product.legacyStockUnreconciled ? <small role="status">Stock historique non rapproché : {product.legacyStockUnreconciled} unité(s) exclue(s) du catalogue.</small> : null}{product.reviewReason ? <small>Note de revue : {product.reviewReason}</small> : null}{product.prescriptionRequired ? <small>Ordonnance obligatoire</small> : null}</div>
        <div className="prescription-actions"><button className="button button-outline" disabled={busy || product.publicationStatus === "PUBLISHED"} onClick={() => edit(product)} type="button">Modifier</button><button className="button button-quiet" disabled={busy || Number(product.reservedStock || 0) > 0} onClick={() => void archive(product)} type="button">Archiver</button></div>
        <form className="auth-form pharmacy-product-form" onSubmit={(event) => { event.preventDefault(); void receiveLot(product); }}>
          <h4>Réceptionner un lot</h4>
          <div className="form-grid two-columns">
            <label>Numéro de lot<input required maxLength={80} value={lotForm.lotNumber} onChange={(event) => setLotForms((current) => ({ ...current, [product.id]: { ...lotForm, lotNumber: event.target.value } }))} /></label>
            <label>Date d’expiration<input required type="date" value={lotForm.expirationDate} onChange={(event) => setLotForms((current) => ({ ...current, [product.id]: { ...lotForm, expirationDate: event.target.value } }))} /></label>
            <label>Quantité reçue<input required min="1" max="1000000" step="1" type="number" value={lotForm.quantityReceived} onChange={(event) => setLotForms((current) => ({ ...current, [product.id]: { ...lotForm, quantityReceived: event.target.value } }))} /></label>
          </div>
          <button className="button button-outline" disabled={busy} type="submit">{busy ? "Enregistrement…" : "Enregistrer le lot"}</button>
        </form>
      </article>;
    }) : <p>Aucun produit enregistré pour cette pharmacie.</p>}</div>
  </section>;
}
