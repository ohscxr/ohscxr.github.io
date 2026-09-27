// Cloudflare Worker + Durable Object backend for the mIRC-style chat room.
//
// This is what makes cross-device chat actually work: every visitor's
// browser opens a WebSocket to this Worker, the Worker forwards the
// upgrade to a single Durable Object instance ("main-room"), and that
// object keeps the message history + connected-user list and broadcasts
// updates to everyone connected.
//
// Deploy with Wrangler (see wrangler.toml in this same folder):
//   npm install -g wrangler   # if you don't have it
//   wrangler login
//   wrangler deploy
//
// Wrangler will print a URL like:
//   https://mirc-chat-worker.YOUR-SUBDOMAIN.workers.dev
// Use the wss:// version of that (wss://.../ws) as WORKER_WS_URL in index.html.

// ---------------------------------------------------------------------------
// Race schedule / alert config
//
// Races run every 2 hours, all day, anchored so a race lands exactly on
// 11:00 PM Eastern time (and therefore also on every odd Eastern hour:
// 1am, 3am, 5am...). "Eastern time" here tracks DST automatically
// (EDT in summer, EST in winter) so it's always really 11pm locally in
// New York, rather than a fixed UTC-4/UTC-5 offset that would drift by an
// hour twice a year.
//
// To shift what o'clock races land on, change the "23" (hour) below.
// To keep every race lining up with 11pm, only change RACE_INTERVAL_HOURS
// by an amount that still evenly divides 24 (e.g. 2, 3, 4, 6, 8, 12).
const RACE_TIMEZONE = "America/New_York";
const RACE_INTERVAL_HOURS = 4;
const RACE_INTERVAL_MS = RACE_INTERVAL_HOURS * 60 * 60 * 1000;
// Wall-clock reference: 11:00 PM on this "local calendar" grid — not a real
// UTC instant, just a fixed point to measure whole 2-hour cycles from.
const RACE_ANCHOR_LOCAL_MS = Date.UTC(2024, 0, 1, 23, 0, 0, 0);

// How long before race start to post an alert, in minutes (soonest last).
const RACE_ALERT_MINUTES = [180, 150, 120, 60, 30, 10, 5];

// Milliseconds to ADD to a UTC timestamp to get RACE_TIMEZONE wall-clock time
// (negative for zones west of UTC, e.g. ~-4h/-5h for America/New_York).
// Recomputed on every call so it tracks DST transitions automatically.
function tzOffsetMs(atUtcMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(atUtcMs));
  const m = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = p.value;
  const hour = m.hour === "24" ? "00" : m.hour; // some engines emit 24 for midnight
  const asIfUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +hour, +m.minute, +m.second);
  return asIfUTC - atUtcMs;
}

// Returns the timestamp (ms) of the next race start strictly after `now`.
function nextRaceStart(now) {
  // Offset is stable across the ~2hr window we're scheduling within, except
  // right at a DST transition (twice a year) — acceptable for a game alert.
  const offset = tzOffsetMs(now, RACE_TIMEZONE);
  const localNow = now + offset;
  const sinceAnchor = localNow - RACE_ANCHOR_LOCAL_MS;
  const cycles = Math.floor(sinceAnchor / RACE_INTERVAL_MS) + 1;
  const localRaceStart = RACE_ANCHOR_LOCAL_MS + cycles * RACE_INTERVAL_MS;
  return localRaceStart - offset;
}

// Returns { time, minutesBefore, raceTime } for the next race alert that
// should fire strictly after `now`, skipping any alerts that no longer fit
// before the soonest upcoming race.
function nextRaceAlert(now) {
  let raceTime = nextRaceStart(now);
  for (let guard = 0; guard < 8; guard++) {
    for (const minutesBefore of RACE_ALERT_MINUTES) {
      const t = raceTime - minutesBefore * 60 * 1000;
      if (t > now) return { time: t, minutesBefore, raceTime };
    }
    raceTime += RACE_INTERVAL_MS; // no alerts left before this race, try the next one
  }
  // Should never happen, but fail safe rather than looping forever.
  return { time: now + RACE_INTERVAL_MS, minutesBefore: RACE_ALERT_MINUTES[0], raceTime: raceTime + RACE_INTERVAL_MS };
}

