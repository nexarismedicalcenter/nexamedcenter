"use strict";

const { onRequest } = require("firebase-functions/v2/https");

const REGION = "us-east4";
const RESULT_STATUSES = [
  "RESULT_PENDING_REVIEW",
  "CORRECTION_REQUESTED",
  "VALIDATED",
  "RESULT_AVAILABLE",
  "NOT_PERFORMED",
];

function cleanText(value, maximum) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

module.exports = function createNexaAdminDiagnosticPartnerReportFunctions(dependencies) {
  const { db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger } = dependencies;

  const nexaAdminDiagnosticPartnerReport = onRequest({ region: REGION, maxInstances: 10 }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") {
      res.set("Allow", "GET, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }

    try {
      const admin = await requireUser(req);
      await requireAppCheckToken(req);
      const administrators = new Set(String(process.env.NEXA_ADMIN_UIDS || "").split(",").map((value) => value.trim()).filter(Boolean));
      if (!administrators.size) throw new ApiError(503, "admin-access-not-configured", "L’accès administrateur NEXA n’est pas configuré.");
      if (!administrators.has(admin.uid)) throw new ApiError(403, "administrator-required", "Accès administrateur requis.");
      await enforceUserRateLimit(admin.uid, "admin-diagnostic-partner-report", 30, 60_000);

      const providerUid = typeof req.query?.providerUid === "string" ? req.query.providerUid.trim() : "";
      if (!/^[A-Za-z0-9:_-]{1,128}$/.test(providerUid)) {
        throw new ApiError(400, "invalid-diagnostic-provider", "Sélectionnez un partenaire NEXA valide.");
      }

      const providerSnapshot = await db.collection("providerProfiles").doc(providerUid).get();
      const providerType = providerSnapshot.get("type");
      if (!providerSnapshot.exists || !["laboratory", "imaging"].includes(String(providerType))) {
        throw new ApiError(404, "diagnostic-provider-not-found", "Ce laboratoire ou centre d’imagerie NEXA est introuvable.");
      }

      const [resultCountEntries, assignedOrdersCount] = await Promise.all([
        Promise.all(RESULT_STATUSES.map(async (status) => {
          const snapshot = await db.collection("diagnosticResults")
            .where("providerUid", "==", providerUid)
            .where("providerType", "==", providerType)
            .where("status", "==", status)
            .count()
            .get();
          return [status, snapshot.data().count];
        })),
        db.collection("nexaOrders")
          .where("providerUid", "==", providerUid)
          .where("kind", "==", providerType)
          .count()
          .get(),
      ]);

      const counts = Object.fromEntries(resultCountEntries);
      const profile = providerSnapshot.get("profile");
      const report = {
        providerUid,
        providerName: typeof profile?.name === "string" ? cleanText(profile.name, 160) || "Partenaire NEXA" : "Partenaire NEXA",
        providerType,
        providerStatus: cleanText(providerSnapshot.get("status"), 40) || "unknown",
        ordersAssigned: assignedOrdersCount.data().count,
        resultsPendingReview: counts.RESULT_PENDING_REVIEW || 0,
        correctionsPending: counts.CORRECTION_REQUESTED || 0,
        examsValidated: counts.VALIDATED || 0,
        resultsAvailable: counts.RESULT_AVAILABLE || 0,
        examsPerformed: (counts.VALIDATED || 0) + (counts.RESULT_AVAILABLE || 0),
        examsNotPerformed: counts.NOT_PERFORMED || 0,
      };

      await db.collection("adminAuditLogs").doc().create({
        actorUid: admin.uid,
        action: "diagnostic_partner_report_viewed",
        resource: `providerProfiles/${providerUid}`,
        providerType,
        ordersAssigned: report.ordersAssigned,
        resultsPendingReview: report.resultsPendingReview,
        correctionsPending: report.correctionsPending,
        createdAt: FieldValue.serverTimestamp(),
      });
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, report });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA diagnostic partner report failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "admin-diagnostic-partner-report-unavailable", "Le rapport partenaire n’est pas disponible.");
    }
  });

  return { nexaAdminDiagnosticPartnerReport };
};
