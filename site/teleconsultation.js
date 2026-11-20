import { auth, firebaseAuthActions, requestNexaFunction, NexaApiError } from "./firebase-client.js";

const loading = document.querySelector("#teleconsultation-loading");
const sessionPanel = document.querySelector("#teleconsultation-session");
const errorBox = document.querySelector("#teleconsultation-error");
const noticeBox = document.querySelector("#teleconsultation-notice");
const statusBox = document.querySelector("#teleconsultation-status");
const timeLabel = document.querySelector("#teleconsultation-time");
const countdown = document.querySelector("#video-countdown");
const localVideo = document.querySelector("#local-video");
const remoteVideo = document.querySelector("#remote-video");
const inviteButton = document.querySelector("#invite-participant");
const joinButton = document.querySelector("#join-session");
const acceptButton = document.querySelector("#accept-invitation");
const refuseButton = document.querySelector("#refuse-invitation");
const microphoneButton = document.querySelector("#toggle-microphone");
const cameraButton = document.querySelector("#toggle-camera");
const leaveButton = document.querySelector("#leave-session");
const completeButton = document.querySelector("#complete-consultation");
const callHistoryEmpty = document.querySelector("#call-history-empty");
const callHistoryList = document.querySelector("#call-history-list");
const sessionMessagesLoading = document.querySelector("#session-messages-loading");
const sessionMessagesEmpty = document.querySelector("#session-messages-empty");
const sessionMessagesList = document.querySelector("#session-messages-list");
const sessionMessagesError = document.querySelector("#session-messages-error");
const sessionMessagesStatus = document.querySelector("#session-messages-status");
const sessionMessagesForm = document.querySelector("#session-message-form");
const sessionMessageText = document.querySelector("#session-message-text");
const sessionMessageSubmit = document.querySelector("#session-message-submit");
const sessionMediaActions = document.querySelector("#session-media-actions");
const sessionPhotoInput = document.querySelector("#session-photo-input");
const sessionPhotoLabel = document.querySelector("#session-photo-label");
const sessionVoiceButton = document.querySelector("#session-voice-button");
const sessionMediaProgress = document.querySelector("#session-media-progress");
const sessionMediaLimits = document.querySelector("#session-media-limits");
const sessionMessagesClosed = document.querySelector("#session-messages-closed");
const appointmentId = new URLSearchParams(window.location.search).get("appointmentId") || "";
const appointmentIdPattern = /^[A-Za-z0-9_-]{10,200}$/;

let currentUser = null;
let participantRole = "";
let canComplete = false;
let noShowOutcome = null;
let noShowReason = null;
let appointmentStatus = "";
let sessionStatus = "";
let videoSignal = null;
let callAttempts = [];
let client = null;
let localTracks = [];
let joined = false;
let joining = false;
let busy = false;
let muted = false;
let cameraOff = false;
let presenceActive = false;
let remainingSeconds = null;
let appointmentStartsAt = "";
let countdownTimer = null;
let heartbeatTimer = null;
let pollTimer = null;
let messagesPollTimer = null;
let messagesLoading = false;
let messagesSending = false;
let sessionMessages = [];
let sessionMessagesRenderKey = "";
let sessionMessageRows = new Map();
let sessionMediaLimitsState = null;
let canSendSessionMessages = false;
let mediaBusy = false;
let voiceRecording = false;
let voiceRecorder = null;
let voiceStream = null;
let voiceChunks = [];
let voiceTimer = null;
let voiceStartedAt = 0;
const sessionMediaUrls = new Map();

document.querySelector("#current-year").textContent = String(new Date().getFullYear());

function showMessage(element, message) {
  element.textContent = message || "";
  element.hidden = !message;
}

