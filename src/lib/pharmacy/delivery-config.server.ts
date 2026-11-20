import "server-only";

export function isPharmacyDeliveryEnabled(): boolean {
  return process.env.NEXA_PHARMACY_DELIVERY_ENABLED === "true";
}
