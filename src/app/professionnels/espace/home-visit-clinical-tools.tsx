"use client";

import { useState } from "react";
import type { User } from "firebase/auth";
import ClinicalRecordPanel from "@/app/teleconsultation/clinical-record-panel";
import PrescriptionPanel from "@/app/teleconsultation/prescription-panel";

export default function HomeVisitClinicalTools({ user, appointmentId }: { user: User; appointmentId: string }) {
  const [open, setOpen] = useState(false);
  return <section className="home-visit-clinical-tools" aria-label="Dossier clinique de la visite">
    <button className="button button-outline" aria-expanded={open} onClick={() => setOpen((current) => !current)} type="button">{open ? "Fermer le dossier" : "Évaluation et ordonnance"}</button>
    {open ? <div className="home-visit-clinical-tools-panels"><ClinicalRecordPanel user={user} appointmentId={appointmentId} /><PrescriptionPanel user={user} appointmentId={appointmentId} /></div> : null}
  </section>;
}
