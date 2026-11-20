import { timingSafeEqual } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { getFirebaseAdminDb, getFirebaseAdminStorage } from "@/lib/firebase/admin";

const EXPIRABLE_SESSION_STATES = ["OPEN", "CANCELLED", "FAILED", "REJECTED", "SUBMITTED", "SCANNING"];

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET || "";
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!secret || token.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(secret));
}

function millis(value: unknown) {
  return value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function" ? Number(value.toMillis()) : 0;
}

function validObjectPath(path: unknown, prefix: string, appointmentId: string, objectId: string) {
  return /^[A-Za-z0-9_-]{10,200}$/.test(appointmentId) && /^[A-Za-z0-9_-]{10,80}$/.test(objectId) && path === `${prefix}/${appointmentId}/${objectId}`;
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ ok: false, error: "Nettoyage des pièces jointes non configuré." }, { status: 503 });
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "Accès refusé." }, { status: 401 });
  try {
    const db = getFirebaseAdminDb();
    const bucket = getFirebaseAdminStorage().bucket();
    const due = Timestamp.now();
    const sessions = await db.collection("clinicalRecordUploadSessions").where("cleanupAfterAt", "<=", due).orderBy("cleanupAfterAt", "asc").limit(50).get();
    let cleanedSessions = 0;
    let deletedObjects = 0;
    let failed = 0;

    for (const candidate of sessions.docs) {
      const claim = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(candidate.ref);
        if (!snapshot.exists || millis(snapshot.get("cleanupAfterAt")) > Date.now()) return null;
        const status = String(snapshot.get("status") || "");
        if (!EXPIRABLE_SESSION_STATES.includes(status)) return null;
        if (status === "SCANNING" && millis(snapshot.get("scanningStartedAt")) > Date.now() - 10 * 60_000) return null;
        const appointmentId = String(snapshot.get("appointmentId") || "");
        const objectId = candidate.id;
        const path = snapshot.get("storagePath");
        if (!validObjectPath(path, "nexa-clinical-record-quarantine", appointmentId, objectId)) return { invalid: true as const };
        transaction.update(candidate.ref, { status: "CLEANING", cleanupStartedAt: FieldValue.serverTimestamp() });
        return { invalid: false as const, path, status };
      });
      if (!claim) continue;
      if (claim.invalid) { failed += 1; continue; }
      try {
        await bucket.file(claim.path).delete({ ignoreNotFound: true });
        await candidate.ref.set({ status: "EXPIRED", closedAt: FieldValue.serverTimestamp(), cleanupAfterAt: FieldValue.delete() }, { merge: true });
        cleanedSessions += 1;
        deletedObjects += 1;
      } catch {
        await candidate.ref.set({ status: claim.status, cleanupAfterAt: Timestamp.fromMillis(Date.now() + 5 * 60_000) }, { merge: true });
        failed += 1;
      }
    }

    const deletions = await db.collection("clinicalRecordAttachmentDeletionQueue").where("cleanupAfterAt", "<=", Timestamp.now()).orderBy("cleanupAfterAt", "asc").limit(50).get();
    for (const candidate of deletions.docs) {
      const claim = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(candidate.ref);
        if (!snapshot.exists || !["PENDING", "DELETING"].includes(String(snapshot.get("status") || "")) || millis(snapshot.get("cleanupAfterAt")) > Date.now()) return null;
        const appointmentId = String(snapshot.get("appointmentId") || "");
        const attachmentId = String(snapshot.get("attachmentId") || "");
        const path = snapshot.get("storagePath");
        if (!validObjectPath(path, "nexa-clinical-records", appointmentId, attachmentId)) return { invalid: true as const };
        transaction.update(candidate.ref, { status: "DELETING", cleanupStartedAt: FieldValue.serverTimestamp() });
        return { invalid: false as const, path };
      });
      if (!claim) continue;
      if (claim.invalid) { failed += 1; continue; }
      try {
        await bucket.file(claim.path).delete({ ignoreNotFound: true });
        await candidate.ref.set({ status: "DONE", completedAt: FieldValue.serverTimestamp(), cleanupAfterAt: FieldValue.delete() }, { merge: true });
        deletedObjects += 1;
      } catch {
        await candidate.ref.set({ status: "PENDING", cleanupAfterAt: Timestamp.fromMillis(Date.now() + 5 * 60_000) }, { merge: true });
        failed += 1;
      }
    }

    return NextResponse.json({ ok: true, cleanedSessions, deletedObjects, failed }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    console.error("NEXA clinical attachment cleanup failed", error instanceof Error ? error.name : "unknown-error");
    return NextResponse.json({ ok: false, error: "Le nettoyage des pièces jointes n’a pas abouti." }, { status: 500, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
