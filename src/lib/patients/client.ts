"use client";

import { getToken } from "firebase/app-check";
import type { User } from "firebase/auth";
import { getFirebaseAppCheck } from "@/lib/firebase/client";

export type PatientRegistrationInput = {
  firstName: string;
  lastName: string;
  birthDate: string;
  phone: string;
  sex: string;
  addressLine: string;
  country: string;
  department: string;
  commune: string;
  emailMarketingConsent: boolean;
  termsAccepted: boolean;
};

type EnsurePatientResponse = {
  ok: true;
  patientNumber: string;
  created: boolean;
  profileComplete: boolean;
};

export class PatientApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "PatientApiError";
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export async function initializePatientProfile(
  user: User,
  registration?: PatientRegistrationInput,
): Promise<EnsurePatientResponse> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const headers = new Headers({
        Authorization: `Bearer ${await user.getIdToken()}`,
        "Content-Type": "application/json",
      });

      const appCheck = getFirebaseAppCheck();
      if (process.env.NODE_ENV === "production" && !appCheck) {
        throw new PatientApiError(
          "app-check-configuration-required",
          "La protection de sécurité de NEXA n’est pas configurée.",
          503,
        );
      }
      if (appCheck) {
        const token = await getToken(appCheck);
        headers.set("X-Firebase-AppCheck", token.token);
      }

      const response = await fetch("/api/patient-profile/initialize", {
        method: "POST",
        headers,
        body: JSON.stringify(registration || {}),
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => null)) as
        | (EnsurePatientResponse & { code?: string; error?: string })
        | null;

      if (response.ok && payload?.ok) {
        if (!/^NMC-\d{7}$/.test(payload.patientNumber)) {
          throw new PatientApiError(
            "invalid-patient-number-response",
            "Le numéro patient n’a pas pu être confirmé. Réessayez dans un instant.",
            502,
          );
        }
        return payload;
      }

      const error = new PatientApiError(
        payload?.code || "patient-profile-request-failed",
        payload?.error || "La création du profil patient a échoué.",
        response.status,
      );
      if (response.status < 500 && response.status !== 429) throw error;
      if (attempt === 2) throw error;
    } catch (error) {
      if (error instanceof PatientApiError && error.status < 500 && error.status !== 429) {
        throw error;
      }
      if (attempt === 2) {
        if (error instanceof PatientApiError) throw error;
        throw new PatientApiError(
          "patient-profile-network-error",
          "Le compte est ouvert, mais la confirmation du numéro patient n’a pas abouti. Réessayez : le numéro ne sera pas attribué en double.",
          503,
        );
      }
    }

    await wait(250 * 2 ** attempt);
  }

  throw new PatientApiError(
    "patient-profile-request-failed",
    "La création du profil patient a échoué.",
    503,
  );
}
