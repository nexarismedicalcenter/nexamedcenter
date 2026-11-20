"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  sendEmailVerification,
  signInWithPopup,
  updateProfile,
  type User,
} from "firebase/auth";
import { FormEvent, useEffect, useState } from "react";
import { getFirebaseAuth } from "@/lib/firebase/client";
import {
  initializePatientProfile,
  PatientApiError,
  type PatientRegistrationInput,
} from "@/lib/patients/client";

const initialValues: PatientRegistrationInput = {
  firstName: "",
  lastName: "",
  birthDate: "",
  phone: "",
  sex: "Non communiqué",
  addressLine: "",
  country: "Haïti",
  department: "",
  commune: "",
  emailMarketingConsent: false,
  termsAccepted: false,
};

function authMessage(error: unknown): string {
  if (error instanceof PatientApiError) {
    return error.message;
  }

  const code = (error as { code?: string })?.code;
  if (code === "auth/email-already-in-use") return "Cette adresse e-mail possède déjà un compte. Connectez-vous pour continuer.";
  if (code === "auth/invalid-email") return "L’adresse e-mail n’est pas valide.";
  if (code === "auth/weak-password") return "Choisissez un mot de passe d’au moins 6 caractères.";
  if (code === "auth/popup-closed-by-user") return "La fenêtre Google a été fermée avant la fin de la connexion.";
  return "L’inscription n’a pas abouti. Vérifiez votre connexion puis réessayez.";
}

function validateRegistration(
  values: PatientRegistrationInput,
  email: string,
  password: string,
  confirmPassword: string,
  needsCredentials: boolean,
): string | null {
  if (!values.firstName.trim() || !values.lastName.trim()) {
    return "Saisissez votre prénom et votre nom avant de créer le compte.";
  }
  if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return "Saisissez une adresse e-mail valide.";
  }
  if (needsCredentials && password.length < 6) {
    return "Choisissez un mot de passe d’au moins 6 caractères.";
  }
  if (needsCredentials && password !== confirmPassword) {
    return "Les mots de passe ne correspondent pas.";
  }
  if (!values.birthDate) return "Saisissez votre date de naissance.";
  const birthDate = new Date(`${values.birthDate}T00:00:00.000Z`);
  if (
    Number.isNaN(birthDate.getTime()) ||
    birthDate.toISOString().slice(0, 10) !== values.birthDate ||
    birthDate.getTime() > Date.now()
  ) {
    return "La date de naissance n’est pas valide.";
  }
  if (!/^\+?[0-9\s().-]{7,24}$/.test(values.phone.trim())) {
    return "Saisissez un numéro de téléphone valide.";
  }
  if (
    !values.addressLine.trim() ||
    !values.country.trim() ||
    !values.department.trim() ||
    !values.commune.trim()
  ) {
    return "Complétez votre adresse, votre pays, votre département et votre commune.";
  }
  if (!values.termsAccepted) {
    return "Vous devez accepter les conditions et lire la politique de confidentialité.";
  }
  return null;
}

