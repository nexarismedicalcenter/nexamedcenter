import { createHash, randomBytes, randomUUID } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

const GRANT_CODE_TTL_MS = 30 * 60_000;

function response(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "clinical-access-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les autorisations d’accès clinique ne sont pas disponibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA patient clinical access failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function iso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).toISOString();
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

function timestamp(value: unknown): number {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).getTime();
  if (value instanceof Date) return value.getTime();
  return typeof value === "number" ? value : Date.parse(String(value || ""));
}

async function requirePatient(request: Request) {
  const user = await requireFirebaseUser(request);
  await requireAppCheck(request);
  const profile = await getFirebaseAdminDb().collection("patientProfiles").doc(user.uid).get();
  if (!profile.exists || profile.get("role") !== "patient" || profile.get("profileComplete") !== true || !/^NMC-\d{7}$/.test(String(profile.get("patientNumber") || ""))) {
    throw new ApiRequestError(403, "complete-patient-profile-required", "Terminez votre profil patient avant de gérer les autorisations cliniques.");
  }
  return { user, patientNumber: String(profile.get("patientNumber")) };
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const { user } = await requirePatient(request);
    await enforceUserRateLimit({ uid: user.uid, action: "patient-clinical-access-read", limit: 30, windowMs: 5 * 60_000 });
    const snapshot = await getFirebaseAdminDb().collection("clinicalAccessGrants")
      .where("patientUid", "==", user.uid)
      .limit(50)
      .get();
    const now = Date.now();
    const grants = snapshot.docs.map((doc) => {
      const data = doc.data();
      const status = String(data.status || "ISSUED").toUpperCase();
      const expiresAtMs = timestamp(status === "CLAIMED" ? data.accessExpiresAt : data.expiresAt);
      return {
        grantId: doc.id,
        providerName: typeof data.providerName === "string" ? data.providerName.slice(0, 120) : "Médecin NEXA",
        status: status !== "REVOKED" && Number.isFinite(expiresAtMs) && expiresAtMs <= now ? "EXPIRED" : status,
        issuedAt: iso(data.issuedAt),
        expiresAt: iso(data.expiresAt),
        accessExpiresAt: iso(data.accessExpiresAt),
      };
    }).sort((left, right) => Date.parse(right.issuedAt || "") - Date.parse(left.issuedAt || ""));
    return response(request, { ok: true, grants });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const { user, patientNumber } = await requirePatient(request);
    await enforceUserRateLimit({ uid: user.uid, action: "patient-clinical-access-issue", limit: 5, windowMs: 60 * 60_000 });
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 2_048) throw new ApiRequestError(413, "request-too-large", "La demande est trop volumineuse.");
    let input: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-body");
      input = parsed as Record<string, unknown>;
    } catch { throw new ApiRequestError(400, "invalid-request", "La demande n’est pas valide."); }
    if (Object.keys(input).some((key) => key !== "providerUid")) throw new ApiRequestError(400, "invalid-request", "Seul le médecin destinataire peut être choisi.");
    const providerUid = typeof input.providerUid === "string" ? input.providerUid.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(providerUid) || providerUid === user.uid) throw new ApiRequestError(400, "invalid-provider", "Choisissez un médecin NEXA valide.");

    const code = randomBytes(24).toString("base64url");
    const codeHash = createHash("sha256").update(code).digest("hex");
    const db = getFirebaseAdminDb();
    const providerRef = db.collection("providerProfiles").doc(providerUid);
    const patientRef = db.collection("patientProfiles").doc(user.uid);
    const grantRef = db.collection("clinicalAccessGrants").doc(randomUUID());
    const codeRef = db.collection("clinicalAccessCodeIndex").doc(codeHash);
    const auditRef = db.collection("clinicalAuditLogs").doc();
    const expiresAt = Date.now() + GRANT_CODE_TTL_MS;

    let providerName = "";
    await db.runTransaction(async (transaction) => {
      const [patient, provider, priorCode] = await Promise.all([
        transaction.get(patientRef), transaction.get(providerRef), transaction.get(codeRef),
      ]);
      if (!patient.exists || patient.get("role") !== "patient" || patient.get("profileComplete") !== true || patient.get("patientNumber") !== patientNumber) {
        throw new ApiRequestError(403, "complete-patient-profile-required", "Le profil patient n’est plus complet.");
      }
      if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("publiclyListed") !== true || provider.get("clinicalCredentialsVerified") !== true) {
        throw new ApiRequestError(404, "doctor-not-available", "Ce médecin NEXA n’est pas disponible pour recevoir une autorisation.");
      }
      if (priorCode.exists) throw new ApiRequestError(503, "authorization-code-unavailable", "Le code d’autorisation n’a pas pu être préparé.");
      const profile = provider.get("profile") && typeof provider.get("profile") === "object" ? provider.get("profile") as Record<string, unknown> : {};
      providerName = typeof profile.name === "string" ? profile.name.slice(0, 120) : "Médecin NEXA";
      transaction.create(grantRef, {
        patientUid: user.uid,
        patientNumber,
        providerUid,
        providerName,
        status: "ISSUED",
        accessCodeHash: codeHash,
        issuedAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(expiresAt),
      });
      transaction.create(codeRef, { grantId: grantRef.id, providerUid, status: "ISSUED", expiresAt: Timestamp.fromMillis(expiresAt), createdAt: FieldValue.serverTimestamp() });
      transaction.create(auditRef, { actorUid: user.uid, action: "patient_clinical_access_grant_issued", resource: `clinicalAccessGrants/${grantRef.id}`, createdAt: FieldValue.serverTimestamp() });
    });

    return response(request, { ok: true, grantId: grantRef.id, providerName, accessCode: code, expiresAt: new Date(expiresAt).toISOString() }, 201);
  } catch (error) { return fail(request, error); }
}

