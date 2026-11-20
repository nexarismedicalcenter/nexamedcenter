"use client";

import { useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";

type PharmacyOrder = { id: string; orderNumber: string; items: { productId: string; name: string; dci: string; dosage: string; pharmaceuticalForm: string; quantity: number; unitPrice: number; lineTotal: number; prescriptionRequired: boolean }[]; subtotal: number; deliveryFee: number; amount: number; currency: string; deliveryMethod: string; deliveryAddress?: { recipientName: string; phone: string; department: string; commune: string; addressLine: string; instructions: string } | null; paymentStatus: string; status: string; requiresPrescription: boolean; createdAt: string | null };
type Prescription = { id: string; providerName: string; specialtyName: string; validatedAt: string | null; medications: { name: string; dosage?: string; form?: string; route?: string; quantity?: number | null; duration?: string; instructions?: string }[] };

const statusLabels: Record<string, string> = { PENDING_PAYMENT: "Paiement en attente", PAID: "Payée · à accepter", ACCEPTED: "Acceptée", PREPARING: "En préparation", READY: "Prête", DELIVERING: "En livraison", DELIVERED: "Livrée", COMPLETED: "Retrait confirmé", PROVIDER_REFUSED: "Refusée · remboursement à rapprocher", PAYMENT_EXPIRED: "Réservation expirée" };

export default function PharmacyOrderManager({ user }: { user: User }) {
  const [orders, setOrders] = useState<PharmacyOrder[]>([]);
  const [prescriptions, setPrescriptions] = useState<Record<string, Prescription>>({});
  const [refusalReasons, setRefusalReasons] = useState<Record<string, string>>({});
  const [deliveryProofs, setDeliveryProofs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try { const result = await appointmentRequest<{ orders: PharmacyOrder[] }>(user, "/api/provider/pharmacy-orders"); setOrders(result.orders || []); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Les commandes pharmacie ne sont pas disponibles."); }
    finally { setLoading(false); }
  }, [user]);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);

  async function act(order: PharmacyOrder, action: "accept" | "refuse" | "prepare" | "ready" | "dispatch" | "deliver" | "complete") {
    const reason = refusalReasons[order.id]?.trim() || "";
    const deliveryProofReference = deliveryProofs[order.id]?.trim() || "";
    if (action === "refuse" && !reason) { setError("Indiquez le motif du refus pour permettre à NEXA de rapprocher le remboursement."); return; }
    if (action === "deliver" && deliveryProofReference.length < 3) { setError("Saisissez la référence de preuve de remise au patient."); return; }
    if (action === "refuse" && !window.confirm("Refuser cette commande payée ? NEXA devra rapprocher le remboursement MonCash.")) return;
    setBusyId(order.id); setError(""); setNotice("");
    try {
      await appointmentRequest(user, "/api/provider/pharmacy-orders", "POST", { orderId: order.id, action, ...(action === "refuse" ? { reason } : {}), ...(action === "deliver" ? { deliveryProofReference } : {}) });
      setNotice(action === "refuse" ? "Le refus est enregistré; NEXA doit traiter le rapprochement du remboursement." : action === "deliver" ? "La remise est confirmée et le stock a été décompté." : "Le statut de la commande est mis à jour.");
      setRefusalReasons((current) => ({ ...current, [order.id]: "" }));
      setDeliveryProofs((current) => ({ ...current, [order.id]: "" }));
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "La commande n’a pas pu être mise à jour."); }
    finally { setBusyId(""); }
  }

  async function viewPrescription(order: PharmacyOrder) {
    setBusyId(order.id); setError("");
    try {
      const result = await appointmentRequest<{ prescription: Prescription }>(user, `/api/provider/pharmacy-orders/${encodeURIComponent(order.id)}/prescription`);
      setPrescriptions((current) => ({ ...current, [order.id]: result.prescription }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "L’ordonnance n’est pas accessible."); }
    finally { setBusyId(""); }
  }

  return <section className="pharmacy-orders" aria-labelledby="pharmacy-orders-heading">
    <div className="pharmacy-orders-heading"><h3 id="pharmacy-orders-heading">Commandes à traiter</h3><button className="button button-quiet" disabled={loading || Boolean(busyId)} onClick={() => void load()} type="button">Actualiser</button></div>
    {error ? <p className="form-error" role="alert">{error}</p> : null}{notice ? <p className="form-notice" role="status">{notice}</p> : null}
    {loading ? <p role="status">Chargement des commandes…</p> : orders.length ? <div className="pharmacy-order-list">{orders.map((order) => <article className="pharmacy-order-card" key={order.id}>
      <div className="pharmacy-order-top"><div><strong>{order.orderNumber}</strong><span>{order.createdAt ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(new Date(order.createdAt)) : "Date à confirmer"} · {statusLabels[order.status] || order.status}</span><span>{order.deliveryMethod === "delivery" ? "Livraison à domicile" : "Retrait en pharmacie"}</span></div><strong>{new Intl.NumberFormat("fr-HT").format(order.amount || order.subtotal)} {order.currency || "HTG"}</strong></div>
      {order.deliveryMethod === "delivery" && order.deliveryAddress ? <address className="pharmacy-order-delivery-address"><strong>Adresse de livraison</strong><span>{order.deliveryAddress.recipientName} · {order.deliveryAddress.phone}</span><span>{order.deliveryAddress.addressLine}, {order.deliveryAddress.commune}, {order.deliveryAddress.department}</span>{order.deliveryAddress.instructions ? <span>Instructions : {order.deliveryAddress.instructions}</span> : null}<small>Sous-total {new Intl.NumberFormat("fr-HT").format(order.subtotal)} HTG · livraison {new Intl.NumberFormat("fr-HT").format(order.deliveryFee)} HTG</small></address> : null}
      <ul className="pharmacy-order-lines">{order.items.map((item) => <li key={item.productId}><span>{item.name} · {item.dosage} · {item.pharmaceuticalForm} × {item.quantity}</span><strong>{new Intl.NumberFormat("fr-HT").format(item.lineTotal)} HTG</strong></li>)}</ul>
      {order.requiresPrescription ? <div className="pharmacy-order-prescription"><p>Une ordonnance validée est associée à cette commande.</p>{prescriptions[order.id] ? <div className="pharmacy-prescription-detail"><strong>Ordonnance du {prescriptions[order.id].providerName}{prescriptions[order.id].specialtyName ? ` · ${prescriptions[order.id].specialtyName}` : ""}</strong><ul>{prescriptions[order.id].medications.map((medicine, index) => <li key={`${medicine.name}-${index}`}>{medicine.name}{medicine.dosage ? ` · ${medicine.dosage}` : ""}{medicine.quantity ? ` · quantité ${medicine.quantity}` : ""}{medicine.instructions ? ` · ${medicine.instructions}` : ""}</li>)}</ul><small>Consultation de l’ordonnance journalisée dans le dossier clinique.</small></div> : <button className="button button-outline" disabled={busyId === order.id} onClick={() => void viewPrescription(order)} type="button">{busyId === order.id ? "Ouverture…" : "Consulter l’ordonnance"}</button>}</div> : null}
      {order.status === "PAID" || order.status === "ACCEPTED" || order.status === "PREPARING" ? <div className="pharmacy-order-actions">{order.status === "PAID" ? <button className="button button-primary" disabled={Boolean(busyId)} onClick={() => void act(order, "accept")} type="button">Accepter</button> : null}{order.status === "ACCEPTED" ? <button className="button button-primary" disabled={Boolean(busyId)} onClick={() => void act(order, "prepare")} type="button">Commencer la préparation</button> : null}{order.status === "PREPARING" ? <button className="button button-primary" disabled={Boolean(busyId)} onClick={() => void act(order, "ready")} type="button">Marquer prête{order.deliveryMethod === "delivery" ? " pour livraison" : " au retrait"}</button> : null}<label className="pharmacy-refusal-label">Motif du refus<input maxLength={500} value={refusalReasons[order.id] || ""} onChange={(event) => setRefusalReasons((current) => ({ ...current, [order.id]: event.target.value }))} /></label><button className="button button-quiet" disabled={Boolean(busyId) || !refusalReasons[order.id]?.trim()} onClick={() => void act(order, "refuse")} type="button">Refuser · signaler à NEXA</button></div> : null}
      {order.status === "READY" && order.deliveryMethod === "pickup" ? <button className="button button-outline" disabled={Boolean(busyId)} onClick={() => void act(order, "complete")} type="button">Confirmer le retrait</button> : null}
      {order.status === "READY" && order.deliveryMethod === "delivery" ? <button className="button button-outline" disabled={Boolean(busyId)} onClick={() => void act(order, "dispatch")} type="button">Remettre au livreur</button> : null}
      {order.status === "DELIVERING" ? <div className="pharmacy-order-actions"><label>Référence de preuve de remise<input required minLength={3} maxLength={120} value={deliveryProofs[order.id] || ""} onChange={(event) => setDeliveryProofs((current) => ({ ...current, [order.id]: event.target.value }))} placeholder="Ex. reçu ou code confirmé" /></label><button className="button button-primary" disabled={Boolean(busyId) || (deliveryProofs[order.id] || "").trim().length < 3} onClick={() => void act(order, "deliver")} type="button">Confirmer la remise au patient</button></div> : null}
    </article>)}</div> : <p>Aucune commande pharmacie enregistrée.</p>}
    <p className="appointment-privacy">Les remboursements et les annulations après paiement restent traités par NEXA avec rapprochement externe.</p>
  </section>;
}
