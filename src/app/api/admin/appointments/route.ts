import { FieldPath, FieldValue, Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { getTeleconsultationDurationMinutes } from "@/lib/teleconsultation/policy";
import { normalizeTeleconsultationSharePolicy } from "@/lib/payments/teleconsultation-share.server";

const PAGE_SIZE = 30;

function decodeCursor(value: string): { seconds: number; nanoseconds: number; id: string } | null {
  if (!value) return null;
  if (value.length > 512) throw new ApiRequestError(400, "invalid-appointment-cursor", "Le repère de pagination n’est pas valide.");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (!Number.isSafeInteger(parsed.seconds) || !Number.isSafeInteger(parsed.nanoseconds) || Number(parsed.nanoseconds) < 0 || Number(parsed.nanoseconds) >= 1_000_000_000 || typeof parsed.id !== "string" || !parsed.id || parsed.id.includes("/") || parsed.id.length > 128) {
      throw new Error("invalid cursor");
    }
    return { seconds: Number(parsed.seconds), nanoseconds: Number(parsed.nanoseconds), id: parsed.id };
  } catch {
    throw new ApiRequestError(400, "invalid-appointment-cursor", "Le repère de pagination n’est pas valide.");
  }
}

function encodeCursor(timestamp: Timestamp, id: string) {
  return Buffer.from(JSON.stringify({ seconds: timestamp.seconds, nanoseconds: timestamp.nanoseconds, id }), "utf8").toString("base64url");
}

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "admin-appointments-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les rendez-vous NEXA ne sont pas disponibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA admin appointments failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* no CORS for disallowed origins */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function iso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return (value.toDate() as Date).toISOString();
  }
  return typeof value === "string" ? value : null;
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-appointment-list", limit: 60, windowMs: 5 * 60_000 });
    const cursor = decodeCursor(new URL(request.url).searchParams.get("cursor") || "");

    const db = getFirebaseAdminDb();
    let query = db.collection("appointments").orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc");
    if (cursor) query = query.startAfter(new Timestamp(cursor.seconds, cursor.nanoseconds), cursor.id);
    const snapshot = await query.limit(PAGE_SIZE + 1).get();
    const hasMore = snapshot.docs.length > PAGE_SIZE;
    const page = snapshot.docs.slice(0, PAGE_SIZE);
    const appointments = page.map((doc) => {
      const data = doc.data();
      const normalizedSharePolicy = normalizeTeleconsultationSharePolicy(data.teleconsultationSharePolicy);
      const storedSharePolicy = normalizedSharePolicy
        ? { ...normalizedSharePolicy, basisConfirmed: false as const }
        : null;
      return {
        appointmentId: doc.id,
        patientUid: typeof data.patientUid === "string" ? data.patientUid.slice(0, 128) : "",
        providerUid: typeof data.providerUid === "string" ? data.providerUid.slice(0, 128) : "",
        providerName: typeof data.providerName === "string" ? data.providerName.slice(0, 160) : "Professionnel NEXA",
        startsAt: iso(data.startsAt),
        endsAt: iso(data.endsAt),
        durationMinutes: data.bookingType === "home_visit" ? 60 : getTeleconsultationDurationMinutes(data),
        amount: Number.isSafeInteger(data.amount) && Number(data.amount) >= 0 ? Number(data.amount) : 0,
        transactionFee: Number.isSafeInteger(data.transactionFee) && Number(data.transactionFee) >= 0 ? Number(data.transactionFee) : 0,
        totalAmount: Number.isSafeInteger(data.totalAmount) && Number(data.totalAmount) >= 0 ? Number(data.totalAmount) : Number.isSafeInteger(data.amount) ? Number(data.amount) : 0,
        currency: typeof data.currency === "string" ? data.currency.slice(0, 8) : "HTG",
        status: typeof data.status === "string" ? data.status.slice(0, 48) : "UNKNOWN",
        bookingType: data.bookingType === "home_visit" ? "home_visit" : data.bookingType === "doctor_proposed_appointment" ? "doctor_proposed_appointment" : "teleconsultation",
        ...(data.bookingType === "home_visit" && typeof data.homeVisitMissionStatus === "string" ? { homeVisitMissionStatus: data.homeVisitMissionStatus.slice(0, 48) } : {}),
        ...(data.bookingType === "home_visit" && typeof data.homeVisitServiceId === "string" ? { homeVisitServiceId: data.homeVisitServiceId.slice(0, 64) } : {}),
        paymentStatus: typeof data.paymentStatus === "string" ? data.paymentStatus.slice(0, 32) : "UNKNOWN",
        refundRequired: data.refundRequired === true,
        refundStatus: typeof data.refundStatus === "string" ? data.refundStatus.slice(0, 48) : "",
        refundMethod: typeof data.refundMethod === "string" ? data.refundMethod.slice(0, 32) : "",
        noShowOutcome: ["PROVIDER_UNRESPONSIVE", "PATIENT_UNRESPONSIVE"].includes(String(data.noShowOutcome || "")) ? String(data.noShowOutcome) : "",
        noShowAt: iso(data.noShowAt),
        sessionStatus: typeof data.sessionStatus === "string" ? data.sessionStatus.slice(0, 48) : "",
        teleconsultationSharePolicy: storedSharePolicy,
        createdAt: iso(data.createdAt),
      };
    });
    const auditRef = db.collection("adminAuditLogs").doc();
    await auditRef.create({
      actorUid: admin.uid,
      action: "admin_appointments_listed",
      resultCount: page.length,
      createdAt: FieldValue.serverTimestamp(),
    });
    const last = page[page.length - 1];
    const lastCreatedAt = last?.get("createdAt");
    return json(request, {
      ok: true,
      appointments,
      nextCursor: hasMore && last && lastCreatedAt instanceof Timestamp ? encodeCursor(lastCreatedAt, last.id) : null,
    });
  } catch (error) { return failure(request, error); }
}
