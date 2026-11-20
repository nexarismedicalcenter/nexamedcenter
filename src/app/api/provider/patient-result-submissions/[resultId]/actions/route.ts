import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { writeClinicalRecordRevision } from "@/lib/clinical-record/versions.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { createUserNotification } from "@/lib/notifications.server";
import { cleanPatientResultText } from "@/lib/patient-result-submissions.server";

type RouteContext = { params: Promise<{ resultId: string }> };

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request); headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "patient-result-follow-up-failed";
  const message = error instanceof ApiRequestError ? error.message : "Le suivi du résultat n’a pas pu être enregistré.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA patient result follow-up failed", error instanceof Error ? error.name : "unknown-error");
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
    const user = await requireFirebaseUser(request); await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "provider-patient-result-follow-up", limit: 15, windowMs: 10 * 60_000 });
    const { resultId } = await context.params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(resultId)) throw new ApiRequestError(400, "invalid-result-id", "La référence du résultat n’est pas valide.");
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 24_576) throw new ApiRequestError(413, "request-too-large", "La demande de suivi est trop volumineuse.");
    let input: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(raw); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-body"); input = parsed as Record<string, unknown>; }
    catch { throw new ApiRequestError(400, "invalid-request", "La demande de suivi n’est pas valide."); }
    const action = cleanPatientResultText(input.action, 30);
    if (!["note", "prescription", "appointment", "close"].includes(action)) throw new ApiRequestError(400, "invalid-follow-up-action", "Choisissez une action de suivi valide.");

    const db = getFirebaseAdminDb();
    const providerRef = db.collection("providerProfiles").doc(user.uid);
    const resultRef = db.collection("patientSubmittedResults").doc(resultId);
    const grantRef = db.collection("patientResultFollowUpGrants").doc(resultId);
    const auditRef = db.collection("patientResultAuditLogs").doc();
    const clinicalAuditRef = db.collection("clinicalAuditLogs").doc();
    const actionRef = resultRef.collection("followUpActions").doc();
    const clinicalRecordRef = db.collection("electronicPatientRecords").doc();
    const counterRef = db.collection("systemCounters").doc("clinicalRecordNumbers");
    const timestamp = FieldValue.serverTimestamp();
    const initial = await Promise.all([providerRef.get(), resultRef.get(), grantRef.get()]);
    const [provider, result, grant] = initial;
    if (!provider.exists || provider.get("type") !== "doctor" || provider.get("status") !== "verified" || provider.get("clinicalCredentialsVerified") !== true) throw new ApiRequestError(403, "verified-doctor-required", "Cette action est réservée au médecin NEXA vérifié.");
    if (!result.exists || result.get("providerUid") !== user.uid || !grant.exists || grant.get("providerUid") !== user.uid || grant.get("patientUid") !== result.get("patientUid")) throw new ApiRequestError(404, "patient-result-not-found", "Ce résultat n’est pas accessible.");
    if (grant.get("status") !== "OPEN") throw new ApiRequestError(403, "follow-up-access-closed", "L’accès de suivi associé à ce résultat est fermé.");
    const patientUid = String(result.get("patientUid") || "");
    const appointmentId = String(result.get("appointmentId") || "");
    const patientRef = db.collection("patientProfiles").doc(patientUid);
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const profileData = provider.get("profile") && typeof provider.get("profile") === "object" ? provider.get("profile") as Record<string, unknown> : {};
    const providerName = cleanPatientResultText(profileData.name || profileData.displayName || user.name, 180) || "Médecin NEXA";
    const specialtyName = cleanPatientResultText(profileData.specialty, 160);
    let responsePayload: Record<string, unknown> = { ok: true, action };
    let notification: { title: string; body: string; eventKey: string; url: string } | null = null;

    if (action === "note") {
      const content = cleanPatientResultText(input.note, 5_000);
      if (!content) throw new ApiRequestError(400, "follow-up-note-required", "Rédigez une note avant de l’ajouter au dossier.");
      let recordNumber = "";
      await db.runTransaction(async (transaction) => {
        const [freshProvider, freshResult, freshGrant, patient, counter] = await Promise.all([transaction.get(providerRef), transaction.get(resultRef), transaction.get(grantRef), transaction.get(patientRef), transaction.get(counterRef)]);
        if (!freshProvider.exists || freshProvider.get("type") !== "doctor" || freshProvider.get("status") !== "verified" || freshProvider.get("clinicalCredentialsVerified") !== true || !freshResult.exists || freshResult.get("providerUid") !== user.uid || !freshGrant.exists || freshGrant.get("providerUid") !== user.uid || freshGrant.get("status") !== "OPEN" || freshGrant.get("patientUid") !== patientUid || !patient.exists || patient.get("role") !== "patient" || patient.get("profileComplete") !== true) throw new ApiRequestError(403, "follow-up-access-closed", "L’accès de suivi a été fermé ou n’est plus autorisé.");
        const lastIssuedNumber = counter.exists ? counter.get("lastIssuedNumber") : 0;
        if (typeof lastIssuedNumber !== "number" || !Number.isSafeInteger(lastIssuedNumber) || lastIssuedNumber < 0 || lastIssuedNumber >= 9_999_999) throw new ApiRequestError(503, "record-number-unavailable", "La numérotation des dossiers est indisponible.");
        const sequence = lastIssuedNumber + 1;
        recordNumber = `NEXA-${new Date().getUTCFullYear()}-${String(sequence).padStart(7, "0")}`;
        const patientData = patient.data() || {};
        const patientNumber = cleanPatientResultText(patientData.patientNumber, 32);
        const patientName = cleanPatientResultText(patientData.displayName || `${patientData.firstName || ""} ${patientData.lastName || ""}`.trim(), 140) || "Patient NEXA";
        const signedAt = new Date().toISOString();
        const signature = { uid: user.uid, name: providerName, specialty: specialtyName, signedAt };
        const clinicalContent = {
          consultationReason: "Suivi du résultat transmis par le patient",
          relevantHistory: cleanPatientResultText(freshResult.get("examName"), 250),
          additionalNotes: content,
        };
        const documentHash = createHash("sha256").update(JSON.stringify({ recordId: clinicalRecordRef.id, providerUid: user.uid, patientUid, version: 1, clinicalContent, signature })).digest("hex");
        await writeClinicalRecordRevision(transaction, clinicalRecordRef, null, {
          version: 1, status: "FINALIZED", clinicalContent, attachments: [], actorUid: user.uid, changeType: "FINALIZED", signature, documentHash,
        });
        transaction.create(clinicalRecordRef, {
          recordId: clinicalRecordRef.id, recordType: "STANDALONE", sourceType: "PATIENT_RESULT_FOLLOW_UP", sourceResultId: resultId, appointmentId,
          patientUid, patientNumber, patientName, providerUid: user.uid, providerName, specialtyName, recordNumber,
          status: "FINALIZED", version: 1, clinicalContent, attachments: [], addendumCount: 0,
          createdAt: timestamp, updatedAt: timestamp, finalizedAt: timestamp, signedAt: timestamp, signature, documentHash,
          createdBy: user.uid, updatedBy: user.uid, accessGrantId: resultId, accessGrantedAt: freshGrant.get("createdAt"), accessRevoked: false,
        });
        transaction.set(counterRef, { lastIssuedNumber: sequence, updatedAt: timestamp }, { merge: true });
        transaction.create(actionRef, { type: "NOTE", patientUid, providerUid: user.uid, providerName, specialtyName, content, recordId: clinicalRecordRef.id, recordNumber, signature, createdAt: timestamp });
        transaction.create(auditRef, { actorUid: user.uid, action: "prescriber_patient_result_note_added", resultId, createdAt: timestamp });
        transaction.create(clinicalAuditRef, { actorUid: user.uid, action: "result_follow_up_clinical_record_created", resultId, recordId: clinicalRecordRef.id, recordNumber, createdAt: timestamp });
      });
      responsePayload = { ...responsePayload, actionId: actionRef.id, recordId: clinicalRecordRef.id, recordNumber };
      notification = { eventKey: `patient-result:${resultId}:note:${actionRef.id}`, title: "Note médicale ajoutée", body: "Votre médecin a ajouté une note de suivi à votre résultat médical.", url: "/espace#resultats" };
    } else if (action === "prescription") {
      const medicationInput = input.medication && typeof input.medication === "object" && !Array.isArray(input.medication) ? input.medication as Record<string, unknown> : {};
      const medication = {
        name: cleanPatientResultText(medicationInput.name, 180), dosage: cleanPatientResultText(medicationInput.dosage, 120),
        form: cleanPatientResultText(medicationInput.form, 120), route: cleanPatientResultText(medicationInput.route, 120),
        quantity: medicationInput.quantity === "" || medicationInput.quantity == null ? null : Number(medicationInput.quantity),
        instructions: cleanPatientResultText(medicationInput.instructions, 500), duration: cleanPatientResultText(medicationInput.duration, 120),
      };
      const notes = cleanPatientResultText(input.notes, 1_000);
      if (!medication.name || (medication.quantity !== null && (!Number.isFinite(medication.quantity) || medication.quantity < 0 || medication.quantity > 1_000_000))) throw new ApiRequestError(400, "invalid-medication", "Vérifiez le nom et la quantité du médicament.");
      const prescriptionRef = db.collection("clinicalPrescriptions").doc();
      await db.runTransaction(async (transaction) => {
        const [freshProvider, freshResult, freshGrant, patient, appointment] = await Promise.all([transaction.get(providerRef), transaction.get(resultRef), transaction.get(grantRef), transaction.get(patientRef), transaction.get(appointmentRef)]);
        if (!freshProvider.exists || freshProvider.get("type") !== "doctor" || freshProvider.get("status") !== "verified" || freshProvider.get("clinicalCredentialsVerified") !== true || !freshResult.exists || freshResult.get("providerUid") !== user.uid || !freshGrant.exists || freshGrant.get("providerUid") !== user.uid || freshGrant.get("status") !== "OPEN" || freshGrant.get("patientUid") !== patientUid || !patient.exists || patient.get("role") !== "patient" || !appointment.exists || appointment.get("patientUid") !== patientUid || appointment.get("providerUid") !== user.uid) throw new ApiRequestError(403, "follow-up-access-closed", "L’accès de suivi a été fermé ou n’est plus autorisé.");
        transaction.create(prescriptionRef, {
          appointmentId, patientUid, providerUid: user.uid, providerName, specialtyName,
          medications: [medication], labExams: [], imagingExams: [], notes,
          status: "VALIDATED", version: 1, versionGroupId: prescriptionRef.id,
          previousVersionId: null, replacedBy: null,
          signature: { uid: user.uid, name: providerName, specialty: specialtyName, signedAt: new Date().toISOString(), source: "PATIENT_RESULT_FOLLOW_UP" },
          validatedAt: timestamp, createdAt: timestamp, updatedAt: timestamp, createdBy: user.uid, updatedBy: user.uid,
          sourceResultId: resultId,
        });
        transaction.create(actionRef, { type: "PRESCRIPTION", patientUid, providerUid: user.uid, prescriptionId: prescriptionRef.id, createdAt: timestamp });
        transaction.create(auditRef, { actorUid: user.uid, action: "prescriber_patient_result_prescription_created", resultId, prescriptionId: prescriptionRef.id, createdAt: timestamp });
      });
      responsePayload = { ...responsePayload, prescriptionId: prescriptionRef.id };
      notification = { eventKey: `patient-result:${resultId}:prescription:${prescriptionRef.id}`, title: "Ordonnance reçue", body: "Votre médecin vous a transmis une ordonnance après la lecture de votre résultat.", url: "/espace#ordonnances" };
    } else if (action === "appointment") {
      const slotId = cleanPatientResultText(input.slotId, 80);
      const note = cleanPatientResultText(input.note, 300);
      if (!/^[a-f0-9]{32}$/.test(slotId)) throw new ApiRequestError(400, "invalid-follow-up-slot", "Choisissez un créneau disponible.");
      const slotRef = db.collection("providerAvailabilitySlots").doc(slotId);
      const proposalId = createHash("sha256").update(`patient-result:${resultId}:${slotId}`).digest("hex").slice(0, 32);
      const proposalRef = db.collection("followUpProposals").doc(proposalId);
      let startsAt = "";
      await db.runTransaction(async (transaction) => {
        const [freshProvider, freshResult, freshGrant, patient, appointment, slot, existing] = await Promise.all([transaction.get(providerRef), transaction.get(resultRef), transaction.get(grantRef), transaction.get(patientRef), transaction.get(appointmentRef), transaction.get(slotRef), transaction.get(proposalRef)]);
        if (!freshProvider.exists || freshProvider.get("type") !== "doctor" || freshProvider.get("status") !== "verified" || freshProvider.get("clinicalCredentialsVerified") !== true || !freshResult.exists || freshResult.get("providerUid") !== user.uid || !freshGrant.exists || freshGrant.get("providerUid") !== user.uid || freshGrant.get("status") !== "OPEN" || freshGrant.get("patientUid") !== patientUid || !patient.exists || patient.get("role") !== "patient" || !appointment.exists || appointment.get("patientUid") !== patientUid || appointment.get("providerUid") !== user.uid) throw new ApiRequestError(403, "follow-up-access-closed", "L’accès de suivi a été fermé ou n’est plus autorisé.");
        if (!slot.exists || slot.get("providerUid") !== user.uid || slot.get("status") !== "available") throw new ApiRequestError(409, "follow-up-slot-unavailable", "Ce créneau n’est plus disponible. Actualisez la liste.");
        const startMs = Date.parse(String(slot.get("startsAt") || ""));
        const endMs = Date.parse(String(slot.get("endsAt") || ""));
        if (!Number.isFinite(startMs) || startMs <= Date.now() || !Number.isFinite(endMs) || endMs - startMs !== 30 * 60_000) throw new ApiRequestError(409, "follow-up-slot-invalid", "La date du créneau n’est plus valide.");
        startsAt = new Date(startMs).toISOString();
        if (existing.exists) throw new ApiRequestError(409, "follow-up-proposal-conflict", "Ce créneau a déjà été proposé pour ce résultat.");
        transaction.create(proposalRef, { appointmentId, sourceResultId: resultId, patientUid, providerUid: user.uid, slotId, startsAt, note, status: "PENDING", createdAt: timestamp, updatedAt: timestamp });
        transaction.create(actionRef, { type: "APPOINTMENT", patientUid, providerUid: user.uid, providerName, proposalId, slotId, startsAt, createdAt: timestamp });
        transaction.create(auditRef, { actorUid: user.uid, action: "prescriber_patient_result_appointment_proposed", resultId, proposalId, createdAt: timestamp });
      });
      responsePayload = { ...responsePayload, proposalId, startsAt };
      notification = { eventKey: `patient-result:${resultId}:appointment:${proposalId}`, title: "Rendez-vous de suivi proposé", body: "Votre médecin vous propose un rendez-vous de suivi. Consultez votre espace NEXA pour voir le créneau.", url: `/rendez-vous/${encodeURIComponent(user.uid)}?slotId=${encodeURIComponent(slotId)}&proposalId=${encodeURIComponent(proposalId)}` };
    } else {
      await db.runTransaction(async (transaction) => {
        const [freshProvider, freshResult, freshGrant] = await Promise.all([transaction.get(providerRef), transaction.get(resultRef), transaction.get(grantRef)]);
        if (!freshProvider.exists || freshProvider.get("type") !== "doctor" || freshProvider.get("status") !== "verified" || freshProvider.get("clinicalCredentialsVerified") !== true || !freshResult.exists || freshResult.get("providerUid") !== user.uid || !freshGrant.exists || freshGrant.get("providerUid") !== user.uid || freshGrant.get("status") !== "OPEN") throw new ApiRequestError(403, "follow-up-access-closed", "L’accès de suivi a déjà été fermé ou n’est plus autorisé.");
        transaction.update(grantRef, { status: "CLOSED", closedAt: timestamp, closedBy: user.uid, updatedAt: timestamp });
        transaction.update(resultRef, { status: "FOLLOW_UP_CLOSED", followUpStatus: "CLOSED", updatedAt: timestamp });
        transaction.create(auditRef, { actorUid: user.uid, action: "prescriber_patient_result_follow_up_closed", resultId, createdAt: timestamp });
      });
      await createUserNotification({ uid: patientUid, eventKey: `patient-result:${resultId}:follow-up-closed`, type: "patient_result_follow_up_closed", title: "Suivi médical terminé", body: "Le médecin prescripteur a terminé le suivi de ce résultat.", url: "/espace#resultats", appointmentId });
      return json(request, { ...responsePayload, followUpStatus: "CLOSED" });
    }

    if (notification) await createUserNotification({ uid: patientUid, ...notification, type: action === "note" ? "patient_result_note_added" : action === "prescription" ? "prescription_received" : "appointment_proposed", appointmentId });
    return json(request, responsePayload, action === "note" || action === "prescription" || action === "appointment" ? 201 : 200);
  } catch (error) { return fail(request, error); }
}
