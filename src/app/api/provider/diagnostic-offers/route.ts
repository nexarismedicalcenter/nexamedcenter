import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

type DiagnosticProviderType = "laboratory" | "imaging";
const providerTypes = new Set<DiagnosticProviderType>(["laboratory", "imaging"]);

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "diagnostic-offers-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les offres du partenaire ne sont pas accessibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA provider diagnostic offers failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}

function parseOffer(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiRequestError(400, "invalid-offer", "La fiche de service n’est pas valide.");
  const input = value as Record<string, unknown>;
  const name = clean(input.name, 180);
  const price = input.price;
  if (name.length < 2 || !Number.isSafeInteger(price) || Number(price) < 0 || Number(price) > 10_000_000) {
    throw new ApiRequestError(400, "invalid-offer", "Indiquez un nom de service et un prix entier valide en HTG.");
  }
  for (const key of ["requiresPrescription", "appointmentRequired", "homeSampling", "active"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") throw new ApiRequestError(400, "invalid-offer-option", "Une option du service n’est pas valide.");
  }
  return {
    name,
    category: clean(input.category, 120),
    catalogExamId: clean(input.catalogExamId, 120),
    description: clean(input.description, 500),
    specimenType: clean(input.specimenType, 120),
    preparation: clean(input.preparation, 1000),
    precautions: clean(input.precautions, 1000),
    technique: clean(input.technique, 180),
    resultDelay: clean(input.resultDelay, 160),
    instructions: clean(input.instructions, 1200),
    price: Number(price),
    requiresPrescription: input.requiresPrescription === true,
    appointmentRequired: input.appointmentRequired === true,
    homeSampling: input.homeSampling === true,
    requestedAvailability: input.active !== false,
  };
}

async function verifiedDiagnosticProvider(request: Request) {
  const user = await requireFirebaseUser(request);
  await requireAppCheck(request);
  const snapshot = await getFirebaseAdminDb().collection("providerProfiles").doc(user.uid).get();
  const type = snapshot.get("type");
  if (!snapshot.exists || !providerTypes.has(type as DiagnosticProviderType) || snapshot.get("status") !== "verified" || snapshot.get("publiclyListed") !== true) {
    throw new ApiRequestError(403, "verified-diagnostic-provider-required", "La gestion des offres est réservée aux laboratoires et centres d’imagerie NEXA vérifiés.");
  }
  return { user, type: type as DiagnosticProviderType };
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const { user, type } = await verifiedDiagnosticProvider(request);
    await enforceUserRateLimit({ uid: user.uid, action: "diagnostic-offers-read", limit: 60, windowMs: 60_000 });
    const db = getFirebaseAdminDb();
    const snapshot = await db.collection("diagnosticOffers").where("providerUid", "==", user.uid).orderBy("updatedAt", "desc").limit(200).get();
    const offers = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        name: data.name,
        category: data.category || "",
        catalogExamId: data.catalogExamId || "",
        description: data.description || "",
        specimenType: data.specimenType || "",
        preparation: data.preparation || "",
        precautions: data.precautions || "",
        technique: data.technique || "",
        resultDelay: data.resultDelay || "",
        instructions: data.instructions || "",
        price: data.price,
        requiresPrescription: data.requiresPrescription === true,
        appointmentRequired: data.appointmentRequired === true,
        homeSampling: data.homeSampling === true,
        requestedAvailability: data.requestedAvailability !== false,
        publicationStatus: data.publicationStatus || "PENDING_REVIEW",
        reviewReason: data.reviewReason || "",
        providerType: type,
      };
    });
    await db.collection("adminAuditLogs").doc().set({
      actorUid: user.uid,
      action: "diagnostic_offers_listed",
      resource: `providerProfiles/${user.uid}`,
      providerType: type,
      resultCount: offers.length,
      createdAt: FieldValue.serverTimestamp(),
    });
    return json(request, { ok: true, offers });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const { user, type } = await verifiedDiagnosticProvider(request);
    await enforceUserRateLimit({ uid: user.uid, action: "diagnostic-offers-write", limit: 20, windowMs: 60_000 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande n’est pas valide.");
    const input = body as Record<string, unknown>;
    const offerId = typeof input.offerId === "string" ? input.offerId.trim() : "";
    if (offerId && !/^[A-Za-z0-9_-]{10,200}$/.test(offerId)) throw new ApiRequestError(400, "invalid-offer-id", "La référence de l’offre n’est pas valide.");
    const offer = parseOffer(input);
    const db = getFirebaseAdminDb();
    const providerRef = db.collection("providerProfiles").doc(user.uid);
    const offerRef = offerId ? db.collection("diagnosticOffers").doc(offerId) : db.collection("diagnosticOffers").doc();
    const auditRef = db.collection("adminAuditLogs").doc();
    const result = await db.runTransaction(async (transaction) => {
      const [providerSnapshot, priorSnapshot] = await Promise.all([
        transaction.get(providerRef),
        offerId ? transaction.get(offerRef) : Promise.resolve(null),
      ]);
      if (!providerSnapshot.exists || providerSnapshot.get("type") !== type || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true) {
        throw new ApiRequestError(403, "provider-no-longer-publishable", "Le profil partenaire n’est plus autorisé à gérer des offres.");
      }
      if (offerId && (!priorSnapshot?.exists || priorSnapshot.get("providerUid") !== user.uid || priorSnapshot.get("providerType") !== type)) {
        throw new ApiRequestError(404, "offer-not-found", "Cette offre n’appartient pas à votre profil.");
      }
      const now = FieldValue.serverTimestamp();
      transaction.set(offerRef, {
        ...offer,
        providerUid: user.uid,
        providerType: type,
        active: false,
        publicationStatus: "PENDING_REVIEW",
        reviewReason: "",
        ...(offerId ? {} : { createdAt: now }),
        updatedAt: now,
      }, { merge: true });
      transaction.create(auditRef, {
        actorUid: user.uid,
        action: offerId ? "diagnostic_offer_updated" : "diagnostic_offer_created",
        resource: `diagnosticOffers/${offerRef.id}`,
        providerType: type,
        createdAt: now,
      });
      return { offerId: offerRef.id, publicationStatus: "PENDING_REVIEW" };
    });
    return json(request, { ok: true, ...result });
  } catch (error) { return fail(request, error); }
}

