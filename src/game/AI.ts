import * as THREE from 'three';
import { ARENA, BALL, CAR, STEER_CURVE, UU, WORLD_SCALE, curveLerp } from './Config';

/** Speed / car-size conversion vs. the original tuning (1 unit = 65 uu). */
const K = 1 / (UU * 65);
/** Field-size conversion for positional distances. */
const F = WORLD_SCALE * 0.85;
import type { Car } from './Car';
import { Ball } from './Ball';
import type { BoostPad } from './Arena';
import { Controls, emptyControls } from './Input';

export type Difficulty = 'rookie' | 'pro' | 'allstar';

interface DiffParams {
  reaction: number; // seconds of perception lag
  aimError: number; // world units of target noise
  boostUse: number; // 0..1 willingness to boost
  throttle: number; // max throttle
  dodges: boolean;
  aerials: boolean;
  jumpSkill: number; // 0..1
  approach: number; // how far behind the ball to line up
}

const PARAMS: Record<Difficulty, DiffParams> = {
  rookie: { reaction: 0.55, aimError: 3.5, boostUse: 0, throttle: 0.68, dodges: false, aerials: false, jumpSkill: 0.35, approach: 3.0 },
  pro: { reaction: 0.2, aimError: 1.4, boostUse: 0.6, throttle: 0.95, dodges: true, aerials: false, jumpSkill: 0.75, approach: 4.5 },
  allstar: { reaction: 0.06, aimError: 0.5, boostUse: 1, throttle: 1, dodges: true, aerials: true, jumpSkill: 1, approach: 5.5 },
};

const v3 = () => new THREE.Vector3();

/** Rule-based bot: lines up behind the ball toward the opponent goal, rotates back, collects boost. */
export class AIController {
  private p: DiffParams;
  private c: Controls = emptyControls();
  private jumpHold = 0;
  private jumpPhase: 'none' | 'first' | 'wait' | 'second' | 'aerial' = 'none';
  private phaseTimer = 0;
  private dodgeDir = { f: 0, s: 0 };
  private noise = v3();
  private noiseTimer = 0;
  private perceived = v3();
  private perceivedVel = v3();
  private history: { t: number; p: THREE.Vector3; v: THREE.Vector3 }[] = [];
  private kickoffFlip = false;
  private aerialTarget = new THREE.Vector3();
  private aerialTime = 0;
  private now = 0;
  private stuckTimer = 0;
  private reverseTimer = 0;
  private reverseSteer = 1;
  role: 'attack' | 'support' = 'attack';
  debug = '';
  lastTarget = new THREE.Vector3();

  constructor(
    public car: Car,
    difficulty: Difficulty,
  ) {
    this.p = PARAMS[difficulty];
  }

  setDifficulty(d: Difficulty) {
    this.p = PARAMS[d];
  }

  reset() {
    this.jumpPhase = 'none';
    this.history = [];
    this.kickoffFlip = false;
  }

