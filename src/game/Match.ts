import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { ARENA, BALL, DT, MATCH_LENGTH, TEAM_COLORS, TEAM_NAMES, Team, rlToWorld } from './Config';
import { Arena } from './Arena';
import { Ball } from './Ball';
import { Car, CarSnapshot } from './Car';
import { AIController, Difficulty } from './AI';
import { Controls, Input } from './Input';
import { GameCamera } from './Camera';
import { HUD } from './HUD';
import { GameAudio } from './Audio';
import { Particles } from './Particles';
import { CarDesign, botDesign, loadDesign, validateDesign } from './CarDesign';
import type { Socket } from '../net/api';
import { packNumbers, type BotSlot, type RosterPlayer } from '../net/protocol';

export type Mode = '1v1' | '2v2';
type State = 'idle' | 'countdown' | 'playing' | 'goal' | 'replay' | 'ended';

interface Frame {
  bp: [number, number, number];
  bq: [number, number, number, number];
  cars: CarSnapshot[];
}

const BLUE_KICKOFFS: [number, number][] = [
  [-2048, -2560],
  [2048, -2560],
  [-256, -3840],
  [256, -3840],
  [0, -4608],
];

export interface EndResult {
  score: [number, number];
  cars: { id?: string; name: string; team: Team; isPlayer: boolean; goals: number; shots: number; saves: number; assists: number; demos: number; score: number }[];
  winner: Team;
  online?: boolean;
}

export interface OnlineSetup {
  room: Socket;
  selfId: string;
  hostId: string;
  roster: RosterPlayer[];
  bots: BotSlot[];
  mode: Mode;
  difficulty: Difficulty;
}

interface OnlineState {
  room: Socket;
  selfId: string;
  hostId: string;
  isHost: boolean;
  byId: Map<string, Car>;
  humans: Set<string>;
  sendAcc: number;
  world: { b: number[]; at: number } | null;
  lastLocalTouch: number;
  padTaken: Map<number, number>;
}

/** Network send rate (messages per second per player). */
const NET_HZ = 20;

