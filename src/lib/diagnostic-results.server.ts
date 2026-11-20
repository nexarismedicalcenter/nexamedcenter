import "server-only";

import { GoogleAuth } from "google-auth-library";
import { ApiRequestError } from "@/lib/auth/server";

export const RESULT_MAX_FILE_BYTES = 15 * 1024 * 1024;
export const RESULT_MAX_FILES = 20;
export const RESULT_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
export const SESSION_MEDIA_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg",
]);

export type DiagnosticProviderType = "laboratory" | "imaging";
export type DiagnosticResultRequirements = {
  requiredCategories: string[];
  allowSupplemental: boolean;
  allowMultiplePerCategory: boolean;
  maxFiles: number;
  maxFileBytes: number;
  allowedMimeTypes: string[];
};
export type DiagnosticResultFileInput = {
  category: string;
  fileName: string;
  contentType: string;
  size: number;
};

const allowedCategories: Record<DiagnosticProviderType, Set<string>> = {
  laboratory: new Set(["LAB_RESULT", "SUPPLEMENTAL"]),
  imaging: new Set(["IMAGING", "RADIOLOGY_REPORT", "SUPPLEMENTAL"]),
};

export function normalizeDiagnosticResultRequirements(
  value: unknown,
  providerType: DiagnosticProviderType,
  errorStatus: 400 | 409 = 400,
): DiagnosticResultRequirements {
  const defaults: DiagnosticResultRequirements = {
    requiredCategories: [providerType === "laboratory" ? "LAB_RESULT" : "IMAGING"],
    allowSupplemental: true,
    allowMultiplePerCategory: true,
    maxFiles: RESULT_MAX_FILES,
    maxFileBytes: RESULT_MAX_FILE_BYTES,
    allowedMimeTypes: [...RESULT_MIME_TYPES],
  };
  if (value === undefined || value === null) return defaults;
  const invalid = () => new ApiRequestError(errorStatus, "invalid-result-requirements", "Les exigences de fichiers configurées pour cet examen ne sont pas valides.");
  if (typeof value !== "object" || Array.isArray(value)) throw invalid();

  const input = value as Record<string, unknown>;
  const categories = [...new Set(Array.isArray(input.requiredCategories)
    ? input.requiredCategories.map((item) => cleanResultText(item, 40).toUpperCase())
    : [])];
  const allowedTypes = allowedCategories[providerType];
  const allowedMimeTypes = [...new Set(Array.isArray(input.allowedMimeTypes)
    ? input.allowedMimeTypes.map((item) => cleanResultText(item, 100).toLowerCase())
    : [])];
  const maxFiles = Number(input.maxFiles);
  const maxFileBytes = Number(input.maxFileBytes);
  const hasPrimaryCategory = providerType === "laboratory"
    ? categories.includes("LAB_RESULT")
    : categories.some((category) => category === "IMAGING" || category === "RADIOLOGY_REPORT");

  if (
    !categories.length || categories.some((category) => !allowedTypes.has(category)) || !hasPrimaryCategory ||
    typeof input.allowSupplemental !== "boolean" || typeof input.allowMultiplePerCategory !== "boolean" ||
    (!input.allowSupplemental && categories.includes("SUPPLEMENTAL")) ||
    !allowedMimeTypes.length || allowedMimeTypes.some((mime) => !RESULT_MIME_TYPES.has(mime)) ||
    !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > RESULT_MAX_FILES ||
    !Number.isInteger(maxFileBytes) || maxFileBytes < 1024 * 1024 || maxFileBytes > RESULT_MAX_FILE_BYTES
  ) throw invalid();

  return {
    requiredCategories: categories,
    allowSupplemental: input.allowSupplemental,
    allowMultiplePerCategory: input.allowMultiplePerCategory,
    maxFiles,
    maxFileBytes,
    allowedMimeTypes,
  };
}

