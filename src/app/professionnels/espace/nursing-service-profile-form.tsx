"use client";

import type { User } from "firebase/auth";
import { FormEvent, useEffect, useState } from "react";
import { appointmentRequest } from "@/lib/appointments/client";

type Period = "DAY" | "NIGHT" | "WEEKEND";
type Zone = { id: string; department: string; commune: string; tariffs: Record<Period, number | null> };
type AvailabilityWeek = { weekStart: string; periods: Period[] };
type PeriodRule = { daysOfWeek: number[]; startTime: string; endTime: string; endDayOffset: number };
type PeriodRules = Record<Period, PeriodRule>;
type ServiceProfile = { experienceStartYear: number; serviceIds: string[]; zoneIds: string[]; weeklyAvailability: AvailabilityWeek[] };

const periods: { id: Period; label: string }[] = [
  { id: "DAY", label: "AM" },
  { id: "NIGHT", label: "PM" },
  { id: "WEEKEND", label: "Week-end" },
];

const defaultPeriodRules: PeriodRules = {
  DAY: { daysOfWeek: [1, 2, 3, 4, 5], startTime: "08:00", endTime: "16:00", endDayOffset: 0 },
  NIGHT: { daysOfWeek: [1, 2, 3, 4, 5], startTime: "16:00", endTime: "08:00", endDayOffset: 1 },
  WEEKEND: { daysOfWeek: [6], startTime: "08:00", endTime: "08:00", endDayOffset: 2 },
};

const weekdayLabels = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];

function scheduleDescription(rule: PeriodRule) {
  const days = [1, 2, 3, 4, 5, 6, 0].filter((day) => rule.daysOfWeek.includes(day)).map((day) => weekdayLabels[day]).join(", ") || "Aucun jour";
  const endDay = rule.endDayOffset === 0 ? "même jour" : rule.endDayOffset === 1 ? "lendemain" : "+" + rule.endDayOffset + " jours";
  return days + " · " + rule.startTime + "–" + rule.endTime + " (" + endDay + ")";
}

const services = [
  { id: "vital_signs", label: "Prise des signes vitaux", detail: "Tension, température, fréquence cardiaque, saturation et glycémie capillaire." },
  { id: "medication_administration", label: "Administration de médicaments", detail: "Injections et perfusions selon prescription et qualification." },
  { id: "wound_care", label: "Soins de plaies", detail: "Pansements, escarres et suivi de cicatrisation." },
  { id: "sample_collection", label: "Prélèvements médicaux", detail: "Prélèvements sanguins et collecte d’échantillons." },
  { id: "postoperative_care", label: "Soins postopératoires", detail: "Surveillance, pansements et retrait selon prescription." },
  { id: "chronic_care", label: "Suivi des maladies chroniques", detail: "Suivi infirmier de patients atteints de maladies chroniques." },
  { id: "elderly_assistance", label: "Assistance aux personnes âgées", detail: "Mobilité, prévention des chutes et surveillance générale." },
  { id: "hygiene_comfort", label: "Soins d’hygiène et de confort", detail: "Aide à l’hygiène, à l’habillage et prévention des escarres." },
  { id: "medical_devices", label: "Gestion de dispositifs médicaux", detail: "Sondes, stomies et oxygénothérapie selon qualification." },
  { id: "therapeutic_education", label: "Éducation thérapeutique", detail: "Conseils de santé et suivi de l’observance." },
  { id: "palliative_care", label: "Accompagnement en soins palliatifs", detail: "Soins de confort et accompagnement du patient et de ses proches." },
];

function htg(value: number | null) {
  return value === null ? "Tarif NEXA à configurer" : `${new Intl.NumberFormat("fr-HT").format(value)} HTG`;
}

function emptyProfile(): ServiceProfile {
  return { experienceStartYear: 0, serviceIds: [], zoneIds: [], weeklyAvailability: [] };
}

