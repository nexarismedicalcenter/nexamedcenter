import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";

const SLOT_MINUTES = 30;
const HOME_VISIT_MINUTES = 60;
const MAX_SLOTS_PER_REQUEST = 30;
const MAX_LOOKAHEAD_DAYS = 90;

function response(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "availability-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les disponibilités ne sont pas accessibles pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA provider availability failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

async function requireVerifiedDoctor(request: Request) {
  const user = await requireFirebaseUser(request);
  await requireAppCheck(request);
  const provider = await getFirebaseAdminDb().collection("providerProfiles").doc(user.uid).get();
  if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
    throw new ApiRequestError(403, "verified-doctor-required", "Seuls les médecins NEXA vérifiés peuvent gérer leurs disponibilités.");
  }
  return user;
}

function parseStartsAt(value: unknown, now: number): string | null {
  if (typeof value !== "string" || value.length > 40 || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time) || time < now + 30 * 60_000 || time > now + MAX_LOOKAHEAD_DAYS * 24 * 60 * 60_000) return null;
  if (date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0 || date.getUTCMinutes() % SLOT_MINUTES !== 0) return null;
  return date.toISOString();
}

export async function GET(request: Request) {
  try {
    const user = await requireVerifiedDoctor(request);
    const now = new Date().toISOString();
    const until = new Date(Date.now() + MAX_LOOKAHEAD_DAYS * 24 * 60 * 60_000).toISOString();
    const snapshot = await getFirebaseAdminDb().collection("providerAvailabilitySlots")
      .where("providerUid", "==", user.uid)
      .where("startsAt", ">=", now)
      .where("startsAt", "<=", until)
      .orderBy("startsAt")
      .limit(100)
      .get();
    return response(request, { ok: true, slots: snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data(), serviceType: doc.get("serviceType") === "HOME_VISIT" ? "HOME_VISIT" : "TELECONSULTATION" })) });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const user = await requireVerifiedDoctor(request);
    await enforceUserRateLimit({ uid: user.uid, action: "publish-provider-availability", limit: 30, windowMs: 5 * 60_000 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray((body as Record<string, unknown>).startsAt)) {
      throw new ApiRequestError(400, "invalid-availability", "Choisissez une ou plusieurs heures de début valides.");
    }
    const rawStarts = (body as { startsAt: unknown[] }).startsAt;
    const serviceTypeValue = (body as Record<string, unknown>).serviceType;
    const serviceType = serviceTypeValue === undefined ? "TELECONSULTATION" : serviceTypeValue;
    if (serviceType !== "TELECONSULTATION" && serviceType !== "HOME_VISIT") throw new ApiRequestError(400, "invalid-availability-service", "Choisissez téléconsultation ou visite à domicile.");
    if (rawStarts.length < 1 || rawStarts.length > MAX_SLOTS_PER_REQUEST) {
      throw new ApiRequestError(400, "invalid-availability-count", "Ajoutez entre 1 et 30 créneaux à la fois.");
    }
    const now = Date.now();
    const parsed = rawStarts.map((value) => parseStartsAt(value, now));
    if (parsed.some((value) => !value) || new Set(parsed).size !== parsed.length) {
      throw new ApiRequestError(400, "invalid-availability-time", "Chaque créneau doit commencer dans au moins 30 minutes, sur une heure complète ou une demi-heure, et dans les 90 prochains jours.");
    }

    const db = getFirebaseAdminDb();
    if (serviceType === "HOME_VISIT") {
      const provider = await db.collection("providerProfiles").doc(user.uid).get();
      const profile = provider.get("profile") && typeof provider.get("profile") === "object" ? provider.get("profile") as Record<string, unknown> : {};
      const tariffs = profile.homeVisitTariffs && typeof profile.homeVisitTariffs === "object" && !Array.isArray(profile.homeVisitTariffs) ? Object.values(profile.homeVisitTariffs as Record<string, unknown>) : [];
      if (profile.homeVisitEnabled !== true || !tariffs.some((amount) => Number.isSafeInteger(amount) && Number(amount) > 0) || !Array.isArray(profile.homeVisitZones) || profile.homeVisitZones.length < 1) {
        throw new ApiRequestError(409, "home-visit-service-not-configured", "NEXA doit d’abord activer votre tarif et vos zones de visite à domicile.");
      }
    }
    const slots = parsed.map((startsAt) => {
      const start = startsAt as string;
      const startMs = Date.parse(start);
      const id = createHash("sha256").update(serviceType === "HOME_VISIT" ? `${user.uid}:HOME_VISIT:${start}` : `${user.uid}:${start}`).digest("hex").slice(0, 32);
      return {
        ref: db.collection("providerAvailabilitySlots").doc(id),
        startsAt: start,
        endsAt: new Date(startMs + (serviceType === "HOME_VISIT" ? HOME_VISIT_MINUTES : SLOT_MINUTES) * 60_000).toISOString(),
      };
    });
    const created = await db.runTransaction(async (transaction) => {
      const existing = await Promise.all(slots.map((slot) => transaction.get(slot.ref)));
      let count = 0;
      slots.forEach((slot, index) => {
        if (existing[index].exists) return;
        transaction.create(slot.ref, {
          providerUid: user.uid,
          providerType: "doctor",
          serviceType,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          status: "available",
          appointmentId: null,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        count += 1;
      });
      return count;
    });
    return response(request, { ok: true, created, duplicates: slots.length - created });
  } catch (error) { return fail(request, error); }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireVerifiedDoctor(request);
    const body = await request.json().catch(() => null);
    const slotId = body && typeof body === "object" && !Array.isArray(body) && typeof body.slotId === "string"
      ? body.slotId.trim()
      : "";
    if (!/^[a-f0-9]{32}$/.test(slotId)) throw new ApiRequestError(400, "invalid-slot", "Le créneau sélectionné n’est pas valide.");
    const ref = getFirebaseAdminDb().collection("providerAvailabilitySlots").doc(slotId);
    await getFirebaseAdminDb().runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists || snapshot.get("providerUid") !== user.uid) throw new ApiRequestError(404, "slot-not-found", "Créneau introuvable.");
      if (snapshot.get("status") !== "available" || Date.parse(String(snapshot.get("startsAt") || "")) <= Date.now()) {
        throw new ApiRequestError(409, "slot-already-reserved", "Un créneau réservé ou passé ne peut pas être supprimé.");
      }
      transaction.delete(ref);
    });
    return response(request, { ok: true, deleted: true });
  } catch (error) { return fail(request, error); }
}
