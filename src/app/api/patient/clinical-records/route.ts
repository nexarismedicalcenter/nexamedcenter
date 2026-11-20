import { NextResponse } from "next/server";
import { ApiRequestError, corsHeaders, requireAppCheck, requireFirebaseUser } from "@/lib/auth/server";
import { getFirebaseAdminDb } from "@/lib/firebase/admin";

function json(request: Request, body: Record<string, unknown>) {
  const headers = corsHeaders(request);
  headers.set("Cache-Control", "no-store, max-age=0");
  return NextResponse.json(body, { headers });
}

function failure(request: Request, error: unknown) {
  const status = error instanceof ApiRequestError ? error.status : 500;
  const code = error instanceof ApiRequestError ? error.code : "patient-records-unavailable";
  const message = error instanceof ApiRequestError ? error.message : "La liste des dossiers n’est pas accessible pour le moment.";
  if (!(error instanceof ApiRequestError)) console.error("NEXA patient record index failed", error instanceof Error ? error.name : "unknown-error");
  const headers = new Headers({ "Cache-Control": "no-store, max-age=0" });
  try { corsHeaders(request).forEach((value, key) => headers.set(key, value)); } catch { /* disallowed origin */ }
  return NextResponse.json({ ok: false, code, error: message }, { status, headers });
}

function iso(value: unknown): string | null {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return (value.toDate() as Date).toISOString();
  }
  return typeof value === "string" ? value : null;
}

export async function OPTIONS(request: Request) {
  try { return new Response(null, { status: 204, headers: corsHeaders(request) }); }
  catch (error) { return new Response(null, { status: error instanceof ApiRequestError ? error.status : 403 }); }
}

export async function GET(request: Request) {
  try {
    const user = await requireFirebaseUser(request);
    await requireAppCheck(request);
    const db = getFirebaseAdminDb();
    const profile = await db.collection("patientProfiles").doc(user.uid).get();
    if (!profile.exists || profile.get("role") !== "patient" || profile.get("profileComplete") !== true) {
      throw new ApiRequestError(403, "patient-profile-required", "Un profil patient NEXA complet est requis.");
    }
    const snapshot = await db.collection("electronicPatientRecords")
      .where("patientUid", "==", user.uid)
      .orderBy("createdAt", "desc")
      .limit(100)
      .get();
    const records = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        recordId: doc.id,
        recordType: data.recordType === "STANDALONE" ? "STANDALONE" : "APPOINTMENT",
        appointmentId: data.appointmentId,
        recordNumber: data.recordNumber,
        status: data.status,
        providerName: data.providerName,
        specialtyName: data.specialtyName,
        createdAt: iso(data.createdAt),
        finalizedAt: iso(data.finalizedAt),
        addendumCount: Number(data.addendumCount) || 0,
      };
    });
    return json(request, { ok: true, records });
  } catch (error) { return failure(request, error); }
}
