import { timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { settlePaidPayment } from "@/lib/payments/settlement.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { releaseReservedLots } from "@/lib/pharmacy/stock";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET || "";
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!secret || token.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(secret));
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ ok: false, error: "Expiration des paniers non configurée." }, { status: 503 });
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "Accès refusé." }, { status: 401 });
  try {
    const db = getFirebaseAdminDb();
    const now = Date.now();
    const expired = await db.collection("nexaOrders")
      .where("kind", "in", ["pharmacy", "laboratory", "imaging"])
      .where("status", "==", "PENDING_PAYMENT")
      .where("holdExpiresAt", "<=", now)
      .limit(100)
      .get();
    let released = 0;
    let reconciled = 0;

    for (const candidate of expired.docs) {
      const orderRef = candidate.ref;
      const preview = candidate.data();
      const kind = String(preview.kind || "");
      const paymentRef = typeof preview.moncashPaymentRef === "string" ? preview.moncashPaymentRef : "";
      const paymentRefDoc = paymentRef ? db.collection("paymentIntents").doc(paymentRef) : null;
      const lines = Array.isArray(preview.items) ? preview.items as Record<string, unknown>[] : [];
      const productRefs = kind === "pharmacy" ? lines.map((item) => db.collection("pharmacyProducts").doc(String(item.productId || "_"))) : [];
      const alertRef = db.collection("paymentSettlementAlerts").doc(`order_expire_${candidate.id}`);
      const eventRef = db.collection("nexaOrderEvents").doc();
      const movementRefs = lines.map((_, index) => db.collection("pharmacyStockMovements").doc(`${candidate.id}__hold_expired__${index}`));
      const outcome = await db.runTransaction(async (transaction) => {
        const [orderSnapshot, paymentSnapshot, alertSnapshot, ...productSnapshots] = await Promise.all([
          transaction.get(orderRef),
          paymentRefDoc ? transaction.get(paymentRefDoc) : Promise.resolve(null),
          transaction.get(alertRef),
          ...productRefs.map((ref) => transaction.get(ref)),
        ]);
        if (!orderSnapshot.exists || !["pharmacy", "laboratory", "imaging"].includes(String(orderSnapshot.get("kind"))) || orderSnapshot.get("status") !== "PENDING_PAYMENT" || Number(orderSnapshot.get("holdExpiresAt")) > now) return "skipped" as const;
        if (paymentSnapshot?.exists && paymentSnapshot.get("status") === "paid") return "paid" as const;

        const currentLines = Array.isArray(orderSnapshot.get("items")) ? orderSnapshot.get("items") as Record<string, unknown>[] : [];
        let reservationMismatch = false;
        const stockUpdates: { index: number; lots?: ReturnType<typeof releaseReservedLots>["lots"]; stock?: number; reservedStock: number }[] = [];
        for (let index = 0; kind === "pharmacy" && index < currentLines.length; index += 1) {
          const quantity = Math.max(0, Number(currentLines[index].quantity) || 0);
          const productSnapshot = productSnapshots[index];
          if (!productSnapshot?.exists) { reservationMismatch = true; continue; }
          const allocations = currentLines[index].reservedLots;
          if (Array.isArray(allocations) && allocations.length > 0) {
            try {
              stockUpdates.push({ index, ...releaseReservedLots(productSnapshot.data() || {}, allocations as { lotNumber: string; quantity: number }[], now) });
            } catch { reservationMismatch = true; }
          } else if (Array.isArray(productSnapshot.get("lots")) || Number(productSnapshot.get("reservedStock") || 0) < quantity) {
            // A lot-tracked product must have a matching per-order allocation. Never release a different order's lot hold.
            reservationMismatch = true;
          } else {
            stockUpdates.push({ index, reservedStock: Math.max(0, Number(productSnapshot.get("reservedStock") || 0) - quantity) });
          }
        }

        stockUpdates.forEach(({ index, lots, stock, reservedStock }) => transaction.set(productRefs[index], {
          ...(lots ? { lots, stock } : {}),
          reservedStock,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true }));
        if (kind === "pharmacy") stockUpdates.forEach(({ index }) => {
          const line = currentLines[index];
          if (!Array.isArray(line.reservedLots) || line.reservedLots.length === 0) return;
          transaction.create(movementRefs[index], {
            productId: String(line.productId || ""),
            providerUid: String(orderSnapshot.get("providerUid") || ""),
            orderId: candidate.id,
            movementType: "RELEASE",
            direction: "RELEASE",
            quantity: Number(line.quantity) || 0,
            lotAllocations: line.reservedLots,
            actorUid: "system:cron",
            reason: "PAYMENT_HOLD_EXPIRED",
            createdAt: FieldValue.serverTimestamp(),
          });
        });
        transaction.set(orderRef, {
          status: "PAYMENT_EXPIRED",
          paymentStatus: "EXPIRED",
          settlementStatus: reservationMismatch ? "REVIEW_REQUIRED" : "EXPIRED",
          expiredAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        transaction.create(eventRef, { orderId: candidate.id, fromStatus: "PENDING_PAYMENT", toStatus: "PAYMENT_EXPIRED", action: "PAYMENT_HOLD_EXPIRED", actorUid: "system:cron", createdAt: FieldValue.serverTimestamp() });
        if (paymentRefDoc && paymentSnapshot?.exists && ["created", "awaiting_payment", "payment_pending", "initializing", "pending"].includes(String(paymentSnapshot.get("status") || "").toLowerCase())) transaction.set(paymentRefDoc, {
          status: "expired", updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        if (reservationMismatch && !alertSnapshot.exists) transaction.create(alertRef, {
          paymentRef: paymentRef || null,
          resourceType: `${kind}-order`,
          resourceId: candidate.id,
          reason: "ORDER_STOCK_RESERVATION_MISMATCH",
          status: "open",
          createdAt: FieldValue.serverTimestamp(),
        });
        return reservationMismatch ? "reconciled" as const : "released" as const;
      });
      if (outcome === "released") released += 1;
      else if (outcome === "reconciled") reconciled += 1;
      else if (outcome === "paid" && paymentRef) {
        await settlePaidPayment(paymentRef);
        reconciled += 1;
      }
    }
    return NextResponse.json({ ok: true, scanned: expired.size, released, reconciled }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    console.error("NEXA pharmacy order expiration failed", error instanceof Error ? error.name : "unknown-error");
    return NextResponse.json({ ok: false, error: "Les réservations pharmacie expirées ne sont pas disponibles." }, { status: 500, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
