import { timingSafeEqual } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { getFirebaseAdminDb, getFirebaseAdminStorage } from "@/lib/firebase/admin";

const EXPIRABLE_STATES = ["OPEN", "FAILED", "REJECTED", "SCANNING", "CLEANING"];

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET || "";
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!secret || token.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(secret));
}

function millis(value: unknown) {
  if (!value || typeof value !== "object" || !("toMillis" in value) || typeof value.toMillis !== "function") return 0;
  const result = Number(value.toMillis());
  return Number.isFinite(result) ? result : 0;
}

function validPath(path: unknown, prefix: string, providerUid: string, objectId: string) {
  return /^[A-Za-z0-9_-]{10,128}$/.test(providerUid) && /^[A-Za-z0-9_-]{10,80}$/.test(objectId) && path === `${prefix}/${providerUid}/${objectId}`;
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ ok: false, error: "Nettoyage des justificatifs non configuré." }, { status: 503 });
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "Accès refusé." }, { status: 401 });
  try {
    const db = getFirebaseAdminDb();
    const bucket = getFirebaseAdminStorage().bucket();
    const due = await db.collection("diagnosticPartnerContractUploadSessions")
      .where("cleanupAfterAt", "<=", Timestamp.now())
      .orderBy("cleanupAfterAt", "asc")
      .limit(50)
      .get();
    let cleanedSessions = 0;
    let deletedObjects = 0;
    let failed = 0;

    for (const candidate of due.docs) {
      const claim = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(candidate.ref);
        if (!snapshot.exists || millis(snapshot.get("cleanupAfterAt")) > Date.now()) return null;
        const status = String(snapshot.get("status") || "");
        if (!EXPIRABLE_STATES.includes(status)) return null;
        if (["SCANNING", "CLEANING"].includes(status) && millis(snapshot.get(status === "SCANNING" ? "scanningStartedAt" : "cleanupStartedAt")) > Date.now() - 10 * 60_000) return null;

        const providerUid = String(snapshot.get("providerUid") || "");
        const sessionPath = snapshot.get("storagePath");
        const documentId = String(snapshot.get("finalDocumentId") || snapshot.get("documentId") || "");
        const finalPath = snapshot.get("finalStoragePath");
        if (!validPath(sessionPath, "nexa-diagnostic-partner-contract-quarantine", providerUid, candidate.id)) return { invalid: true as const };
        if (finalPath !== undefined && (!documentId || !validPath(finalPath, "nexa-diagnostic-partner-contracts", providerUid, documentId))) return { invalid: true as const };
        transaction.update(candidate.ref, { status: "CLEANING", cleanupStartedAt: FieldValue.serverTimestamp() });
        return { invalid: false as const, sessionPath, finalPath: typeof finalPath === "string" ? finalPath : null, status };
      });
      if (!claim) continue;
      if (claim.invalid) { failed += 1; continue; }
      try {
        const paths = [claim.sessionPath, claim.finalPath].filter((path): path is string => Boolean(path));
        await Promise.all(paths.map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
        await candidate.ref.set({ status: "EXPIRED", closedAt: FieldValue.serverTimestamp(), cleanupAfterAt: FieldValue.delete(), finalStoragePath: FieldValue.delete(), finalDocumentId: FieldValue.delete() }, { merge: true });
        cleanedSessions += 1;
        deletedObjects += paths.length;
      } catch {
        await candidate.ref.set({ status: claim.status, cleanupAfterAt: Timestamp.fromMillis(Date.now() + 5 * 60_000) }, { merge: true });
        failed += 1;
      }
    }

    return NextResponse.json({ ok: true, cleanedSessions, deletedObjects, failed }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    console.error("NEXA partner contract cleanup failed", error instanceof Error ? error.name : "unknown-error");
    return NextResponse.json({ ok: false, error: "Le nettoyage des justificatifs n’a pas abouti." }, { status: 500, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
