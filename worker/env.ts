import type { Lobby } from './lobby';
import type { Room } from './room';

export interface Env {
  LOBBY: DurableObjectNamespace<Lobby>;
  ROOM: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
}

export interface RoomConfig {
  code: string;
  kind: 'private' | 'quick' | 'team';
  mode: '1v1' | '2v2';
  hostId: string;
  /** Matched rooms: who may join and on which side. Empty for private rooms. */
  slots: { id: string; team: 0 | 1 }[];
  teamBattle?: { blue: string; orange: string };
  teamNames?: [string, string];
  started: boolean;
  reported: boolean;
}

export interface MatchReport {
  code: string;
  mode: '1v1' | '2v2';
  teamBattle?: { blue: string; orange: string };
  score: [number, number];
  players: { id: string; team: 0 | 1; goals: number; saves: number; assists: number; shots: number }[];
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export function randomCode(len: number): string {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return [...a].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}
