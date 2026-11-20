import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONSULTATION_CLINICAL_ACCESS_DURATION_MS,
  getConsultationClinicalAccessWindow,
  hasActiveConsultationClinicalAccess,
  hasActiveStandaloneClinicalAccess,
} from "../src/lib/clinical-record/access.ts";

const startedAtMs = Date.parse("2026-11-09T12:00:00.000Z");

function appointment(overrides = {}) {
  return {
    paymentStatus: "PAID",
    status: "IN_PROGRESS",
    sessionStartedAt: new Date(startedAtMs),
    effectiveConsultationStartedAt: new Date(startedAtMs),
    ...overrides,
  };
}

test("clinical access lasts 24 hours from the effective participant connection", () => {
  const window = getConsultationClinicalAccessWindow(appointment());
  assert.deepEqual(window, {
    startedAtMs,
    expiresAtMs: startedAtMs + CONSULTATION_CLINICAL_ACCESS_DURATION_MS,
  });
  assert.equal(hasActiveConsultationClinicalAccess(appointment(), startedAtMs), true);
  assert.equal(hasActiveConsultationClinicalAccess(appointment({ status: "COMPLETED" }), startedAtMs + 23 * 60 * 60_000), true);
  assert.equal(hasActiveConsultationClinicalAccess(appointment(), startedAtMs + CONSULTATION_CLINICAL_ACCESS_DURATION_MS), false);
});

test("clinical access fails closed before start, after expiry, or without a paid active consultation", () => {
  assert.equal(hasActiveConsultationClinicalAccess(appointment(), startedAtMs - 1), false);
  assert.equal(hasActiveConsultationClinicalAccess(appointment({ paymentStatus: "PENDING" }), startedAtMs), false);
  assert.equal(hasActiveConsultationClinicalAccess(appointment({ status: "CONFIRMED" }), startedAtMs), false);
  assert.equal(hasActiveConsultationClinicalAccess(appointment({ effectiveConsultationStartedAt: null }), startedAtMs), false);
});

test("standalone record access requires a live, unrevoked patient grant", () => {
  const record = {
    accessGrantedAt: new Date(startedAtMs),
    accessExpiresAt: new Date(startedAtMs + CONSULTATION_CLINICAL_ACCESS_DURATION_MS),
    accessRevoked: false,
  };
  assert.equal(hasActiveStandaloneClinicalAccess(record, startedAtMs + 1), true);
  assert.equal(hasActiveStandaloneClinicalAccess(record, startedAtMs + CONSULTATION_CLINICAL_ACCESS_DURATION_MS), false);
  assert.equal(hasActiveStandaloneClinicalAccess({ ...record, accessRevoked: true }, startedAtMs + 1), false);
  assert.equal(hasActiveStandaloneClinicalAccess({ accessExpiresAt: record.accessExpiresAt }, startedAtMs + 1), false);
});
