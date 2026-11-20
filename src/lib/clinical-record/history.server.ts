import "server-only";

import type { DocumentSnapshot, Firestore, QueryDocumentSnapshot } from "firebase-admin/firestore";

const PAGE_SIZE = 10;
const BATCH_SIZE = 20;
const MAX_SCAN = 100;
const FINAL_STATUSES = ["FINALIZED", "SIGNED"] as const;
const TEXT_FIELDS = [
  "consultationReason", "relevantHistory", "allergies", "currentTreatments", "symptoms", "history",
  "clinicalObservations", "clinicalAssessment", "diagnoses", "carePlan", "recommendations", "followUp", "additionalNotes",
] as const;

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim().slice(0, maxLength);
}

function iso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).toISOString();
  return typeof value === "string" ? value : null;
}

function projectClinicalContent(value: unknown) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const result: Record<string, unknown> = {};
  for (const field of TEXT_FIELDS) result[field] = cleanText(source[field], 2_000);

  const rawVitals = source.patientVitals && typeof source.patientVitals === "object" && !Array.isArray(source.patientVitals)
    ? source.patientVitals as Record<string, unknown>
    : {};
  const patientVitals: Record<string, number | string | null> = {};
  for (const field of ["systolic", "diastolic", "heartRate", "respiratoryRate", "spo2", "glycemia", "temperature", "weight", "height"] as const) {
    const value = rawVitals[field];
    patientVitals[field] = typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  for (const field of ["weightUnit", "heightUnit"] as const) {
    if (typeof rawVitals[field] === "string") patientVitals[field] = cleanText(rawVitals[field], 10);
  }
  result.patientVitals = patientVitals;

  result.medications = Array.isArray(source.medications) ? source.medications.slice(0, 20).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    return [{
      name: cleanText(item.name, 180), dosage: cleanText(item.dosage, 120), form: cleanText(item.form, 80),
      route: cleanText(item.route, 80), quantity: typeof item.quantity === "number" && Number.isFinite(item.quantity) ? item.quantity : null,
      instructions: cleanText(item.instructions, 300), duration: cleanText(item.duration, 120),
    }].filter((medication) => medication.name);
  }) : [];
  for (const field of ["laboratoryTests", "imagingExams"] as const) {
    result[field] = Array.isArray(source[field]) ? (source[field] as unknown[]).slice(0, 20).map((item) => cleanText(item, 250)).filter(Boolean) : [];
  }
  return result;
}

async function projectRecord(document: QueryDocumentSnapshot) {
  const data = document.data();
  const signature = data.signature && typeof data.signature === "object" && !Array.isArray(data.signature)
    ? data.signature as Record<string, unknown>
    : {};
  const addendaSnapshot = await document.ref.collection("addenda").orderBy("createdAt", "asc").limit(100).get();
  return {
    recordId: document.id,
    recordNumber: cleanText(data.recordNumber, 100) || "Dossier clinique",
    recordType: data.recordType === "STANDALONE" ? "STANDALONE" : "APPOINTMENT",
    providerName: cleanText(data.providerName, 180) || "Médecin NEXA",
    specialtyName: cleanText(data.specialtyName, 160),
    finalizedAt: iso(data.finalizedAt),
    signature: {
      name: cleanText(signature.name, 180),
      specialty: cleanText(signature.specialty, 160),
      signedAt: cleanText(signature.signedAt, 80),
    },
    clinicalContent: projectClinicalContent(data.clinicalContent),
    addenda: addendaSnapshot.docs.flatMap((addendumDocument) => {
      const addendum = addendumDocument.data();
      if (addendum.patientUid !== data.patientUid || addendum.providerUid !== data.providerUid) return [];
      return [{
        reason: cleanText(addendum.reason, 500),
        content: cleanText(addendum.content, 2_000),
        signatureName: cleanText(addendum.signatureName, 180),
        createdAt: iso(addendum.createdAt),
      }];
    }),
  };
}

function isSignedClinicalRecord(document: QueryDocumentSnapshot | DocumentSnapshot) {
  const data = document.data() || {};
  const signature = data.signature && typeof data.signature === "object" && !Array.isArray(data.signature)
    ? data.signature as Record<string, unknown>
    : {};
  return FINAL_STATUSES.includes(data.status as typeof FINAL_STATUSES[number]) &&
    typeof data.providerUid === "string" && data.providerUid.length > 0 &&
    signature.uid === data.providerUid && typeof signature.signedAt === "string" &&
    /^[a-f0-9]{64}$/i.test(String(data.documentHash || "")) && Boolean(data.finalizedAt);
}

export async function listOtherPhysicianClinicalHistory({
  db,
  patientUid,
  requestingProviderUid,
  excludeRecordId,
  cursor,
}: {
  db: Firestore;
  patientUid: string;
  requestingProviderUid: string;
  excludeRecordId: string;
  cursor?: string;
}) {
  const collection = db.collection("electronicPatientRecords");
  const baseQuery = collection
    .where("patientUid", "==", patientUid)
    .where("status", "in", [...FINAL_STATUSES])
    .orderBy("finalizedAt", "desc");
  let cursorSnapshot: QueryDocumentSnapshot | undefined;
  if (cursor) {
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(cursor)) throw new Error("invalid-cursor");
    const candidate = await collection.doc(cursor).get();
    if (!candidate.exists || candidate.get("patientUid") !== patientUid || !isSignedClinicalRecord(candidate)) {
      throw new Error("invalid-cursor");
    }
    cursorSnapshot = candidate as QueryDocumentSnapshot;
  }

  const records: QueryDocumentSnapshot[] = [];
  let scanCursor = cursorSnapshot;
  let scanned = 0;
  let lastBatchSize = 0;
  while (records.length < PAGE_SIZE + 1 && scanned < MAX_SCAN) {
    const batchLimit = Math.min(BATCH_SIZE, MAX_SCAN - scanned);
    let batchQuery = baseQuery.limit(batchLimit);
    if (scanCursor) batchQuery = batchQuery.startAfter(scanCursor);
    const batch = await batchQuery.get();
    lastBatchSize = batch.size;
    if (batch.empty) break;
    for (const document of batch.docs) {
      scanCursor = document;
      scanned += 1;
      if (document.id === excludeRecordId || document.get("providerUid") === requestingProviderUid || !isSignedClinicalRecord(document)) continue;
      records.push(document);
      if (records.length === PAGE_SIZE + 1 || scanned === MAX_SCAN) break;
    }
    if (batch.size < batchLimit || scanned >= MAX_SCAN) break;
  }

  const hasExtraRecord = records.length > PAGE_SIZE;
  const pageDocuments = records.slice(0, PAGE_SIZE);
  const page = await Promise.all(pageDocuments.map(projectRecord));
  const canContinueAfterScan = !hasExtraRecord && scanned >= MAX_SCAN && lastBatchSize === Math.min(BATCH_SIZE, MAX_SCAN - (scanned - lastBatchSize));
  return {
    records: page,
    nextCursor: hasExtraRecord ? pageDocuments[pageDocuments.length - 1]?.id || null : canContinueAfterScan ? scanCursor?.id || null : null,
  };
}
