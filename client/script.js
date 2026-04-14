// Replace this with your deployed backend URL before publishing to GitHub Pages.
const SIGNALING_SERVER_URL =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1"
    ? "http://localhost:3000"
    : "https://voice-chat-7ryk.onrender.com";

const RTC_CONFIGURATION = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

const joinForm = document.getElementById("join-form");
const roomInput = document.getElementById("room-input");
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

roomInput.value = "demo-room";

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (socket) {
    return;
  }

  const roomId = roomInput.value.trim();

  if (!roomId) {
    setStatus("Enter a room name before joining.");
    return;
  }

  await joinRoom(roomId);
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
      "Could not reach the signaling server. Update the backend URL in client/script.js and try again."
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
    attachRemoteStream(userId, event.streams[0]);
  };

  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection.connectionState;

    if (state === "connected") {
      ensureParticipantCard(userId, "Audio live");
    }

    if (state === "failed" || state === "closed") {
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
  const participantCard = ensureParticipantCard(userId, "Audio live");
  const audioElement = participantCard.querySelector("audio");

  audioElement.srcObject = stream;
  audioElement
    .play()
    .catch((error) => console.error("Audio autoplay was blocked:", error));
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
  audio.autoplay = true;
  audio.playsInline = true;

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
