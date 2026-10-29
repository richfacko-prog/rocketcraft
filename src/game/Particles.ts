import * as THREE from 'three';

const VERT = /* glsl */ `
attribute float size;
attribute float alpha;
attribute vec3 pcolor;
varying vec3 vColor;
varying float vAlpha;
uniform float uScale;
void main() {
  vColor = pcolor;
  vAlpha = alpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * uScale / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  float a = smoothstep(1.0, 0.0, d);
  a = a * a;
  gl_FragColor = vec4(vColor, a * vAlpha);
}`;

export interface EmitOpts {
  pos: THREE.Vector3;
  vel?: THREE.Vector3;
  spread?: number; // random velocity magnitude
  color: THREE.Color | number;
  color2?: THREE.Color | number; // color at end of life
  size: number;
  sizeEnd?: number;
  life: number;
  gravity?: number;
  drag?: number;
  count?: number;
  alpha?: number;
  jitter?: number; // spawn position jitter
}

class Pool {
  readonly max: number;
  points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private c0: Float32Array;
  private c1: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private a0: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private next = 0;
  material: THREE.ShaderMaterial;

  constructor(max: number, blending: THREE.Blending) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.c0 = new Float32Array(max * 3);
    this.c1 = new Float32Array(max * 3);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uScale: { value: 400 } },
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  emit(o: EmitOpts) {
    const count = o.count ?? 1;
    const c0 = o.color instanceof THREE.Color ? o.color : new THREE.Color(o.color);
    const c1 = o.color2 === undefined ? c0 : o.color2 instanceof THREE.Color ? o.color2 : new THREE.Color(o.color2);
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      const j = o.jitter ?? 0;
      this.pos[i * 3] = o.pos.x + (Math.random() - 0.5) * j;
      this.pos[i * 3 + 1] = o.pos.y + (Math.random() - 0.5) * j;
      this.pos[i * 3 + 2] = o.pos.z + (Math.random() - 0.5) * j;
      const sp = o.spread ?? 0;
      let rx = 0, ry = 0, rz = 0;
      if (sp > 0) {
        // random direction in sphere
        do {
          rx = Math.random() * 2 - 1;
          ry = Math.random() * 2 - 1;
          rz = Math.random() * 2 - 1;
        } while (rx * rx + ry * ry + rz * rz > 1);
      }
      this.vel[i * 3] = (o.vel?.x ?? 0) + rx * sp;
      this.vel[i * 3 + 1] = (o.vel?.y ?? 0) + ry * sp;
      this.vel[i * 3 + 2] = (o.vel?.z ?? 0) + rz * sp;
      const l = o.life * (0.7 + Math.random() * 0.6);
      this.life[i] = l;
      this.maxLife[i] = l;
      this.c0.set([c0.r, c0.g, c0.b], i * 3);
      this.c1.set([c1.r, c1.g, c1.b], i * 3);
      this.s0[i] = o.size;
      this.s1[i] = o.sizeEnd ?? o.size;
      this.a0[i] = o.alpha ?? 1;
      this.grav[i] = o.gravity ?? 0;
      this.drag[i] = o.drag ?? 0;
    }
  }

  update(dt: number) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        this.size[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const t = 1 - Math.max(0, this.life[i]) / this.maxLife[i];
      const k = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      for (let c = 0; c < 3; c++) this.col[i * 3 + c] = this.c0[i * 3 + c] + (this.c1[i * 3 + c] - this.c0[i * 3 + c]) * t;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      this.alpha[i] = this.a0[i] * (1 - t) * Math.min(1, t * 12 + 0.2);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.pcolor.needsUpdate = true;
    g.attributes.size.needsUpdate = true;
    g.attributes.alpha.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
  }
}

interface Ring {
  mesh: THREE.Mesh;
  age: number;
  life: number;
  scale: number;
}

export class Particles {
  glow: Pool;
  smoke: Pool;
  private rings: Ring[] = [];
  private ringGeo = new THREE.SphereGeometry(1, 32, 16);
  constructor(private scene: THREE.Scene) {
    this.glow = new Pool(6000, THREE.AdditiveBlending);
    this.smoke = new Pool(1500, THREE.NormalBlending);
    scene.add(this.smoke.points);
    scene.add(this.glow.points);
  }

  /** Expanding translucent shockwave sphere. */
  shockwave(pos: THREE.Vector3, color: number, scale: number, life = 0.7) {
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.6,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this.ringGeo, mat);
    mesh.position.copy(pos);
    mesh.scale.setScalar(0.1);
    mesh.renderOrder = 6;
    this.scene.add(mesh);
    this.rings.push({ mesh, age: 0, life, scale });
  }

  setViewport(heightPx: number, fovDeg: number) {
    const s = heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
    this.glow.material.uniforms.uScale.value = s;
    this.smoke.material.uniforms.uScale.value = s;
  }

  update(dt: number) {
    this.glow.update(dt);
    this.smoke.update(dt);
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.age += dt;
      const t = r.age / r.life;
      if (t >= 1) {
        this.scene.remove(r.mesh);
        (r.mesh.material as THREE.Material).dispose();
        this.rings.splice(i, 1);
        continue;
      }
      r.mesh.scale.setScalar(r.scale * (1 - Math.pow(1 - t, 3)));
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - t) * (1 - t);
    }
  }

  clear() {
    this.glow.clear();
    this.smoke.clear();
    for (const r of this.rings) this.scene.remove(r.mesh);
    this.rings = [];
  }

  explosion(pos: THREE.Vector3, color: number, scale = 1) {
    const c = new THREE.Color(color);
    const white = new THREE.Color(0xffffff);
    // fast sparks
    this.glow.emit({ pos, spread: 30 * scale, color: white, color2: c, size: 1.4 * scale, sizeEnd: 0.3, life: 1.6, drag: 1.4, gravity: 6, count: Math.round(360 * scale) });
    // lingering embers
    this.glow.emit({ pos, spread: 9 * scale, color: c.clone().lerp(white, 0.4), color2: c, size: 0.8 * scale, sizeEnd: 0.2, life: 2.6, drag: 0.8, gravity: -1, count: Math.round(160 * scale), jitter: 2 * scale });
    // fireball core
    this.glow.emit({ pos, spread: 6 * scale, color: white, color2: c, size: 7 * scale, sizeEnd: 14 * scale, life: 0.8, drag: 3, count: Math.round(60 * scale), alpha: 0.45 });
    this.smoke.emit({ pos, spread: 7 * scale, color: 0x9098a8, color2: 0x404450, size: 5 * scale, sizeEnd: 13 * scale, life: 2.4, drag: 1.5, gravity: -1.2, count: Math.round(26 * scale), alpha: 0.18, jitter: 3 * scale });
    this.shockwave(pos, color, 14 * scale, 0.75);
    this.shockwave(pos, 0xffffff, 6 * scale, 0.4);
  }

  sparks(pos: THREE.Vector3, normal: THREE.Vector3, strength: number) {
    const n = Math.min(60, Math.round(6 + strength * 1.2));
    this.glow.emit({
      pos,
      vel: normal.clone().multiplyScalar(4 + strength * 0.15),
      spread: 6 + strength * 0.25,
      color: 0xfff2c0,
      color2: 0xff7a20,
      size: 0.45,
      sizeEnd: 0.05,
      life: 0.45,
      gravity: 12,
      drag: 1,
      count: n,
    });
  }
}
