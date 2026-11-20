import { Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { getFirebaseAdminDb, getFirebaseAdminStorage } from "@/lib/firebase/admin";
import { timingSafeEqual } from "node:crypto";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET || "";
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!secret || token.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(secret));
}

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ ok: false, error: "Nettoyage non configuré." }, { status: 503 });
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "Accès refusé." }, { status: 401 });
  try {
    const db = getFirebaseAdminDb();
    const expired = await db.collection("sessionMessages")
      .where("expiresAt", "<=", Timestamp.now())
      .orderBy("expiresAt")
      .limit(400)
      .get();
    const bucket = getFirebaseAdminStorage().bucket();
    const messageResults = await Promise.allSettled(expired.docs.map(async (doc) => {
      const storagePath = doc.get("storagePath");
      if (typeof storagePath === "string" && storagePath === `nexa-session-media/${doc.get("appointmentId")}/${doc.id}`) {
        await bucket.file(storagePath).delete({ ignoreNotFound: true });
      }
      await doc.ref.delete();
    }));

    const expiredUploads = await db.collection("sessionMessageMediaUploads")
      .where("expiresAt", "<=", Timestamp.now())
      .orderBy("expiresAt")
      .limit(400)
      .get();
    const uploadResults = await Promise.allSettled(expiredUploads.docs.map(async (doc) => {
      const appointmentId = doc.get("appointmentId");
      const expectedPath = `nexa-session-media-quarantine/${appointmentId}/${doc.id}`;
      if (doc.get("storagePath") === expectedPath) await bucket.file(expectedPath).delete({ ignoreNotFound: true });
      await doc.ref.delete();
    }));
    const failures = [...messageResults, ...uploadResults].filter((result) => result.status === "rejected").length;
    if (failures) throw new Error("expired-session-media-cleanup-incomplete");
    return NextResponse.json({ ok: true, messagesDeleted: expired.size, uploadsCleaned: expiredUploads.size }, { headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch (error) {
    console.error("NEXA session message cleanup failed", error instanceof Error ? error.name : "unknown-error");
    return NextResponse.json({ ok: false, error: "Les messages expirés n’ont pas pu être supprimés." }, { status: 500, headers: { "Cache-Control": "no-store, max-age=0" } });
  }
}
