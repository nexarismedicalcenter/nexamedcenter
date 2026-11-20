export const LAB_SUPPORT_CATEGORIES = [
  "commande",
  "examen",
  "resultat",
  "paiement",
  "remboursement",
  "decaissement",
  "compte",
  "technique",
] as const;

export type LabSupportCategory = (typeof LAB_SUPPORT_CATEGORIES)[number];
export type LabSupportStatus = "OPEN" | "IN_PROGRESS" | "RESOLVED" | "CLOSED";

export type LabSupportMessage = {
  id: string;
  authorRole: "admin";
  message: string;
  createdAt: string | null;
};

export type LabSupportTicket = {
  id: string;
  requesterUid: string;
  category: LabSupportCategory;
  subject: string;
  description: string;
  status: LabSupportStatus;
  messageCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  lastReplyAt: string | null;
  messages?: LabSupportMessage[];
};

export function cleanLabSupportText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

export function isLabSupportStatus(value: unknown): value is LabSupportStatus {
  return value === "OPEN" || value === "IN_PROGRESS" || value === "RESOLVED" || value === "CLOSED";
}