function renderSessionMessages(messages, { force = false } = {}) {
  sessionMessages = Array.isArray(messages) ? messages : [];
  const messageIds = new Set(sessionMessages.map((message) => message.id).filter(Boolean));
  for (const messageId of sessionMediaUrls.keys()) {
    if (!messageIds.has(messageId)) sessionMediaUrls.delete(messageId);
  }
  const renderKey = JSON.stringify([
    currentUser?.uid || "",
    sessionMessages.map((message) => [message.id, message.senderUid, message.kind, message.text, message.fileName, message.durationSeconds, message.createdAt]),
  ]);
  sessionMessagesEmpty.hidden = sessionMessages.length > 0;
  if (!force && renderKey === sessionMessagesRenderKey) return;
  sessionMessagesRenderKey = renderKey;
  const nextRows = new Map();
  const renderedRows = [];
  sessionMessages.forEach((message, index) => {
    const rowId = String(message.id || `missing-${index}`);
    const rowFingerprint = JSON.stringify([
      currentUser?.uid || "", message.senderUid, message.kind, message.text, message.fileName,
      message.durationSeconds, message.createdAt, sessionMediaUrls.get(rowId) || "",
    ]);
    const existingRow = sessionMessageRows.get(rowId);
    if (existingRow?.fingerprint === rowFingerprint) {
      nextRows.set(rowId, existingRow);
      renderedRows.push(existingRow.element);
      return;
    }
    const item = document.createElement("li");
    item.dataset.messageId = rowId;
    item.className = "nexa-session-messages__item" + (message.senderUid === currentUser?.uid ? " is-mine" : "");
    const sender = document.createElement("span");
    sender.className = "nexa-session-messages__sender";
    sender.textContent = message.senderUid === currentUser?.uid ? "Vous" : "Participant";
    item.append(sender);
    if (message.kind === "photo" || message.kind === "voice") {
      const media = document.createElement("div");
      media.className = "nexa-session-messages__media";
      const url = sessionMediaUrls.get(rowId);
      if (url && message.kind === "photo") {
        const image = document.createElement("img");
        image.alt = safeMessageFileName(message.fileName) || "Photo envoyée dans la séance";
        image.loading = "lazy";
        image.src = url;
        image.addEventListener("error", () => {
          sessionMediaUrls.delete(rowId);
          renderSessionMessages(sessionMessages, { force: true });
        }, { once: true });
        media.append(image);
      } else if (url && message.kind === "voice") {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.preload = "none";
        audio.src = url;
        audio.addEventListener("error", () => {
          sessionMediaUrls.delete(rowId);
          renderSessionMessages(sessionMessages, { force: true });
        }, { once: true });
        media.append(audio);
        if (Number.isSafeInteger(message.durationSeconds) && message.durationSeconds > 0) {
          const duration = document.createElement("small");
          duration.textContent = `${message.durationSeconds} s`;
          media.append(duration);
        }
      } else {
        const openButton = document.createElement("button");
        openButton.className = "button button-outline";
        openButton.type = "button";
        openButton.textContent = message.kind === "photo" ? "Afficher la photo" : "Charger le message vocal";
        openButton.addEventListener("click", () => { void loadSessionMedia(message); });
        media.append(openButton);
      }
      item.append(media);
    } else {
      const content = document.createElement("p");
      content.className = "nexa-session-messages__text";
      content.textContent = typeof message.text === "string" ? message.text : "";
      item.append(content);
    }
    if (message.createdAt) {
      const date = new Date(message.createdAt);
      if (!Number.isNaN(date.getTime())) {
        const time = document.createElement("time");
        time.dateTime = date.toISOString();
        time.textContent = new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "medium", timeStyle: "short" }).format(date);
        item.append(time);
      }
    }
    const row = { fingerprint: rowFingerprint, element: item };
    nextRows.set(rowId, row);
    renderedRows.push(item);
  });
  sessionMessageRows = nextRows;
  renderedRows.forEach((row, index) => {
    const current = sessionMessagesList.children[index];
    if (current !== row) sessionMessagesList.insertBefore(row, current || null);
  });
  while (sessionMessagesList.children.length > renderedRows.length) sessionMessagesList.lastElementChild.remove();
  sessionMessagesList.scrollTop = sessionMessagesList.scrollHeight;
}

function safeMessageFileName(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 120) : "";
}

function updateSessionMediaControls(canSend) {
  sessionMediaActions.hidden = !canSend;
  const limits = sessionMediaLimitsState;
  const photoCap = limits?.maxPhotos;
  const voiceCap = limits?.maxVoiceMessages;
  const photosUsed = Number(limits?.photosUsed) || 0;
  const voiceUsed = Number(limits?.voiceMessagesUsed) || 0;
  const photoAvailable = photoCap === null || (Number(photoCap) > photosUsed);
  const voiceAvailable = voiceCap === null || (Number(voiceCap) > voiceUsed);
  const maxVoiceSeconds = Math.max(1, Math.min(300, Number(limits?.maxVoiceSeconds) || 60));
  sessionPhotoInput.disabled = !canSend || !photoAvailable || mediaBusy || voiceRecording;
  sessionPhotoLabel.classList.toggle("is-disabled", sessionPhotoInput.disabled);
  sessionVoiceButton.disabled = (!canSend || !voiceAvailable || mediaBusy) && !voiceRecording;
  sessionVoiceButton.textContent = voiceRecording ? "Arrêter le message vocal" : "Enregistrer un message vocal";
  sessionMediaProgress.hidden = !mediaBusy && !voiceRecording;
  if (mediaBusy) sessionMediaProgress.textContent = "Analyse antivirus et envoi du média…";
  else if (voiceRecording) sessionMediaProgress.textContent = `Enregistrement en cours… (maximum ${maxVoiceSeconds} s)`;
  if (limits) {
    const photoLabel = photoCap === null ? "photos sans limite" : `${photosUsed}/${photoCap} photos`;
    const voiceLabel = voiceCap === null ? "vocaux sans limite" : `${voiceUsed}/${voiceCap} vocaux`;
    sessionMediaLimits.textContent = `${photoLabel} · ${voiceLabel} · maximum vocal ${maxVoiceSeconds} s`;
    sessionMediaLimits.hidden = false;
  } else {
    sessionMediaLimits.hidden = true;
  }
}

