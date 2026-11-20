import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPrescriptionAvailabilityLines,
  getPrescriptionExpiryMillis,
  isDiagnosticAvailabilityMatch,
  isMedicationAvailabilityMatch,
  isPrescriptionPastExpiry,
  normalizeAvailabilityText,
  rankAvailabilityLocation,
} from "../src/lib/prescription-availability.ts";

test("prescription availability assigns stable, type-specific line identifiers", () => {
  const lines = buildPrescriptionAvailabilityLines({
    medications: [{ name: "Amoxicilline", dosage: "500 mg", form: "Capsule" }],
    labExams: ["Hémogramme", { name: "Glycémie" }],
    imagingExams: ["Radiographie thoracique"],
  });
  assert.deepEqual(lines.map(({ id, type }) => [id, type]), [
    ["medication-1", "medication"],
    ["laboratory-1", "laboratory"],
    ["laboratory-2", "laboratory"],
    ["imaging-1", "imaging"],
  ]);
});

test("medication availability requires the prescribed name and dosage", () => {
  const line = buildPrescriptionAvailabilityLines({ medications: [{ name: "Amoxicilline", dosage: "500 mg", form: "Capsule" }] })[0];
  assert.equal(isMedicationAvailabilityMatch(line, { name: "Amoxicilline", dosage: "500 mg", pharmaceuticalForm: "Capsule" }), true);
  assert.equal(isMedicationAvailabilityMatch(line, { name: "Amoxicilline", dosage: "250 mg", pharmaceuticalForm: "Capsule" }), false);
  assert.equal(isMedicationAvailabilityMatch(line, { name: "Autre médicament", dci: "Autre DCI", dosage: "500 mg", pharmaceuticalForm: "Capsule" }), false);
});

test("diagnostic availability matches the normalized prescribed exam name", () => {
  const lab = buildPrescriptionAvailabilityLines({ labExams: ["Hémogramme complet"] })[0];
  assert.equal(isDiagnosticAvailabilityMatch(lab, { name: "Hemogramme complet" }), true);
  assert.equal(isDiagnosticAvailabilityMatch(lab, { name: "Hémogramme" }), false);
  assert.equal(normalizeAvailabilityText("  Hémogramme  "), "hemogramme");
});

test("availability ranks commune before department and other locations", () => {
  const patient = { department: "Ouest", commune: "Port-au-Prince" };
  assert.equal(rankAvailabilityLocation(patient, patient), 0);
  assert.equal(rankAvailabilityLocation(patient, { department: "Ouest", commune: "Delmas" }), 1);
  assert.equal(rankAvailabilityLocation(patient, { department: "Nord", commune: "Cap-Haïtien" }), 2);
});

test("expiry parsing preserves absent expiry and rejects malformed explicit expiry", () => {
  assert.equal(getPrescriptionExpiryMillis(undefined), null);
  assert.equal(getPrescriptionExpiryMillis("not-a-date"), 0);
  assert.equal(getPrescriptionExpiryMillis("2030-01-01T00:00:00.000Z"), Date.parse("2030-01-01T00:00:00.000Z"));
  assert.equal(isPrescriptionPastExpiry({ expiresAt: "2020-01-01T00:00:00.000Z" }, Date.now()), true);
  assert.equal(isPrescriptionPastExpiry({}, Date.now()), false);
});
