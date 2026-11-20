import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireNexaAdministrator } from "@/lib/auth/server";
import { enforceUserRateLimit } from "@/lib/auth/rate-limit.server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

const PAGE_SIZE = 50;
const ISSUE_STATUSES = new Set(["OPEN", "RESOLVED", "ALL"]);

function json(request: Request, payload: Record<string, unknown>, status = 200) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(payload, { status, headers });
}

function fail(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "diagnostic-result-issues-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "Le suivi des anomalies de résultats n’est pas accessible.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA diagnostic result issue review failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function clean(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function iso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).toISOString();
  return null;
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-diagnostic-result-issue-list", limit: 30, windowMs: 60_000 });
    const params = new URL(request.url).searchParams;
    const status = (params.get("status") || "OPEN").toUpperCase();
    const cursor = params.get("cursor") || "";
    if (!ISSUE_STATUSES.has(status)) throw new ApiRequestError(400, "invalid-diagnostic-issue-status", "Le filtre d’anomalies n’est pas valide.");
    if (cursor && !/^[A-Za-z0-9_-]{10,200}$/.test(cursor)) throw new ApiRequestError(400, "invalid-diagnostic-issue-cursor", "Le curseur de la liste n’est pas valide.");

    const db = getFirebaseAdminDb();
    const collection = db.collection("diagnosticResultIssues");
    let query = collection.orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc");
    if (status !== "ALL") query = query.where("status", "==", status);
    if (cursor) {
      const cursorSnapshot = await collection.doc(cursor).get();
      if (!cursorSnapshot.exists || (status !== "ALL" && cursorSnapshot.get("status") !== status)) {
        throw new ApiRequestError(400, "invalid-diagnostic-issue-cursor", "Le curseur ne correspond pas à ce filtre.");
      }
      query = query.startAfter(cursorSnapshot);
    }

    const snapshot = await query.limit(PAGE_SIZE + 1).get();
    const page = snapshot.docs.slice(0, PAGE_SIZE);
    const issues = page.map((doc) => ({
      id: doc.id,
      resultId: clean(doc.get("resultId"), 200),
      orderId: clean(doc.get("orderId"), 200),
      examLineId: clean(doc.get("examLineId"), 200),
      partnerUid: clean(doc.get("partnerUid"), 128),
      providerType: clean(doc.get("providerType"), 20),
      actorUid: clean(doc.get("actorUid"), 128),
      issueReason: clean(doc.get("issueReason"), 1000),
      status: clean(doc.get("status"), 20),
      createdAt: iso(doc.get("createdAt")),
      resolutionReason: clean(doc.get("resolutionReason"), 1000),
      resolvedByUid: clean(doc.get("resolvedByUid"), 128),
      resolvedAt: iso(doc.get("resolvedAt")),
    }));
    await db.collection("adminAuditLogs").add({
      actorUid: admin.uid,
      action: "diagnostic_result_issues_listed",
      resource: "diagnosticResultIssues",
      count: issues.length,
      status,
      createdAt: FieldValue.serverTimestamp(),
    });
    return json(request, { ok: true, issues, nextCursor: snapshot.docs.length > PAGE_SIZE ? page.at(-1)?.id || null : null });
  } catch (error) { return fail(request, error); }
}

