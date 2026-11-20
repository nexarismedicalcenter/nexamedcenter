export type PharmacyLot = {
  lotNumber: string;
  expirationDate: string;
  quantityReceived: number;
  quantityAvailable: number;
  reservedQuantity?: number;
  status?: string;
  [key: string]: unknown;
};

export type PharmacyStockProduct = {
  stock?: number;
  reservedStock?: number;
  lots?: PharmacyLot[];
};

export type PharmacyLotAllocation = { lotNumber: string; quantity: number };
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HAITI_TIME_ZONE = "America/Port-au-Prince";

function validDateOnly(date: string): boolean {
  if (!DATE_ONLY_PATTERN.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function localCalendarDate(now: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: HAITI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function expirationEnd(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const date = value.trim();
  if (DATE_ONLY_PATTERN.test(date)) {
    if (!validDateOnly(date)) return null;
    const [year, month, day] = date.split("-").map(Number);
    const start = Date.UTC(year, month - 1, day);
    return start + 24 * 60 * 60 * 1000 - 1;
  }
  const timestamp = Date.parse(date);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function positiveInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 1_000_000 ? Number(value) : 0;
}

function nonnegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000 ? Number(value) : 0;
}

function lotExpired(lot: PharmacyLot, now: number): boolean {
  const expirationDate = typeof lot.expirationDate === "string" ? lot.expirationDate.trim() : "";
  if (DATE_ONLY_PATTERN.test(expirationDate)) return !validDateOnly(expirationDate) || expirationDate < localCalendarDate(now);
  const timestamp = expirationEnd(expirationDate);
  return timestamp === null || timestamp < now;
}

function lotAvailable(lot: PharmacyLot, now = Date.now()): number {
  if (String(lot.status || "ACTIVE").toUpperCase() !== "ACTIVE") return 0;
  if (lotExpired(lot, now)) return 0;
  return nonnegativeInteger(lot.quantityAvailable);
}

function normalizeAllocations(allocations: PharmacyLotAllocation[]): Map<string, number> {
  if (!Array.isArray(allocations) || allocations.length < 1 || allocations.length > 100) {
    throw new Error("invalid-lot-allocation");
  }
  const normalized = new Map<string, number>();
  for (const allocation of allocations) {
    const lotNumber = typeof allocation?.lotNumber === "string" ? allocation.lotNumber.trim() : "";
    const quantity = positiveInteger(allocation?.quantity);
    if (!lotNumber || lotNumber.length > 80 || !quantity) throw new Error("invalid-lot-allocation");
    const combined = (normalized.get(lotNumber) || 0) + quantity;
    if (!Number.isSafeInteger(combined) || combined > 1_000_000) throw new Error("invalid-lot-allocation");
    normalized.set(lotNumber, combined);
  }
  return normalized;
}

export function isLotSellable(lot: PharmacyLot, now = Date.now()): boolean {
  return lotAvailable(lot, now) > 0;
}

export function getSellableStock(product: PharmacyStockProduct, now = Date.now()): number {
  const lots = Array.isArray(product.lots) ? product.lots : [];
  return lots.reduce((total, lot) => total + lotAvailable(lot, now), 0);
}

export function getReservedStock(product: PharmacyStockProduct): number {
  const lots = Array.isArray(product.lots) ? product.lots : [];
  return lots.reduce((total, lot) => total + nonnegativeInteger(lot.reservedQuantity), 0);
}

export function getAvailableSellableStock(product: PharmacyStockProduct, now = Date.now()): number {
  const lots = Array.isArray(product.lots) ? product.lots : [];
  return lots.reduce((total, lot) => {
    const sellable = lotAvailable(lot, now);
    const reserved = nonnegativeInteger(lot.reservedQuantity);
    return total + Math.max(0, sellable - reserved);
  }, 0);
}

function lotOrder(left: PharmacyLot, right: PharmacyLot): number {
  const dateDifference = (expirationEnd(left.expirationDate) ?? Number.MAX_SAFE_INTEGER) -
    (expirationEnd(right.expirationDate) ?? Number.MAX_SAFE_INTEGER);
  return dateDifference || left.lotNumber.localeCompare(right.lotNumber);
}

export function reserveSellableLots(
  product: PharmacyStockProduct,
  quantity: number,
  now = Date.now(),
): { lots: PharmacyLot[]; allocations: PharmacyLotAllocation[]; stock: number; reservedStock: number } {
  const requested = positiveInteger(quantity);
  if (!requested || requested > 1_000_000) throw new Error("invalid-stock-quantity");
  const lots = expirePharmacyLots(product, now).lots;
  if (getAvailableSellableStock({ lots }, now) < requested) throw new Error("insufficient-sellable-stock");

  let remaining = requested;
  const allocations: PharmacyLotAllocation[] = [];
  for (const candidate of lots.filter((lot) => isLotSellable(lot, now)).sort(lotOrder)) {
    if (!remaining) break;
    const available = lotAvailable(candidate, now);
    const reserved = nonnegativeInteger(candidate.reservedQuantity);
    const reservedNow = Math.min(remaining, Math.max(0, available - reserved));
    if (!reservedNow) continue;
    candidate.reservedQuantity = reserved + reservedNow;
    allocations.push({ lotNumber: candidate.lotNumber, quantity: reservedNow });
    remaining -= reservedNow;
  }
  if (remaining) throw new Error("insufficient-sellable-stock");
  return { lots, allocations, stock: getSellableStock({ lots }, now), reservedStock: getReservedStock({ lots }) };
}

export function releaseReservedLots(
  product: PharmacyStockProduct,
  allocations: PharmacyLotAllocation[],
  now = Date.now(),
): { lots: PharmacyLot[]; stock: number; reservedStock: number } {
  const lots = expirePharmacyLots(product, now).lots;
  for (const [lotNumber, quantity] of normalizeAllocations(allocations)) {
    const lot = lots.find((candidate) => candidate.lotNumber === lotNumber);
    if (!lot || nonnegativeInteger(lot.reservedQuantity) < quantity) {
      throw new Error("lot-reservation-mismatch");
    }
    lot.reservedQuantity = nonnegativeInteger(lot.reservedQuantity) - quantity;
  }
  return { lots, stock: getSellableStock({ lots }, now), reservedStock: getReservedStock({ lots }) };
}

export function consumeReservedLots(
  product: PharmacyStockProduct,
  allocations: PharmacyLotAllocation[],
  now = Date.now(),
): { lots: PharmacyLot[]; stock: number; reservedStock: number } {
  const lots = expirePharmacyLots(product, now).lots;
  for (const [lotNumber, quantity] of normalizeAllocations(allocations)) {
    const lot = lots.find((candidate) => candidate.lotNumber === lotNumber);
    if (!lot || !isLotSellable(lot, now) || nonnegativeInteger(lot.reservedQuantity) < quantity ||
      nonnegativeInteger(lot.quantityAvailable) < quantity) {
      throw new Error("lot-reservation-not-sellable");
    }
    lot.quantityAvailable = nonnegativeInteger(lot.quantityAvailable) - quantity;
    lot.reservedQuantity = nonnegativeInteger(lot.reservedQuantity) - quantity;
    if (lot.quantityAvailable === 0) lot.status = "EXHAUSTED";
  }
  return { lots, stock: getSellableStock({ lots }, now), reservedStock: getReservedStock({ lots }) };
}

export function createPharmacyLot(input: {
  lotNumber: unknown;
  expirationDate: unknown;
  quantityReceived: unknown;
  receivedAt?: string;
}, now = Date.now()): PharmacyLot {
  const lotNumber = typeof input.lotNumber === "string" ? input.lotNumber.trim() : "";
  const expirationDate = typeof input.expirationDate === "string" ? input.expirationDate.trim() : "";
  const quantityReceived = positiveInteger(input.quantityReceived);
  if (!lotNumber || !/^[\p{L}\p{N}._/-]{1,80}$/u.test(lotNumber) || !validDateOnly(expirationDate) || expirationDate < localCalendarDate(now) || !quantityReceived) {
    throw new Error("invalid-pharmacy-lot");
  }
  return {
    lotNumber,
    expirationDate,
    quantityReceived,
    quantityAvailable: quantityReceived,
    reservedQuantity: 0,
    status: "ACTIVE",
    receivedAt: input.receivedAt || new Date(now).toISOString(),
  };
}

export function expirePharmacyLots(product: PharmacyStockProduct, now = Date.now()): {
  lots: PharmacyLot[];
  stock: number;
  reservedStock: number;
  expiredLots: number;
} {
  let expiredLots = 0;
  const lots = (Array.isArray(product.lots) ? product.lots : []).map((lot) => {
    if (String(lot.status || "ACTIVE").toUpperCase() === "ACTIVE" && lotExpired(lot, now)) {
      expiredLots += 1;
      return { ...lot, status: "EXPIRED" };
    }
    return { ...lot };
  });
  return { lots, stock: getSellableStock({ lots }, now), reservedStock: getReservedStock({ lots }), expiredLots };
}