export default function PatientRegistrationForm() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [values, setValues] = useState(initialValues);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [patientNumber, setPatientNumber] = useState("");
  const [today, setToday] = useState("");

  function continueAfterRegistration() {
    const next = new URLSearchParams(window.location.search).get("next") || "/espace";
    try {
      const destination = new URL(next, window.location.origin);
      router.push(destination.origin === window.location.origin ? `${destination.pathname}${destination.search}${destination.hash}` : "/espace");
    } catch { router.push("/espace"); }
  }

  useEffect(() => {
    const dateTimer = window.setTimeout(() => {
      const now = new Date();
      const localDate = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
      setToday(localDate);
    }, 0);
    const auth = getFirebaseAuth();
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (currentUser?.email) setEmail(currentUser.email);
      if (currentUser && new URLSearchParams(window.location.search).get("completer") === "1") {
        void initializePatientProfile(currentUser)
          .then((result) => {
            if (result.profileComplete) {
              setPatientNumber(result.patientNumber);
              setNotice("Votre profil patient est déjà complet.");
            } else {
              setNotice(`Votre numéro patient ${result.patientNumber} est attribué. Complétez les informations ci-dessous pour finaliser votre profil.`);
            }
          })
          .catch((profileError: unknown) => setError(authMessage(profileError)));
      }
    });
    return () => {
      window.clearTimeout(dateTimer);
      unsubscribe();
    };
  }, []);

  function updateValue<K extends keyof PatientRegistrationInput>(
    key: K,
    value: PatientRegistrationInput[K],
  ) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function finishRegistration(currentUser: User) {
    const result = await initializePatientProfile(currentUser, values);
    setPatientNumber(result.patientNumber);
    setNotice(
      result.created
        ? "Votre compte et votre numéro patient NEXA sont prêts."
        : "Votre profil patient est à jour.",
    );
    setError("");
    if (!currentUser.emailVerified) {
      try {
        await sendEmailVerification(currentUser);
      } catch {
        setNotice("Votre compte est créé. La vérification de l’adresse e-mail pourra être renvoyée depuis votre espace.");
      }
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    const currentUser = getFirebaseAuth().currentUser;
    if (
      currentUser?.email &&
      email.trim().toLowerCase() !== currentUser.email.toLowerCase()
    ) {
      setError("L’adresse du profil doit correspondre au compte connecté.");
      return;
    }
    const validationError = validateRegistration(
      values,
      currentUser?.email || email,
      password,
      confirmPassword,
      !currentUser,
    );
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);

    try {
      let registeringUser = getFirebaseAuth().currentUser;
      if (!registeringUser) {
        const credential = await createUserWithEmailAndPassword(
          getFirebaseAuth(),
          email.trim(),
          password,
        );
        registeringUser = credential.user;
        setUser(registeringUser);
        const initialized = await initializePatientProfile(registeringUser);
        if (!initialized.profileComplete) {
          setNotice(`Votre numéro patient ${initialized.patientNumber} est attribué. Finalisation de votre profil…`);
        }
      }

      if (!registeringUser) throw new Error("La session de création de compte a expiré.");
      await finishRegistration(registeringUser);
      if (registeringUser.displayName !== `${values.firstName} ${values.lastName}`.trim()) {
        await updateProfile(registeringUser, {
          displayName: `${values.firstName} ${values.lastName}`.trim(),
        }).catch(() => undefined);
      }
    } catch (submitError) {
      setError(
        submitError instanceof Error && !("code" in submitError)
          ? submitError.message
          : authMessage(submitError),
      );
      if (getFirebaseAuth().currentUser) setUser(getFirebaseAuth().currentUser);
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogleSignup() {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const credential = await signInWithPopup(
        getFirebaseAuth(),
        new GoogleAuthProvider(),
      );
      setUser(credential.user);
      if (credential.user.email) setEmail(credential.user.email);
      const result = await initializePatientProfile(credential.user);
      if (result.profileComplete) {
        const existing = result;
        setPatientNumber(existing.patientNumber);
        setNotice("Votre compte patient NEXA est prêt.");
      } else {
        setNotice(`Votre numéro patient ${result.patientNumber} vous a été attribué. Complétez les informations ci-dessous pour finaliser votre profil.`);
      }
    } catch (googleError) {
      setError(authMessage(googleError));
    } finally {
      setBusy(false);
    }
  }

  if (patientNumber) {
    return (
      <section className="success-panel" aria-live="polite">
        <span className="success-mark" aria-hidden="true">✓</span>
        <p className="eyebrow">Compte patient créé</p>
        <h2>Bienvenue chez NEXA.</h2>
        <p>Conservez votre numéro patient. Il vous sera demandé pour retrouver votre dossier.</p>
        <p className="patient-number" aria-label={`Votre numéro patient est ${patientNumber}`}>
          {patientNumber}
        </p>
        <p className="muted">Ce numéro identifie votre dossier; il ne remplace pas votre mot de passe.</p>
        <button className="button button-primary" onClick={continueAfterRegistration} type="button">Continuer</button>
      </section>
    );
  }

  return (
    <form className="auth-form" onSubmit={handleSubmit} noValidate>
      {user ? (
        <div className="account-notice">
          Compte connecté : <strong>{user.email || user.displayName || "Compte Google"}</strong>.
          <br />Finalisez les renseignements du profil patient.
        </div>
      ) : (
        <>
          <div className="form-grid two-columns">
            <label>
              Nom <span aria-hidden="true">*</span>
              <input autoComplete="family-name" maxLength={80} required value={values.lastName} onChange={(event) => updateValue("lastName", event.target.value)} />
            </label>
            <label>
              Prénom <span aria-hidden="true">*</span>
              <input autoComplete="given-name" maxLength={80} required value={values.firstName} onChange={(event) => updateValue("firstName", event.target.value)} />
            </label>
          </div>
          <label>
            Adresse e-mail <span aria-hidden="true">*</span>
            <input autoComplete="email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <div className="form-grid two-columns">
            <label>
              Mot de passe <span aria-hidden="true">*</span>
              <input autoComplete="new-password" minLength={6} required type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            <label>
              Confirmer le mot de passe <span aria-hidden="true">*</span>
              <input autoComplete="new-password" minLength={6} required type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
            </label>
          </div>
        </>
      )}

      <div className="form-grid two-columns">
        <label>
          Date de naissance <span aria-hidden="true">*</span>
          <input autoComplete="bday" max={today || undefined} required type="date" value={values.birthDate} onChange={(event) => updateValue("birthDate", event.target.value)} />
        </label>
        <label>
          Téléphone <span aria-hidden="true">*</span>
          <input autoComplete="tel" maxLength={24} required type="tel" value={values.phone} onChange={(event) => updateValue("phone", event.target.value)} />
        </label>
      </div>
      <label>
        Sexe (facultatif)
        <select value={values.sex} onChange={(event) => updateValue("sex", event.target.value)}>
          <option>Non communiqué</option>
          <option>Femme</option>
          <option>Homme</option>
          <option>Autre</option>
        </select>
      </label>
      <label>
        Adresse <span aria-hidden="true">*</span>
        <input autoComplete="street-address" maxLength={180} required value={values.addressLine} onChange={(event) => updateValue("addressLine", event.target.value)} />
      </label>
      <div className="form-grid three-columns">
        <label>
          Pays <span aria-hidden="true">*</span>
          <input autoComplete="country-name" maxLength={80} required value={values.country} onChange={(event) => updateValue("country", event.target.value)} />
        </label>
        <label>
          Département <span aria-hidden="true">*</span>
          <input maxLength={100} required value={values.department} onChange={(event) => updateValue("department", event.target.value)} />
        </label>
        <label>
          Commune <span aria-hidden="true">*</span>
          <input maxLength={100} required value={values.commune} onChange={(event) => updateValue("commune", event.target.value)} />
        </label>
      </div>

      <label className="checkbox-row">
        <input type="checkbox" checked={values.emailMarketingConsent} onChange={(event) => updateValue("emailMarketingConsent", event.target.checked)} />
        <span>Je souhaite recevoir les nouvelles et informations de NEXA. Je pourrai me désinscrire à tout moment.</span>
      </label>
      <label className="checkbox-row">
        <input checked={values.termsAccepted} onChange={(event) => updateValue("termsAccepted", event.target.checked)} type="checkbox" />
        <span>J’accepte les <Link href="/conditions" target="_blank">conditions d’utilisation</Link> et j’ai lu la <Link href="/confidentialite" target="_blank">politique de confidentialité</Link>.</span>
      </label>

      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="form-notice" role="status">{notice}</p>}
      <button className="button button-primary button-wide" disabled={busy} type="submit">
        {busy ? "Création du profil…" : user ? "Finaliser et obtenir mon numéro patient" : "Créer mon compte patient"}
      </button>
      {!user && (
        <>
          <div className="form-divider"><span>ou</span></div>
          <button className="button button-google button-wide" disabled={busy} onClick={handleGoogleSignup} type="button">
            Continuer avec Google
          </button>
        </>
      )}
      <p className="auth-switch">Vous avez déjà un compte ? <Link href="/connexion">Se connecter</Link></p>
    </form>
  );
}
