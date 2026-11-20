"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { HOME_VISIT_SERVICES } from "@/lib/home-visits";

type HomeVisitDoctor = {
  id: string;
  name: string;
  specialty?: string;
  bio?: string;
  photoUrl?: string;
  homeVisitServices: { id: string; label: string; tariffHTG: number }[];
  homeVisitZones: { department: string; commune: string }[];
};

export default function HomeVisitDirectory() {
  const [doctors, setDoctors] = useState<HomeVisitDoctor[]>([]);
  const [serviceId, setServiceId] = useState<string>(HOME_VISIT_SERVICES[0].id);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/catalog?type=doctors&service=HOME_VISIT&serviceId=${encodeURIComponent(serviceId)}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { ok?: boolean; results?: HomeVisitDoctor[]; error?: string };
        if (!response.ok || !payload.ok) throw new Error(payload.error || "Le répertoire des visites n’est pas disponible.");
        setDoctors(payload.results || []);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Le répertoire des visites n’est pas disponible.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [serviceId]);

  return <section className="directory-results" aria-labelledby="home-visit-doctors-title">
    <div className="directory-results-heading"><h2 id="home-visit-doctors-title">Choisissez le type de soin</h2><p>Le répertoire affiche ensuite les médecins vérifiés qui proposent ce soin dans votre zone.</p></div>
    <div className="home-visit-service-filter"><label>Type de soin<select value={serviceId} onChange={(event) => { setServiceId(event.target.value); setLoading(true); setError(""); }}><option value="">Choisissez un service</option>{HOME_VISIT_SERVICES.map((service) => <option key={service.id} value={service.id}>{service.label}</option>)}</select></label></div>
    <div className="directory-results-heading"><h2>{loading ? "Chargement des médecins…" : `${doctors.length} médecin${doctors.length === 1 ? "" : "s"} disponible${doctors.length === 1 ? "" : "s"}`}</h2><p>Tarif du soin affiché en HTG. Les frais de transaction et le total sont calculés avant le paiement.</p></div>
    {error ? <div className="directory-state directory-error" role="alert"><p>{error}</p><button className="button button-outline" onClick={() => window.location.reload()} type="button">Réessayer</button></div> : null}
    {!loading && !error && doctors.length === 0 ? <div className="directory-state"><h3>Aucun médecin ne propose actuellement ce soin</h3><p>Les tarifs et communes doivent d’abord être configurés par NEXA.</p></div> : null}
    <div className="directory-grid" aria-live="polite">{doctors.map((doctor) => <article className="directory-card" key={doctor.id}>
      <div className="directory-card-top"><span className="directory-avatar" aria-hidden="true">{doctor.name.slice(0, 1).toLocaleUpperCase("fr")}</span><span className="directory-verified"><span aria-hidden="true">✓</span> Médecin vérifié</span></div>
      <h3>{doctor.name}</h3>
      {doctor.specialty ? <p className="directory-specialty">{doctor.specialty}</p> : null}
      {doctor.bio ? <p>{doctor.bio}</p> : null}
      <p className="directory-location">Zones desservies : {doctor.homeVisitZones.map((zone) => `${zone.commune}, ${zone.department}`).join(" · ")}</p>
      {doctor.homeVisitServices.filter((service) => service.id === serviceId).map((service) => <p className="directory-fee" key={service.id}>{service.label} · visite d’une heure : {new Intl.NumberFormat("fr-HT").format(service.tariffHTG)} HTG</p>)}
      <Link className="button button-primary" href={`/rendez-vous/${encodeURIComponent(doctor.id)}?serviceType=HOME_VISIT&serviceId=${encodeURIComponent(serviceId)}`}>Voir les créneaux</Link>
    </article>)}</div>
  </section>;
}
