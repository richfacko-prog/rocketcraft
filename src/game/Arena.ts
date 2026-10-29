import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { ARENA, TEAM_COLORS, UU, rlToWorld } from './Config';

const { halfLength: A, halfWidth: B, height: H, cornerRadius: RC, rampRadius: RF } = ARENA;
const GW = ARENA.goalWidth / 2;
const GH = ARENA.goalHeight;
const GD = ARENA.goalDepth;
// Inset ("core") rounded rectangle: the flat floor region.
const IA = A - RF;
const IB = B - RF;
const IRC = RC - RF;

export const GROUP_ARENA = 0x0001;
export const GROUP_CAR = 0x0002;
export const GROUP_BALL = 0x0004;
export function groups(member: number, filter: number) {
  return (member << 16) | filter;
}

/** Signed distance to the arena surface: positive inside the playable volume. */
export function arenaSdf(x: number, y: number, z: number): number {
  // Main rounded box = Minkowski sum of a rounded prism and a sphere of radius RF
  const qx = Math.abs(x) - (IA - IRC);
  const qz = Math.abs(z) - (IB - IRC);
  const mx = Math.max(qx, 0);
  const mz = Math.max(qz, 0);
  const d2 = Math.sqrt(mx * mx + mz * mz) + Math.min(Math.max(qx, qz), 0) - IRC;
  const wy = Math.abs(y - H / 2) - (H / 2 - RF);
  const ox = Math.max(d2, 0);
  const oy = Math.max(wy, 0);
  const core = Math.min(Math.max(d2, wy), 0) + Math.sqrt(ox * ox + oy * oy);
  let d = RF - core;
  // Goals: interior boxes unioned into the free space
  const ax = Math.abs(x);
  const g = Math.min(ax - (IA - 2), A + GD - ax, GW - Math.abs(z), y, GH - y);
  if (g > d) d = g;
  return d;
}

const _n = new THREE.Vector3();
/** Inward-facing surface normal at (or near) point p. */
export function arenaNormal(p: THREE.Vector3, out: THREE.Vector3 = _n): THREE.Vector3 {
  const e = 0.04;
  out.set(
    arenaSdf(p.x + e, p.y, p.z) - arenaSdf(p.x - e, p.y, p.z),
    arenaSdf(p.x, p.y + e, p.z) - arenaSdf(p.x, p.y - e, p.z),
    arenaSdf(p.x, p.y, p.z + e) - arenaSdf(p.x, p.y, p.z - e),
  );
  const l = out.length();
  if (l < 1e-6) out.set(0, 1, 0);
  else out.multiplyScalar(1 / l);
  return out;
}

const _rp = new THREE.Vector3();
/** Sphere-traced raycast against the analytic arena. Returns hit distance or -1. */
export function arenaRaycast(o: THREE.Vector3, d: THREE.Vector3, maxDist: number): number {
  let t = 0;
  for (let i = 0; i < 24; i++) {
    _rp.copy(o).addScaledVector(d, t);
    const s = arenaSdf(_rp.x, _rp.y, _rp.z);
    if (s < 0.003) return t;
    t += s;
    if (t > maxDist) return -1;
  }
  return t <= maxDist ? t : -1;
}

interface PerimPt {
  x: number;
  z: number;
  nx: number;
  nz: number;
  s: number; // arc length
  end: boolean; // lies on a goal-end straight
}

function buildPerimeter(): PerimPt[] {
  const pts: PerimPt[] = [];
  const cx = IA - IRC;
  const cz = IB - IRC;
  const push = (x: number, z: number, nx: number, nz: number, end: boolean) => {
    const last = pts[pts.length - 1];
    if (last && Math.abs(last.x - x) < 1e-6 && Math.abs(last.z - z) < 1e-6) {
      last.end = last.end && end;
      return;
    }
    const s = last ? last.s + Math.hypot(x - last.x, z - last.z) : 0;
    pts.push({ x, z, nx, nz, s, end });
  };
  const line = (breaks: number[], f: (t: number) => [number, number], nx: number, nz: number, end: boolean) => {
    for (let k = 0; k < breaks.length - 1; k++) {
      const a0 = breaks[k];
      const a1 = breaks[k + 1];
      const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 3));
      for (let i = 0; i <= n; i++) {
        const [x, z] = f(a0 + ((a1 - a0) * i) / n);
        push(x, z, nx, nz, end);
      }
    }
  };
  const arc = (ccx: number, ccz: number, a0: number, a1: number) => {
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      push(ccx + IRC * Math.cos(a), ccz + IRC * Math.sin(a), Math.cos(a), Math.sin(a), false);
    }
  };
  line([-cz, -GW, GW, cz], (t) => [IA, t], 1, 0, true);
  arc(cx, cz, 0, Math.PI / 2);
  line([cx, -cx], (t) => [t, IB], 0, 1, false);
  arc(-cx, cz, Math.PI / 2, Math.PI);
  line([cz, GW, -GW, -cz], (t) => [-IA, t], -1, 0, true);
  arc(-cx, -cz, Math.PI, Math.PI * 1.5);
  line([-cx, cx], (t) => [t, -IB], 0, -1, false);
  arc(cx, -cz, Math.PI * 1.5, Math.PI * 2);
  // remove closing duplicate
  const f = pts[0];
  const l = pts[pts.length - 1];
  if (Math.hypot(f.x - l.x, f.z - l.z) < 1e-6) pts.pop();
  // mark endpoints of segments: end flag means on end straight
  return pts;
}

