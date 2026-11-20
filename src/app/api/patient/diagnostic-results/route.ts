import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { cleanResultText } from "@/lib/diagnostic-results.server";
import { cleanPatientResultText, isoPatientResultDate, patientResultClaimId, readPatientResultExam, type PatientResultExamType } from "@/lib/patient-result-submissions.server";

function json(request: Request, payload: Record<string, unknown>) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "patient-diagnostic-results-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Vos résultats médicaux ne sont pas accessibles pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA patient diagnostic results failed", error instanceof Error ? error.name : "unknown-error");
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
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    await enforceUserRateLimit({ uid: user.uid, action: "patient-diagnostic-results-read", limit: 40, windowMs: 60_000 });
    const db = getFirebaseAdminDb();
    const profile = await db.collection("patientProfiles").doc(user.uid).get();
    if (!profile.exists || profile.get("role") !== "patient" || profile.get("profileComplete") !== true) throw new ApiRequestError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
    const [partnerSnapshot, submittedSnapshot, prescriptionSnapshot, claimSnapshot] = await Promise.all([
      db.collection("diagnosticResults").where("patientUid", "==", user.uid).where("status", "==", "RESULT_AVAILABLE").orderBy("createdAt", "desc").limit(50).get(),
      db.collection("patientSubmittedResults").where("patientUid", "==", user.uid).orderBy("createdAt", "desc").limit(50).get(),
      db.collection("clinicalPrescriptions").where("patientUid", "==", user.uid).where("status", "==", "VALIDATED").orderBy("validatedAt", "desc").limit(100).get(),
      db.collection("patientResultClaims").where("patientUid", "==", user.uid).limit(500).get(),
    ]);
    const results = partnerSnapshot.docs.map((doc) => {
      const data = doc.data();
      const files = Array.isArray(data.files) ? data.files.filter((file) => file && typeof file === "object" && file.antivirusStatus === "CLEAN").map((file) => ({
        id: cleanResultText(file.id, 100),
        category: cleanResultText(file.category, 40),
        fileName: cleanResultText(file.fileName, 180),
        contentType: cleanResultText(file.contentType, 100),
        size: Number(file.size) || 0,
      })) : [];
      return {
        id: doc.id,
        source: "NEXA_PARTNER",
        orderId: cleanResultText(data.orderId, 200),
        orderNumber: cleanResultText(data.orderNumber, 80),
        examName: cleanResultText(data.examName, 180),
        providerName: cleanResultText(data.providerName, 120) || "Centre NEXA",
        providerType: cleanResultText(data.providerType, 20),
        version: Number(data.version) || 1,
        performedAt: cleanResultText(data.performedAt, 10),
        transferredAt: data.patientTransferredAt && typeof data.patientTransferredAt.toDate === "function" ? data.patientTransferredAt.toDate().toISOString() : null,
        files,
      };
    }).filter((result) => result.files.length > 0);
    const patientResultsRaw = await Promise.all(submittedSnapshot.docs.map(async (doc) => {
      const data = doc.data();
      const files = Array.isArray(data.files) ? data.files.filter((file) => file && typeof file === "object" && file.antivirusStatus === "CLEAN").map((file) => ({
        id: cleanPatientResultText(file.id, 100),
        category: cleanPatientResultText(file.category, 40),
        fileName: cleanPatientResultText(file.fileName, 180),
        contentType: cleanPatientResultText(file.contentType, 100),
        size: Number(file.size) || 0,
      })) : [];
      const actionsSnapshot = await doc.ref.collection("followUpActions").orderBy("createdAt", "desc").limit(20).get();
      const followUpActions = actionsSnapshot.docs.map((actionDoc) => {
        const action = actionDoc.data();
        return {
          id: actionDoc.id,
          type: cleanPatientResultText(action.type, 30),
          content: action.type === "NOTE" ? cleanPatientResultText(action.content, 5_000) : "",
          providerName: cleanPatientResultText(action.providerName, 180),
          providerUid: cleanPatientResultText(action.providerUid, 200),
          slotId: cleanPatientResultText(action.slotId, 80),
          recordId: cleanPatientResultText(action.recordId, 200),
          recordNumber: cleanPatientResultText(action.recordNumber, 100),
          startsAt: isoPatientResultDate(action.startsAt),
          createdAt: isoPatientResultDate(action.createdAt),
        };
      });
      return {
        id: doc.id,
        source: "PATIENT_UPLOAD",
        examName: cleanPatientResultText(data.examName, 250) || "Résultat médical",
        providerName: "Transmis au médecin prescripteur",
        providerType: cleanPatientResultText(data.examType, 20),
        version: 1,
        performedAt: null,
        transferredAt: isoPatientResultDate(data.createdAt),
        followUpStatus: cleanPatientResultText(data.status, 40),
        followUpActions,
        files,
      };
    }));
    const patientResults = patientResultsRaw.filter((result) => result.files.length > 0);
    const claims = new Map(claimSnapshot.docs.map((doc) => [doc.id, doc.data()]));
    const uploadableExams: Record<string, unknown>[] = [];
    for (const prescriptionDoc of prescriptionSnapshot.docs) {
      const prescription = prescriptionDoc.data();
      for (const [examType, field] of [["laboratory", "labExams"], ["imaging", "imagingExams"]] as const) {
        const examValues = Array.isArray(prescription[field]) ? prescription[field] as unknown[] : [];
        for (let examIndex = 0; examIndex < Math.min(examValues.length, 50); examIndex += 1) {
          const claimId = patientResultClaimId(prescriptionDoc.id, examType as PatientResultExamType, examIndex);
          const claim = claims.get(claimId);
          const isAvailable = !claim || claim.status === "AVAILABLE" || (claim.status === "OPEN" && Number(claim.expiresAt?.toMillis?.() || 0) <= Date.now());
          if (!isAvailable) continue;
          const examName = readPatientResultExam(prescription, examType, examIndex);
          uploadableExams.push({
            prescriptionId: prescriptionDoc.id,
            appointmentId: cleanPatientResultText(prescription.appointmentId, 200),
            examType,
            examIndex,
            examName,
            providerName: cleanPatientResultText(prescription.providerName, 180) || "Médecin NEXA",
            specialtyName: cleanPatientResultText(prescription.specialtyName, 160),
          });
        }
      }
    }
    return json(request, { ok: true, results: [...results, ...patientResults].sort((left, right) => String(right.transferredAt || "").localeCompare(String(left.transferredAt || ""))).slice(0, 100), uploadableExams });
  } catch (error) { return fail(request, error); }
}
