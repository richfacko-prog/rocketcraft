// Global Lobby Durable Object: player profiles, teams, leaderboard and matchmaking.
// Players are anonymous: the browser keeps a random id + secret token in localStorage.
import { DurableObject } from 'cloudflare:workers';
import { cleanName, cleanTeamName, type LobbyClientMsg, type NetMode } from '../src/net/protocol';
import { json, randomCode, randomHex, type Env, type MatchReport } from './env';

type PlayerRow = {
  id: string;
  token: string;
  name: string;
  mmr: number;
  wins: number;
  losses: number;
  goals: number;
  saves: number;
  assists: number;
  shots: number;
  games: number;
  team_id: string | null;
};

type TeamRow = {
  id: string;
  name: string;
  code: string;
  captain: string;
  rating: number;
  wins: number;
  losses: number;
};

/** Per-socket state, kept on the socket so it survives hibernation. */
interface SocketState {
  id: string;
  name: string;
  teamId: string | null;
  queue: NetMode | 'team' | null;
  since: number;
}

const MAX_TEAM = 3;
const BOT_FILL_AFTER_MS = 20_000;

export class Lobby extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
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
  private player(id: string | null): PlayerRow | null {
    if (!id) return null;
    const rows = this.sql.exec<PlayerRow>('SELECT * FROM players WHERE id = ?', id).toArray();
    return rows[0] ?? null;
  }

  private authed(req: Request, url: URL): PlayerRow | null {
    const id = req.headers.get('x-player-id') ?? url.searchParams.get('id');
    const token = req.headers.get('x-player-token') ?? url.searchParams.get('token');
    const p = this.player(id);
    if (!p || !token || token.length !== p.token.length) return null;
    let diff = 0;
    for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ p.token.charCodeAt(i);
    return diff === 0 ? p : null;
  }

  private team(id: string | null): TeamRow | null {
    if (!id) return null;
    return this.sql.exec<TeamRow>('SELECT id, name, code, captain, rating, wins, losses FROM teams WHERE id = ?', id).toArray()[0] ?? null;
  }

  private teamMembers(teamId: string) {
    const online = new Set(this.sockets().map((s) => s.att.id));
    return this.sql
      .exec<{ id: string; name: string }>('SELECT id, name FROM players WHERE team_id = ? ORDER BY created', teamId)
      .toArray()
      .map((m) => ({ id: m.id, name: m.name, online: online.has(m.id) }));
  }

  private publicPlayer(p: PlayerRow) {
    return { id: p.id, name: p.name, mmr: p.mmr, wins: p.wins, losses: p.losses, goals: p.goals, saves: p.saves, assists: p.assists, shots: p.shots, games: p.games, teamId: p.team_id };
  }

  private sockets(): { ws: WebSocket; att: SocketState }[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === WebSocket.OPEN)
      .map((ws) => ({ ws, att: ws.deserializeAttachment() as SocketState }));
  }

  private send(ws: WebSocket, msg: unknown) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket closing */
    }
  }

  private sendTo(playerId: string, msg: unknown) {
    for (const s of this.sockets()) if (s.att.id === playerId) this.send(s.ws, msg);
  }

  private broadcastTeam(teamId: string | null) {
    if (!teamId) return;
    const members = this.teamMembers(teamId);
    const queued = this.sockets().some((s) => s.att.teamId === teamId && s.att.queue === 'team');
    for (const s of this.sockets()) if (s.att.teamId === teamId) this.send(s.ws, { t: 'team', members, queued });
  }

  /** Update the stored socket state for every socket of a player. */
  private patchPlayerSockets(playerId: string, patch: Partial<SocketState>) {
    for (const s of this.sockets()) {
      if (s.att.id !== playerId) continue;
      s.ws.serializeAttachment({ ...s.att, ...patch });
    }
  }

  // ------------------------------------------------------------------ HTTP
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/api/lobby') {
      if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'Expected a WebSocket' }, 426);
      const p = this.authed(req, url);
      if (!p) return json({ error: 'Not signed in' }, 401);
      const pair = new WebSocketPair();
      const att: SocketState = { id: p.id, name: p.name, teamId: p.team_id, queue: null, since: 0 };
      this.ctx.acceptWebSocket(pair[1], [p.id]);
      pair[1].serializeAttachment(att);
      this.send(pair[1], { t: 'hello', online: new Set(this.sockets().map((s) => s.att.id)).size });
      this.broadcastTeam(p.team_id);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (path === '/api/register' && req.method === 'POST') {
      const body = await req.json<{ name?: string }>().catch(() => ({}) as { name?: string });
      const name = cleanName(body.name) ?? `Player${Math.floor(1000 + Math.random() * 9000)}`;
      const id = randomHex(8);
      const token = randomHex(24);
      this.sql.exec('INSERT INTO players(id, token, name, created) VALUES(?, ?, ?, ?)', id, token, name, Date.now());
      return json({ id, token, name });
    }

    if (path === '/api/leaderboard') {
      const players = this.sql
        .exec<PlayerRow>('SELECT * FROM players WHERE games > 0 ORDER BY mmr DESC, wins DESC LIMIT 50')
        .toArray()
        .map((p) => this.publicPlayer(p));
      const teams = this.sql
        .exec<TeamRow & { members: number }>(
          `SELECT t.id, t.name, t.rating, t.wins, t.losses, (SELECT COUNT(*) FROM players p WHERE p.team_id = t.id) AS members
           FROM teams t ORDER BY t.rating DESC, t.wins DESC LIMIT 50`,
        )
        .toArray()
        .map((t) => ({ id: t.id, name: t.name, rating: t.rating, wins: t.wins, losses: t.losses, members: t.members }));
      return json({ players, teams });
    }

    // everything below needs a signed-in player
    const me = this.authed(req, url);
    if (!me) return json({ error: 'Not signed in' }, 401);
    const body = req.method === 'POST' ? await req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>) : {};

    switch (path) {
      case '/api/me': {
        const team = this.team(me.team_id);
        return json({ player: this.publicPlayer(me), team: team ? { ...team, members: this.teamMembers(team.id) } : null });
      }
      case '/api/name': {
        const name = cleanName(body.name);
        if (!name) return json({ error: 'Names are 2–16 letters, numbers, spaces, dots, dashes or underscores.' }, 400);
        this.sql.exec('UPDATE players SET name = ? WHERE id = ?', name, me.id);
        this.patchPlayerSockets(me.id, { name });
        this.broadcastTeam(me.team_id);
        return json({ name });
      }
      case '/api/team/create': {
        if (me.team_id) return json({ error: 'Leave your current team first.' }, 400);
        const name = cleanTeamName(body.name);
        if (!name) return json({ error: 'Team names are 3–20 letters, numbers or spaces.' }, 400);
        const key = name.toLowerCase();
        if (this.sql.exec('SELECT 1 FROM teams WHERE name_key = ?', key).toArray().length) return json({ error: 'That team name is taken.' }, 409);
        const id = randomHex(8);
        let code = randomCode(6);
        while (this.sql.exec('SELECT 1 FROM teams WHERE code = ?', code).toArray().length) code = randomCode(6);
        this.sql.exec('INSERT INTO teams(id, name, name_key, code, captain, created) VALUES(?, ?, ?, ?, ?, ?)', id, name, key, code, me.id, Date.now());
        this.sql.exec('UPDATE players SET team_id = ? WHERE id = ?', id, me.id);
        this.patchPlayerSockets(me.id, { teamId: id });
        this.broadcastTeam(id);
        return json({ team: { ...this.team(id), members: this.teamMembers(id) } });
      }
      case '/api/team/join': {
        if (me.team_id) return json({ error: 'Leave your current team first.' }, 400);
        const code = String(body.code ?? '').trim().toUpperCase();
        const team = this.sql.exec<TeamRow>('SELECT id, name, code, captain, rating, wins, losses FROM teams WHERE code = ?', code).toArray()[0];
        if (!team) return json({ error: 'No team has that code.' }, 404);
        const count = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM players WHERE team_id = ?', team.id).one().n;
        if (count >= MAX_TEAM) return json({ error: `That team is full (${MAX_TEAM} players).` }, 409);
        this.sql.exec('UPDATE players SET team_id = ? WHERE id = ?', team.id, me.id);
        this.patchPlayerSockets(me.id, { teamId: team.id });
        this.broadcastTeam(team.id);
        return json({ team: { ...team, members: this.teamMembers(team.id) } });
      }
      case '/api/team/leave': {
        const teamId = me.team_id;
        if (!teamId) return json({ ok: true });
        this.sql.exec('UPDATE players SET team_id = NULL WHERE id = ?', me.id);
        this.patchPlayerSockets(me.id, { teamId: null, queue: null });
        const left = this.sql.exec<{ id: string }>('SELECT id FROM players WHERE team_id = ? ORDER BY created', teamId).toArray();
        if (!left.length) this.sql.exec('DELETE FROM teams WHERE id = ?', teamId);
        else this.sql.exec('UPDATE teams SET captain = ? WHERE id = ? AND captain = ?', left[0].id, teamId, me.id);
        for (const s of this.sockets()) if (s.att.teamId === teamId && s.att.queue === 'team') s.ws.serializeAttachment({ ...s.att, queue: null });
        this.broadcastTeam(teamId);
        return json({ ok: true });
      }
      case '/api/room/create': {
        const mode: NetMode = body.mode === '2v2' ? '2v2' : '1v1';
        const code = await this.createRoom('private', mode, [], me.id);
        return json({ code });
      }
    }
    return json({ error: 'Not found' }, 404);
  }

  // ------------------------------------------------------------------ rooms
  private async createRoom(
    kind: 'private' | 'quick' | 'team',
    mode: NetMode,
    slots: { id: string; team: 0 | 1 }[],
    hostId: string,
    teamBattle?: { blue: string; orange: string },
    teamNames?: [string, string],
  ): Promise<string> {
    let code = randomCode(5);
    while (this.sql.exec('SELECT 1 FROM rooms WHERE code = ?', code).toArray().length) code = randomCode(5);
    this.sql.exec('INSERT INTO rooms(code, created) VALUES(?, ?)', code, Date.now());
    const stub = this.env.ROOM.get(this.env.ROOM.idFromName(code));
    await stub.setup({ code, kind, mode, hostId, slots, teamBattle, teamNames, started: false, reported: false });
    return code;
  }

  /** Called by Room objects to check a joining player's credentials. */
  async verify(id: string, token: string): Promise<{ id: string; name: string } | null> {
    const p = this.player(id);
    if (!p || p.token !== token) return null;
    return { id: p.id, name: p.name };
  }

  /** Called by a Room when its host reports the final result. Applied once per room. */
  async reportResult(r: MatchReport): Promise<void> {
    const room = this.sql.exec<{ reported: number }>('SELECT reported FROM rooms WHERE code = ?', r.code).toArray()[0];
    if (!room || room.reported) return;
    this.sql.exec('UPDATE rooms SET reported = 1 WHERE code = ?', r.code);
    const winner: 0 | 1 = r.score[0] > r.score[1] ? 0 : 1;
    const humans = r.players.map((p) => ({ ...p, row: this.player(p.id) })).filter((p) => p.row);
    // Elo on team averages (empty or bot-filled slots count as 1000)
    const avg = (team: 0 | 1) => {
      const ms = humans.filter((h) => h.team === team).map((h) => h.row!.mmr);
      const size = r.mode === '2v2' ? 2 : 1;
      while (ms.length < size) ms.push(1000);
      return ms.reduce((a, b) => a + b, 0) / ms.length;
    };
    const ratings: [number, number] = [avg(0), avg(1)];
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
        h.id,
      );
    }
    if (r.teamBattle) {
      const blue = this.team(r.teamBattle.blue);
      const orange = this.team(r.teamBattle.orange);
      if (blue && orange) {
        const eb = 1 / (1 + 10 ** ((orange.rating - blue.rating) / 400));
        const db = Math.round(32 * ((winner === 0 ? 1 : 0) - eb));
        this.sql.exec('UPDATE teams SET rating = MAX(0, rating + ?), wins = wins + ?, losses = losses + ? WHERE id = ?', db, winner === 0 ? 1 : 0, winner === 0 ? 0 : 1, blue.id);
        this.sql.exec('UPDATE teams SET rating = MAX(0, rating - ?), wins = wins + ?, losses = losses + ? WHERE id = ?', db, winner === 1 ? 1 : 0, winner === 1 ? 0 : 1, orange.id);
      }
    }
  }

  // ------------------------------------------------------------------ matchmaking sockets
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > 2000) return;
    let msg: LobbyClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() as SocketState;
    switch (msg.t) {
      case 'queue':
        if (msg.mode !== '1v1' && msg.mode !== '2v2') return;
        this.patchPlayerSockets(att.id, { queue: msg.mode, since: Date.now() });
        break;
      case 'cancel':
        this.patchPlayerSockets(att.id, { queue: null });
        this.send(ws, { t: 'queue', mode: null, waiting: 0, since: 0 });
        break;
      case 'teamQueue': {
        if (!att.teamId) return this.send(ws, { t: 'error', message: 'Join or create a team first.' });
        const online = new Set(this.sockets().filter((s) => s.att.teamId === att.teamId).map((s) => s.att.id));
        if (online.size < 2) return this.send(ws, { t: 'error', message: 'Both teammates need to be online on the Teams tab.' });
        this.patchPlayerSockets(att.id, { queue: 'team', since: Date.now() });
        this.broadcastTeam(att.teamId);
        break;
      }
      case 'teamCancel':
        for (const s of this.sockets()) if (s.att.teamId === att.teamId && s.att.queue === 'team') s.ws.serializeAttachment({ ...s.att, queue: null });
        this.broadcastTeam(att.teamId);
        break;
      case 'ping':
        return;
    }
    await this.matchmake();
  }

  async webSocketClose(ws: WebSocket) {
    const att = ws.deserializeAttachment() as SocketState;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    this.broadcastTeam(att.teamId);
    await this.matchmake();
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    await this.matchmake();
  }

  private async matchmake() {
    const now = Date.now();
    const all = this.sockets().filter((s) => s.ws.readyState === WebSocket.OPEN);
    const byId = new Map<string, SocketState>();
    for (const s of all) if (!byId.has(s.att.id) || s.att.queue) byId.set(s.att.id, s.att);
    const queue = (mode: SocketState['queue']) => [...byId.values()].filter((a) => a.queue === mode).sort((a, b) => a.since - b.since);
    const matched = async (ids: string[], code: string, mode: NetMode, kind: 'quick' | 'team') => {
      for (const id of ids) {
        this.patchPlayerSockets(id, { queue: null });
        byId.delete(id);
        this.sendTo(id, { t: 'matched', code, mode, kind });
      }
    };

    // 1v1
    let q = queue('1v1');
    while (q.length >= 2) {
      const [a, b] = q.splice(0, 2);
      const code = await this.createRoom('quick', '1v1', [{ id: a.id, team: 0 }, { id: b.id, team: 1 }], a.id);
      await matched([a.id, b.id], code, '1v1', 'quick');
    }
    // 2v2 solo queue (bots fill in after a wait)
    q = queue('2v2');
    while (q.length >= 4 || (q.length >= 2 && now - q[0].since > BOT_FILL_AFTER_MS)) {
      const group = q.splice(0, Math.min(4, q.length));
      const slots = group.map((p, i) => ({ id: p.id, team: (i % 2) as 0 | 1 }));
      const code = await this.createRoom('quick', '2v2', slots, group[0].id);
      await matched(group.map((p) => p.id), code, '2v2', 'quick');
    }
    // team battles: pair the two longest-waiting teams that have two members online
    const teamWaits = new Map<string, number>();
    for (const a of queue('team')) if (a.teamId) teamWaits.set(a.teamId, Math.min(teamWaits.get(a.teamId) ?? Infinity, a.since));
    const readyTeams = [...teamWaits.entries()]
      .map(([teamId, since]) => ({ teamId, since, members: [...new Set(all.filter((s) => s.att.teamId === teamId).map((s) => s.att.id))] }))
      .filter((t) => t.members.length >= 2)
      .sort((a, b) => a.since - b.since);
    while (readyTeams.length >= 2) {
      const [ta, tb] = readyTeams.splice(0, 2);
      const blue = ta.members.slice(0, 2);
      const orange = tb.members.slice(0, 2);
      const slots = [...blue.map((id) => ({ id, team: 0 as const })), ...orange.map((id) => ({ id, team: 1 as const }))];
      const names: [string, string] = [this.team(ta.teamId)?.name ?? 'Blue', this.team(tb.teamId)?.name ?? 'Orange'];
      const code = await this.createRoom('team', '2v2', slots, blue[0], { blue: ta.teamId, orange: tb.teamId }, names);
      for (const t of [ta, tb]) for (const s of all) if (s.att.teamId === t.teamId) s.ws.serializeAttachment({ ...(s.ws.deserializeAttachment() as SocketState), queue: null });
      await matched([...blue, ...orange], code, '2v2', 'team');
      this.broadcastTeam(ta.teamId);
      this.broadcastTeam(tb.teamId);
    }

    // queue status for everyone still waiting
    let anyWaiting = false;
    for (const s of this.sockets()) {
      if (!s.att.queue) continue;
      anyWaiting = true;
      const waiting = new Set(this.sockets().filter((o) => o.att.queue === s.att.queue).map((o) => (s.att.queue === 'team' ? o.att.teamId : o.att.id))).size;
      this.send(s.ws, { t: 'queue', mode: s.att.queue, waiting, since: s.att.since });
    }
    if (anyWaiting) await this.ctx.storage.setAlarm(now + 5000);
  }
}

function clampStat(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(n, 50)) : 0;
}
