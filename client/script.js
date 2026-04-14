const DEFAULT_REMOTE_SIGNALING_URL = "https://voice-chat-7ryk.onrender.com";
const DEFAULT_ICE_SERVERS = [
  {
    urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
      "stun:stun2.l.google.com:19302"
    ]
  }
];

const runtimeConfig = window.VOICE_CHAT_CONFIG || {};
const SIGNALING_SERVER_URL = resolveSignalingServerUrl();
const RTC_CONFIGURATION = resolveRtcConfiguration();
const HAS_TURN_SERVER = hasTurnServer(RTC_CONFIGURATION);

const joinForm = document.getElementById("join-form");
const roomInput = document.getElementById("room-input");
const createRoomButton = document.getElementById("create-room-button");
const shareLinkInput = document.getElementById("share-link");
const copyLinkButton = document.getElementById("copy-link-button");
const joinButton = document.getElementById("join-button");
const muteButton = document.getElementById("mute-button");
const leaveButton = document.getElementById("leave-button");
const statusText = document.getElementById("status-text");
const currentRoomLabel = document.getElementById("current-room");
const participantCountLabel = document.getElementById("participant-count");
const micStatusLabel = document.getElementById("mic-status");
const participantSummary = document.getElementById("participant-summary");
const participantsContainer = document.getElementById("participants");
const selfStateLabel = document.getElementById("self-state");

let socket = null;
let localStream = null;
let currentRoomId = "";
let isLeaving = false;
let isMicMuted = false;

const peerConnections = new Map();
const participantCards = new Map();
const pendingIceCandidates = new Map();

roomInput.value = getInitialRoomId();
updateShareLink(roomInput.value);
updateMuteUi();

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (socket) {
    return;
  }

  const roomId = roomInput.value.trim();

  if (!roomId) {
    setStatus("Create a room ID or type one before joining.");
    return;
  }

  await joinRoom(roomId);
});

roomInput.addEventListener("input", () => {
  updateShareLink(roomInput.value);
});

createRoomButton.addEventListener("click", () => {
  if (socket) {
    return;
  }

  roomInput.value = createRoomId();
  updateShareLink(roomInput.value);
  roomInput.focus();
  roomInput.select();
  setStatus("A new room ID is ready. Share the invite link, then join the call.");
});

copyLinkButton.addEventListener("click", async () => {
  await copyInviteLink();
});

leaveButton.addEventListener("click", async () => {
  await leaveRoom("You left the call.");
});

muteButton.addEventListener("click", () => {
  toggleMute();
});

async function joinRoom(roomId) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("This browser does not support microphone access.");
    return;
  }

  joinButton.disabled = true;
  setStatus("Requesting microphone access...");
  setSelfState("Waiting for microphone permission");

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
  } catch (error) {
    handleMediaError(error);
    joinButton.disabled = false;
    return;
  }

  isMicMuted = false;
  syncLocalAudioTracks();
  updateMuteUi();
  setSelfState(getReadyStateLabel());
  setStatus("Connecting to the signaling server...");
  connectSocket(roomId);
}

function connectSocket(roomId) {
  currentRoomId = roomId;
  updateShareLink(roomId);
  isLeaving = false;
  socket = io(SIGNALING_SERVER_URL, {
    transports: ["websocket", "polling"]
  });

  registerSocketEvents();
}

