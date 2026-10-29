var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker/lobby.ts
import { DurableObject } from "cloudflare:workers";

// src/net/protocol.ts
var NAME_RE = /^[A-Za-z0-9 _.\-]{2,16}$/;
function cleanName(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/\s+/g, " ");
  return NAME_RE.test(s) ? s : null;
}
__name(cleanName, "cleanName");
var TEAM_NAME_RE = /^[A-Za-z0-9 _.\-]{3,20}$/;
function cleanTeamName(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/\s+/g, " ");
  return TEAM_NAME_RE.test(s) ? s : null;
}
__name(cleanTeamName, "cleanTeamName");

// worker/env.ts
var json = /* @__PURE__ */ __name((data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } }), "json");
function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(randomHex, "randomHex");
var CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function randomCode(len) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return [...a].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}
__name(randomCode, "randomCode");

// worker/lobby.ts
var MAX_TEAM = 3;
var BOT_FILL_AFTER_MS = 2e4;
var Lobby = class extends DurableObject {
  static {
    __name(this, "Lobby");
  }
  sql;
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS players(
        id TEXT PRIMARY KEY, token TEXT NOT NULL, name TEXT NOT NULL,
        mmr INTEGER NOT NULL DEFAULT 1000, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
        goals INTEGER NOT NULL DEFAULT 0, saves INTEGER NOT NULL DEFAULT 0, assists INTEGER NOT NULL DEFAULT 0,
        shots INTEGER NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0, team_id TEXT, created INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS teams(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, code TEXT NOT NULL UNIQUE,
        captain TEXT NOT NULL, rating INTEGER NOT NULL DEFAULT 1000, wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)`);
      this.sql.exec(`CREATE TABLE IF NOT EXISTS rooms(code TEXT PRIMARY KEY, created INTEGER NOT NULL, reported INTEGER NOT NULL DEFAULT 0)`);
    });
  }
  // ------------------------------------------------------------------ helpers
  player(id) {
    if (!id) return null;
    const rows = this.sql.exec("SELECT * FROM players WHERE id = ?", id).toArray();
    return rows[0] ?? null;
  }
  authed(req, url) {
    const id = req.headers.get("x-player-id") ?? url.searchParams.get("id");
    const token = req.headers.get("x-player-token") ?? url.searchParams.get("token");
    const p = this.player(id);
    if (!p || !token || token.length !== p.token.length) return null;
    let diff = 0;
    for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ p.token.charCodeAt(i);
    return diff === 0 ? p : null;
  }
  team(id) {
    if (!id) return null;
    return this.sql.exec("SELECT id, name, code, captain, rating, wins, losses FROM teams WHERE id = ?", id).toArray()[0] ?? null;
  }
  teamMembers(teamId) {
    const online = new Set(this.sockets().map((s) => s.att.id));
    return this.sql.exec("SELECT id, name FROM players WHERE team_id = ? ORDER BY created", teamId).toArray().map((m) => ({ id: m.id, name: m.name, online: online.has(m.id) }));
  }
  publicPlayer(p) {
    return { id: p.id, name: p.name, mmr: p.mmr, wins: p.wins, losses: p.losses, goals: p.goals, saves: p.saves, assists: p.assists, shots: p.shots, games: p.games, teamId: p.team_id };
  }
  sockets() {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN).map((ws) => ({ ws, att: ws.deserializeAttachment() }));
  }
  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
    }
  }
  sendTo(playerId, msg) {
    for (const s of this.sockets()) if (s.att.id === playerId) this.send(s.ws, msg);
  }
  broadcastTeam(teamId) {
    if (!teamId) return;
    const members = this.teamMembers(teamId);
    const queued = this.sockets().some((s) => s.att.teamId === teamId && s.att.queue === "team");
    for (const s of this.sockets()) if (s.att.teamId === teamId) this.send(s.ws, { t: "team", members, queued });
  }
  /** Update the stored socket state for every socket of a player. */
  patchPlayerSockets(playerId, patch) {
    for (const s of this.sockets()) {
      if (s.att.id !== playerId) continue;
      s.ws.serializeAttachment({ ...s.att, ...patch });
    }
  }
  // ------------------------------------------------------------------ HTTP
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/api/lobby") {
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "Expected a WebSocket" }, 426);
      const p = this.authed(req, url);
      if (!p) return json({ error: "Not signed in" }, 401);
      const pair = new WebSocketPair();
      const att = { id: p.id, name: p.name, teamId: p.team_id, queue: null, since: 0 };
      this.ctx.acceptWebSocket(pair[1], [p.id]);
      pair[1].serializeAttachment(att);
      this.send(pair[1], { t: "hello", online: new Set(this.sockets().map((s) => s.att.id)).size });
      this.broadcastTeam(p.team_id);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (path === "/api/register" && req.method === "POST") {
      const body2 = await req.json().catch(() => ({}));
      const name = cleanName(body2.name) ?? `Player${Math.floor(1e3 + Math.random() * 9e3)}`;
      const id = randomHex(8);
      const token = randomHex(24);
      this.sql.exec("INSERT INTO players(id, token, name, created) VALUES(?, ?, ?, ?)", id, token, name, Date.now());
      return json({ id, token, name });
    }
    if (path === "/api/leaderboard") {
      const players = this.sql.exec("SELECT * FROM players WHERE games > 0 ORDER BY mmr DESC, wins DESC LIMIT 50").toArray().map((p) => this.publicPlayer(p));
      const teams = this.sql.exec(
        `SELECT t.id, t.name, t.rating, t.wins, t.losses, (SELECT COUNT(*) FROM players p WHERE p.team_id = t.id) AS members
           FROM teams t ORDER BY t.rating DESC, t.wins DESC LIMIT 50`
      ).toArray().map((t) => ({ id: t.id, name: t.name, rating: t.rating, wins: t.wins, losses: t.losses, members: t.members }));
      return json({ players, teams });
    }
    const me = this.authed(req, url);
    if (!me) return json({ error: "Not signed in" }, 401);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    switch (path) {
      case "/api/me": {
        const team = this.team(me.team_id);
        return json({ player: this.publicPlayer(me), team: team ? { ...team, members: this.teamMembers(team.id) } : null });
      }
      case "/api/name": {
        const name = cleanName(body.name);
        if (!name) return json({ error: "Names are 2\u201316 letters, numbers, spaces, dots, dashes or underscores." }, 400);
        this.sql.exec("UPDATE players SET name = ? WHERE id = ?", name, me.id);
        this.patchPlayerSockets(me.id, { name });
        this.broadcastTeam(me.team_id);
        return json({ name });
      }
      case "/api/team/create": {
        if (me.team_id) return json({ error: "Leave your current team first." }, 400);
        const name = cleanTeamName(body.name);
        if (!name) return json({ error: "Team names are 3\u201320 letters, numbers or spaces." }, 400);
        const key = name.toLowerCase();
        if (this.sql.exec("SELECT 1 FROM teams WHERE name_key = ?", key).toArray().length) return json({ error: "That team name is taken." }, 409);
        const id = randomHex(8);
        let code = randomCode(6);
        while (this.sql.exec("SELECT 1 FROM teams WHERE code = ?", code).toArray().length) code = randomCode(6);
        this.sql.exec("INSERT INTO teams(id, name, name_key, code, captain, created) VALUES(?, ?, ?, ?, ?, ?)", id, name, key, code, me.id, Date.now());
        this.sql.exec("UPDATE players SET team_id = ? WHERE id = ?", id, me.id);
        this.patchPlayerSockets(me.id, { teamId: id });
        this.broadcastTeam(id);
        return json({ team: { ...this.team(id), members: this.teamMembers(id) } });
      }
      case "/api/team/join": {
        if (me.team_id) return json({ error: "Leave your current team first." }, 400);
        const code = String(body.code ?? "").trim().toUpperCase();
        const team = this.sql.exec("SELECT id, name, code, captain, rating, wins, losses FROM teams WHERE code = ?", code).toArray()[0];
        if (!team) return json({ error: "No team has that code." }, 404);
        const count = this.sql.exec("SELECT COUNT(*) AS n FROM players WHERE team_id = ?", team.id).one().n;
        if (count >= MAX_TEAM) return json({ error: `That team is full (${MAX_TEAM} players).` }, 409);
        this.sql.exec("UPDATE players SET team_id = ? WHERE id = ?", team.id, me.id);
        this.patchPlayerSockets(me.id, { teamId: team.id });
        this.broadcastTeam(team.id);
        return json({ team: { ...team, members: this.teamMembers(team.id) } });
      }
      case "/api/team/leave": {
        const teamId = me.team_id;
        if (!teamId) return json({ ok: true });
        this.sql.exec("UPDATE players SET team_id = NULL WHERE id = ?", me.id);
        this.patchPlayerSockets(me.id, { teamId: null, queue: null });
        const left = this.sql.exec("SELECT id FROM players WHERE team_id = ? ORDER BY created", teamId).toArray();
        if (!left.length) this.sql.exec("DELETE FROM teams WHERE id = ?", teamId);
        else this.sql.exec("UPDATE teams SET captain = ? WHERE id = ? AND captain = ?", left[0].id, teamId, me.id);
        for (const s of this.sockets()) if (s.att.teamId === teamId && s.att.queue === "team") s.ws.serializeAttachment({ ...s.att, queue: null });
        this.broadcastTeam(teamId);
        return json({ ok: true });
      }
      case "/api/room/create": {
        const mode = body.mode === "2v2" ? "2v2" : "1v1";
        const code = await this.createRoom("private", mode, [], me.id);
        return json({ code });
      }
    }
    return json({ error: "Not found" }, 404);
  }
  // ------------------------------------------------------------------ rooms
  async createRoom(kind, mode, slots, hostId, teamBattle, teamNames) {
    let code = randomCode(5);
    while (this.sql.exec("SELECT 1 FROM rooms WHERE code = ?", code).toArray().length) code = randomCode(5);
    this.sql.exec("INSERT INTO rooms(code, created) VALUES(?, ?)", code, Date.now());
    const stub = this.env.ROOM.get(this.env.ROOM.idFromName(code));
    await stub.setup({ code, kind, mode, hostId, slots, teamBattle, teamNames, started: false, reported: false });
    return code;
  }
  /** Called by Room objects to check a joining player's credentials. */
  async verify(id, token) {
    const p = this.player(id);
    if (!p || p.token !== token) return null;
    return { id: p.id, name: p.name };
  }
  /** Called by a Room when its host reports the final result. Applied once per room. */
  async reportResult(r) {
    const room = this.sql.exec("SELECT reported FROM rooms WHERE code = ?", r.code).toArray()[0];
    if (!room || room.reported) return;
    this.sql.exec("UPDATE rooms SET reported = 1 WHERE code = ?", r.code);
    const winner = r.score[0] > r.score[1] ? 0 : 1;
    const humans = r.players.map((p) => ({ ...p, row: this.player(p.id) })).filter((p) => p.row);
    const avg = /* @__PURE__ */ __name((team) => {
      const ms = humans.filter((h) => h.team === team).map((h) => h.row.mmr);
      const size = r.mode === "2v2" ? 2 : 1;
      while (ms.length < size) ms.push(1e3);
      return ms.reduce((a, b) => a + b, 0) / ms.length;
    }, "avg");
    const ratings = [avg(0), avg(1)];
    for (const h of humans) {
      const own = ratings[h.team];
      const opp = ratings[h.team === 0 ? 1 : 0];
      const expected = 1 / (1 + 10 ** ((opp - own) / 400));
      const won = h.team === winner ? 1 : 0;
      const delta = Math.round(32 * (won - expected));
      this.sql.exec(
        `UPDATE players SET mmr = MAX(0, mmr + ?), games = games + 1, wins = wins + ?, losses = losses + ?,
         goals = goals + ?, saves = saves + ?, assists = assists + ?, shots = shots + ? WHERE id = ?`,
        delta,
        won,
        1 - won,
        clampStat(h.goals),
        clampStat(h.saves),
        clampStat(h.assists),
        clampStat(h.shots),
        h.id
      );
    }
    if (r.teamBattle) {
      const blue = this.team(r.teamBattle.blue);
      const orange = this.team(r.teamBattle.orange);
      if (blue && orange) {
        const eb = 1 / (1 + 10 ** ((orange.rating - blue.rating) / 400));
        const db = Math.round(32 * ((winner === 0 ? 1 : 0) - eb));
        this.sql.exec("UPDATE teams SET rating = MAX(0, rating + ?), wins = wins + ?, losses = losses + ? WHERE id = ?", db, winner === 0 ? 1 : 0, winner === 0 ? 0 : 1, blue.id);
        this.sql.exec("UPDATE teams SET rating = MAX(0, rating - ?), wins = wins + ?, losses = losses + ? WHERE id = ?", db, winner === 1 ? 1 : 0, winner === 1 ? 0 : 1, orange.id);
      }
    }
  }
  // ------------------------------------------------------------------ matchmaking sockets
  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 2e3) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment();
    switch (msg.t) {
      case "queue":
        if (msg.mode !== "1v1" && msg.mode !== "2v2") return;
        this.patchPlayerSockets(att.id, { queue: msg.mode, since: Date.now() });
        break;
      case "cancel":
        this.patchPlayerSockets(att.id, { queue: null });
        this.send(ws, { t: "queue", mode: null, waiting: 0, since: 0 });
        break;
      case "teamQueue": {
        if (!att.teamId) return this.send(ws, { t: "error", message: "Join or create a team first." });
        const online = new Set(this.sockets().filter((s) => s.att.teamId === att.teamId).map((s) => s.att.id));
        if (online.size < 2) return this.send(ws, { t: "error", message: "Both teammates need to be online on the Teams tab." });
        this.patchPlayerSockets(att.id, { queue: "team", since: Date.now() });
        this.broadcastTeam(att.teamId);
        break;
      }
      case "teamCancel":
        for (const s of this.sockets()) if (s.att.teamId === att.teamId && s.att.queue === "team") s.ws.serializeAttachment({ ...s.att, queue: null });
        this.broadcastTeam(att.teamId);
        break;
      case "ping":
        return;
    }
    await this.matchmake();
  }
  async webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    try {
      ws.close();
    } catch {
    }
    this.broadcastTeam(att.teamId);
    await this.matchmake();
  }
  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
  async alarm() {
    await this.matchmake();
  }
  async matchmake() {
    const now = Date.now();
    const all = this.sockets().filter((s) => s.ws.readyState === WebSocket.OPEN);
    const byId = /* @__PURE__ */ new Map();
    for (const s of all) if (!byId.has(s.att.id) || s.att.queue) byId.set(s.att.id, s.att);
    const queue = /* @__PURE__ */ __name((mode) => [...byId.values()].filter((a) => a.queue === mode).sort((a, b) => a.since - b.since), "queue");
    const matched = /* @__PURE__ */ __name(async (ids, code, mode, kind) => {
      for (const id of ids) {
        this.patchPlayerSockets(id, { queue: null });
        byId.delete(id);
        this.sendTo(id, { t: "matched", code, mode, kind });
      }
    }, "matched");
    let q = queue("1v1");
    while (q.length >= 2) {
      const [a, b] = q.splice(0, 2);
      const code = await this.createRoom("quick", "1v1", [{ id: a.id, team: 0 }, { id: b.id, team: 1 }], a.id);
      await matched([a.id, b.id], code, "1v1", "quick");
    }
    q = queue("2v2");
    while (q.length >= 4 || q.length >= 2 && now - q[0].since > BOT_FILL_AFTER_MS) {
      const group = q.splice(0, Math.min(4, q.length));
      const slots = group.map((p, i) => ({ id: p.id, team: i % 2 }));
      const code = await this.createRoom("quick", "2v2", slots, group[0].id);
      await matched(group.map((p) => p.id), code, "2v2", "quick");
    }
    const teamWaits = /* @__PURE__ */ new Map();
    for (const a of queue("team")) if (a.teamId) teamWaits.set(a.teamId, Math.min(teamWaits.get(a.teamId) ?? Infinity, a.since));
    const readyTeams = [...teamWaits.entries()].map(([teamId, since]) => ({ teamId, since, members: [...new Set(all.filter((s) => s.att.teamId === teamId).map((s) => s.att.id))] })).filter((t) => t.members.length >= 2).sort((a, b) => a.since - b.since);
    while (readyTeams.length >= 2) {
      const [ta, tb] = readyTeams.splice(0, 2);
      const blue = ta.members.slice(0, 2);
      const orange = tb.members.slice(0, 2);
      const slots = [...blue.map((id) => ({ id, team: 0 })), ...orange.map((id) => ({ id, team: 1 }))];
      const names = [this.team(ta.teamId)?.name ?? "Blue", this.team(tb.teamId)?.name ?? "Orange"];
      const code = await this.createRoom("team", "2v2", slots, blue[0], { blue: ta.teamId, orange: tb.teamId }, names);
      for (const t of [ta, tb]) for (const s of all) if (s.att.teamId === t.teamId) s.ws.serializeAttachment({ ...s.ws.deserializeAttachment(), queue: null });
      await matched([...blue, ...orange], code, "2v2", "team");
      this.broadcastTeam(ta.teamId);
      this.broadcastTeam(tb.teamId);
    }
    let anyWaiting = false;
    for (const s of this.sockets()) {
      if (!s.att.queue) continue;
      anyWaiting = true;
      const waiting = new Set(this.sockets().filter((o) => o.att.queue === s.att.queue).map((o) => s.att.queue === "team" ? o.att.teamId : o.att.id)).size;
      this.send(s.ws, { t: "queue", mode: s.att.queue, waiting, since: s.att.since });
    }
    if (anyWaiting) await this.ctx.storage.setAlarm(now + 5e3);
  }
};
function clampStat(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(n, 50)) : 0;
}
__name(clampStat, "clampStat");

// worker/room.ts
import { DurableObject as DurableObject2 } from "cloudflare:workers";
var RELAY_ANY = /* @__PURE__ */ new Set(["car", "touch", "pad", "chat"]);
var RELAY_HOST = /* @__PURE__ */ new Set(["world", "kickoff", "go", "goal", "demo", "end", "start"]);
var Room = class extends DurableObject2 {
  static {
    __name(this, "Room");
  }
  cfg = null;
  async config() {
    if (!this.cfg) this.cfg = await this.ctx.storage.get("cfg") ?? null;
    return this.cfg;
  }
  async save(cfg) {
    this.cfg = cfg;
    await this.ctx.storage.put("cfg", cfg);
  }
  /** Called by the Lobby when it creates the room. */
  async setup(cfg) {
    await this.save(cfg);
    await this.ctx.storage.setAlarm(Date.now() + 4 * 36e5);
  }
  async alarm() {
    if (this.ctx.getWebSockets().length) {
      await this.ctx.storage.setAlarm(Date.now() + 36e5);
      return;
    }
    await this.ctx.storage.deleteAll();
    this.cfg = null;
  }
  sockets() {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN).map((ws) => ({ ws, att: ws.deserializeAttachment() }));
  }
  roster() {
    const seen = /* @__PURE__ */ new Map();
    for (const s of this.sockets().sort((a, b) => a.att.joined - b.att.joined)) {
      seen.set(s.att.id, { id: s.att.id, name: s.att.name, team: s.att.team, design: s.att.design });
    }
    return [...seen.values()];
  }
  async broadcastRoster() {
    const cfg = await this.config();
    if (!cfg) return;
    const info = {
      t: "roster",
      code: cfg.code,
      mode: cfg.mode,
      kind: cfg.kind,
      hostId: cfg.hostId,
      started: cfg.started,
      players: this.roster(),
      teamNames: cfg.teamNames,
      expected: cfg.kind === "private" ? void 0 : cfg.slots.length
    };
    const msg = JSON.stringify(info);
    for (const s of this.sockets()) this.safeSend(s.ws, msg);
  }
  safeSend(ws, msg) {
    try {
      ws.send(msg);
    } catch {
    }
  }
  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket") return json({ error: "Expected a WebSocket" }, 426);
    const cfg = await this.config();
    if (!cfg) return json({ error: "That room does not exist (check the code)." }, 404);
    const url = new URL(req.url);
    const id = url.searchParams.get("id") ?? "";
    const token = url.searchParams.get("token") ?? "";
    const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName("global"));
    const who = await lobby.verify(id, token);
    if (!who) return json({ error: "Not signed in" }, 401);
    const roster = this.roster();
    const already = roster.find((p) => p.id === id);
    let team;
    if (cfg.kind !== "private") {
      const slot = cfg.slots.find((s) => s.id === id);
      if (!slot) return json({ error: "You are not part of this match." }, 403);
      team = slot.team;
    } else if (already) {
      team = already.team;
    } else {
      if (cfg.started) return json({ error: "That match has already started." }, 409);
      const per = cfg.mode === "1v1" ? 1 : 2;
      const count = /* @__PURE__ */ __name((t) => roster.filter((p) => p.team === t).length, "count");
      if (count(0) < per && count(0) <= count(1)) team = 0;
      else if (count(1) < per) team = 1;
      else if (count(0) < per) team = 0;
      else return json({ error: "That room is full." }, 409);
    }
    for (const s of this.sockets()) if (s.att.id === id) s.ws.close(4e3, "Replaced by a newer connection");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [id]);
    const att = { id, name: who.name, team, design: null, joined: Date.now() };
    pair[1].serializeAttachment(att);
    if (cfg.kind === "private" && !cfg.started && !this.sockets().some((s) => s.att.id === cfg.hostId)) {
      await this.save({ ...cfg, hostId: id });
    }
    await this.broadcastRoster();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 12e3) return;
    const att = ws.deserializeAttachment();
    const m = raw.match(/^\{"t":"(\w+)"/);
    if (!m) return;
    const type = m[1];
    const cfg = await this.config();
    if (!cfg) return;
    const isHost = att.id === cfg.hostId;
    if (RELAY_ANY.has(type) || RELAY_HOST.has(type) && isHost) {
      if (type === "start") {
        if (cfg.started) return;
        await this.save({ ...cfg, started: true });
      }
      const out = `{"f":"${att.id}","d":${raw}}`;
      for (const s of this.sockets()) if (s.ws !== ws) this.safeSend(s.ws, out);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (type) {
      case "hello": {
        const design = raw.length < 3e3 ? msg.design : null;
        ws.serializeAttachment({ ...att, design });
        await this.broadcastRoster();
        break;
      }
      case "setTeam": {
        if (cfg.kind !== "private" || cfg.started) return;
        const team = msg.team === 1 ? 1 : 0;
        const per = cfg.mode === "1v1" ? 1 : 2;
        if (this.roster().filter((p) => p.team === team && p.id !== att.id).length >= per) return;
        ws.serializeAttachment({ ...att, team });
        await this.broadcastRoster();
        break;
      }
      case "setMode": {
        if (cfg.kind !== "private" || cfg.started || !isHost) return;
        const mode = msg.mode === "2v2" ? "2v2" : "1v1";
        await this.save({ ...cfg, mode });
        if (mode === "1v1") {
          const seen = { 0: 0, 1: 0 };
          for (const s of this.sockets().sort((a, b) => a.att.joined - b.att.joined)) {
            seen[s.att.team]++;
            if (seen[s.att.team] > 1) {
              const other = s.att.team === 0 ? 1 : 0;
              if (seen[other] < 1) {
                seen[other]++;
                seen[s.att.team]--;
                s.ws.serializeAttachment({ ...s.att, team: other });
              }
            }
          }
        }
        await this.broadcastRoster();
        break;
      }
      case "result": {
        if (!isHost || cfg.reported) return;
        await this.save({ ...cfg, reported: true });
        const score = Array.isArray(msg.score) ? [Number(msg.score[0]) || 0, Number(msg.score[1]) || 0] : [0, 0];
        const stats = msg.stats ?? {};
        const players = this.roster().map((p) => ({
          id: p.id,
          team: p.team,
          goals: Number(stats[p.id]?.goals) || 0,
          saves: Number(stats[p.id]?.saves) || 0,
          assists: Number(stats[p.id]?.assists) || 0,
          shots: Number(stats[p.id]?.shots) || 0
        }));
        const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName("global"));
        await lobby.reportResult({ code: cfg.code, mode: cfg.mode, teamBattle: cfg.teamBattle, score, players });
        break;
      }
    }
  }
  async webSocketClose(ws) {
    const att = ws.deserializeAttachment();
    try {
      ws.close();
    } catch {
    }
    const cfg = await this.config();
    if (!cfg) return;
    const stillHere = this.sockets().some((s) => s.ws !== ws && s.att.id === att.id);
    if (stillHere) return;
    if (att.id === cfg.hostId) {
      if (!cfg.started) {
        const next = this.sockets().find((s) => s.ws !== ws);
        if (next) await this.save({ ...cfg, hostId: next.att.id });
      } else {
        const msg = JSON.stringify({ t: "hostLeft" });
        for (const s of this.sockets()) if (s.ws !== ws) this.safeSend(s.ws, msg);
      }
    }
    await this.broadcastRoster();
  }
  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }
};

// worker/index.ts
var worker_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    const roomWs = url.pathname.match(/^\/api\/room\/([A-Z0-9]{5})\/ws$/);
    if (roomWs) {
      const stub = env.ROOM.get(env.ROOM.idFromName(roomWs[1]));
      return stub.fetch(req);
    }
    if (url.pathname.startsWith("/api/")) {
      const stub = env.LOBBY.get(env.LOBBY.idFromName("global"));
      return stub.fetch(req);
    }
    return env.ASSETS.fetch(req);
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-lTlXbm/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-lTlXbm/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Lobby,
  Room,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
