"use client";

import Link from "next/link";
import { createUserWithEmailAndPassword, onAuthStateChanged, sendEmailVerification, type User } from "firebase/auth";
import { FormEvent, useEffect, useState } from "react";
import { getFirebaseAuth } from "@/lib/firebase/client";
import { initializePatientProfile, PatientApiError } from "@/lib/patients/client";
import { NURSING_QUALIFICATIONS, submitProfessionalApplication } from "@/lib/professional-applications/client";

const initial = { providerType: "doctor", name: "", specialty: "", indicativeFee: "", phone: "", department: "", commune: "", publicBio: "" };

export default function ProfessionalApplicationForm({ fixedProviderType }: { fixedProviderType?: "nurse" } = {}) {
  const [user, setUser] = useState<User | null>(null);
  const [values, setValues] = useState({ ...initial, ...(fixedProviderType ? { providerType: fixedProviderType } : {}) });
  const [selectedNursingQualifications, setSelectedNursingQualifications] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [patientNumber, setPatientNumber] = useState("");

  useEffect(() => onAuthStateChanged(getFirebaseAuth(), (currentUser) => {
    setUser(currentUser);
    if (currentUser?.email) setEmail(currentUser.email);
  }), []);

  function update(key: keyof typeof initial, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setNotice("");
    if (!accepted) { setError("Vous devez accepter les conditions et lire la politique de confidentialité."); return; }
    if (values.providerType === "nurse" && selectedNursingQualifications.length === 0) { setError("Choisissez au moins une qualification infirmière."); return; }
    setBusy(true);
    try {
      let currentUser = getFirebaseAuth().currentUser;
      if (!currentUser) {
        const credential = await createUserWithEmailAndPassword(getFirebaseAuth(), email.trim(), password);
        currentUser = credential.user;
        setUser(currentUser);
      } else if (currentUser.email?.toLowerCase() !== email.trim().toLowerCase()) {
        throw new Error("L’adresse doit correspondre au compte connecté.");
      }
      const patientProfile = await initializePatientProfile(currentUser);
      setPatientNumber(patientProfile.patientNumber);
      const result = await submitProfessionalApplication(currentUser, {
        ...values,
        indicativeFee: values.providerType === "doctor" ? Number(values.indicativeFee) : undefined,
        nursingQualifications: values.providerType === "nurse" ? selectedNursingQualifications : undefined,
        termsAccepted: accepted,
      });
      setSubmitted(true);
      setNotice(result.alreadySubmitted ? "Votre pré-demande est déjà en cours d’examen." : "Votre pré-demande a été envoyée à l’équipe NEXA.");
      if (!currentUser.emailVerified) await sendEmailVerification(currentUser).catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof PatientApiError
        ? cause.message
        : cause instanceof Error && !("code" in cause)
          ? cause.message
          : "La pré-demande n’a pas pu être envoyée. Vérifiez vos informations et réessayez.");
      if (getFirebaseAuth().currentUser) setUser(getFirebaseAuth().currentUser);
    } finally { setBusy(false); }
  }

  if (submitted) return <section className="success-panel" aria-live="polite"><span className="success-mark" aria-hidden="true">✓</span><p className="eyebrow">Demande enregistrée</p><h2>Merci de rejoindre NEXA.</h2><p>{notice}</p>{patientNumber ? <p className="patient-number" aria-label={`Votre numéro patient est ${patientNumber}`}>Votre numéro patient NEXA : <strong>{patientNumber}</strong></p> : null}<p>Vous pouvez suivre la suite depuis cette adresse e-mail. Ne transmettez aucun document par e-mail.</p><Link className="button button-primary" href="/">Retour à l’accueil</Link></section>;

  return (
    <form className="auth-form" onSubmit={handleSubmit}>
      {!fixedProviderType ? <label>Type de professionnel <span aria-hidden="true">*</span><select value={values.providerType} onChange={(event) => update("providerType", event.target.value)}><option value="doctor">Médecin</option><option value="laboratory">Laboratoire</option><option value="imaging">Centre d’imagerie</option><option value="pharmacy">Pharmacie</option></select></label> : <p className="account-notice">Candidature distincte · personnel infirmier à domicile</p>}
      <label>Nom professionnel ou établissement <span aria-hidden="true">*</span><input autoComplete="organization" maxLength={120} required value={values.name} onChange={(event) => update("name", event.target.value)} /></label>
      {values.providerType === "doctor" ? <label>Spécialité médicale <span aria-hidden="true">*</span><input autoComplete="off" maxLength={100} required value={values.specialty} onChange={(event) => update("specialty", event.target.value)} /></label> : null}
      {values.providerType === "doctor" ? <label>Tarif proposé pour une consultation (HTG) <span aria-hidden="true">*</span><input inputMode="numeric" min="1" max="10000000" required type="number" step="1" value={values.indicativeFee} onChange={(event) => update("indicativeFee", event.target.value)} /><small>Le tarif sera vérifié par NEXA avant publication.</small></label> : null}
      {values.providerType === "nurse" ? <fieldset className="form-checklist"><legend>Qualifications infirmières déclarées <span aria-hidden="true">*</span></legend><p>Sélectionnez les qualifications que NEXA devra vérifier avant l’approbation.</p>{NURSING_QUALIFICATIONS.map((qualification) => <label className="checkbox-row" key={qualification.id}><input checked={selectedNursingQualifications.includes(qualification.id)} onChange={(event) => setSelectedNursingQualifications((current) => event.target.checked ? [...current, qualification.id] : current.filter((id) => id !== qualification.id))} type="checkbox" /><span>{qualification.label}</span></label>)}</fieldset> : null}
      {values.providerType === "nurse" ? <p className="account-notice">Après approbation, NEXA activera une étape sécurisée pour compléter le profil de services infirmiers. Le profil ne sera ni publié ni réservable avant sa validation. Le rôle infirmier ne peut pas prescrire de médicaments.</p> : null}
      <div className="form-grid two-columns"><label>Téléphone public <span aria-hidden="true">*</span><input autoComplete="tel" maxLength={30} required type="tel" value={values.phone} onChange={(event) => update("phone", event.target.value)} /></label><label>Adresse e-mail de suivi <span aria-hidden="true">*</span><input autoComplete="email" required type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label></div>
      <div className="form-grid two-columns"><label>Département <span aria-hidden="true">*</span><input maxLength={80} required value={values.department} onChange={(event) => update("department", event.target.value)} /></label><label>Commune <span aria-hidden="true">*</span><input maxLength={80} required value={values.commune} onChange={(event) => update("commune", event.target.value)} /></label></div>
      <label>Présentation publique (facultatif)<textarea maxLength={300} rows={3} value={values.publicBio} onChange={(event) => update("publicBio", event.target.value)} /></label>
      {!user ? <label>Mot de passe du compte de suivi <span aria-hidden="true">*</span><input autoComplete="new-password" minLength={6} required type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label> : <p className="account-notice">Connecté avec : <strong>{user.email}</strong>{patientNumber ? <> · Numéro patient NEXA : <strong>{patientNumber}</strong></> : null}</p>}
      <label className="checkbox-row"><input checked={accepted} onChange={(event) => setAccepted(event.target.checked)} type="checkbox" /><span>J’accepte les <Link href="/conditions" target="_blank">conditions</Link> et j’ai lu la <Link href="/confidentialite" target="_blank">politique de confidentialité</Link>.</span></label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {notice ? <p className="form-notice" role="status">{notice}</p> : null}
      <button className="button button-primary button-wide" disabled={busy} type="submit">{busy ? "Envoi…" : "Envoyer ma pré-demande"}</button>
      {!user ? <p className="auth-switch">Vous avez déjà un compte ? <Link href="/connexion">Connectez-vous</Link></p> : null}
      <p className="auth-switch">Aucun fichier n’est accepté dans ce formulaire.</p>
    </form>
  );
}
