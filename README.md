# Real-Time Voice Chat

A beginner-friendly real-time voice chat app built with plain HTML, CSS, JavaScript, WebRTC, Node.js, and Socket.IO.

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
- This demo uses a public STUN server only. For stronger real-world reliability, add a TURN server later.

## Run locally

1. Install backend dependencies:

   ```bash
   cd server
   npm install
   npm run dev
   ```

2. Start a simple static server for the frontend in a second terminal:

   ```bash
   cd client
   python3 -m http.server 5500
   ```

3. Open [http://127.0.0.1:5500](http://127.0.0.1:5500) in two browser tabs or on two devices.
4. Join the same room name in both tabs.
5. Allow microphone access when the browser asks.

Note: opening `index.html` directly with `file://` is not recommended because microphone access works best on `localhost` or HTTPS.

## Deploy the backend

These steps use Render, but Railway or similar hosts also work.

1. Create a new GitHub repository and push this project.
2. Create a new **Web Service** on Render.
3. Point Render to your GitHub repository.
4. Set the **Root Directory** to `server`.
5. Use:

   - Build command: `npm install`
   - Start command: `npm start`

6. Add this environment variable on Render:

   - `CLIENT_ORIGIN=https://YOUR_GITHUB_USERNAME.github.io,http://127.0.0.1:5500,http://localhost:5500`

7. Deploy the service and copy the Render URL, for example:

   - `https://voice-chat-7ryk.onrender.com`

## Deploy the frontend with GitHub Pages

1. Open `client/script.js`.
2. Replace the backend URL with `https://voice-chat-7ryk.onrender.com`.
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
