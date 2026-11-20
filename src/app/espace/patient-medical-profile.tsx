"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";

type Answer = { yes: boolean | null; details: string };
type Condition = { diagnosed: boolean | null; sinceMonth: string };
type MedicalProfile = {
  languages: string[];
  allergies: Answer;
  diabetes: Condition;
  hypertension: Condition;
  tobacco: Answer;
  alcohol: Answer;
  coffee: Answer;
  tea: Answer;
};
type Identity = { firstName: string; lastName: string; birthDate: string; sex: string };
type ProfileResponse = { profile: MedicalProfile | null; identity: Identity };

const emptyAnswer = (): Answer => ({ yes: null, details: "" });
const emptyCondition = (): Condition => ({ diagnosed: null, sinceMonth: "" });
const emptyProfile = (): MedicalProfile => ({
  languages: [], allergies: emptyAnswer(), diabetes: emptyCondition(), hypertension: emptyCondition(),
  tobacco: emptyAnswer(), alcohol: emptyAnswer(), coffee: emptyAnswer(), tea: emptyAnswer(),
});
const languages = [
  { id: "creole", label: "Créole haïtien" }, { id: "french", label: "Français" },
  { id: "english", label: "Anglais" }, { id: "spanish", label: "Espagnol" },
];

export default function PatientMedicalProfile({ user }: { user: User }) {
  const [identity, setIdentity] = useState<Identity>({ firstName: "", lastName: "", birthDate: "", sex: "" });
  const [profile, setProfile] = useState<MedicalProfile>(emptyProfile);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    void appointmentRequest<ProfileResponse>(user, "/api/patient/medical-profile")
      .then((result) => {
        if (!active) return;
        setIdentity(result.identity || { firstName: "", lastName: "", birthDate: "", sex: "" });
        setProfile(result.profile ? {
          ...emptyProfile(),
          ...result.profile,
          allergies: { ...emptyAnswer(), ...result.profile.allergies },
          diabetes: { ...emptyCondition(), ...result.profile.diabetes },
          hypertension: { ...emptyCondition(), ...result.profile.hypertension },
          tobacco: { ...emptyAnswer(), ...result.profile.tobacco },
          alcohol: { ...emptyAnswer(), ...result.profile.alcohol },
          coffee: { ...emptyAnswer(), ...result.profile.coffee },
          tea: { ...emptyAnswer(), ...result.profile.tea },
        } : emptyProfile());
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "La fiche médicale ne peut pas être chargée."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [user]);

  function setAnswer(key: "allergies" | "tobacco" | "alcohol" | "coffee" | "tea", patch: Partial<Answer>) {
    setProfile((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  }

  function setCondition(key: "diabetes" | "hypertension", patch: Partial<Condition>) {
    setProfile((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      await appointmentRequest(user, "/api/patient/medical-profile", "PUT", { profile });
      setNotice("Votre fiche médicale a été enregistrée.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "La fiche médicale n’a pas été enregistrée.");
    } finally { setBusy(false); }
  }

  return <section className="patient-appointments patient-medical-profile" aria-labelledby="patient-medical-profile-title">
    <h2 id="patient-medical-profile-title">Ma fiche médicale initiale</h2>
    <p>Ces informations de santé sont privées. Elles sont communiquées au médecin associé uniquement lorsqu’une consultation payée a commencé, pendant sa période d’accès autorisée.</p>
    {loading ? <p role="status">Chargement de votre fiche médicale…</p> : <>
      <div className="clinical-record-meta">
        <span><small>Nom du compte</small><strong>{[identity.firstName, identity.lastName].filter(Boolean).join(" ") || "À compléter dans le profil"}</strong></span>
        <span><small>Date de naissance</small><strong>{identity.birthDate || "Non renseignée"}</strong></span>
        <span><small>Sexe</small><strong>{identity.sex || "Non renseigné"}</strong></span>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p className="form-notice" role="status">{notice}</p> : null}
      <form className="auth-form" onSubmit={(event) => void save(event)}>
        <fieldset>
          <legend>Langues préférées</legend>
          <div className="form-grid">
            {languages.map((language) => <label key={language.id}>
              <input type="checkbox" checked={profile.languages.includes(language.id)} onChange={(event) => setProfile((current) => ({
                ...current,
                languages: event.target.checked ? [...current.languages, language.id] : current.languages.filter((item) => item !== language.id),
              }))} /> {language.label}
            </label>)}
          </div>
        </fieldset>
        <YesNoField label="Avez-vous des allergies connues ?" value={profile.allergies} detailLabel="Précisez les allergies" onChange={(patch) => setAnswer("allergies", patch)} />
        <ConditionField label="Diabète diagnostiqué ?" value={profile.diabetes} onChange={(patch) => setCondition("diabetes", patch)} />
        <ConditionField label="Hypertension diagnostiquée ?" value={profile.hypertension} onChange={(patch) => setCondition("hypertension", patch)} />
        <YesNoField label="Consommez-vous du tabac ?" value={profile.tobacco} detailLabel="Quantité ou fréquence" onChange={(patch) => setAnswer("tobacco", patch)} />
        <YesNoField label="Consommez-vous de l’alcool ?" value={profile.alcohol} detailLabel="Quantité ou fréquence" onChange={(patch) => setAnswer("alcohol", patch)} />
        <YesNoField label="Consommez-vous du café ?" value={profile.coffee} detailLabel="Quantité ou fréquence" onChange={(patch) => setAnswer("coffee", patch)} />
        <YesNoField label="Consommez-vous du thé ?" value={profile.tea} detailLabel="Quantité ou fréquence" onChange={(patch) => setAnswer("tea", patch)} />
        <p className="appointment-privacy">Votre médecin vérifiera ces réponses avec vous. Elles ne remplacent pas son évaluation clinique.</p>
        <button className="button button-primary" disabled={busy || loading} type="submit">{busy ? "Enregistrement…" : "Enregistrer ma fiche médicale"}</button>
      </form>
    </>}
  </section>;
}

function YesNoField({ label, detailLabel, value, onChange }: { label: string; detailLabel: string; value: Answer; onChange: (patch: Partial<Answer>) => void }) {
  return <fieldset>
    <legend>{label}</legend>
    <label>Réponse<select required value={value.yes === null ? "" : String(value.yes)} onChange={(event) => onChange({ yes: event.target.value === "" ? null : event.target.value === "true", details: event.target.value === "true" ? value.details : "" })}>
      <option value="">Choisissez une réponse</option><option value="true">Oui</option><option value="false">Non</option>
    </select></label>
    {value.yes ? <label>{detailLabel}<input required value={value.details} onChange={(event) => onChange({ details: event.target.value })} maxLength={500} /></label> : null}
  </fieldset>;
}

function ConditionField({ label, value, onChange }: { label: string; value: Condition; onChange: (patch: Partial<Condition>) => void }) {
  return <fieldset>
    <legend>{label}</legend>
    <label>Réponse<select required value={value.diagnosed === null ? "" : String(value.diagnosed)} onChange={(event) => onChange({ diagnosed: event.target.value === "" ? null : event.target.value === "true", sinceMonth: event.target.value === "true" ? value.sinceMonth : "" })}>
      <option value="">Choisissez une réponse</option><option value="true">Oui</option><option value="false">Non</option>
    </select></label>
    {value.diagnosed ? <label>Mois et année du diagnostic<input required type="month" value={value.sinceMonth} onChange={(event) => onChange({ sinceMonth: event.target.value })} /></label> : null}
  </fieldset>;
}
