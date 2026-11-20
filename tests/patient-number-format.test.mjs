import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPatientNumber } from "../src/lib/patients/ensure-patient-profile.ts";

test("patient numbers use the NMC prefix and a seven-digit sequence", () => {
  assert.equal(formatPatientNumber(1), "NMC-0000001");
  assert.equal(formatPatientNumber(42), "NMC-0000042");
  assert.equal(formatPatientNumber(9_999_999), "NMC-9999999");
});

test("patient number formatting rejects values outside the supported range", () => {
  for (const value of [0, -1, 1.5, Number.NaN, 10_000_000]) {
    assert.throws(() => formatPatientNumber(value), RangeError);
  }
});
