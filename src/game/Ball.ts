import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { ARENA, BALL, CAR, HIT_SCALE_CURVE, UU, curveLerp } from './Config';
import { arenaNormal, arenaSdf, GROUP_ARENA, GROUP_BALL, groups } from './Arena';
import type { Car } from './Car';

const v3 = () => new THREE.Vector3();

export interface HitInfo {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  strength: number; // change of ball speed
}

function makeBallTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#c9ced8';
  g.fillRect(0, 0, 1024, 512);
  // hex panel pattern in equirect space
  const r = 46;
  const hh = Math.sqrt(3) * r;
  for (let row = -1; row < 512 / hh + 1; row++) {
    for (let col = -1; col < 1024 / (r * 1.5) + 1; col++) {
      const cx = col * r * 1.5;
      const cy = row * hh + (col % 2 ? hh / 2 : 0);
      g.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k;
        const x = cx + r * 0.92 * Math.cos(a);
        const y = cy + r * 0.92 * Math.sin(a);
        if (k === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      g.fillStyle = (row + col) % 3 === 0 ? '#3a3f4a' : '#e8ebf0';
      g.fill();
      g.strokeStyle = '#2a2d35';
      g.lineWidth = 4;
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function makeShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(0,0,0,0.75)');
  grd.addColorStop(0.6, 'rgba(0,0,0,0.45)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export class Ball {
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh;
  shadow: THREE.Mesh;
  pos = v3();
  vel = v3();
  angVel = v3();
  quat = new THREE.Quaternion();
  private prevPos = v3();
  private prevQuat = new THREE.Quaternion();
  private mat: THREE.MeshStandardMaterial;
  private flash = 0;
  frozen = false;
  /** Predicted path: positions at 1/60s intervals. */
  predicted: THREE.Vector3[] = [];
  predictedVel: THREE.Vector3[] = [];
  static readonly PRED_DT = 1 / 60;
  static readonly PRED_STEPS = 240;

  constructor(world: RAPIER.World, scene: THREE.Scene) {
    const R = BALL.radius;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setCanSleep(false).setCcdEnabled(true).setAngularDamping(0.05).setLinearDamping(0),
    );
    const vol = (4 / 3) * Math.PI * R * R * R;
    world.createCollider(
      RAPIER.ColliderDesc.ball(R)
        .setDensity(BALL.mass / vol)
        .setRestitution(BALL.restitution)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
        .setFriction(0.35)
        .setCollisionGroups(groups(GROUP_BALL, GROUP_ARENA)),
      this.body,
    );
    this.mat = new THREE.MeshStandardMaterial({
      map: makeBallTexture(),
      roughness: 0.35,
      metalness: 0.25,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.0,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(R, 48, 32), this.mat);
    this.mesh.castShadow = true;
    scene.add(this.mesh);
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: makeShadowTexture(), transparent: true, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 1;
    scene.add(this.shadow);
    for (let i = 0; i < Ball.PRED_STEPS; i++) {
      this.predicted.push(v3());
      this.predictedVel.push(v3());
    }
  }

  reset(x = 0, y = BALL.radius + 0.02, z = 0) {
    this.body.setTranslation({ x, y, z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.readState();
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    this.mesh.visible = true;
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
  }

  writeVel() {
    this.body.setLinvel({ x: this.vel.x, y: this.vel.y, z: this.vel.z }, true);
    this.body.setAngvel({ x: this.angVel.x, y: this.angVel.y, z: this.angVel.z }, true);
  }

  prePhysics(dt: number) {
    this.prevPos.copy(this.pos);
    this.prevQuat.copy(this.quat);
    this.readState();
    if (this.frozen) {
      this.vel.set(0, 0, 0);
      this.angVel.set(0, 0, 0);
      this.writeVel();
      return;
    }
    this.vel.y -= BALL.gravity * dt;
    this.vel.multiplyScalar(1 - BALL.drag * dt);
    const s = this.vel.length();
    if (s > BALL.maxSpeed) this.vel.multiplyScalar(BALL.maxSpeed / s);
    if (this.angVel.length() > 6) this.angVel.setLength(6);
    this.writeVel();
  }

  /** Rocket-League style car/ball interaction. Call after world.step with fresh state. */
  collideCar(car: Car, time: number): HitInfo | null {
    if (car.demolished) return null;
    const R = BALL.radius;
    const h = CAR.halfExtents;
    const qi = car.quat.clone().invert();
    const local = this.pos.clone().sub(car.pos).applyQuaternion(qi);
    const cl = new THREE.Vector3(
      THREE.MathUtils.clamp(local.x, -h.x, h.x),
      THREE.MathUtils.clamp(local.y, -h.y, h.y),
      THREE.MathUtils.clamp(local.z, -h.z, h.z),
    );
    const closest = cl.clone().applyQuaternion(car.quat).add(car.pos);
    const d = this.pos.clone().sub(closest);
    const dist = d.length();
    if (dist >= R) return null;
    const n = dist > 1e-4 ? d.multiplyScalar(1 / dist) : this.pos.clone().sub(car.pos).normalize();
    // push ball out of the car
    this.pos.addScaledVector(n, R - dist + 0.001);
    this.body.setTranslation({ x: this.pos.x, y: this.pos.y, z: this.pos.z }, true);

    const arm = closest.clone().sub(car.pos);
    const vCar = car.vel.clone().add(v3().crossVectors(car.angVel, arm));
    const vrel = this.vel.clone().sub(vCar);
    const vn = vrel.dot(n);
    if (vn >= 0) return null;
    const before = this.vel.clone();
    const relSpeed0 = car.vel.clone().sub(this.vel).length();
    const mb = BALL.mass;
    const mc = 1;
    const e = 0.05;
    const j = (-(1 + e) * vn) / (1 / mb + 1 / mc);
    this.vel.addScaledVector(n, j / mb);
    car.vel.addScaledVector(n, -j / mc);

    // spin from tangential friction
    const vt = vrel.clone().addScaledVector(n, -vn);
    this.angVel.add(v3().crossVectors(n, vt).multiplyScalar(0.35 / R));

    // Dribble assist: soft touches (low relative speed) carry the ball with the car instead of
    // knocking it away, so ground and air dribbles are controllable. Hard hits are unchanged.
    // only when the ball sits on top of the car (roof / hood), i.e. an actual dribble
    const onTop = THREE.MathUtils.clamp((n.dot(car.up) - 0.55) / 0.3, 0, 1);
    // (assist is for human players only; bots play the plain hit model)
    const soft = car.isPlayer ? THREE.MathUtils.clamp(1 - relSpeed0 / BALL.dribbleSpeed, 0, 1) * onTop : 0;
    if (soft > 0) {
      const carVt = vCar.clone().addScaledVector(n, -vCar.dot(n));
      const ballVt = this.vel.clone().addScaledVector(n, -this.vel.dot(n));
      this.vel.add(carVt.sub(ballVt).multiplyScalar(0.5 * soft));
      // keep the ball moving with the car along the contact normal (no bounce-off)
      const sep = this.vel.dot(n) - vCar.dot(n);
      if (sep > 0) this.vel.addScaledVector(n, -sep * 0.6 * soft);
    }

    // Psyonix extra impulse (only on the start of a touch), softened for dribble touches
    if (time - car.lastBallHit > 0.1) {
      const relSpeed = Math.min(relSpeed0, 4600 * UU);
      const dir = this.pos.clone().sub(car.pos).applyQuaternion(qi);
      dir.y *= 0.35;
      dir.applyQuaternion(car.quat);
      dir.addScaledVector(car.fwd, -0.35 * dir.dot(car.fwd));
      dir.normalize();
      // a little extra forward bias for punchy, readable hits
      dir.addScaledVector(car.fwd, 0.12 * Math.max(0, car.fwd.dot(dir))).normalize();
      const scale = curveLerp(HIT_SCALE_CURVE, relSpeed / UU);
      this.vel.addScaledVector(dir, relSpeed * scale * (1 - 0.75 * soft));
    }
    car.lastBallHit = time;
    const sp = this.vel.length();
    if (sp > BALL.maxSpeed) this.vel.multiplyScalar(BALL.maxSpeed / sp);
    this.writeVel();
    car.body.setLinvel({ x: car.vel.x, y: car.vel.y, z: car.vel.z }, true);
    const strength = this.vel.clone().sub(before).length();
    this.flash = Math.min(1, strength / 30);
    return { point: closest, normal: n.clone(), strength };
  }

  /** Simple ballistic prediction with arena bounces (for AI and shot/save stats). */
  predict() {
    const p = this.pos.clone();
    const v = this.vel.clone();
    const dt = Ball.PRED_DT;
    const R = BALL.radius;
    const n = v3();
    for (let i = 0; i < Ball.PRED_STEPS; i++) {
      v.y -= BALL.gravity * dt;
      v.multiplyScalar(1 - BALL.drag * dt);
      p.addScaledVector(v, dt);
      const s = arenaSdf(p.x, p.y, p.z);
      if (s < R) {
        arenaNormal(p, n);
        p.addScaledVector(n, R - s);
        const vn = v.dot(n);
        if (vn < 0) {
          v.addScaledVector(n, -(1 + BALL.restitution * 0.92) * vn);
          // tangential friction
          const vt = v.clone().addScaledVector(n, -v.dot(n));
          v.addScaledVector(vt, -0.12);
        }
      }
      this.predicted[i].copy(p);
      this.predictedVel[i].copy(v);
    }
  }

  /** Does the ball's predicted path enter the goal defended by `team` within `seconds`? */
  headingIntoGoal(team: 0 | 1, seconds = 2.5): boolean {
    const sign = team === 0 ? -1 : 1;
    const steps = Math.min(Ball.PRED_STEPS, Math.round(seconds / Ball.PRED_DT));
    for (let i = 0; i < steps; i++) {
      const p = this.predicted[i];
      if (p.x * sign > ARENA.halfLength + BALL.radius * 0.5) return true;
    }
    return false;
  }

  syncVisual(alpha: number, dt: number) {
    this.mesh.position.lerpVectors(this.prevPos, this.pos, alpha);
    this.mesh.quaternion.slerpQuaternions(this.prevQuat, this.quat, alpha);
    this.flash = Math.max(0, this.flash - dt * 3);
    this.mat.emissiveIntensity = this.flash * 0.6;
    this.updateShadow();
  }

  setVisualPose(p: THREE.Vector3, q: THREE.Quaternion) {
    this.mesh.position.copy(p);
    this.mesh.quaternion.copy(q);
    this.updateShadow();
  }

  private updateShadow() {
    const p = this.mesh.position;
    const hgt = Math.max(0, p.y - BALL.radius);
    const s = BALL.radius * 2.2 * (1 + hgt * 0.025);
    this.shadow.scale.set(s, s, 1);
    this.shadow.position.set(p.x, 0.05, p.z);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.clamp(1 - hgt / 45, 0.35, 1);
    this.shadow.visible = this.mesh.visible && Math.abs(p.x) < ARENA.halfLength + ARENA.goalDepth;
  }
}
