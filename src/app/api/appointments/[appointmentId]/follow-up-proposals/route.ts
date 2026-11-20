import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { hasActiveConsultationClinicalAccess } from "@/lib/clinical-record/access";
import { createUserNotification } from "@/lib/notifications.server";

type RouteContext = { params: Promise<{ appointmentId: string }> };

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "follow-up-proposal-failed";
  const message = error instanceof ApiRequestError ? error.message : "La proposition de suivi n’a pas pu être envoyée.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA follow-up proposal failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "propose-appointment-follow-up", limit: 8, windowMs: 10 * 60_000 });
    const { appointmentId } = await context.params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) throw new ApiRequestError(400, "invalid-appointment", "Le rendez-vous n’est pas valide.");
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 6_144) throw new ApiRequestError(413, "request-too-large", "La demande est trop volumineuse.");
    let body: unknown;
    try { body = JSON.parse(raw); } catch { throw new ApiRequestError(400, "invalid-request", "La demande n’est pas valide."); }
    const values = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const slotId = typeof values.slotId === "string" ? values.slotId.trim() : "";
    const note = typeof values.note === "string" ? values.note.trim().slice(0, 300) : "";
    if (!/^[a-f0-9]{32}$/.test(slotId)) throw new ApiRequestError(400, "invalid-follow-up-slot", "Choisissez un créneau disponible.");

    const db = getFirebaseAdminDb();
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const providerRef = db.collection("providerProfiles").doc(user.uid);
    const slotRef = db.collection("providerAvailabilitySlots").doc(slotId);
    const proposalId = createHash("sha256").update(`${appointmentId}:${slotId}`).digest("hex").slice(0, 32);
    const proposalRef = db.collection("followUpProposals").doc(proposalId);
    const outcome = await db.runTransaction(async (transaction) => {
      const [appointmentSnapshot, providerSnapshot, slotSnapshot, priorProposal] = await Promise.all([
        transaction.get(appointmentRef), transaction.get(providerRef), transaction.get(slotRef), transaction.get(proposalRef),
      ]);
      if (!appointmentSnapshot.exists || appointmentSnapshot.get("providerUid") !== user.uid || appointmentSnapshot.get("providerType") !== "doctor") {
        throw new ApiRequestError(404, "appointment-not-found", "Cette consultation ne vous est pas attribuée.");
      }
      const appointment = appointmentSnapshot.data() || {};
      if (appointment.paymentStatus !== "PAID" || !["IN_PROGRESS", "COMPLETED"].includes(String(appointment.status || "").toUpperCase())) {
        throw new ApiRequestError(409, "follow-up-not-available", "Une proposition de suivi est disponible après le paiement d’une consultation en cours ou terminée.");
      }
      if (!hasActiveConsultationClinicalAccess(appointment)) {
        throw new ApiRequestError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée. Une nouvelle prise en charge est nécessaire.");
      }
      if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) {
        throw new ApiRequestError(403, "verified-doctor-required", "Seuls les médecins NEXA vérifiés peuvent proposer un suivi.");
      }
      if (!slotSnapshot.exists || slotSnapshot.get("providerUid") !== user.uid || slotSnapshot.get("status") !== "available") {
        throw new ApiRequestError(409, "follow-up-slot-unavailable", "Ce créneau n’est plus disponible. Actualisez la liste.");
      }
      const startsAt = Date.parse(String(slotSnapshot.get("startsAt") || ""));
      const endsAt = Date.parse(String(slotSnapshot.get("endsAt") || ""));
      if (!Number.isFinite(startsAt) || startsAt <= Date.now() || !Number.isFinite(endsAt) || endsAt - startsAt !== 30 * 60_000) {
        throw new ApiRequestError(409, "follow-up-slot-invalid", "La date de ce créneau n’est plus valide.");
      }
      if (priorProposal.exists) {
        if (priorProposal.get("providerUid") !== user.uid || priorProposal.get("patientUid") !== appointment.patientUid || priorProposal.get("slotId") !== slotId) {
          throw new ApiRequestError(409, "follow-up-proposal-conflict", "Cette proposition ne peut pas être réutilisée.");
        }
        return { created: false, patientUid: String(appointment.patientUid || ""), startsAt: String(priorProposal.get("startsAt") || ""), proposalId };
      }
      if (typeof appointment.patientUid !== "string" || !appointment.patientUid) throw new ApiRequestError(409, "patient-not-found", "Le patient associé à cette consultation n’est pas disponible.");
      transaction.create(proposalRef, {
        appointmentId,
        patientUid: appointment.patientUid,
        providerUid: user.uid,
        slotId,
        startsAt: new Date(startsAt).toISOString(),
        note,
        status: "PENDING",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { created: true, patientUid: appointment.patientUid, startsAt: new Date(startsAt).toISOString(), proposalId };
    });

    if (outcome.created) {
      const date = new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "full", timeStyle: "short" }).format(new Date(outcome.startsAt));
      const bodyText = [`Votre médecin vous propose un rendez-vous de suivi le ${date}.`, note].filter(Boolean).join(" ");
      await createUserNotification({
        uid: outcome.patientUid,
        eventKey: `follow-up-proposal:${outcome.proposalId}`,
        type: "appointment_proposed",
        title: "Nouveau rendez-vous de suivi proposé",
        body: bodyText,
        url: `/rendez-vous/${encodeURIComponent(user.uid)}?slotId=${encodeURIComponent(slotId)}&proposalId=${encodeURIComponent(outcome.proposalId)}`,
        appointmentId,
      }).catch((error) => console.error("NEXA follow-up notification failed", error instanceof Error ? error.name : "unknown-error"));
    }
    return json(request, { ok: true, ...outcome, status: "PENDING" }, outcome.created ? 201 : 200);
  } catch (error) { return fail(request, error); }
}
