const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();

const server = http.createServer(app);

const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 30000,
  maxHttpBufferSize: 1e6
});


app.use(
  express.static(
    path.join(__dirname, "public")
  )
);


/*
==================================================
ROOM STORAGE
==================================================
*/

const rooms = new Map();


function createRoom(code) {

  const room = {

    code,

    host: null,

    players: new Map(),

    buzzes: [],

    round: 1

  };

  rooms.set(code, room);

  return room;

}


function getRoom(code) {

  return rooms.get(code);

}


function generateCode() {

  let code;

  do {

    code =
      Math.floor(
        100000 +
        Math.random() * 900000
      ).toString();

  } while (rooms.has(code));

  return code;

}



/*
==================================================
CLEAN NAME
==================================================
*/

function cleanName(name) {

  return String(name || "")
    .trim()
    .slice(0, 30)
    .replace(/[<>]/g, "");

}



/*
==================================================
SOCKET CONNECTION
==================================================
*/

io.on(
  "connection",
  socket => {


    /*
    ==============================================
    CREATE HOST
    ==============================================
    */

    socket.on(
      "host:create",
      (_, callback) => {

        const code =
          generateCode();

        const room =
          createRoom(code);


        room.host = socket.id;


        socket.join(code);

        socket.data.room = code;

        socket.data.role = "host";


        callback({
          ok: true,
          code
        });


        sendState(room);

      }
    );



    /*
    ==============================================
    PLAYER JOIN
    ==============================================
    */

    socket.on(
      "player:join",
      ({ code, name }, callback) => {

        code =
          String(code || "")
            .trim();


        name =
          cleanName(name);


        const room =
          getRoom(code);


        if (!room) {

          return callback({
            ok: false,
            error: "Room not found."
          });

        }


        if (!room.host) {

          return callback({
            ok: false,
            error: "Host is not connected."
          });

        }


        if (room.players.size >= 100) {

          return callback({
            ok: false,
            error:
              "Room is full (100 players maximum)."
          });

        }


        if (!name) {

          return callback({
            ok: false,
            error:
              "Please enter your name."
          });

        }


        /*
          Prevent duplicate names.
        */

        const duplicate =
          [...room.players.values()]
            .some(
              player =>
                player.name.toLowerCase() ===
                name.toLowerCase()
            );


        if (duplicate) {

          return callback({
            ok: false,
            error:
              "That name is already in use."
          });

        }


        const player = {

          id: socket.id,

          name,

          connected: true,

          buzzed: false

        };


        room.players.set(
          socket.id,
          player
        );


        socket.join(code);


        socket.data.room = code;

        socket.data.role = "player";

        socket.data.playerName = name;


        callback({
          ok: true,
          name
        });


        sendState(room);

      }
    );



    /*
    ==============================================
    PLAYER RECONNECT AFTER RELOAD
    ==============================================
    */

    socket.on(
      "player:reconnect",
      ({ code, name }, callback) => {

        code =
          String(code || "")
            .trim();


        name =
          cleanName(name);


        const room =
          getRoom(code);


        if (!room) {

          return callback({
            ok: false,
            error: "Room not found."
          });

        }


        /*
          Find the player by name.
        */

        let existingPlayer = null;


        for (
          const player
          of room.players.values()
        ) {

          if (
            player.name.toLowerCase() ===
            name.toLowerCase()
          ) {

            existingPlayer = player;

            break;

          }

        }


        if (!existingPlayer) {

          return callback({
            ok: false,
            error:
              "Your previous session was not found."
          });

        }


        /*
          IMPORTANT:

          Replace the old socket ID
          with the new socket ID.

          This means refreshing the page
          does NOT create a new player.
        */

        const oldId =
          existingPlayer.id;


        room.players.delete(
          oldId
        );


        existingPlayer.id =
          socket.id;


        existingPlayer.connected =
          true;


        room.players.set(
          socket.id,
          existingPlayer
        );


        /*
          Update any existing buzz
          belonging to this player.
        */

        room.buzzes.forEach(
          buzz => {

            if (
              buzz.id === oldId
            ) {

              buzz.id =
                socket.id;

            }

          }
        );


        socket.join(code);


        socket.data.room = code;

        socket.data.role = "player";

        socket.data.playerName =
          existingPlayer.name;


        callback({
          ok: true,
          name: existingPlayer.name
        });


        sendState(room);

      }
    );



    /*
    ==============================================
    BUZZ
    ==============================================
    */

    socket.on(
      "buzz",
      (_, callback) => {

        const code =
          socket.data.room;


        const room =
          getRoom(code);


        if (
          !room ||
          socket.data.role !== "player"
        ) {

          return callback({
            ok: false,
            error:
              "You are not in a room."
          });

        }


        const player =
          room.players.get(
            socket.id
          );


        if (!player) {

          return callback({
            ok: false,
            error:
              "Player session not found."
          });

        }


        /*
          Only ONE buzz per player
          per round.
        */

        if (player.buzzed) {

          return callback({
            ok: false,
            error:
              "You already buzzed this round."
          });

        }


        player.buzzed = true;


        const buzz = {

          id: socket.id,

          name: player.name,

          rank:
            room.buzzes.length + 1,

          round:
            room.round,

          time: Date.now()

        };


        room.buzzes.push(
          buzz
        );


        callback({

          ok: true,

          rank: buzz.rank

        });


        sendState(room);

      }
    );



    /*
    ==============================================
    NEW ROUND
    ==============================================
    */

    socket.on(
      "host:newRound",
      () => {

        const code =
          socket.data.room;


        const room =
          getRoom(code);


        if (
          !room ||
          socket.data.role !== "host" ||
          room.host !== socket.id
        ) {

          return;

        }


        room.round++;

        room.buzzes = [];


        /*
          Reset everyone's buzz state.
        */

        room.players.forEach(
          player => {

            player.buzzed = false;

          }
        );


        sendState(room);

      }
    );



    /*
    ==============================================
    LEAVE ROOM
    ==============================================
    */

    socket.on(
      "leaveRoom",
      (_, callback) => {

        const code =
          socket.data.room;


        const room =
          getRoom(code);


        if (!room) {

          if (callback)
            callback({ ok: true });

          return;

        }


        /*
          HOST LEAVING
        */

        if (
          socket.data.role === "host" &&
          room.host === socket.id
        ) {

          room.host = null;


          io.to(code).emit(
            "hostGone"
          );

        }


        /*
          PLAYER LEAVING
        */

        if (
          socket.data.role === "player"
        ) {

          room.players.delete(
            socket.id
          );


          /*
            Remove their buzz too.
          */

          room.buzzes =
            room.buzzes.filter(
              buzz =>
                buzz.id !== socket.id
            );


          /*
            Recalculate ranks.
          */

          room.buzzes.forEach(
            (buzz, index) => {

              buzz.rank =
                index + 1;

            }
          );

        }


        socket.leave(code);


        socket.data.room = null;

        socket.data.role = null;


        sendState(room);


        if (callback)
          callback({ ok: true });


        /*
          Delete empty rooms.
        */

        if (
          !room.host &&
          room.players.size === 0
        ) {

          rooms.delete(code);

        }

      }
    );



    /*
    ==============================================
    DISCONNECT
    ==============================================
    */

    socket.on(
      "disconnect",
      () => {

        const code =
          socket.data.room;


        const room =
          getRoom(code);


        if (!room) return;


        /*
          HOST DISCONNECT

          DO NOT DELETE ROOM.

          This is important because
          Render/browser connections can
          temporarily disappear.
        */

        if (
          socket.data.role === "host" &&
          room.host === socket.id
        ) {

          room.host = null;


          io.to(code).emit(
            "hostGone"
          );

        }


        /*
          PLAYER DISCONNECT

          DO NOT DELETE PLAYER.

          This allows reload/reconnect.
        */

        if (
          socket.data.role === "player"
        ) {

          const player =
            room.players.get(
              socket.id
            );


          if (player) {

            player.connected =
              false;

          }

        }


        sendState(room);

      }
    );

  }
);



