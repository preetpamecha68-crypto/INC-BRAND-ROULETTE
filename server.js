const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();

const server =
  http.createServer(app);

const io =
  new Server(server, {

    pingInterval: 10000,

    pingTimeout: 30000,

    maxHttpBufferSize: 1e6

  });


app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);


/* ==========================================
   ROOMS
========================================== */

const rooms =
  new Map();


function generateCode() {

  let code;


  do {

    code =
      Math.floor(
        100000 +
        Math.random() * 900000
      ).toString();

  }
  while (
    rooms.has(code)
  );


  return code;

}


function cleanName(name) {

  return String(
    name || ""
  )
    .trim()
    .slice(0, 30)
    .replace(
      /[<>]/g,
      ""
    );

}


/* ==========================================
   SOCKET CONNECTION
========================================== */

io.on(
  "connection",
  socket => {


    /* ======================================
       CREATE HOST ROOM
    ====================================== */

    socket.on(
      "host:create",
      (_, callback) => {

        const code =
          generateCode();


        const room = {

          code,

          host: socket.id,

          players:
            new Map(),

          buzzes: [],

          round: 1

        };


        rooms.set(
          code,
          room
        );


        socket.join(
          code
        );


        socket.data.room =
          code;

        socket.data.role =
          "host";


        callback({

          ok: true,

          code

        });


        sendState(
          room
        );

      }
    );



    /* ======================================
       PLAYER JOIN
    ====================================== */

    socket.on(
      "player:join",
      (
        { code, name },
        callback
      ) => {

        code =
          String(
            code || ""
          ).trim();


        name =
          cleanName(
            name
          );


        const room =
          rooms.get(
            code
          );


        if (!room) {

          return callback({

            ok: false,

            error:
              "Room not found."

          });

        }


        if (!room.host) {

          return callback({

            ok: false,

            error:
              "Host is reconnecting. Please try again in a few seconds."

          });

        }


        if (
          room.players.size >= 100
        ) {

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


        const duplicate =
          [...room.players.values()]
            .some(
              player =>
                player.name
                  .toLowerCase() ===
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

          id:
            socket.id,

          name,

          connected:
            true,

          buzzed:
            false

        };


        room.players.set(
          socket.id,
          player
        );


        socket.join(
          code
        );


        socket.data.room =
          code;

        socket.data.role =
          "player";

        socket.data.playerName =
          name;


        callback({

          ok: true,

          name

        });


        sendState(
          room
        );

      }
    );



    /* ======================================
       PLAYER RECONNECT
    ====================================== */

    socket.on(
      "player:reconnect",
      (
        { code, name },
        callback
      ) => {

        code =
          String(
            code || ""
          ).trim();


        name =
          cleanName(
            name
          );


        const room =
          rooms.get(
            code
          );


        if (!room) {

          return callback({

            ok: false,

            error:
              "Room not found."

          });

        }


        let player =
          null;


        let oldId =
          null;


        for (
          const [
            id,
            existing
          ]
          of room.players
        ) {

          if (
            existing.name
              .toLowerCase() ===
            name.toLowerCase()
          ) {

            player =
              existing;

            oldId =
              id;

            break;

          }

        }


        if (!player) {

          return callback({

            ok: false,

            error:
              "Previous player session not found."

          });

        }


        room.players.delete(
          oldId
        );


        player.id =
          socket.id;


        player.connected =
          true;


        room.players.set(
          socket.id,
          player
        );


        /*
          IMPORTANT:

          Move their existing buzz
          to the new socket ID.
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


        socket.join(
          code
        );


        socket.data.room =
          code;

        socket.data.role =
          "player";

        socket.data.playerName =
          player.name;


        callback({

          ok: true,

          name:
            player.name

        });


        sendState(
          room
        );

      }
    );



    /* ======================================
       BUZZ
    ====================================== */

    socket.on(
      "buzz",
      (_, callback) => {

        const code =
          socket.data.room;


        const room =
          rooms.get(
            code
          );


        if (
          !room ||
          socket.data.role !==
            "player"
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
          ONE BUZZ PER ROUND.
        */

        if (
          player.buzzed
        ) {

          return callback({

            ok: false,

            error:
              "You already buzzed this round."

          });

        }


        player.buzzed =
          true;


        const buzz = {

          id:
            socket.id,

          name:
            player.name,

          rank:
            room.buzzes.length + 1,

          round:
            room.round,

          time:
            Date.now()

        };


        room.buzzes.push(
          buzz
        );


        callback({

          ok: true,

          rank:
            buzz.rank

        });


        sendState(
          room
        );

      }
    );



    /* ======================================
       NEW ROUND
    ====================================== */

    socket.on(
      "host:newRound",
      () => {

        const code =
          socket.data.room;


        const room =
          rooms.get(
            code
          );


        if (
          !room ||
          socket.data.role !==
            "host" ||
          room.host !==
            socket.id
        ) {

          return;

        }


        room.round++;


        room.buzzes =
          [];


        room.players.forEach(
          player => {

            player.buzzed =
              false;

          }
        );


        sendState(
          room
        );

      }
    );



    /* ======================================
       LEAVE ROOM
    ====================================== */

    socket.on(
      "leaveRoom",
      (_, callback) => {

        const code =
          socket.data.room;


        const room =
          rooms.get(
            code
          );


        if (!room) {

          if (callback)
            callback({
              ok: true
            });

          return;

        }


        /*
          HOST LEAVES
        */

        if (
          socket.data.role ===
            "host" &&
          room.host ===
            socket.id
        ) {

          room.host =
            null;


          io.to(code).emit(
            "hostGone"
          );

        }


        /*
          PLAYER LEAVES
        */

        if (
          socket.data.role ===
            "player"
        ) {

          room.players.delete(
            socket.id
          );


          room.buzzes =
            room.buzzes.filter(
              buzz =>
                buzz.id !==
                socket.id
            );


          room.buzzes.forEach(
            (buzz, index) => {

              buzz.rank =
                index + 1;

            }
          );

        }


        socket.leave(
          code
        );


        socket.data.room =
          null;

        socket.data.role =
          null;


        sendState(
          room
        );


        if (callback)
          callback({
            ok: true
          });


        /*
          Only delete completely
          empty rooms.
        */

        if (
          !room.host &&
          room.players.size === 0
        ) {

          rooms.delete(
            code
          );

        }

      }
    );



    /* ======================================
       DISCONNECT
    ====================================== */

    socket.on(
      "disconnect",
      () => {

        const code =
          socket.data.room;


        const room =
          rooms.get(
            code
          );


        if (!room)
          return;


        /*
          IMPORTANT:

          DO NOT DELETE HOST.

          A reload temporarily disconnects
          the socket.
        */

        if (
          socket.data.role ===
            "host" &&
          room.host ===
            socket.id
        ) {

          room.host =
            null;


          io.to(code).emit(
            "hostGone"
          );

        }


        /*
          IMPORTANT:

          DO NOT DELETE PLAYERS.

          They can reconnect after reload.
        */

        if (
          socket.data.role ===
            "player"
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


        sendState(
          room
        );

      }
    );

  }
);



/* ==========================================
   SEND STATE
========================================== */

function sendState(
  room
) {

  if (!room)
    return;


  const buzzes =
    room.buzzes.map(
      buzz => ({

        id:
          buzz.id,

        name:
          buzz.name,

        rank:
          buzz.rank,

        round:
          buzz.round,

        time:
          buzz.time

      })
    );


  /*
    HOST
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
                p =>
                  p.connected
              )
              .map(
                p => ({

                  id:
                    p.id,

                  name:
                    p.name

                })
              ),

          buzzes,

          round:
            room.round

        }
      );

    }

  }


  /*
    PLAYERS
  */

  room.players.forEach(
    player => {

      if (
        !player.connected
      )
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
            buzz.id ===
            player.id
        );


      playerSocket.emit(
        "state",
        {

          players:
            [...room.players.values()]
              .filter(
                p =>
                  p.connected
              )
              .map(
                p => ({

                  id:
                    p.id,

                  name:
                    p.name

                })
              ),

          buzzes,

          myBuzz:
            myBuzz ||
            null,

          round:
            room.round

        }
      );

    }
  );

}



/* ==========================================
   SERVER
========================================== */

const PORT =
  process.env.PORT ||
  3000;


server.listen(
  PORT,
  () => {

    console.log(
      `INC Brand Roulette running on port ${PORT}`
    );

  }
);