  /** Compute controls. `kickoff` true while the ball hasn't been touched since kickoff. */
  think(dt: number, time: number, ball: Ball, cars: Car[], pads: BoostPad[], kickoff: boolean): Controls {
    const car = this.car;
    const c = this.c;
    const P = this.p;
    this.now = time;
    c.jump = false;
    c.boost = false;
    c.handbrake = false;
    c.roll = 0;
    if (car.demolished) return c;

    // delayed perception of the ball
    this.history.push({ t: time, p: ball.pos.clone(), v: ball.vel.clone() });
    while (this.history.length > 2 && this.history[1].t <= time - P.reaction) this.history.shift();
    const h = this.history[0];
    this.perceived.copy(h.p).addScaledVector(h.v, Math.min(P.reaction, time - h.t));
    this.perceivedVel.copy(h.v);
    this.noiseTimer -= dt;
    if (this.noiseTimer <= 0) {
      this.noiseTimer = 0.6 + Math.random() * 0.6;
      this.noise.set((Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2).multiplyScalar(P.aimError);
    }

    const attackSign = car.team === 0 ? 1 : -1; // direction toward opponent goal
    const oppGoal = new THREE.Vector3(attackSign * (ARENA.halfLength + 2), 1, 0);
    const ownGoal = new THREE.Vector3(-attackSign * (ARENA.halfLength - 1), 0, 0);

    // --- choose an intercept point on the predicted path ---
    const pos = car.pos;
    const speed = Math.max(car.speed, 8 * K);
    let intercept = this.perceived.clone();
    let interceptT = 0;
    const offs = this.perceived.clone().sub(ball.pos);
    for (let i = 0; i < Ball.PRED_STEPS; i += 3) {
      const bp = ball.predicted[i];
      const t = (i + 1) * Ball.PRED_DT;
      const reach = (4.2 + P.jumpSkill * 2) * K;
      if (bp.y > reach) continue;
      const d = bp.distanceTo(pos) - BALL.radius - 1;
      const maxSpd = car.boost > 10 ? CAR.maxSpeed * 0.9 : CAR.maxDriveSpeed;
      const tReach = d / Math.max(speed, Math.min(maxSpd, speed + 10 * K * t));
      if (tReach <= t || i >= Ball.PRED_STEPS - 3) {
        intercept = bp.clone().add(offs);
        interceptT = t;
        break;
      }
    }

    // ball side relative to car: are we on the correct (goal-side) of the ball?
    const ballX = Math.max(intercept.x * attackSign, this.perceived.x * attackSign);
    const carX = pos.x * attackSign;
    const behindBall = carX < ballX - 1;

    // teammates: decide role in 2v2 (closest to ball attacks)
    const mates = cars.filter((o) => o !== car && o.team === car.team && !o.demolished);
    this.role = 'attack';
    for (const m of mates) {
      const md = m.pos.distanceTo(intercept) + (m.pos.x * attackSign > ballX ? 12 * F : 0);
      const myd = pos.distanceTo(intercept) + (behindBall ? 0 : 12 * F);
      if (md < myd) this.role = 'support';
    }

    let target: THREE.Vector3;
    let hitting = false;
    let wantBoost = false;
    let arriveSpeed = CAR.maxSpeed;
    const ballThreat = ball.headingIntoGoal(car.team, 2.5);

    if (kickoff) {
      hitting = true;
      if (this.role === 'attack') {
        target = this.perceived.clone();
        target.x -= attackSign * 1.2;
        wantBoost = true;
      } else {
        target = ownGoal.clone().lerp(this.perceived, 0.25);
      }
    } else if (this.role === 'support' && !ballThreat) {
      // hang back between ball and own goal, grab boost if low
      target = ownGoal.clone().lerp(intercept, 0.45);
      target.z *= 0.6;
      arriveSpeed = 14 * K;
      if (car.boost < 50) {
        const pad = this.nearestPad(pads, pos, 30 * F, true);
        if (pad) target = pad.pos.clone();
      }
    } else {
      const dangerous = ballThreat || intercept.x * attackSign < -ARENA.halfLength * 0.45;
      const ballInOurHalf = Math.min(intercept.x, this.perceived.x) * attackSign < -4 * F && Math.max(intercept.x, this.perceived.x) * attackSign < 8 * F;
      // desired direction to send the ball
      let D: THREE.Vector3;
      if (dangerous) D = intercept.clone().sub(ownGoal).setY(0).normalize();
      else {
        const aim = oppGoal.clone();
        aim.z = THREE.MathUtils.clamp(intercept.z * 0.4, -ARENA.goalWidth * 0.3, ARENA.goalWidth * 0.3);
        D = aim.sub(intercept).setY(0).normalize();
      }
      const N = new THREE.Vector3(-D.z, 0, D.x);
      const rel = pos.clone().sub(intercept).setY(0);
      const along = rel.dot(D);
      const lateral = rel.dot(N);
      const dist = rel.length();
      const opps = cars.filter((o) => o.team !== car.team && !o.demolished);
      const oppCloser = opps.some((o) => o.pos.distanceTo(intercept) < dist - 8 * F);
      const smart = P.dodges; // pro & all-star play positionally
      if (smart && oppCloser && behindBall && !ballThreat && (ballInOurHalf || this.perceivedVel.x * attackSign < -5 * K)) {
        // shadow defence: stay between ball and our goal, don't overcommit
        target = ownGoal.clone().lerp(intercept.clone().setY(0), 0.45);
        arriveSpeed = 15 * K;
        wantBoost = false;
      } else if (!behindBall && (ballInOurHalf || ballThreat) && dist > 6 * K) {
        // wrong side with danger: race back to the far post (shadow defence)
        const postZ = -Math.sign(intercept.z || 1) * ARENA.goalWidth * 0.32;
        target = new THREE.Vector3(-attackSign * (ARENA.halfLength - 5 * K), 0, postZ);
        const dPost = Math.hypot(target.x - pos.x, target.z - pos.z);
        wantBoost = dPost > 20 * F;
        arriveSpeed = 12 * K;
        if (dPost < 6 * K) {
          target = intercept.clone().setY(0); // made it back: challenge
          hitting = true;
        }
      } else if (along > 0.8) {
        // in front of / beside the ball: loop around it without touching
        const side = Math.sign(lateral || 1);
        target = intercept.clone().addScaledVector(D, -6 * K).addScaledVector(N, side * 5 * K);
        target.y = 0;
        wantBoost = dist > 18 * F;
      } else {
        // behind the ball: hit through its back
        const alignment = -rel.clone().normalize().dot(D);
        hitting = true;
        if (dist < 14 * K && alignment < 0.6) arriveSpeed = 15 * K;
        target = intercept.clone().addScaledVector(D, -(BALL.radius + 0.6));
        if (dist < 10 * K && alignment > 0.7) target = intercept.clone().addScaledVector(D, 2 * K);
        else if (alignment < 0.7) target.addScaledVector(D, -Math.min(dist * 0.25, 4 * K));
        target.y = 0;
        if (car.boost < 25 && dist > 25 * F && !dangerous) {
          const pad = this.nearestPad(pads, pos, 16 * F, false);
          if (pad) target = pad.pos.clone();
        }
        wantBoost = (dist > 18 * F && alignment > 0.5) || (dangerous && dist > 8 * K);
      }
    }
    this.debug = `${this.jumpPhase} ${kickoff ? 'KO' : this.role}${behindBall ? ' behind' : ' wrong'}${ballThreat ? ' THREAT' : ''} int=${intercept.toArray().map((v) => v.toFixed(0))}@${interceptT.toFixed(2)}`;
    // aim error shrinks as we get close (bots still commit, they just aim worse)
    const noiseScale = kickoff ? 0.15 : THREE.MathUtils.clamp(pos.distanceTo(target) / (25 * F), 0.15, 1);
    target.add(this.noise.clone().multiplyScalar(noiseScale));
    // keep target inside the field
    if (!hitting) this.avoidBall(target, ball.pos);
    // inside a goal: drive out toward the field first
    if (Math.abs(pos.x) > ARENA.halfLength + 0.5 && Math.abs(target.x) < Math.abs(pos.x)) {
      target.set(Math.sign(pos.x) * (ARENA.halfLength - 8 * K), 0, pos.z * 0.5);
    }
    target.x = THREE.MathUtils.clamp(target.x, -ARENA.halfLength + 2, ARENA.halfLength - 2);
    target.z = THREE.MathUtils.clamp(target.z, -ARENA.halfWidth + 2, ARENA.halfWidth - 2);

    this.lastTarget.copy(target);
    // --- drive toward target ---
    const local = target.clone().sub(pos).applyQuaternion(car.quat.clone().invert());
    const angle = Math.atan2(local.z, local.x); // + = target on the right
    const dist = Math.hypot(local.x, local.z);
    c.steer = THREE.MathUtils.clamp(angle * 3, -1, 1);
    const fs = car.forwardSpeed;
    if (Math.abs(angle) > 1.9 && dist < 8 * K && fs < 5 * K) {
      // close and behind: reverse
      c.throttle = -1;
      c.steer = -c.steer;
    } else {
      c.throttle = P.throttle;
      if (fs > arriveSpeed && dist < 15 * K) c.throttle = fs > arriveSpeed + 6 * K && dist < 9 * K ? -1 : 0;
      // sharp turn close to the target: lift off / brake so the turning circle shrinks
      // (target inside our current turning circle => can't make the turn at this speed)
      const turnRadius = 1 / (curveLerp(STEER_CURVE, Math.abs(fs) / UU) / UU);
      const side = Math.sign(local.z || 1);
      const toCenter = Math.hypot(local.x, local.z - side * turnRadius);
      if (Math.abs(angle) > 0.5 && toCenter < turnRadius * 0.95 && car.onGround) c.throttle = fs > 10 * K ? -0.4 : 0.5;
    }
    if (Math.abs(angle) > 1.2 && fs > 10 * K && car.onGround) c.handbrake = true;
    const aligned = Math.abs(angle) < (P.boostUse >= 1 ? 0.4 : 0.25);
    // speed flip on long straight runs when low on boost
    if (P.dodges && car.onGround && aligned && Math.abs(angle) < 0.15 && dist > 28 * F && fs > 11 * K && fs < 21 * K && car.boost < 30 && this.jumpPhase === 'none' && !kickoff) {
      this.startJump({ f: 1, s: 0 });
    }
    const boostAllowed = Math.random() < P.boostUse * 1.5 || P.boostUse >= 1;
    if (car.onGround && aligned && wantBoost && !car.supersonic && boostAllowed && P.boostUse > 0.1) c.boost = true;
    if (kickoff && aligned && this.role === 'attack' && P.boostUse > 0.2) c.boost = true;

    // --- jumping / dodging ---
    this.handleJumps(dt, ball, intercept, interceptT, kickoff, target);

    // --- air recovery & aerial control ---
    if (this.jumpPhase === 'second') {
      // keep the dodge direction set by handleJumps
    } else if (car.isDodging && car.wheelContacts === 0) {
      c.pitch = 0;
      c.yaw = 0;
      c.roll = 0;
    } else if (!car.onGround && car.wheelContacts === 0) {
      this.airControl(this.jumpPhase === 'aerial' ? this.aerialTarget : intercept);
    } else {
      c.pitch = 0;
      c.yaw = c.steer;
    }
    this.unstick(dt);
    return c;
  }

  /** Back out when pinned against a wall or goal post. */
  private unstick(dt: number) {
    const car = this.car;
    const c = this.c;
    if (this.reverseTimer > 0) {
      this.reverseTimer -= dt;
      c.throttle = -1;
      c.steer = this.reverseSteer;
      c.boost = false;
      return;
    }
    if (car.onGround && Math.abs(c.throttle) > 0.5 && car.speed < 1.5 && this.jumpPhase === 'none') {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.7) {
        this.stuckTimer = 0;
        this.reverseTimer = 0.9;
        this.reverseSteer = -Math.sign(c.steer || 1);
      }
    } else this.stuckTimer = 0;
  }

