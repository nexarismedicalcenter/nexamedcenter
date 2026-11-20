"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  GoogleAuthProvider,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
} from "firebase/auth";
import { FormEvent, useState } from "react";
import { getFirebaseAuth } from "@/lib/firebase/client";
import { initializePatientProfile, PatientApiError } from "@/lib/patients/client";

function displayError(error: unknown): string {
  if (error instanceof PatientApiError) return error.message;
  const code = (error as { code?: string })?.code;
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
    return "Adresse e-mail ou mot de passe incorrect.";
  }
  if (code === "auth/too-many-requests") return "Trop de tentatives. Réessayez plus tard.";
  if (code === "auth/popup-closed-by-user") return "La fenêtre Google a été fermée avant la fin de la connexion.";
  return "Connexion impossible pour le moment. Vérifiez votre connexion puis réessayez.";
}

export default function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function continueAsPatient(user: Parameters<typeof initializePatientProfile>[0]) {
    const next = new URLSearchParams(window.location.search).get("next");
    let providerDestination: string | null = null;
    if (next) {
      try {
        const destination = new URL(next, window.location.origin);
        if (destination.origin === window.location.origin && destination.pathname.startsWith("/professionnels/espace")) {
          providerDestination = `${destination.pathname}${destination.search}${destination.hash}`;
        }
      } catch { /* use the standard patient account flow */ }
    }
    const profile = await initializePatientProfile(user);
    if (providerDestination) {
      router.replace(providerDestination);
      return;
    }
    if (!profile.profileComplete) {
      router.replace(`/inscription?completer=1${next ? `&next=${encodeURIComponent(next)}` : ""}`);
      return;
    }
    if (next) {
      try {
        const destination = new URL(next, window.location.origin);
        if (destination.origin === window.location.origin) {
          router.replace(`${destination.pathname}${destination.search}${destination.hash}`);
          return;
        }
      } catch { /* use the normal patient landing page */ }
    }
    router.replace("/espace");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const credential = await signInWithEmailAndPassword(
        getFirebaseAuth(),
        email.trim(),
        password,
      );
      await continueAsPatient(credential.user);
    } catch (loginError) {
      setError(displayError(loginError));
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogleLogin() {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const credential = await signInWithPopup(
        getFirebaseAuth(),
        new GoogleAuthProvider(),
      );
      await continueAsPatient(credential.user);
    } catch (loginError) {
      setError(displayError(loginError));
    } finally {
      setBusy(false);
    }
  }

  async function handlePasswordReset() {
    setError("");
    setNotice("");
    if (!email.trim()) {
      setError("Saisissez votre adresse e-mail pour recevoir le lien de réinitialisation.");
      return;
    }
    setBusy(true);
    try {
      await sendPasswordResetEmail(getFirebaseAuth(), email.trim());
      setNotice("Si un compte correspond à cette adresse, un lien de réinitialisation a été envoyé.");
    } catch {
      setNotice("Si un compte correspond à cette adresse, un lien de réinitialisation a été envoyé.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-form-wrap">
      <form className="login-form" onSubmit={handleSubmit}>
        <label>
          Adresse e-mail
          <input autoComplete="email" required type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label>
          Mot de passe
          <input autoComplete="current-password" required type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <button className="button button-primary button-wide" disabled={busy} type="submit">
          {busy ? "Connexion…" : "Se connecter"}
        </button>
        <button className="text-button" disabled={busy} onClick={handlePasswordReset} type="button">Mot de passe oublié ?</button>
      </form>
      <div className="form-divider"><span>ou</span></div>
      <button className="button button-google button-wide" disabled={busy} onClick={handleGoogleLogin} type="button">Continuer avec Google</button>
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="form-notice" role="status">{notice}</p>}
      <p className="auth-switch">Pas encore de compte ? <Link href="/inscription">Créer un compte patient</Link></p>
    </div>
  );
}