async function loadSessionMessages() {
  if (!currentUser || messagesLoading || !appointmentIdPattern.test(appointmentId)) return;
  messagesLoading = true;
  try {
    const result = await requestNexaFunction(currentUser, "nexaSessionMessages", "GET", undefined, { appointmentId });
    renderSessionMessages(result.messages);
    sessionMediaLimitsState = result.mediaLimits || null;
    const canSend = result.canSend === true;
    canSendSessionMessages = canSend;
    sessionMessagesForm.hidden = !canSend;
    sessionMessagesClosed.hidden = canSend;
    sessionMessageText.disabled = !canSend;
    sessionMessageSubmit.disabled = !canSend || messagesSending;
    updateSessionMediaControls(canSend);
    showMessage(sessionMessagesStatus, "");
    showMessage(sessionMessagesError, "");
  } catch (error) {
    canSendSessionMessages = false;
    sessionMessagesForm.hidden = true;
    sessionMessageText.disabled = true;
    sessionMessageSubmit.disabled = true;
    sessionMessagesClosed.hidden = false;
    updateSessionMediaControls(false);
    showMessage(sessionMessagesError, error instanceof NexaApiError ? error.message : "Les messages de cette séance sont momentanément indisponibles.");
  } finally {
    messagesLoading = false;
    sessionMessagesLoading.hidden = true;
  }
}

async function sendSessionMessage(event) {
  event.preventDefault();
  const text = sessionMessageText.value.trim();
  if (!currentUser || !text || messagesSending || text.length > 4_000) return;
  messagesSending = true;
  sessionMessageSubmit.disabled = true;
  showMessage(sessionMessagesError, "");
  showMessage(sessionMessagesStatus, "Envoi du message…");
  try {
    const result = await requestNexaFunction(currentUser, "nexaSessionMessages", "POST", { appointmentId, text });
    sessionMessageText.value = "";
    if (result.message) renderSessionMessages([...sessionMessages, result.message]);
    showMessage(sessionMessagesStatus, "Message envoyé.");
    void loadSessionMessages();
  } catch (error) {
    showMessage(sessionMessagesStatus, "");
    showMessage(sessionMessagesError, error instanceof NexaApiError ? error.message : "Le message n’a pas pu être envoyé.");
    void loadSessionMessages();
  } finally {
    messagesSending = false;
    sessionMessageSubmit.disabled = sessionMessagesForm.hidden || !sessionMessageText.value.trim();
  }
}

