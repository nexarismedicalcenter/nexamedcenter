"use strict";

const { onRequest } = require("firebase-functions/v2/https");

const REGION = "us-east4";
const EDITABLE_STATUSES = new Set(["IN_PROGRESS", "COMPLETED"]);

function getBody(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) && !Array.isArray(req.body)) return req.body;
  if (!Buffer.isBuffer(req.rawBody)) return null;
  try {
    const value = JSON.parse(req.rawBody.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function cleanText(value, maximum) {
  return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim().slice(0, maximum) : "";
}

function cleanContent(value, ApiError) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid-prescription-content", "Le contenu de l’ordonnance n’est pas valide.");
  }
  const medications = Array.isArray(value.medications) ? value.medications.slice(0, 50).map((raw) => {
    const item = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const quantity = item.quantity === "" || item.quantity == null ? null : Number(item.quantity);
    if (quantity !== null && (!Number.isFinite(quantity) || quantity < 0 || quantity > 1_000_000)) {
      throw new ApiError(400, "invalid-medication-quantity", "Vérifiez les quantités de médicaments.");
    }
    return {
      name: cleanText(item.name, 180), dosage: cleanText(item.dosage, 120),
      form: cleanText(item.form, 120), route: cleanText(item.route, 120), quantity,
      instructions: cleanText(item.instructions, 500), duration: cleanText(item.duration, 120),
    };
  }).filter((item) => item.name) : [];
  const exams = (raw) => Array.isArray(raw) ? raw.slice(0, 50).map((item) => cleanText(item, 250)).filter(Boolean) : [];
  return {
    medications,
    labExams: exams(value.labExams),
    imagingExams: exams(value.imagingExams),
    notes: cleanText(value.notes, 1_000),
  };
}

function hasContent(value) {
  return Boolean(value.medications?.length || value.labExams?.length || value.imagingExams?.length);
}

function timestamp(value) {
  if (value && typeof value.toDate === "function") return value.toDate().getTime();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") return Date.parse(value);
  return Number.NaN;
}

function iso(value) {
  const time = timestamp(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function activeClinicalAccess(appointment, now = Date.now()) {
  if (appointment.paymentStatus !== "PAID") return false;
  const status = String(appointment.status || "").toUpperCase();
  const completedHomeVisit = appointment.bookingType === "home_visit" && status === "COMPLETED" && appointment.homeVisitMissionStatus === "COMPLETED";
  const startedHomeVisit = appointment.bookingType === "home_visit" && ["CONFIRMED", "COMPLETED"].includes(status) && timestamp(appointment.effectiveConsultationStartedAt) > 0;
  const start = startedHomeVisit ? timestamp(appointment.effectiveConsultationStartedAt)
    : completedHomeVisit ? timestamp(appointment.homeVisitMissionClosedAt)
    : EDITABLE_STATUSES.has(status) ? timestamp(appointment.effectiveConsultationStartedAt) : Number.NaN;
  return Number.isFinite(start) && start > 0 && now >= start && now < start + 24 * 60 * 60_000;
}

function publicPrescription(id, data) {
  const medications = Array.isArray(data.medications) ? data.medications.slice(0, 50).flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const quantity = raw.quantity == null ? null : Number(raw.quantity);
    return [{
      name: cleanText(raw.name, 180), dosage: cleanText(raw.dosage, 120), form: cleanText(raw.form, 120),
      route: cleanText(raw.route, 120), quantity: Number.isFinite(quantity) ? quantity : null,
      instructions: cleanText(raw.instructions, 500), duration: cleanText(raw.duration, 120),
    }].filter((item) => item.name);
  }) : [];
  const signature = data.signature && typeof data.signature === "object" ? {
    name: cleanText(data.signature.name, 180),
    specialty: cleanText(data.signature.specialty, 160),
    signedAt: cleanText(data.signature.signedAt, 80),
  } : null;
  return {
    id,
    appointmentId: cleanText(data.appointmentId, 200),
    providerName: cleanText(data.providerName, 180),
    specialtyName: cleanText(data.specialtyName, 160),
    medications,
    labExams: Array.isArray(data.labExams) ? data.labExams.slice(0, 50).map((item) => cleanText(item, 250)).filter(Boolean) : [],
    imagingExams: Array.isArray(data.imagingExams) ? data.imagingExams.slice(0, 50).map((item) => cleanText(item, 250)).filter(Boolean) : [],
    notes: cleanText(data.notes, 1_000),
    status: ["DRAFT", "VALIDATED", "REPLACED"].includes(data.status) ? data.status : "UNKNOWN",
    version: Number(data.version) > 0 ? Number(data.version) : 1,
    versionGroupId: cleanText(data.versionGroupId || id, 200),
    previousVersionId: cleanText(data.previousVersionId, 200) || null,
    replacedBy: cleanText(data.replacedBy, 200) || null,
    validatedAt: iso(data.validatedAt),
    createdAt: iso(data.createdAt),
    signature,
  };
}