function buildProfile(): { r: number; y: number }[] {
  const prof: { r: number; y: number }[] = [];
  const n = 10;
  for (let i = 0; i <= n; i++) {
    const t = ((Math.PI / 2) * i) / n;
    prof.push({ r: RF * Math.sin(t), y: RF * (1 - Math.cos(t)) });
  }
  const wallBreaks = [RF, GH, H - RF];
  for (let k = 0; k < wallBreaks.length - 1; k++) {
    const y0 = wallBreaks[k];
    const y1 = wallBreaks[k + 1];
    const m = Math.max(1, Math.ceil((y1 - y0) / 2.5));
    for (let i = 1; i <= m; i++) prof.push({ r: RF, y: y0 + ((y1 - y0) * i) / m });
  }
  for (let i = 1; i <= n; i++) {
    const t = ((Math.PI / 2) * i) / n;
    prof.push({ r: RF * Math.cos(t), y: H - RF + RF * Math.sin(t) });
  }
  return prof;
}

export class BoostPad {
  active = true;
  timer = 0;
  readonly respawn: number;
  readonly amount: number;
  readonly radius: number;
  group = new THREE.Group();
  private disc: THREE.Mesh;
  private orb?: THREE.Mesh;
  private halo?: THREE.Sprite;
  private discMat: THREE.MeshBasicMaterial;

  constructor(
    public readonly pos: THREE.Vector3,
    public readonly big: boolean,
    glowTex: THREE.Texture,
  ) {
    this.respawn = big ? 10 : 4;
    this.amount = big ? 100 : 12;
    this.radius = big ? 208 * UU : 144 * UU;
    const baseR = big ? 2.4 : 1.25;
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(baseR, baseR * 1.1, 0.12, 24),
      new THREE.MeshStandardMaterial({ color: 0x222831, metalness: 0.6, roughness: 0.4 }),
    );
    base.position.y = 0.06;
    base.receiveShadow = true;
    this.group.add(base);
    this.discMat = new THREE.MeshBasicMaterial({ color: 0xffc23a });
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(baseR * 0.75, 24), this.discMat);
    this.disc.rotation.x = -Math.PI / 2;
    this.disc.position.y = 0.13;
    this.group.add(this.disc);
    if (big) {
      this.orb = new THREE.Mesh(
        new THREE.SphereGeometry(1.0, 20, 14),
        new THREE.MeshBasicMaterial({ color: 0xffd060 }),
      );
      this.orb.position.y = 2.0;
      this.group.add(this.orb);
      this.halo = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: glowTex,
          color: 0xffa020,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          transparent: true,
          opacity: 0.85,
        }),
      );
      this.halo.scale.set(6.5, 6.5, 1);
      this.halo.position.y = 2.0;
      this.group.add(this.halo);
    }
    this.group.position.copy(pos);
  }

  take() {
    this.active = false;
    this.timer = this.respawn;
    this.discMat.color.set(0x3a2a10);
    if (this.orb) this.orb.visible = false;
    if (this.halo) this.halo.visible = false;
  }

  reset() {
    this.active = true;
    this.timer = 0;
    this.discMat.color.set(0xffc23a);
    if (this.orb) this.orb.visible = true;
    if (this.halo) this.halo.visible = true;
  }

  update(dt: number, time: number) {
    if (!this.active) {
      this.timer -= dt;
      if (this.timer <= 0) this.reset();
    } else {
      const pulse = 0.75 + 0.25 * Math.sin(time * 4 + this.pos.x);
      this.discMat.color.setRGB(1 * pulse, 0.76 * pulse, 0.23 * pulse);
      if (this.orb) {
        this.orb.position.y = 2.0 + Math.sin(time * 2 + this.pos.z) * 0.25;
        this.orb.rotation.y = time;
        if (this.halo) this.halo.position.y = this.orb.position.y;
      }
    }
  }
}

function makeGlowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.6)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function roundRectPath(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.arcTo(x + w, y, x + w, y + r, r);
  g.lineTo(x + w, y + h - r);
  g.arcTo(x + w, y + h, x + w - r, y + h, r);
  g.lineTo(x + r, y + h);
  g.arcTo(x, y + h, x, y + h - r, r);
  g.lineTo(x, y + r);
  g.arcTo(x, y, x + r, y, r);
  g.closePath();
}

function makeNoiseTile(size: number, amount: number, base = 128): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = base + (Math.random() - 0.5) * amount;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = n;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Tiled grain used as a bump map so the turf has detail up close. */
function makeTurfBump(): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(makeNoiseTile(256, 160));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(90, 70);
  t.anisotropy = 8;
  return t;
}

