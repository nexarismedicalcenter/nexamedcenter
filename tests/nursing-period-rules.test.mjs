import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_NURSING_PERIOD_RULES,
  configuredNursingPeriodRules,
  normalizeNursingPeriodRules,
} from "../src/lib/nursing/service-profile.server.ts";

test("nursing schedule defaults match the approved AM, PM, and weekend blocks", () => {
  assert.deepEqual(DEFAULT_NURSING_PERIOD_RULES.DAY, { daysOfWeek: [1, 2, 3, 4, 5], startTime: "08:00", endTime: "16:00", endDayOffset: 0 });
  assert.deepEqual(DEFAULT_NURSING_PERIOD_RULES.NIGHT, { daysOfWeek: [1, 2, 3, 4, 5], startTime: "16:00", endTime: "08:00", endDayOffset: 1 });
  assert.deepEqual(DEFAULT_NURSING_PERIOD_RULES.WEEKEND, { daysOfWeek: [6], startTime: "08:00", endTime: "08:00", endDayOffset: 2 });
});

test("admin nursing period rules normalize days and reject invalid windows", () => {
  const rules = structuredClone(DEFAULT_NURSING_PERIOD_RULES);
  rules.DAY.daysOfWeek = [5, 1, 3, 2, 4];
  assert.deepEqual(normalizeNursingPeriodRules(rules)?.DAY.daysOfWeek, [1, 2, 3, 4, 5]);
  assert.equal(normalizeNursingPeriodRules({ ...rules, NIGHT: { ...rules.NIGHT, endDayOffset: 3 } }), null);
  assert.equal(normalizeNursingPeriodRules({ ...rules, DAY: { ...rules.DAY, endTime: "08:00" } }), null);
  assert.equal(normalizeNursingPeriodRules({ ...rules, WEEKEND: { ...rules.WEEKEND, daysOfWeek: [6, 6] } }), null);
  assert.equal(normalizeNursingPeriodRules({ ...rules, NIGHT: { ...rules.NIGHT, startTime: "24:00" } }), null);
});

test("missing or malformed stored nursing rules fall back to the approved defaults", () => {
  assert.deepEqual(configuredNursingPeriodRules(null), DEFAULT_NURSING_PERIOD_RULES);
  assert.deepEqual(configuredNursingPeriodRules({ periodRules: { DAY: {} } }), DEFAULT_NURSING_PERIOD_RULES);
});