export async function DELETE(request: Request) {
  try {
    const { user, type } = await verifiedDiagnosticProvider(request);
    await enforceUserRateLimit({ uid: user.uid, action: "diagnostic-offers-archive", limit: 20, windowMs: 60_000 });
    const body = await request.json().catch(() => null);
    const offerId = body && typeof body === "object" && !Array.isArray(body) && typeof (body as Record<string, unknown>).offerId === "string" ? String((body as Record<string, unknown>).offerId).trim() : "";
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(offerId)) throw new ApiRequestError(400, "invalid-offer-id", "La référence de l’offre n’est pas valide.");
    const db = getFirebaseAdminDb();
    const offerRef = db.collection("diagnosticOffers").doc(offerId);
    const auditRef = db.collection("adminAuditLogs").doc();
    await db.runTransaction(async (transaction) => {
      const [providerSnapshot, offerSnapshot] = await Promise.all([
        transaction.get(db.collection("providerProfiles").doc(user.uid)),
        transaction.get(offerRef),
      ]);
      if (!providerSnapshot.exists || providerSnapshot.get("type") !== type || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true) throw new ApiRequestError(403, "verified-diagnostic-provider-required", "Le profil partenaire n’est plus autorisé.");
      if (!offerSnapshot.exists || offerSnapshot.get("providerUid") !== user.uid || offerSnapshot.get("providerType") !== type) throw new ApiRequestError(404, "offer-not-found", "Cette offre n’appartient pas à votre profil.");
      transaction.set(offerRef, { active: false, requestedAvailability: false, publicationStatus: "ARCHIVED", reviewReason: "", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      transaction.create(auditRef, { actorUid: user.uid, action: "diagnostic_offer_archived", resource: `diagnosticOffers/${offerId}`, providerType: type, createdAt: FieldValue.serverTimestamp() });
    });
    return json(request, { ok: true, offerId, publicationStatus: "ARCHIVED" });
  } catch (error) { return fail(request, error); }
}