  /** Bend the path around the ball when we don't intend to touch it. */
  private avoidBall(target: THREE.Vector3, ballPos: THREE.Vector3) {
    const p = this.car.pos;
    const seg = target.clone().sub(p).setY(0);
    const len = seg.length();
    if (len < 1) return;
    seg.multiplyScalar(1 / len);
    const toBall = ballPos.clone().sub(p).setY(0);
    const t = toBall.dot(seg);
    if (t < 0 || t > len + 2 || ballPos.y > 5 * K) return;
    const perp = toBall.clone().addScaledVector(seg, -t);
    const miss = perp.length();
    const clear = BALL.radius + 2.6;
    if (miss > clear) return;
    // go around on the side we're already offset to
    const side = miss > 0.01 ? perp.multiplyScalar(-1 / miss) : new THREE.Vector3(-seg.z, 0, seg.x);
    target.copy(ballPos).setY(0).addScaledVector(side, clear + 1.5).addScaledVector(seg, -1);
  }

  private nearestPad(pads: BoostPad[], pos: THREE.Vector3, maxDist: number, preferBig: boolean): BoostPad | null {
    let best: BoostPad | null = null;
    let bestD = maxDist;
    for (const p of pads) {
      if (!p.active) continue;
      const d = p.pos.distanceTo(pos) * (preferBig && p.big ? 0.5 : 1);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  private handleJumps(dt: number, ball: Ball, intercept: THREE.Vector3, interceptT: number, kickoff: boolean, _target: THREE.Vector3) {
    const car = this.car;
    const c = this.c;
    const P = this.p;
    this.phaseTimer += dt;
    const toBall = ball.pos.clone().sub(car.pos);
    const distBall = toBall.length();
    const localBall = toBall.clone().applyQuaternion(car.quat.clone().invert());
    const facingBall = localBall.x > 0 && Math.abs(Math.atan2(localBall.z, localBall.x)) < 0.35;

    switch (this.jumpPhase) {
      case 'none': {
        if (!car.onGround) break;
        // kickoff flip
        if (kickoff && P.dodges && !this.kickoffFlip && distBall < 9 * K + car.speed * 0.12 && facingBall) {
          this.kickoffFlip = true;
          this.startJump({ f: 1, s: 0 });
          break;
        }
        // ball will be in the air within reach in front of us shortly
        const fut = ball.predicted[Math.min(Ball.PRED_STEPS - 1, 17)];
        const h = fut.y;
        const lf = fut.clone().sub(car.pos).applyQuaternion(car.quat.clone().invert());
        const fHoriz = Math.hypot(lf.x, lf.z);
        if (h > 3.4 * K && h < (4.4 + P.jumpSkill * 3.5) * K && fHoriz < 3.2 * K && lf.x > -0.5 && Math.random() < P.jumpSkill) {
          this.jumpPhase = 'first';
          this.phaseTimer = 0;
          this.jumpHold = h > 5 * K ? 0.2 : 0.1;
          this.dodgeDir = { f: 0, s: 0 };
          break;
        }
        // shot: ground ball close, aligned toward goal -> dodge into it
        const goalDir = (car.team === 0 ? 1 : -1) * Math.sign(toBall.x);
        if (P.dodges && ball.pos.y < 2.6 * K && distBall < 4.2 * K + car.speed * 0.04 && facingBall && car.speed > 9 && goalDir > 0) {
          this.startJump({ f: 1, s: THREE.MathUtils.clamp(localBall.z * 0.5, -1, 1) });
          break;
        }
        // aerial: find a high point on the predicted path we can reach in time
        if (P.aerials && car.boost > 30 && car.onGround && car.up.y > 0.9) {
          for (let i = 24; i < 150; i += 4) {
            const bp = ball.predicted[i];
            if (bp.y < 6.5 * K || bp.y > 20 * K) continue;
            const t = (i + 1) * Ball.PRED_DT;
            // acceleration needed (after the jump impulse) to arrive exactly at t
            const v0 = car.vel.clone().addScaledVector(car.up, CAR.jumpImpulse * 1.8);
            const need = bp.clone().sub(car.pos).addScaledVector(v0, -t).multiplyScalar(2 / (t * t));
            need.y += CAR.gravity;
            const flat = need.clone().setY(0);
            const local = flat.applyQuaternion(car.quat.clone().invert());
            const facing = local.x > 0 && Math.abs(Math.atan2(local.z, local.x)) < 0.8;
            if (facing && need.length() < CAR.boostAccel * 0.95 && car.boost > CAR.boostDrain * t + 5) {
              this.aerialTarget.copy(bp);
              this.aerialTime = this.now + t;
              this.jumpPhase = 'aerial';
              this.phaseTimer = 0;
              break;
            }
          }
        }
        break;
      }
      case 'first':
        c.jump = this.phaseTimer < this.jumpHold;
        if (this.phaseTimer >= this.jumpHold) {
          this.jumpPhase = 'wait';
          this.phaseTimer = 0;
        }
        break;
      case 'wait':
        c.jump = false;
        if (this.phaseTimer > 0.06) {
          // decide on second jump / dodge
          const close = distBall < 4.8 * K;
          if (this.dodgeDir.f !== 0 || this.dodgeDir.s !== 0) {
            this.jumpPhase = 'second';
            this.phaseTimer = 0;
          } else if (close && ball.pos.y > car.pos.y + 1.2 * K && P.jumpSkill > 0.5) {
            this.jumpPhase = 'second';
            this.phaseTimer = 0;
            this.dodgeDir = { f: 0, s: 0 };
          } else if (this.phaseTimer > 0.8 || car.onGround) {
            this.jumpPhase = 'none';
          }
        }
        break;
      case 'second':
        c.jump = true;
        c.pitch = this.dodgeDir.f;
        c.steer = this.dodgeDir.s;
        c.yaw = this.dodgeDir.s;
        if (this.phaseTimer > 0.05) {
          this.jumpPhase = 'none';
          this.dodgeDir = { f: 0, s: 0 };
        }
        break;
      case 'aerial': {
        // jump (held), then boost along the required acceleration
        c.jump = this.phaseTimer < 0.2;
        const idx = Math.round((this.aerialTime - this.now) / Ball.PRED_DT);
        this.aerialTarget.copy(ball.predicted[THREE.MathUtils.clamp(idx, 0, Ball.PRED_STEPS - 1)]);
        if ((this.phaseTimer > 0.3 && car.onGround) || this.now > this.aerialTime + 0.3) this.jumpPhase = 'none';
        break;
      }
    }
  }

  private startJump(dir: { f: number; s: number }) {
    this.jumpPhase = 'first';
    this.phaseTimer = 0;
    this.jumpHold = 0.08;
    this.dodgeDir = dir;
  }

  private airControl(intercept: THREE.Vector3) {
    const car = this.car;
    const c = this.c;
    const inv = car.quat.clone().invert();
    let desiredFwd: THREE.Vector3;
    let desiredUp = new THREE.Vector3(0, 1, 0);
    if (this.jumpPhase === 'aerial') {
      const T = Math.max(0.08, this.aerialTime - this.now);
      const need = intercept.clone().sub(car.pos).addScaledVector(car.vel, -T).multiplyScalar(2 / (T * T));
      need.y += CAR.gravity;
      desiredFwd = need.clone().normalize();
      const align = desiredFwd.dot(car.fwd);
      c.boost = align > 0.8 && need.length() > CAR.boostAccel * 0.25 && car.boost > 0;
      desiredUp = new THREE.Vector3(0, 1, 0).addScaledVector(desiredFwd, -desiredFwd.y).normalize();
      if (desiredUp.lengthSq() < 0.5) desiredUp.set(0, 1, 0);
    } else {
      // recovery: nose along horizontal velocity, wheels down
      desiredFwd = car.vel.clone().setY(0);
      if (desiredFwd.lengthSq() < 1) desiredFwd.copy(car.fwd).setY(0);
      desiredFwd.normalize();
      // if heading into a wall, aim wheels at it
      const ahead = car.pos.clone().addScaledVector(car.vel, 0.4);
      if (Math.abs(ahead.x) > ARENA.halfLength - 3 || Math.abs(ahead.z) > ARENA.halfWidth - 3) {
        desiredUp = car.pos.clone().setY(0).multiplyScalar(-1).normalize().lerp(new THREE.Vector3(0, 1, 0), 0.5).normalize();
      }
    }
    const lf = desiredFwd.clone().applyQuaternion(inv);
    const lu = desiredUp.clone().applyQuaternion(inv);
    const wl = car.angVel.clone().applyQuaternion(inv);
    // pitch: rotate nose toward lf.y (nose up => negative pitch input)
    const pitchErr = Math.atan2(lf.y, lf.x);
    const yawErr = Math.atan2(lf.z, lf.x);
    const rollErr = Math.atan2(lu.z, lu.y);
    c.pitch = THREE.MathUtils.clamp(-pitchErr * 3 + wl.z * 0.45, -1, 1);
    c.yaw = THREE.MathUtils.clamp(yawErr * 3 + wl.y * 0.45, -1, 1);
    c.steer = c.yaw;
    c.roll = THREE.MathUtils.clamp(rollErr * 2.5 - wl.x * 0.35, -1, 1);
  }
}
