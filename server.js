import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import pg from "pg";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  transports: ["websocket"],
  pingInterval: 5000,
  pingTimeout: 10000
});

const PORT = Number(process.env.PORT || 10000);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

function nowMs() {
  return Date.now();
}

function getRoom(roomCode) {
  return rooms.get(roomCode);
}

async function db(query, params = []) {
  return pool.query(query, params);
}

async function ensureSchema() {
  await db(`
    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      code VARCHAR(10) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      socket_id TEXT,
      name TEXT NOT NULL,
      connected BOOLEAN NOT NULL DEFAULT TRUE,
      client_offset_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
      latency_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
      position INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rounds (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      round_number INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'waiting',
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS buzzes (
      id SERIAL PRIMARY KEY,
      round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      client_timestamp_ms BIGINT NOT NULL,
      server_received_ms BIGINT NOT NULL,
      calibrated_server_ms BIGINT NOT NULL,
      latency_ms DOUBLE PRECISION NOT NULL DEFAULT 0,
      position INTEGER,
      accepted BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS buzzes_round_idx
      ON buzzes(round_id);

    CREATE INDEX IF NOT EXISTS players_room_idx
      ON players(room_id);
  `);
}

async function getOrCreateRoom(code) {
  const existing = await db(
    "SELECT * FROM rooms WHERE code = $1",
    [code]
  );

  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const inserted = await db(
    "INSERT INTO rooms(code) VALUES($1) RETURNING *",
    [code]
  );

  return inserted.rows[0];
}

async function createRound(room) {
  const next = room.roundNumber + 1;

  const result = await db(
    `
    INSERT INTO rounds(room_id, round_number, state)
    VALUES($1, $2, 'waiting')
    RETURNING *
    `,
    [room.dbId, next]
  );

  room.roundNumber = next;
  room.roundId = result.rows[0].id;
  room.state = "waiting";
  room.buzzes = [];

  return result.rows[0];
}

function publicRoom(room) {
  return {
    code: room.code,
    state: room.state,
    roundNumber: room.roundNumber,
    roundId: room.roundId,

    players: [...room.players.values()].map(player => ({
      id: player.playerId,
      name: player.name,
      connected: player.connected,
      latencyMs: Math.round(player.latencyMs),
      position: player.position
    }))
  };
}

