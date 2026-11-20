"use client";

import { getToken } from "firebase/app-check";
import type { User } from "firebase/auth";
import { getFirebaseAppCheck } from "@/lib/firebase/client";

export type ProfessionalApplicationInput = {
  providerType: string;
  name: string;
  specialty: string;
  nursingQualifications?: string[];
  indicativeFee?: number;
  phone: string;
  department: string;
  commune: string;
  publicBio: string;
  termsAccepted: boolean;
};

export const NURSING_QUALIFICATIONS = [
  { id: "general_nursing", label: "Infirmier·ère généraliste" },
  { id: "intensive_care", label: "Soins intensifs" },
  { id: "geriatrics", label: "Gériatrie" },
  { id: "pediatrics", label: "Pédiatrie" },
  { id: "palliative_care", label: "Soins palliatifs" },
  { id: "community_health", label: "Santé communautaire" },
  { id: "anesthesia", label: "Anesthésie" },
  { id: "instrumentation", label: "Instrumentation" },
] as const;

export async function submitProfessionalApplication(user: User, input: ProfessionalApplicationInput) {
  const headers = new Headers({ Authorization: `Bearer ${await user.getIdToken()}`, "Content-Type": "application/json" });
  const appCheck = getFirebaseAppCheck();
  if (process.env.NODE_ENV === "production" && !appCheck) throw new Error("La protection App Check de NEXA n’est pas configurée.");
  if (appCheck) headers.set("X-Firebase-AppCheck", (await getToken(appCheck)).token);
  const response = await fetch("/api/professional-applications", { method: "POST", headers, body: JSON.stringify(input), cache: "no-store" });
  const payload = await response.json() as { ok?: boolean; alreadySubmitted?: boolean; error?: string };
  if (!response.ok || !payload.ok) throw new Error(payload.error || "La pré-demande n’a pas abouti.");
  return { alreadySubmitted: Boolean(payload.alreadySubmitted) };
}
