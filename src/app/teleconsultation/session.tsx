"use client";

import Link from "next/link";
import { getToken } from "firebase/app-check";
import { onAuthStateChanged, type User } from "firebase/auth";
import { useRouter, useSearchParams } from "next/navigation";
import type { IAgoraRTCClient, IAgoraRTCRemoteUser, ILocalTrack } from "agora-rtc-sdk-ng";
import { useCallback, useEffect, useRef, useState } from "react";
import { appointmentRequest } from "@/lib/appointments/client";
import { getFirebaseAppCheck, getFirebaseAuth } from "@/lib/firebase/client";
import ClinicalRecordPanel from "./clinical-record-panel";
import SessionMessages from "./session-messages";
import PrescriptionPanel from "./prescription-panel";
import FollowUpProposal from "./follow-up-proposal";

type AgoraSession = {
  appId: string;
  token: string;
  channelName: string;
  uid: number;
  expiresAt: number;
  videoRemainingSeconds: number;
  videoStatus: string;
};

type PresenceSnapshot = {
  ok?: boolean;
  expired?: boolean;
  videoRemainingSeconds?: number;
  error?: string;
};

type VideoSignal = { id: string; status: "RINGING" | "CONNECTING" | "ACTIVE" | "REFUSED" | "MISSED" | "ENDED"; by: "self" | "peer"; updatedAt: string };
type CallAttempt = { initiatedBy: "patient" | "doctor"; attemptNumber: number; status: string; startedAt: string; resolvedAt?: string };
type NoShowOutcome = "PROVIDER_UNRESPONSIVE" | "PATIENT_UNRESPONSIVE" | null;

async function fetchAgoraToken(
  user: User,
  appointmentId: string,
  presenceAction: "join" | "heartbeat",
): Promise<AgoraSession> {
  const headers = new Headers({ Authorization: `Bearer ${await user.getIdToken()}`, "Content-Type": "application/json" });
  const appCheck = getFirebaseAppCheck();
  if (process.env.NODE_ENV === "production" && !appCheck) throw new Error("La protection App Check de NEXA n’est pas configurée.");
  if (appCheck) headers.set("X-Firebase-AppCheck", (await getToken(appCheck)).token);
  const response = await fetch("/api/teleconsultation/token", {
    method: "POST", headers, body: JSON.stringify({ appointmentId, presenceAction }), cache: "no-store",
  });
  const payload = await response.json() as AgoraSession & { ok?: boolean; error?: string };
  if (!response.ok || payload.ok !== true || !payload.appId || !payload.token || !payload.channelName || !Number.isInteger(payload.uid)) {
    throw new Error(payload.error || "La séance vidéo n’est pas encore accessible.");
  }
  return payload;
}

async function updatePresence(
  user: User,
  appointmentId: string,
  action: "heartbeat" | "leave",
  keepalive = false,
): Promise<PresenceSnapshot> {
  const headers = new Headers({ Authorization: `Bearer ${await user.getIdToken()}`, "Content-Type": "application/json" });
  const appCheck = getFirebaseAppCheck();
  if (process.env.NODE_ENV === "production" && !appCheck) throw new Error("La protection App Check de NEXA n’est pas configurée.");
  if (appCheck) headers.set("X-Firebase-AppCheck", (await getToken(appCheck)).token);
  const response = await fetch("/api/teleconsultation/presence", {
    method: "POST", headers, body: JSON.stringify({ appointmentId, action }), cache: "no-store", keepalive,
  });
  const payload = await response.json().catch(() => null) as PresenceSnapshot | null;
  if (payload?.expired) return payload;
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error || "Le suivi de la séance est momentanément indisponible.");
  }
  return payload;
}

