import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  getTeleconsultationVideoLimitSeconds,
  reconcileStaleTeleconsultationPresence,
  recordTeleconsultationPresence,
  TeleconsultationPresenceError,
} from "../src/lib/teleconsultation/presence.server.ts";

const projectId = "demo-nexaris";
const app = initializeApp({ projectId }, "teleconsultation-presence-tests");
const db = getFirestore(app);
const baseTime = 1_800_000_000_000;

async function clearFirestoreEmulator() {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
  if (!emulatorHost) throw new Error("Refusing to clear Firestore without an emulator host.");
  const parsedHost = new URL(`http://${emulatorHost}`).hostname;
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsedHost)) {
    throw new Error("Refusing to clear a non-local Firestore target.");
  }
  const response = await fetch(
    `http://${emulatorHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  assert.equal(response.ok, true, "Firestore emulator must be available and clearable.");
}

function appointment(overrides = {}) {
  return {
    patientUid: "patient-uid",
    providerUid: "doctor-uid",
    providerType: "doctor",
    bookingType: "teleconsultation",
    status: "IN_PROGRESS",
    paymentStatus: "PAID",
    sessionStatus: "IN_PROGRESS",
    effectiveConsultationStartedAt: new Date(baseTime - 10_000).toISOString(),
    videoConnectedParticipants: {
      "patient-uid": baseTime - 10_000,
      "doctor-uid": baseTime - 10_000,
    },
    startsAt: new Date(baseTime - 60_000).toISOString(),
    endsAt: new Date(baseTime + 30 * 60_000).toISOString(),
    interactiveEndsAt: new Date(baseTime + 60 * 60_000).toISOString(),
    consultationRights: { durationMinutes: 5 },
    ...overrides,
  };
}

beforeEach(clearFirestoreEmulator);
after(() => app.delete());

test("a paid teleconsultation plan of 25 minutes caps the video quota independently of its 30-minute slot", () => {
  const limit = getTeleconsultationVideoLimitSeconds(appointment({
    endsAt: new Date(baseTime + 30 * 60_000).toISOString(),
    consultationRights: { durationMinutes: 25 },
  }));
  assert.equal(limit, 25 * 60);
});

test("counts server-observed time only while both appointment participants are present", async () => {
  const ref = db.collection("appointments").doc("presence_accounting_001");
  await ref.set(appointment());

  const patientJoin = await recordTeleconsultationPresence(db, {
    appointmentId: ref.id, uid: "patient-uid", action: "join", nowMs: baseTime,
  });
  const doctorJoin = await recordTeleconsultationPresence(db, {
    appointmentId: ref.id, uid: "doctor-uid", action: "join", nowMs: baseTime + 10_000,
  });
  await ref.update({ videoConnectedParticipants: { "patient-uid": baseTime + 20_000, "doctor-uid": baseTime + 20_000 } });
  const patientHeartbeat = await recordTeleconsultationPresence(db, {
    appointmentId: ref.id, uid: "patient-uid", action: "heartbeat", nowMs: baseTime + 20_000,
  });
  await ref.update({ videoConnectedParticipants: { "patient-uid": baseTime + 30_000, "doctor-uid": baseTime + 30_000 } });
  const doctorHeartbeat = await recordTeleconsultationPresence(db, {
    appointmentId: ref.id, uid: "doctor-uid", action: "heartbeat", nowMs: baseTime + 30_000,
  });
  await ref.update({ videoConnectedParticipants: { "patient-uid": baseTime + 40_000, "doctor-uid": baseTime + 40_000 } });
  const patientLeaves = await recordTeleconsultationPresence(db, {
    appointmentId: ref.id, uid: "patient-uid", action: "leave", nowMs: baseTime + 40_000,
  });
  const doctorLeaves = await recordTeleconsultationPresence(db, {
    appointmentId: ref.id, uid: "doctor-uid", action: "leave", nowMs: baseTime + 50_000,
  });
  const final = await ref.get();

  assert.equal(patientJoin.videoConsumedSeconds, 0);
  assert.equal(patientJoin.videoStatus, "WAITING");
  assert.equal(doctorJoin.videoConsumedSeconds, 0);
  assert.equal(doctorJoin.videoStatus, "ACTIVE");
  assert.equal(patientHeartbeat.videoConsumedSeconds, 10);
  assert.equal(doctorHeartbeat.videoConsumedSeconds, 20);
  assert.equal(patientLeaves.videoConsumedSeconds, 30);
  assert.equal(doctorLeaves.videoConsumedSeconds, 30);
  assert.equal(final.get("videoConsumedSeconds"), 30);
  assert.equal(final.get("videoStatus"), "ENDED");
  assert.deepEqual(final.get("videoParticipants"), {});
});

test("does not count a lone participant and removes abandoned presence", async () => {
  const ref = db.collection("appointments").doc("presence_reconcile_001");
  await ref.set(appointment());
  await recordTeleconsultationPresence(db, {
    appointmentId: ref.id, uid: "patient-uid", action: "join", nowMs: baseTime,
  });
  await recordTeleconsultationPresence(db, {
    appointmentId: ref.id, uid: "doctor-uid", action: "join", nowMs: baseTime + 1_000,
  });

  const reconciled = await reconcileStaleTeleconsultationPresence(db, baseTime + 31_001);
  const final = await ref.get();

  assert.equal(reconciled.checked, 1);
  assert.equal(reconciled.reconciled, 1);
  assert.equal(final.get("videoConsumedSeconds"), 0);
  assert.equal(final.get("videoStatus"), "ENDED");
  assert.deepEqual(final.get("videoParticipants"), {});
  assert.equal(final.get("videoActiveSinceMs"), null);
});

test("caps usage at the purchased video limit and expires the interactive session", async () => {
  const ref = db.collection("appointments").doc("presence_quota_001");
  await ref.set(appointment({
    consultationRights: { durationMinutes: 1 },
    videoConsumedMilliseconds: 59_000,
    videoConsumedSeconds: 59,
    videoParticipants: {
      "patient-uid": { lastSeenAtMs: baseTime },
      "doctor-uid": { lastSeenAtMs: baseTime },
    },
    videoActiveSinceMs: baseTime,
  }));

  const result = await recordTeleconsultationPresence(db, {
    appointmentId: ref.id, uid: "patient-uid", action: "heartbeat", nowMs: baseTime + 2_000,
  });
  const final = await ref.get();

  assert.equal(result.expired, true);
  assert.equal(result.videoConsumedSeconds, 60);
  assert.equal(result.videoRemainingSeconds, 0);
  assert.equal(final.get("sessionStatus"), "INTERACTIVE_TIME_EXPIRED");
  assert.equal(final.get("videoStatus"), "ENDED");
  assert.deepEqual(final.get("videoParticipants"), {});
});

test("rejects presence updates from users outside the appointment", async () => {
  const ref = db.collection("appointments").doc("presence_forbidden_001");
  await ref.set(appointment());

  await assert.rejects(
    recordTeleconsultationPresence(db, {
      appointmentId: ref.id, uid: "unrelated-uid", action: "join", nowMs: baseTime,
    }),
    TeleconsultationPresenceError,
  );
  assert.equal((await ref.get()).get("videoParticipants"), undefined);
});