function formatRaceClock(ms) {
  return new Date(ms).toLocaleTimeString("en-US", {
    timeZone: RACE_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short", // renders as "EST" or "EDT" automatically
  });
}

function raceAlertText(minutesBefore, raceTime) {
  const when = minutesBefore === 60 ? "1 hour" : minutesBefore + " minutes";
  return `🏁 Race starts in ${when} (${formatRaceClock(raceTime)})! Get to the starting line.`;
}

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // WebSocket -> { nickname, color }
    this.messages = [];

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get("messages");
      this.messages = stored || [];

      // Only (re)schedule if nothing is already pending — the alarm and its
      // pending-alert record persist in storage across DO restarts/evictions.
      const existingAlarm = await this.state.storage.getAlarm();
      if (existingAlarm === null) {
        await this.scheduleNextRaceAlarm();
      }
    });
  }

  async scheduleNextRaceAlarm() {
    const next = nextRaceAlert(Date.now());
    await this.state.storage.put("pendingRaceAlert", next);
    await this.state.storage.setAlarm(next.time);
  }

  async alarm() {
    const pending = await this.state.storage.get("pendingRaceAlert");
    if (pending) {
      await this.postRaceAlert(pending.minutesBefore, pending.raceTime);
    }
    await this.scheduleNextRaceAlarm();
  }

  async postRaceAlert(minutesBefore, raceTime) {
    const entry = {
      id: Date.now() + "-race-" + minutesBefore,
      nick: "RaceControl",
      color: "#ffcc00",
      text: raceAlertText(minutesBefore, raceTime),
      ts: Date.now(),
    };

    this.messages.push(entry);
    if (this.messages.length > 100) {
      this.messages = this.messages.slice(-100);
    }
    await this.state.storage.put("messages", this.messages);

    this.broadcast({ type: "message", message: entry });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      await this.handleSession(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  async handleSession(ws) {
    ws.accept();
    this.sessions.set(ws, { nickname: null, color: null });

    // Send recent history to the newly connected client.
    ws.send(JSON.stringify({ type: "history", messages: this.messages }));

    ws.addEventListener("message", async (evt) => {
      let data;
      try {
        data = JSON.parse(evt.data);
      } catch (e) {
        return;
      }
      if (data.type === "join") {
        const nickname = String(data.nickname || "guest").slice(0, 20);
        const color = String(data.color || "#c0c0c0").slice(0, 20);
        this.sessions.set(ws, { nickname, color });
        this.broadcastPresence();
      } else if (data.type === "message") {
        const session = this.sessions.get(ws);
        if (!session || !session.nickname) return;
        const text = String(data.text || "").slice(0, 500);
        if (!text) return;

        const entry = {
          id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
          nick: session.nickname,
          color: session.color,
          text,
          ts: Date.now(),
        };

        this.messages.push(entry);
        if (this.messages.length > 100) {
          this.messages = this.messages.slice(-100);
        }
        await this.state.storage.put("messages", this.messages);

        this.broadcast({ type: "message", message: entry });
      }
    });

    const cleanup = () => {
      this.sessions.delete(ws);
      this.broadcastPresence();
    };
    ws.addEventListener("close", cleanup);
    ws.addEventListener("error", cleanup);
  }

  broadcast(data) {
    const str = JSON.stringify(data);
    for (const ws of this.sessions.keys()) {
      try {
        ws.send(str);
      } catch (e) {
        this.sessions.delete(ws);
      }
    }
  }

  broadcastPresence() {
    const peers = [];
    for (const session of this.sessions.values()) {
      if (session.nickname) {
        peers.push({ nickname: session.nickname, color: session.color });
      }
    }
    this.broadcast({ type: "presence", peers });
  }
}

export default {
  async fetch(request, env) {
    // A single named Durable Object instance = a single shared chat room.
    // (Use a different name, or derive one from the URL, if you want
    // multiple independent rooms.)
    const id = env.CHAT_ROOM.idFromName("main-room");
    const stub = env.CHAT_ROOM.get(id);
    return stub.fetch(request);
  },
};