function hashId(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export class Match {
  world: RAPIER.World;
  arena: Arena;
  ball: Ball;
  cars: Car[] = [];
  player!: Car;
  ais: AIController[] = [];
  particles: Particles;
  cam: GameCamera;
  hud = new HUD();
  audio = new GameAudio();
  input = new Input();

  state: State = 'idle';
  paused = false;
  score: [number, number] = [0, 0];
  clock = MATCH_LENGTH;
  overtime = false;
  private stateTimer = 0;
  private time = 0;
  private acc = 0;
  private kickoff = true;
  private lastTouch: Car | null = null;
  private prevTouch: Car | null = null;
  private prevTouchTime = -10;
  private threat: [boolean, boolean] = [false, false];
  private shotCredited: Car | null = null;
  private frames: Frame[] = [];
  private replayFrames: Frame[] = [];
  private replayPos = 0;
  private lastCount = -1;
  private waitingForGround = false;
  private bumpCooldown = new Map<string, number>();
  private goalScoredBy: Team = 0;
  difficulty: Difficulty = 'pro';
  /** The local player's garage design, applied when a match starts. */
  playerDesign: CarDesign = loadDesign();
  mode: Mode = '1v1';
  /** Debug/test hook: when set, replaces the local player's input. */
  overrideControls: Controls | null = null;
  onEnd: (r: EndResult) => void = () => {};
  /** Online match stopped early (host left, connection lost). */
  onAbort: (reason: string) => void = () => {};
  online: OnlineState | null = null;
  onPauseToggle: (p: boolean) => void = () => {};

  constructor(
    private scene: THREE.Scene,
    aspect: number,
  ) {
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    this.world.timestep = DT;
    this.arena = new Arena(scene, this.world);
    this.ball = new Ball(this.world, scene);
    this.ball.reset();
    this.particles = new Particles(scene);
    this.cam = new GameCamera(aspect);
    this.hud.setBallCam(this.cam.ballCam, this.ballCamKey());
  }

  start(mode: Mode, difficulty: Difficulty) {
    this.online = null;
    this.mode = mode;
    this.difficulty = difficulty;
    for (const c of this.cars) c.dispose(this.scene);
    this.cars = [];
    this.ais = [];
    const names = mode === '1v1' ? [['You'], ['Bot']] : [['You', 'Merlin'], ['Viper', 'Sundown']];
    if (mode === '2v2') {
      // AI names a bit more like the real game
      names[1] = ['Viper', 'Sundown'];
    }
    for (const team of [0, 1] as Team[]) {
      for (let i = 0; i < names[team].length; i++) {
        const isPlayer = team === 0 && i === 0;
        const design = isPlayer ? this.playerDesign : botDesign(team, Math.floor(Math.random() * 1e6) + i * 977);
        const car = new Car(this.world, this.scene, team, names[team][i], isPlayer, design);
        this.cars.push(car);
        if (isPlayer) this.player = car;
        else this.ais.push(new AIController(car, difficulty));
      }
    }
    this.score = [0, 0];
    this.clock = MATCH_LENGTH;
    this.overtime = false;
    this.paused = false;
    this.hud.setScore(0, 0);
    this.hud.setClock(this.clock, false);
    this.hud.show(true);
    this.audio.init();
    this.setupKickoff();
  }

  /** Start an online match. The host simulates the ball/rules; everyone drives their own car. */
  startOnline(o: OnlineSetup) {
    this.mode = o.mode;
    this.difficulty = o.difficulty;
    for (const c of this.cars) c.dispose(this.scene);
    this.cars = [];
    this.ais = [];
    const isHost = o.selfId === o.hostId;
    const byId = new Map<string, Car>();
    const add = (id: string, name: string, team: Team, design: CarDesign, kind: 'self' | 'remote' | 'bot') => {
      const car = new Car(this.world, this.scene, team, name, kind === 'self', design);
      car.netId = id;
      if (kind === 'self') this.player = car;
      if (kind === 'remote' || (kind === 'bot' && !isHost)) car.setRemote(true);
      if (kind === 'bot' && isHost) this.ais.push(new AIController(car, o.difficulty));
      this.cars.push(car);
      byId.set(id, car);
    };
    for (const p of o.roster) add(p.id, p.name, p.team, p.id === o.selfId ? this.playerDesign : validateDesign(p.design), p.id === o.selfId ? 'self' : 'remote');
    for (const b of o.bots) add(b.id, b.name, b.team, botDesign(b.team, hashId(b.id)), 'bot');
    this.online = {
      room: o.room,
      selfId: o.selfId,
      hostId: o.hostId,
      isHost,
      byId,
      humans: new Set(o.roster.map((p) => p.id)),
      sendAcc: 0,
      world: null,
      lastLocalTouch: -10,
      padTaken: new Map(),
    };
    this.score = [0, 0];
    this.clock = MATCH_LENGTH;
    this.overtime = false;
    this.paused = false;
    this.hud.setScore(0, 0);
    this.hud.setClock(this.clock, false);
    this.hud.show(true);
    this.audio.init();
    if (isHost) this.setupKickoff();
    else {
      // wait for the host's kickoff message
      this.state = 'countdown';
      this.stateTimer = 99;
      this.ball.reset();
      this.ball.frozen = true;
      this.player.spawn(this.player.team === 0 ? -60 : 60, 0, this.player.team === 0 ? 0 : Math.PI);
      this.player.frozen = true;
      this.hud.message('…', 'Waiting for the host', 5, 'count');
      this.cam.snapTo(this.player, this.ball.pos);
    }
  }

  quit() {
    if (this.online) {
      this.online.room.close();
      this.online = null;
    }
    this.state = 'idle';
    this.paused = false;
    this.hud.show(false);
    this.hud.replay(false);
    this.hud.clearMessage();
    for (const c of this.cars) c.dispose(this.scene);
    this.cars = [];
    this.ais = [];
    this.ball.reset();
    this.particles.clear();
    this.audio.setEngine(0, 0, false, false, false);
  }

  private setupKickoff() {
    this.state = 'countdown';
    this.stateTimer = 3.0;
    this.lastCount = -1;
    this.kickoff = true;
    this.lastTouch = null;
    this.prevTouch = null;
    this.shotCredited = null;
    this.waitingForGround = false;
    this.ball.reset();
    this.ball.frozen = true;
    this.arena.resetPads();
    this.frames = [];
    this.hud.replay(false);

    const blue = this.cars.filter((c) => c.team === 0);
    const orange = this.cars.filter((c) => c.team === 1);
    let spots: number[];
    if (blue.length === 1) spots = [Math.floor(Math.random() * 5)];
    else {
      const pairs = [
        [0, 1],
        [2, 3],
        [0, 4],
        [1, 4],
        [2, 1],
        [3, 0],
      ];
      spots = pairs[Math.floor(Math.random() * pairs.length)];
      if (Math.random() < 0.5) spots = [spots[1], spots[0]];
    }
    const spawns: Record<string, [number, number, number]> = {};
    const place = (car: Car, spot: number, mirror: boolean) => {
      let [x, z] = rlToWorld(BLUE_KICKOFFS[spot][0], BLUE_KICKOFFS[spot][1]);
      if (mirror) {
        x = -x;
        z = -z;
      }
      const yaw = Math.atan2(z, -x); // face the ball at origin
      spawns[car.netId] = packNumbers([x, z, yaw]) as [number, number, number];
      if (car.remote) return;
      car.spawn(x, z, yaw);
      car.frozen = true;
    };
    blue.forEach((c, i) => place(c, spots[i], false));
    orange.forEach((c, i) => place(c, spots[i], true));
    for (const ai of this.ais) ai.reset();
    for (const c of this.cars) if (!c.remote) c.readState();
    this.cam.snapTo(this.player, this.ball.pos);
    this.netSendNow({ t: 'kickoff', sp: spawns, o: this.overtime, k: this.clock, s: this.score });
  }

  /** Client: the host started a kickoff. */
  private clientKickoff(d: { sp?: Record<string, number[]>; o?: boolean; k?: number; s?: [number, number] }) {
    this.state = 'countdown';
    this.stateTimer = 3.0;
    this.lastCount = -1;
    this.kickoff = true;
    this.overtime = !!d.o;
    if (typeof d.k === 'number') this.clock = d.k;
    if (Array.isArray(d.s)) {
      this.score = [Number(d.s[0]) || 0, Number(d.s[1]) || 0];
      this.hud.setScore(this.score[0], this.score[1]);
    }
    this.ball.reset();
    this.ball.frozen = true;
    this.arena.resetPads();
    this.online!.padTaken.clear();
    this.online!.world = null;
    const sp = d.sp?.[this.online!.selfId];
    if (sp && sp.length === 3 && sp.every(Number.isFinite)) this.player.spawn(sp[0], sp[1], sp[2]);
    this.player.frozen = true;
    this.cam.snapTo(this.player, this.ball.pos);
  }

  private respawn(car: Car) {
    const s = car.team === 0 ? -1 : 1;
    const z = (Math.random() < 0.5 ? -1 : 1) * (6 + Math.random() * 8);
    const x = s * (ARENA.halfLength - 6);
    car.spawn(x, z, Math.atan2(0, -s), 33);
    car.frozen = false;
  }

  /** Called every animation frame with real elapsed time. Returns render alpha. */
  frame(realDt: number): number {
    const dt = Math.min(realDt, 0.1);
    const actions = this.input.consumeActions();
    if (actions.has('mute')) this.audio.toggleMute();
    if (this.state === 'idle') {
      this.cam.updateOrbit(performance.now() / 1000);
      this.arena.followShadows(new THREE.Vector3());
      this.particles.update(dt);
      this.arena.update(dt, performance.now() / 1000);
      this.ball.syncVisual(1, dt);
      return 1;
    }
    if (this.state === 'ended') {
      this.cam.updateOrbit(performance.now() / 1000);
      this.particles.update(dt);
      return 1;
    }
    if (actions.has('pause')) {
      this.paused = !this.paused;
      this.onPauseToggle(this.paused);
      if (this.audio.ctx && !this.online) this.audio.setEngine(0, 0, false, false, false);
    }
    if (this.online) {
      this.netReceive();
      if (!this.online) return 1; // aborted while reading messages
      const st0 = this.state as State;
      if (st0 === 'ended' || st0 === 'idle') return 1;
    } else if (this.paused) return 1; // online matches keep running behind the pause menu
    if (actions.has('ballcam')) {
      this.cam.ballCam = !this.cam.ballCam;
      this.cam.save();
      this.hud.setBallCam(this.cam.ballCam, this.ballCamKey());
    }
    if (actions.has('guide')) this.hud.toggleGuide();
    if (actions.has('camNear')) this.cam.setDistance(this.cam.distance - 0.5);
    if (actions.has('camFar')) this.cam.setDistance(this.cam.distance + 0.5);

    if (this.state === 'replay') {
      this.updateReplay(dt, actions.has('skip'));
      return 1;
    }

    // --- controls ---
    this.player.controls = this.paused ? { ...this.player.controls, throttle: 0, steer: 0, boost: false, jump: false } : this.overrideControls ? { ...this.overrideControls } : this.input.read();
    this.hud.showScoreboard(this.input.scoreboardHeld, this.scoreRows());
    this.ball.predict();
    this.threat = [this.ball.headingIntoGoal(0), this.ball.headingIntoGoal(1)];
    for (const ai of this.ais) ai.car.controls = { ...ai.think(dt, this.time, this.ball, this.cars, this.arena.pads, this.kickoff) };

    // --- state timers ---
    if (this.state === 'countdown') {
      this.stateTimer -= dt;
      const n = Math.ceil(this.stateTimer);
      if (n !== this.lastCount && n > 0) {
        this.lastCount = n;
        this.hud.message(String(n), this.overtime ? 'OVERTIME — NEXT GOAL WINS' : '', 1.0, 'count');
        this.audio.beep(false);
      }
      if (this.stateTimer <= 0 && (!this.online || this.online.isHost)) {
        this.go();
        this.netSendNow({ t: 'go' });
      }
    } else if (this.state === 'playing' && this.online && !this.online.isHost) {
      // clients take the clock from the host
    } else if (this.state === 'playing') {
      if (!this.kickoff) {
        if (this.overtime) this.clock += dt;
        else this.clock = Math.max(0, this.clock - dt);
      }
      if (!this.overtime && this.clock <= 0) {
        if (!this.waitingForGround) {
          this.waitingForGround = true;
          this.hud.toast('0:00 — game ends when the ball hits the ground', '#ff5a5a');
        }
        if (this.ball.pos.y < BALL.radius + 0.25) this.timeUp();
      }
    } else if (this.state === 'goal') {
      this.stateTimer -= dt;
      if (this.stateTimer <= 0 && (!this.online || this.online.isHost)) {
        if (this.overtime || (this.clock <= 0 && this.score[0] !== this.score[1])) this.endMatch();
        else if (this.online) this.setupKickoff(); // no replays online
        else this.startReplay();
      }
    }
    const st = this.state as State;
    if (st === 'ended' || st === 'idle') return 1;
    this.hud.setClock(this.clock, this.overtime);

    // --- fixed-step physics ---
    this.acc += dt;
    let steps = 0;
    while (this.acc >= DT && steps < 12) {
      this.physicsStep();
      this.acc -= DT;
      steps++;
    }
    if (steps >= 12) this.acc = 0;
    const alpha = this.acc / DT;
    if (this.online) {
      this.clientBallCorrection();
      this.netSend(dt);
    }

    // --- visuals ---
    for (const c of this.cars) c.syncVisual(alpha, dt, this.particles, this.time);
    if (this.state !== 'goal') this.ball.syncVisual(alpha, dt);
    this.arena.update(dt, this.time);
    this.particles.update(dt);
    this.cam.lookInput = this.input.readLook();
    this.cam.update(dt, this.player, this.ball.mesh.position);
    // shadow frustum centered between the player and the ball
    const focus = this.ball.mesh.position.clone().sub(this.player.group.position).clampLength(0, 22).add(this.player.group.position);
    this.arena.followShadows(focus);
    this.hud.update(dt, this.player, this.ball.mesh.position, this.cam.camera, this.state !== 'goal', {
      gamepad: this.input.usingGamepad,
      countdown: this.state === 'countdown',
      scheme: this.input.scheme,
    });

    // demolition respawns
    for (const c of this.cars) {
      if (c.demolished && !c.remote) {
        c.update(dt);
        if (c.respawnTimer <= 0) this.respawn(c);
      }
    }
    // audio
    const p = this.player;
    for (const e of p.events) if (e === 'jump' || e === 'flip') this.audio.jump();
    for (const c of this.cars) c.events.length = 0;
    this.audio.setEngine(p.speed, p.controls.throttle, p.boosting, p.supersonic, !p.demolished);
    return alpha;
  }

  private physicsStep() {
    this.time += DT;
    for (const c of this.cars) c.prePhysics(DT, this.time);
    if (this.state !== 'goal') this.ball.prePhysics(DT);
    this.world.step();
    for (const c of this.cars) if (!c.demolished && !c.remote) c.readState();
    this.ball.readState();

    const authority = !this.online || this.online.isHost;
    if (this.state === 'playing' || this.state === 'countdown') {
      // each machine only resolves touches for the cars it simulates
      for (const c of this.cars) {
        if (c.remote) continue;
        const hit = this.ball.collideCar(c, this.time);
        if (!hit) continue;
        this.onBallHit(c, hit.point, hit.normal, hit.strength);
        if (this.online && !this.online.isHost) {
          const b = this.ball;
          this.online.lastLocalTouch = performance.now() / 1000;
          this.netSendNow({ t: 'touch', b: packNumbers([b.pos.x, b.pos.y, b.pos.z, b.vel.x, b.vel.y, b.vel.z, b.angVel.x, b.angVel.y, b.angVel.z]) });
        }
      }
    }
    if (authority) this.carInteractions();
    this.pickupPads();
    if (this.state === 'playing' && authority) this.checkGoal();
    if (!this.online && (this.state === 'playing' || this.state === 'countdown')) this.record();
  }

  private onBallHit(car: Car, point: THREE.Vector3, normal: THREE.Vector3, strength: number) {
    const now = this.time;
    if (this.kickoff) this.kickoff = false;
    if (this.lastTouch !== car) {
      this.prevTouch = this.lastTouch;
      this.prevTouchTime = now;
    }
    this.lastTouch = car;
    if (strength > 2) {
      const d = point.distanceTo(this.cam.camera.position);
      this.audio.hit(strength * THREE.MathUtils.clamp(1.6 - d / 60, 0.3, 1));
      this.particles.sparks(point, normal, strength);
      if (strength > 25 && (car.isPlayer || d < 40)) this.cam.shake(0.08 + strength * 0.004);
      if (strength > 38) this.particles.shockwave(this.ball.pos.clone(), 0xffffff, 2.2 + strength * 0.03, 0.35);
    }
    // stats: shots & saves using predicted path after the hit
    const wasThreat = this.threat[car.team];
    this.ball.predict();
    const opp: Team = car.team === 0 ? 1 : 0;
    const nowThreat = this.ball.headingIntoGoal(car.team);
    if (wasThreat && !nowThreat && strength > 3) {
      car.stats.saves++;
      car.stats.score += 50;
      this.hud.toast(`${car.name} — SAVE!`, car.team === 0 ? '#5aa8ff' : '#ffa24a');
    }
    const shot = this.ball.headingIntoGoal(opp, 3);
    if (shot && this.shotCredited !== car) {
      car.stats.shots++;
      car.stats.score += 20;
      this.shotCredited = car;
      if (car.isPlayer) this.hud.toast('Shot on goal', '#ffffff');
    } else if (!shot) this.shotCredited = null;
    this.threat = [this.ball.headingIntoGoal(0), this.ball.headingIntoGoal(1)];
  }

  private carInteractions() {
    for (let i = 0; i < this.cars.length; i++) {
      for (let j = i + 1; j < this.cars.length; j++) {
        const a = this.cars[i];
        const b = this.cars[j];
        if (a.demolished || b.demolished || a.frozen || b.frozen) continue;
        const d = b.pos.clone().sub(a.pos);
        const dist = d.length();
        if (dist > 2.7) continue;
        d.normalize();
        for (const [att, vic, dir] of [
          [a, b, d],
          [b, a, d.clone().negate()],
        ] as [Car, Car, THREE.Vector3][]) {
          if (att.team === vic.team) continue;
          const toward = att.vel.dot(dir) - vic.vel.dot(dir);
          if (att.supersonic && toward > 14 && att.fwd.dot(dir) > 0.55) {
            this.demolish(vic, att);
            return;
          }
        }
        const key = `${i}-${j}`;
        const rel = a.vel.clone().sub(b.vel).dot(d);
        if (rel > 6 && (this.bumpCooldown.get(key) ?? 0) < this.time) {
          this.bumpCooldown.set(key, this.time + 0.5);
          if (a.isPlayer || b.isPlayer) this.audio.bump();
          this.particles.sparks(a.pos.clone().addScaledVector(d, dist / 2), d, rel);
        }
      }
    }
  }

  private demolish(victim: Car, attacker: Car, fromNet = false) {
    const pos = victim.pos.clone();
    if (!victim.remote) victim.demolish();
    if (!fromNet) this.netSendNow({ t: 'demo', v: victim.netId, a: attacker.netId });
    attacker.stats.demos++;
    attacker.stats.score += 25;
    this.particles.explosion(pos, TEAM_COLORS[victim.team], 0.7);
    const d = pos.distanceTo(this.cam.camera.position);
    if (d < 60 || victim.isPlayer || attacker.isPlayer) this.audio.explosion(false);
    this.cam.shake(victim.isPlayer ? 0.5 : 0.15);
    this.hud.toast(`${attacker.name} demolished ${victim.name}`, attacker.team === 0 ? '#5aa8ff' : '#ffa24a');
  }

  private pickupPads() {
    for (const c of this.cars) {
      if (c.demolished || c.remote || c.boost >= 100) continue;
      this.arena.pads.forEach((pad, i) => {
        if (!pad.active) return;
        const dx = c.pos.x - pad.pos.x;
        const dz = c.pos.z - pad.pos.z;
        if (dx * dx + dz * dz < pad.radius * pad.radius && c.pos.y < 3.2) {
          pad.take();
          c.boost = Math.min(100, c.boost + pad.amount);
          if (c.isPlayer) this.audio.pickup(pad.big);
          if (this.online && !this.online.isHost) {
            this.online.padTaken.set(i, performance.now() / 1000);
            this.netSendNow({ t: 'pad', i });
          }
        }
      });
    }
  }

  private checkGoal() {
    const x = this.ball.pos.x;
    const lim = ARENA.halfLength + BALL.radius;
    if (x > lim) this.goal(0);
    else if (x < -lim) this.goal(1);
  }

  private goal(team: Team) {
    this.score[team]++;
    this.goalScoredBy = team;
    let scorer: Car | null = null;
    if (this.lastTouch && this.lastTouch.team === team) scorer = this.lastTouch;
    else if (this.prevTouch && this.prevTouch.team === team) scorer = this.prevTouch;
    let sub = '';
    if (scorer) {
      scorer.stats.goals++;
      scorer.stats.score += 100;
      if (this.shotCredited !== scorer) {
        scorer.stats.shots++;
        scorer.stats.score += 20;
      }
      sub = `${scorer.name}`;
      if (this.prevTouch && this.prevTouch !== scorer && this.prevTouch.team === team && this.time - this.prevTouchTime < 6) {
        this.prevTouch.stats.assists++;
        this.prevTouch.stats.score += 50;
        sub += ` · assist ${this.prevTouch.name}`;
      }
    } else sub = 'Own goal!';
    const pos = this.ball.pos.clone();
    this.netSendNow({ t: 'goal', team, sub, p: packNumbers([pos.x, pos.y, pos.z]), s: this.score });
    this.goalFx(team, sub, pos);
    // grab replay frames (last ~3.2s)
    const n = Math.round(3.2 / DT);
    this.replayFrames = this.frames.slice(-n);
  }

  /** Explosion, knockback, banner and state change for a goal (used by host and clients). */
  private goalFx(team: Team, sub: string, pos: THREE.Vector3) {
    this.hud.setScore(this.score[0], this.score[1]);
    this.hud.bumpScore(team);
    this.goalScoredBy = team;
    this.particles.explosion(pos, TEAM_COLORS[team], 2.2);
    this.arena.celebrate(team);
    this.audio.explosion(true);
    this.audio.goalHorn();
    this.cam.shake(1.2);
    // shockwave knocks cars back (each machine pushes the cars it simulates)
    for (const c of this.cars) {
      if (c.demolished || c.remote) continue;
      const d = c.pos.clone().sub(pos);
      const dist = d.length();
      const R = 36;
      if (dist < R) {
        const push = d.normalize().multiplyScalar(30 * (1 - dist / R));
        push.y += 7 * (1 - dist / R);
        c.vel.add(push);
        c.body.setLinvel({ x: c.vel.x, y: c.vel.y, z: c.vel.z }, true);
      }
    }
    this.ball.mesh.visible = false;
    this.ball.shadow.visible = false;
    this.ball.frozen = true;
    this.ball.body.setTranslation({ x: 0, y: -20, z: 0 }, true);
    this.ball.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.hud.message(`${TEAM_NAMES[team]} SCORES!`, sub, 3, team === 0 ? 'goal blue' : 'goal orange');
    this.state = 'goal';
    this.stateTimer = 3;
  }

  private timeUp() {
    this.waitingForGround = false;
    if (this.score[0] === this.score[1]) {
      this.overtime = true;
      this.clock = 0;
      this.audio.whistle();
      this.hud.message('OVERTIME', 'Next goal wins', 2.5, 'ot');
      this.setupKickoff();
    } else {
      this.endMatch();
    }
  }

  private startReplay() {
    if (this.replayFrames.length < 10) {
      this.setupKickoff();
      return;
    }
    this.state = 'replay';
    this.replayPos = 0;
    this.hud.replay(true);
    this.hud.hideIndicator();
    this.hud.clearMessage();
    this.ball.mesh.visible = true;
    const f = this.replayFrames[0];
    this.cam.updateReplay(1 / 60, new THREE.Vector3(...f.bp), new THREE.Vector3(1, 0, 0), true);
    this.audio.setEngine(0, 0, false, false, false);
  }

  private updateReplay(dt: number, skip: boolean) {
    const speed = 0.5; // slow motion
    const prevIdx = Math.floor(this.replayPos);
    this.replayPos += (dt * speed) / DT;
    const idx = Math.floor(this.replayPos);
    const frames = this.replayFrames;
    if (skip || idx >= frames.length - 1) {
      if (!skip) this.particles.explosion(new THREE.Vector3(...frames[frames.length - 1].bp), TEAM_COLORS[this.goalScoredBy], 1.0);
      this.hud.replay(false);
      this.setupKickoff();
      return;
    }
    const a = frames[idx];
    const b = frames[Math.min(idx + 1, frames.length - 1)];
    const t = this.replayPos - idx;
    const bp = new THREE.Vector3(...a.bp).lerp(new THREE.Vector3(...b.bp), t);
    const bq = new THREE.Quaternion(...a.bq).slerp(new THREE.Quaternion(...b.bq), t);
    this.ball.setVisualPose(bp, bq);
    const bv = new THREE.Vector3(...b.bp).sub(new THREE.Vector3(...a.bp)).divideScalar(DT);
    this.cars.forEach((c, i) => c.applySnapshot(a.cars[i], this.particles, dt, this.time));
    void prevIdx;
    this.time += dt * speed;
    this.particles.update(dt * speed);
    this.arena.update(dt, this.time);
    this.cam.updateReplay(dt, bp, bv);
    this.arena.followShadows(bp);
  }

  private record() {
    const b = this.ball;
    this.frames.push({
      bp: [b.pos.x, b.pos.y, b.pos.z],
      bq: [b.quat.x, b.quat.y, b.quat.z, b.quat.w],
      cars: this.cars.map((c) => c.snapshot()),
    });
    if (this.frames.length > 5 / DT) this.frames.splice(0, this.frames.length - Math.round(5 / DT));
  }

  private endMatch() {
    this.state = 'ended';
    this.hud.show(false);
    this.hud.replay(false);
    for (const c of this.cars) c.hideFx();
    this.audio.setEngine(0, 0, false, false, false);
    this.audio.whistle();
    const winner: Team = this.score[0] > this.score[1] ? 0 : 1;
    const result: EndResult = {
      score: [...this.score] as [number, number],
      winner,
      online: !!this.online,
      cars: this.cars.map((c) => ({ id: c.netId, name: c.name, team: c.team, isPlayer: c.isPlayer, ...c.stats })),
    };
    if (this.online?.isHost) {
      this.netSendNow({ t: 'end', r: result });
      const stats: Record<string, { goals: number; saves: number; assists: number; shots: number }> = {};
      for (const c of this.cars) if (this.online.humans.has(c.netId)) stats[c.netId] = { goals: c.stats.goals, saves: c.stats.saves, assists: c.stats.assists, shots: c.stats.shots };
      this.netSendNow({ t: 'result', score: this.score, stats });
    }
    this.onEnd(result);
  }

  private go() {
    this.state = 'playing';
    for (const c of this.cars) c.frozen = false;
    this.ball.frozen = false;
    this.hud.message('GO!', '', 0.8, 'go');
    this.audio.beep(true);
  }

  // ------------------------------------------------------------------ online
  private netSendNow(m: unknown) {
    if (this.online) this.online.room.send(m);
  }

  /** Periodic state streaming: the host sends the world, clients send their car. */
  private netSend(dt: number) {
    const o = this.online!;
    o.sendAcc += dt;
    if (o.sendAcc < 1 / NET_HZ) return;
    o.sendAcc = 0;
    if (!o.isHost) {
      o.room.send({ t: 'car', s: this.player.netState() });
      return;
    }
    const b = this.ball;
    const cars: Record<string, number[]> = {};
    const stats: Record<string, number[]> = {};
    for (const c of this.cars) {
      if (!c.remote) cars[c.netId] = c.netState();
      stats[c.netId] = [c.stats.goals, c.stats.assists, c.stats.saves, c.stats.shots, c.stats.score];
    }
    o.room.send({
      t: 'world',
      b: packNumbers([b.pos.x, b.pos.y, b.pos.z, b.quat.x, b.quat.y, b.quat.z, b.quat.w, b.vel.x, b.vel.y, b.vel.z, b.angVel.x, b.angVel.y, b.angVel.z]),
      bv: b.mesh.visible ? 1 : 0,
      c: cars,
      k: Math.round(this.clock * 100) / 100,
      s: this.score,
      o: this.overtime,
      p: this.arena.pads.map((pad) => (pad.active ? '1' : '0')).join(''),
      st: stats,
    });
  }

  private netReceive() {
    const o = this.online!;
    const now = performance.now() / 1000;
    for (const raw of o.room.drain()) {
      const m = raw as { t?: string; f?: string; d?: Record<string, unknown> } & Record<string, unknown>;
      if (m.t === 'roster') {
        const present = new Set(((m.players as RosterPlayer[]) ?? []).map((p) => p.id));
        for (const id of o.humans) {
          const car = o.byId.get(id);
          if (!car || id === o.selfId || car.absent || present.has(id)) continue;
          car.absent = true;
          this.hud.toast(`${car.name} left the match`, '#ff8a6a');
        }
        continue;
      }
      if (m.t === 'hostLeft') {
        this.abortOnline('The host left the match.');
        return;
      }
      if (!m.f || !m.d || typeof m.d !== 'object') continue;
      const from = m.f;
      const d = m.d;
      const fromHost = from === o.hostId;
      switch (d.t) {
        case 'car': {
          const car = o.byId.get(from);
          if (car?.remote) car.pushNetState(d.s as number[], now);
          break;
        }
        case 'touch':
          if (o.isHost) this.applyRemoteTouch(from, d.b as number[]);
          break;
        case 'pad': {
          const pad = o.isHost ? this.arena.pads[Number(d.i)] : undefined;
          if (pad?.active) pad.take();
          break;
        }
        case 'world':
          if (fromHost && !o.isHost) this.applyWorld(d, now);
          break;
        case 'kickoff':
          if (fromHost && !o.isHost) this.clientKickoff(d as never);
          break;
        case 'go':
          if (fromHost && !o.isHost && this.state === 'countdown') this.go();
          break;
        case 'goal':
          if (fromHost && !o.isHost) {
            const team = d.team === 1 ? 1 : 0;
            if (Array.isArray(d.s)) this.score = [Number(d.s[0]) || 0, Number(d.s[1]) || 0];
            const p = (d.p as number[]) ?? [0, 0, 0];
            this.goalFx(team, String(d.sub ?? '').slice(0, 60), new THREE.Vector3(p[0], p[1], p[2]));
          }
          break;
        case 'demo':
          if (fromHost && !o.isHost) {
            const v = o.byId.get(String(d.v));
            const a = o.byId.get(String(d.a));
            if (v && a) this.demolish(v, a, true);
          }
          break;
        case 'end':
          if (fromHost && !o.isHost) {
            const r = d.r as EndResult;
            if (r && Array.isArray(r.cars)) {
              for (const c of r.cars) c.isPlayer = c.id === o.selfId;
              this.score = r.score;
              this.state = 'ended';
              this.hud.show(false);
              this.hud.showScoreboard(false, []);
              for (const c of this.cars) c.hideFx();
              this.audio.setEngine(0, 0, false, false, false);
              this.audio.whistle();
              this.onEnd({ ...r, online: true });
            }
          }
          break;
      }
    }
  }

  /** Client: take the host's clock, score, pads, stats and host-owned cars from a world update. */
  private applyWorld(d: Record<string, unknown>, now: number) {
    const o = this.online!;
    if (Array.isArray(d.b) && d.b.length >= 13) o.world = { b: d.b as number[], at: now };
    if (typeof d.k === 'number') this.clock = d.k;
    this.overtime = !!d.o;
    if (Array.isArray(d.s)) {
      const s0 = Number(d.s[0]) || 0;
      const s1 = Number(d.s[1]) || 0;
      if (s0 !== this.score[0] || s1 !== this.score[1]) {
        this.score = [s0, s1];
        this.hud.setScore(s0, s1);
      }
    }
    const cars = (d.c ?? {}) as Record<string, number[]>;
    for (const id of Object.keys(cars)) {
      const car = o.byId.get(id);
      if (car?.remote) car.pushNetState(cars[id], now);
    }
    const st = (d.st ?? {}) as Record<string, number[]>;
    for (const id of Object.keys(st)) {
      const car = o.byId.get(id);
      const v = st[id];
      if (car && Array.isArray(v)) Object.assign(car.stats, { goals: v[0] | 0, assists: v[1] | 0, saves: v[2] | 0, shots: v[3] | 0, score: v[4] | 0 });
    }
    if (typeof d.p === 'string') {
      this.arena.pads.forEach((pad, i) => {
        const active = (d.p as string)[i] === '1';
        const mine = now - (o.padTaken.get(i) ?? -10) < 1.5;
        if (active && !pad.active && !mine) pad.reset();
        else if (!active && pad.active) pad.take();
      });
    }
    if (d.bv === 0 && this.state !== 'goal') this.ball.mesh.visible = false;
  }

  /** Client: steer the local ball toward the host's ball (unless we just touched it ourselves). */
  private clientBallCorrection() {
    const o = this.online!;
    if (o.isHost || !o.world || this.state !== 'playing') return;
    const now = performance.now() / 1000;
    if (now - o.lastLocalTouch < 0.3) return;
    const b = o.world.b;
    const age = Math.min(0.25, now - o.world.at) + 0.05;
    const target = new THREE.Vector3(b[0] + b[7] * age, b[1] + b[8] * age, b[2] + b[9] * age);
    const ball = this.ball;
    const err = target.sub(ball.pos);
    const hostVel = new THREE.Vector3(b[7], b[8], b[9]);
    if (err.length() > 10) {
      ball.pos.add(err);
      ball.vel.copy(hostVel);
    } else {
      ball.pos.addScaledVector(err, 0.2);
      ball.vel.lerp(hostVel, 0.25);
    }
    ball.angVel.lerp(new THREE.Vector3(b[10], b[11], b[12]), 0.25);
    ball.body.setTranslation({ x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, true);
    ball.writeVel();
  }

  /** Host: a client reports that its car hit the ball. Trust it if the car is plausibly there. */
  private applyRemoteTouch(from: string, b: number[]) {
    const car = this.online!.byId.get(from);
    if (!car || !Array.isArray(b) || b.length < 9 || !b.every(Number.isFinite)) return;
    if (this.state !== 'playing' && this.state !== 'countdown') return;
    const pos = new THREE.Vector3(b[0], b[1], b[2]);
    if (pos.distanceTo(car.pos) > 9 || pos.distanceTo(this.ball.pos) > 14) return;
    const ball = this.ball;
    const before = ball.vel.clone();
    ball.pos.copy(pos).addScaledVector(new THREE.Vector3(b[3], b[4], b[5]), 0.03);
    ball.vel.set(b[3], b[4], b[5]);
    ball.angVel.set(b[6], b[7], b[8]);
    ball.body.setTranslation({ x: ball.pos.x, y: ball.pos.y, z: ball.pos.z }, true);
    ball.writeVel();
    if (this.state === 'countdown') return;
    const n = pos.clone().sub(car.pos).normalize();
    this.onBallHit(car, pos.clone().addScaledVector(n, -BALL.radius), n, ball.vel.clone().sub(before).length());
  }

  private abortOnline(reason: string) {
    this.quit();
    this.onAbort(reason);
  }

  /** Rows for the Tab scoreboard. */
  private scoreRows() {
    return this.cars.map((c) => ({ name: c.isPlayer ? `${c.name} (you)` : c.name, team: c.team, ...c.stats, absent: c.absent }));
  }

  ballCamKey() {
    return this.input.usingGamepad ? 'Y' : this.input.scheme === 'rl' ? 'Space' : 'Y';
  }

  setPaused(p: boolean) {
    this.paused = p;
  }

  /** Restart the current match with the same mode and difficulty. */
  restart() {
    this.particles.clear();
    this.start(this.mode, this.difficulty);
  }
}