async function uploadSessionMedia(user, file, kind, durationSeconds = 0) {
  let uploadId = "";
  try {
    const ticket = await requestNexaFunction(user, "nexaSessionMediaUpload", "POST", {
      action: "start",
      appointmentId,
      kind,
      contentType: file.type,
      size: file.size,
      fileName: file.name,
      ...(kind === "voice" ? { durationSeconds } : {}),
    });
    uploadId = ticket.uploadId;
    let target;
    try { target = new URL(ticket.uploadUrl); } catch { throw new Error("La destination de dépôt sécurisé n’est pas valide."); }
    if (target.protocol !== "https:" || (target.hostname !== "storage.googleapis.com" && !target.hostname.endsWith(".storage.googleapis.com")) ||
      !ticket.fields || typeof ticket.fields !== "object" || Array.isArray(ticket.fields)) {
      throw new Error("Le dépôt sécurisé n’a pas retourné une destination valide.");
    }
    const formData = new FormData();
    for (const [name, value] of Object.entries(ticket.fields)) {
      if (typeof value !== "string") throw new Error("La session de dépôt sécurisé n’est pas valide.");
      formData.append(name, value);
    }
    formData.append("file", file, ticket.fileName);
    const uploaded = await fetch(target.href, {
      method: "POST",
      body: formData,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!uploaded.ok) throw new Error("Le téléversement sécurisé a échoué. Vérifiez le fichier et réessayez.");
    const finalized = await requestNexaFunction(user, "nexaSessionMediaFinalize", "POST", { appointmentId, uploadId });
    uploadId = "";
    return finalized;
  } catch (error) {
    if (uploadId) {
      await requestNexaFunction(user, "nexaSessionMediaUpload", "DELETE", { appointmentId, uploadId }).catch(() => undefined);
    }
    throw error;
  }
}

async function sendSessionMedia(file, kind, durationSeconds = 0) {
  if (!file || !canSendSessionMessages || mediaBusy) return;
  const allowedTypes = kind === "photo"
    ? new Set(["image/jpeg", "image/png", "image/webp"])
    : new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg"]);
  if (!allowedTypes.has(String(file.type || "").toLowerCase()) || file.size < 1 || file.size > 15 * 1024 * 1024) {
    showMessage(sessionMessagesError, "Choisissez un média au format accepté de 15 Mio maximum.");
    return;
  }
  mediaBusy = true;
  showMessage(sessionMessagesError, "");
  showMessage(sessionMessagesStatus, "Préparation du dépôt sécurisé…");
  updateSessionMediaControls(canSendSessionMessages);
  try {
    await uploadSessionMedia(currentUser, file, kind, durationSeconds);
    showMessage(sessionMessagesStatus, "Le média a été analysé puis envoyé.");
    await loadSessionMessages();
  } catch (error) {
    showMessage(sessionMessagesStatus, "");
    showMessage(sessionMessagesError, error instanceof NexaApiError || error instanceof Error ? error.message : "Le média n’a pas pu être envoyé.");
    void loadSessionMessages();
  } finally {
    mediaBusy = false;
    updateSessionMediaControls(canSendSessionMessages);
  }
}

async function loadSessionMedia(message) {
  if (!currentUser || !message?.id || !["photo", "voice"].includes(message.kind)) return;
  showMessage(sessionMessagesError, "");
  showMessage(sessionMessagesStatus, "Vérification du média…");
  try {
    const result = await requestNexaFunction(currentUser, "nexaSessionMediaRead", "GET", undefined, { appointmentId, messageId: message.id });
    const target = new URL(result.url);
    if (target.protocol !== "https:" || (target.hostname !== "storage.googleapis.com" && !target.hostname.endsWith(".storage.googleapis.com"))) {
      throw new Error("Le lien temporaire du média n’est pas valide.");
    }
    sessionMediaUrls.set(message.id, target.href);
    showMessage(sessionMessagesStatus, "");
    renderSessionMessages(sessionMessages, { force: true });
  } catch (error) {
    showMessage(sessionMessagesStatus, "");
    showMessage(sessionMessagesError, error instanceof NexaApiError || error instanceof Error ? error.message : "Le média n’a pas pu être ouvert.");
  }
}

async function toggleSessionVoiceRecording() {
  if (voiceRecorder?.state === "recording") {
    voiceRecorder.stop();
    return;
  }
  if (!canSendSessionMessages || mediaBusy || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    showMessage(sessionMessagesError, "L’enregistrement vocal n’est pas disponible dans ce navigateur ou pour cette séance.");
    return;
  }
  showMessage(sessionMessagesError, "");
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceChunks = [];
    const candidates = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
    const mimeType = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
    voiceRecorder = new MediaRecorder(voiceStream, mimeType ? { mimeType } : undefined);
    voiceStartedAt = Date.now();
    voiceRecorder.ondataavailable = (event) => { if (event.data.size > 0) voiceChunks.push(event.data); };
    voiceRecorder.onerror = () => showMessage(sessionMessagesError, "L’enregistrement vocal a été interrompu.");
    voiceRecorder.onstop = () => {
      if (voiceTimer !== null) window.clearTimeout(voiceTimer);
      voiceTimer = null;
      voiceStream?.getTracks().forEach((track) => track.stop());
      voiceStream = null;
      voiceRecorder = null;
      voiceRecording = false;
      const maximum = Math.max(1, Math.min(300, Number(sessionMediaLimitsState?.maxVoiceSeconds) || 60));
      const durationSeconds = Math.max(1, Math.min(maximum, Math.ceil((Date.now() - voiceStartedAt) / 1_000)));
      const contentType = String(mimeType || "audio/webm").split(";", 1)[0].toLowerCase();
      const blob = new Blob(voiceChunks, { type: contentType });
      voiceChunks = [];
      const extension = contentType.split("/")[1] || "audio";
      updateSessionMediaControls(canSendSessionMessages);
      if (blob.size > 0) void sendSessionMedia(new File([blob], `message-vocal.${extension}`, { type: contentType }), "voice", durationSeconds);
      else showMessage(sessionMessagesError, "Aucun son n’a été enregistré.");
    };
    voiceRecorder.start(1_000);
    voiceRecording = true;
    updateSessionMediaControls(canSendSessionMessages);
    const maximum = Math.max(1, Math.min(300, Number(sessionMediaLimitsState?.maxVoiceSeconds) || 60));
    voiceTimer = window.setTimeout(() => { if (voiceRecorder?.state === "recording") voiceRecorder.stop(); }, maximum * 1_000);
  } catch {
    voiceStream?.getTracks().forEach((track) => track.stop());
    voiceStream = null;
    voiceRecording = false;
    updateSessionMediaControls(canSendSessionMessages);
    showMessage(sessionMessagesError, "Autorisez le microphone pour enregistrer un message vocal.");
  }
}

