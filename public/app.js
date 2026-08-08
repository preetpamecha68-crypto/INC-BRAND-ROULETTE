const socket = io({
  transports: ["websocket"]
});

const $ = id =>
  document.getElementById(id);

let joined = false;
let room = null;
let playerId = null;

let offsetMs = 0;
let latencyMs = 0;


function setConnection(
  ok,
  text
) {

  $("connectionText")
    .textContent = text;

  document
    .querySelector(".status")
    .className =
      "status " +
      (ok ? "ok" : "bad");
}


function serverNow() {

  return Date.now() + offsetMs;

}


async function calibrateClock() {

  const samples = [];

  for (let i = 0; i < 8; i++) {

    const sent = Date.now();

    await new Promise(resolve => {

      socket.emit(
        "sync-ping",
        {
          clientSentMs: sent
        },

        response => {

          const received =
            Date.now();

          const rtt =
            received - sent;

          const midpoint =
            sent + rtt / 2;

          const offset =
            response.serverReceivedMs -
            midpoint;

          samples.push({
            rtt,
            offset
          });

          resolve();

        }
      );

    });

    await new Promise(
      resolve =>
        setTimeout(resolve, 40)
    );

  }


  samples.sort(
    (a, b) =>
      a.rtt - b.rtt
  );


  const best =
    samples.slice(0, 4);


  latencyMs =
    best.reduce(
      (sum, sample) =>
        sum + sample.rtt / 2,
      0
    ) / best.length;


  offsetMs =
    best.reduce(
      (sum, sample) =>
        sum + sample.offset,
      0
    ) / best.length;


  $("latency")
    .textContent =
      Math.round(latencyMs);


  socket.emit(
    "calibrate",
    {
      offsetMs,
      latencyMs
    }
  );

}


function renderRoom(data) {

  room = data;

  $("roundNumber")
    .textContent =
      data.roundNumber;

  $("roundState")
    .textContent =
      data.state.toUpperCase();


  $("players").innerHTML =
    data.players
      .sort(
        (a, b) =>
          (a.position ?? 999) -
          (b.position ?? 999)
      )
      .map(player => `
        <div class="player">

          <span>
            ${escapeHtml(player.name)}

            ${
              player.id === playerId
                ? "(YOU)"
                : ""
            }

          </span>

          <span class="pos">

            ${
              player.position
                ? "#" + player.position
                : player.connected
                  ? "READY"
                  : "OFFLINE"
            }

          </span>

        </div>
      `)
      .join("");


  const active =
    data.state === "active";


  $("buzzBtn").disabled =
    !active;

  $("startBtn").disabled =
    active;

}


function escapeHtml(value) {

  return value.replace(
    /[&<>"']/g,

    character => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[character])
  );

}


$("joinBtn").onclick =
  () => {

    const roomCode =
      $("roomCode")
        .value
        .trim();

    const name =
      $("playerName")
        .value
        .trim();


    socket.emit(
      "join-room",

      {
        roomCode,
        name
      },

      async response => {

        if (!response?.ok) {

          $("joinError")
            .textContent =
              response?.error ||
              "Could not join.";

          return;
        }


        joined = true;

        playerId =
          response.playerId;


        $("joinView")
          .classList
          .add("hidden");


        $("gameView")
          .classList
          .remove("hidden");


        renderRoom(
          response.room
        );


        await calibrateClock();

      }
    );

  };


$("buzzBtn").onclick =
  () => {

    if (!joined) {
      return;
    }


    $("buzzBtn")
      .disabled = true;


    socket.emit(
      "buzz",

      {
        clientTimestampMs:
          serverNow()
      },

      response => {

        if (!response?.ok) {

          $("result")
            .textContent =
              response?.error ||
              "Buzz rejected.";

        }

      }
    );

  };


$("startBtn").onclick =
  () => {

    socket.emit(
      "start-round"
    );

  };


$("nextBtn").onclick =
  () => {

    socket.emit(
      "next-round"
    );

  };


socket.on(
  "connect",
  () => {

    setConnection(
      true,
      "CONNECTED"
    );

  }
);


socket.on(
  "disconnect",
  () => {

    setConnection(
      false,
      "DISCONNECTED"
    );

  }
);


socket.on(
  "room-state",
  renderRoom
);


socket.on(
  "round-started",
  data => {

    $("roundState")
      .textContent =
        "ACTIVE";

    $("result")
      .innerHTML = "";

    $("buzzBtn")
      .disabled = false;

  }
);


socket.on(
  "new-round",
  data => {

    $("roundNumber")
      .textContent =
        data.roundNumber;

    $("roundState")
      .textContent =
        "WAITING";

    $("result")
      .innerHTML = "";

    $("buzzBtn")
      .disabled = true;

  }
);


socket.on(
  "buzz-result",
  data => {

    const winner =
      data.winner;


    $("roundState")
      .textContent =
        "LOCKED";


    $("result").innerHTML = `

      <div class="winner">
        🏆
        ${escapeHtml(
          winner.playerName
        )}
      </div>

      <div>
        Buzz #${winner.position}
        ·
        ${winner.latencyMs}ms latency
      </div>

    `;


    $("buzzBtn")
      .disabled = true;

  }
);


socket.on(
  "buzz-list",
  buzzes => {

    if (buzzes?.length) {

      $("roundState")
        .textContent =
          "LOCKED";

    }

  }
);


setInterval(
  () => {

    if (joined) {
      calibrateClock();
    }

  },
  30000
);
