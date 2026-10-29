// Room Durable Object: one per match. Relays game messages between players.
// The host's browser runs the authoritative simulation (ball, score, clock); every other
// player simulates their own car and streams its state. The room only forwards messages,
// enforces who may send host-only messages, and reports the final result to the Lobby.
import { DurableObject } from 'cloudflare:workers';
import type { RoomInfo, RosterPlayer } from '../src/net/protocol';
import { json, type Env, type RoomConfig } from './env';

interface SocketState {
  id: string;
  name: string;
  team: 0 | 1;
  design: unknown;
  joined: number;
}

const RELAY_ANY = new Set(['car', 'touch', 'pad', 'chat']);
const RELAY_HOST = new Set(['world', 'kickoff', 'go', 'goal', 'demo', 'end', 'start']);

export class Room extends DurableObject<Env> {
  private cfg: RoomConfig | null = null;

  private async config(): Promise<RoomConfig | null> {
    if (!this.cfg) this.cfg = (await this.ctx.storage.get<RoomConfig>('cfg')) ?? null;
    return this.cfg;
  }

  private async save(cfg: RoomConfig) {
    this.cfg = cfg;
    await this.ctx.storage.put('cfg', cfg);
  }

  /** Called by the Lobby when it creates the room. */
  async setup(cfg: RoomConfig) {
    await this.save(cfg);
    // tidy up abandoned rooms after a few hours
    await this.ctx.storage.setAlarm(Date.now() + 4 * 3600_000);
  }

  async alarm() {
    if (this.ctx.getWebSockets().length) {
      await this.ctx.storage.setAlarm(Date.now() + 3600_000);
      return;
    }
    await this.ctx.storage.deleteAll();
    this.cfg = null;
  }