function registerSocketEvents() {
  socket.on("connect", () => {
    setConnectedUi(true);
    currentRoomLabel.textContent = currentRoomId;
    setStatus(`Connected. Joining "${currentRoomId}"...`);
    socket.emit("join-room", { roomId: currentRoomId });
  });

  socket.on("connect_error", async (error) => {
    console.error("Could not connect to the signaling server:", error);
    await leaveRoom(
      `Could not reach ${SIGNALING_SERVER_URL}. Open the Render URL directly or update client/config.js with the active backend URL.`
    );
  });

  socket.on("room-error", async (message) => {
    setStatus(message);
    await leaveRoom(message);
  });

  socket.on("existing-users", async (userIds) => {
    setSelfState(getConnectedStateLabel());

    if (userIds.length === 0) {
      setStatus("You joined the room. Waiting for someone else to join...");
      participantSummary.textContent = "No one else is in the room yet.";
      return;
    }

    setStatus(`Joining audio with ${userIds.length} participant(s)...`);

    for (const userId of userIds) {
      await startOffer(userId);
    }
  });

  socket.on("user-joined", ({ userId }) => {
    ensureParticipantCard(userId, "Connecting audio...");
    setStatus("A new participant joined. Waiting for their audio offer...");
  });

  socket.on("offer", async ({ from, offer }) => {
    try {
      const peerConnection = createPeerConnection(from);
      ensureParticipantCard(from, "Connecting audio...");
      await peerConnection.setRemoteDescription(offer);
      await flushPendingIceCandidates(from);

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      socket.emit("answer", { to: from, answer });
      setStatus("Accepted an incoming audio connection.");
    } catch (error) {
      console.error("Error while answering an offer:", error);
      setStatus("Could not accept an incoming connection.");
    }
  });

  socket.on("answer", async ({ from, answer }) => {
    const peerConnection = peerConnections.get(from);

    if (!peerConnection) {
      return;
    }

    try {
      await peerConnection.setRemoteDescription(answer);
      await flushPendingIceCandidates(from);
      setStatus("Audio connection established.");
    } catch (error) {
      console.error("Error while applying an answer:", error);
    }
  });

  socket.on("ice-candidate", async ({ from, candidate }) => {
    if (!candidate) {
      return;
    }

    const peerConnection = peerConnections.get(from);

    if (!peerConnection) {
      queueIceCandidate(from, candidate);
      return;
    }

    try {
      await peerConnection.addIceCandidate(candidate);
    } catch (error) {
      console.error("Error while adding an ICE candidate:", error);
      queueIceCandidate(from, candidate);
    }
  });

  socket.on("user-left", ({ userId }) => {
    removePeer(userId);
    setStatus("A participant left the room.");
  });

  socket.on("room-users", (count) => {
    updateParticipantCount(count);
  });

  socket.on("disconnect", () => {
    if (isLeaving) {
      return;
    }

    cleanupPeers();
    stopLocalStream();
    setConnectedUi(false);
    currentRoomLabel.textContent = "Disconnected";
    updateParticipantCount(0);
    setSelfState("Disconnected");
    setStatus("Connection lost. You can join the room again.");
    socket = null;
  });
}

function createPeerConnection(userId) {
  if (peerConnections.has(userId)) {
    return peerConnections.get(userId);
  }

  const peerConnection = new RTCPeerConnection(RTC_CONFIGURATION);

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });
  }

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && socket) {
      socket.emit("ice-candidate", {
        to: userId,
        candidate: event.candidate
      });
    }
  };

  peerConnection.ontrack = (event) => {
    const stream = event.streams[0] || new MediaStream([event.track]);
    attachRemoteStream(userId, stream);
  };

  peerConnection.oniceconnectionstatechange = () => {
    const state = peerConnection.iceConnectionState;

    if (state === "checking") {
      ensureParticipantCard(userId, getConnectingMessage());
      return;
    }

    if (state === "connected" || state === "completed") {
      ensureParticipantCard(userId, "Audio route established");
      return;
    }

    if (state === "failed") {
      ensureParticipantCard(userId, getFailureMessage());
      setStatus(getFailureStatusMessage());
    }
  };

  peerConnection.onicecandidateerror = (event) => {
    console.error("ICE candidate error:", event);

    if (!HAS_TURN_SERVER) {
      return;
    }

    setStatus(
      "TURN relay is configured, but the browser could not use it. Recheck TURN URL, username, credential, and TLS/port settings."
    );
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;

    if (state === "connected") {
      ensureParticipantCard(userId, "Audio live");
      return;
    }

    if (state === "disconnected") {
      ensureParticipantCard(userId, "Reconnecting audio...");
      return;
    }

    if (state === "failed") {
      ensureParticipantCard(userId, getFailureMessage());
      setStatus(getFailureStatusMessage());
      return;
    }

    if (state === "closed") {
      removePeer(userId);
    }
  };

  peerConnections.set(userId, peerConnection);
  return peerConnection;
}

async function startOffer(userId) {
  try {
    const peerConnection = createPeerConnection(userId);
    ensureParticipantCard(userId, "Connecting audio...");

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit("offer", { to: userId, offer });
  } catch (error) {
    console.error("Error while creating an offer:", error);
    setStatus("Could not start one of the audio connections.");
  }
}

function attachRemoteStream(userId, stream) {
  const participantCard = ensureParticipantCard(userId, "Audio ready");
  const audioElement = participantCard.querySelector("audio");

  audioElement.srcObject = stream;
  audioElement.hidden = false;
  attemptRemotePlayback(userId, audioElement);
}