export function cleanResultText(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

export function validateResultFiles(
  value: unknown,
  providerType: DiagnosticProviderType,
  configuredRequirements?: unknown,
): DiagnosticResultFileInput[] {
  const requirements = normalizeDiagnosticResultRequirements(configuredRequirements, providerType, 409);
  if (!Array.isArray(value) || value.length < 1 || value.length > requirements.maxFiles) {
    throw new ApiRequestError(400, "invalid-result-file-count", `Sélectionnez entre 1 et ${requirements.maxFiles} fichiers.`);
  }
  const files: DiagnosticResultFileInput[] = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ApiRequestError(400, "invalid-result-file", "Un fichier sélectionné n’est pas valide.");
    const input = entry as Record<string, unknown>;
    const category = cleanResultText(input.category, 40).toUpperCase();
    const fileName = cleanResultText(input.fileName, 180).replace(/[\\/\r\n]/g, "_") || "resultat";
    const contentType = cleanResultText(input.contentType, 100).toLowerCase();
    const size = input.size;
    if (!allowedCategories[providerType].has(category) || (category === "SUPPLEMENTAL" && !requirements.allowSupplemental)) throw new ApiRequestError(400, "invalid-result-file-category", "La catégorie d’un fichier n’est pas autorisée pour cet examen.");
    if (!requirements.allowedMimeTypes.includes(contentType)) throw new ApiRequestError(400, "invalid-result-file-type", "Le format du fichier n’est pas autorisé pour cet examen.");
    if (!Number.isSafeInteger(size) || Number(size) < 1 || Number(size) > requirements.maxFileBytes) throw new ApiRequestError(400, "invalid-result-file-size", "Un fichier dépasse la taille maximale configurée pour cet examen.");
    return { category, fileName, contentType, size: Number(size) };
  });
  const categoryCounts = new Map<string, number>();
  for (const file of files) {
    const count = (categoryCounts.get(file.category) || 0) + 1;
    if (!requirements.allowMultiplePerCategory && count > 1) throw new ApiRequestError(400, "multiple-result-files-not-allowed", "Un seul fichier par catégorie est autorisé pour cet examen.");
    categoryCounts.set(file.category, count);
  }
  const missingCategory = requirements.requiredCategories.find((category) => !categoryCounts.has(category));
  if (missingCategory) throw new ApiRequestError(400, "required-result-file-missing", `Ajoutez au moins un fichier dans la catégorie obligatoire : ${missingCategory}.`);
  return files;
}

function parseServiceAccount(raw: string) {
  let credentials: { project_id?: string; client_email?: string; private_key?: string };
  try {
    credentials = JSON.parse(raw) as typeof credentials;
  } catch {
    throw new ApiRequestError(503, "scanner-identity-not-configured", "L’analyse de sécurité n’est pas configurée. Aucun résultat ne peut être transmis.");
  }
  if (credentials.project_id !== "nexaris-1339d" || !credentials.client_email || !credentials.private_key) {
    throw new ApiRequestError(503, "scanner-identity-not-configured", "L’analyse de sécurité n’est pas configurée. Aucun résultat ne peut être transmis.");
  }
  return credentials;
}