function makeFloorTexture(): THREE.CanvasTexture {
  const W = 4096;
  const Hh = Math.round((W * (B + 1)) / (A + GD + 1));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = Hh;
  const g = c.getContext('2d')!;
  const sx = W / (2 * (A + GD + 1));
  const sz = Hh / (2 * (B + 1));
  const X = (x: number) => (x + A + GD + 1) * sx;
  const Z = (z: number) => (z + B + 1) * sz;
  // Turf base with mowing stripes
  g.fillStyle = '#1d4a2b';
  g.fillRect(0, 0, W, Hh);
  const stripes = 24;
  for (let i = 0; i < stripes; i++) {
    const x0 = -A + (2 * A * i) / stripes;
    g.fillStyle = i % 2 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.07)';
    g.fillRect(X(x0), 0, (2 * A * sx) / stripes, Hh);
  }
  // Team tint halves
  let grd = g.createLinearGradient(X(-A), 0, X(0), 0);
  grd.addColorStop(0, 'rgba(40,120,255,0.40)');
  grd.addColorStop(1, 'rgba(40,120,255,0.04)');
  g.fillStyle = grd;
  g.fillRect(0, 0, X(0), Hh);
  grd = g.createLinearGradient(X(0), 0, X(A), 0);
  grd.addColorStop(0, 'rgba(255,130,20,0.04)');
  grd.addColorStop(1, 'rgba(255,130,20,0.40)');
  g.fillStyle = grd;
  g.fillRect(X(0), 0, W - X(0), Hh);
  // Grain (pattern fill is much cheaper than per-pixel noise at this size)
  g.globalAlpha = 0.18;
  g.globalCompositeOperation = 'overlay';
  g.fillStyle = g.createPattern(makeNoiseTile(256, 90), 'repeat')!;
  g.fillRect(0, 0, W, Hh);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  // Grid
  g.strokeStyle = 'rgba(255,255,255,0.045)';
  g.lineWidth = 3;
  for (let x = -A; x <= A; x += 10) {
    g.beginPath();
    g.moveTo(X(x), Z(-B));
    g.lineTo(X(x), Z(B));
    g.stroke();
  }
  for (let z = -B; z <= B; z += 10) {
    g.beginPath();
    g.moveTo(X(-A), Z(z));
    g.lineTo(X(A), Z(z));
    g.stroke();
  }
  // Field markings
  const line = 0.45; // world units
  g.strokeStyle = 'rgba(255,255,255,0.82)';
  g.lineWidth = line * sx;
  const inset = 1.2;
  roundRectPath(g, X(-IA + inset), Z(-IB + inset), (2 * (IA - inset)) * sx, (2 * (IB - inset)) * sz, (IRC - inset) * sx);
  g.stroke();
  g.beginPath();
  g.moveTo(X(0), Z(-IB + inset));
  g.lineTo(X(0), Z(IB - inset));
  g.stroke();
  const circle = (cx: number, cz: number, r: number, a0 = 0, a1 = Math.PI * 2) => {
    g.beginPath();
    g.ellipse(X(cx), Z(cz), r * sx, r * sz, 0, a0, a1);
    g.stroke();
  };
  circle(0, 0, 18);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.beginPath();
  g.ellipse(X(0), Z(0), 1.1 * sx, 1.1 * sz, 0, 0, Math.PI * 2);
  g.fill();
  for (const s of [-1, 1]) {
    const gl = s * (IA - inset); // goal-end line
    const box = (depth: number, halfW: number) =>
      g.strokeRect(s < 0 ? X(gl) : X(gl - depth), Z(-halfW), depth * sx, 2 * halfW * sz);
    box(28, GW + 18); // penalty area
    box(10, GW + 5); // goal area
    // penalty spot and arc
    const spot = gl - s * 20;
    g.beginPath();
    g.ellipse(X(spot), Z(0), 0.7 * sx, 0.7 * sz, 0, 0, Math.PI * 2);
    g.fill();
    const edge = gl - s * 28;
    const r = 13;
    const a = Math.acos((edge - spot) / (r * -s) || 0);
    if (s < 0) circle(spot, 0, r, -a, a);
    else circle(spot, 0, r, Math.PI - a, Math.PI + a);
    // goal interior tint
    g.fillStyle = s < 0 ? 'rgba(40,120,255,0.28)' : 'rgba(255,130,20,0.28)';
    g.fillRect(s < 0 ? X(-A - GD) : X(A), Z(-GW), GD * sx, 2 * GW * sz);
    g.fillStyle = 'rgba(255,255,255,0.85)';
  }
  // Center logo
  g.save();
  g.translate(X(0), Z(0));
  g.globalAlpha = 0.16;
  g.fillStyle = '#ffffff';
  g.font = `italic 700 ${Math.round(7 * sx)}px Rajdhani, system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('RACECRAFT', 0, 0);
  g.restore();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function makeGridTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(255,255,255,1)';
  g.lineWidth = 6;
  // hexagon-ish panel pattern
  g.strokeRect(0, 0, 256, 256);
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, 128);
  g.lineTo(256, 128);
  g.moveTo(128, 0);
  g.lineTo(128, 256);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}


function makeCrowdTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0a0d16';
  g.fillRect(0, 0, 1024, 512);
  const shirts = ['#2f8cff', '#ff8a1e', '#e8e8f0', '#3b4155', '#8a96ad', '#1f5fc0', '#c66510', '#f2d36b'];
  const rows = 16;
  for (let r = 0; r < rows; r++) {
    const y = (r + 0.6) * (512 / rows);
    g.fillStyle = '#151a28';
    g.fillRect(0, y + 10, 1024, 5); // seat row
    for (let x = 4; x < 1024; x += 9 + Math.random() * 4) {
      if (Math.random() < 0.12) continue; // empty seat
      const shirt = shirts[(Math.random() * shirts.length) | 0];
      g.fillStyle = shirt;
      g.globalAlpha = 0.55 + Math.random() * 0.45;
      g.fillRect(x, y, 7, 11);
      g.fillStyle = Math.random() < 0.5 ? '#c99a7a' : '#6b4a36';
      g.beginPath();
      g.arc(x + 3.5, y - 3, 3.2, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function makeLedTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#05070d';
  g.fillRect(0, 0, 2048, 64);
  const parts = ['RACECRAFT', '◆', 'BLUE', 'VS', 'ORANGE', '◆', 'BOOST UP', '◆', 'RACECRAFT', '◆', 'SUPERSONIC', '◆'];
  g.font = 'italic 700 44px Rajdhani, system-ui, sans-serif';
  g.textBaseline = 'middle';
  let x = 20;
  for (const p of parts) {
    g.fillStyle = p === 'BLUE' ? '#4aa0ff' : p === 'ORANGE' ? '#ff9a2e' : p === '◆' ? '#ffcf6a' : '#eef3ff';
    g.fillText(p, x, 34);
    x += g.measureText(p).width + 28;
  }
  // LED dot mask
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let yy = 0; yy < 64; yy += 4) g.fillRect(0, yy, 2048, 1);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Sloped strip following a rounded rectangle (used for stand tiers and LED boards). */
function roundRectBand(hx: number, hz: number, r: number, inner: number, outer: number, y0: number, y1: number, uScale: number): THREE.BufferGeometry {
  const pts: { x: number; z: number; nx: number; nz: number }[] = [];
  const cx = hx - r;
  const cz = hz - r;
  const corners: [number, number, number][] = [
    [cx, cz, 0],
    [-cx, cz, Math.PI / 2],
    [-cx, -cz, Math.PI],
    [cx, -cz, Math.PI * 1.5],
  ];
  for (const [ox, oz, a0] of corners) {
    for (let i = 0; i <= 12; i++) {
      const a = a0 + (Math.PI / 2) * (i / 12);
      pts.push({ x: ox + r * Math.cos(a), z: oz + r * Math.sin(a), nx: Math.cos(a), nz: Math.sin(a) });
    }
  }
  pts.push(pts[0]);
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i > 0) s += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
    pos.push(p.x + p.nx * inner, y0, p.z + p.nz * inner, p.x + p.nx * outer, y1, p.z + p.nz * outer);
    uv.push(s / uScale, 0, s / uScale, 1);
    if (i < pts.length - 1) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

const HEX_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const HEX_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uFlash;
uniform vec2 uScale;
uniform float uBase;
varying vec2 vUv;
float hexDist(vec2 p) {
  p = abs(p);
  return max(dot(p, normalize(vec2(1.0, 1.7320508))), p.x);
}
vec4 hexCoords(vec2 uv) {
  vec2 r = vec2(1.0, 1.7320508);
  vec2 h = r * 0.5;
  vec2 a = mod(uv, r) - h;
  vec2 b = mod(uv - h, r) - h;
  vec2 gv = dot(a, a) < dot(b, b) ? a : b;
  return vec4(gv, uv - gv);
}
void main() {
  vec2 uv = vUv * uScale;
  vec4 hc = hexCoords(uv);
  float d = hexDist(hc.xy);
  float edge = smoothstep(0.40, 0.49, d);
  float cell = fract(sin(dot(hc.zw, vec2(12.9898, 78.233))) * 43758.5453);
  float twinkle = 0.5 + 0.5 * sin(uTime * 2.2 + cell * 6.2831);
  float scan = 1.0 - abs(fract(vUv.y - uTime * 0.22) - 0.5) * 2.0;
  scan = pow(scan, 8.0);
  float fill = cell > 0.92 ? 0.12 * twinkle : 0.0;
  float a = edge * (0.45 + 0.35 * twinkle) + fill + uBase + scan * 0.3;
  a = a * (1.0 + uFlash * 2.5) + uFlash * 0.25;
  vec3 col = mix(uColor, vec3(1.0), edge * 0.2 + uFlash * 0.45);
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}`;