/*
==================================================
STATE
==================================================
*/

function sendState(room) {

  if (!room) return;


  const buzzes =
    room.buzzes.map(
      buzz => ({
        id: buzz.id,

        name: buzz.name,

        rank: buzz.rank,

        round: buzz.round,

        time: buzz.time
      })
    );


  /*
    Send a personalized state
    to each socket.

    This lets a player know
    their own buzz even after reload.
  */

  room.players.forEach(
    player => {

      if (!player.connected)
        return;


      const playerSocket =
        io.sockets.sockets.get(
          player.id
        );


      if (!playerSocket)
        return;


      const myBuzz =
        room.buzzes.find(
          buzz =>
            buzz.id === player.id
        );


      playerSocket.emit(
        "state",
        {

          players:
            [...room.players.values()]
              .filter(
                p => p.connected
              )
              .map(
                p => ({
                  id: p.id,
                  name: p.name
                })
              ),

          buzzes,

          myBuzz:
            myBuzz || null,

          round:
            room.round

        }
      );

    }
  );


  /*
    Send host state.
  */

  if (room.host) {

    const hostSocket =
      io.sockets.sockets.get(
        room.host
      );


    if (hostSocket) {

      hostSocket.emit(
        "state",
        {

          players:
            [...room.players.values()]
              .filter(
                p => p.connected
              )
              .map(
                p => ({
                  id: p.id,
                  name: p.name
                })
              ),

          buzzes,

          round:
            room.round

        }
      );

    }

  }

}



/*
==================================================
SERVER
==================================================
*/

const PORT =
  process.env.PORT || 3000;


server.listen(
  PORT,
  () => {

    console.log(
      `INC Brand Roulette running on port ${PORT}`
    );

  }
);