  private sockets() {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === WebSocket.OPEN)
      .map((ws) => ({ ws, att: ws.deserializeAttachment() as SocketState }));
  }

  private roster(): RosterPlayer[] {
    const seen = new Map<string, RosterPlayer>();
    for (const s of this.sockets().sort((a, b) => a.att.joined - b.att.joined)) {
      seen.set(s.att.id, { id: s.att.id, name: s.att.name, team: s.att.team, design: s.att.design });
    }
    return [...seen.values()];
  }

  private async broadcastRoster() {
    const cfg = await this.config();
    if (!cfg) return;
    const info: RoomInfo = {
      t: 'roster',
      code: cfg.code,
      mode: cfg.mode,
      kind: cfg.kind,
      hostId: cfg.hostId,
      started: cfg.started,
      players: this.roster(),
      teamNames: cfg.teamNames,
      expected: cfg.kind === 'private' ? undefined : cfg.slots.length,
    };
    const msg = JSON.stringify(info);
    for (const s of this.sockets()) this.safeSend(s.ws, msg);
  }

  private safeSend(ws: WebSocket, msg: string) {
    try {
      ws.send(msg);
    } catch {
      /* closing */
    }
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'Expected a WebSocket' }, 426);
    const cfg = await this.config();
    if (!cfg) return json({ error: 'That room does not exist (check the code).' }, 404);
    const url = new URL(req.url);
    const id = url.searchParams.get('id') ?? '';
    const token = url.searchParams.get('token') ?? '';
    const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName('global'));
    const who = await lobby.verify(id, token);
    if (!who) return json({ error: 'Not signed in' }, 401);

    const roster = this.roster();
    const already = roster.find((p) => p.id === id);
    let team: 0 | 1;
    if (cfg.kind !== 'private') {
      const slot = cfg.slots.find((s) => s.id === id);
      if (!slot) return json({ error: 'You are not part of this match.' }, 403);
      team = slot.team;
    } else if (already) {
      team = already.team;
    } else {
      if (cfg.started) return json({ error: 'That match has already started.' }, 409);
      const per = cfg.mode === '1v1' ? 1 : 2;
      const count = (t: 0 | 1) => roster.filter((p) => p.team === t).length;
      if (count(0) < per && count(0) <= count(1)) team = 0;
      else if (count(1) < per) team = 1;
      else if (count(0) < per) team = 0;
      else return json({ error: 'That room is full.' }, 409);
    }
    // one socket per player: replace older connections
    for (const s of this.sockets()) if (s.att.id === id) s.ws.close(4000, 'Replaced by a newer connection');

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [id]);
    const att: SocketState = { id, name: who.name, team, design: null, joined: Date.now() };
    pair[1].serializeAttachment(att);
    // private room whose host is gone: the first player in becomes host
    if (cfg.kind === 'private' && !cfg.started && !this.sockets().some((s) => s.att.id === cfg.hostId)) {
      await this.save({ ...cfg, hostId: id });
    }
    await this.broadcastRoster();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > 12000) return;
    const att = ws.deserializeAttachment() as SocketState;
    const m = raw.match(/^\{"t":"(\w+)"/);
    if (!m) return;
    const type = m[1];
    const cfg = await this.config();
    if (!cfg) return;
    const isHost = att.id === cfg.hostId;

    // fast path: relay gameplay traffic with an authentic sender id
    if (RELAY_ANY.has(type) || (RELAY_HOST.has(type) && isHost)) {
      if (type === 'start') {
        if (cfg.started) return;
        await this.save({ ...cfg, started: true });
      }
      const out = `{"f":"${att.id}","d":${raw}}`;
      for (const s of this.sockets()) if (s.ws !== ws) this.safeSend(s.ws, out);
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (type) {
      case 'hello': {
        const design = raw.length < 3000 ? msg.design : null;
        ws.serializeAttachment({ ...att, design });
        await this.broadcastRoster();
        break;
      }
      case 'setTeam': {
        if (cfg.kind !== 'private' || cfg.started) return;
        const team = msg.team === 1 ? 1 : 0;
        const per = cfg.mode === '1v1' ? 1 : 2;
        if (this.roster().filter((p) => p.team === team && p.id !== att.id).length >= per) return;
        ws.serializeAttachment({ ...att, team });
        await this.broadcastRoster();
        break;
      }
      case 'setMode': {
        if (cfg.kind !== 'private' || cfg.started || !isHost) return;
        const mode = msg.mode === '2v2' ? '2v2' : '1v1';
        await this.save({ ...cfg, mode });
        // squeeze players into the new team sizes
        if (mode === '1v1') {
          const seen: Record<number, number> = { 0: 0, 1: 0 };
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
      case 'result': {
        if (!isHost || cfg.reported) return;
        await this.save({ ...cfg, reported: true });
        const score = Array.isArray(msg.score) ? [Number(msg.score[0]) || 0, Number(msg.score[1]) || 0] : [0, 0];
        const stats = (msg.stats ?? {}) as Record<string, { goals?: number; saves?: number; assists?: number; shots?: number }>;
        const players = this.roster().map((p) => ({
          id: p.id,
          team: p.team,
          goals: Number(stats[p.id]?.goals) || 0,
          saves: Number(stats[p.id]?.saves) || 0,
          assists: Number(stats[p.id]?.assists) || 0,
          shots: Number(stats[p.id]?.shots) || 0,
        }));
        const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName('global'));
        await lobby.reportResult({ code: cfg.code, mode: cfg.mode, teamBattle: cfg.teamBattle, score: score as [number, number], players });
        break;
      }
    }
  }

  async webSocketClose(ws: WebSocket) {
    const att = ws.deserializeAttachment() as SocketState;
    try {
      ws.close();
    } catch {
      /* already closed */
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
        const msg = JSON.stringify({ t: 'hostLeft' });
        for (const s of this.sockets()) if (s.ws !== ws) this.safeSend(s.ws, msg);
      }
    }
    await this.broadcastRoster();
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }
}