io.on("connection", socket => {
  socket.data.roomCode = null;
  socket.data.playerId = null;

  socket.on("join-room", async ({ roomCode, name }, ack) => {
    try {
      if (!roomCode || !name?.trim()) {
        return ack?.({
          ok: false,
          error: "Room code and name are required."
        });
      }

      roomCode = roomCode.trim().toUpperCase();
      name = name.trim().slice(0, 40);

      let room = getRoom(roomCode);

      if (!room) {
        const dbRoom = await getOrCreateRoom(roomCode);

        room = {
          code: roomCode,
          dbId: dbRoom.id,
          roundId: null,
          roundNumber: 0,
          state: "waiting",
          buzzes: [],
          players: new Map()
        };

        rooms.set(roomCode, room);

        await createRound(room);
      }

      const result = await db(
        `
        INSERT INTO players(room_id, socket_id, name)
        VALUES($1, $2, $3)
        RETURNING *
        `,
        [room.dbId, socket.id, name]
      );

      const row = result.rows[0];

      const player = {
        playerId: row.id,
        name,
        socketId: socket.id,
        connected: true,
        offsetMs: 0,
        latencyMs: 0,
        position: null,
        lastBuzzRound: null
      };

      room.players.set(socket.id, player);

      socket.data.roomCode = roomCode;
      socket.data.playerId = row.id;

      socket.join(roomCode);

      ack?.({
        ok: true,
        playerId: row.id,
        room: publicRoom(room),
        serverTimeMs: nowMs()
      });

      io.to(roomCode).emit(
        "room-state",
        publicRoom(room)
      );

    } catch (error) {
      console.error(error);

      ack?.({
        ok: false,
        error: "Could not join room."
      });
    }
  });

  socket.on("sync-ping", ({ clientSentMs }, ack) => {
    const serverReceivedMs = nowMs();

    ack?.({
      clientSentMs,
      serverReceivedMs,
      serverSentMs: nowMs()
    });
  });

  socket.on("calibrate", async ({ offsetMs, latencyMs }, ack) => {
    const room = getRoom(socket.data.roomCode);
    const player = room?.players.get(socket.id);

    if (!player) {
      return ack?.({ ok: false });
    }

    player.offsetMs = Number(offsetMs) || 0;

    player.latencyMs = Math.max(
      0,
      Number(latencyMs) || 0
    );

    await db(
      `
      UPDATE players
      SET client_offset_ms=$1,
          latency_ms=$2
      WHERE id=$3
      `,
      [
        player.offsetMs,
        player.latencyMs,
        player.playerId
      ]
    );

    ack?.({ ok: true });
  });

  socket.on("start-round", async ack => {
    const room = getRoom(socket.data.roomCode);

    if (!room) {
      return ack?.({
        ok: false,
        error: "Room not found."
      });
    }

    if (room.state === "active") {
      return ack?.({
        ok: false,
        error: "Round already active."
      });
    }

    await db(
      `
      UPDATE rounds
      SET state='active',
          started_at=NOW()
      WHERE id=$1
      `,
      [room.roundId]
    );

    room.state = "active";
    room.buzzes = [];

    io.to(room.code).emit(
      "round-started",
      {
        roundId: room.roundId,
        roundNumber: room.roundNumber,
        serverStartMs: nowMs()
      }
    );

    io.to(room.code).emit(
      "room-state",
      publicRoom(room)
    );

    ack?.({ ok: true });
  });

  socket.on("buzz", async ({ clientTimestampMs }, ack) => {
    try {
      const room = getRoom(socket.data.roomCode);
      const player = room?.players.get(socket.id);

      if (!room || !player) {
        return ack?.({
          ok: false,
          error: "Not in a room."
        });
      }

      if (room.state !== "active") {
        return ack?.({
          ok: false,
          error: "Round is not active."
        });
      }

      if (player.lastBuzzRound === room.roundId) {
        return ack?.({
          ok: false,
          error: "Duplicate buzz."
        });
      }

      const serverReceivedMs = nowMs();
      const clientMs = Number(clientTimestampMs);

      if (!Number.isFinite(clientMs)) {
        return ack?.({
          ok: false,
          error: "Invalid timestamp."
        });
      }

      const calibratedServerMs =
        Math.round(clientMs + player.offsetMs);

      if (
        calibratedServerMs >
        serverReceivedMs + 250
      ) {
        return ack?.({
          ok: false,
          error: "Invalid future timestamp."
        });
      }

      const position =
        room.buzzes.length + 1;

      const insert = await db(
        `
        INSERT INTO buzzes(
          round_id,
          player_id,
          client_timestamp_ms,
          server_received_ms,
          calibrated_server_ms,
          latency_ms,
          position,
          accepted
        )
        VALUES(
          $1,$2,$3,$4,$5,$6,$7,TRUE
        )
        RETURNING *
        `,
        [
          room.roundId,
          player.playerId,
          Math.round(clientMs),
          serverReceivedMs,
          calibratedServerMs,
          player.latencyMs,
          position
        ]
      );

      player.lastBuzzRound = room.roundId;
      player.position = position;

      const buzz = {
        id: insert.rows[0].id,
        playerId: player.playerId,
        playerName: player.name,
        clientTimestampMs: Math.round(clientMs),
        serverReceivedMs,
        calibratedServerMs,
        latencyMs: Math.round(player.latencyMs),
        position
      };

      room.buzzes.push(buzz);

      const isWinner =
        room.buzzes.length === 1;

      if (isWinner) {
        room.state = "locked";

        await db(
          `
          UPDATE rounds
          SET state='locked',
              ended_at=NOW()
          WHERE id=$1
          `,
          [room.roundId]
        );

        io.to(room.code).emit(
          "buzz-result",
          {
            winner: buzz,
            buzzes: room.buzzes,
            locked: true
          }
        );

      } else {
        socket.emit(
          "buzz-result",
          {
            winner: room.buzzes[0],
            buzzes: room.buzzes,
            locked: true
          }
        );

        io.to(room.code).emit(
          "buzz-list",
          room.buzzes
        );
      }

      io.to(room.code).emit(
        "room-state",
        publicRoom(room)
      );

      ack?.({
        ok: true,
        position
      });

    } catch (error) {
      console.error(error);

      ack?.({
        ok: false,
        error: "Buzz failed."
      });
    }
  });

  socket.on("next-round", async ack => {
    const room = getRoom(socket.data.roomCode);

    if (!room) {
      return ack?.({
        ok: false,
        error: "Room not found."
      });
    }

    await createRound(room);

    for (const player of room.players.values()) {
      player.position = null;
      player.lastBuzzRound = null;
    }

    io.to(room.code).emit(
      "new-round",
      {
        roundId: room.roundId,
        roundNumber: room.roundNumber
      }
    );

    io.to(room.code).emit(
      "room-state",
      publicRoom(room)
    );

    ack?.({
      ok: true,
      roundNumber: room.roundNumber
    });
  });

  socket.on("disconnect", async () => {
    const room = getRoom(socket.data.roomCode);
    const player = room?.players.get(socket.id);

    if (player) {
      player.connected = false;

      await db(
        `
        UPDATE players
        SET connected=false
        WHERE id=$1
        `,
        [player.playerId]
      );

      io.to(room.code).emit(
        "room-state",
        publicRoom(room)
      );
    }
  });
});

app.get("/health", async (_req, res) => {
  try {
    await db("SELECT 1");

    res.json({
      ok: true,
      database: true
    });

  } catch {
    res.status(503).json({
      ok: false,
      database: false
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
  );
});

ensureSchema()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(
        `INC Atlas Buzzer running on port ${PORT}`
      );
    });
  })
  .catch(error => {
    console.error(
      "Database initialization failed:",
      error
    );

    process.exit(1);
  });