export default function TeleconsultationSession() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const appointmentId = searchParams.get("appointmentId") || "";
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [error, setError] = useState("");
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const [videoSignal, setVideoSignal] = useState<VideoSignal | null>(null);
  const [callAttempts, setCallAttempts] = useState<CallAttempt[]>([]);
  const [noShowOutcome, setNoShowOutcome] = useState<NoShowOutcome>(null);
  const [signalBusy, setSignalBusy] = useState(false);
  const [canProposeFollowUp, setCanProposeFollowUp] = useState(false);
  const clientRef = useRef<IAgoraRTCClient | null>(null);
  const localTracksRef = useRef<ILocalTrack[]>([]);
  const localVideoRef = useRef<HTMLDivElement | null>(null);
  const remoteVideoRef = useRef<HTMLDivElement | null>(null);
  const presenceActiveRef = useRef(false);
  const heartbeatBusyRef = useRef(false);
  const heartbeatFailuresRef = useRef(0);
  const joinBusyRef = useRef(false);

  const sendVideoSignal = useCallback(async (action: "invite" | "accept" | "refuse" | "connected" | "end" | "timeout") => {
    if (!user || !appointmentId) throw new Error("Connectez-vous pour utiliser l’appel vidéo.");
    const result = await appointmentRequest<{ videoSignal: VideoSignal | null; callAttempts?: CallAttempt[]; noShowOutcome?: NoShowOutcome }>(
      user,
      `/api/appointments/${encodeURIComponent(appointmentId)}/video-signal`,
      "POST",
      { action },
    );
    setVideoSignal(result.videoSignal);
    setCallAttempts(Array.isArray(result.callAttempts) ? result.callAttempts : []);
    setNoShowOutcome(result.noShowOutcome || null);
    return result.videoSignal;
  }, [appointmentId, user]);

  useEffect(() => onAuthStateChanged(getFirebaseAuth(), (currentUser) => {
    setUser(currentUser);
    setAuthReady(true);
    if (!currentUser && appointmentId) router.replace(`/connexion?next=${encodeURIComponent(`/teleconsultation?appointmentId=${appointmentId}`)}`);
  }), [appointmentId, router]);

  useEffect(() => {
    if (!user || !appointmentId) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const result = await appointmentRequest<{ videoSignal: VideoSignal | null; canProposeFollowUp: boolean; callAttempts?: CallAttempt[]; noShowOutcome?: NoShowOutcome }>(
          user,
          `/api/appointments/${encodeURIComponent(appointmentId)}/video-signal`,
        );
        if (disposed) return;
        const candidate = result.videoSignal;
        const isExpiredInvite = candidate?.status === "RINGING" && Date.now() - Date.parse(candidate.updatedAt) > 90_000;
        if (isExpiredInvite) {
          await sendVideoSignal("timeout");
          if (disposed) return;
          setCanProposeFollowUp(result.canProposeFollowUp === true);
          return;
        }
        setVideoSignal(candidate);
        setCallAttempts(Array.isArray(result.callAttempts) ? result.callAttempts : []);
        setNoShowOutcome(result.noShowOutcome || null);
        setCanProposeFollowUp(result.canProposeFollowUp === true);
      } catch { /* Video signaling is optional while the participant loads the session. */ }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [appointmentId, sendVideoSignal, user]);

  const leaveCall = useCallback(async (message?: string) => {
    if (presenceActiveRef.current && user && appointmentId) {
      presenceActiveRef.current = false;
      await updatePresence(user, appointmentId, "leave").catch(() => undefined);
    }
    const tracks = localTracksRef.current;
    localTracksRef.current = [];
    tracks.forEach((track) => {
      try { track.stop(); track.close(); } catch { /* tracks may already be closed */ }
    });
    const client = clientRef.current;
    clientRef.current = null;
    if (client) await client.leave().catch(() => undefined);
    setJoined(false);
    setMuted(false);
    setCameraOff(false);
    if (localVideoRef.current) {
      localVideoRef.current.replaceChildren();
      const placeholder = document.createElement("span");
      placeholder.textContent = "Votre caméra apparaîtra ici après autorisation.";
      localVideoRef.current.append(placeholder);
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.replaceChildren();
      const placeholder = document.createElement("span");
      placeholder.textContent = "En attente de l’autre participant…";
      remoteVideoRef.current.append(placeholder);
    }
    if (message) setError(message);
  }, [appointmentId, user]);

  useEffect(() => () => {
    localTracksRef.current.forEach((track) => { try { track.stop(); track.close(); } catch { /* cleanup */ } });
    void clientRef.current?.leave().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!joined || !user || !appointmentId) return;
    let disposed = false;
    const leavePresence = () => {
      if (!presenceActiveRef.current) return;
      presenceActiveRef.current = false;
      void updatePresence(user, appointmentId, "leave", true).catch(() => undefined);
    };
    const heartbeat = window.setInterval(async () => {
      if (disposed || heartbeatBusyRef.current || !presenceActiveRef.current) return;
      heartbeatBusyRef.current = true;
      try {
        const presence = await updatePresence(user, appointmentId, "heartbeat");
        heartbeatFailuresRef.current = 0;
        if (typeof presence.videoRemainingSeconds === "number") setRemainingSeconds(presence.videoRemainingSeconds);
        await sendVideoSignal("connected").catch(() => undefined);
        if (presence.expired || presence.videoRemainingSeconds === 0) {
          await leaveCall("La durée vidéo incluse dans cette consultation est terminée.");
        }
      } catch {
        heartbeatFailuresRef.current += 1;
        if (heartbeatFailuresRef.current >= 3) {
          await leaveCall("Le suivi sécurisé de la séance est indisponible. Rejoignez-la de nouveau dans un instant.");
        }
      } finally {
        heartbeatBusyRef.current = false;
      }
    }, 10_000);
    window.addEventListener("pagehide", leavePresence);
    return () => {
      disposed = true;
      window.clearInterval(heartbeat);
      window.removeEventListener("pagehide", leavePresence);
      leavePresence();
    };
  }, [appointmentId, joined, leaveCall, sendVideoSignal, user]);

  async function joinCall(acceptPendingInvite = true) {
    if (!user || joinBusyRef.current) return;
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(appointmentId)) { setError("Le lien de la séance est incomplet."); return; }
    joinBusyRef.current = true;
    setJoining(true); setError("");
    let client: IAgoraRTCClient | null = null;
    try {
      if (acceptPendingInvite && videoSignal?.status === "RINGING" && videoSignal.by === "peer") await sendVideoSignal("accept");
      presenceActiveRef.current = true;
      const session = await fetchAgoraToken(user, appointmentId, "join");
      setRemainingSeconds(session.videoRemainingSeconds);
      const agoraModule = await import("agora-rtc-sdk-ng");
      const AgoraRTC = agoraModule.default;
      client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
      clientRef.current = client;

      client.on("user-published", async (remoteUser: IAgoraRTCRemoteUser, mediaType) => {
        await client?.subscribe(remoteUser, mediaType);
        if (mediaType === "video" && remoteVideoRef.current && remoteUser.videoTrack) {
          remoteVideoRef.current.replaceChildren();
          remoteUser.videoTrack.play(remoteVideoRef.current);
        }
        if (mediaType === "audio") remoteUser.audioTrack?.play();
      });
      client.on("user-unpublished", (_remoteUser, mediaType) => {
        if (mediaType === "video" && remoteVideoRef.current) remoteVideoRef.current.replaceChildren();
      });
      client.on("user-left", () => { if (remoteVideoRef.current) remoteVideoRef.current.replaceChildren(); });
      client.on("token-privilege-will-expire", async () => {
        try {
          const renewed = await fetchAgoraToken(user, appointmentId, "heartbeat");
          await client?.renewToken(renewed.token);
          setRemainingSeconds(renewed.videoRemainingSeconds);
        } catch {
          await leaveCall("La séance est terminée ou votre accès vidéo a expiré.");
        }
      });

      await client.join(session.appId, session.channelName, session.token, session.uid);
      const tracks = await AgoraRTC.createMicrophoneAndCameraTracks(
        { encoderConfig: "speech_standard" },
        { encoderConfig: "480p_1" },
      );
      localTracksRef.current = tracks;
      if (localVideoRef.current) {
        localVideoRef.current.replaceChildren();
        tracks[1].play(localVideoRef.current);
      }
      await client.publish(tracks);
      setJoined(true);
      // Report a connection only after this browser has joined and published its tracks.
      // The server starts the clinical window when both participants report this state.
      await sendVideoSignal("connected").catch(() => undefined);
    } catch (cause) {
      if (client || presenceActiveRef.current) await leaveCall();
      setError(cause instanceof Error ? cause.message : "Impossible d’ouvrir la séance vidéo.");
    } finally { setJoining(false); joinBusyRef.current = false; }
  }

  async function inviteToVideoCall() {
    if (!user || signalBusy) return;
    setSignalBusy(true); setError("");
    try {
      await sendVideoSignal("invite");
      if (!joined) await joinCall();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "L’invitation vidéo n’a pas pu être envoyée.");
    } finally { setSignalBusy(false); }
  }

  async function respondToVideoInvite(action: "accept" | "refuse") {
    if (signalBusy) return;
    setSignalBusy(true); setError("");
    try {
      await sendVideoSignal(action);
      if (action === "accept") await joinCall(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "La réponse à l’invitation n’a pas abouti.");
    } finally { setSignalBusy(false); }
  }

  async function endVideoCall() {
    if (signalBusy) return;
    setSignalBusy(true);
    try { await sendVideoSignal("end"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "L’appel n’a pas pu être terminé côté serveur."); }
    finally { setSignalBusy(false); await leaveCall("Vous avez quitté l’appel vidéo."); }
  }

  async function toggleMicrophone() {
    const track = localTracksRef.current[0];
    if (!track) return;
    const next = !muted;
    await track.setEnabled(!next);
    setMuted(next);
  }

  async function toggleCamera() {
    const track = localTracksRef.current[1];
    if (!track) return;
    const next = !cameraOff;
    await track.setEnabled(!next);
    setCameraOff(next);
  }

  const minutesRemaining = remainingSeconds === null ? null : Math.max(0, Math.floor(remainingSeconds / 60));

  return (
    <main className="telehealth-page">
      <header className="directory-header"><Link className="brand brand-compact" href="/" aria-label="NEXA Medical Center, accueil"><span className="brand-mark" aria-hidden="true">N</span><span>NEXA <small>MEDICAL CENTER</small></span></Link><Link className="button button-outline" href="/espace">Mon espace patient</Link></header>
      <section className="telehealth-shell">
        <p className="eyebrow">Séance NEXA</p><h1>Téléconsultation sécurisée.</h1>
        <p className="appointment-intro">La vidéo n’est disponible que pour le patient et le médecin associés au rendez-vous, après le démarrage de la séance par le médecin.</p>
        {!appointmentId ? <div className="directory-state directory-error" role="alert"><p>Le lien ne contient pas de rendez-vous.</p><Link className="button button-outline" href="/espace">Retourner à mon espace</Link></div> : null}
        {appointmentId && authReady && !user ? <p role="status">Redirection vers la connexion…</p> : null}
        <div className="telehealth-video-grid"><section><h2>Votre caméra</h2><div className="telehealth-video" ref={localVideoRef}><span>Votre caméra apparaîtra ici après autorisation.</span></div></section><section><h2>Autre participant</h2><div className="telehealth-video" ref={remoteVideoRef}><span>En attente de l’autre participant…</span></div></section></div>
        {minutesRemaining !== null ? <p className="appointment-privacy">Durée vidéo restante estimée : {minutesRemaining} min. L’accès vidéo expire à la fin de la fenêtre de séance autorisée.</p> : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {videoSignal?.status === "RINGING" && videoSignal.by === "peer" && !joined ? <section className="video-invite" aria-labelledby="video-invite-title" aria-live="assertive" role="region"><div><h2 id="video-invite-title">Invitation à un appel vidéo</h2><p>Un participant à votre séance vous invite à rejoindre l’appel.</p></div><div className="video-invite-actions"><button className="button button-primary" disabled={signalBusy || joining} onClick={() => void respondToVideoInvite("accept")} type="button">{signalBusy || joining ? "Connexion…" : "Accepter et rejoindre"}</button><button className="button button-outline" disabled={signalBusy} onClick={() => void respondToVideoInvite("refuse")} type="button">Refuser</button></div></section> : null}
        {videoSignal?.status === "RINGING" && videoSignal.by === "self" ? <p className="appointment-privacy" role="status">Invitation envoyée. Si aucune réponse n’arrive après 90 secondes, l’appel sera enregistré comme sans réponse.</p> : null}
        {videoSignal?.status === "CONNECTING" ? <p className="appointment-privacy" role="status">Invitation acceptée. Vous pouvez rejoindre la salle vidéo.</p> : null}
        {videoSignal?.status === "ACTIVE" ? <p className="appointment-privacy" role="status">Les deux participants sont connectés à l’appel vidéo.</p> : null}
        {videoSignal?.status === "REFUSED" ? <p className="appointment-privacy" role="status">L’invitation vidéo a été refusée.</p> : null}
        {videoSignal?.status === "MISSED" ? <p className="appointment-privacy" role="status">L’invitation est restée sans réponse. Une nouvelle tentative est possible avant la clôture de la séance.</p> : null}
        {videoSignal?.status === "ENDED" ? <p className="appointment-privacy" role="status">L’appel vidéo est terminé.</p> : null}
        {noShowOutcome === "PROVIDER_UNRESPONSIVE" ? <p className="directory-state" role="status">Après deux appels initiés par le patient et restés sans réponse du médecin, le montant du service est remboursé dans le portefeuille NEXA. Les frais de transaction ne sont pas remboursés.</p> : null}
        {noShowOutcome === "PATIENT_UNRESPONSIVE" ? <p className="directory-state" role="status">Après deux appels initiés par le médecin et restés sans réponse du patient, le montant du service est conservé par NEXA. Aucun versement n’est dû au médecin.</p> : null}
        {callAttempts.length ? <section className="appointment-privacy" aria-labelledby="call-attempts-title"><h2 id="call-attempts-title">Historique des appels</h2><ul>{callAttempts.map((attempt, index) => <li key={`${attempt.startedAt}-${index}`}>{attempt.initiatedBy === "patient" ? "Patient" : "Médecin"} — appel {attempt.attemptNumber} — {attempt.status === "NO_ANSWER" ? "sans réponse" : attempt.status === "REFUSED" ? "refusé" : attempt.status === "CONNECTED" ? "connecté" : attempt.status === "ENDED" ? "terminé" : attempt.status === "ACCEPTED" ? "accepté" : "en attente"} — {new Date(attempt.startedAt).toLocaleString("fr-HT")}</li>)}</ul></section> : null}
        <div className="telehealth-actions">{!joined ? <><button className="button button-primary" disabled={!user || !appointmentId || joining || signalBusy || Boolean(noShowOutcome)} onClick={() => void inviteToVideoCall()} type="button">{signalBusy ? "Envoi de l’invitation…" : joining ? "Connexion…" : "Inviter l’autre participant"}</button><button className="button button-outline" disabled={!user || !appointmentId || joining || signalBusy || Boolean(noShowOutcome)} onClick={() => void joinCall()} type="button">Rejoindre directement</button></> : <><button className="button button-outline" onClick={() => void toggleMicrophone()} type="button">{muted ? "Activer le micro" : "Couper le micro"}</button><button className="button button-outline" onClick={() => void toggleCamera()} type="button">{cameraOff ? "Activer la caméra" : "Couper la caméra"}</button>{["MISSED", "REFUSED", "ENDED"].includes(videoSignal?.status || "") && !noShowOutcome ? <button className="button button-outline" disabled={signalBusy} onClick={() => void inviteToVideoCall()} type="button">Relancer l’appel</button> : null}<button className="button button-primary" disabled={signalBusy} onClick={() => void endVideoCall()} type="button">Quitter l’appel vidéo</button></>}</div>
        {user && appointmentId ? <SessionMessages user={user} appointmentId={appointmentId} /> : null}
        {user && appointmentId ? <ClinicalRecordPanel user={user} appointmentId={appointmentId} /> : null}
        {user && appointmentId ? <PrescriptionPanel user={user} appointmentId={appointmentId} /> : null}
        {user && appointmentId && canProposeFollowUp ? <FollowUpProposal user={user} appointmentId={appointmentId} /> : null}
        <p className="appointment-emergency">N’utilisez pas la vidéo NEXA pour les urgences médicales. En cas d’urgence, contactez les services d’urgence locaux.</p>
      </section>
      <footer className="directory-footer"><Link href="/conditions">Conditions</Link><Link href="/confidentialite">Confidentialité</Link><span>© 2026 NEXA Medical Center</span></footer>
    </main>
  );
}
