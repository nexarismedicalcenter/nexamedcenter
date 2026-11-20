import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";
import { cleanResultText } from "@/lib/diagnostic-results.server";
import { createUserNotification } from "@/lib/notifications.server";

type RouteContext = { params: Promise<{ resultId: string }> };

function errorResponse(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "diagnostic-result-transfer-failed";
  const message = error instanceof ApiRequestError ? error.message : "Le transfert du résultat au patient n’a pas abouti.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA diagnostic result transfer failed", error instanceof Error ? error.name : "unknown-error");
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
    const admin = await requireNexaAdministrator(request);
    const { resultId } = await context.params;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(resultId)) throw new ApiRequestError(400, "invalid-result-id", "La référence du résultat n’est pas valide.");
    const db = getFirebaseAdminDb();
    const resultRef = db.collection("diagnosticResults").doc(resultId);
    const result = await db.runTransaction(async (transaction) => {
      const resultSnapshot = await transaction.get(resultRef);
      if (!resultSnapshot.exists) throw new ApiRequestError(404, "diagnostic-result-not-found", "Ce résultat est introuvable.");
      const current = resultSnapshot.data() || {};
      if (current.status !== "VALIDATED" || current.examPerformed !== true || !Array.isArray(current.files) || !current.files.length || current.files.some((file: Record<string, unknown>) => file.antivirusStatus !== "CLEAN" || !String(file.storagePath || "").startsWith(`nexa-diagnostic-results/${current.orderId}/${resultId}/`))) throw new ApiRequestError(409, "diagnostic-result-not-transferable", "Le résultat doit être validé comme examen effectué avec tous les fichiers propres avant son transfert.");
      const orderRef = db.collection("nexaOrders").doc(cleanResultText(current.orderId, 200));
      const claimRef = db.collection("diagnosticResultClaims").doc(createHash("sha256").update(`${current.orderId}:${current.examLineId}`).digest("hex"));
      const [orderSnapshot, claimSnapshot] = await Promise.all([transaction.get(orderRef), transaction.get(claimRef)]);
      const order = orderSnapshot.data() || {};
      const claim = claimSnapshot.data() || {};
      if (!orderSnapshot.exists || !claimSnapshot.exists || claim.currentResultId !== resultId || order.patientUid !== current.patientUid || order.providerUid !== current.providerUid || order.kind !== current.providerType) throw new ApiRequestError(409, "diagnostic-result-order-mismatch", "Le patient, le centre ou la commande ne correspond plus au résultat.");
      const items = Array.isArray(order.items) ? order.items as Record<string, unknown>[] : [];
      if (items.filter((item) => item.offerId === current.examLineId).length !== 1) throw new ApiRequestError(409, "diagnostic-result-exam-mismatch", "L’examen ne correspond pas exactement à la commande.");
      const updatedItems = items.map((item) => item.offerId === current.examLineId ? { ...item, resultStatus: "RESULT_AVAILABLE", resultId } : item);
      const allResultsAvailable = updatedItems.every((item) => item.resultStatus === "RESULT_AVAILABLE");
      const now = FieldValue.serverTimestamp();
      transaction.update(resultRef, { status: "RESULT_AVAILABLE", patientTransferredAt: now, patientTransferredByUid: admin.uid, updatedAt: now, adminViewedAt: FieldValue.delete(), adminViewedByUid: FieldValue.delete(), adminViewedFileIds: FieldValue.delete() });
      transaction.update(orderRef, { items: updatedItems, ...(allResultsAvailable ? { status: "COMPLETED", completedAt: now } : {}), updatedAt: now });
      transaction.create(db.collection("diagnosticResultAuditLogs").doc(), { actorUid: admin.uid, action: "diagnostic_result_transferred_to_patient", orderId: current.orderId, examLineId: current.examLineId, resultId, createdAt: now });
      transaction.create(db.collection("nexaOrderEvents").doc(), { orderId: current.orderId, action: "DIAGNOSTIC_RESULT_AVAILABLE_TO_PATIENT", actorUid: admin.uid, createdAt: now });
      return { patientUid: String(current.patientUid || ""), orderId: String(current.orderId), examName: cleanResultText(current.examName, 180) };
    });
    if (result.patientUid) await createUserNotification({
      uid: result.patientUid,
      eventKey: `diagnostic-result-available:${resultId}`,
      type: "diagnostic_result_available",
      title: "Un résultat médical est disponible",
      body: "Connectez-vous à votre espace NEXA pour consulter le résultat vérifié.",
      url: "/espace#resultats",
    });
    return json(request, { ok: true, resultId, status: "RESULT_AVAILABLE", orderId: result.orderId, examName: result.examName });
  } catch (error) { return errorResponse(request, error); }
}

function json(request: Request, payload: Record<string, unknown>) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { headers });
}
