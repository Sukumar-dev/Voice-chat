window.VOICE_CHAT_CONFIG = window.VOICE_CHAT_CONFIG || {
  signalingServerUrl: "https://voice-chat-7ryk.onrender.com",
  rtcConfiguration: {
    iceServers: [
      {
        urls: [
          "turn:global.relay.metered.ca:80",
          "turn:global.relay.metered.ca:80?transport=tcp",
          "turn:global.relay.metered.ca:443",
          "turns:global.relay.metered.ca:443?transport=tcp"
        ],
        username: "44826b2a63ee37960a162f04",
        credential: "K8xeOyt/1UWC5ukt"
      }
    ]
  }
};
