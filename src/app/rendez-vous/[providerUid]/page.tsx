import type { Metadata } from "next";
import { Suspense } from "react";
import AppointmentBooking from "./appointment-booking";

export const metadata: Metadata = {
  title: "Prendre rendez-vous",
  description: "Consultez les disponibilités d’un médecin vérifié du réseau NEXA.",
  robots: { index: false, follow: false },
};

async function AppointmentContent({ params }: { params: Promise<{ providerUid: string }> }) {
  const { providerUid } = await params;
  return <AppointmentBooking providerUid={providerUid} />;
}

export default function AppointmentPage({ params }: { params: Promise<{ providerUid: string }> }) {
  return <Suspense fallback={<main className="appointment-page"><section className="appointment-shell" role="status">Ouverture des disponibilités…</section></main>}><AppointmentContent params={params} /></Suspense>;
}
