import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeDiagnosticResultRequirements,
  validateResultFiles,
} from "../src/lib/diagnostic-results.server.ts";

const pdf = (category, size = 1000) => ({ category, fileName: "resultat.pdf", contentType: "application/pdf", size });
const defaults = (providerType) => normalizeDiagnosticResultRequirements(undefined, providerType);

test("keeps the current lab and imaging upload defaults for existing orders", () => {
  assert.deepEqual(defaults("laboratory"), {
    requiredCategories: ["LAB_RESULT"],
    allowSupplemental: true,
    allowMultiplePerCategory: true,
    maxFiles: 20,
    maxFileBytes: 15 * 1024 * 1024,
    allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"],
  });
  assert.deepEqual(defaults("imaging").requiredCategories, ["IMAGING"]);
  assert.deepEqual(validateResultFiles([pdf("LAB_RESULT")], "laboratory").map((file) => file.category), ["LAB_RESULT"]);
});

test("requires every configured category and enforces per-exam file limits", () => {
  const requirements = {
    requiredCategories: ["IMAGING", "RADIOLOGY_REPORT"],
    allowSupplemental: false,
    allowMultiplePerCategory: false,
    maxFiles: 4,
    maxFileBytes: 2 * 1024 * 1024,
    allowedMimeTypes: ["application/pdf", "image/jpeg"],
  };

  assert.equal(validateResultFiles([pdf("IMAGING"), pdf("RADIOLOGY_REPORT")], "imaging", requirements).length, 2);
  assert.throws(() => validateResultFiles([pdf("IMAGING")], "imaging", requirements), { code: "required-result-file-missing" });
  assert.throws(() => validateResultFiles([pdf("IMAGING"), pdf("IMAGING"), pdf("RADIOLOGY_REPORT")], "imaging", requirements), { code: "multiple-result-files-not-allowed" });
  assert.throws(() => validateResultFiles([pdf("IMAGING"), pdf("RADIOLOGY_REPORT"), { ...pdf("SUPPLEMENTAL"), fileName: "extra.pdf" }], "imaging", requirements), { code: "invalid-result-file-category" });
  assert.throws(() => validateResultFiles([pdf("IMAGING"), pdf("RADIOLOGY_REPORT"), pdf("SUPPLEMENTAL"), { ...pdf("SUPPLEMENTAL"), fileName: "extra.pdf" }], "imaging", { ...requirements, allowSupplemental: true }), { code: "multiple-result-files-not-allowed" });
  assert.throws(() => validateResultFiles([pdf("IMAGING", 2 * 1024 * 1024 + 1), pdf("RADIOLOGY_REPORT")], "imaging", requirements), { code: "invalid-result-file-size" });
  assert.throws(() => validateResultFiles([pdf("IMAGING"), { ...pdf("RADIOLOGY_REPORT"), contentType: "image/png" }], "imaging", requirements), { code: "invalid-result-file-type" });
});

test("rejects unsafe or incompatible admin requirements", () => {
  assert.throws(() => normalizeDiagnosticResultRequirements({
    requiredCategories: ["SUPPLEMENTAL"],
    allowSupplemental: true,
    allowMultiplePerCategory: true,
    maxFiles: 2,
    maxFileBytes: 1024 * 1024,
    allowedMimeTypes: ["application/pdf"],
  }, "laboratory"), { code: "invalid-result-requirements" });

  assert.throws(() => normalizeDiagnosticResultRequirements({
    requiredCategories: ["LAB_RESULT"],
    allowSupplemental: false,
    allowMultiplePerCategory: true,
    maxFiles: 21,
    maxFileBytes: 1024 * 1024,
    allowedMimeTypes: ["application/pdf"],
  }, "laboratory"), { code: "invalid-result-requirements" });

  assert.throws(() => normalizeDiagnosticResultRequirements({
    requiredCategories: ["LAB_RESULT"],
    allowSupplemental: false,
    allowMultiplePerCategory: true,
    maxFiles: 2,
    maxFileBytes: 1024 * 1024,
    allowedMimeTypes: ["application/x-executable"],
  }, "laboratory"), { code: "invalid-result-requirements" });
});
