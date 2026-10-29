// Shared between the game client and the Cloudflare Worker (worker/*.ts).
// Messages are small JSON objects with a `t` (type) field.

export type NetMode = '1v1' | '2v2';
export type NetTeam = 0 | 1;

export interface RosterPlayer {
  id: string;
  name: string;
  team: NetTeam;
  design?: unknown; // CarDesign, validated on receipt
}

export interface RoomInfo {
  t: 'roster';
  code: string;
  mode: NetMode;
  kind: 'private' | 'quick' | 'team';
  hostId: string;
  started: boolean;
  players: RosterPlayer[];
  teamNames?: [string, string];
  /** Matched rooms: how many players are expected to join. */
  expected?: number;
}

/** A bot slot the host fills when starting. */
export interface BotSlot {
  id: string;
  name: string;
  team: NetTeam;
}

// ---- car state packing -------------------------------------------------
// [x,y,z, qx,qy,qz,qw, vx,vy,vz, wx,wy,wz, boost, flags, steer]
export const CAR_STATE_LEN = 16;
export const FLAG_BOOST = 1;
export const FLAG_SUPERSONIC = 2;
export const FLAG_GROUND = 4;
export const FLAG_DEMOLISHED = 8;

const r3 = (v: number) => Math.round(v * 1000) / 1000;
export function packNumbers(a: number[]): number[] {
  return a.map(r3);
}

// ---- lobby (matchmaking) messages ----------------------------------------
export type LobbyClientMsg =
  | { t: 'queue'; mode: NetMode }
  | { t: 'cancel' }
  | { t: 'teamQueue' }
  | { t: 'teamCancel' }
  | { t: 'ping' };

export type LobbyServerMsg =
  | { t: 'hello'; online: number }
  | { t: 'queue'; mode: NetMode | 'team' | null; waiting: number; since: number }
  | { t: 'matched'; code: string; mode: NetMode; kind: 'quick' | 'team' }
  | { t: 'team'; members: { id: string; name: string; online: boolean }[]; queued: boolean }
  | { t: 'error'; message: string };

export const NAME_RE = /^[A-Za-z0-9 _.\-]{2,16}$/;
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/\s+/g, ' ');
  return NAME_RE.test(s) ? s : null;
}
export const TEAM_NAME_RE = /^[A-Za-z0-9 _.\-]{3,20}$/;
export function cleanTeamName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/\s+/g, ' ');
  return TEAM_NAME_RE.test(s) ? s : null;
}
