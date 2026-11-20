import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { getAvailableSellableStock } from "@/lib/pharmacy/stock";
import {
  buildPrescriptionAvailabilityLines,
  cleanAvailabilityText,
  getPrescriptionExpiryMillis,
  isDiagnosticAvailabilityMatch,
  isMedicationAvailabilityMatch,
  normalizePatientLocation,
  rankAvailabilityLocation,
  type PatientLocation,
} from "@/lib/prescription-availability";

type RouteContext = { params: Promise<{ prescriptionId: string }> };

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "prescription-availability-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Les disponibilités de cette ordonnance ne sont pas accessibles pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA prescription availability failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "prescription-availability", limit: 6, windowMs: 5 * 60_000 });
    const { prescriptionId } = await context.params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(prescriptionId)) throw new ApiRequestError(400, "invalid-prescription", "La référence d’ordonnance n’est pas valide.");

    const db = getFirebaseAdminDb();
    const [patientSnapshot, prescriptionSnapshot] = await Promise.all([
      db.collection("patientProfiles").doc(user.uid).get(),
      db.collection("clinicalPrescriptions").doc(prescriptionId).get(),
    ]);
    if (!patientSnapshot.exists || patientSnapshot.get("role") !== "patient" || patientSnapshot.get("profileComplete") !== true) {
      throw new ApiRequestError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
    }
    const prescription = prescriptionSnapshot.data() || {};
    if (!prescriptionSnapshot.exists || prescription.patientUid !== user.uid || prescription.status !== "VALIDATED") {
      await db.collection("adminAuditLogs").add({ actorUid: user.uid, action: "prescription_availability_access_denied", resource: `clinicalPrescriptions/${prescriptionId}`, context: { actualPatientUid: prescription.patientUid || null, status: prescription.status || null }, createdAt: new Date().toISOString() }).catch(() => {});
      throw new ApiRequestError(403, "prescription-not-available", "Cette ordonnance validée n’est pas accessible pour ce compte.");
    }
    const expiresAt = getPrescriptionExpiryMillis(prescription.expiresAt);
    if (expiresAt !== null && expiresAt <= Date.now()) throw new ApiRequestError(409, "prescription-expired", "Cette ordonnance a expiré et ne peut plus être utilisée.");

    const profile = patientSnapshot.data() || {};
    const patientLocation = normalizePatientLocation(profile);
    const params = new URL(request.url).searchParams;
    const requestedDepartment = cleanAvailabilityText(params.get("department"), 80);
    const requestedCommune = cleanAvailabilityText(params.get("commune"), 80);
    const searchLocation = requestedDepartment || requestedCommune ? { department: requestedDepartment || patientLocation.department, commune: requestedCommune || patientLocation.commune } : patientLocation;
    const lines = buildPrescriptionAvailabilityLines(prescription);
    const needsMedicine = lines.some((line) => line.type === "medication");
    const needsLab = lines.some((line) => line.type === "laboratory");
    const needsImaging = lines.some((line) => line.type === "imaging");
    const [productsSnapshot, offersSnapshot] = await Promise.all([
      needsMedicine ? db.collection("pharmacyProducts").where("publicationStatus", "==", "PUBLISHED").limit(500).get() : Promise.resolve(null),
      needsLab || needsImaging ? db.collection("diagnosticOffers").where("publicationStatus", "==", "PUBLISHED").where("active", "==", true).limit(500).get() : Promise.resolve(null),
    ]);
    const productDocs = productsSnapshot?.docs ?? [];
    const offerDocs = offersSnapshot?.docs ?? [];
    const providerIds = [...new Set([...productDocs.map((doc) => String(doc.get("providerUid") || "")), ...offerDocs.map((doc) => String(doc.get("providerUid") || ""))].filter((uid) => /^[A-Za-z0-9_-]{1,128}$/.test(uid)))];
    const providerSnapshots = [];
    for (let index = 0; index < providerIds.length; index += 250) {
      providerSnapshots.push(...await db.getAll(...providerIds.slice(index, index + 250).map((uid) => db.collection("providerProfiles").doc(uid))));
    }
    const providers = new Map(providerSnapshots.filter((doc) => doc.exists && doc.get("status") === "verified" && doc.get("publiclyListed") === true).map((doc) => [doc.id, doc.data() || {}]));
    const productCandidates = productDocs.flatMap((doc) => {
      const product = doc.data();
      const providerUid = String(product.providerUid || "");
      const provider = providers.get(providerUid);
      if (!provider || provider.type !== "pharmacy" || product.active !== true || !Number.isSafeInteger(product.price) || Number(product.price) < 1 || getAvailableSellableStock(product) < 1) return [];
      const profile = provider.profile && typeof provider.profile === "object" ? provider.profile as Record<string, unknown> : {};
      const location = normalizePatientLocation(profile);
      return [{ id: doc.id, providerUid, providerName: cleanAvailabilityText(profile.name || profile.displayName || provider.displayName, 120) || "Pharmacie NEXA", location, name: cleanAvailabilityText(product.name, 180), dci: cleanAvailabilityText(product.dci, 180), dosage: cleanAvailabilityText(product.dosage, 100), form: cleanAvailabilityText(product.pharmaceuticalForm, 100), price: Number(product.price), stock: getAvailableSellableStock(product), prescriptionRequired: product.prescriptionRequired === true || product.regulatoryCategory !== "OTC" }];
    });
    const offerCandidates = offerDocs.flatMap((doc) => {
      const offer = doc.data();
      const providerUid = String(offer.providerUid || "");
      const provider = providers.get(providerUid);
      const providerType = offer.providerType;
      if (!provider || (providerType !== "laboratory" && providerType !== "imaging") || provider.type !== providerType || (providerType === "laboratory" && !needsLab) || (providerType === "imaging" && !needsImaging) || offer.requestedAvailability === false) return [];
      const profile = provider.profile && typeof provider.profile === "object" ? provider.profile as Record<string, unknown> : {};
      const location = normalizePatientLocation(profile);
      return [{ id: doc.id, providerUid, providerType, providerName: cleanAvailabilityText(profile.name || profile.displayName || provider.displayName, 120) || "Partenaire NEXA", location, name: cleanAvailabilityText(offer.name, 180), price: Number.isSafeInteger(offer.price) && Number(offer.price) >= 0 ? Number(offer.price) : null, appointmentRequired: offer.appointmentRequired === true, catalogExamId: cleanAvailabilityText(offer.catalogExamId, 120), preparation: cleanAvailabilityText(offer.preparation, 500), requiresPrescription: offer.requiresPrescription === true }];
    });

    const availableLines = lines.map((line) => {
      const offers = line.type === "medication"
        ? productCandidates.filter((product) => isMedicationAvailabilityMatch(line, product) && product.prescriptionRequired)
          .map((product) => ({ ...product, type: line.type, route: "/pharmacie" }))
        : offerCandidates.filter((offer) => offer.providerType === line.type && isDiagnosticAvailabilityMatch(line, offer))
          .map((offer) => ({ ...offer, type: line.type, route: line.type === "laboratory" ? "/laboratoires" : "/imagerie" }));
      offers.sort((left, right) => rankAvailabilityLocation(searchLocation, left.location as PatientLocation) - rankAvailabilityLocation(searchLocation, right.location as PatientLocation) || (Number(left.price) || 0) - (Number(right.price) || 0));
      return { ...line, status: offers.length ? "DISPONIBLE" : "NON_DISPONIBLE", offers: offers.slice(0, 20) };
    });
    await db.collection("adminAuditLogs").add({ actorUid: user.uid, action: "prescription_availability_checked", resource: `clinicalPrescriptions/${prescriptionId}`, context: { lineCount: availableLines.length, availableLineCount: availableLines.filter((line) => line.status === "DISPONIBLE").length }, createdAt: new Date().toISOString() }).catch(() => {});
    return json(request, { ok: true, patientLocation, searchLocation, lines: availableLines });
  } catch (error) { return fail(request, error); }
}