export class Arena {
  group = new THREE.Group();
  pads: BoostPad[] = [];
  glowTex = makeGlowTexture();
  private sun!: THREE.DirectionalLight;
  private goalLights: THREE.PointLight[] = [];
  private crowdMats: THREE.MeshStandardMaterial[] = [];
  private ledMats: THREE.MeshBasicMaterial[] = [];
  private beams: { pivot: THREE.Group; mat: THREE.MeshBasicMaterial; base: THREE.Color; phase: number }[] = [];
  private celebrateTimer = 0;
  private goalFieldMats: [THREE.ShaderMaterial[], THREE.ShaderMaterial[]] = [[], []];
  private goalCoreMats: THREE.MeshBasicMaterial[] = [];
  private goalSpinners: THREE.Object3D[] = [];
  private goalHolos: THREE.Mesh[] = [];
  private goalFlash: [number, number] = [0, 0];
  private celebrateTeam: 0 | 1 = 0;

  constructor(scene: THREE.Scene, world: RAPIER.World) {
    scene.add(this.group);
    this.buildLights(scene);
    this.buildSurface(world);
    this.buildGoals(world);
    this.buildPads();
    this.buildStadium();
  }

  private buildLights(scene: THREE.Scene) {
    scene.background = new THREE.Color(0x060912);
    scene.fog = new THREE.Fog(0x060912, 260, 760);
    const hemi = new THREE.HemisphereLight(0xc8dcff, 0x1a2030, 1.25);
    scene.add(hemi);
    // Key light. Its shadow frustum follows the action (see followShadows) so shadows stay
    // sharp on the large field without a huge shadow map.
    const sun = new THREE.DirectionalLight(0xfff6ea, 2.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -45;
    sc.right = 45;
    sc.top = 45;
    sc.bottom = -45;
    sc.near = 5;
    sc.far = 220;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.06;
    scene.add(sun);
    scene.add(sun.target);
    this.sun = sun;
    // fill light from the opposite side (no shadows)
    const fill = new THREE.DirectionalLight(0xbfd2ff, 0.7);
    fill.position.set(-60, 80, -50);
    scene.add(fill);
    // team-colored goal lighting
    for (const s of [-1, 1]) {
      const team = s < 0 ? 0 : 1;
      const pl = new THREE.PointLight(TEAM_COLORS[team], 900, 130, 1.5);
      pl.position.set(s * (A - 3), 12, 0);
      scene.add(pl);
      this.goalLights.push(pl);
    }
  }

  /** Keep the shadow frustum centered on what the camera is looking at. */
  followShadows(focus: THREE.Vector3) {
    const fx = THREE.MathUtils.clamp(focus.x, -A, A);
    const fz = THREE.MathUtils.clamp(focus.z, -B, B);
    // snap to texel grid to avoid shimmering
    const texel = 90 / 2048;
    const sxp = Math.round(fx / texel) * texel;
    const szp = Math.round(fz / texel) * texel;
    this.sun.position.set(sxp + 50, 120, szp + 60);
    this.sun.target.position.set(sxp, 0, szp);
  }

  private buildSurface(world: RAPIER.World) {
    const perim = buildPerimeter();
    const prof = buildProfile();
    const np = perim.length;
    const nr = prof.length;
    const pos: number[] = [];
    const col: number[] = [];
    const uv: number[] = [];
    const blue = new THREE.Color(TEAM_COLORS[0]);
    const orange = new THREE.Color(TEAM_COLORS[1]);
    const neutral = new THREE.Color(0x8a93a8);
    const tmp = new THREE.Color();
    const totalS = perim[np - 1].s + Math.hypot(perim[0].x - perim[np - 1].x, perim[0].z - perim[np - 1].z);
    for (let i = 0; i <= np; i++) {
      const p = perim[i % np];
      const s = i === np ? totalS : p.s;
      for (let j = 0; j < nr; j++) {
        const { r, y } = prof[j];
        const x = p.x + p.nx * r;
        const z = p.z + p.nz * r;
        pos.push(x, y, z);
        const t = THREE.MathUtils.clamp(x / A, -1, 1);
        if (t < 0) tmp.copy(neutral).lerp(blue, Math.min(1, -t * 1.3));
        else tmp.copy(neutral).lerp(orange, Math.min(1, t * 1.3));
        const alpha = y < RF + 0.01 ? 0.92 : y > H - RF - 0.01 ? 0.35 : THREE.MathUtils.lerp(0.75, 0.22, (y - RF) / (H - 2 * RF));
        const bright = y < RF + 0.01 ? 0.55 : 1;
        col.push(tmp.r * bright, tmp.g * bright, tmp.b * bright, alpha);
        // arc-length along profile for v
        uv.push(s / 4, (j === 0 ? 0 : y + r * 0.0) / 4);
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < np; i++) {
      const p0 = perim[i];
      const p1 = perim[(i + 1) % np];
      const mouth = p0.end && p1.end && Math.abs(p0.z) <= GW + 1e-4 && Math.abs(p1.z) <= GW + 1e-4 && Math.sign(p0.x) === Math.sign(p1.x);
      for (let j = 0; j < nr - 1; j++) {
        if (mouth && prof[j + 1].y <= GH + 1e-4) continue;
        const a = i * nr + j;
        const b = (i + 1) * nr + j;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    // Fix winding so faces point into the arena
    {
      const ia = idx[0] * 3;
      const ib = idx[1] * 3;
      const ic = idx[2] * 3;
      const va = new THREE.Vector3(pos[ia], pos[ia + 1], pos[ia + 2]);
      const vb = new THREE.Vector3(pos[ib], pos[ib + 1], pos[ib + 2]);
      const vc = new THREE.Vector3(pos[ic], pos[ic + 1], pos[ic + 2]);
      const n = vb.clone().sub(va).cross(vc.clone().sub(va));
      const center = va.clone().add(vb).add(vc).multiplyScalar(1 / 3);
      const inward = arenaNormal(center.clone().addScaledVector(n.clone().normalize(), 0), new THREE.Vector3());
      if (n.dot(inward) < 0) {
        for (let k = 0; k < idx.length; k += 3) {
          const t = idx[k + 1];
          idx[k + 1] = idx[k + 2];
          idx[k + 2] = t;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const wallMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      transparent: true,
      map: makeGridTexture(),
      roughness: 0.5,
      metalness: 0.2,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const walls = new THREE.Mesh(geo, wallMat);
    walls.renderOrder = 2;
    walls.receiveShadow = true;
    this.group.add(walls);

    // Glow strips along the top of the ramps and along the ceiling edge
    for (const [rr, yy, hh] of [
      [RF, RF, 0.18],
      [RF, H - RF, 0.12],
    ] as [number, number, number][]) {
      const sp: number[] = [];
      const sc: number[] = [];
      const si: number[] = [];
      for (let i = 0; i <= np; i++) {
        const p = perim[i % np];
        const x = p.x + p.nx * (rr - 0.03);
        const z = p.z + p.nz * (rr - 0.03);
        sp.push(x, yy - hh, z, x, yy + hh, z);
        const t = THREE.MathUtils.clamp(x / A, -1, 1);
        if (t < 0) tmp.copy(neutral).lerp(blue, Math.min(1, -t * 2));
        else tmp.copy(neutral).lerp(orange, Math.min(1, t * 2));
        sc.push(tmp.r, tmp.g, tmp.b, tmp.r, tmp.g, tmp.b);
        if (i < np) {
          const p1 = perim[(i + 1) % np];
          const mouth = p.end && p1.end && Math.abs(p.z) <= GW + 1e-4 && Math.abs(p1.z) <= GW + 1e-4 && yy < GH;
          if (!mouth) {
            const a = i * 2;
            si.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
          }
        }
      }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
      sg.setAttribute('color', new THREE.Float32BufferAttribute(sc, 3));
      sg.setIndex(si);
      const strip = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      this.group.add(strip);
    }

    // Cheek triangles that close the ramp profile beside the goal mouths
    const cheekPos: number[] = [];
    const cheekIdx: number[] = [];
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const base = cheekPos.length / 3;
        cheekPos.push(sx * A, 0, sz * GW);
        const n = 10;
        for (let i = 0; i <= n; i++) {
          const t = ((Math.PI / 2) * i) / n;
          cheekPos.push(sx * (IA + RF * Math.sin(t)), RF * (1 - Math.cos(t)), sz * GW);
        }
        for (let i = 0; i < n; i++) cheekIdx.push(base, base + 1 + i, base + 2 + i);
      }
    }
    const cheekGeo = new THREE.BufferGeometry();
    cheekGeo.setAttribute('position', new THREE.Float32BufferAttribute(cheekPos, 3));
    cheekGeo.setIndex(cheekIdx);
    cheekGeo.computeVertexNormals();
    this.group.add(
      new THREE.Mesh(cheekGeo, new THREE.MeshStandardMaterial({ color: 0x2a3040, side: THREE.DoubleSide })),
    );

    // Physics trimesh (walls + ramps + cheeks)
    const allPos = new Float32Array(pos.length + cheekPos.length);
    allPos.set(pos, 0);
    allPos.set(cheekPos, pos.length);
    const off = pos.length / 3;
    const allIdx = new Uint32Array(idx.length + cheekIdx.length);
    allIdx.set(idx, 0);
    allIdx.set(
      cheekIdx.map((i) => i + off),
      idx.length,
    );
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const tm = RAPIER.ColliderDesc.trimesh(allPos, allIdx, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES)
      .setFriction(0.6)
      .setRestitution(0)
      .setCollisionGroups(groups(GROUP_ARENA, 0xffff));
    world.createCollider(tm, body);
    // Floor & ceiling slabs
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(A + GD + 5, 2, B + 5)
        .setTranslation(0, -2, 0)
        .setFriction(0.6)
        .setCollisionGroups(groups(GROUP_ARENA, 0xffff)),
      body,
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(A + GD + 5, 2, B + 5)
        .setTranslation(0, H + 2, 0)
        .setFriction(0.6)
        .setCollisionGroups(groups(GROUP_ARENA, 0xffff)),
      body,
    );

    // Visual floor: fan over the inset rounded rect
    const fp: number[] = [0, 0, 0];
    const fuv: number[] = [];
    const U = (x: number) => (x + A + GD + 1) / (2 * (A + GD + 1));
    const V = (z: number) => 1 - (z + B + 1) / (2 * (B + 1));
    fuv.push(U(0), V(0));
    for (const p of perim) {
      fp.push(p.x, 0, p.z);
      fuv.push(U(p.x), V(p.z));
    }
    const fi: number[] = [];
    for (let i = 0; i < np; i++) fi.push(0, 1 + ((i + 1) % np), 1 + i);
    // goal floors
    for (const s of [-1, 1]) {
      const b0 = fp.length / 3;
      const x0 = s * IA;
      const x1 = s * (A + GD);
      for (const [x, z] of [
        [x0, -GW],
        [x1, -GW],
        [x1, GW],
        [x0, GW],
      ]) {
        fp.push(x, 0, z);
        fuv.push(U(x), V(z));
      }
      if (s > 0) fi.push(b0, b0 + 2, b0 + 1, b0, b0 + 3, b0 + 2);
      else fi.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3);
    }
    const fgeo = new THREE.BufferGeometry();
    fgeo.setAttribute('position', new THREE.Float32BufferAttribute(fp, 3));
    fgeo.setAttribute('uv', new THREE.Float32BufferAttribute(fuv, 2));
    fgeo.setIndex(fi);
    fgeo.computeVertexNormals();
    // ensure up-facing
    const nAttr = fgeo.getAttribute('normal');
    if (nAttr.getY(1) < 0) {
      for (let k = 0; k < fi.length; k += 3) [fi[k + 1], fi[k + 2]] = [fi[k + 2], fi[k + 1]];
      fgeo.setIndex(fi);
      fgeo.computeVertexNormals();
    }
    const floor = new THREE.Mesh(
      fgeo,
      new THREE.MeshStandardMaterial({ map: makeFloorTexture(), bumpMap: makeTurfBump(), bumpScale: 0.6, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide }),
    );
    floor.receiveShadow = true;
    (floor.material as THREE.MeshStandardMaterial).envMapIntensity = 0.15;
    this.group.add(floor);

    // Ceiling: faint panel grid
    const cgeo = fgeo.clone();
    cgeo.setDrawRange(0, np * 3);
    const ceil = new THREE.Mesh(
      cgeo,
      new THREE.MeshBasicMaterial({ color: 0x1a2235, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
    );
    ceil.position.y = H;
    this.group.add(ceil);
  }

  private buildGoals(world: RAPIER.World) {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const g = groups(GROUP_ARENA, 0xffff);
    for (const s of [-1, 1]) {
      const team = s < 0 ? 0 : 1;
      const color = new THREE.Color(TEAM_COLORS[team]);
      const cx = s * (A + GD / 2);
      // colliders
      for (const sz of [-1, 1]) {
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(GD / 2 + 0.5, GH / 2, 0.5).setTranslation(cx, GH / 2, sz * (GW + 0.5)).setCollisionGroups(g),
          body,
        );
      }
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.5, GH / 2 + 1, GW + 1).setTranslation(s * (A + GD + 0.5), GH / 2, 0).setCollisionGroups(g),
        body,
      );
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(GD / 2 + 0.5, 0.5, GW + 1).setTranslation(cx, GH + 0.5, 0).setCollisionGroups(g),
        body,
      );
      this.buildGoalVisuals(s, team, color, cx);
    }
  }

  /** Futuristic goal: energy-field nets, hex frame, portal curtain, hologram banner. */
  private buildGoalVisuals(s: number, team: 0 | 1, color: THREE.Color, cx: number) {
    const field = (w: number, h: number, base: number) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: HEX_VERT,
        fragmentShader: HEX_FRAG,
        uniforms: {
          uColor: { value: color.clone() },
          uTime: { value: 0 },
          uFlash: { value: 0 },
          uScale: { value: new THREE.Vector2(w / 2.2, h / 2.2) },
          uBase: { value: base },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      this.goalFieldMats[team].push(m);
      return m;
    };
    // energy-field nets
    const back = new THREE.Mesh(new THREE.PlaneGeometry(2 * GW, GH), field(2 * GW, GH, 0.05));
    back.position.set(s * (A + GD), GH / 2, 0);
    back.rotation.y = Math.PI / 2;
    this.group.add(back);
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(GD, 2 * GW), field(GD, 2 * GW, 0.03));
    roof.rotation.x = Math.PI / 2;
    roof.position.set(cx, GH, 0);
    this.group.add(roof);
    for (const sz of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.PlaneGeometry(GD, GH), field(GD, GH, 0.04));
      side.position.set(cx, GH / 2, sz * GW);
      this.group.add(side);
    }
    // glowing hex floor inside the goal
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(GD, 2 * GW), field(GD, 2 * GW, 0.0));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0.05, 0);
    this.group.add(floor);
    // portal curtain across the goal mouth (faint; flashes on a goal)
    const portalMat = field(2 * GW, GH, 0.0);
    portalMat.uniforms.uBase.value = -0.25; // mostly invisible until it flashes
    const portal = new THREE.Mesh(new THREE.PlaneGeometry(2 * GW, GH), portalMat);
    portal.position.set(s * (A + 0.3), GH / 2, 0);
    portal.rotation.y = Math.PI / 2;
    this.group.add(portal);

    // frame: hexagonal posts and crossbar with a white core light
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x10141f, metalness: 0.85, roughness: 0.25, emissive: color, emissiveIntensity: 0.55 });
    const coreMat = new THREE.MeshBasicMaterial({ color: color.clone().lerp(new THREE.Color(0xffffff), 0.55), toneMapped: false });
    this.goalCoreMats[team] = coreMat;
    const beam = (len: number) => new THREE.CylinderGeometry(0.42, 0.42, len, 6);
    const core = (len: number) => new THREE.BoxGeometry(0.08, len, 0.9);
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(beam(GH + 0.8), frameMat);
      post.position.set(s * A, GH / 2, sz * GW);
      this.group.add(post);
      const strip = new THREE.Mesh(core(GH), coreMat);
      strip.position.set(s * (A - 0.4), GH / 2, sz * GW);
      this.group.add(strip);
      // corner node
      const node = new THREE.Mesh(new THREE.OctahedronGeometry(0.95), coreMat);
      node.position.set(s * A, GH + 0.2, sz * GW);
      this.group.add(node);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.07, 6, 24), coreMat);
      ring.position.copy(node.position);
      ring.rotation.y = Math.PI / 2;
      this.group.add(ring);
      this.goalSpinners.push(node, ring);
    }
    const bar = new THREE.Mesh(beam(2 * GW), frameMat);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(s * A, GH + 0.2, 0);
    this.group.add(bar);
    const barCore = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.9, 2 * GW), coreMat);
    barCore.position.set(s * (A - 0.4), GH + 0.2, 0);
    this.group.add(barCore);
    // outer chevron frame: angled struts flaring out from the goal
    const strutMat = new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: 0.85 });
    const flare = 3.2;
    for (const sz of [-1, 1]) {
      const st = new THREE.Mesh(new THREE.BoxGeometry(0.25, GH + 3, 0.25), strutMat);
      st.position.set(s * (A - 0.6), (GH + 3) / 2, sz * (GW + flare / 2));
      st.rotation.x = -sz * Math.atan2(flare, GH + 3);
      this.group.add(st);
    }
    const topStrut = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 2 * (GW + flare)), strutMat);
    topStrut.position.set(s * (A - 0.6), GH + 3, 0);
    this.group.add(topStrut);

    // glowing goal line
    const line = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 2 * GW), new THREE.MeshBasicMaterial({ color, toneMapped: false }));
    line.rotation.x = -Math.PI / 2;
    line.position.set(s * A, 0.06, 0);
    this.group.add(line);
    const lineGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(3, 2 * GW),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    lineGlow.rotation.x = -Math.PI / 2;
    lineGlow.position.set(s * A, 0.065, 0);
    this.group.add(lineGlow);

    // hologram banner above the goal
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 192;
    const g = c.getContext('2d')!;
    g.font = 'italic 800 130px "Saira Condensed", Rajdhani, system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.shadowColor = '#ffffff';
    g.shadowBlur = 24;
    g.fillText(team === 0 ? 'BLUE' : 'ORANGE', 512, 100);
    g.globalCompositeOperation = 'destination-out';
    for (let y = 0; y < 192; y += 6) g.fillRect(0, y, 1024, 2); // scanlines
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const holo = new THREE.Mesh(
      new THREE.PlaneGeometry(22, 4.1),
      new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
    );
    holo.position.set(s * (A - 1), GH + 7, 0);
    holo.rotation.y = -s * Math.PI / 2;
    this.group.add(holo);
    this.goalHolos.push(holo);
  }

  private buildPads() {
    const big: [number, number][] = [
      [-3584, 0],
      [3584, 0],
      [-3072, 4096],
      [3072, 4096],
      [-3072, -4096],
      [3072, -4096],
    ];
    const small: [number, number][] = [
      [0, -4240], [-1792, -4184], [1792, -4184], [-940, -3308], [940, -3308], [0, -2816],
      [-3584, -2484], [3584, -2484], [-1788, -2300], [1788, -2300], [-2048, -1036], [0, -1024],
      [2048, -1036], [-1024, 0], [1024, 0], [-2048, 1036], [0, 1024], [2048, 1036],
      [-1788, 2300], [1788, 2300], [-3584, 2484], [3584, 2484], [0, 2816], [-940, 3308],
      [940, 3308], [-1792, 4184], [1792, 4184], [0, 4240],
    ];
    for (const [list, isBig] of [
      [big, true],
      [small, false],
    ] as [[number, number][], boolean][]) {
      for (const [rx, ry] of list) {
        const [x, z] = rlToWorld(rx, ry);
        const pad = new BoostPad(new THREE.Vector3(x, 0, z), isBig, this.glowTex);
        this.pads.push(pad);
        this.group.add(pad.group);
      }
    }
  }

  private buildStadium() {
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(700, 64),
      new THREE.MeshStandardMaterial({ color: 0x0a0d15, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    this.group.add(ground);

    // Stands: three tiers following the arena outline
    const crowd = makeCrowdTexture();
    const hx = A + GD + 10;
    const hz = B + 10;
    const tiers = [
      { inner: 0, outer: 30, y0: 2, y1: 22 },
      { inner: 34, outer: 62, y0: 30, y1: 52 },
      { inner: 66, outer: 92, y0: 60, y1: 82 },
    ];
    for (const t of tiers) {
      const geo = roundRectBand(hx, hz, 30, t.inner, t.outer, t.y0, t.y1, 60);
      const tex = crowd.clone();
      tex.needsUpdate = true;
      const mat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 1, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.22 });
      this.crowdMats.push(mat);
      this.group.add(new THREE.Mesh(geo, mat));
      // concrete fascia under each tier
      const fascia = roundRectBand(hx, hz, 30, t.inner, t.inner, t.y0 - 6, t.y0, 60);
      this.group.add(new THREE.Mesh(fascia, new THREE.MeshStandardMaterial({ color: 0x1a1f2c, roughness: 0.9, side: THREE.DoubleSide })));
    }
    // LED ribbon boards on the tier fronts
    const led = makeLedTexture();
    for (const t of tiers) {
      const tex = led.clone();
      tex.needsUpdate = true;
      tex.repeat.set(1, 1);
      const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, toneMapped: false });
      this.ledMats.push(mat);
      const board = new THREE.Mesh(roundRectBand(hx, hz, 30, t.inner - 0.5, t.inner - 0.5, t.y0 - 4.5, t.y0 - 1, 120), mat);
      this.group.add(board);
    }
    // Roof ring with lamp rows
    const roof = new THREE.Mesh(
      roundRectBand(hx, hz, 30, 40, 110, 96, 104, 60),
      new THREE.MeshStandardMaterial({ color: 0x141824, roughness: 0.8, metalness: 0.4, side: THREE.DoubleSide }),
    );
    this.group.add(roof);
    const lampGeo = new THREE.BoxGeometry(5, 1.2, 2.5);
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const lamps = new THREE.InstancedMesh(lampGeo, lampMat, 40);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      const x = Math.cos(a) * (hx + 32);
      const z = Math.sin(a) * (hz + 32);
      m4.makeRotationY(-a);
      m4.setPosition(x, 95, z);
      lamps.setMatrixAt(i, m4);
    }
    this.group.add(lamps);
    // Sweeping light beams
    const beamGeo = new THREE.ConeGeometry(9, 110, 24, 1, true);
    beamGeo.translate(0, -55, 0);
    const beamCols = [0xdde8ff, TEAM_COLORS[0], 0xdde8ff, TEAM_COLORS[1]];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const pivot = new THREE.Group();
      pivot.position.set(Math.cos(a) * (hx + 20), 94, Math.sin(a) * (hz + 20));
      const mat = new THREE.MeshBasicMaterial({
        color: beamCols[i % 4],
        transparent: true,
        opacity: 0.07,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const beam = new THREE.Mesh(beamGeo, mat);
      pivot.add(beam);
      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: this.glowTex, color: beamCols[i % 4], blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
      );
      glow.scale.set(16, 16, 1);
      pivot.add(glow);
      this.group.add(pivot);
      this.beams.push({ pivot, mat, base: new THREE.Color(beamCols[i % 4]), phase: i * 0.9 });
    }
    // Corner light towers
    for (const [x, z] of [
      [-(hx + 70), -(hz + 60)],
      [hx + 70, -(hz + 60)],
      [-(hx + 70), hz + 60],
      [hx + 70, hz + 60],
    ]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.8, 120, 8), new THREE.MeshStandardMaterial({ color: 0x2a2f3c }));
      pole.position.set(x, 60, z);
      this.group.add(pole);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(22, 10, 2), lampMat);
      panel.position.set(x, 122, z);
      panel.lookAt(0, 0, 0);
      this.group.add(panel);
      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: this.glowTex, color: 0xdde8ff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
      );
      glow.scale.set(90, 90, 1);
      glow.position.set(x, 122, z);
      this.group.add(glow);
    }
  }

  /** Flash goal lights / beams in the scoring team's color and make the crowd jump. */
  celebrate(team: 0 | 1) {
    this.celebrateTeam = team;
    this.celebrateTimer = 4;
    // the goal that was scored IN flashes (scoring team 0 = blue scores into orange's goal)
    this.goalFlash[team === 0 ? 1 : 0] = 1;
  }

  resetPads() {
    for (const p of this.pads) p.reset();
  }

  update(dt: number, time: number) {
    for (const p of this.pads) p.update(dt, time);
    for (const t of [0, 1] as const) {
      this.goalFlash[t] = Math.max(0, this.goalFlash[t] - dt * 0.6);
      const f = this.goalFlash[t] * (0.6 + 0.4 * Math.abs(Math.sin(time * 14)));
      for (const m of this.goalFieldMats[t]) {
        m.uniforms.uTime.value = time;
        m.uniforms.uFlash.value = f;
      }
    }
    for (let i = 0; i < this.goalSpinners.length; i++) this.goalSpinners[i].rotation.x = time * (i % 2 ? -0.8 : 1.2);
    for (const h of this.goalHolos) (h.material as THREE.MeshBasicMaterial).opacity = 0.7 + 0.15 * Math.sin(time * 3) + (Math.random() < 0.02 ? -0.4 : 0);
    const party = this.celebrateTimer > 0;
    if (party) this.celebrateTimer -= dt;
    for (const m of this.ledMats) if (m.map) m.map.offset.x = (time * 0.03) % 1;
    for (const m of this.crowdMats) {
      m.emissiveIntensity = party ? 0.3 + 0.2 * Math.abs(Math.sin(time * 9)) : 0.22;
      if (m.map) m.map.offset.y = party ? Math.abs(Math.sin(time * 8)) * 0.006 : 0;
    }
    const teamCol = new THREE.Color(TEAM_COLORS[this.celebrateTeam]);
    for (const b of this.beams) {
      b.pivot.rotation.z = Math.sin(time * 0.35 + b.phase) * 0.55;
      b.pivot.rotation.x = Math.cos(time * 0.27 + b.phase * 1.3) * 0.45;
      if (party) {
        b.mat.color.copy(teamCol);
        b.mat.opacity = 0.1 + 0.08 * Math.abs(Math.sin(time * 6 + b.phase));
      } else {
        b.mat.color.copy(b.base);
        b.mat.opacity = 0.06;
      }
    }
    this.goalLights.forEach((l, i) => {
      l.intensity = party && i === this.celebrateTeam ? 900 + 1400 * Math.abs(Math.sin(time * 10)) : 900;
    });
  }
}
