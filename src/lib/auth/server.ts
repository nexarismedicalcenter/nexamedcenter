import "server-only";

import { getAppCheck } from "firebase-admin/app-check";
import type { DecodedIdToken } from "firebase-admin/auth";
import { getFirebaseAdminApp, getFirebaseAdminAuth } from "@/lib/firebase/admin";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "ApiRequestError";
  }
}

export async function requireFirebaseUser(request: Request): Promise<DecodedIdToken> {
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new ApiRequestError(401, "authentication-required", "Connexion requise.");
  }

  try {
    return await getFirebaseAdminAuth().verifyIdToken(match[1], true);
  } catch {
    throw new ApiRequestError(401, "invalid-session", "La session a expiré. Reconnectez-vous.");
  }
}

export async function requireAppCheck(request: Request): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;

  const appCheckToken = request.headers.get("x-firebase-appcheck");
  if (!appCheckToken) {
    throw new ApiRequestError(403, "app-check-required", "Vérification de sécurité requise.");
  }

  try {
    await getAppCheck(getFirebaseAdminApp()).verifyToken(appCheckToken);
  } catch {
    throw new ApiRequestError(403, "invalid-app-check", "Vérification de sécurité invalide.");
  }
}

export async function requireNexaAdministrator(request: Request): Promise<DecodedIdToken> {
  const user = await requireFirebaseUser(request);
  await requireAppCheck(request);

  const configuredAdmins = new Set(
    (process.env.NEXA_ADMIN_UIDS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (configuredAdmins.size === 0) {
    throw new ApiRequestError(503, "admin-access-not-configured", "L’accès administrateur n’est pas configuré.");
  }
  if (!configuredAdmins.has(user.uid)) {
    throw new ApiRequestError(403, "administrator-required", "Accès administrateur requis.");
  }
  return user;
}

export function corsHeaders(request: Request): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, X-Firebase-AppCheck",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  });
  const origin = request.headers.get("origin");
  if (!origin) return headers;

  const allowedOrigins = new Set(
    (process.env.NEXA_ALLOWED_ORIGINS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  try {
    allowedOrigins.add(new URL(request.url).origin);
  } catch {
    // A malformed request URL is rejected by the route handler.
  }
  if (process.env.NODE_ENV !== "production") {
    allowedOrigins.add("http://localhost:3000");
    allowedOrigins.add("http://localhost:3001");
  }

  if (!allowedOrigins.has(origin)) {
    throw new ApiRequestError(403, "origin-not-allowed", "Origine non autorisée.");
  }

  headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}
