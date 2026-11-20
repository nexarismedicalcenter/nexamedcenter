import "server-only";

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { ApiRequestError } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

export async function enforceUserRateLimit(input: {
  uid: string;
  action: string;
  limit: number;
  windowMs: number;
}): Promise<void> {
  const now = Date.now();
  const id = createHash("sha256").update(`${input.uid}:${input.action}`).digest("hex");
  const ref = getFirebaseAdminDb().collection("apiRateLimitWindows").doc(id);
  await getFirebaseAdminDb().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const oldWindowStart = Number(snapshot.get("windowStartMs"));
    const oldCount = Number(snapshot.get("count"));
    const active = Number.isFinite(oldWindowStart) && oldWindowStart + input.windowMs > now;
    const count = active && Number.isSafeInteger(oldCount) ? oldCount : 0;
    const windowStartMs = active ? oldWindowStart : now;
    if (count >= input.limit) {
      throw new ApiRequestError(429, "rate-limit-exceeded", "Trop de demandes. Attendez quelques minutes puis réessayez.");
    }
    transaction.set(ref, {
      action: input.action,
      count: count + 1,
      windowStartMs,
      expiresAtMs: windowStartMs + input.windowMs,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}
