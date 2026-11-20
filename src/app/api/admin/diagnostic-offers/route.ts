import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { createUserNotification } from "@/lib/notifications.server";
import { normalizeDiagnosticResultRequirements, type DiagnosticProviderType } from "@/lib/diagnostic-results.server";

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "admin-diagnostic-offers-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les offres diagnostiques ne sont pas accessibles.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA admin diagnostic offers failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    await requireNexaAdministrator(request);
    const snapshot = await getFirebaseAdminDb().collection("diagnosticOffers")
      .where("publicationStatus", "in", ["PENDING_REVIEW", "PUBLISHED"])
      .limit(200)
      .get();
    const offers = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        publicationStatus: data.publicationStatus === "PUBLISHED" ? "PUBLISHED" : "PENDING_REVIEW",
        providerUid: String(data.providerUid || ""),
        providerType: String(data.providerType || ""),
        name: String(data.name || ""),
        category: String(data.category || ""),
        description: String(data.description || ""),
        specimenType: String(data.specimenType || ""),
        preparation: String(data.preparation || ""),
        precautions: String(data.precautions || ""),
        technique: String(data.technique || ""),
        resultDelay: String(data.resultDelay || ""),
        instructions: String(data.instructions || ""),
        price: Number(data.price) || 0,
        requiresPrescription: data.requiresPrescription === true,
        appointmentRequired: data.appointmentRequired === true,
        homeSampling: data.homeSampling === true,
        requestedAvailability: data.requestedAvailability !== false,
        resultRequirements: normalizeDiagnosticResultRequirements(
          data.resultRequirements,
          data.providerType === "imaging" ? "imaging" : "laboratory",
          409,
        ),
      };
    });
    return json(request, { ok: true, offers });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande est invalide.");
    const input = body as Record<string, unknown>;
    const offerId = typeof input.offerId === "string" ? input.offerId.trim() : "";
    const action = typeof input.action === "string" ? input.action.trim().toUpperCase() : "";
    const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(offerId) || !["PUBLISH", "UPDATE_REQUIREMENTS", "REQUEST_CORRECTION", "REJECT", "SUSPEND", "ARCHIVE"].includes(action)) {
      throw new ApiRequestError(400, "invalid-diagnostic-offer-review", "L’offre ou la décision de revue n’est pas valide.");
    }
    if (!new Set(["PUBLISH", "UPDATE_REQUIREMENTS"]).has(action) && !reason) throw new ApiRequestError(400, "review-reason-required", "Un motif est obligatoire pour cette décision.");
    if (action === "UPDATE_REQUIREMENTS" && input.resultRequirements === undefined) throw new ApiRequestError(400, "result-requirements-required", "Les exigences à enregistrer sont manquantes.");
    const db = getFirebaseAdminDb();
    const offerRef = db.collection("diagnosticOffers").doc(offerId);
    const auditRef = db.collection("adminAuditLogs").doc();
    const result = await db.runTransaction(async (transaction) => {
      const offerSnapshot = await transaction.get(offerRef);
      if (!offerSnapshot.exists) throw new ApiRequestError(404, "diagnostic-offer-not-found", "Cette offre est introuvable.");
      const offer = offerSnapshot.data() || {};
      const providerType = offer.providerType as DiagnosticProviderType;
      const providerRef = db.collection("providerProfiles").doc(String(offer.providerUid || "_"));
      const providerSnapshot = await transaction.get(providerRef);
      const typeIsValid = providerType === "laboratory" || providerType === "imaging";
      if (!typeIsValid) throw new ApiRequestError(409, "diagnostic-provider-type-invalid", "Le type de partenaire de cette offre doit être vérifié.");
      const resultRequirements = ["PUBLISH", "UPDATE_REQUIREMENTS"].includes(action)
        ? normalizeDiagnosticResultRequirements(input.resultRequirements, providerType, 400)
        : undefined;
      if (action === "UPDATE_REQUIREMENTS" && offer.publicationStatus !== "PUBLISHED") {
        throw new ApiRequestError(409, "diagnostic-offer-not-published", "Seule une offre actuellement publiée peut recevoir une mise à jour de ses exigences.");
      }
      if (action === "PUBLISH" && offer.publicationStatus !== "PENDING_REVIEW") {
        throw new ApiRequestError(409, "diagnostic-offer-not-pending", "Seule une offre en attente de revue peut être publiée.");
      }
      if (action === "PUBLISH" && (!providerSnapshot.exists || providerSnapshot.get("type") !== offer.providerType || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("publiclyListed") !== true)) {
        throw new ApiRequestError(409, "diagnostic-provider-not-publishable", "Le partenaire propriétaire n’est plus vérifié et publié.");
      }
      if (action === "PUBLISH" && (String(offer.name || "").trim().length < 2 || !Number.isSafeInteger(offer.price) || Number(offer.price) < 0 || Number(offer.price) > 10_000_000)) {
        throw new ApiRequestError(409, "diagnostic-offer-incomplete", "Le nom et le prix HTG de l’offre doivent être valides avant publication.");
      }
      const status = action === "PUBLISH" || action === "UPDATE_REQUIREMENTS" ? "PUBLISHED" : action === "REQUEST_CORRECTION" ? "NEEDS_CORRECTION" : action === "SUSPEND" ? "SUSPENDED" : action === "ARCHIVE" ? "ARCHIVED" : "REJECTED";
      if (action === "UPDATE_REQUIREMENTS") {
        if (!resultRequirements) throw new ApiRequestError(400, "result-requirements-required", "Les exigences à enregistrer sont manquantes.");
        transaction.update(offerRef, { resultRequirements, updatedAt: FieldValue.serverTimestamp() });
      } else {
        transaction.set(offerRef, {
          publicationStatus: status,
          active: action === "PUBLISH" && offer.requestedAvailability !== false,
          reviewReason: action === "PUBLISH" ? "" : reason,
          reviewedByUid: admin.uid,
          reviewedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
          ...(resultRequirements ? { resultRequirements } : {}),
        }, { merge: true });
      }
      transaction.create(auditRef, {
        actorUid: admin.uid,
        action: action === "UPDATE_REQUIREMENTS" ? "diagnostic_offer_requirements_updated" : `diagnostic_offer_${action.toLowerCase()}`,
        resource: `diagnosticOffers/${offerId}`,
        providerType: offer.providerType,
        ...(resultRequirements ? { resultRequirements } : {}),
        createdAt: FieldValue.serverTimestamp(),
      });
      return { providerUid: String(offer.providerUid || ""), status, providerType: String(offer.providerType), action };
    });
    if (result.providerUid) await createUserNotification({
      uid: result.providerUid,
      eventKey: `diagnostic-offer-review:${offerId}:${auditRef.id}`,
      type: "diagnostic_offer_review",
      title: result.action === "UPDATE_REQUIREMENTS" ? "Exigences de résultat mises à jour" : result.status === "PUBLISHED" ? "Offre publiée" : result.status === "NEEDS_CORRECTION" ? "Correction demandée" : result.status === "SUSPENDED" ? "Offre suspendue" : result.status === "ARCHIVED" ? "Offre archivée" : "Offre refusée",
      body: result.action === "UPDATE_REQUIREMENTS" ? "Les exigences mises à jour s’appliquent aux nouvelles commandes; les commandes existantes conservent leurs exigences initiales." : result.status === "PUBLISHED" ? "Votre offre est publiée dans le répertoire NEXA." : reason,
      url: "/professionnels/espace",
    });
    return json(request, { ok: true, offerId, publicationStatus: result.status, providerType: result.providerType });
  } catch (error) { return fail(request, error); }
}
