import * as THREE from 'three';
import { arenaNormal, arenaSdf } from './Arena';
import type { Car } from './Car';

const WORLD_UP = new THREE.Vector3(0, 1, 0);

function damp(rate: number, dt: number) {
  return 1 - Math.exp(-rate * dt);
}

/** Rocket League style chase cam / ball cam with boost FOV and shake. */
export class GameCamera {
  camera: THREE.PerspectiveCamera;
  ballCam = true;
  baseFov = 74;
  distance = 7.2;
  height = 2.6;
  static readonly MIN_DIST = 5;
  static readonly MAX_DIST = 12;
  private shakeAmt = 0;
  private fovExtra = 0;
  private up = new THREE.Vector3(0, 1, 0);
  private heading = new THREE.Vector3(1, 0, 0);
  private pos = new THREE.Vector3(-20, 6, 0);
  private look = new THREE.Vector3();
  private initialized = false;
  /** Right-stick look (-1..1), set every frame by the match. */
  lookInput = { x: 0, y: 0 };
  private lookYaw = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 0.1, 1400);
    try {
      const s = JSON.parse(localStorage.getItem('racecraft.camera') || '{}');
      if (typeof s.distance === 'number') this.setDistance(s.distance, false);
      if (typeof s.fov === 'number') this.setFov(s.fov, false);
      if (typeof s.ballCam === 'boolean') this.ballCam = s.ballCam;
    } catch {
      /* defaults */
    }
  }

  /** Camera distance behind the car; height scales with it. */
  setDistance(d: number, persist = true) {
    this.distance = THREE.MathUtils.clamp(d, GameCamera.MIN_DIST, GameCamera.MAX_DIST);
    this.height = 1.2 + this.distance * 0.195;
    if (persist) this.save();
  }

  setFov(f: number, persist = true) {
    this.baseFov = THREE.MathUtils.clamp(f, 60, 100);
    if (persist) this.save();
  }

  save() {
    try {
      localStorage.setItem('racecraft.camera', JSON.stringify({ distance: this.distance, fov: this.baseFov, ballCam: this.ballCam }));
    } catch {
      /* storage unavailable */
    }
  }

  shake(amount: number) {
    this.shakeAmt = Math.max(this.shakeAmt, amount);
  }

  snapTo(car: Car, ballPos: THREE.Vector3) {
    this.initialized = false;
    this.update(1 / 60, car, ballPos, true);
  }

  update(dt: number, car: Car, ballPos: THREE.Vector3, snap = false) {
    const k = snap || !this.initialized ? 1 : 0;
    const carPos = car.group.position;
    // camera "up": on any surface (floor, wall, ceiling) the camera rides with the car like in
    // Rocket League; in the air it eases back to a level horizon.
    const onSurface = car.onGround && !car.demolished;
    const targetUp = onSurface ? car.surfaceNormal : WORLD_UP;
    this.up.lerp(targetUp, k || damp(onSurface ? 6 : 3, dt)).normalize();

    const carFwd = new THREE.Vector3(1, 0, 0).applyQuaternion(car.group.quaternion);
    const flatFwd = carFwd.clone().addScaledVector(this.up, -carFwd.dot(this.up));
    let desiredHeading: THREE.Vector3;
    if (this.ballCam) {
      const toBall = ballPos.clone().sub(carPos);
      const len = toBall.length() || 1;
      desiredHeading = toBall.clone().addScaledVector(this.up, -toBall.dot(this.up));
      // ball almost straight "above" the car (e.g. car on a wall, ball out in the field):
      // there is no clear behind-direction, so lean on the car's own heading instead
      const planar = desiredHeading.length() / len;
      if (planar < 0.45 && flatFwd.lengthSq() > 0.05) desiredHeading.lerp(flatFwd.clone().normalize().multiplyScalar(len), 1 - planar / 0.45);
    } else {
      desiredHeading = flatFwd.clone();
      // pointing straight along "up" (mid-air): use the velocity direction
      if (desiredHeading.lengthSq() < 0.05 && car.vel.lengthSq() > 4) desiredHeading.copy(car.vel).addScaledVector(this.up, -car.vel.dot(this.up));
    }
    if (desiredHeading.lengthSq() < 1e-4) desiredHeading.copy(this.heading);
    desiredHeading.normalize();
    // keep heading on the plane and slerp it
    this.heading.addScaledVector(this.up, -this.heading.dot(this.up)).normalize();
    this.heading.lerp(desiredHeading, k || damp(this.ballCam ? 9 : 7, dt)).normalize();

    // right-stick look-around swings the camera around the car
    this.lookYaw += (this.lookInput.x * 2.6 - this.lookYaw) * damp(10, dt);
    const view = Math.abs(this.lookYaw) > 1e-3 ? this.heading.clone().applyAxisAngle(this.up, -this.lookYaw) : this.heading;
    const speedT = Math.min(1, car.vel.length() / 40);
    const dist = this.distance + speedT * 0.4;
    const desired = carPos.clone().addScaledVector(view, -dist).addScaledVector(this.up, this.height);
    if (car.demolished) desired.copy(this.pos);
    this.pos.lerp(desired, k || damp(18, dt));

    // keep inside arena
    const s = arenaSdf(this.pos.x, this.pos.y, this.pos.z);
    if (s < 0.8) this.pos.addScaledVector(arenaNormal(this.pos, new THREE.Vector3()), 0.8 - s);

    let lookTarget: THREE.Vector3;
    if (this.ballCam) {
      const toBall = ballPos.clone().sub(this.pos);
      const len = toBall.length();
      toBall.normalize();
      // limit pitch so the car stays in frame
      const elev = Math.asin(THREE.MathUtils.clamp(toBall.dot(this.up), -1, 1));
      const maxElev = THREE.MathUtils.degToRad(28);
      const minElev = THREE.MathUtils.degToRad(-14);
      const ce = THREE.MathUtils.clamp(elev, minElev, maxElev);
      const flat = toBall.clone().addScaledVector(this.up, -toBall.dot(this.up)).normalize();
      if (flat.lengthSq() < 0.5) flat.copy(this.heading);
      const dir = flat.multiplyScalar(Math.cos(ce)).addScaledVector(this.up, Math.sin(ce));
      lookTarget = this.pos.clone().addScaledVector(dir, Math.max(7, Math.min(len, 26)));
      // bias toward the car so it stays low in the frame
      const carLook = carPos.clone().addScaledVector(this.up, 1.0).addScaledVector(this.heading, 3);
      lookTarget.lerp(carLook, 0.25);
    } else {
      lookTarget = carPos.clone().addScaledVector(this.up, 1.1).addScaledVector(view, 2.5);
    }
    if (Math.abs(this.lookYaw) > 0.2) lookTarget = carPos.clone().addScaledVector(this.up, 1.1).addScaledVector(view, 2.5);
    if (car.demolished) lookTarget = ballPos.clone();
    else {
      // never let the car leave the frame: limit the angle between the view and the car
      const dirLook = lookTarget.clone().sub(this.pos).normalize();
      const dirCar = carPos.clone().addScaledVector(this.up, 0.3).sub(this.pos).normalize();
      const ang = dirLook.angleTo(dirCar);
      const maxA = THREE.MathUtils.degToRad(this.camera.fov * 0.36);
      if (ang > maxA) {
        const q = new THREE.Quaternion().setFromUnitVectors(dirLook, dirCar);
        const part = new THREE.Quaternion().slerp(q, (ang - maxA) / ang);
        dirLook.applyQuaternion(part);
        lookTarget = this.pos.clone().addScaledVector(dirLook, Math.max(7, lookTarget.distanceTo(this.pos)));
      }
    }
    this.look.lerp(lookTarget, k || damp(20, dt));
    this.initialized = true;

    // FOV and shake
    const fovTarget = (car.boosting ? 5 : 0) + (car.supersonic ? 4 : 0);
    this.fovExtra += (fovTarget - this.fovExtra) * damp(4, dt);
    if (car.boosting) this.shakeAmt = Math.max(this.shakeAmt, 0.035);
    this.apply(dt);
  }

  /** Free cinematic camera used for replays. */
  updateReplay(dt: number, ballPos: THREE.Vector3, ballVel: THREE.Vector3, snap = false) {
    const k = snap ? 1 : 0;
    const flat = ballVel.clone();
    flat.y = 0;
    if (flat.lengthSq() < 1) flat.copy(this.heading);
    flat.normalize();
    this.heading.lerp(flat, k || damp(1.5, dt)).normalize();
    const side = new THREE.Vector3().crossVectors(this.heading, WORLD_UP).normalize();
    const desired = ballPos.clone().addScaledVector(this.heading, -16).addScaledVector(side, 8).add(new THREE.Vector3(0, 6, 0));
    this.pos.lerp(desired, k || damp(3, dt));
    const s = arenaSdf(this.pos.x, this.pos.y, this.pos.z);
    if (s < 1) this.pos.addScaledVector(arenaNormal(this.pos, new THREE.Vector3()), 1 - s);
    this.look.lerp(ballPos, k || damp(8, dt));
    this.up.lerp(WORLD_UP, k || damp(3, dt)).normalize();
    this.fovExtra += (0 - this.fovExtra) * damp(4, dt);
    this.apply(dt);
  }

  /** Static overview camera (menus). */
  updateOrbit(time: number) {
    const a = time * 0.06;
    this.pos.set(Math.cos(a) * 120, 42, Math.sin(a) * 92);
    this.look.set(0, 2, 0);
    this.up.copy(WORLD_UP);
    this.apply(0);
  }

  private apply(dt: number) {
    const cam = this.camera;
    cam.position.copy(this.pos);
    if (this.shakeAmt > 0.001) {
      const a = this.shakeAmt;
      cam.position.x += (Math.random() - 0.5) * a;
      cam.position.y += (Math.random() - 0.5) * a;
      cam.position.z += (Math.random() - 0.5) * a;
      this.shakeAmt *= Math.exp(-dt * 5);
    }
    cam.up.copy(this.up);
    cam.lookAt(this.look);
    const fov = this.baseFov + this.fovExtra;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  get fov() {
    return this.camera.fov;
  }
}
