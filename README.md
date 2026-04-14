# Real-Time Voice Chat

A beginner-friendly real-time voice chat app built with plain HTML, CSS, JavaScript, WebRTC, Node.js, and Socket.IO.

The app now creates shareable room IDs automatically, exposes a copyable invite link, and can serve the frontend directly from the Node server so one Render deployment can host the full experience.

## Folder structure

```text
.
├── .github/
│   └── workflows/
│       └── deploy-client.yml
├── client/
│   ├── index.html
│   ├── script.js
│   └── style.css
├── server/
│   ├── package.json
│   └── server.js
└── README.md
```

## How it works

- The browser gets microphone access with `getUserMedia`.
- The Socket.IO server helps users in the same room exchange WebRTC offers, answers, and ICE candidates.
- After signaling is complete, the audio stream flows directly between browsers with WebRTC.
- This project uses a simple mesh setup, so it is best for small rooms.
- This demo uses public STUN servers by default. For stronger real-world reliability, add a TURN server later.

## Run locally

1. Install backend dependencies:

   ```bash
   cd server
   npm install
   npm run dev
   ```

2. In a second terminal, start a simple static server for the frontend:

   ```bash
   cd client
   python3 -m http.server 5500
   ```

3. Open [http://127.0.0.1:5500](http://127.0.0.1:5500) in two browser tabs or on two devices.
4. Share the generated invite link or join the same room ID in both tabs.
5. Allow microphone access when the browser asks.
6. If a browser blocks autoplay, press the Play button on that participant card.

Note: opening `index.html` directly with `file://` is not recommended because microphone access works best on `localhost` or HTTPS.

## Deploy on Render

This is now the simplest deployment path because Render can host the Socket.IO backend and the static frontend from the same URL.

1. Create a new GitHub repository and push this project.
2. Create a new **Web Service** on Render.
3. Point Render to your GitHub repository.
4. Set the **Root Directory** to `server`.
5. Use:

   - Build command: `npm install`
   - Start command: `npm start`

6. Deploy the service and open the Render URL, for example:

   - `https://voice-chat-7ryk.onrender.com`

7. Optional environment variables:

   - `CLIENT_ORIGIN=https://YOUR_GITHUB_USERNAME.github.io,http://127.0.0.1:5500,http://localhost:5500`
   - `TURN_SERVER_URLS=turn:YOUR_TURN_HOST:3478`
   - `TURN_USERNAME=YOUR_USERNAME`
   - `TURN_CREDENTIAL=YOUR_PASSWORD`

When the app is served from Render, the frontend automatically connects back to the same origin, so you do not need to hard-code the backend URL anymore.

## Deploy the frontend with GitHub Pages

GitHub Pages is still optional if you want a separate static frontend.

1. Open `client/config.js`.
2. Set `signalingServerUrl` to your live backend, for example `https://voice-chat-7ryk.onrender.com`.
3. Commit and push your changes to GitHub.
4. In your GitHub repository, open **Settings > Pages** and set the source to **GitHub Actions**.
5. Push to the `main` branch.
6. The included workflow publishes the `client/` folder to GitHub Pages automatically.

Your site URL will look like this:

- `https://YOUR_GITHUB_USERNAME.github.io/YOUR_REPOSITORY_NAME/`

If your default branch is not `main`, update `.github/workflows/deploy-client.yml`.

## WebRTC signaling in this project

1. A user joins a room from the frontend.
2. The frontend connects to the Socket.IO server and sends `join-room`.
3. The server returns the list of people already in that room.
4. The new user creates a WebRTC offer for each existing user.
5. Existing users create answers and send them back through the server.
6. Both sides exchange ICE candidates through the server.
7. Once WebRTC finishes connecting, audio travels directly between browsers.

The Socket.IO server only handles signaling messages. The voice audio itself does not pass through the server after the peer connection is established.

## Troubleshooting audio

- If the room connects but you still cannot hear the other person, first press Play on the participant card in case autoplay was blocked by the browser.
- If calls only fail on some networks, add TURN server credentials. STUN-only setups often fail across stricter Wi-Fi or mobile networks because browsers cannot always reach each other directly.
