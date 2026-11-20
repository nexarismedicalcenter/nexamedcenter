import { randomBytes } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb, getFirebaseAdminStorage } from "@/lib/firebase/admin";
import { cleanPatientResultText, patientResultClaimId, readPatientResultExam, validatePatientResultFiles, type PatientResultExamType } from "@/lib/patient-result-submissions.server";

const SESSION_MINUTES = 20;

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "patient-result-upload-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le dépôt sécurisé du résultat n’est pas disponible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA patient result upload session failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "patient-result-upload-start", limit: 5, windowMs: 10 * 60_000 });
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 32_768) throw new ApiRequestError(413, "request-too-large", "La liste des fichiers est trop volumineuse.");
    let body: unknown;
    try { body = JSON.parse(raw); } catch { throw new ApiRequestError(400, "invalid-request", "La demande de dépôt n’est pas valide."); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande de dépôt n’est pas valide.");
    const input = body as Record<string, unknown>;
    const prescriptionId = cleanPatientResultText(input.prescriptionId, 200);
    const examType = input.examType;
    const examIndex = input.examIndex;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(prescriptionId) || !["laboratory", "imaging"].includes(String(examType)) || !Number.isSafeInteger(examIndex)) {
      throw new ApiRequestError(400, "invalid-prescribed-exam", "L’examen prescrit sélectionné n’est pas valide.");
    }
    if (input.confirmMatch !== true) throw new ApiRequestError(400, "result-confirmation-required", "Confirmez que les documents correspondent au patient et à l’examen prescrit affiché.");
    const selectedType = examType as PatientResultExamType;
    const files = validatePatientResultFiles(input.files, selectedType);
    const db = getFirebaseAdminDb();
    const patientRef = db.collection("patientProfiles").doc(user.uid);
    const prescriptionRef = db.collection("clinicalPrescriptions").doc(prescriptionId);
    const claimId = patientResultClaimId(prescriptionId, selectedType, Number(examIndex));
    const claimRef = db.collection("patientResultClaims").doc(claimId);
    const sessionRef = db.collection("patientResultUploadSessions").doc();
    const resultRef = db.collection("patientSubmittedResults").doc();
    const expiresAtMs = Date.now() + SESSION_MINUTES * 60_000;

    const upload = await db.runTransaction(async (transaction) => {
      const [patientSnapshot, prescriptionSnapshot, claimSnapshot] = await Promise.all([
        transaction.get(patientRef), transaction.get(prescriptionRef), transaction.get(claimRef),
      ]);
      if (!patientSnapshot.exists || patientSnapshot.get("role") !== "patient" || patientSnapshot.get("profileComplete") !== true) {
        throw new ApiRequestError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
      }
      if (!prescriptionSnapshot.exists || prescriptionSnapshot.get("status") !== "VALIDATED" || prescriptionSnapshot.get("patientUid") !== user.uid) {
        throw new ApiRequestError(404, "prescription-not-found", "Aucune ordonnance active ne correspond à cet examen.");
      }
      const prescription = prescriptionSnapshot.data() || {};
      const providerUid = cleanPatientResultText(prescription.providerUid, 200);
      const appointmentId = cleanPatientResultText(prescription.appointmentId, 200);
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(providerUid) || !/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) {
        throw new ApiRequestError(409, "prescription-link-invalid", "L’ordonnance n’est pas liée à une prise en charge valide.");
      }
      const activeAppointmentRef = db.collection("appointments").doc(appointmentId);
      const activeProviderRef = db.collection("providerProfiles").doc(providerUid);
      const [appointmentSnapshot, providerSnapshot] = await Promise.all([
        transaction.get(activeAppointmentRef), transaction.get(activeProviderRef),
      ]);
      if (!appointmentSnapshot.exists || appointmentSnapshot.get("patientUid") !== user.uid || appointmentSnapshot.get("providerUid") !== providerUid || appointmentSnapshot.get("providerType") !== "doctor" || appointmentSnapshot.get("paymentStatus") !== "PAID" || !["IN_PROGRESS", "COMPLETED"].includes(String(appointmentSnapshot.get("status") || "").toUpperCase())) {
        throw new ApiRequestError(409, "prescription-encounter-invalid", "L’ordonnance n’est plus liée à une consultation NEXA admissible.");
      }
      if (!providerSnapshot.exists || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("clinicalCredentialsVerified") !== true) {
        throw new ApiRequestError(403, "prescribing-doctor-unavailable", "Le médecin prescripteur n’est plus autorisé à recevoir ce résultat.");
      }
      const examName = readPatientResultExam(prescription, selectedType, Number(examIndex));
      const claim = claimSnapshot.data() || {};
      if (claimSnapshot.exists && claim.status === "SUBMITTED") throw new ApiRequestError(409, "result-already-uploaded", "Un résultat a déjà été envoyé pour cet examen prescrit.");
      if (claimSnapshot.exists && claim.status === "OPEN" && typeof claim.sessionId === "string") {
        const activeSessionRef = db.collection("patientResultUploadSessions").doc(claim.sessionId);
        const activeSessionSnapshot = await transaction.get(activeSessionRef);
        const activeExpiry = activeSessionSnapshot.get("expiresAt") as Timestamp | undefined;
        if (activeSessionSnapshot.exists && activeSessionSnapshot.get("status") === "OPEN" && (activeExpiry?.toMillis() || 0) > Date.now()) {
          throw new ApiRequestError(409, "result-upload-already-open", "Un dépôt est déjà ouvert pour cet examen. Terminez-le ou réessayez après son expiration.");
        }
      }
      const fileEntries = files.map((file, index) => {
        const extension = file.contentType === "application/pdf" ? "pdf" : file.contentType === "image/jpeg" ? "jpg" : "png";
        const id = randomBytes(18).toString("base64url");
        return {
          id,
          category: file.category,
          fileName: `${selectedType === "laboratory" ? "laboratoire" : "imagerie"}-${index + 1}.${extension}`,
          contentType: file.contentType,
          expectedSize: file.size,
          storagePath: `nexa-patient-result-quarantine/${sessionRef.id}/${id}`,
        };
      });
      const now = FieldValue.serverTimestamp();
      transaction.create(sessionRef, {
        patientUid: user.uid,
        providerUid,
        appointmentId,
        prescriptionId,
        examType: selectedType,
        examIndex: Number(examIndex),
        examName,
        claimId,
        resultId: resultRef.id,
        files: fileEntries,
        status: "OPEN",
        createdAt: now,
        expiresAt: Timestamp.fromMillis(expiresAtMs),
      });
      transaction.set(claimRef, {
        patientUid: user.uid,
        providerUid,
        prescriptionId,
        examType: selectedType,
        examIndex: Number(examIndex),
        status: "OPEN",
        sessionId: sessionRef.id,
        resultId: resultRef.id,
        updatedAt: now,
        expiresAt: Timestamp.fromMillis(expiresAtMs),
      }, { merge: true });
      return { providerUid, appointmentId, examName, fileEntries, sessionId: sessionRef.id, resultId: resultRef.id };
    });

    const bucket = getFirebaseAdminStorage().bucket();
    let uploads: Record<string, unknown>[];
    try {
      uploads = await Promise.all(upload.fileEntries.map(async (file) => {
        const [policy] = await bucket.file(file.storagePath).generateSignedPostPolicyV4({
          expires: Date.now() + 10 * 60_000,
          fields: {
            "Content-Type": file.contentType,
            success_action_status: "201",
            "x-goog-if-generation-match": "0",
            "x-goog-meta-firebasestoragedownloadtokens": "",
          },
          conditions: [
            ["content-length-range", 1, 15 * 1024 * 1024],
            ["eq", "$key", file.storagePath],
            ["eq", "$Content-Type", file.contentType],
            ["eq", "$success_action_status", "201"],
            ["eq", "$x-goog-if-generation-match", "0"],
            ["eq", "$x-goog-meta-firebasestoragedownloadtokens", ""],
          ],
        });
        return { fileId: file.id, category: file.category, fileName: file.fileName, contentType: file.contentType, expectedSize: file.expectedSize, uploadUrl: policy.url, fields: policy.fields };
      }));
    } catch {
      await db.runTransaction(async (transaction) => {
        const [sessionSnapshot, claimSnapshot] = await Promise.all([transaction.get(sessionRef), transaction.get(claimRef)]);
        if (sessionSnapshot.exists && sessionSnapshot.get("patientUid") === user.uid && sessionSnapshot.get("status") === "OPEN") transaction.update(sessionRef, { status: "FAILED", closedAt: FieldValue.serverTimestamp(), expiresAt: Timestamp.now() });
        if (claimSnapshot.exists && claimSnapshot.get("sessionId") === sessionRef.id) transaction.update(claimRef, { status: "AVAILABLE", sessionId: FieldValue.delete(), expiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
      });
      throw new ApiRequestError(503, "secure-upload-unavailable", "Le téléversement sécurisé est indisponible. Aucun résultat n’a été transmis; réessayez plus tard.");
    }
    return json(request, { ok: true, uploadSessionId: upload.sessionId, resultId: upload.resultId, examName: upload.examName, files: uploads }, 201);
  } catch (error) { return fail(request, error); }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "patient-result-upload-cancel", limit: 10, windowMs: 10 * 60_000 });
    const body = await request.json().catch(() => null);
    const sessionId = body && typeof body === "object" && !Array.isArray(body) ? cleanPatientResultText((body as Record<string, unknown>).uploadSessionId, 80) : "";
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(sessionId)) throw new ApiRequestError(400, "invalid-upload-session", "La session de dépôt n’est pas valide.");
    const db = getFirebaseAdminDb();
    const sessionRef = db.collection("patientResultUploadSessions").doc(sessionId);
    const sessionSnapshot = await sessionRef.get();
    if (!sessionSnapshot.exists || sessionSnapshot.get("patientUid") !== user.uid || sessionSnapshot.get("status") !== "OPEN") throw new ApiRequestError(404, "upload-session-not-found", "Cette session de dépôt n’est plus active.");
    const claimId = cleanPatientResultText(sessionSnapshot.get("claimId"), 100);
    const claimRef = db.collection("patientResultClaims").doc(claimId);
    await db.runTransaction(async (transaction) => {
      const [freshSession, freshClaim] = await Promise.all([transaction.get(sessionRef), transaction.get(claimRef)]);
      if (!freshSession.exists || freshSession.get("patientUid") !== user.uid || freshSession.get("status") !== "OPEN") throw new ApiRequestError(409, "upload-session-closed", "La session de dépôt a déjà été fermée.");
      transaction.update(sessionRef, { status: "CANCELLED", closedAt: FieldValue.serverTimestamp(), expiresAt: Timestamp.now() });
      if (freshClaim.exists && freshClaim.get("sessionId") === sessionId) transaction.update(claimRef, { status: "AVAILABLE", sessionId: FieldValue.delete(), expiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
    });
    const files = Array.isArray(sessionSnapshot.get("files")) ? sessionSnapshot.get("files") as Array<Record<string, unknown>> : [];
    await Promise.allSettled(files.map((file) => typeof file.storagePath === "string" ? getFirebaseAdminStorage().bucket().file(file.storagePath).delete({ ignoreNotFound: true }) : Promise.resolve()));
    return json(request, { ok: true });
  } catch (error) { return fail(request, error); }
}