async function attemptRemotePlayback(userId, audioElement) {
  try {
    await audioElement.play();
    ensureParticipantCard(userId, "Audio live");
  } catch (error) {
    console.error("Audio autoplay was blocked:", error);
    ensureParticipantCard(userId, "Audio ready. Press play to hear.");
    setStatus(
      "A remote stream is ready. If you cannot hear it yet, press Play on that participant card."
    );
  }
}

function ensureParticipantCard(userId, stateText) {
  if (participantCards.has(userId)) {
    const existingCard = participantCards.get(userId);
    const statusNode = existingCard.querySelector("p");
    statusNode.textContent = stateText;
    return existingCard;
  }

  const card = document.createElement("article");
  card.className = "participant";
  card.dataset.userId = userId;

  const info = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = `Guest ${userId.slice(0, 5)}`;

  const status = document.createElement("p");
  status.textContent = stateText;

  const audio = document.createElement("audio");
  audio.className = "participant-audio";
  audio.autoplay = true;
  audio.controls = true;
  audio.hidden = true;
  audio.playsInline = true;
  audio.addEventListener("play", () => {
    if (audio.srcObject) {
      ensureParticipantCard(userId, "Audio live");
    }
  });

  info.append(title, status);
  card.append(info, audio);
  participantsContainer.appendChild(card);
  participantCards.set(userId, card);

  return card;
}

function removePeer(userId) {
  const peerConnection = peerConnections.get(userId);

  if (peerConnection) {
    peerConnection.close();
    peerConnections.delete(userId);
  }

  pendingIceCandidates.delete(userId);

  const card = participantCards.get(userId);

  if (card) {
    const audioElement = card.querySelector("audio");

    if (audioElement) {
      audioElement.srcObject = null;
    }

    card.remove();
    participantCards.delete(userId);
  }
}

function cleanupPeers() {
  Array.from(peerConnections.keys()).forEach(removePeer);
}

function queueIceCandidate(userId, candidate) {
  const queue = pendingIceCandidates.get(userId) || [];
  queue.push(candidate);
  pendingIceCandidates.set(userId, queue);
}

async function flushPendingIceCandidates(userId) {
  const peerConnection = peerConnections.get(userId);
  const queuedCandidates = pendingIceCandidates.get(userId);

  if (!peerConnection || !queuedCandidates || queuedCandidates.length === 0) {
    return;
  }

  for (const candidate of queuedCandidates) {
    try {
      await peerConnection.addIceCandidate(candidate);
    } catch (error) {
      console.error("Could not apply a queued ICE candidate:", error);
    }
  }

  pendingIceCandidates.delete(userId);
}

async function leaveRoom(message) {
  isLeaving = true;

  if (socket) {
    socket.emit("leave-room");
    socket.disconnect();
    socket = null;
  }

  cleanupPeers();
  stopLocalStream();
  setConnectedUi(false);
  currentRoomLabel.textContent = "Not connected";
  updateParticipantCount(0);
  participantSummary.textContent = "No one else is in the room yet.";
  setSelfState("Not connected");
  setStatus(message);
  currentRoomId = "";
  isLeaving = false;
}

function stopLocalStream() {
  if (!localStream) {
    isMicMuted = false;
    updateMuteUi();
    return;
  }

  localStream.getTracks().forEach((track) => track.stop());
  localStream = null;
  isMicMuted = false;
  updateMuteUi();
}

function setConnectedUi(isConnected) {
  roomInput.disabled = isConnected;
  createRoomButton.disabled = isConnected;
  joinButton.disabled = isConnected;
  leaveButton.disabled = !isConnected;
}

function toggleMute() {
  if (!localStream) {
    return;
  }

  isMicMuted = !isMicMuted;
  syncLocalAudioTracks();
  updateMuteUi();

  if (socket) {
    setSelfState(getConnectedStateLabel());
  } else {
    setSelfState(getReadyStateLabel());
  }

  setStatus(
    isMicMuted ? "Your microphone is muted." : "Your microphone is unmuted."
  );
}

function syncLocalAudioTracks() {
  if (!localStream) {
    return;
  }

  localStream.getAudioTracks().forEach((track) => {
    track.enabled = !isMicMuted;
  });
}

function updateMuteUi() {
  const hasMicrophone = Boolean(localStream);

  muteButton.disabled = !hasMicrophone;
  muteButton.textContent = isMicMuted ? "Unmute" : "Mute";
  muteButton.classList.toggle("is-muted", isMicMuted);
  micStatusLabel.textContent = hasMicrophone ? (isMicMuted ? "Muted" : "On") : "Off";
}

