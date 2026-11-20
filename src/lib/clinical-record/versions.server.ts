import "server-only";

import { FieldValue, type DocumentReference, type Transaction } from "firebase-admin/firestore";

export type ClinicalRecordRevision = {
  version: number;
  status: string;
  clinicalContent: unknown;
  attachments?: unknown[];
  actorUid?: string;
  createdAt?: unknown;
  signature?: unknown;
  documentHash?: string | null;
  changeType: "INITIAL" | "DRAFT_SAVED" | "FINALIZED" | "ATTACHMENT_ADDED" | "ATTACHMENT_REMOVED";
};

function revisionRef(recordRef: DocumentReference, version: number) {
  return recordRef.collection("versions").doc(String(version).padStart(8, "0"));
}

export async function writeClinicalRecordRevision(
  transaction: Transaction,
  recordRef: DocumentReference,
  current: ClinicalRecordRevision | null,
  next: ClinicalRecordRevision,
) {
  if (current) {
    const previousRef = revisionRef(recordRef, current.version);
    const previousSnapshot = await transaction.get(previousRef);
    if (!previousSnapshot.exists) {
      transaction.create(previousRef, {
        version: current.version,
        status: current.status,
        clinicalContent: current.clinicalContent,
        attachments: Array.isArray(current.attachments) ? current.attachments : [],
        actorUid: current.actorUid || "system:migration-snapshot",
        createdAt: current.createdAt || FieldValue.serverTimestamp(),
        changeType: current.changeType,
        ...(current.signature ? { signature: current.signature } : {}),
        ...(current.documentHash ? { documentHash: current.documentHash } : {}),
      });
    }
  }

  transaction.create(revisionRef(recordRef, next.version), {
    version: next.version,
    status: next.status,
    clinicalContent: next.clinicalContent,
    attachments: Array.isArray(next.attachments) ? next.attachments : [],
    actorUid: next.actorUid || "unknown",
    createdAt: next.createdAt || FieldValue.serverTimestamp(),
    changeType: next.changeType,
    ...(next.signature ? { signature: next.signature } : {}),
    ...(next.documentHash ? { documentHash: next.documentHash } : {}),
  });
}
