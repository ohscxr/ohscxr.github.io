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

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // WebSocket -> { nickname, color }
    this.messages = [];

    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get("messages");
      this.messages = stored || [];
    });
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
 // Test
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
