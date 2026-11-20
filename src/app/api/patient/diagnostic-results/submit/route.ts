import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb, getFirebaseAdminStorage } from "@/lib/firebase/admin";
import { createUserNotification } from "@/lib/notifications.server";
import { cleanPatientResultText, getPatientAge, readPatientResultExam, validatePatientResultFiles, type PatientResultExamType } from "@/lib/patient-result-submissions.server";
import { scanDiagnosticResultFile } from "@/lib/diagnostic-results.server";

export const maxDuration = 300;

type SessionFile = { id: string; category: string; fileName: string; contentType: string; expectedSize: number; storagePath: string };

function json(request: Request, body: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "patient-result-submit-failed";
  const message = error instanceof ApiRequestError ? error.message : "Le résultat n’a pas pu être remis au médecin prescripteur.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA patient result submit failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function millis(value: unknown) {
  return value && typeof value === "object" && "toMillis" in value && typeof value.toMillis === "function" ? Number(value.toMillis()) : 0;
}

async function closeFailedSession(db: FirebaseFirestore.Firestore, sessionId: string, patientUid: string, status: "SCAN_FAILED" | "REJECTED") {
  const sessionRef = db.collection("patientResultUploadSessions").doc(sessionId);
  const snapshot = await sessionRef.get();
  if (!snapshot.exists || snapshot.get("patientUid") !== patientUid || snapshot.get("status") !== "SCANNING") return;
  const claimRef = db.collection("patientResultClaims").doc(String(snapshot.get("claimId")));
  await db.runTransaction(async (transaction) => {
    const [freshSession, freshClaim] = await Promise.all([transaction.get(sessionRef), transaction.get(claimRef)]);
    if (!freshSession.exists || freshSession.get("patientUid") !== patientUid || freshSession.get("status") !== "SCANNING") return;
    transaction.update(sessionRef, { status, closedAt: FieldValue.serverTimestamp(), expiresAt: Timestamp.fromMillis(Date.now() + 15 * 60_000) });
    if (freshClaim.exists && freshClaim.get("sessionId") === sessionId) transaction.update(claimRef, {
      status: freshClaim.get("currentResultId") ? "SUBMITTED" : "AVAILABLE",
      sessionId: FieldValue.delete(), expiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp(),
    });
  });
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function POST(request: Request) {
  let db: ReturnType<typeof getFirebaseAdminDb> | null = null;
  let bucket: ReturnType<ReturnType<typeof getFirebaseAdminStorage>["bucket"]> | null = null;
  let userUid = "";
  let sessionId = "";
  const movedPaths: string[] = [];
  let quarantinedPaths: string[] = [];
  let ownsScanLock = false;
  let submitted = false;
  try {
    const user = await requireFirebaseUser(request);
    userUid = user.uid;
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "patient-result-submit", limit: 5, windowMs: 10 * 60_000 });
    const input = await request.json().catch(() => null);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new ApiRequestError(400, "invalid-request", "La demande de transmission n’est pas valide.");
    sessionId = cleanPatientResultText((input as Record<string, unknown>).uploadSessionId, 80);
    if (!/^[A-Za-z0-9_-]{10,80}$/.test(sessionId)) throw new ApiRequestError(400, "invalid-upload-session", "La session de dépôt n’est pas valide.");

    db = getFirebaseAdminDb();
    bucket = getFirebaseAdminStorage().bucket();
    const activeDb = db;
    const activeBucket = bucket;
    const sessionRef = db.collection("patientResultUploadSessions").doc(sessionId);
    const sessionSnapshot = await sessionRef.get();
    if (!sessionSnapshot.exists || sessionSnapshot.get("patientUid") !== user.uid || sessionSnapshot.get("status") !== "OPEN") throw new ApiRequestError(403, "upload-session-invalid", "La session de dépôt est expirée ou non autorisée. Sélectionnez à nouveau l’examen.");
    const session = sessionSnapshot.data() || {};
    const examType = session.examType as PatientResultExamType;
    if (!["laboratory", "imaging"].includes(examType)) throw new ApiRequestError(409, "upload-session-type-invalid", "Le type d’examen de la session n’est plus valide.");
    const files = Array.isArray(session.files) ? session.files as SessionFile[] : [];
    if (files.length >= 1 && files.length <= 20 && files.every((file) => /^[A-Za-z0-9_-]{10,80}$/.test(file.id) && file.storagePath === `nexa-patient-result-quarantine/${sessionId}/${file.id}`)) quarantinedPaths = files.map((file) => file.storagePath);
    if (millis(session.expiresAt) <= Date.now()) throw new ApiRequestError(403, "upload-session-expired", "La session de dépôt a expiré. Sélectionnez à nouveau l’examen.");
    if (files.length < 1 || files.length > 20 || files.some((file) => !/^[A-Za-z0-9_-]{10,80}$/.test(file.id) || file.storagePath !== `nexa-patient-result-quarantine/${sessionId}/${file.id}`)) throw new ApiRequestError(409, "upload-session-files-invalid", "Les fichiers attendus pour cette session ne sont pas valides.");

    const providerRef = db.collection("providerProfiles").doc(cleanPatientResultText(session.providerUid, 200));
    const patientRef = db.collection("patientProfiles").doc(user.uid);
    const prescriptionRef = db.collection("clinicalPrescriptions").doc(cleanPatientResultText(session.prescriptionId, 200));
    const appointmentRef = db.collection("appointments").doc(cleanPatientResultText(session.appointmentId, 200));
    const claimRef = db.collection("patientResultClaims").doc(cleanPatientResultText(session.claimId, 100));
    const resultRef = db.collection("patientSubmittedResults").doc(cleanPatientResultText(session.resultId, 200));
    const [provider, patient, prescription, appointment, claim] = await Promise.all([providerRef.get(), patientRef.get(), prescriptionRef.get(), appointmentRef.get(), claimRef.get()]);
    if (!patient.exists || patient.get("role") !== "patient" || patient.get("profileComplete") !== true) throw new ApiRequestError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
    if (!provider.exists || provider.get("type") !== "doctor" || provider.get("status") !== "verified" || provider.get("clinicalCredentialsVerified") !== true) throw new ApiRequestError(403, "prescribing-doctor-unavailable", "Le médecin prescripteur n’est plus autorisé à recevoir ce résultat.");
    if (!prescription.exists || prescription.get("patientUid") !== user.uid || prescription.get("providerUid") !== session.providerUid || prescription.get("appointmentId") !== session.appointmentId || prescription.get("status") !== "VALIDATED") throw new ApiRequestError(409, "prescription-changed", "L’ordonnance n’est plus active pour ce dépôt.");
    if (!appointment.exists || appointment.get("patientUid") !== user.uid || appointment.get("providerUid") !== session.providerUid || appointment.get("providerType") !== "doctor" || appointment.get("paymentStatus") !== "PAID" || !["IN_PROGRESS", "COMPLETED"].includes(String(appointment.get("status") || "").toUpperCase())) throw new ApiRequestError(409, "prescription-encounter-invalid", "La prise en charge liée à cette ordonnance n’est plus valide.");
    const examName = readPatientResultExam(prescription.data() || {}, examType, Number(session.examIndex));
    if (examName !== session.examName || !claim.exists || claim.get("sessionId") !== sessionId || claim.get("status") !== "OPEN") throw new ApiRequestError(409, "result-upload-claim-lost", "Le dépôt n’est plus associé à l’examen prescrit sélectionné.");
    validatePatientResultFiles(files.map((file) => ({ category: file.category, fileName: file.fileName, contentType: file.contentType, size: file.expectedSize })), examType);

    await activeDb.runTransaction(async (transaction) => {
      const [freshSession, freshClaim, freshResult] = await Promise.all([transaction.get(sessionRef), transaction.get(claimRef), transaction.get(resultRef)]);
      if (!freshSession.exists || freshSession.get("patientUid") !== user.uid || freshSession.get("status") !== "OPEN" || freshClaim.get("sessionId") !== sessionId || freshClaim.get("status") !== "OPEN" || freshResult.exists) throw new ApiRequestError(409, "result-upload-session-conflict", "La session a expiré ou a déjà été utilisée.");
      transaction.update(sessionRef, { status: "SCANNING", scanningStartedAt: FieldValue.serverTimestamp() });
      transaction.update(claimRef, { status: "SCANNING", updatedAt: FieldValue.serverTimestamp() });
    });
    ownsScanLock = true;

    const storedFiles = await Promise.all(files.map(async (file) => {
      const object = activeBucket.file(file.storagePath);
      const [exists] = await object.exists();
      if (!exists) throw new ApiRequestError(400, "result-file-missing", "Un fichier sélectionné n’a pas été téléversé.");
      const [metadata] = await object.getMetadata();
      const size = Number(metadata.size || 0);
      const contentType = String(metadata.contentType || "").toLowerCase();
      const custom = metadata.metadata && typeof metadata.metadata === "object" ? metadata.metadata as Record<string, unknown> : {};
      const downloadToken = Object.entries(custom).find(([key]) => key.toLowerCase() === "firebasestoragedownloadtokens")?.[1];
      if (contentType !== file.contentType || size !== file.expectedSize || size < 1 || size > 15 * 1024 * 1024 || (typeof downloadToken === "string" && downloadToken.length > 0)) throw new ApiRequestError(400, "result-file-metadata-invalid", "Un fichier ne correspond pas à son type ou sa taille attendue.");
      return { ...file, size, contentType, md5Hash: typeof metadata.md5Hash === "string" ? metadata.md5Hash : null };
    }));
    const hashes = new Set<string>();
    for (const file of storedFiles) {
      if (file.md5Hash && hashes.has(file.md5Hash)) throw new ApiRequestError(409, "duplicate-result-file", "Le même fichier a été sélectionné plusieurs fois.");
      if (file.md5Hash) hashes.add(file.md5Hash);
    }
    const scanResults = new Array<{ scannerVersion: string | null }>(storedFiles.length);
    let cursor = 0;
    let scanFailure: unknown;
    const scanWorker = async () => {
      while (!scanFailure) {
        const index = cursor++;
        if (index >= storedFiles.length) return;
        try {
          const [contents] = await activeBucket.file(storedFiles[index].storagePath).download();
          scanResults[index] = await scanDiagnosticResultFile({ fileBuffer: contents, contentType: storedFiles[index].contentType });
        } catch (error) { scanFailure ||= error; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, storedFiles.length) }, () => scanWorker()));
    if (scanFailure) throw scanFailure;

    if (!/^[A-Za-z0-9_-]{10,200}$/.test(resultRef.id) || (await resultRef.get()).exists) throw new ApiRequestError(409, "patient-result-already-submitted", "Un résultat a déjà été transmis pour cette session.");
    const resultFiles: Record<string, unknown>[] = [];
    for (let index = 0; index < storedFiles.length; index += 1) {
      const file = storedFiles[index];
      const destination = `nexa-patient-submitted-results/${user.uid}/${resultRef.id}/${file.id}`;
      await activeBucket.file(file.storagePath).move(destination);
      movedPaths.push(destination);
      await activeBucket.file(destination).setMetadata({
        contentType: file.contentType,
        cacheControl: "private, no-store",
        metadata: { nexaScanStatus: "CLEAN", firebaseStorageDownloadTokens: "" },
      });
      resultFiles.push({ id: file.id, category: file.category, storagePath: destination, fileName: file.fileName, contentType: file.contentType, size: file.size, md5Hash: file.md5Hash, antivirusStatus: "CLEAN", antivirusScannerVersion: scanResults[index].scannerVersion, antivirusScannedAt: new Date().toISOString() });
    }

    const profileData = patient.data() || {};
    const patientName = cleanPatientResultText(profileData.displayName || `${profileData.firstName || ""} ${profileData.lastName || ""}`.trim(), 140);
    const patientNumber = cleanPatientResultText(profileData.patientNumber, 32);
    const notificationIdentity = [patientName || "Patient NEXA", patientNumber, cleanPatientResultText(profileData.sex, 32), getPatientAge(profileData.birthDate) === null ? "" : `${getPatientAge(profileData.birthDate)} ans`].filter(Boolean).join(" · ");
    const grantRef = activeDb.collection("patientResultFollowUpGrants").doc(resultRef.id);
    const auditRef = activeDb.collection("patientResultAuditLogs").doc();
    const now = FieldValue.serverTimestamp();
    await activeDb.runTransaction(async (transaction) => {
      const [freshPatient, freshProvider, freshPrescription, freshAppointment, freshSession, freshClaim, freshResult] = await Promise.all([
        transaction.get(patientRef), transaction.get(providerRef), transaction.get(prescriptionRef), transaction.get(appointmentRef), transaction.get(sessionRef), transaction.get(claimRef), transaction.get(resultRef),
      ]);
      const currentExam = freshPrescription.exists ? readPatientResultExam(freshPrescription.data() || {}, examType, Number(session.examIndex)) : "";
      if (!freshPatient.exists || freshPatient.get("role") !== "patient" || freshPatient.get("profileComplete") !== true || !freshProvider.exists || freshProvider.get("type") !== "doctor" || freshProvider.get("status") !== "verified" || freshProvider.get("clinicalCredentialsVerified") !== true || !freshPrescription.exists || freshPrescription.get("status") !== "VALIDATED" || freshPrescription.get("patientUid") !== user.uid || freshPrescription.get("providerUid") !== session.providerUid || freshPrescription.get("appointmentId") !== session.appointmentId || currentExam !== session.examName || !freshAppointment.exists || freshAppointment.get("patientUid") !== user.uid || freshAppointment.get("providerUid") !== session.providerUid || freshAppointment.get("providerType") !== "doctor" || freshAppointment.get("paymentStatus") !== "PAID" || !["IN_PROGRESS", "COMPLETED"].includes(String(freshAppointment.get("status") || "").toUpperCase())) throw new ApiRequestError(409, "result-authorization-changed", "L’ordonnance ou l’autorisation du médecin a changé pendant l’analyse.");
      if (!freshSession.exists || freshSession.get("status") !== "SCANNING" || freshSession.get("patientUid") !== user.uid || !freshClaim.exists || freshClaim.get("sessionId") !== sessionId || freshClaim.get("status") !== "SCANNING" || freshResult.exists) throw new ApiRequestError(409, "result-upload-session-conflict", "La session de résultat a expiré ou a déjà été utilisée.");
      transaction.create(resultRef, {
        patientUid: user.uid,
        patientNumber,
        providerUid: session.providerUid,
        appointmentId: session.appointmentId,
        prescriptionId: session.prescriptionId,
        examType,
        examIndex: Number(session.examIndex),
        examName: session.examName,
        files: resultFiles,
        status: "AVAILABLE_TO_PRESCRIBER",
        createdAt: now,
        updatedAt: now,
      });
      transaction.create(grantRef, {
        resultId: resultRef.id,
        patientUid: user.uid,
        providerUid: session.providerUid,
        appointmentId: session.appointmentId,
        prescriptionId: session.prescriptionId,
        status: "OPEN",
        allowedActions: ["note", "prescription", "appointment"],
        createdAt: now,
        closedAt: null,
      });
      transaction.update(sessionRef, { status: "SUBMITTED", submittedAt: now });
      transaction.update(claimRef, { status: "SUBMITTED", resultId: resultRef.id, sessionId: FieldValue.delete(), expiresAt: FieldValue.delete(), updatedAt: now });
      transaction.create(auditRef, { actorUid: user.uid, providerUid: session.providerUid, action: "patient_diagnostic_result_submitted", resultId: resultRef.id, fileCount: resultFiles.length, createdAt: now });
    });
    submitted = true;
    await createUserNotification({
      uid: String(session.providerUid), eventKey: `patient-result:${resultRef.id}:available`, type: "patient_result_available",
      title: "Résultat médical disponible",
      body: `Un résultat est disponible pour ${notificationIdentity}. Ouvrez votre espace NEXA pour le consulter.`,
      url: "/professionnels/espace#resultats-patient", appointmentId: String(session.appointmentId),
    });
    return json(request, { ok: true, resultId: resultRef.id, status: "AVAILABLE_TO_PRESCRIBER", message: "Votre résultat est sécurisé et transmis au médecin qui a prescrit cet examen." }, 201);
  } catch (error) {
    if (!submitted && ownsScanLock && userUid && sessionId) {
      if (bucket) await Promise.allSettled([...quarantinedPaths, ...movedPaths].map((path) => bucket?.file(path).delete({ ignoreNotFound: true })));
      const status = error instanceof ApiRequestError && error.code === "malware-detected" ? "REJECTED" : "SCAN_FAILED";
      try { if (db) await closeFailedSession(db, sessionId, userUid, status); }
      catch (cleanupError) { console.error("NEXA patient result quarantine cleanup failed", cleanupError instanceof Error ? cleanupError.name : "unknown-error"); }
    }
    return fail(request, error);
  }
}