export default function NursingServiceProfileForm({ user }: { user: User }) {
  const [profile, setProfile] = useState<ServiceProfile>(emptyProfile());
  const [zones, setZones] = useState<Zone[]>([]);
  const [periodRules, setPeriodRules] = useState<PeriodRules>(defaultPeriodRules);
  const [status, setStatus] = useState("INCOMPLETE");
  const [reviewReason, setReviewReason] = useState("");
  const [weekStart, setWeekStart] = useState("");
  const [weekPeriods, setWeekPeriods] = useState<Period[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void appointmentRequest<{
      profile: ServiceProfile | null;
      zones: Zone[];
      periodRules?: PeriodRules;
      serviceProfileStatus: string;
      serviceProfileReviewReason: string;
    }>(user, "/api/provider/nursing-profile")
      .then((result) => {
        if (!active) return;
        setProfile(result.profile || emptyProfile());
        setZones(result.zones || []);
        setPeriodRules(result.periodRules || defaultPeriodRules);
        setStatus(result.serviceProfileStatus || "INCOMPLETE");
        setReviewReason(result.serviceProfileReviewReason || "");
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Votre profil infirmier n’est pas accessible."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [user]);

  function toggleValue<T extends string>(values: T[], value: T): T[] {
    return values.includes(value) ? values.filter((current) => current !== value) : [...values, value];
  }

  function addWeek() {
    setError(""); setNotice("");
    if (!weekStart || weekPeriods.length === 0) {
      setError("Choisissez le lundi de la semaine et au moins une période de disponibilité.");
      return;
    }
    const date = new Date(`${weekStart}T12:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.getUTCDay() !== 1) {
      setError("La disponibilité doit commencer un lundi.");
      return;
    }
    setProfile((current) => ({
      ...current,
      weeklyAvailability: [...current.weeklyAvailability.filter((week) => week.weekStart !== weekStart), { weekStart, periods: [...weekPeriods] }]
        .sort((left, right) => left.weekStart.localeCompare(right.weekStart)),
    }));
    setWeekStart(""); setWeekPeriods([]);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true); setError(""); setNotice("");
    try {
      const result = await appointmentRequest<{ serviceProfileStatus: string; message: string; profile: ServiceProfile }>(
        user,
        "/api/provider/nursing-profile",
        "POST",
        profile,
      );
      setProfile(result.profile);
      setStatus(result.serviceProfileStatus);
      setReviewReason("");
      setNotice(result.message);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le profil infirmier n’a pas pu être enregistré."); }
    finally { setSaving(false); }
  }

  const statusText: Record<string, string> = {
    INCOMPLETE: "Profil incomplet · non visible et non réservable",
    PENDING_REVIEW: "Profil transmis · vérification NEXA en attente",
    APPROVED: "Profil vérifié · publication et réservation infirmière encore à ouvrir",
    REJECTED: "Correction demandée par NEXA",
  };

  return <section className="provider-slots nursing-provider-profile" aria-labelledby="nursing-profile-title">
    <h2 id="nursing-profile-title">Profil de soins infirmiers à domicile</h2>
    <p>{statusText[status] || "Profil à compléter"}</p>
    <p>Le rôle infirmier peut consigner les soins autorisés, mais ne peut pas prescrire de médicaments. Les actes proposés sont soumis au contrôle NEXA de vos qualifications.</p>
    {reviewReason ? <p className="form-error" role="alert">Motif communiqué par NEXA : {reviewReason}</p> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {notice ? <p className="form-notice" role="status">{notice}</p> : null}
    {loading ? <p role="status">Chargement du profil et des zones…</p> : <form className="nursing-profile-form" onSubmit={(event) => void save(event)}>
      <label>Année de début d’activité infirmière<input required max={new Date().getFullYear()} min="1950" step="1" type="number" value={profile.experienceStartYear || ""} onChange={(event) => setProfile((current) => ({ ...current, experienceStartYear: Number(event.target.value) }))} /></label>

      <fieldset className="nursing-services-fieldset"><legend>Services proposés</legend><div className="nursing-service-options">{services.map((service) => <label className="nursing-service-option" key={service.id}><input checked={profile.serviceIds.includes(service.id)} onChange={() => setProfile((current) => ({ ...current, serviceIds: toggleValue(current.serviceIds, service.id) }))} type="checkbox" /><span><strong>{service.label}</strong><small>{service.detail}</small></span></label>)}</div></fieldset>

      <fieldset className="nursing-services-fieldset"><legend>Zones desservies et tarifs par période</legend>{zones.length ? <div className="nursing-zone-options">{zones.map((zone) => <label className="nursing-zone-option" key={zone.id}><input checked={profile.zoneIds.includes(zone.id)} onChange={() => setProfile((current) => ({ ...current, zoneIds: toggleValue(current.zoneIds, zone.id) }))} type="checkbox" /><span><strong>{zone.commune}, {zone.department}</strong><small>{periods.map((period) => (period.label + " (" + scheduleDescription(periodRules[period.id]) + ") : " + htg(zone.tariffs[period.id]) + " / période complète")).join(" · ")}</small></span></label>)}</div> : <p>Aucune zone infirmière n’est encore ouverte par NEXA. Votre profil restera invisible jusqu’à la configuration d’une zone.</p>}</fieldset>

      <fieldset className="nursing-services-fieldset"><legend>Semaines et week-ends de travail</legend><p>Les jours et horaires des blocs AM, PM et Week-end sont définis par l’administration en heure locale d’Haïti. Choisissez le lundi de chaque semaine où vous travaillez, puis les périodes offertes pendant cette semaine. Les tarifs complets de chaque bloc sont aussi fixés par NEXA; une disponibilité publiée n’ouvre pas encore de réservation patient.</p><div className="nursing-week-builder"><label>Lundi de la semaine<input required type="date" value={weekStart} onChange={(event) => setWeekStart(event.target.value)} /></label><div className="nursing-period-options">{periods.map((period) => <label key={period.id}><input checked={weekPeriods.includes(period.id)} onChange={() => setWeekPeriods((current) => toggleValue(current, period.id))} type="checkbox" /><span><strong>{period.label}</strong><small>{scheduleDescription(periodRules[period.id])}</small></span></label>)}</div><button className="button button-outline" onClick={addWeek} type="button">Ajouter cette semaine / ce week-end</button></div>{profile.weeklyAvailability.length ? <ul className="nursing-week-list">{profile.weeklyAvailability.map((week) => <li key={week.weekStart}><span><strong>Semaine du {week.weekStart}</strong><small>{week.periods.map((id) => { const period = periods.find((entry) => entry.id === id); return period ? period.label + " · " + scheduleDescription(periodRules[id]) : id; }).join(" · ")}</small></span><button className="button button-quiet" onClick={() => setProfile((current) => ({ ...current, weeklyAvailability: current.weeklyAvailability.filter((entry) => entry.weekStart !== week.weekStart) }))} type="button">Retirer</button></li>)}</ul> : <p>Aucune semaine ou aucun week-end n’est encore programmé.</p>}</fieldset>

      <p className="nursing-profile-note">Les tarifs sont définis par l’administration NEXA et représentent le prix total de la période sélectionnée pour la semaine ou le week-end. Aucune réservation patient ni rémunération n’est ouverte dans cette étape; le détail des prestations et leur validation seront définis dans le parcours de mission.</p>
      <button className="button button-primary" disabled={saving || zones.length === 0} type="submit">{saving ? "Enregistrement…" : "Enregistrer le profil infirmier"}</button>
    </form>}
  </section>;
}
