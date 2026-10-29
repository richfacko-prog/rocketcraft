import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CAR, STEER_CURVE, TEAM_COLORS, THROTTLE_CURVE, UU, Team, carRideHeight, curveLerp } from './Config';
import { CarDesign } from './CarDesign';
import { CarModel } from './CarModel';
import { arenaNormal, arenaRaycast, arenaSdf, GROUP_ARENA, GROUP_CAR, groups } from './Arena';
import { Controls, emptyControls } from './Input';
import { Particles } from './Particles';
import { CAR_STATE_LEN, FLAG_BOOST, FLAG_DEMOLISHED, FLAG_GROUND, FLAG_SUPERSONIC, packNumbers } from '../net/protocol';

/** Remote cars are drawn this far in the past so there are always two snapshots to blend. */
const NET_DELAY = 0.1;

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

// Moment of inertia (local: x = roll axis, y = yaw axis, z = pitch axis), mass = 1
const INERTIA = new THREE.Vector3(0.36, 0.75, 0.62);

const v3 = () => new THREE.Vector3();

export interface CarStats {
  goals: number;
  shots: number;
  saves: number;
  assists: number;
  demos: number;
  score: number;
}

export interface CarSnapshot {
  p: [number, number, number];
  q: [number, number, number, number];
  boosting: boolean;
  supersonic: boolean;
  visible: boolean;
}

export class Car {
  body: RAPIER.RigidBody;
  group = new THREE.Group();
  controls: Controls = emptyControls();
  boost = CAR.startBoost;
  stats: CarStats = { goals: 0, shots: 0, saves: 0, assists: 0, demos: 0, score: 0 };

  // physics state
  pos = v3();
  vel = v3();
  angVel = v3();
  quat = new THREE.Quaternion();
  fwd = v3();
  up = v3();
  right = v3();
  surfaceNormal = new THREE.Vector3(0, 1, 0);
  wheelContacts = 0;
  onGround = false;
  sticking = false;
  /** 0..1 grip holding the car to a wall/ceiling (speed-based). */
  wallGrip = 0;
  private wallHold = 0;
  supersonic = false;
  boosting = false;
  demolished = false;
  respawnTimer = 0;
  frozen = false;
  lastBallHit = -10;
  /** Network id (online matches). */
  netId = '';
  /** Driven by network snapshots instead of local physics (other players, or host bots on clients). */
  remote = false;
  /** Gone from the match (player disconnected). */
  absent = false;
  private netBuf: { t: number; s: number[] }[] = [];

  private prevJump = false;
  private jumping = false;
  private jumpTimer = 0;
  private hasJumped = false;
  private hasDoubleJumped = false;
  private hasFlipped = false;
  private airTimer = 0; // time since jump / leaving ground
  private canSecondJump = false;
  private noGroundTimer = 0;
  private dodgeTimer = -1;
  private dodgeSpin = v3();
  private slide = 0;
  private upsideTimer = 0;
  private boostMinTimer = 0;
  private wheelDist = [0, 0, 0, 0];
  private wheelSpin = 0;

  // visuals (the model is a child of `group`, which follows the interpolated physics pose)
  private prevPos = v3();
  private prevQuat = new THREE.Quaternion();
  model: CarModel;
  private nameTag?: THREE.Sprite;
  private visVel = v3();
  private accelLocal = v3();
  private airTime = 0;
  readonly color: THREE.Color;

