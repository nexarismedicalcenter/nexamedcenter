import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "admin-home-visit-missions-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les visites à vérifier ne sont pas accessibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA admin home visit missions failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function iso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).toISOString();
  return typeof value === "string" ? value : null;
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-home-visit-mission-review-list", limit: 30, windowMs: 5 * 60_000 });
    const db = getFirebaseAdminDb();
    const snapshot = await db.collection("appointments").where("homeVisitMissionStatus", "==", "ADMIN_REVIEW_REQUIRED").limit(100).get();
    const reportSnapshots = snapshot.docs.length ? await db.getAll(...snapshot.docs.map((doc) => db.collection("homeVisitMissionReports").doc(doc.id))) : [];
    const patientRefs = snapshot.docs.map((doc) => db.collection("patientProfiles").doc(String(doc.get("patientUid") || "_")));
    const patientSnapshots = patientRefs.length ? await db.getAll(...patientRefs) : [];
    const missions = snapshot.docs.map((doc, index) => {
      const data = doc.data();
      const report = reportSnapshots[index]?.data() || {};
      const patient = patientSnapshots[index]?.data() || {};
      const ratings = report.ratings && typeof report.ratings === "object" ? report.ratings as Record<string, unknown> : {};
      return {
        appointmentId: doc.id,
        patientName: typeof patient.displayName === "string" ? patient.displayName.slice(0, 100) : "Patient NEXA",
        patientUid: typeof data.patientUid === "string" ? data.patientUid.slice(0, 128) : "",
        providerUid: typeof data.providerUid === "string" ? data.providerUid.slice(0, 128) : "",
        providerName: typeof data.providerName === "string" ? data.providerName.slice(0, 120) : "Médecin NEXA",
        serviceId: typeof data.homeVisitServiceId === "string" ? data.homeVisitServiceId.slice(0, 64) : "",
        startsAt: typeof data.startsAt === "string" ? data.startsAt : "",
        serviceCompletion: typeof report.serviceCompletion === "string" ? report.serviceCompletion : "UNKNOWN",
        providerPresent: report.providerPresent === true,
        identityMatched: report.identityMatched === true,
        visitStartedAt: iso(report.visitStartedAt),
        visitEndedAt: iso(report.visitEndedAt),
        ratings: Object.fromEntries(["punctuality", "professionalism", "listening", "explanations", "satisfaction"].map((key) => [key, Number.isInteger(ratings[key]) ? Number(ratings[key]) : null])),
        submittedAt: iso(report.createdAt),
        paymentStatus: typeof data.paymentStatus === "string" ? data.paymentStatus : "UNKNOWN",
      };
    }).sort((a, b) => String(b.submittedAt || "").localeCompare(String(a.submittedAt || "")));
    await db.collection("adminAuditLogs").doc().create({ actorUid: admin.uid, action: "admin_home_visit_mission_review_listed", resultCount: missions.length, createdAt: FieldValue.serverTimestamp() });
    return json(request, { ok: true, missions });
  } catch (error) { return fail(request, error); }
}