export async function POST(request: Request) {
  try {
    const admin = await requireNexaAdministrator(request);
    await enforceUserRateLimit({ uid: admin.uid, action: "admin-diagnostic-result-issue-write", limit: 20, windowMs: 60_000 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiRequestError(400, "invalid-request", "La demande de suivi est invalide.");
    const input = body as Record<string, unknown>;
    const action = clean(input.action, 20).toUpperCase();
    const reason = clean(input.reason, 1000);
    if (reason.length < 5) throw new ApiRequestError(400, "diagnostic-issue-reason-required", "Un motif de suivi d’au moins cinq caractères est requis.");

    const db = getFirebaseAdminDb();
    if (action === "CREATE") {
      const resultId = clean(input.resultId, 200);
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(resultId)) throw new ApiRequestError(400, "invalid-diagnostic-result-id", "La référence du résultat n’est pas valide.");
      const issueRef = db.collection("diagnosticResultIssues").doc();
      const auditRef = db.collection("adminAuditLogs").doc();
      const resultRef = db.collection("diagnosticResults").doc(resultId);
      const created = await db.runTransaction(async (transaction) => {
        const resultSnapshot = await transaction.get(resultRef);
        if (!resultSnapshot.exists) throw new ApiRequestError(404, "diagnostic-result-not-found", "Ce résultat est introuvable.");
        const result = resultSnapshot.data() || {};
        const orderId = clean(result.orderId, 200);
        const examLineId = clean(result.examLineId, 200);
        const partnerUid = clean(result.providerUid, 128);
        const providerType = clean(result.providerType, 20);
        const patientUid = clean(result.patientUid, 128);
        if (!/^[A-Za-z0-9_-]{10,200}$/.test(orderId) || !/^[A-Za-z0-9_-]{1,200}$/.test(examLineId) || !/^[A-Za-z0-9_-]{1,128}$/.test(partnerUid) || !["laboratory", "imaging"].includes(providerType) || !patientUid) {
          throw new ApiRequestError(409, "diagnostic-result-link-invalid", "Le résultat n’est pas correctement relié à un centre et une commande NEXA.");
        }
        const orderRef = db.collection("nexaOrders").doc(orderId);
        const orderSnapshot = await transaction.get(orderRef);
        const order = orderSnapshot.data() || {};
        const matchingItems = Array.isArray(order.items) ? order.items.filter((item: unknown) => item && typeof item === "object" && (item as Record<string, unknown>).offerId === examLineId) : [];
        if (!orderSnapshot.exists || order.providerUid !== partnerUid || order.kind !== providerType || order.patientUid !== patientUid || matchingItems.length !== 1) {
          throw new ApiRequestError(409, "diagnostic-result-order-mismatch", "Le résultat, son centre et sa commande ne correspondent plus.");
        }
        const now = FieldValue.serverTimestamp();
        transaction.create(issueRef, {
          resultId,
          orderId,
          examLineId,
          partnerUid,
          providerType,
          actorUid: admin.uid,
          issueReason: reason,
          title: "Anomalie signalée sur un résultat",
          status: "OPEN",
          createdAt: now,
          updatedAt: now,
        });
        transaction.create(auditRef, {
          actorUid: admin.uid,
          action: "diagnostic_result_issue_reported",
          resource: `diagnosticResultIssues/${issueRef.id}`,
          resultId,
          orderId,
          createdAt: now,
        });
        return { issueId: issueRef.id, orderId };
      });
      return json(request, { ok: true, issueId: created.issueId, status: "OPEN" }, 201);
    }

    if (action === "RESOLVE") {
      const issueId = clean(input.issueId, 200);
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(issueId)) throw new ApiRequestError(400, "invalid-diagnostic-issue-id", "La référence de l’anomalie n’est pas valide.");
      const issueRef = db.collection("diagnosticResultIssues").doc(issueId);
      const auditRef = db.collection("adminAuditLogs").doc();
      await db.runTransaction(async (transaction) => {
        const issueSnapshot = await transaction.get(issueRef);
        if (!issueSnapshot.exists) throw new ApiRequestError(404, "diagnostic-issue-not-found", "Cette anomalie n’existe pas.");
        if (issueSnapshot.get("status") !== "OPEN") throw new ApiRequestError(409, "diagnostic-issue-already-resolved", "Cette anomalie est déjà clôturée.");
        const now = FieldValue.serverTimestamp();
        transaction.update(issueRef, { status: "RESOLVED", resolutionReason: reason, resolvedByUid: admin.uid, resolvedAt: now, updatedAt: now });
        transaction.create(auditRef, {
          actorUid: admin.uid,
          action: "diagnostic_result_issue_resolved",
          resource: `diagnosticResultIssues/${issueId}`,
          resultId: clean(issueSnapshot.get("resultId"), 200),
          orderId: clean(issueSnapshot.get("orderId"), 200),
          createdAt: now,
        });
      });
      return json(request, { ok: true, issueId, status: "RESOLVED" });
    }

    throw new ApiRequestError(400, "invalid-diagnostic-issue-action", "L’action de suivi n’est pas valide.");
  } catch (error) { return fail(request, error); }
}
