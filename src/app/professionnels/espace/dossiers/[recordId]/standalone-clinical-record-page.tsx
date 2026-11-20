"use client";

import Link from "next/link";
import { onAuthStateChanged, type User } from "firebase/auth";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import ClinicalRecordPanel from "@/app/teleconsultation/clinical-record-panel";
import { getFirebaseAuth } from "@/lib/firebase/client";

export default function StandaloneClinicalRecordPage({ recordId }: { recordId: string }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => onAuthStateChanged(getFirebaseAuth(), (currentUser) => {
    setUser(currentUser);
    setLoading(false);
    if (!currentUser) router.replace(`/connexion?next=${encodeURIComponent(`/professionnels/espace/dossiers/${recordId}`)}`);
  }), [recordId, router]);

  return <main className="appointment-page">
    <header className="directory-header"><Link className="brand brand-compact" href="/" aria-label="NEXA Medical Center, accueil"><span className="brand-mark" aria-hidden="true">N</span><span>NEXA <small>MEDICAL CENTER</small></span></Link><Link className="button button-outline" href="/professionnels/espace">Espace professionnel</Link></header>
    <section className="appointment-shell"><p className="eyebrow">Dossier clinique autonome NEXA</p>
      {loading ? <p role="status">Vérification de la session…</p> : user ? <ClinicalRecordPanel user={user} recordId={recordId} /> : <p role="status">Redirection vers la connexion…</p>}
    </section>
    <footer className="directory-footer"><Link href="/conditions">Conditions</Link><Link href="/confidentialite">Confidentialité</Link><span>© 2026 NEXA Medical Center</span></footer>
  </main>;
}