export async function DELETE(request: Request) {
  try {
    const { user } = await requirePatient(request);
    await enforceUserRateLimit({ uid: user.uid, action: "patient-clinical-access-revoke", limit: 10, windowMs: 5 * 60_000 });
    const body = await request.json().catch(() => null);
    const grantId = body && typeof body === "object" && !Array.isArray(body) && typeof body.grantId === "string" ? body.grantId.trim() : "";
    if (!/^[0-9a-f-]{36}$/i.test(grantId)) throw new ApiRequestError(400, "invalid-grant", "L’autorisation clinique n’est pas valide.");

    const db = getFirebaseAdminDb();
    const grantRef = db.collection("clinicalAccessGrants").doc(grantId);
    const auditRef = db.collection("clinicalAuditLogs").doc();
    let alreadyRevoked = false;
    await db.runTransaction(async (transaction) => {
      const grant = await transaction.get(grantRef);
      if (!grant.exists || grant.get("patientUid") !== user.uid) throw new ApiRequestError(404, "grant-not-found", "Cette autorisation clinique n’est pas disponible.");
      if (grant.get("status") === "REVOKED") { alreadyRevoked = true; return; }
      const recordId = typeof grant.get("claimedRecordId") === "string" ? grant.get("claimedRecordId") as string : "";
      const codeHash = typeof grant.get("accessCodeHash") === "string" ? grant.get("accessCodeHash") as string : "";
      const recordRef = recordId ? db.collection("electronicPatientRecords").doc(recordId) : null;
      const codeRef = /^[a-f0-9]{64}$/.test(codeHash) ? db.collection("clinicalAccessCodeIndex").doc(codeHash) : null;
      const [record, code] = await Promise.all([
        recordRef ? transaction.get(recordRef) : Promise.resolve(null),
        codeRef ? transaction.get(codeRef) : Promise.resolve(null),
      ]);
      transaction.set(grantRef, { status: "REVOKED", revokedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      if (recordRef && record?.exists && record.get("accessGrantId") === grantId && record.get("patientUid") === user.uid) {
        transaction.set(recordRef, { accessRevoked: true, accessRevokedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      }
      if (codeRef && code?.exists) transaction.set(codeRef, { status: "REVOKED", revokedAt: FieldValue.serverTimestamp() }, { merge: true });
      transaction.create(auditRef, { actorUid: user.uid, action: "patient_clinical_access_grant_revoked", resource: `clinicalAccessGrants/${grantId}`, createdAt: FieldValue.serverTimestamp() });
    });
    return response(request, { ok: true, grantId, status: "REVOKED", alreadyRevoked });
  } catch (error) { return fail(request, error); }
}
