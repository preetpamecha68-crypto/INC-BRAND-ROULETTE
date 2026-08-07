const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the website
app.use(express.static(path.join(__dirname, "public")));

// Store all active rooms
const rooms = new Map();

function cleanName(name) {
  return String(name || "")
    .trim()
    .slice(0, 30)
    .replace(/[<>]/g, "");
}

function getRoom(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      host: null,
      players: new Map(),
      buzzes: [],
      round: 0,
      locked: false
    });
  }

  return rooms.get(code);
}

function roomSnapshot(room) {
  return {
    players: [...room.players.entries()].map(([id, name]) => ({
      id,
      name
    })),

    buzzes: room.buzzes.map((buzz, index) => ({
      rank: index + 1,
      name: buzz.name,
      time: buzz.time
    })),

    locked: room.locked,
    round: room.round
  };
}

io.on("connection", (socket) => {

  // =========================
  // HOST CREATES A ROOM
  // =========================

  socket.on("host:create", (_, callback) => {

    let code;

    do {
      code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (rooms.has(code));

    const room = getRoom(code);

    room.host = socket.id;

    socket.join(code);

    socket.data.room = code;
    socket.data.host = true;

    callback({
      ok: true,
      code
    });

    io.to(code).emit("state", roomSnapshot(room));
  });


  // =========================
  // PLAYER JOINS
  // =========================

  socket.on("player:join", ({ code, name }, callback) => {

    code = String(code || "").trim();
    name = cleanName(name);

    const room = rooms.get(code);

    if (!room || !room.host) {
      return callback({
        ok: false,
        error: "Room not found. Check the room code."
      });
    }

    if (room.players.size >= 100) {
      return callback({
        ok: false,
        error: "This room is full."
      });
    }

    if (!name) {
      return callback({
        ok: false,
        error: "Please enter your name."
      });
    }

    socket.join(code);

    socket.data.room = code;
    socket.data.player = true;
    socket.data.name = name;

    room.players.set(socket.id, name);

    callback({
      ok: true,
      name
    });

    io.to(code).emit("state", roomSnapshot(room));
  });


  // =========================
  // PLAYER BUZZES
  // =========================

  socket.on("buzz", (_, callback) => {

    const code = socket.data.room;
    const room = rooms.get(code);

    if (
      !room ||
      !socket.data.player ||
      room.locked
    ) {
      if (callback) {
        callback({
          ok: false
        });
      }

      return;
    }

    const playerName = room.players.get(socket.id);

    if (!playerName) {
      return;
    }

    const buzz = {
      id: socket.id,
      name: playerName,
      time: Date.now()
    };

    // Record the buzz
    room.buzzes.push(buzz);

    // LOCK IMMEDIATELY
    room.locked = true;

    // Tell everyone
    io.to(code).emit(
      "state",
      roomSnapshot(room)
    );

    if (callback) {
      callback({
        ok: true
      });
    }
  });


  // =========================
  // HOST STARTS NEW ROUND
  // =========================

  socket.on("host:newRound", () => {

    const code = socket.data.room;
    const room = rooms.get(code);

    if (
      !room ||
      !socket.data.host
    ) {
      return;
    }

    room.buzzes = [];
    room.locked = false;
    room.round++;

    io.to(code).emit(
      "state",
      roomSnapshot(room)
    );
  });


  // =========================
  // HOST CLEARS PLAYERS
  // =========================

  socket.on("host:clear", () => {

    const code = socket.data.room;
    const room = rooms.get(code);

    if (
      !room ||
      !socket.data.host
    ) {
      return;
    }

    room.players.clear();
    room.buzzes = [];
    room.locked = false;
    room.round++;

    io.to(code).emit(
      "state",
      roomSnapshot(room)
    );
  });


  // =========================
  // PLAYER / HOST DISCONNECT
  // =========================

  socket.on("disconnect", () => {

    const code = socket.data.room;
    const room = rooms.get(code);

    if (!room) {
      return;
    }

    // Host disconnected
    if (socket.data.host) {

      room.host = null;

      io.to(code).emit("hostGone");
    }

    // Player disconnected
    if (socket.data.player) {

      room.players.delete(socket.id);

      io.to(code).emit(
        "state",
        roomSnapshot(room)
      );
    }
  });

});


// =========================
// START SERVER
// =========================

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(
    `Brand Roulette server running on port ${PORT}`
  );
});
