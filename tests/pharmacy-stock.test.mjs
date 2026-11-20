import assert from "node:assert/strict";
import { test } from "node:test";
import {
  consumeReservedLots,
  createPharmacyLot,
  expirePharmacyLots,
  getAvailableSellableStock,
  getSellableStock,
  getReservedStock,
  releaseReservedLots,
  reserveSellableLots,
} from "../src/lib/pharmacy/stock.ts";

const now = Date.parse("2026-11-08T12:00:00.000Z");

function lot(lotNumber, expirationDate, quantityAvailable, reservedQuantity = 0, status = "ACTIVE") {
  return { lotNumber, expirationDate, quantityReceived: quantityAvailable, quantityAvailable, reservedQuantity, status };
}

test("reserves sellable inventory by earliest expiry and ignores expired or quarantined lots", () => {
  const product = { lots: [
    lot("LOT-OLD", "2026-11-07", 4),
    lot("LOT-A", "2026-11-09", 2, 1),
    lot("LOT-B", "2026-12-31", 5),
    lot("LOT-Q", "2026-12-31", 20, 0, "QUARANTINE"),
  ] };

  assert.equal(getSellableStock(product, now), 7);
  assert.equal(getAvailableSellableStock(product, now), 6);
  const reservation = reserveSellableLots(product, 4, now);
  assert.deepEqual(reservation.allocations, [
    { lotNumber: "LOT-A", quantity: 1 },
    { lotNumber: "LOT-B", quantity: 3 },
  ]);
  assert.equal(reservation.lots[0].status, "EXPIRED");
  assert.equal(reservation.stock, 7);
  assert.equal(reservation.reservedStock, 5);
  assert.equal(getAvailableSellableStock({ lots: reservation.lots }, now), 2);
  assert.equal(product.lots[1].reservedQuantity, 1, "reservation does not mutate the source product");
});

test("consumes only the reserved quantities and retains an earlier reservation", () => {
  const product = { lots: [lot("LOT-A", "2026-11-09", 2, 2), lot("LOT-B", "2026-12-31", 5, 3)] };
  const consumed = consumeReservedLots(product, [
    { lotNumber: "LOT-A", quantity: 1 },
    { lotNumber: "LOT-B", quantity: 3 },
  ], now);

  assert.equal(consumed.stock, 3);
  assert.equal(consumed.reservedStock, 1);
  assert.deepEqual(consumed.lots.map(({ lotNumber, quantityAvailable, reservedQuantity }) => ({ lotNumber, quantityAvailable, reservedQuantity })), [
    { lotNumber: "LOT-A", quantityAvailable: 1, reservedQuantity: 1 },
    { lotNumber: "LOT-B", quantityAvailable: 2, reservedQuantity: 0 },
  ]);
});

test("releases an unpaid hold after expiry without returning expired medicine to sale", () => {
  const product = { lots: [lot("LOT-A", "2026-11-09", 3, 2)] };
  const released = releaseReservedLots(product, [{ lotNumber: "LOT-A", quantity: 2 }], Date.parse("2026-11-10T12:00:00Z"));
  assert.equal(released.stock, 0);
  assert.equal(released.reservedStock, 0);
  assert.equal(released.lots[0].quantityAvailable, 3);
});

test("does not dispense a lot that expires after checkout", () => {
  const product = { lots: [lot("LOT-A", "2026-11-09", 2, 1)] };
  assert.throws(() => consumeReservedLots(product, [{ lotNumber: "LOT-A", quantity: 1 }], Date.parse("2026-11-10T12:00:00Z")), /lot-reservation-not-sellable/);
  assert.equal(product.lots[0].quantityAvailable, 2);
  assert.equal(product.lots[0].reservedQuantity, 1);
});

test("expiration marks a lot unavailable but keeps the physical and reserved quantities for review", () => {
  const result = expirePharmacyLots({ lots: [lot("LOT-A", "2026-11-07", 4, 1)] }, now);
  assert.equal(result.expiredLots, 1);
  assert.equal(result.stock, 0);
  assert.equal(result.reservedStock, 1);
  assert.equal(result.lots[0].quantityAvailable, 4);
  assert.equal(result.lots[0].status, "EXPIRED");
});

test("creates a valid future lot and rejects malformed, expired, or zero-quantity lots", () => {
  assert.deepEqual(createPharmacyLot({ lotNumber: "LOT-NEW-1", expirationDate: "2026-11-09", quantityReceived: 12 }, now), {
    lotNumber: "LOT-NEW-1",
    expirationDate: "2026-11-09",
    quantityReceived: 12,
    quantityAvailable: 12,
    reservedQuantity: 0,
    status: "ACTIVE",
    receivedAt: new Date(now).toISOString(),
  });
  assert.throws(() => createPharmacyLot({ lotNumber: "LOT-OLD", expirationDate: "2026-11-07", quantityReceived: 2 }, now), /invalid-pharmacy-lot/);
  assert.throws(() => createPharmacyLot({ lotNumber: "LOT-ZERO", expirationDate: "2026-12-01", quantityReceived: 0 }, now), /invalid-pharmacy-lot/);
  assert.equal(getReservedStock({ lots: [lot("LOT-R", "2026-12-01", 2, 1)] }), 1);
});
