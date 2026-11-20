import "server-only";

import {
  FieldValue,
  type Firestore,
} from "firebase-admin/firestore";

const PATIENT_NUMBER_WIDTH = 7;
const MAX_PATIENT_NUMBER = 9_999_999;

export type PatientRegistration = {
  firstName: string;
  lastName: string;
  birthDate: string;
  phone: string;
  sex: string;
  addressLine: string;
  country: string;
  department: string;
  commune: string;
  emailMarketingConsent: boolean;
  termsAccepted: true;
};

export type PatientIdentity = {
  uid: string;
  email: string;
};

export type EnsurePatientProfileResult = {
  patientNumber: string;
  created: boolean;
  profileComplete: boolean;
};

export class PatientNumberCapacityError extends Error {
  constructor() {
    super("La capacité de numérotation patient est épuisée.");
    this.name = "PatientNumberCapacityError";
  }
}

export class PatientNumberIntegrityError extends Error {
  constructor() {
    super("Le compteur de numéros patients n’est pas valide.");
    this.name = "PatientNumberIntegrityError";
  }
}

export function formatPatientNumber(sequence: number): string {
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    sequence > MAX_PATIENT_NUMBER
  ) {
    throw new RangeError("Patient number sequence is outside the supported range.");
  }
  return `NMC-${String(sequence).padStart(PATIENT_NUMBER_WIDTH, "0")}`;
}

function isPatientNumber(value: unknown): value is string {
  return typeof value === "string" && /^NMC-\d{7}$/.test(value);
}

export async function ensurePatientProfile(
  db: Firestore,
  identity: PatientIdentity,
  registration?: PatientRegistration,
): Promise<EnsurePatientProfileResult> {
  if (!identity.uid || !identity.email) {
    throw new Error("Patient identity is incomplete.");
  }

  const patientRef = db.collection("patientProfiles").doc(identity.uid);
  const sequenceRef = db.collection("systemCounters").doc("patientNumbers");
  const indexCollection = db.collection("patientNumberIndex");

  return db.runTransaction(async (transaction) => {
    const patientSnapshot = await transaction.get(patientRef);
    const existingPatientNumber = patientSnapshot.get("patientNumber");

    if (isPatientNumber(existingPatientNumber)) {
      const indexRef = indexCollection.doc(existingPatientNumber);
      const indexSnapshot = await transaction.get(indexRef);
      if (indexSnapshot.exists && indexSnapshot.get("uid") !== identity.uid) {
        throw new Error("Patient number index ownership conflict.");
      }
      if (!registration) {
        if (!indexSnapshot.exists) {
          transaction.create(indexRef, {
            uid: identity.uid,
            createdAt: FieldValue.serverTimestamp(),
          });
        }
        return {
          patientNumber: existingPatientNumber,
          created: false,
          profileComplete: patientSnapshot.get("profileComplete") === true,
        };
      }

      transaction.set(
        patientRef,
        {
          ...registration,
          email: identity.email,
          displayName: `${registration.firstName} ${registration.lastName}`.trim(),
          profileComplete: true,
          termsAcceptedAt:
            patientSnapshot.get("termsAcceptedAt") || FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      if (!indexSnapshot.exists) {
        transaction.create(indexRef, {
          uid: identity.uid,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      return { patientNumber: existingPatientNumber, created: false, profileComplete: true };
    }

    const sequenceSnapshot = await transaction.get(sequenceRef);
    const lastIssuedNumber = sequenceSnapshot.exists
      ? sequenceSnapshot.get("lastIssuedNumber")
      : 0;
    if (
      typeof lastIssuedNumber !== "number" ||
      !Number.isSafeInteger(lastIssuedNumber) ||
      lastIssuedNumber < 0 ||
      lastIssuedNumber > MAX_PATIENT_NUMBER
    ) {
      throw new PatientNumberIntegrityError();
    }
    let sequence = lastIssuedNumber + 1;
    let patientNumber = "";
    let indexRef = indexCollection.doc("pending");

    while (sequence <= MAX_PATIENT_NUMBER) {
      patientNumber = formatPatientNumber(sequence);
      indexRef = indexCollection.doc(patientNumber);
      const indexSnapshot = await transaction.get(indexRef);
      if (!indexSnapshot.exists) break;
      sequence += 1;
    }

    if (sequence > MAX_PATIENT_NUMBER) throw new PatientNumberCapacityError();

    transaction.create(indexRef, {
      uid: identity.uid,
      createdAt: FieldValue.serverTimestamp(),
    });
    transaction.set(
      sequenceRef,
      {
        lastIssuedNumber: sequence,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    transaction.set(
      patientRef,
      {
        uid: identity.uid,
        email: identity.email,
        role: "patient",
        patientNumber,
        ...(registration || {}),
        ...(registration
          ? { displayName: `${registration.firstName} ${registration.lastName}`.trim() }
          : {}),
        profileComplete: Boolean(registration),
        ...(registration ? { termsAcceptedAt: FieldValue.serverTimestamp() } : {}),
        createdAt: patientSnapshot.get("createdAt") || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return { patientNumber, created: true, profileComplete: Boolean(registration) };
  }, { maxAttempts: 20 });
}