function sessionDate(value) {
  const date = new Date(value);
  return !value || Number.isNaN(date.getTime())
    ? "Horaire indisponible"
    : new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "full", timeStyle: "short" }).format(date);
}

function formatRemaining(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(safe / 60);
  const remainder = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")} restantes`;
}

function renderCallHistory() {
  const labels = {
    NO_ANSWER: "sans réponse",
    REFUSED: "refusé",
    CONNECTED: "connecté",
    ENDED: "terminé",
    ACCEPTED: "accepté",
    RINGING: "en attente",
  };
  const rows = callAttempts.map((attempt) => {
    const item = document.createElement("li");
    const who = attempt.initiatedBy === "patient" ? "Patient" : "Médecin";
    const date = attempt.startedAt ? new Date(attempt.startedAt) : null;
    const at = date && !Number.isNaN(date.getTime())
      ? new Intl.DateTimeFormat("fr-HT", { timeZone: "America/Port-au-Prince", dateStyle: "short", timeStyle: "short" }).format(date)
      : "heure indisponible";
    item.textContent = `${who} · appel ${attempt.attemptNumber} · ${labels[attempt.status] || "état à vérifier"} · ${at}`;
    return item;
  });
  callHistoryList.replaceChildren(...rows);
  callHistoryEmpty.hidden = rows.length > 0;
}

function updateControls() {
  const incoming = videoSignal?.status === "RINGING" && videoSignal.by === "peer";
  const outgoing = videoSignal?.status === "RINGING" && videoSignal.by === "self";
  const closed = appointmentStatus === "COMPLETED" || ["TERMINATED", "INTERACTIVE_TIME_EXPIRED"].includes(sessionStatus) || Boolean(noShowOutcome);
  const blocked = closed || busy || joining;
  const scheduledStart = Date.parse(appointmentStartsAt);
  const notStarted = Number.isFinite(scheduledStart) && Date.now() < scheduledStart;
  inviteButton.hidden = joined || incoming || outgoing || closed;
  joinButton.hidden = joined || incoming || closed;
  acceptButton.hidden = joined || !incoming || closed;
  refuseButton.hidden = joined || !incoming || closed;
  microphoneButton.hidden = !joined;
  cameraButton.hidden = !joined;
  leaveButton.hidden = !joined;
  completeButton.hidden = participantRole !== "doctor" || !canComplete || closed;
  inviteButton.disabled = blocked || notStarted;
  joinButton.disabled = blocked || notStarted;
  acceptButton.disabled = blocked || notStarted;
  refuseButton.disabled = busy;
  microphoneButton.disabled = !joined;
  cameraButton.disabled = !joined;
  leaveButton.disabled = busy;
  completeButton.disabled = busy;
  if (appointmentStatus === "COMPLETED" || ["TERMINATED", "INTERACTIVE_TIME_EXPIRED"].includes(sessionStatus)) showMessage(statusBox, "Cette séance vidéo est terminée.");
  else if (notStarted) showMessage(statusBox, `La salle vidéo sera accessible à ${sessionDate(appointmentStartsAt)}.`);
  else if (outgoing) showMessage(statusBox, "L’invitation a été envoyée. En attente de l’autre participant…");
  else if (incoming) showMessage(statusBox, "L’autre participant vous invite à rejoindre la séance.");
  else if (joined) showMessage(statusBox, "Vous êtes dans la salle vidéo sécurisée.");
  else if (noShowReason === "PROVIDER_DID_NOT_ACCEPT") showMessage(statusBox, "Le médecin n’a pas accepté le rendez-vous. Le dossier est en examen par l’administration NEXA et la salle vidéo est fermée.");
  else if (noShowOutcome) showMessage(statusBox, "Les appels de cette séance ont été signalés à NEXA. La salle est suspendue.");
}