  constructor(
    private world: RAPIER.World,
    private scene: THREE.Scene,
    public readonly team: Team,
    public readonly name: string,
    public readonly isPlayer: boolean,
    design: CarDesign,
  ) {
    this.color = new THREE.Color(TEAM_COLORS[team]);
    const desc = RAPIER.RigidBodyDesc.dynamic().setCanSleep(false).setCcdEnabled(true).setLinearDamping(0).setAngularDamping(0);
    this.body = world.createRigidBody(desc);
    const h = CAR.halfExtents;
    const vol = 8 * h.x * h.y * h.z;
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(h.x, h.y, h.z)
        .setDensity(1 / vol)
        .setFriction(0)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitution(0.15)
        .setCollisionGroups(groups(GROUP_CAR, GROUP_ARENA | GROUP_CAR)),
      this.body,
    );
    this.model = new CarModel(design, TEAM_COLORS[team]);
    this.group.add(this.model.root);
    scene.add(this.group);
    if (!isPlayer) {
      this.buildNameTag();
      scene.add(this.nameTag!);
    }
  }

  /** Swap the visual model (e.g. after the garage design changed). Physics is untouched. */
  setDesign(design: CarDesign) {
    this.group.remove(this.model.root);
    this.model.dispose();
    this.model = new CarModel(design, TEAM_COLORS[this.team]);
    this.group.add(this.model.root);
  }

  private buildNameTag() {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 64;
    const x = c.getContext('2d')!;
    x.font = '700 34px Rajdhani, system-ui, sans-serif';
    x.textAlign = 'center';
    x.fillStyle = 'rgba(6,9,18,0.55)';
    x.fillRect(28, 8, 200, 48);
    x.fillStyle = this.team === 0 ? '#2f8cff' : '#ff8a1e';
    x.fillRect(28, 52, 200, 4);
    x.fillStyle = '#f2f5fa';
    x.fillText(this.name, 128, 43);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.nameTag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    this.nameTag.scale.set(2.6, 0.65, 1);
    this.nameTag.renderOrder = 10;
  }

  /** Place the car at a spawn, facing yaw (radians, 0 = +x). */
  spawn(x: number, z: number, yaw: number, boost = CAR.startBoost) {
    const q = new THREE.Quaternion().setFromAxisAngle(Y, yaw);
    const y = carRideHeight();
    this.body.setEnabled(true);
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.pos.set(x, y, z);
    this.quat.copy(q);
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(q);
    this.vel.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    this.boost = boost;
    this.demolished = false;
    this.group.visible = true;
    this.jumping = false;
    this.hasJumped = this.hasDoubleJumped = this.hasFlipped = false;
    this.canSecondJump = false;
    this.dodgeTimer = -1;
    this.supersonic = false;
    this.boosting = false;
    this.slide = 0;
    this.upsideTimer = 0;
    this.noGroundTimer = 0;
    this.prevJump = true; // require a fresh press
    this.updateAxes();
  }

  demolish() {
    this.demolished = true;
    this.respawnTimer = 3;
    this.body.setEnabled(false);
    this.group.visible = false;
    if (this.nameTag) this.nameTag.visible = false;
    this.boosting = false;
    this.supersonic = false;
  }

  private updateAxes() {
    this.fwd.copy(X).applyQuaternion(this.quat);
    this.up.copy(Y).applyQuaternion(this.quat);
    this.right.copy(Z).applyQuaternion(this.quat);
  }

  readState() {
    const t = this.body.translation();
    const r = this.body.rotation();
    const lv = this.body.linvel();
    const av = this.body.angvel();
    this.pos.set(t.x, t.y, t.z);
    this.quat.set(r.x, r.y, r.z, r.w);
    this.vel.set(lv.x, lv.y, lv.z);
    this.angVel.set(av.x, av.y, av.z);
    this.updateAxes();
  }

  get speed() {
    return this.vel.length();
  }

  get forwardSpeed() {
    return this.vel.dot(this.fwd);
  }

  /** True when the car can still use its second jump / dodge. */
  get hasFlip() {
    return this.canSecondJump && !this.hasDoubleJumped && !this.hasFlipped && this.airTimer < CAR.dodgeWindow;
  }

  get isDodging() {
    return this.dodgeTimer >= 0;
  }

  // ------------------------------------------------------------------ networking
  setRemote(on: boolean) {
    this.remote = on;
    this.body.setBodyType(on ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic, true);
  }

  /** Compact state for the network. */
  netState(): number[] {
    const flags = (this.boosting ? FLAG_BOOST : 0) | (this.supersonic ? FLAG_SUPERSONIC : 0) | (this.onGround ? FLAG_GROUND : 0) | (this.demolished ? FLAG_DEMOLISHED : 0);
    const p = this.pos, q = this.quat, v = this.vel, w = this.angVel;
    return packNumbers([p.x, p.y, p.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z, w.x, w.y, w.z, this.boost, flags, this.controls.steer]);
  }

  pushNetState(s: number[], now: number) {
    if (!Array.isArray(s) || s.length < CAR_STATE_LEN || !s.every((x) => Number.isFinite(x))) return;
    const last = this.netBuf[this.netBuf.length - 1];
    // big jump (kickoff, respawn): don't blend across it
    if (last && Math.hypot(s[0] - last.s[0], s[1] - last.s[1], s[2] - last.s[2]) > 15) this.netBuf.length = 0;
    this.netBuf.push({ t: now, s });
    if (this.netBuf.length > 40) this.netBuf.splice(0, this.netBuf.length - 40);
  }

  private remoteStep(now: number) {
    const buf = this.netBuf;
    if (!buf.length) return;
    const rt = now - NET_DELAY;
    let a = buf[0];
    let b = buf[0];
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].t <= rt) {
        a = buf[i];
        b = buf[Math.min(i + 1, buf.length - 1)];
        break;
      }
    }
    const sa = a.s;
    const sb = b.s;
    let k = b.t > a.t ? (rt - a.t) / (b.t - a.t) : 0;
    let extra = 0;
    if (a === b) {
      // ran out of snapshots: extrapolate a little with the last velocity
      k = 0;
      extra = Math.min(0.2, Math.max(0, rt - a.t));
    }
    k = THREE.MathUtils.clamp(k, 0, 1);
    const L = (i: number) => sa[i] + (sb[i] - sa[i]) * k;
    this.pos.set(L(0) + sa[7] * extra, L(1) + sa[8] * extra, L(2) + sa[9] * extra);
    this.quat.set(sa[3], sa[4], sa[5], sa[6]).slerp(new THREE.Quaternion(sb[3], sb[4], sb[5], sb[6]), k).normalize();
    this.vel.set(L(7), L(8), L(9));
    this.angVel.set(L(10), L(11), L(12));
    this.boost = sb[13];
    const flags = sb[14];
    this.boosting = !!(flags & FLAG_BOOST);
    this.supersonic = !!(flags & FLAG_SUPERSONIC);
    this.onGround = !!(flags & FLAG_GROUND);
    this.wheelContacts = this.onGround ? 4 : 0;
    this.controls.steer = sb[15];
    const dead = !!(flags & FLAG_DEMOLISHED) || this.absent;
    if (dead !== this.demolished) {
      this.demolished = dead;
      this.body.setEnabled(!dead);
      this.group.visible = !dead;
      if (this.nameTag) this.nameTag.visible = !dead;
    }
    const maxLen = CAR.suspensionRest + CAR.wheelRadius;
    for (let i = 0; i < 4; i++) this.wheelDist[i] = this.onGround ? maxLen - 0.1 : maxLen;
    this.updateAxes();
    if (!dead) {
      this.body.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y, z: this.pos.z });
      this.body.setNextKinematicRotation({ x: this.quat.x, y: this.quat.y, z: this.quat.z, w: this.quat.w });
    }
  }

  /** One fixed physics step, executed before world.step(). */
  prePhysics(dt: number, time: number) {
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    if (this.remote) {
      this.remoteStep(performance.now() / 1000);
      return;
    }
    if (this.demolished) return;
    this.readState();
    const c = this.controls;
    if (this.frozen) {
      this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.prevJump = c.jump;
      this.boosting = false;
      this.probeWheels(); // keep wheel visuals settled
      return;
    }

    const v = this.vel;
    const w = this.angVel;
    const acc = v3();
    const torque = v3();

    // --- Suspension raycasts ---
    if (this.noGroundTimer > 0) this.noGroundTimer -= dt;
    const contacts = this.noGroundTimer > 0 ? 0 : this.probeWheels(acc, torque);
    const wasGround = this.onGround;
    this.wheelContacts = contacts;
    this.onGround = contacts >= 3;
    const N = this.surfaceNormal;

    // --- Gravity & surface grip ---
    // Full gravity always applies. Off the floor, the only thing holding the car to a wall or
    // the ceiling is a grip force that grows with speed: fast cars ride the walls, slow cars
    // peel off and fall. Grip is always weaker than gravity, so nothing can hang from the ceiling.
    const g = CAR.gravity;
    const speed = v.length();
    acc.y -= g;
    this.wallGrip = 0;
    this.wallHold = 0;
    if (this.onGround && !this.jumping) {
      const floorish = N.y > 0.7;
      if (floorish) {
        acc.addScaledVector(N, -CAR.stickyAccel);
        this.sticking = false;
      } else {
        const t = THREE.MathUtils.clamp((speed - CAR.wallGripMinSpeed) / (CAR.wallGripFullSpeed - CAR.wallGripMinSpeed), 0, 1);
        this.wallGrip = t;
        this.sticking = t > 0;
        if (t > 0) acc.addScaledVector(N, -CAR.wallGripMax * t);
        else acc.addScaledVector(N, CAR.wallPeel); // too slow: tip away from the surface
        // gravity pulling the car away from this surface (positive on overhangs / ceiling)
        const pullAway = -g * N.y;
        this.wallHold = CAR.wallGripMax * t > pullAway ? t : 0;
      }
    } else {
      this.sticking = false;
    }

    // --- Jump state ---
    const jumpPressed = c.jump && !this.prevJump;
    this.prevJump = c.jump;
    if (this.onGround && !this.jumping && this.noGroundTimer <= 0) {
      this.hasJumped = false;
      this.hasDoubleJumped = false;
      this.hasFlipped = false;
      this.canSecondJump = false;
      this.airTimer = 0;
      if (this.dodgeTimer > 0.15) this.dodgeTimer = -1;
    } else {
      this.airTimer += dt;
      if (wasGround && !this.onGround && !this.hasJumped) {
        // drove off a surface: one flip is still available
        this.canSecondJump = true;
        this.airTimer = 0;
      }
    }

    if (jumpPressed && this.onGround && !this.jumping) {
      v.addScaledVector(this.up, CAR.jumpImpulse);
      this.jumping = true;
      this.jumpTimer = 0;
      this.hasJumped = true;
      this.canSecondJump = true;
      this.airTimer = 0;
      this.noGroundTimer = 0.1;
      this.onGround = false;
      this.sticking = false;
      this.emitEvent('jump');
    } else if (jumpPressed && !this.onGround && contacts < 3 && this.hasFlip && !this.jumping) {
      const dirF = c.pitch;
      const dirS = c.handbrake && c.roll !== 0 ? c.roll : c.steer;
      const mag = Math.max(Math.abs(dirF), Math.abs(dirS));
      if (mag > 0.5) this.startDodge(dirF, dirS);
      else {
        v.addScaledVector(this.up, CAR.jumpImpulse);
        this.hasDoubleJumped = true;
        this.emitEvent('jump');
      }
    }
    if (this.jumping) {
      this.jumpTimer += dt;
      if (c.jump && this.jumpTimer < CAR.jumpHoldTime) acc.addScaledVector(this.up, CAR.jumpHoldAccel);
      else this.jumping = false;
    }

    // --- Boost ---
    if (this.boostMinTimer > 0) this.boostMinTimer -= dt;
    const wantBoost = (c.boost || this.boostMinTimer > 0) && this.boost > 0;
    if (wantBoost && !this.boosting) this.boostMinTimer = 0.1;
    this.boosting = wantBoost;
    if (this.boosting) {
      acc.addScaledVector(this.fwd, CAR.boostAccel);
      this.boost = Math.max(0, this.boost - CAR.boostDrain * dt);
    }

    // --- Ground driving ---
    const slideTarget = c.handbrake && this.onGround ? 1 : 0;
    this.slide += (slideTarget - this.slide) * Math.min(1, dt * (slideTarget ? 9 : 4));
    if (contacts >= 2) {
      const traction = contacts / 4;
      const f = this.fwd.clone().addScaledVector(N, -this.fwd.dot(N)).normalize();
      const r = this.right.clone().addScaledVector(N, -this.right.dot(N)).normalize();
      const vf = v.dot(f);
      const vr = v.dot(r);
      const throttle = this.boosting ? 1 : c.throttle;
      let a = 0;
      if (Math.abs(throttle) > 0.01 && throttle * vf < 0 && Math.abs(vf) > 0.3) {
        a = Math.sign(throttle) * Math.min(CAR.brakeAccel * Math.abs(throttle), Math.abs(vf) / dt);
      } else if (Math.abs(throttle) > 0.01) {
        const accel = curveLerp(THROTTLE_CURVE, Math.abs(vf) / UU) * UU;
        a = throttle * accel;
      } else {
        a = -Math.sign(vf) * Math.min(CAR.coastDecel, Math.abs(vf) / dt);
      }
      acc.addScaledVector(f, a * traction);
      // lateral grip
      const grip = THREE.MathUtils.lerp(CAR.lateralGrip, CAR.slideGrip, this.slide);
      v.addScaledVector(r, -vr * Math.min(1, grip * dt) * traction);
      // steering: yaw rate around surface normal
      const curv = curveLerp(STEER_CURVE, Math.abs(vf) / UU) / UU;
      const target = -c.steer * vf * curv * (1 + 0.45 * this.slide);
      const wn = w.dot(N);
      const resp = THREE.MathUtils.lerp(16, 7, this.slide);
      w.addScaledVector(N, (target - wn) * Math.min(1, resp * dt) * traction);
      if (this.onGround && !this.jumping) {
        // kill suspension rebound away from the surface (keeps cars glued at speed)
        // (only on the floor or while the car still has wall grip, so slow cars can fall away)
        const vn = v.dot(N);
        const hold = N.y > 0.7 ? 1 : this.wallHold;
        if (vn > 0 && hold > 0) v.addScaledVector(N, -vn * Math.min(1, 14 * dt * hold));
      }
      if (this.onGround) {
        // align body with the surface (keeps the car glued through curved ramps)
        const axis = v3().crossVectors(this.up, N);
        const wPerp = w.clone().addScaledVector(N, -w.dot(N));
        const desired = axis.multiplyScalar(14);
        w.add(desired.sub(wPerp).multiplyScalar(Math.min(1, 10 * dt)));
      }
    }

    // --- Air control ---
    const R = this.quat;
    const Rinv = R.clone().invert();
    if (contacts === 0) {
      const wl = w.clone().applyQuaternion(Rinv);
      if (this.dodgeTimer >= 0 && this.dodgeTimer < CAR.dodgeDuration) {
        // flip cancel: pulling the stick back stops the pitch rotation
        let sx = this.dodgeSpin.x;
        let sz = this.dodgeSpin.z;
        if (this.dodgeSpin.z !== 0 && c.pitch * -Math.sign(this.dodgeSpin.z) < -0.5) sz *= 0.15;
        wl.x = sx;
        wl.z = sz;
        wl.y += -c.yaw * CAR.airTorque.yaw * 0.3 * dt;
      } else {
        const T = CAR.airTorque;
        const D = CAR.airDamp;
        const roll = c.roll;
        const pitch = c.pitch;
        const yaw = c.handbrake && c.roll !== 0 ? 0 : c.yaw;
        wl.x += (roll * T.roll - D.roll * wl.x) * dt;
        wl.z += (-pitch * T.pitch - D.pitch * wl.z * (1 - Math.abs(pitch))) * dt;
        wl.y += (-yaw * T.yaw - D.yaw * wl.y * (1 - Math.abs(yaw))) * dt;
      }
      w.copy(wl.applyQuaternion(R));
    }
    if (this.dodgeTimer >= 0) {
      const before = this.dodgeTimer;
      this.dodgeTimer += dt;
      if (before < CAR.dodgeDuration && this.dodgeTimer >= CAR.dodgeDuration && contacts === 0) {
        // flip finished: bleed off most of the flip rotation so the car settles
        const wl = w.clone().applyQuaternion(Rinv);
        wl.x *= 0.15;
        wl.z *= 0.15;
        w.copy(wl.applyQuaternion(R));
      }
      if (this.dodgeTimer > CAR.dodgeDuration + 0.4) this.dodgeTimer = -1;
    }

    // --- Spring torques (weight transfer) ---
    if (torque.lengthSq() > 0) {
      const tl = torque.applyQuaternion(Rinv);
      tl.set(tl.x / INERTIA.x, tl.y / INERTIA.y, tl.z / INERTIA.z);
      w.addScaledVector(tl.applyQuaternion(R), dt);
    }
    if (contacts > 0) {
      // extra angular damping while touching the ground
      w.multiplyScalar(1 - Math.min(0.5, 2.5 * dt));
    }

    // --- Auto-righting when stuck on roof / side ---
    this.autoRight(dt, jumpPressed, contacts, v, w);

    // --- Integrate accelerations ---
    v.addScaledVector(acc, dt);
    const maxW = this.dodgeTimer >= 0 && this.dodgeTimer < CAR.dodgeDuration ? 11 : CAR.maxAngVel;
    if (w.length() > maxW) w.setLength(maxW);
    const sp = v.length();
    if (sp > CAR.maxSpeed) v.multiplyScalar(CAR.maxSpeed / sp);
    if (sp >= CAR.supersonic) this.supersonic = true;
    else if (sp < CAR.supersonicExit) this.supersonic = false;

    this.body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
    this.body.setAngvel({ x: w.x, y: w.y, z: w.z }, true);
    void time;
  }

  private startDodge(dirF: number, dirS: number) {
    const len = Math.hypot(dirF, dirS);
    const f = dirF / len;
    const s = dirS / len;
    // dodge impulse in the car's yaw frame (flattened)
    const ff = this.fwd.clone();
    ff.y = 0;
    if (ff.lengthSq() < 0.05) ff.copy(this.fwd);
    ff.normalize();
    const rr = v3().crossVectors(ff, Y).normalize();
    const vf = this.vel.dot(ff);
    const fImp = f > 0 ? CAR.dodgeImpulse : CAR.dodgeImpulse * 1.066;
    const sImp = CAR.dodgeImpulse * (1 + (0.9 * Math.abs(vf)) / CAR.maxSpeed);
    this.vel.addScaledVector(ff, f * fImp).addScaledVector(rr, s * sImp);
    // dodge z-damping: flips stay low and land as the rotation completes
    this.vel.y = this.vel.y < 0 ? 0 : this.vel.y * 0.35;
    this.dodgeSpin.set(s * CAR.dodgeSpin, 0, -f * CAR.dodgeSpin);
    this.dodgeTimer = 0;
    this.hasFlipped = true;
    this.emitEvent('flip');
  }

  private autoRight(dt: number, jumpPressed: boolean, contacts: number, v: THREE.Vector3, w: THREE.Vector3) {
    const d = arenaSdf(this.pos.x, this.pos.y, this.pos.z);
    if (contacts >= 3 || d > 1.4) {
      this.upsideTimer = 0;
      return;
    }
    const N = arenaNormal(this.pos, v3());
    const upDot = this.up.dot(N);
    if (upDot < 0.5 && d < 1.0) {
      // hull scraping on the surface: friction
      const vt = v.clone().addScaledVector(N, -v.dot(N));
      v.addScaledVector(vt, -Math.min(1, 2.2 * dt));
    }
    if (upDot < 0.5 && v.length() < 5) {
      this.upsideTimer += dt;
      if (this.upsideTimer > 0.7 || (jumpPressed && this.upsideTimer > 0.05)) {
        this.upsideTimer = 0;
        const axis = v3().crossVectors(this.up, N);
        if (axis.lengthSq() < 1e-4) axis.copy(this.fwd);
        axis.normalize();
        const angle = Math.acos(THREE.MathUtils.clamp(upDot, -1, 1));
        v.addScaledVector(N, 4.2);
        w.copy(axis.multiplyScalar(angle / 0.42));
        this.canSecondJump = false;
      }
    } else this.upsideTimer = 0;
  }

  /** Raycast the 4 wheels; adds spring forces to acc/torque if provided. Returns contact count. */
  private probeWheels(acc?: THREE.Vector3, torque?: THREE.Vector3): number {
    let contacts = 0;
    const nSum = v3();
    const down = this.up.clone().negate();
    const maxLen = CAR.suspensionRest + CAR.wheelRadius;
    const probeLen = maxLen + 0.18; // slack so the car doesn't lose the surface on bumps
    const attach = v3();
    const rel = v3();
    const pv = v3();
    const hit = v3();
    for (let i = 0; i < 4; i++) {
      const o = CAR.wheelOffsets[i];
      rel.set(o[0], o[1], o[2]).applyQuaternion(this.quat);
      attach.copy(this.pos).add(rel);
      const t = arenaRaycast(attach, down, probeLen);
      if (t < 0) {
        this.wheelDist[i] = maxLen;
        continue;
      }
      this.wheelDist[i] = Math.min(t, maxLen);
      contacts++;
      hit.copy(attach).addScaledVector(down, t);
      nSum.add(arenaNormal(hit, v3()));
      if (acc && torque && t < maxLen) {
        const x = maxLen - t;
        pv.crossVectors(this.angVel, rel).add(this.vel);
        const vu = pv.dot(this.up);
        let F = CAR.springK * x - CAR.springC * vu;
        if (F < 0) F = 0;
        acc.addScaledVector(this.up, F);
        torque.add(v3().crossVectors(rel, this.up.clone().multiplyScalar(F)));
      }
    }
    if (contacts > 0) this.surfaceNormal.copy(nSum.normalize());
    else this.surfaceNormal.set(0, 1, 0);
    return contacts;
  }

  // simple event hooks for audio/fx
  events: string[] = [];
  private emitEvent(e: string) {
    this.events.push(e);
  }

  update(dt: number) {
    if (this.demolished) {
      this.respawnTimer -= dt;
    }
  }

  /** Interpolated visual sync + effects. */
  syncVisual(alpha: number, dt: number, particles: Particles, time: number) {
    if (this.demolished) return;
    this.group.position.lerpVectors(this.prevPos, this.pos, alpha);
    this.group.quaternion.slerpQuaternions(this.prevQuat, this.quat, alpha);
    const m = this.model;
    // wheels: suspension travel, steering and rolling
    const fs = this.forwardSpeed;
    if (this.wheelContacts > 0) this.wheelSpin += (fs / CAR.wheelRadius) * dt;
    else this.wheelSpin += (this.controls.throttle * 12) * dt; // wheels spin freely in the air
    for (let i = 0; i < 4; i++) {
      const o = CAR.wheelOffsets[i];
      m.setWheel(i, o[1] - (this.wheelDist[i] - CAR.wheelRadius), i < 2 ? -this.controls.steer * 0.42 : 0, this.wheelSpin);
    }
    // chassis lean from acceleration (visual only)
    if (dt > 0) {
      const a = this.vel.clone().sub(this.visVel).divideScalar(dt);
      this.visVel.copy(this.vel);
      a.applyQuaternion(this.quat.clone().invert());
      if (!this.onGround) a.set(0, 0, 0);
      this.accelLocal.lerp(a, 1 - Math.exp(-8 * dt));
    }
    m.animate(dt, this.accelLocal);
    const c = this.controls;
    const braking = this.onGround && ((c.throttle < -0.1 && fs > 1) || (c.throttle > 0.1 && fs < -1) || c.handbrake);
    m.setBraking(braking);
    this.showBoostFx(this.boosting, this.supersonic, dt, particles, time);
    if (this.nameTag) {
      this.nameTag.visible = true;
      this.nameTag.position.copy(this.group.position).add(new THREE.Vector3(0, 2.2, 0));
    }
    // landing dust
    if (!this.onGround) this.airTime += dt;
    else {
      if (this.airTime > 0.45) {
        this.events.push('land');
        const p = this.group.position.clone().addScaledVector(this.surfaceNormal, -0.6);
        particles.smoke.emit({ pos: p, spread: 3, color: 0x9aa3b5, color2: 0x4a5060, size: 1.2, sizeEnd: 3.2, life: 0.7, alpha: 0.25, count: 10, jitter: 1.6 });
      }
      this.airTime = 0;
    }
  }

  showBoostFx(boosting: boolean, supersonic: boolean, _dt: number, particles: Particles, time: number) {
    const m = this.model;
    m.setBoost(boosting, time);
    const [core, outer] = m.boostColors(time);
    if (boosting) {
      const back = this.group.localToWorld(new THREE.Vector3(m.spec.upper[1][0] - 0.35, 0.0, 0));
      const dir = new THREE.Vector3(-1, 0, 0).applyQuaternion(this.group.quaternion);
      const base = this.vel.clone().multiplyScalar(0.6);
      switch (m.design.trail) {
        case 'flame':
          particles.glow.emit({ pos: back, vel: base.addScaledVector(dir, 12), spread: 1.8, color: core, color2: outer, size: 1.0, sizeEnd: 0.15, life: 0.24, count: 2, jitter: 0.2 });
          if (Math.random() < 0.35)
            particles.smoke.emit({ pos: back, vel: dir.multiplyScalar(3), spread: 1, color: 0x666666, color2: 0x222222, size: 1.1, sizeEnd: 2.6, life: 0.6, alpha: 0.22 });
          break;
        case 'plasma':
          particles.glow.emit({ pos: back, vel: base.addScaledVector(dir, 6), spread: 0.6, color: core, color2: outer, size: 1.5, sizeEnd: 0.5, life: 0.45, count: 2, jitter: 0.1, alpha: 0.8 });
          break;
        case 'sparkle':
          particles.glow.emit({ pos: back, vel: base.addScaledVector(dir, 9), spread: 5, color: 0xffffff, color2: outer, size: 0.35, sizeEnd: 0.05, life: 0.5, count: 4, jitter: 0.3, gravity: 6 });
          break;
      }
    }
    if (supersonic) {
      for (const s of [-1, 1]) {
        const p = this.group.localToWorld(new THREE.Vector3(-1.0, 0.3, s * 0.72));
        particles.glow.emit({ pos: p, color: 0xffffff, color2: outer, size: 0.6, sizeEnd: 0.05, life: 0.4, alpha: 0.8, count: 2, jitter: 0.08 });
      }
    }
  }

  snapshot(): CarSnapshot {
    return {
      p: [this.pos.x, this.pos.y, this.pos.z],
      q: [this.quat.x, this.quat.y, this.quat.z, this.quat.w],
      boosting: this.boosting,
      supersonic: this.supersonic,
      visible: !this.demolished,
    };
  }

  applySnapshot(s: CarSnapshot, particles: Particles, dt: number, time: number) {
    this.group.visible = s.visible;
    if (this.nameTag) this.nameTag.visible = s.visible;
    if (!s.visible) {
      this.model.setBoost(false, time);
      return;
    }
    this.group.position.set(s.p[0], s.p[1], s.p[2]);
    this.group.quaternion.set(s.q[0], s.q[1], s.q[2], s.q[3]);
    if (this.nameTag) this.nameTag.position.copy(this.group.position).add(new THREE.Vector3(0, 2.2, 0));
    this.showBoostFx(s.boosting, s.supersonic, dt, particles, time);
  }

  hideFx() {
    this.model.setBoost(false, 0);
  }

  dispose(scene: THREE.Scene = this.scene) {
    scene.remove(this.group);
    if (this.nameTag) scene.remove(this.nameTag);
    this.model.dispose();
    this.world.removeRigidBody(this.body);
  }
}
