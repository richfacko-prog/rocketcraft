// Client side of the Racecraft online API (served by the Cloudflare Worker on the same site).
import type { NetMode } from './protocol';

export interface Identity {
  id: string;
  token: string;
  name: string;
}

export interface PlayerProfile {
  id: string;
  name: string;
  mmr: number;
  wins: number;
  losses: number;
  goals: number;
  saves: number;
  assists: number;
  shots: number;
  games: number;
  teamId: string | null;
}

export interface TeamInfo {
  id: string;
  name: string;
  code: string;
  captain: string;
  rating: number;
  wins: number;
  losses: number;
  members: { id: string; name: string; online: boolean }[];
}

export interface Leaderboard {
  players: PlayerProfile[];
  teams: { id: string; name: string; rating: number; wins: number; losses: number; members: number }[];
}

const KEY = 'racecraft.identity.v1';

export class ApiError extends Error {}

export class Api {
  identity: Identity | null = null;

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const v = JSON.parse(raw);
        if (typeof v?.id === 'string' && typeof v?.token === 'string') this.identity = { id: v.id, token: v.token, name: String(v.name ?? '') };
      }
    } catch {
      /* storage unavailable: a new identity is created per session */
    }
  }

  private save() {
    try {
      if (this.identity) localStorage.setItem(KEY, JSON.stringify(this.identity));
    } catch {
      /* ignore */
    }
  }

  wsBase(): string {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  }

  private async call<T>(path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.identity) {
      headers['x-player-id'] = this.identity.id;
      headers['x-player-token'] = this.identity.token;
    }
    let res: Response;
    try {
      res = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError('Can’t reach the Racecraft server. Check your connection and try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Server error (${res.status})`);
    return data as T;
  }

  /** Make sure we have a player identity (creates one on first use). */
  async ensure(name?: string): Promise<Identity> {
    if (this.identity) {
      try {
        await this.me();
        return this.identity;
      } catch (e) {
        if (!(e instanceof ApiError) || !/signed in/i.test(e.message)) throw e;
        this.identity = null; // server forgot us (e.g. reset): register again
      }
    }
    const r = await this.call<Identity>('register', { name });
    this.identity = r;
    this.save();
    return r;
  }

  me() {
    return this.call<{ player: PlayerProfile; team: TeamInfo | null }>('me');
  }

  async rename(name: string) {
    const r = await this.call<{ name: string }>('name', { name });
    if (this.identity) {
      this.identity.name = r.name;
      this.save();
    }
    return r.name;
  }

  leaderboard() {
    return this.call<Leaderboard>('leaderboard');
  }
  createTeam(name: string) {
    return this.call<{ team: TeamInfo }>('team/create', { name });
  }
  joinTeam(code: string) {
    return this.call<{ team: TeamInfo }>('team/join', { code });
  }
  leaveTeam() {
    return this.call<{ ok: true }>('team/leave', {});
  }
  createRoom(mode: NetMode) {
    return this.call<{ code: string }>('room/create', { mode });
  }
}

/** Small JSON WebSocket wrapper. */
export class Socket {
  private ws: WebSocket | null = null;
  private inbox: unknown[] = [];
  onMessage: ((m: unknown) => void) | null = null;
  onClose: ((code: number, reason: string) => void) | null = null;
  onOpen: (() => void) | null = null;
  closedByUs = false;

  constructor(public url: string) {}

  connect() {
    this.closedByUs = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => this.onOpen?.();
    ws.onmessage = (e) => {
      let m: unknown;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (this.onMessage) this.onMessage(m);
      else this.inbox.push(m);
    };
    ws.onclose = (e) => {
      if (this.ws === ws) this.ws = null;
      this.onClose?.(e.code, e.reason);
    };
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(m: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** Take queued messages (when no onMessage handler is set). */
  drain(): unknown[] {
    const out = this.inbox;
    this.inbox = [];
    return out;
  }

  close() {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
  }
}