function updateCallState(result) {
  videoSignal = result.videoSignal || null;
  callAttempts = Array.isArray(result.callAttempts) ? result.callAttempts : [];
  participantRole = result.participantRole || participantRole;
  canComplete = result.canComplete === true;
  noShowOutcome = result.noShowOutcome || null;
  noShowReason = result.noShowReason || null;
  appointmentStatus = result.appointmentStatus || appointmentStatus;
  sessionStatus = result.sessionStatus || sessionStatus;
  appointmentStartsAt = typeof result.startsAt === "string" ? result.startsAt : appointmentStartsAt;
  if (appointmentStartsAt) timeLabel.textContent = sessionDate(appointmentStartsAt);
  renderCallHistory();
  updateControls();
}

async function sendSignal(action) {
  if (!currentUser) throw new Error("Connectez-vous pour utiliser la salle vidéo.");
  const result = await requestNexaFunction(currentUser, "nexaVideoSignal", "POST", { appointmentId, action });
  updateCallState(result);
  return result.videoSignal;
}

async function refreshSignal() {
  if (!currentUser || !appointmentIdPattern.test(appointmentId)) return;
  try {
    const result = await requestNexaFunction(currentUser, "nexaVideoSignal", "POST", { appointmentId, action: "timeout" });
    updateCallState(result);
  } catch (error) {
    if (error instanceof NexaApiError && error.status === 409) showMessage(errorBox, error.message);
  }
}

async function requestAgoraToken(presenceAction) {
  const result = await requestNexaFunction(currentUser, "nexaAgoraToken", "POST", { appointmentId, presenceAction });
  if (!result.appId || !result.token || !result.channelName || !Number.isInteger(result.uid)) {
    throw new Error("Le jeton Agora n’a pas été confirmé.");
  }
  return result;
}

async function updatePresence(action) {
  const result = await requestNexaFunction(currentUser, "nexaTeleconsultationPresence", "POST", { appointmentId, action });
  if (typeof result.videoRemainingSeconds === "number") setRemainingSeconds(result.videoRemainingSeconds);
  return result;
}

function setRemainingSeconds(seconds) {
  if (!Number.isFinite(Number(seconds))) return;
  remainingSeconds = Math.max(0, Math.floor(Number(seconds)));
  countdown.textContent = formatRemaining(remainingSeconds);
  countdown.hidden = false;
  if (countdownTimer) window.clearInterval(countdownTimer);
  countdownTimer = window.setInterval(() => {
    if (!joined || remainingSeconds === null) return;
    remainingSeconds = Math.max(0, remainingSeconds - 1);
    countdown.textContent = formatRemaining(remainingSeconds);
    if (remainingSeconds === 0) void leaveCall("La durée vidéo incluse dans cette consultation est terminée.");
  }, 1_000);
}

function replaceVideoPlaceholder(container, text) {
  container.replaceChildren();
  const placeholder = document.createElement("span");
  placeholder.textContent = text;
  container.append(placeholder);
}

async function leaveCall(message = "") {
  if (heartbeatTimer) window.clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (countdownTimer) window.clearInterval(countdownTimer);
  countdownTimer = null;
  if (presenceActive && currentUser) {
    presenceActive = false;
    await updatePresence("leave").catch(() => undefined);
  }
  const tracks = localTracks;
  localTracks = [];
  tracks.forEach((track) => {
    try { track.stop(); track.close(); } catch { /* track déjà fermé par le SDK */ }
  });
  const activeClient = client;
  client = null;
  if (activeClient) await activeClient.leave().catch(() => undefined);
  joined = false;
  joining = false;
  muted = false;
  cameraOff = false;
  replaceVideoPlaceholder(localVideo, "Votre caméra apparaîtra ici après autorisation.");
  replaceVideoPlaceholder(remoteVideo, "En attente de l’autre participant…");
  if (message) showMessage(noticeBox, message);
  updateControls();
}

