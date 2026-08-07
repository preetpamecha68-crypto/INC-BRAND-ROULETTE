const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

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
      round: 0
    });
  }

  return rooms.get(code);
}


/* =========================
   CONNECTION
========================= */

io.on("connection", socket => {


  /* =========================
     CREATE HOST ROOM
  ========================= */

  socket.on("host:create", (_, callback) => {

    let code;

    do {
      code = Math.floor(
        100000 + Math.random() * 900000
      ).toString();

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


    io.to(code).emit(
      "state",
      snapshot(room)
    );

  });



  /* =========================
     HOST JOIN
  ========================= */

  socket.on("host:join", ({ code }, callback) => {

    code = String(code || "").trim();

    const room = rooms.get(code);


    if (!room) {

      return callback({
        ok: false,
        error: "Room not found"
      });

    }


    if (room.host !== null) {

      return callback({
        ok: false,
        error: "This room already has a host"
      });

    }


    room.host = socket.id;

    socket.join(code);

    socket.data.room = code;
    socket.data.host = true;


    callback({
      ok: true,
      code
    });


    io.to(code).emit(
      "state",
      snapshot(room)
    );

  });



  /* =========================
     PLAYER JOIN
  ========================= */

  socket.on(
    "player:join",
    ({ code, name }, callback) => {

      code = String(code || "").trim();

      name = cleanName(name);

      const room = rooms.get(code);


      if (!room || !room.host) {

        return callback({
          ok: false,
          error: "Room not found"
        });

      }


      if (room.players.size >= 100) {

        return callback({
          ok: false,
          error: "Room is full (100 players maximum)"
        });

      }


      if (!name) {

        return callback({
          ok: false,
          error: "Please enter your name"
        });

      }


      /*
        Prevent duplicate names.
      */

      const duplicate = [
        ...room.players.values()
      ].some(
        existing =>
          existing.toLowerCase() ===
          name.toLowerCase()
      );


      if (duplicate) {

        return callback({
          ok: false,
          error: "That name is already taken"
        });

      }


      socket.join(code);

      socket.data.room = code;
      socket.data.player = true;
      socket.data.name = name;


      room.players.set(
        socket.id,
        name
      );


      callback({
        ok: true,
        name
      });


      io.to(code).emit(
        "state",
        snapshot(room)
      );

    }
  );



  /* =========================
     PLAYER BUZZ
  ========================= */

  socket.on("buzz", (_, callback) => {

    const code = socket.data.room;

    const room = rooms.get(code);


    /*
      Make sure this is actually
      a player in a valid room.
    */

    if (
      !room ||
      !socket.data.player ||
      !room.players.has(socket.id)
    ) {

      if (callback) {
        callback({
          ok: false,
          error: "Not allowed"
        });
      }

      return;
    }


    /*
      IMPORTANT:
      A player can buzz only ONCE
      per round.
    */

    const alreadyBuzzed =
      room.buzzes.some(
        buzz => buzz.id === socket.id
      );


    if (alreadyBuzzed) {

      if (callback) {
        callback({
          ok: false,
          error: "You already buzzed"
        });
      }

      return;
    }


    /*
      Add player to the sequence.

      The order in this array is the
      exact order the server received
      the buzzes.
    */

    const buzz = {

      id: socket.id,

      name: room.players.get(
        socket.id
      ),

      rank: room.buzzes.length + 1,

      time: Date.now()

    };


    room.buzzes.push(buzz);


    /*
      Send the new sequence
      immediately to EVERYONE.
    */

    io.to(code).emit(
      "state",
      snapshot(room)
    );


    if (callback) {

      callback({
        ok: true,
        rank: buzz.rank
      });

    }

  });



  /* =========================
     NEW ROUND
  ========================= */

  socket.on(
    "host:newRound",
    () => {

      const code = socket.data.room;

      const room = rooms.get(code);


      if (
        !room ||
        !socket.data.host ||
        room.host !== socket.id
      ) {
        return;
      }


      /*
        Clear the buzz sequence.
        Everyone can buzz again.
      */

      room.buzzes = [];

      room.round++;


      io.to(code).emit(
        "state",
        snapshot(room)
      );

    }
  );



  /* =========================
     CLEAR PLAYERS
  ========================= */

  socket.on(
    "host:clear",
    () => {

      const code = socket.data.room;

      const room = rooms.get(code);


      if (
        !room ||
        !socket.data.host ||
        room.host !== socket.id
      ) {
        return;
      }


      room.players.clear();

      room.buzzes = [];

      room.round++;


      io.to(code).emit(
        "state",
        snapshot(room)
      );

    }
  );



  /* =========================
     DISCONNECT
  ========================= */

  socket.on("disconnect", () => {

    const code = socket.data.room;

    const room = rooms.get(code);


    if (!room) {
      return;
    }


    /*
      Host disconnected.
    */

    if (
      socket.data.host &&
      room.host === socket.id
    ) {

      room.host = null;

      io.to(code).emit(
        "hostGone"
      );

    }


    /*
      Player disconnected.
    */

    if (socket.data.player) {

      room.players.delete(
        socket.id
      );

      /*
        If they already buzzed,
        keep their buzz in the sequence.
        This is important!
      */

    }


    io.to(code).emit(
      "state",
      snapshot(room)
    );


    /*
      Delete completely empty rooms.
    */

    if (
      room.host === null &&
      room.players.size === 0
    ) {

      rooms.delete(code);

    }

  });

});



/* =========================
   SEND ROOM STATE
========================= */

function snapshot(room) {

  return {

    players: [
      ...room.players.entries()
    ].map(
      ([id, name]) => ({
        id,
        name
      })
    ),


    buzzes: room.buzzes.map(
      buzz => ({
        id: buzz.id,
        name: buzz.name,
        rank: buzz.rank,
        time: buzz.time
      })
    ),


    round: room.round

  };

}



/* =========================
   START SERVER
========================= */

const PORT =
  process.env.PORT || 3000;


server.listen(
  PORT,
  () => {

    console.log(
      `Brand Roulette running on port ${PORT}`
    );

  }
);
