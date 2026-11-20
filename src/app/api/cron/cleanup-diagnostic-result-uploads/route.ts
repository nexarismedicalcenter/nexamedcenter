import { timingSafeEqual } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { getFirebaseAdminDb, getFirebaseAdminStorage } from "@/lib/firebase/admin";

const CLEANUP_STATES = ["OPEN", "SCANNING", "CLEANING", "CANCELLING", "CANCELLED", "SUBMITTED", "SCAN_FAILED", "REJECTED", "FAILED"];

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET || "";
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!secret || token.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(secret));
}

function timestampMillis(value: unknown) {
  return value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function" ? Number(value.toMillis()) : 0;
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ ok: false, error: "Nettoyage des téléversements non configuré." }, { status: 503 });
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "Accès refusé." }, { status: 401 });
  try {
    const db = getFirebaseAdminDb();
    const bucket = getFirebaseAdminStorage().bucket();
    const expired = await db.collection("diagnosticResultUploadSessions").where("status", "in", CLEANUP_STATES).where("expiresAt", "<=", Timestamp.now()).orderBy("expiresAt", "asc").limit(50).get();
    let expiredSessions = 0;
    let deletedObjects = 0;
    let failedSessions = 0;

    for (const candidate of expired.docs) {
      const initial = candidate.data();
      const claimId = typeof initial.claimId === "string" ? initial.claimId : "";
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(claimId)) { failedSessions += 1; continue; }
      const claimRef = db.collection("diagnosticResultClaims").doc(claimId);
      const cleanup = await db.runTransaction(async (transaction) => {
        const [session, claim] = await Promise.all([transaction.get(candidate.ref), transaction.get(claimRef)]);
        const status = String(session.get("status") || "");
        if (!session.exists || !CLEANUP_STATES.includes(status) || timestampMillis(session.get("expiresAt")) > Date.now()) return null;
        if (status !== "CLEANING") transaction.update(candidate.ref, { status: "CLEANING", cleanupStartedAt: FieldValue.serverTimestamp(), expiresAt: Timestamp.now() });
        if (claim.exists && claim.get("sessionId") === candidate.id && claim.get("status") !== "CLEANING") transaction.update(claimRef, { status: "CLEANING", updatedAt: FieldValue.serverTimestamp() });
        const files = Array.isArray(session.get("files")) ? session.get("files") as Record<string, unknown>[] : [];
        const paths = files.map((file) => {
          const id = typeof file.id === "string" ? file.id : "";
          const path = typeof file.storagePath === "string" ? file.storagePath : "";
          return /^[A-Za-z0-9_-]{10,80}$/.test(id) && path === `nexa-result-quarantine/${candidate.id}/${id}` ? path : "";
        });
        return { paths, orderId: session.get("orderId"), examLineId: session.get("examLineId"), wasSubmitted: status === "SUBMITTED" };
      });
      if (!cleanup) continue;
      if (!cleanup.paths.length || cleanup.paths.some((path) => !path)) { failedSessions += 1; continue; }

      const deletes = await Promise.allSettled(cleanup.paths.map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
      if (deletes.some((result) => result.status === "rejected")) { failedSessions += 1; continue; }
      const finalized = await db.runTransaction(async (transaction) => {
        const [session, claim] = await Promise.all([transaction.get(candidate.ref), transaction.get(claimRef)]);
        if (!session.exists || session.get("status") !== "CLEANING") return false;
        transaction.update(candidate.ref, { status: "EXPIRED", closedAt: FieldValue.serverTimestamp() });
        if (claim.exists && claim.get("sessionId") === candidate.id) transaction.update(claimRef, {
          status: claim.get("currentResultId") ? "SUBMITTED" : "AVAILABLE",
          sessionId: FieldValue.delete(),
          expiresAt: FieldValue.delete(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.create(db.collection("diagnosticResultAuditLogs").doc(), { actorUid: "system:cron", action: cleanup.wasSubmitted ? "diagnostic_result_quarantine_cleaned" : "diagnostic_result_upload_expired", orderId: cleanup.orderId, examLineId: cleanup.examLineId, fileCount: cleanup.paths.length, createdAt: FieldValue.serverTimestamp() });
        return true;
      });
      if (finalized) { expiredSessions += 1; deletedObjects += cleanup.paths.length; }
    }
    const patientExpired = await db.collection("patientResultUploadSessions").where("status", "in", CLEANUP_STATES).where("expiresAt", "<=", Timestamp.now()).orderBy("expiresAt", "asc").limit(50).get();
    for (const candidate of patientExpired.docs) {
      const claimId = typeof candidate.get("claimId") === "string" ? String(candidate.get("claimId")) : "";
      if (!/^[a-f0-9]{64}$/.test(claimId)) { failedSessions += 1; continue; }
      const claimRef = db.collection("patientResultClaims").doc(claimId);
      const cleanup = await db.runTransaction(async (transaction) => {
        const [session, claim] = await Promise.all([transaction.get(candidate.ref), transaction.get(claimRef)]);
        const status = String(session.get("status") || "");
        if (!session.exists || !CLEANUP_STATES.includes(status) || timestampMillis(session.get("expiresAt")) > Date.now()) return null;
        if (status !== "CLEANING") transaction.update(candidate.ref, { status: "CLEANING", cleanupStartedAt: FieldValue.serverTimestamp(), expiresAt: Timestamp.now() });
        if (claim.exists && claim.get("sessionId") === candidate.id && claim.get("status") !== "CLEANING") transaction.update(claimRef, { status: "CLEANING", updatedAt: FieldValue.serverTimestamp() });
        const files = Array.isArray(session.get("files")) ? session.get("files") as Record<string, unknown>[] : [];
        const paths = files.map((file) => {
          const id = typeof file.id === "string" ? file.id : "";
          const path = typeof file.storagePath === "string" ? file.storagePath : "";
          return /^[A-Za-z0-9_-]{10,80}$/.test(id) && path === `nexa-patient-result-quarantine/${candidate.id}/${id}` ? path : "";
        });
        return { paths, patientUid: session.get("patientUid"), resultId: session.get("resultId"), wasSubmitted: status === "SUBMITTED" };
      });
      if (!cleanup) continue;
      if (!cleanup.paths.length || cleanup.paths.some((path) => !path)) { failedSessions += 1; continue; }
      const deletes = await Promise.allSettled(cleanup.paths.map((path) => bucket.file(path).delete({ ignoreNotFound: true })));
      if (deletes.some((result) => result.status === "rejected")) { failedSessions += 1; continue; }
      const finalized = await db.runTransaction(async (transaction) => {
        const [session, claim] = await Promise.all([transaction.get(candidate.ref), transaction.get(claimRef)]);
        if (!session.exists || session.get("status") !== "CLEANING") return false;
        transaction.update(candidate.ref, { status: "EXPIRED", closedAt: FieldValue.serverTimestamp() });
        if (claim.exists && claim.get("sessionId") === candidate.id) transaction.update(claimRef, {
          status: cleanup.wasSubmitted ? "SUBMITTED" : "AVAILABLE",
          sessionId: FieldValue.delete(), expiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp(),
        });
        transaction.create(db.collection("patientResultAuditLogs").doc(), { actorUid: "system:cron", action: cleanup.wasSubmitted ? "patient_diagnostic_quarantine_cleaned" : "patient_result_upload_expired", resultId: cleanup.resultId, fileCount: cleanup.paths.length, createdAt: FieldValue.serverTimestamp() });
        return true;
      });
      if (finalized) { expiredSessions += 1; deletedObjects += cleanup.paths.length; }
    }
    return NextResponse.json({ ok: true, expiredSessions, deletedObjects, failedSessions }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    console.error("NEXA diagnostic result upload cleanup failed", error instanceof Error ? error.name : "unknown-error");
    return NextResponse.json({ ok: false, error: "Les téléversements expirés n’ont pas pu être nettoyés." }, { status: 500, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
