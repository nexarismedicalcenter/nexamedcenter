import { createHash, timingSafeEqual } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { createUserNotification } from "@/lib/notifications.server";

const MAX_BODY_BYTES = 1024;

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "home-visit-close-failed";
  const message = error instanceof ApiRequestError ? error.message : "La mission ne peut pas être clôturée pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA home visit close failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

async function readBody(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw new ApiRequestError(413, "request-too-large", "La requête de clôture dépasse la taille autorisée.");
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw new ApiRequestError(413, "request-too-large", "La requête de clôture dépasse la taille autorisée.");
  try { return JSON.parse(raw) as unknown; } catch { throw new ApiRequestError(400, "invalid-mission-code", "La requête de clôture n’est pas valide."); }
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request, { params }: { params: Promise<{ appointmentId: string }> }) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "close-home-visit-mission", limit: 5, windowMs: 10 * 60_000 });
    const providerSnapshot = await getFirebaseAdminDb().collection("providerProfiles").doc(user.uid).get();
    if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) {
      throw new ApiRequestError(403, "verified-doctor-required", "Cette action est réservée aux médecins NEXA vérifiés.");
    }

    const { appointmentId } = await params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) throw new ApiRequestError(400, "invalid-appointment", "La référence de la visite n’est pas valide.");
    const body = await readBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "code")) {
      throw new ApiRequestError(400, "invalid-mission-code", "La requête de clôture n’est pas valide.");
    }
    const code = body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).code === "string" ? ((body as Record<string, unknown>).code as string).trim() : "";
    if (!/^\d{8}$/.test(code)) throw new ApiRequestError(400, "invalid-mission-code", "Saisissez le code de clôture à huit chiffres remis par le patient.");

    const db = getFirebaseAdminDb();
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const reportRef = db.collection("homeVisitMissionReports").doc(appointmentId);
    const auditRef = db.collection("paymentAuditLogs").doc();
    let patientUid = "";
    await db.runTransaction(async (transaction) => {
      const [appointmentSnapshot, reportSnapshot] = await Promise.all([transaction.get(appointmentRef), transaction.get(reportRef)]);
      if (!appointmentSnapshot.exists || appointmentSnapshot.get("providerUid") !== user.uid || appointmentSnapshot.get("bookingType") !== "home_visit") {
        throw new ApiRequestError(404, "home-visit-not-found", "Cette visite n’est pas accessible.");
      }
      const appointment = appointmentSnapshot.data() || {};
      if (appointment.paymentStatus !== "PAID" || appointment.status !== "CONFIRMED" || appointment.homeVisitMissionStatus !== "AWAITING_PROVIDER_CODE" || !reportSnapshot.exists) {
        throw new ApiRequestError(409, "home-visit-not-ready-to-close", "La visite doit être payée et le formulaire du patient confirmé avant sa clôture.");
      }
      const report = reportSnapshot.data() || {};
      if (report.providerUid !== user.uid || report.providerPresent !== true || report.identityMatched !== true || report.patientConfirmed !== true || !["COMPLETED", "PARTIAL"].includes(String(report.serviceCompletion || ""))) {
        throw new ApiRequestError(409, "home-visit-report-review-required", "Le formulaire patient nécessite une vérification NEXA avant la clôture.");
      }
      const storedHash = typeof appointment.homeVisitMissionCodeHash === "string" ? appointment.homeVisitMissionCodeHash : "";
      const submittedHash = createHash("sha256").update(`NEXA_HOME_VISIT:${appointmentId}:${code}`).digest("hex");
      const storedBytes = /^[a-f0-9]{64}$/.test(storedHash) ? Buffer.from(storedHash, "hex") : Buffer.alloc(32);
      const submittedBytes = Buffer.from(submittedHash, "hex");
      if (!timingSafeEqual(storedBytes, submittedBytes) || !/^[a-f0-9]{64}$/.test(storedHash)) {
        throw new ApiRequestError(400, "mission-code-mismatch", "Le code ne correspond pas à cette visite. Vérifiez le code remis par le patient.");
      }
      patientUid = String(appointment.patientUid || "");
      if (!patientUid) throw new ApiRequestError(409, "home-visit-patient-unavailable", "Le patient associé à cette visite n’est pas disponible.");
      const now = FieldValue.serverTimestamp();
      transaction.set(appointmentRef, {
        status: "COMPLETED",
        homeVisitMissionStatus: "COMPLETED",
        homeVisitMissionClosedAt: now,
        homeVisitMissionClosedByUid: user.uid,
        homeVisitMissionCodeHash: FieldValue.delete(),
        homeVisitMissionCode: FieldValue.delete(),
        updatedAt: now,
      }, { merge: true });
      transaction.create(auditRef, {
        actorUid: user.uid,
        action: "home_visit_mission_closed_by_patient_code",
        resource: `appointments/${appointmentId}`,
        createdAt: now,
      });
    });

    await createUserNotification({
      uid: patientUid,
      eventKey: `home-visit:${appointmentId}:mission-closed`,
      appointmentId,
      type: "home_visit_mission_closed",
      title: "Visite NEXA clôturée",
      body: "Le médecin a validé votre code et clôturé la mission. Le statut de votre visite est mis à jour dans votre espace NEXA.",
      url: "/espace",
    });
    return json(request, { ok: true, missionStatus: "COMPLETED" });
  } catch (error) { return fail(request, error); }
}
