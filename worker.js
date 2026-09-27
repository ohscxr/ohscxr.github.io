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
// Races run at 11pm, 3am, 5am, 7am, 9am, 11am, 1pm, 3pm, 5pm, 7pm, 9pm and
// 11pm again, Eastern time — every 2 hours around the clock EXCEPT there's
// no 1am race, so there's a 4-hour gap from 11pm to 3am, then normal 2-hour
// spacing the rest of the day.
//
// "Eastern time" tracks DST automatically (EDT in summer, EST in winter) so
// this is always really 11pm/3am/etc. locally in New York, not a fixed
// UTC-4/UTC-5 offset that would drift by an hour twice a year.
//
// To change the schedule, edit the hours (0-23) in RACE_HOURS_LOCAL below.
const RACE_TIMEZONE = "America/New_York";
const RACE_HOURS_LOCAL = [3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23];

// How long before race start to post an alert, in minutes (soonest last).
const RACE_ALERT_MINUTES = [60, 30, 10, 5];

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

// Converts a wall-clock date/time in `timeZone` to the real UTC instant it
// represents (handling DST via a one-step refinement near the transition).
function localPartsToUtc(year, month, day, hour, minute, second, timeZone) {
  const guess = Date.UTC(year, month, day, hour, minute, second);
  const offset1 = tzOffsetMs(guess, timeZone);
  const t1 = guess - offset1;
  const offset2 = tzOffsetMs(t1, timeZone);
  return offset2 === offset1 ? t1 : guess - offset2;
}

// Returns the timestamp (ms) of the next race start strictly after `now`.
function nextRaceStart(now) {
  const offsetNow = tzOffsetMs(now, RACE_TIMEZONE);
  const local = new Date(now + offsetNow); // wall-clock pseudo-date; read with getUTC*
  const y = local.getUTCFullYear();
  const mo = local.getUTCMonth();
  const d = local.getUTCDate();

  const candidates = [];
  for (const dayOffset of [0, 1]) {
    for (const hour of RACE_HOURS_LOCAL) {
      candidates.push(localPartsToUtc(y, mo, d + dayOffset, hour, 0, 0, RACE_TIMEZONE));
    }
  }
  candidates.sort((a, b) => a - b);
  return candidates.find((t) => t > now);
}

// Returns { time, minutesBefore, raceTime } for the next race alert that
// should fire strictly after `now`, skipping any alerts that no longer fit
// before the soonest upcoming race (races aren't evenly spaced here, so
// each rollover re-derives the following race from the schedule directly).
function nextRaceAlert(now) {
  let raceTime = nextRaceStart(now);
  for (let guard = 0; guard < 8; guard++) {
    for (const minutesBefore of RACE_ALERT_MINUTES) {
      const t = raceTime - minutesBefore * 60 * 1000;
      if (t > now) return { time: t, minutesBefore, raceTime };
    }
    raceTime = nextRaceStart(raceTime); // no alerts left before this race, try the next one
  }
  // Should never happen, but fail safe rather than looping forever.
  return { time: now + 60 * 60 * 1000, minutesBefore: RACE_ALERT_MINUTES[0], raceTime: raceTime };
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