async function joinCall(acceptInvitation = false) {
  if (!currentUser || joined || joining || busy || noShowOutcome) return;
  if (!appointmentIdPattern.test(appointmentId)) {
    showMessage(errorBox, "Le lien de la consultation est incomplet.");
    return;
  }
  joining = true;
  updateControls();
  showMessage(errorBox, "");
  showMessage(noticeBox, "");
  let createdClient = null;
  try {
    if (acceptInvitation && videoSignal?.status === "RINGING" && videoSignal.by === "peer") await sendSignal("accept");
    const AgoraRTC = globalThis.AgoraRTC;
    if (!AgoraRTC || typeof AgoraRTC.createClient !== "function") throw new Error("Le service vidéo n’a pas pu être chargé. Actualisez la page puis réessayez.");

    presenceActive = true;
    const session = await requestAgoraToken("join");
    setRemainingSeconds(session.videoRemainingSeconds);
    createdClient = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
    client = createdClient;

    createdClient.on("user-published", async (remoteUser, mediaType) => {
      await createdClient.subscribe(remoteUser, mediaType);
      if (mediaType === "video" && remoteUser.videoTrack) {
        remoteVideo.replaceChildren();
        remoteUser.videoTrack.play(remoteVideo);
      }
      if (mediaType === "audio") remoteUser.audioTrack?.play();
    });
    createdClient.on("user-unpublished", (_remoteUser, mediaType) => {
      if (mediaType === "video") replaceVideoPlaceholder(remoteVideo, "L’autre participant a coupé sa caméra.");
    });
    createdClient.on("user-left", () => replaceVideoPlaceholder(remoteVideo, "En attente de l’autre participant…"));
    createdClient.on("token-privilege-will-expire", async () => {
      try {
        const renewal = await requestAgoraToken("heartbeat");
        await createdClient.renewToken(renewal.token);
        setRemainingSeconds(renewal.videoRemainingSeconds);
      } catch (error) {
        await leaveCall(error instanceof NexaApiError ? error.message : "Votre accès vidéo a expiré.");
      }
    });

    await createdClient.join(session.appId, session.channelName, session.token, session.uid);
    const tracks = await AgoraRTC.createMicrophoneAndCameraTracks(
      { encoderConfig: "speech_standard" },
      { encoderConfig: "480p_1" },
    );
    localTracks = tracks;
    localVideo.replaceChildren();
    tracks[1].play(localVideo);
    await createdClient.publish(tracks);
    joined = true;
    joining = false;
    updateControls();
    await sendSignal("connected").catch(() => undefined);
    heartbeatTimer = window.setInterval(async () => {
      if (!joined || !currentUser || busy) return;
      try {
        const presence = await updatePresence("heartbeat");
        if (presence.expired || presence.videoRemainingSeconds === 0) {
          await leaveCall("La durée vidéo incluse dans cette consultation est terminée.");
          return;
        }
        await sendSignal("connected").catch(() => undefined);
      } catch (error) {
        await leaveCall(error instanceof NexaApiError ? error.message : "Le suivi sécurisé de la séance est indisponible. Rejoignez-la de nouveau dans un instant.");
      }
    }, 10_000);
    await refreshSignal();
  } catch (error) {
    if (createdClient || presenceActive) await leaveCall();
    joining = false;
    showMessage(errorBox, error instanceof NexaApiError ? error.message : error instanceof Error ? error.message : "Impossible d’ouvrir la séance vidéo.");
    updateControls();
  }
}

async function inviteParticipant() {
  if (!currentUser || busy) return;
  busy = true;
  updateControls();
  showMessage(errorBox, "");
  try {
    await sendSignal("invite");
  } catch (error) {
    showMessage(errorBox, error instanceof NexaApiError ? error.message : "L’invitation vidéo n’a pas pu être envoyée.");
  } finally {
    busy = false;
    updateControls();
  }
  if (videoSignal?.status === "RINGING" && videoSignal.by === "self") await joinCall();
}

async function endCall() {
  if (!currentUser || busy) return;
  busy = true;
  updateControls();
  try {
    await sendSignal("end").catch(() => undefined);
    await leaveCall("Vous avez quitté l’appel vidéo.");
  } finally {
    busy = false;
    updateControls();
  }
}

async function completeConsultation() {
  if (!currentUser || participantRole !== "doctor" || !canComplete || busy) return;
  busy = true;
  updateControls();
  showMessage(errorBox, "");
  try {
    if (joined) await leaveCall();
    await requestNexaFunction(currentUser, "nexaVideoSignal", "POST", { appointmentId, action: "end" }).catch(() => undefined);
    await requestNexaFunction(currentUser, "nexaProviderAppointments", "POST", { appointmentId, action: "complete" });
    canComplete = false;
    appointmentStatus = "COMPLETED";
    sessionStatus = "TERMINATED";
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = null;
    showMessage(noticeBox, "La consultation est terminée.");
    showMessage(statusBox, "Séance terminée. Vous pouvez retourner à votre espace professionnel.");
    completeButton.hidden = true;
  } catch (error) {
    showMessage(errorBox, error instanceof NexaApiError ? error.message : "La consultation n’a pas pu être terminée.");
  } finally {
    busy = false;
    updateControls();
  }
}

