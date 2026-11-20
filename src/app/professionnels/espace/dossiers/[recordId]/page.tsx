import { Suspense } from "react";
import type { Metadata } from "next";
import StandaloneClinicalRecordPage from "./standalone-clinical-record-page";

export const metadata: Metadata = { title: "Dossier clinique", robots: { index: false, follow: false } };

export default function StandaloneClinicalRecordRoute({ params }: { params: Promise<{ recordId: string }> }) {
  return <Suspense fallback={<main className="appointment-page"><section className="appointment-shell"><p role="status">Ouverture du dossier clinique…</p></section></main>}>
    {params.then(({ recordId }) => <StandaloneClinicalRecordPage recordId={recordId} />)}
  </Suspense>;
}