function getReadyStateLabel() {
  return isMicMuted ? "Microphone ready (muted)" : "Microphone ready";
}

function getConnectedStateLabel() {
  return isMicMuted ? "Connected (muted)" : "Connected";
}

function setStatus(message) {
  statusText.textContent = message;
}

function setSelfState(message) {
  selfStateLabel.textContent = message;
}

function updateParticipantCount(count) {
  participantCountLabel.textContent = String(count);

  if (count <= 1) {
    participantSummary.textContent = "No one else is in the room yet.";
    return;
  }

  participantSummary.textContent = `${count - 1} other participant(s) connected.`;
}

function handleMediaError(error) {
  console.error("Microphone error:", error);

  if (error.name === "NotAllowedError") {
    setStatus("Microphone access was blocked. Allow the permission and try again.");
    setSelfState("Permission denied");
    return;
  }

  if (error.name === "NotFoundError") {
    setStatus("No microphone was found on this device.");
    setSelfState("No microphone found");
    return;
  }

  setStatus("Could not access the microphone.");
  setSelfState("Microphone unavailable");
}

async function copyInviteLink() {
  if (!shareLinkInput.value) {
    return;
  }

  try {
    await navigator.clipboard.writeText(shareLinkInput.value);
    setStatus("Invite link copied. Send it to the other participant.");
  } catch (error) {
    shareLinkInput.focus();
    shareLinkInput.select();
    setStatus("Copy failed. The invite link is selected so you can copy it manually.");
  }
}

function updateShareLink(roomId) {
  const trimmedRoomId = String(roomId || "").trim();
  const shareUrl = new URL(window.location.href);

  if (trimmedRoomId) {
    shareUrl.searchParams.set("room", trimmedRoomId);
  } else {
    shareUrl.searchParams.delete("room");
  }

  history.replaceState(null, "", `${shareUrl.pathname}${shareUrl.search}${shareUrl.hash}`);
  shareLinkInput.value = shareUrl.toString();
  copyLinkButton.disabled = !trimmedRoomId;
}

function getInitialRoomId() {
  const roomFromUrl = new URL(window.location.href).searchParams.get("room");

  if (roomFromUrl && roomFromUrl.trim()) {
    return roomFromUrl.trim();
  }

  return createRoomId();
}

function createRoomId() {
  return `room-${createRandomToken(6)}`;
}

function createRandomToken(length) {
  if (window.crypto && window.crypto.getRandomValues) {
    const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    const values = new Uint8Array(length);
    window.crypto.getRandomValues(values);

    return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
  }

  return Math.random().toString(36).slice(2, 2 + length);
}

function resolveSignalingServerUrl() {
  const currentUrl = new URL(window.location.href);
  const configuredUrl =
    currentUrl.searchParams.get("backend") || runtimeConfig.signalingServerUrl;

  if (configuredUrl) {
    return stripTrailingSlash(configuredUrl);
  }

  if (isLocalDevelopmentHost()) {
    return "http://localhost:3000";
  }

  if (window.location.hostname.endsWith("github.io")) {
    return DEFAULT_REMOTE_SIGNALING_URL;
  }

  return stripTrailingSlash(window.location.origin);
}

function resolveRtcConfiguration() {
  const configuredRtc = runtimeConfig.rtcConfiguration || {};

  if (Array.isArray(configuredRtc.iceServers) && configuredRtc.iceServers.length > 0) {
    return configuredRtc;
  }

  return {
    ...configuredRtc,
    iceServers: DEFAULT_ICE_SERVERS
  };
}

function hasTurnServer(configuration) {
  const iceServers = Array.isArray(configuration?.iceServers)
    ? configuration.iceServers
    : [];

  return iceServers.some((server) => {
    const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
    return urls.some((url) => String(url || "").trim().toLowerCase().startsWith("turn:"));
  });
}

function getConnectingMessage() {
  return HAS_TURN_SERVER ? "Connecting audio through network relay..." : "Connecting audio...";
}

function getFailureMessage() {
  if (HAS_TURN_SERVER) {
    return "Connection failed. Check the TURN relay settings.";
  }

  return "Connection failed. Add a TURN server for different networks.";
}

function getFailureStatusMessage() {
  if (HAS_TURN_SERVER) {
    return "Audio could not connect even with TURN enabled. Verify the TURN server URL, username, credential, and whether the relay allows your deployed origin.";
  }

  return "Audio is failing across networks because this deployment is using STUN only. Add TURN relay settings in client/config.js or Render environment variables.";
}

function isLocalDevelopmentHost() {
  return (
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
  );
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}