async function scanFile(input: {
  fileBuffer: Buffer;
  contentType: string;
}, allowedTypes: Set<string>): Promise<{ scannerVersion: string | null; durationSeconds?: number }> {
  const scannerUrl = process.env.NEXA_MALWARE_SCANNER_URL || "";
  const audience = process.env.NEXA_MALWARE_SCANNER_AUDIENCE || "";
  let target: URL;
  try {
    target = new URL(scannerUrl);
  } catch {
    throw new ApiRequestError(503, "malware-scanner-unavailable", "L’analyse de sécurité est temporairement indisponible. Réessayez plus tard.");
  }
  const localScanner = process.env.NODE_ENV !== "production" && target.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  if ((target.protocol !== "https:" && !localScanner) || target.username || target.password || target.search || target.hash || !["", "/"].includes(target.pathname)) {
    throw new ApiRequestError(503, "malware-scanner-unavailable", "L’analyse de sécurité est temporairement indisponible. Réessayez plus tard.");
  }
  if (!Buffer.isBuffer(input.fileBuffer) || input.fileBuffer.length < 1 || input.fileBuffer.length > RESULT_MAX_FILE_BYTES || !allowedTypes.has(input.contentType)) {
    throw new ApiRequestError(400, "invalid-result-file", "Le fichier ne respecte pas les limites de sécurité NEXA.");
  }

  let token = "";
  if (!localScanner) {
    let parsedAudience: URL | null = null;
    try { parsedAudience = new URL(audience); } catch { /* invalid audience remains unavailable */ }
    if (!parsedAudience || parsedAudience.origin !== target.origin || !["", "/"].includes(parsedAudience.pathname) || parsedAudience.search || parsedAudience.hash || parsedAudience.username || parsedAudience.password) {
      throw new ApiRequestError(503, "scanner-audience-not-configured", "L’identité de l’analyse de sécurité n’est pas configurée.");
    }
    const credentials = parseServiceAccount(process.env.NEXA_SCANNER_CALLER_SERVICE_ACCOUNT_JSON || "");
    try {
      const auth = new GoogleAuth({ projectId: credentials.project_id, credentials: { type: "service_account", ...credentials } });
      const client = await auth.getIdTokenClient(audience);
      token = await client.idTokenProvider.fetchIdToken(audience);
    } catch {
      throw new ApiRequestError(503, "scanner-identity-unavailable", "L’identité de l’analyse de sécurité est temporairement indisponible.");
    }
    if (!token) throw new ApiRequestError(503, "scanner-identity-unavailable", "L’identité de l’analyse de sécurité est temporairement indisponible.");
  }

  let response: Response;
  try {
    response = await fetch(new URL("/scan", target.origin), {
      method: "POST",
      headers: { "Content-Type": input.contentType, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: new Blob([new Uint8Array(input.fileBuffer)], { type: input.contentType }),
      signal: AbortSignal.timeout(40_000),
      cache: "no-store",
    });
  } catch {
    throw new ApiRequestError(503, "malware-scanner-unavailable", "L’analyse de sécurité est temporairement indisponible. Aucun résultat n’a été transmis.");
  }
  const result = await response.json().catch(() => ({})) as { status?: unknown; scannerVersion?: unknown; durationSeconds?: unknown };
  if (!response.ok) {
    if (response.status === 415 || response.status === 413) throw new ApiRequestError(400, "invalid-result-file", "Le fichier ne correspond pas à son type ou dépasse la taille permise.");
    throw new ApiRequestError(503, "malware-scanner-unavailable", "L’analyse de sécurité est temporairement indisponible. Aucun résultat n’a été transmis.");
  }
  if (result.status === "INFECTED") throw new ApiRequestError(422, "malware-detected", "Un fichier a été bloqué par l’analyse antivirus. Vérifiez-le puis recommencez le dépôt.");
  if (result.status !== "CLEAN") throw new ApiRequestError(503, "malware-scanner-invalid-response", "L’analyse de sécurité n’a pas confirmé que le fichier est propre.");
  return {
    scannerVersion: typeof result.scannerVersion === "string" ? result.scannerVersion.slice(0, 80) : null,
    ...(Number.isSafeInteger(result.durationSeconds) ? { durationSeconds: Number(result.durationSeconds) } : {}),
  };
}

export async function scanDiagnosticResultFile(input: { fileBuffer: Buffer; contentType: string }): Promise<{ scannerVersion: string | null }> {
  const result = await scanFile(input, RESULT_MIME_TYPES);
  return { scannerVersion: result.scannerVersion };
}

export async function scanSessionMediaFile(input: {
  fileBuffer: Buffer;
  contentType: string;
  expectedDurationSeconds?: number;
  maximumDurationSeconds?: number;
}): Promise<{ scannerVersion: string | null; durationSeconds?: number }> {
  const result = await scanFile(input, SESSION_MEDIA_MIME_TYPES);
  if (input.contentType.startsWith("audio/")) {
    if (!Number.isSafeInteger(result.durationSeconds) || Number(result.durationSeconds) < 1) {
      throw new ApiRequestError(503, "session-media-duration-unavailable", "La durée du message vocal n’a pas pu être vérifiée.");
    }
    if (input.expectedDurationSeconds && Math.abs(Number(result.durationSeconds) - input.expectedDurationSeconds) > 1) {
      throw new ApiRequestError(400, "session-media-duration-mismatch", "La durée du message vocal ne correspond pas à l’enregistrement.");
    }
    if (input.maximumDurationSeconds && Number(result.durationSeconds) > input.maximumDurationSeconds) {
      throw new ApiRequestError(400, "session-media-duration-too-long", `Le message vocal dépasse la durée autorisée de ${input.maximumDurationSeconds} secondes.`);
    }
  }
  return result;
}
