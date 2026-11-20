"use client";

import { getToken } from "firebase/app-check";
import type { User } from "firebase/auth";
import { getFirebaseAppCheck } from "@/lib/firebase/client";

export async function appointmentRequest<T>(user: User, path: string, method = "GET", body?: unknown): Promise<T> {
  const headers = new Headers({ Authorization: `Bearer ${await user.getIdToken()}` });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const appCheck = getFirebaseAppCheck();
  if (process.env.NODE_ENV === "production" && !appCheck) throw new Error("La protection App Check de NEXA n’est pas configurée.");
  if (appCheck) headers.set("X-Firebase-AppCheck", (await getToken(appCheck)).token);
  const response = await fetch(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null) as ({ ok?: boolean; error?: string } & T) | null;
  if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || "La demande n’a pas abouti.");
  return payload;
}