module.exports = function createNexaPrescriptionFunctions(dependencies) {
  const { db, FieldValue, ApiError, requireUser, requireAppCheckToken, enforceUserRateLimit, setCors, fail, logger, createNexaNotification } = dependencies;

  async function requireDoctor(req, authenticatedUser = null) {
    const user = authenticatedUser || await requireUser(req);
    if (!authenticatedUser) await requireAppCheckToken(req);
    const provider = await db.collection("providerProfiles").doc(user.uid).get();
    if (!provider.exists || provider.get("status") !== "verified" || provider.get("type") !== "doctor" || provider.get("clinicalCredentialsVerified") !== true) {
      throw new ApiError(403, "verified-doctor-required", "Cette action est réservée au médecin NEXA vérifié.");
    }
    const profile = provider.get("profile") && typeof provider.get("profile") === "object" ? provider.get("profile") : {};
    return { uid: user.uid, name: cleanText(profile.name || user.name || "Médecin NEXA", 180), specialty: cleanText(profile.specialty, 160) };
  }

  const nexaClinicalPrescriptions = onRequest({ region: REGION }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!["GET", "POST"].includes(req.method)) {
      res.set("Allow", "GET, POST, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    if (req.method === "POST" && ((Number(req.get("Content-Length")) || 0) > 80_000 || (Buffer.isBuffer(req.rawBody) && req.rawBody.length > 80_000))) {
      return fail(res, 413, "prescription-too-large", "L’ordonnance dépasse la taille autorisée.");
    }

    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      const appointmentId = typeof req.query.appointmentId === "string" ? req.query.appointmentId.trim() : "";
      if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) throw new ApiError(400, "invalid-appointment", "La référence de consultation n’est pas valide.");
      const appointmentRef = db.collection("appointments").doc(appointmentId);
      const appointmentSnapshot = await appointmentRef.get();
      if (!appointmentSnapshot.exists) throw new ApiError(404, "appointment-not-found", "Consultation introuvable.");
      const appointment = appointmentSnapshot.data() || {};
      const patientView = appointment.patientUid === user.uid;
      const collection = db.collection("clinicalPrescriptions");
      res.set("Cache-Control", "no-store, max-age=0");

      if (req.method === "GET") {
        if (patientView) {
          await enforceUserRateLimit(user.uid, "patient-prescription-read", 30, 5 * 60_000);
          const profile = await db.collection("patientProfiles").doc(user.uid).get();
          if (!profile.exists || profile.get("role") !== "patient" || profile.get("profileComplete") !== true) {
            throw new ApiError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
          }
        } else {
          const doctor = await requireDoctor(req, user);
          if (appointment.providerUid !== doctor.uid || appointment.providerType !== "doctor") throw new ApiError(403, "forbidden", "Vous ne participez pas à cette consultation.");
          if (!activeClinicalAccess(appointment)) throw new ApiError(403, "clinical-access-expired", "L’autorisation d’accès clinique est expirée.");
          await enforceUserRateLimit(doctor.uid, "clinical-prescription-read", 30, 5 * 60_000);
        }
        const snapshot = await collection.where("appointmentId", "==", appointmentId).limit(100).get();
        const prescriptions = snapshot.docs
          .map((doc) => ({ id: doc.id, data: doc.data() || {} }))
          .filter(({ data }) => patientView
            ? data.patientUid === user.uid && data.providerUid === appointment.providerUid && data.status === "VALIDATED"
            : data.providerUid === user.uid && data.patientUid === appointment.patientUid)
          .sort((left, right) => timestamp(right.data.createdAt) - timestamp(left.data.createdAt))
          .map(({ id, data }) => publicPrescription(id, data));
        if (!patientView) {
          await db.collection("clinicalAuditLogs").add({ actorUid: user.uid, action: "doctor_clinical_prescriptions_accessed", appointmentId, createdAt: FieldValue.serverTimestamp() });
        }
        return res.status(200).json({ ok: true, view: patientView ? "patient" : "provider", prescriptions });
      }

      const doctor = await requireDoctor(req, user);
      await enforceUserRateLimit(doctor.uid, "clinical-prescription-write", 30, 5 * 60_000);
      const input = getBody(req);
      const allowedKeys = new Set(["action", "prescriptionId", "content"]);
      if (!input || Object.keys(input).some((key) => !allowedKeys.has(key))) throw new ApiError(400, "invalid-request", "La demande d’ordonnance n’est pas valide.");
      const action = typeof input.action === "string" ? input.action : "";
      if (!["createDraft", "updateDraft", "validate", "correct"].includes(action)) throw new ApiError(400, "invalid-prescription-action", "Action d’ordonnance invalide.");
      if (appointment.providerUid !== doctor.uid || appointment.providerType !== "doctor") throw new ApiError(403, "forbidden", "Vous ne participez pas à cette consultation.");
      const content = action === "validate" ? null : cleanContent(input.content, ApiError);
      if (action === "correct" && !hasContent(content)) throw new ApiError(400, "prescription-empty", "Ajoutez au moins un médicament ou un examen.");
      const auditRef = db.collection("clinicalAuditLogs").doc();
      const timestampValue = FieldValue.serverTimestamp();
      let patientUid = "";
      let outputId = "";
      let outputStatus = "";
      let outputVersion = 1;
      let oldPrescriptionId = "";

      if (action === "createDraft") {
        const prescriptionRef = collection.doc();
        await db.runTransaction(async (transaction) => {
          const [freshAppointment, providerSnapshot] = await Promise.all([
            transaction.get(appointmentRef),
            transaction.get(db.collection("providerProfiles").doc(doctor.uid)),
          ]);
          if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) throw new ApiError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé.");
          if (!freshAppointment.exists || freshAppointment.get("providerUid") !== doctor.uid || freshAppointment.get("providerType") !== "doctor" || !activeClinicalAccess(freshAppointment.data() || {})) throw new ApiError(403, "clinical-access-expired", "L’autorisation clinique n’est pas active pour cette consultation.");
          patientUid = String(freshAppointment.get("patientUid") || "");
          if (!patientUid) throw new ApiError(409, "patient-required", "La consultation n’est pas associée à un patient.");
          outputId = prescriptionRef.id;
          outputStatus = "DRAFT";
          transaction.create(prescriptionRef, {
            appointmentId, patientUid, providerUid: doctor.uid, providerName: doctor.name, specialtyName: doctor.specialty,
            ...content, status: "DRAFT", version: 1, versionGroupId: prescriptionRef.id,
            previousVersionId: null, replacedBy: null, signature: null, validatedAt: null,
            createdAt: timestampValue, updatedAt: timestampValue, createdBy: doctor.uid, updatedBy: doctor.uid,
          });
          transaction.create(auditRef, { actorUid: doctor.uid, action: "clinical_prescription_draft_created", appointmentId, prescriptionId: prescriptionRef.id, createdAt: timestampValue });
        });
      } else {
        const prescriptionId = typeof input.prescriptionId === "string" ? input.prescriptionId.trim() : "";
        if (!/^[A-Za-z0-9_-]{10,200}$/.test(prescriptionId)) throw new ApiError(400, "invalid-prescription", "La référence de l’ordonnance n’est pas valide.");
        const oldRef = collection.doc(prescriptionId);
        const nextRef = action === "correct" ? collection.doc() : oldRef;
        await db.runTransaction(async (transaction) => {
          const [freshAppointment, providerSnapshot, prescriptionSnapshot] = await Promise.all([
            transaction.get(appointmentRef),
            transaction.get(db.collection("providerProfiles").doc(doctor.uid)),
            transaction.get(oldRef),
          ]);
          if (!providerSnapshot.exists || providerSnapshot.get("status") !== "verified" || providerSnapshot.get("type") !== "doctor" || providerSnapshot.get("clinicalCredentialsVerified") !== true) throw new ApiError(403, "verified-doctor-required", "Le profil médecin n’est plus autorisé.");
          if (!freshAppointment.exists || freshAppointment.get("providerUid") !== doctor.uid || freshAppointment.get("providerType") !== "doctor" || !activeClinicalAccess(freshAppointment.data() || {})) throw new ApiError(403, "clinical-access-expired", "L’autorisation clinique n’est pas active pour cette consultation.");
          if (!prescriptionSnapshot.exists || prescriptionSnapshot.get("appointmentId") !== appointmentId || prescriptionSnapshot.get("providerUid") !== doctor.uid || prescriptionSnapshot.get("patientUid") !== freshAppointment.get("patientUid")) throw new ApiError(404, "prescription-not-found", "Cette ordonnance n’est pas accessible.");
          const previous = prescriptionSnapshot.data() || {};
          patientUid = String(previous.patientUid || "");
          oldPrescriptionId = prescriptionId;
          if (action === "updateDraft") {
            if (previous.status !== "DRAFT") throw new ApiError(409, "prescription-immutable", "Seul un brouillon peut être modifié.");
            outputId = prescriptionId; outputStatus = "DRAFT"; outputVersion = Number(previous.version) || 1;
            transaction.set(oldRef, { ...content, updatedAt: timestampValue, updatedBy: doctor.uid }, { merge: true });
            transaction.create(auditRef, { actorUid: doctor.uid, action: "clinical_prescription_draft_updated", appointmentId, prescriptionId, createdAt: timestampValue });
            return;
          }
          if (action === "validate") {
            if (previous.status !== "DRAFT" || !hasContent(previous)) throw new ApiError(409, "prescription-empty", "Ajoutez au moins un médicament ou un examen avant validation.");
            outputId = prescriptionId; outputStatus = "VALIDATED"; outputVersion = Number(previous.version) || 1;
            transaction.set(oldRef, {
              status: "VALIDATED", validatedAt: timestampValue, updatedAt: timestampValue, updatedBy: doctor.uid,
              signature: { uid: doctor.uid, name: doctor.name, specialty: doctor.specialty, signedAt: new Date().toISOString() },
            }, { merge: true });
            transaction.create(auditRef, { actorUid: doctor.uid, action: "clinical_prescription_validated", appointmentId, prescriptionId, version: outputVersion, createdAt: timestampValue });
            return;
          }
          if (previous.status !== "VALIDATED" || !hasContent(content)) throw new ApiError(409, "prescription-not-correctable", "Seule une ordonnance validée peut être remplacée par une nouvelle version.");
          outputId = nextRef.id; outputStatus = "VALIDATED"; outputVersion = Math.max(1, Number(previous.version) || 1) + 1;
          transaction.set(oldRef, { status: "REPLACED", replacedBy: nextRef.id, updatedAt: timestampValue }, { merge: true });
          transaction.create(nextRef, {
            ...previous, ...content, status: "VALIDATED", version: outputVersion,
            versionGroupId: previous.versionGroupId || prescriptionId, previousVersionId: prescriptionId, replacedBy: null,
            validatedAt: timestampValue, createdAt: timestampValue, updatedAt: timestampValue,
            signature: { uid: doctor.uid, name: doctor.name, specialty: doctor.specialty, signedAt: new Date().toISOString() },
            createdBy: doctor.uid, updatedBy: doctor.uid,
          });
          transaction.create(auditRef, { actorUid: doctor.uid, action: "clinical_prescription_corrected", appointmentId, prescriptionId: nextRef.id, previousPrescriptionId: prescriptionId, version: outputVersion, createdAt: timestampValue });
        });
      }

      if (["validate", "correct"].includes(action) && patientUid && typeof createNexaNotification === "function") {
        await createNexaNotification(patientUid, `prescription:${outputId}:validated`, {
          type: action === "correct" ? "prescription_corrected" : "prescription_received",
          title: action === "correct" ? "Ordonnance mise à jour" : "Ordonnance reçue",
          body: action === "correct" ? `Une nouvelle version (${outputVersion}) de votre ordonnance est disponible.` : "Votre médecin vous a transmis une ordonnance.",
          url: "/espace-patient.html",
        }, appointmentId).catch((error) => logger.warn("NEXA prescription notification failed", { errorName: error instanceof Error ? error.name : "unknown-error" }));
      }
      return res.status(200).json({ ok: true, prescriptionId: outputId, previousPrescriptionId: oldPrescriptionId || null, status: outputStatus, version: outputVersion });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA prescription request failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "prescriptions-unavailable", "Les ordonnances ne sont pas accessibles pour le moment.");
    }
  });

  const nexaPatientPrescriptions = onRequest({ region: REGION }, async (req, res) => {
    if (!setCors(req, res)) return fail(res, 403, "origin-not-allowed", "Origine non autorisée.");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") {
      res.set("Allow", "GET, OPTIONS");
      return fail(res, 405, "method-not-allowed", "Méthode non autorisée.");
    }
    try {
      const user = await requireUser(req);
      await requireAppCheckToken(req);
      await enforceUserRateLimit(user.uid, "patient-prescription-list", 20, 5 * 60_000);
      const profile = await db.collection("patientProfiles").doc(user.uid).get();
      if (!profile.exists || profile.get("role") !== "patient" || profile.get("profileComplete") !== true) throw new ApiError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
      const snapshot = await db.collection("clinicalPrescriptions")
        .where("patientUid", "==", user.uid)
        .where("status", "==", "VALIDATED")
        .orderBy("validatedAt", "desc")
        .limit(100)
        .get();
      const prescriptions = snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() || {} }))
        .filter(({ data }) => data.patientUid === user.uid && data.status === "VALIDATED")
        .map(({ id, data }) => publicPrescription(id, data));
      await db.collection("clinicalAuditLogs").add({ actorUid: user.uid, action: "patient_clinical_prescriptions_accessed", createdAt: FieldValue.serverTimestamp() });
      res.set("Cache-Control", "no-store, max-age=0");
      return res.status(200).json({ ok: true, prescriptions });
    } catch (error) {
      if (error instanceof ApiError) return fail(res, error.status, error.code, error.message);
      logger.error("NEXA patient prescriptions request failed", { errorName: error instanceof Error ? error.name : "unknown-error" });
      return fail(res, 500, "patient-prescriptions-unavailable", "Les ordonnances ne sont pas accessibles pour le moment.");
    }
  });

  return { nexaClinicalPrescriptions, nexaPatientPrescriptions };
};
