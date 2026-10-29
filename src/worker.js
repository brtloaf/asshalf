// asshalf — Cloudflare Worker + one Durable Object per room.
// The Worker serves the game from /public and hands /ws/<CODE> to that room's Durable Object.

import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 8;
const CUT_MS = { half: 40000, target: 40000, tri: 60000 };
const REVEAL_MS = 7000;
const KINDS = ["half", "target", "tri"];
// player colors: strong enough to read on the cream paper shape and the green mat
const COLORS = ["#e9a23b", "#ff5a4e", "#2e8b6a", "#3a7ca5", "#b04fbf", "#d9467a", "#7a5a2b", "#5c6bc0"];

const fresh = () => ({
  phase: "lobby", host: null, order: [], players: {}, rounds: 5, kind: "half",
  round: 0, info: null, deadline: 0, results: {}, touched: Date.now(),
});
const rint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo; };
function triTargets() {
  for (;;) {
    const a = rint(8, 67), b = rint(8, 67), c = 100 - a - b;
    if (c >= 8 && a !== b && b !== c && a !== c) return [a, b, c].sort((x, y) => x - y);
  }
}
const pt = p => [Math.round(num(p?.[0], -3, 3) * 1000) / 1000, Math.round(num(p?.[1], -3, 3) * 1000) / 1000];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/ws\/([A-Za-z]{4})$/);
    if (m) {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1].toUpperCase()));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.s = null; // room state; reloaded from storage after the object hibernates
  }

  async load() {
    if (!this.s) this.s = (await this.ctx.storage.get("s")) || fresh();
    return this.s;
  }
  async save() {
    this.s.touched = Date.now();
    await this.ctx.storage.put("s", this.s);
  }

  sockets(exclude) {
    return this.ctx.getWebSockets().filter(ws => ws !== exclude && ws.deserializeAttachment()?.pid);
  }
  online(exclude) {
    return new Set(this.sockets(exclude).map(ws => ws.deserializeAttachment().pid));
  }

  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server); // hibernation API: no billing while everyone is idle
    return new Response(null, { status: 101, webSocket: client });
  }

  view(pid, exclude) {
    const s = this.s, on = this.online(exclude);
    return {
      t: "state", now: Date.now(), you: pid,
      phase: s.phase, host: s.host, kind: s.kind, round: s.round, rounds: s.rounds,
      info: s.phase === "lobby" ? null : s.info, deadline: s.deadline,
      players: s.order.map(p => ({
        pid: p, name: s.players[p].name, color: s.players[p].color, total: s.players[p].total,
        online: on.has(p), done: !!s.results[p],
      })),
      results: s.phase === "cutting" ? null : s.results, // hidden until everyone has cut
    };
  }
  broadcast(exclude) {
    for (const ws of this.sockets(exclude)) {
      try { ws.send(JSON.stringify(this.view(ws.deserializeAttachment().pid, exclude))); } catch {}
    }
  }

  prune(on = this.online()) {
    const s = this.s;
    for (const p of s.order) if (!on.has(p)) delete s.players[p];
    s.order = s.order.filter(p => on.has(p));
  }

  async newRound() {
    const s = this.s;
    s.round++;
    s.results = {};
    let target = 50;
    if (s.kind === "target") do target = rint(5, 95); while (target === 50);
    s.info = { seed: Math.floor(Math.random() * 2 ** 32), target, targets: s.kind === "tri" ? triTargets() : null };
    s.phase = "cutting";
    s.deadline = Date.now() + CUT_MS[s.kind];
    await this.ctx.storage.setAlarm(s.deadline);
  }
  async reveal() {
    this.s.phase = "reveal";
    this.s.deadline = Date.now() + REVEAL_MS;
    await this.ctx.storage.setAlarm(this.s.deadline);
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    let s = await this.load();
    const me = ws.deserializeAttachment()?.pid;

    if (msg.t === "join") {
      const pid = String(msg.pid || "").replace(/[^\w-]/g, "").slice(0, 40);
      const name = String(msg.name || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 16) || "Player";
      if (!pid) return;
      // a room nobody has touched in 30 minutes starts over
      if (this.online(ws).size === 0 && Date.now() - s.touched > 30 * 60 * 1000) s = this.s = fresh();
      if (s.phase === "lobby") this.prune(new Set([...this.online(ws), pid]));
      if (!s.players[pid]) {
        if (s.order.length >= MAX_PLAYERS) {
          ws.send(JSON.stringify({ t: "error", msg: "This room is full. Eight players max." }));
          ws.close(1008, "full");
          return;
        }
        const used = new Set(Object.values(s.players).map(p => p.color));
        s.players[pid] = { name, color: COLORS.find(c => !used.has(c)) || COLORS[0], total: 0 };
        s.order.push(pid);
      } else {
        s.players[pid].name = name;
      }
      ws.serializeAttachment({ pid });
      if (!s.host || !this.online().has(s.host)) s.host = pid;
      await this.save();
      this.broadcast();
      return;
    }
    if (!me || !s.players[me]) return;

    if (msg.t === "aim") {
      // live blade preview: relayed, never stored
      if (s.phase !== "cutting" || s.results[me]) return;
      const out = JSON.stringify({ t: "aim", pid: me, a: pt(msg.a), b: pt(msg.b) });
      for (const other of this.sockets(ws)) { try { other.send(out); } catch {} }
      return;
    }

    if (msg.t === "start") {
      if (me !== s.host || !["lobby", "final"].includes(s.phase)) return;
      s.kind = KINDS.includes(msg.kind) ? msg.kind : "half";
      s.rounds = Math.round(num(msg.rounds, 1, 10));
      this.prune();
      for (const p of Object.values(s.players)) p.total = 0;
      s.round = 0;
      await this.newRound();
    } else if (msg.t === "lobby") {
      if (me !== s.host || s.phase !== "final") return;
      s.phase = "lobby";
      this.prune();
      for (const p of Object.values(s.players)) p.total = 0;
    } else if (msg.t === "cut") {
      if (s.phase !== "cutting" || msg.round !== s.round || s.results[me]) return;
      const score = Math.round(num(msg.score, 0, 100));
      const lines = (Array.isArray(msg.lines) ? msg.lines : []).slice(0, 2).map(l => [pt(l?.[0]), pt(l?.[1])]);
      const pcts = (Array.isArray(msg.pcts) ? msg.pcts : []).slice(0, 3).map(v => Math.round(num(v, 0, 100) * 10) / 10);
      s.results[me] = { score, lines, pcts };
      s.players[me].total += score;
      const on = this.online();
      if ([...on].every(p => s.results[p])) await this.reveal();
    } else {
      return;
    }
    await this.save();
    this.broadcast();
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(1000, "bye"); } catch {}
    await this.left(ws);
  }
  async webSocketError(ws) {
    await this.left(ws);
  }
  async left(ws) {
    const pid = ws.deserializeAttachment()?.pid;
    if (!pid) return;
    const s = await this.load(), on = this.online(ws);
    if (s.host === pid && !on.has(pid)) s.host = s.order.find(p => on.has(p)) || null;
    if (s.phase === "lobby") this.prune(on);
    if (s.phase === "cutting" && on.size && [...on].every(p => s.results[p])) await this.reveal();
    await this.save();
    this.broadcast(ws);
  }

  async alarm() {
    const s = await this.load();
    if (this.online().size === 0) { // everyone left: clear the room
      await this.ctx.storage.deleteAll();
      this.s = null;
      return;
    }
    if (s.deadline && Date.now() < s.deadline - 100) { await this.ctx.storage.setAlarm(s.deadline); return; }
    if (s.phase === "cutting") await this.reveal();
    else if (s.phase === "reveal") {
      if (s.round < s.rounds) await this.newRound();
      else { s.phase = "final"; s.deadline = 0; }
    } else return;
    await this.save();
    this.broadcast();
  }
}
