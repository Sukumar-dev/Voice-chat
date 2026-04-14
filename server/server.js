const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const allowedOrigins = process.env.CLIENT_ORIGIN
  ? process.env.CLIENT_ORIGIN
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  : "*";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  }
});

const socketToRoom = new Map();

app.get("/", (_request, response) => {
  response.json({
    name: "voice-chat-signaling-server",
    status: "running"
  });
});

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

function emitRoomUserCount(roomId) {
  const count = io.sockets.adapter.rooms.get(roomId)?.size || 0;
  io.to(roomId).emit("room-users", count);
}

function leaveCurrentRoom(socket) {
  const roomId = socketToRoom.get(socket.id);

  if (!roomId) {
    return;
  }

  socket.leave(roomId);
  socketToRoom.delete(socket.id);
  socket.to(roomId).emit("user-left", { userId: socket.id });
  emitRoomUserCount(roomId);
}

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on("join-room", ({ roomId }) => {
    const trimmedRoomId = String(roomId || "").trim();

    if (!trimmedRoomId) {
      socket.emit("room-error", "Room name is required.");
      return;
    }

    if (socketToRoom.has(socket.id)) {
      leaveCurrentRoom(socket);
    }

    const roomMembers = io.sockets.adapter.rooms.get(trimmedRoomId);
    const existingUsers = roomMembers ? [...roomMembers] : [];

    socket.join(trimmedRoomId);
    socketToRoom.set(socket.id, trimmedRoomId);

    socket.emit("existing-users", existingUsers);
    socket.to(trimmedRoomId).emit("user-joined", { userId: socket.id });
    emitRoomUserCount(trimmedRoomId);

    console.log(`User ${socket.id} joined room: ${trimmedRoomId}`);
  });

  socket.on("offer", ({ to, offer }) => {
    io.to(to).emit("offer", { from: socket.id, offer });
  });

  socket.on("answer", ({ to, answer }) => {
    io.to(to).emit("answer", { from: socket.id, answer });
  });

  socket.on("ice-candidate", ({ to, candidate }) => {
    io.to(to).emit("ice-candidate", { from: socket.id, candidate });
  });

  socket.on("leave-room", () => {
    leaveCurrentRoom(socket);
  });

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
    console.log(`User disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server listening on http://localhost:${PORT}`);
});