async function toggleMicrophone() {
  const track = localTracks[0];
  if (!track) return;
  muted = !muted;
  await track.setEnabled(!muted);
  microphoneButton.textContent = muted ? "Activer le micro" : "Couper le micro";
}

async function toggleCamera() {
  const track = localTracks[1];
  if (!track) return;
  cameraOff = !cameraOff;
  await track.setEnabled(!cameraOff);
  cameraButton.textContent = cameraOff ? "Activer la caméra" : "Couper la caméra";
}

inviteButton.addEventListener("click", () => { void inviteParticipant(); });
joinButton.addEventListener("click", () => { void joinCall(); });
acceptButton.addEventListener("click", () => { void joinCall(true); });
refuseButton.addEventListener("click", async () => {
  refuseButton.disabled = true;
  try { await sendSignal("refuse"); }
  catch (error) { showMessage(errorBox, error instanceof NexaApiError ? error.message : "L’invitation n’a pas pu être déclinée."); }
  finally { refuseButton.disabled = false; updateControls(); }
});
microphoneButton.addEventListener("click", () => { void toggleMicrophone().catch(() => showMessage(errorBox, "Le micro ne peut pas être modifié.")); });
cameraButton.addEventListener("click", () => { void toggleCamera().catch(() => showMessage(errorBox, "La caméra ne peut pas être modifiée.")); });
leaveButton.addEventListener("click", () => { void endCall(); });
completeButton.addEventListener("click", () => { void completeConsultation(); });
sessionMessagesForm.addEventListener("submit", (event) => { void sendSessionMessage(event); });
sessionMessageText.addEventListener("input", () => { sessionMessageSubmit.disabled = !canSendSessionMessages || !sessionMessageText.value.trim() || messagesSending; });
sessionPhotoInput.addEventListener("change", () => {
  const file = sessionPhotoInput.files?.[0];
  sessionPhotoInput.value = "";
  if (file) void sendSessionMedia(file, "photo");
});
sessionVoiceButton.addEventListener("click", () => { void toggleSessionVoiceRecording(); });

firebaseAuthActions.onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user) {
    const next = `./teleconsultation.html?appointmentId=${encodeURIComponent(appointmentId)}`;
    window.location.replace(`./connexion.html?next=${encodeURIComponent(next)}`);
    return;
  }
  if (!appointmentIdPattern.test(appointmentId)) {
    loading.hidden = true;
    showMessage(errorBox, "Le lien de la consultation est incomplet.");
    return;
  }
  try {
    const status = await requestNexaFunction(user, "nexaVideoSignal", "POST", { appointmentId, action: "timeout" });
    updateCallState(status);
    timeLabel.textContent = status.startsAt ? sessionDate(status.startsAt) : "Séance protégée · horaire selon le fuseau d’Haïti";
    sessionPanel.hidden = false;
    loading.hidden = true;
    if (pollTimer) window.clearInterval(pollTimer);
    pollTimer = window.setInterval(() => { void refreshSignal(); }, 10_000);
    void loadSessionMessages();
    if (messagesPollTimer) window.clearInterval(messagesPollTimer);
    messagesPollTimer = window.setInterval(() => { if (!document.hidden) void loadSessionMessages(); }, 10_000);
  } catch (error) {
    loading.hidden = true;
    showMessage(errorBox, error instanceof NexaApiError ? error.message : "La consultation n’est pas accessible depuis ce compte.");
  }
});

window.addEventListener("pagehide", () => {
  if (currentUser && presenceActive) void updatePresence("leave").catch(() => undefined);
  if (heartbeatTimer) window.clearInterval(heartbeatTimer);
  if (pollTimer) window.clearInterval(pollTimer);
  if (messagesPollTimer) window.clearInterval(messagesPollTimer);
  if (voiceTimer !== null) window.clearTimeout(voiceTimer);
  if (voiceRecorder) {
    voiceRecorder.onstop = null;
    if (voiceRecorder.state !== "inactive") voiceRecorder.stop();
  }
  voiceStream?.getTracks().forEach((track) => track.stop());
  localTracks.forEach((track) => { try { track.stop(); track.close(); } catch { /* fermeture déjà effectuée */ } });
  void client?.leave().catch(() => undefined);
});
