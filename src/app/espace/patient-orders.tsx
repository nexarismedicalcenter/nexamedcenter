"use client";

import { useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { useRouter } from "next/navigation";
import { appointmentRequest } from "@/lib/appointments/client";
import CashRefundRequest from "./cash-refund-request";

type OrderItem = { offerId?: string; name: string; dci?: string; dosage?: string; pharmaceuticalForm?: string; quantity?: number; unitPrice?: number; price?: number; lineTotal?: number; resultStatus?: string };
type OrderSummary = { id: string; kind: "pharmacy" | "laboratory" | "imaging"; orderNumber: string; providerName: string; items: OrderItem[]; subtotal: number; deliveryFee: number; amount: number; transactionFee: number; totalAmount: number; transactionFeeRateBps: number; currency: string; deliveryMethod: string; deliveryAddress?: { recipientName: string; phone: string; department: string; commune: string; addressLine: string; instructions: string } | null; paymentStatus: string; refundMethod?: string | null; requestedRefundMethod?: string | null; refundRequired: boolean; refundedAmount?: number | null; settlementStatus: string; status: string; createdAt: string | null; holdExpiresAt: number | null; paymentRef: string | null };

const statusLabels: Record<string, string> = {
  PENDING_PAYMENT: "Paiement en attente",
  PAID: "Payée · en attente de la pharmacie",
  ACCEPTED: "Acceptée par la pharmacie",
  PREPARING: "En préparation",
  READY: "Prête au retrait",
  COMPLETED: "Retrait confirmé",
  DELIVERING: "En cours de livraison",
  DELIVERED: "Livrée",
  PROVIDER_REFUSED: "Refusée · remboursement à vérifier par NEXA",
  REFUNDED: "Remboursée",
  PAYMENT_EXPIRED: "Réservation expirée",
  PATIENT_PRESENTED: "Présence confirmée au centre",
  SAMPLE_COLLECTED: "Prélèvement effectué",
  SAMPLE_RECEIVED: "Échantillon reçu au laboratoire",
  ANALYSIS_IN_PROGRESS: "Analyse en cours",
  EXAM_IN_PROGRESS: "Examen en cours",
  EXAM_COMPLETED: "Examen terminé · résultat en préparation",
};

const resultStatusLabels: Record<string, string> = {
  RESULT_PENDING_REVIEW: "Résultat transmis à NEXA pour vérification",
  VALIDATED: "Résultat vérifié · transfert au patient en attente",
  RESULT_AVAILABLE: "Résultat disponible dans votre espace patient",
  CORRECTION_REQUESTED: "Le centre prépare une correction du résultat",
  NOT_PERFORMED: "NEXA suit cet examen · aucun paiement supplémentaire",
};

function typeLabel(kind: OrderSummary["kind"]) {
  return kind === "pharmacy" ? "Pharmacie" : kind === "laboratory" ? "Laboratoire" : "Imagerie";
}

export default function PatientOrders({ user }: { user: User }) {
  const router = useRouter();
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);

  const load = useCallback(async () => {
    try {
      const result = await appointmentRequest<{ orders: OrderSummary[] }>(user, "/api/patient/orders");
      setOrders(result.orders || []); setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Vos commandes ne peuvent pas être chargées."); }
    finally { setLoading(false); }
  }, [user]);

  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => { const interval = window.setInterval(() => setCurrentTime(Date.now()), 30_000); const initial = window.setTimeout(() => setCurrentTime(Date.now()), 0); return () => { window.clearInterval(interval); window.clearTimeout(initial); }; }, []);

  async function resumePayment(order: OrderSummary) {
    if (!order.paymentRef) return;
    setBusyId(order.id); setError("");
    try {
      const payment = await appointmentRequest<{ status: string; checkoutUrl?: string }>(user, "/api/payments/moncash/create", "POST", { paymentRef: order.paymentRef });
      if (payment.status === "paid") { router.push(`/paiement/retour?paymentRef=${encodeURIComponent(order.paymentRef)}`); return; }
      const url = new URL(payment.checkoutUrl || "");
      if (url.protocol !== "https:" || url.hostname !== "moncashbutton.digicelgroup.com") throw new Error("Le lien MonCash n’est pas valide.");
      window.location.assign(url.toString());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le paiement ne peut pas être repris."); await load(); }
    finally { setBusyId(""); }
  }

  async function payWithWallet(order: OrderSummary) {
    if (!order.paymentRef) return;
    setBusyId(order.id); setError("");
    try {
      const result = await appointmentRequest<{ paymentMethod: string }>(user, `/api/patient/orders/${encodeURIComponent(order.id)}/pay-wallet`, "POST", {});
      if (result.paymentMethod === "MONCASH") { router.push(`/paiement/retour?paymentRef=${encodeURIComponent(order.paymentRef)}`); return; }
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le portefeuille NEXA ne peut pas payer cette commande."); }
    finally { setBusyId(""); }
  }

  return <section className="patient-appointments" aria-labelledby="patient-orders-heading">
    <h2 id="patient-orders-heading">Mes commandes</h2>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {loading ? <p role="status">Chargement des commandes…</p> : orders.length ? <ul>{orders.map((order) => {
      const expired = Boolean(order.holdExpiresAt && currentTime && order.holdExpiresAt <= currentTime);
      const latePaid = order.status === "PAYMENT_EXPIRED" && order.paymentStatus === "PAID";
      const status = latePaid ? "Paiement reçu après expiration · rapprochement NEXA" : order.status === "PAID" && order.paymentStatus === "FREE" ? "Confirmée sans frais" : order.status === "PAID" && order.kind !== "pharmacy" ? "Payée · en attente du centre" : order.kind !== "pharmacy" && order.status === "COMPLETED" ? "Commande terminée · résultat remis" : statusLabels[order.status] || order.status;
      return <li className="patient-order-item" key={order.id}><div><strong>{typeLabel(order.kind)} · {order.providerName} · {order.orderNumber}</strong>{order.items.map((item, index) => <span key={`${item.offerId || item.name}-${index}`}>{item.name}{item.quantity && item.quantity > 1 ? ` × ${item.quantity}` : ""}{item.resultStatus && resultStatusLabels[item.resultStatus] ? <small className="patient-order-result-status">{resultStatusLabels[item.resultStatus]}</small> : null}</span>)}<small>{order.createdAt ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(new Date(order.createdAt)) : "Date à confirmer"} · {status}</small>{order.kind === "pharmacy" && order.deliveryMethod === "pickup" ? <small>Retrait en pharmacie</small> : null}{order.kind === "pharmacy" && order.deliveryMethod === "delivery" ? <small>Livraison à {order.deliveryAddress?.recipientName || ""} · {order.deliveryAddress?.addressLine || "Adresse non renseignée"}, {order.deliveryAddress?.commune || ""}, {order.deliveryAddress?.department || ""} · {order.deliveryAddress?.phone || ""}</small> : null}{order.kind === "pharmacy" && order.deliveryMethod === "delivery" && order.deliveryAddress?.instructions ? <small>Instructions : {order.deliveryAddress.instructions}</small> : null}{order.kind === "pharmacy" && order.deliveryMethod === "delivery" ? <small>Sous-total {new Intl.NumberFormat("fr-HT").format(order.subtotal)} HTG · livraison {new Intl.NumberFormat("fr-HT").format(order.deliveryFee)} HTG</small> : null}{order.transactionFee > 0 ? <small>Montant du service : {new Intl.NumberFormat("fr-HT").format(order.amount)} HTG · frais de transaction ({(order.transactionFeeRateBps / 100).toLocaleString("fr-HT")} %) : {new Intl.NumberFormat("fr-HT").format(order.transactionFee)} HTG · total à payer : {new Intl.NumberFormat("fr-HT").format(order.totalAmount)} HTG. Les frais ne sont pas remboursés.</small> : null}{latePaid ? <small>Ne payez pas une seconde fois. NEXA vérifie la transaction et vous contactera.</small> : null}{order.status === "PROVIDER_REFUSED" && order.paymentStatus !== "FREE" ? <small>NEXA doit vérifier le remboursement. Ne payez pas à nouveau.</small> : null}{order.status === "REFUNDED" ? <small>{order.refundMethod === "NEXA_WALLET" ? `${new Intl.NumberFormat("fr-HT").format(order.refundedAmount || order.amount)} HTG crédités dans votre portefeuille NEXA.` : order.refundMethod === "MONCASH_EXTERNAL" ? "Le remboursement externe MonCash a été confirmé par NEXA." : "NEXA a enregistré le remboursement."}</small> : null}{order.status === "PROVIDER_REFUSED" && order.paymentStatus === "PAID" && order.settlementStatus === "CONFIRMED" && order.refundRequired ? <CashRefundRequest user={user} resourceType={`${order.kind}-order` as "pharmacy-order" | "laboratory-order" | "imaging-order"} resourceId={order.id} alreadyRequested={order.requestedRefundMethod === "CASH_MANUAL"} /> : null}</div>{order.status === "PENDING_PAYMENT" && order.paymentStatus === "PENDING" && !expired && order.paymentRef ? <div className="patient-order-payment-actions"><button className="button button-primary" disabled={busyId === order.id} onClick={() => void resumePayment(order)} type="button">{busyId === order.id ? "Ouverture…" : `Payer ${new Intl.NumberFormat("fr-HT").format(order.totalAmount)} ${order.currency} par MonCash`}</button><button className="button button-outline" disabled={busyId === order.id} onClick={() => void payWithWallet(order)} type="button">Payer avec le portefeuille NEXA</button></div> : order.status === "PENDING_PAYMENT" && expired ? <small>Cette commande expire; actualisez dans quelques instants.</small> : null}</li>;
    })}</ul> : <p>Vous n’avez pas encore de commande.</p>}
    <p className="appointment-privacy">La passerelle MonCash reçoit une référence opaque, un montant et une devise. Après vérification, NEXA peut créditer un remboursement dans votre portefeuille; aucun remboursement externe n’est déclenché automatiquement.</p>
  </section>;
}
