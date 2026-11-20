"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import type { User } from "firebase/auth";
import { appointmentRequest } from "@/lib/appointments/client";

type SessionMessage = {
  id: string;
  senderUid: string;
  kind: "text" | "photo" | "voice";
  text: string;
  fileName?: string;
  durationSeconds?: number;
  createdAt: string | null;
};
type MediaLimits = {
  maxPhotos: number | null;
  maxVoiceMessages: number | null;
  maxVoiceSeconds: number;
  photosUsed: number;
  voiceMessagesUsed: number;
};

export default function SessionMessages({ user, appointmentId }: { user: User; appointmentId: string }) {
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [text, setText] = useState("");
  const [canSend, setCanSend] = useState(false);
  const [mediaLimits, setMediaLimits] = useState<MediaLimits | null>(null);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [mediaError, setMediaError] = useState("");
  const listRef = useRef<HTMLUListElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const voiceTimerRef = useRef<number | null>(null);
  const voiceStartedAtRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const result = await appointmentRequest<{ messages: SessionMessage[]; canSend: boolean; mediaLimits: MediaLimits }>(user, `/api/appointments/${encodeURIComponent(appointmentId)}/messages`);
      setMessages(result.messages || []);
      setCanSend(result.canSend === true);
      setMediaLimits(result.mediaLimits || null);
      setError("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "La messagerie est indisponible."); }
    finally { setLoading(false); }
  }, [appointmentId, user]);

  useEffect(() => {
    const initial = window.setTimeout(() => { void load(); }, 0);
    const polling = window.setInterval(() => { void load(); }, 10_000);
    return () => { window.clearTimeout(initial); window.clearInterval(polling); };
  }, [load]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages]);

  useEffect(() => () => {
    if (voiceTimerRef.current !== null) window.clearTimeout(voiceTimerRef.current);
    if (recorderRef.current) {
      recorderRef.current.onstop = null;
      if (recorderRef.current.state !== "inactive") recorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = text.trim();
    if (!message || !canSend || sending) return;
    setSending(true); setError("");
    try {
      await appointmentRequest(user, `/api/appointments/${encodeURIComponent(appointmentId)}/messages`, "POST", { text: message });
      setText("");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Le message n’a pas pu être envoyé."); }
    finally { setSending(false); }
  }

  async function sendMedia(file: File, kind: "photo" | "voice", durationSeconds = 0) {
    if (!canSend || mediaBusy) return;
    if (file.size < 1 || file.size > 15 * 1024 * 1024) {
      setMediaError("Le média doit peser au maximum 15 Mio.");
      return;
    }
    setMediaBusy(true); setMediaError("");
    let uploadId = "";
    const mediaBase = `/api/appointments/${encodeURIComponent(appointmentId)}/messages/media`;
    try {
      const contentType = file.type.split(";", 1)[0].trim().toLowerCase();
      const ticket = await appointmentRequest<{ uploadId: string; uploadUrl: string; fields: Record<string, string>; fileName: string }>(user, mediaBase, "POST", {
        kind, contentType, size: file.size, fileName: file.name, ...(kind === "voice" ? { durationSeconds } : {}),
      });
      uploadId = ticket.uploadId;
      const formData = new FormData();
      Object.entries(ticket.fields).forEach(([key, value]) => formData.append(key, value));
      formData.append("file", file, ticket.fileName);
      const response = await fetch(ticket.uploadUrl, { method: "POST", body: formData, cache: "no-store", credentials: "omit" });
      if (!response.ok) throw new Error("Le téléversement sécurisé a échoué. Réessayez.");
      await appointmentRequest(user, `${mediaBase}/${encodeURIComponent(uploadId)}`, "POST", {});
      await load();
    } catch (cause) {
      if (uploadId) await appointmentRequest(user, `${mediaBase}/${encodeURIComponent(uploadId)}`, "DELETE").catch(() => undefined);
      setMediaError(cause instanceof Error ? cause.message : "Le média n’a pas pu être envoyé.");
    } finally { setMediaBusy(false); }
  }

  async function choosePhoto(file: File | undefined) {
    if (!file) return;
    await sendMedia(file, "photo");
  }

  async function toggleVoiceRecording() {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
      return;
    }
    if (!canSend || mediaBusy) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setMediaError("L’enregistrement vocal n’est pas pris en charge dans ce navigateur.");
      return;
    }
    setMediaError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const candidates = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
      const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      voiceStartedAtRef.current = Date.now();
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      recorder.onerror = () => setMediaError("L’enregistrement vocal a été interrompu.");
      recorder.onstop = () => {
        if (voiceTimerRef.current !== null) window.clearTimeout(voiceTimerRef.current);
        voiceTimerRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        setRecording(false);
        const contentType = (recorder.mimeType || "audio/webm").split(";", 1)[0].toLowerCase();
        const blob = new Blob(chunksRef.current, { type: contentType });
        const durationSeconds = Math.max(1, Math.min(mediaLimits?.maxVoiceSeconds || 60, Math.ceil((Date.now() - voiceStartedAtRef.current) / 1000)));
        if (blob.size > 0) void sendMedia(new File([blob], `message-vocal.${contentType.split("/")[1] || "audio"}`, { type: contentType }), "voice", durationSeconds);
      };
      recorder.start();
      setRecording(true);
      voiceTimerRef.current = window.setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, (mediaLimits?.maxVoiceSeconds || 60) * 1000);
    } catch (cause) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setMediaError(cause instanceof Error ? "Autorisez le microphone pour enregistrer un message vocal." : "Le microphone n’est pas accessible.");
    }
  }

  async function loadMedia(message: SessionMessage) {
    setMediaError("");
    try {
      const result = await appointmentRequest<{ url: string }>(user, `/api/appointments/${encodeURIComponent(appointmentId)}/messages/${encodeURIComponent(message.id)}/media`);
      setMediaUrls((current) => ({ ...current, [message.id]: result.url }));
    } catch (cause) { setMediaError(cause instanceof Error ? cause.message : "Le média n’a pas pu être ouvert."); }
  }

  const photosUsed = mediaLimits?.photosUsed || 0;
  const voiceUsed = mediaLimits?.voiceMessagesUsed || 0;
  const photoRemaining = mediaLimits?.maxPhotos === null ? Number.POSITIVE_INFINITY : Math.max(0, (mediaLimits?.maxPhotos || 0) - photosUsed);
  const voiceRemaining = mediaLimits?.maxVoiceMessages === null ? Number.POSITIVE_INFINITY : Math.max(0, (mediaLimits?.maxVoiceMessages || 0) - voiceUsed);
  const canSendPhoto = canSend && photoRemaining > 0 && !mediaBusy && !recording;
  const canSendVoice = canSend && voiceRemaining > 0 && !mediaBusy;

  return <section className="session-messages" aria-labelledby="session-messages-heading">
    <p className="eyebrow">Échange écrit</p><h2 id="session-messages-heading">Messages de la séance.</h2>
    <p className="appointment-privacy">Cette messagerie est liée à ce rendez-vous et accessible uniquement à ses deux participants. Les messages et médias sont supprimés après 30 jours. Les médias sont analysés avant leur ouverture.</p>
    {error ? <div className="form-error" role="alert">{error}<button className="button button-outline" disabled={loading} onClick={() => void load()} type="button">Réessayer</button></div> : null}
    <ul className="session-message-list" aria-live="polite" ref={listRef}>
      {loading ? <li className="session-message-empty" role="status">Chargement des messages…</li> : messages.length ? messages.map((message) => <li className={message.senderUid === user.uid ? "session-message is-mine" : "session-message"} key={message.id}>
        {message.kind === "text" ? <p>{message.text}</p> : message.kind === "photo" ? <div className="session-message-media">
          {mediaUrls[message.id] ? <Image alt={message.fileName || "Photo envoyée dans la séance"} height={480} src={mediaUrls[message.id]} unoptimized width={640} /> : <button className="button button-outline" type="button" onClick={() => void loadMedia(message)}>Afficher la photo</button>}
        </div> : <div className="session-message-media">
          {mediaUrls[message.id] ? <audio controls preload="none" src={mediaUrls[message.id]}>Votre navigateur ne peut pas lire ce message vocal.</audio> : <button className="button button-outline" type="button" onClick={() => void loadMedia(message)}>Charger le message vocal</button>}
          {message.durationSeconds ? <small>{message.durationSeconds} s</small> : null}
        </div>}
        <time dateTime={message.createdAt || undefined}>{message.createdAt ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(new Date(message.createdAt)) : ""}</time>
      </li>) : <li className="session-message-empty">Aucun message pour le moment.</li>}
    </ul>
    {mediaError ? <p className="form-error" role="alert">{mediaError}</p> : null}
    {canSend ? <>
      {mediaLimits ? <p className="session-media-limits" aria-live="polite">{mediaLimits.maxPhotos === null ? "Photos non limitées" : `${photosUsed}/${mediaLimits.maxPhotos} photos`} · {mediaLimits.maxVoiceMessages === null ? "vocaux non limités" : `${voiceUsed}/${mediaLimits.maxVoiceMessages} vocaux`}</p> : null}
      <div className="session-media-actions">
        <label className={`button button-outline${canSendPhoto ? "" : " is-disabled"}`}>
          Ajouter une photo
          <input accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" disabled={!canSendPhoto} onChange={(event) => { void choosePhoto(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} type="file" />
        </label>
        <button className={recording ? "button button-primary" : "button button-outline"} disabled={!recording && !canSendVoice} onClick={() => void toggleVoiceRecording()} type="button">
          {recording ? "Arrêter le message vocal" : "Enregistrer un message vocal"}
        </button>
        {mediaBusy ? <span role="status">Analyse et envoi du média…</span> : recording ? <span role="status">Enregistrement en cours… (maximum {mediaLimits?.maxVoiceSeconds || 60} s)</span> : null}
      </div>
      <form className="session-message-form" onSubmit={(event) => void send(event)}><label htmlFor="session-message-text">Votre message</label><textarea id="session-message-text" maxLength={4000} rows={3} value={text} onChange={(event) => setText(event.target.value)} /><div><small>{text.length}/4000</small><button className="button button-primary" disabled={sending || !text.trim()} type="submit">{sending ? "Envoi…" : "Envoyer"}</button></div></form>
    </> : !loading ? <p className="appointment-privacy">La séance est terminée. L’historique reste consultable, mais l’envoi de nouveaux messages est fermé.</p> : null}
  </section>;
}
