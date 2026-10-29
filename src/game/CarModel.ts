import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CAR, carRideHeight } from './Config';
import { BOOST_HEX, CarDesign, GLOW_HEX, HEADLIGHT_HEX, RIM_HEX } from './CarDesign';

// Visual car model. Local frame matches the physics body: origin = hitbox center,
// x = forward, y = up, z = right. All body styles share the same physics hitbox.

const WHEEL_X = CAR.wheelOffsets[0][0];
const WHEEL_Z = Math.abs(CAR.wheelOffsets[0][2]);
const R = CAR.wheelRadius;
/** Wheel-center height (local) with the suspension at rest on flat ground. */
const X_EQ = (CAR.gravity + CAR.stickyAccel) / (4 * CAR.springK);
export const WHEEL_REST_Y = CAR.wheelOffsets[0][1] - (CAR.suspensionRest - X_EQ);
void carRideHeight;

interface StyleSpec {
  upper: [number, number][]; // silhouette from rear-bottom, over the top, to front-bottom
  bottom: number;
  halfWidth: number;
  window: [number, number][];
  windshield: [number, number, number, number];
  rearGlass?: [number, number, number, number];
  head: [number, number];
  tail: [number, number];
  spoiler: [number, number];
  roof: [number, number];
  hood: [number, number];
}

const STYLES: Record<CarDesign['body'], StyleSpec> = {
  // Octane-style: tall cabin, short sloped hood, wheels in fender pods
  striker: {
    upper: [[-1.3, -0.36], [-1.32, -0.05], [-1.26, 0.22], [-1.0, 0.32], [-0.7, 0.66], [-0.05, 0.72], [0.38, 0.4], [1.05, 0.28], [1.3, 0.1], [1.33, -0.18], [1.3, -0.36]],
    bottom: -0.36,
    halfWidth: 0.64,
    window: [[-0.92, 0.31], [-0.66, 0.62], [-0.06, 0.66], [0.32, 0.4]],
    windshield: [-0.03, 0.7, 0.36, 0.41],
    rearGlass: [-0.72, 0.64, -0.97, 0.33],
    head: [1.28, 0.1],
    tail: [-1.29, 0.14],
    spoiler: [-1.08, 0.3],
    roof: [-0.35, 0.7],
    hood: [0.75, 0.33],
  },
  // Dominus-style: long, flat, low muscle car
  viper: {
    upper: [[-1.32, -0.34], [-1.35, -0.04], [-1.3, 0.2], [-0.95, 0.26], [-0.5, 0.5], [0.1, 0.52], [0.55, 0.3], [1.2, 0.2], [1.36, 0.06], [1.37, -0.2], [1.32, -0.34]],
    bottom: -0.34,
    halfWidth: 0.72,
    window: [[-0.86, 0.25], [-0.5, 0.47], [0.08, 0.49], [0.5, 0.3]],
    windshield: [0.12, 0.5, 0.52, 0.31],
    rearGlass: [-0.52, 0.48, -0.9, 0.27],
    head: [1.33, 0.03],
    tail: [-1.33, 0.08],
    spoiler: [-1.0, 0.25],
    roof: [-0.2, 0.5],
    hood: [0.85, 0.25],
  },
  // Fennec-style: compact, boxy, upright
  brute: {
    upper: [[-1.3, -0.32], [-1.32, 0.3], [-1.2, 0.42], [-0.98, 0.45], [-0.9, 0.82], [0.3, 0.84], [0.6, 0.46], [1.15, 0.42], [1.31, 0.3], [1.32, -0.22], [1.3, -0.32]],
    bottom: -0.32,
    halfWidth: 0.7,
    window: [[-0.88, 0.46], [-0.86, 0.78], [0.27, 0.79], [0.54, 0.47]],
    windshield: [0.31, 0.82, 0.58, 0.47],
    head: [1.3, 0.24],
    tail: [-1.3, 0.24],
    spoiler: [-0.96, 0.82],
    roof: [-0.3, 0.83],
    hood: [0.85, 0.44],
  },
  // Breakout-style: very low, sharp wedge
  wedge: {
    upper: [[-1.3, -0.34], [-1.33, 0.3], [-1.12, 0.42], [-0.6, 0.6], [-0.2, 0.62], [0.3, 0.36], [1.37, -0.04], [1.37, -0.22], [1.3, -0.34]],
    bottom: -0.34,
    halfWidth: 0.66,
    window: [[-0.82, 0.42], [-0.58, 0.56], [-0.2, 0.58], [0.24, 0.38]],
    windshield: [-0.17, 0.6, 0.28, 0.37],
    head: [1.33, -0.02],
    tail: [-1.32, 0.3],
    spoiler: [-1.1, 0.42],
    roof: [-0.4, 0.6],
    hood: [0.8, 0.17],
  },
};

const BEVEL_T = 0.07;
const BEVEL_S = 0.06;

function bodyShape(spec: StyleSpec, wheelY: number): THREE.Shape {
  const s = new THREE.Shape();
  const up = spec.upper;
  const bot = spec.bottom;
  const ra = R + 0.06;
  const dy = bot - wheelY;
  const dx = Math.sqrt(Math.max(0.01, ra * ra - dy * dy));
  const a0 = Math.asin(THREE.MathUtils.clamp(dy / ra, -1, 1));
  s.moveTo(up[0][0], up[0][1]);
  for (const p of up.slice(1)) s.lineTo(p[0], p[1]);
  // bottom edge from front to rear with wheel arches
  s.lineTo(WHEEL_X + dx, bot);
  s.absarc(WHEEL_X, wheelY, ra, a0, Math.PI - a0, false);
  s.lineTo(-WHEEL_X + dx, bot);
  s.absarc(-WHEEL_X, wheelY, ra, a0, Math.PI - a0, false);
  s.closePath();
  return s;
}

function finishMaterial(color: string, finish: CarDesign['finish']): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({ color });
  switch (finish) {
    case 'gloss':
      Object.assign(m, { roughness: 0.28, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.06 });
      break;
    case 'metallic':
      Object.assign(m, { roughness: 0.34, metalness: 0.72, clearcoat: 0.7, clearcoatRoughness: 0.1 });
      break;
    case 'matte':
      Object.assign(m, { roughness: 0.82, metalness: 0.05, clearcoat: 0 });
      break;
    case 'pearl':
      Object.assign(m, { roughness: 0.3, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.05, iridescence: 0.8, iridescenceIOR: 1.6 });
      break;
    case 'chrome':
      Object.assign(m, { roughness: 0.07, metalness: 1, clearcoat: 0.4 });
      break;
  }
  return m;
}

// ---- side decals -----------------------------------------------------------
const DX0 = -1.3;
const DX1 = 1.3;
const DY0 = -0.6;
const DY1 = 0.95;

function seeded(seed: number) {
  let x = seed % 2147483647 || 1;
  return () => (x = (x * 16807) % 2147483647) / 2147483647;
}

function contrastText(hex: string): string {
  const c = new THREE.Color(hex);
  return c.r * 0.3 + c.g * 0.59 + c.b * 0.11 > 0.55 ? '#111318' : '#ffffff';
}

/** Draws the decal (secondary color only, transparent elsewhere) in body-profile space. */
function paintDecal(d: CarDesign, mirrorText: boolean): THREE.CanvasTexture | null {
  if (d.decal === 'none') return null;
  const W = 1024;
  const H = 512;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const PX = (x: number) => ((x - DX0) / (DX1 - DX0)) * W;
  const PY = (y: number) => ((DY1 - y) / (DY1 - DY0)) * H;
  const sec = d.secondary;
  g.fillStyle = sec;
  g.strokeStyle = sec;
  switch (d.decal) {
    case 'stripes': {
      g.fillRect(PX(-1.3), PY(0.1), PX(1.3) - PX(-1.3), PY(0.04) - PY(0.1));
      g.fillRect(PX(-1.3), PY(0.0), PX(1.3) - PX(-1.3), PY(-0.02) - PY(0.0));
      break;
    }
    case 'flames': {
      const grd = g.createLinearGradient(PX(1.2), 0, PX(-0.7), 0);
      grd.addColorStop(0, sec);
      grd.addColorStop(0.75, sec);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      const tongues = [
        [0.18, -0.15],
        [0.06, -0.45],
        [-0.06, -0.2],
        [-0.16, -0.55],
        [-0.26, -0.05],
      ];
      g.beginPath();
      g.moveTo(PX(1.2), PY(0.2));
      for (const [y, x] of tongues) {
        g.quadraticCurveTo(PX(x + 0.45), PY(y + 0.1), PX(x), PY(y));
        g.quadraticCurveTo(PX(x + 0.3), PY(y - 0.02), PX(x + 0.55), PY(y - 0.06));
      }
      g.lineTo(PX(1.2), PY(-0.32));
      g.closePath();
      g.fill();
      break;
    }
    case 'lightning': {
      g.beginPath();
      const pts: [number, number][] = [
        [1.1, 0.16], [0.55, 0.12], [0.62, 0.02], [-0.05, 0.08], [0.02, -0.04], [-0.95, 0.04],
        [-0.12, -0.1], [-0.18, -0.02], [0.5, -0.08], [0.42, 0.02], [1.1, 0.06],
      ];
      g.moveTo(PX(pts[0][0]), PY(pts[0][1]));
      for (const p of pts.slice(1)) g.lineTo(PX(p[0]), PY(p[1]));
      g.closePath();
      g.fill();
      break;
    }
    case 'number': {
      g.fillRect(PX(-1.3), PY(-0.12), PX(1.3) - PX(-1.3), PY(-0.18) - PY(-0.12));
      const cx = PX(0.0);
      const cy = PY(0.05);
      const r = (0.27 / (DY1 - DY0)) * H;
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = contrastText(sec);
      g.font = `italic 700 ${Math.round(r * 1.25)}px Rajdhani, system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.save();
      g.translate(cx, cy + r * 0.06);
      if (mirrorText) g.scale(-1, 1);
      g.fillText(String(d.number), 0, 0);
      g.restore();
      break;
    }
    case 'camo': {
      const rnd = seeded(1337);
      const shades = [sec, new THREE.Color(sec).lerp(new THREE.Color(d.primary), 0.5).getStyle()];
      const cell = 22;
      for (let y = 0; y < H; y += cell) {
        for (let x = 0; x < W; x += cell) {
          const v = rnd();
          if (v < 0.42) {
            g.fillStyle = shades[v < 0.2 ? 0 : 1];
            g.fillRect(x, y, cell * (1 + Math.floor(rnd() * 3)), cell);
          }
        }
      }
      break;
    }
    case 'split': {
      g.fillRect(0, PY(-0.06), W, H - PY(-0.06));
      g.fillRect(0, PY(0.02), W, PY(-0.0) - PY(0.02));
      break;
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.repeat.set(1 / (DX1 - DX0), 1 / (DY1 - DY0));
  t.offset.set(-DX0 / (DX1 - DX0), -DY0 / (DY1 - DY0));
  return t;
}

// ---- wheels ----------------------------------------------------------------
function buildWheel(style: CarDesign['wheel'], rimHex: number, caliperHex: number): { pivot: THREE.Group; spin: THREE.Group } {
  const pivot = new THREE.Group(); // steering
  const spin = new THREE.Group(); // rolling (about local z)
  pivot.add(spin);
  const tw = 0.36;
  const tireProfile = [
    new THREE.Vector2(R * 0.66, -tw / 2),
    new THREE.Vector2(R * 0.9, -tw / 2),
    new THREE.Vector2(R * 0.985, -tw / 2 + 0.035),
    new THREE.Vector2(R, -tw / 2 + 0.08),
    new THREE.Vector2(R, tw / 2 - 0.08),
    new THREE.Vector2(R * 0.985, tw / 2 - 0.035),
    new THREE.Vector2(R * 0.9, tw / 2),
    new THREE.Vector2(R * 0.66, tw / 2),
  ];
  const tireGeo = new THREE.LatheGeometry(tireProfile, 28);
  tireGeo.rotateX(Math.PI / 2);
  const tire = new THREE.Mesh(tireGeo, new THREE.MeshStandardMaterial({ color: 0x16171b, roughness: 0.92, side: THREE.DoubleSide }));
  tire.castShadow = true;
  spin.add(tire);
  // tread grooves
  const groove = new THREE.Mesh(
    new THREE.TorusGeometry(R * 0.995, 0.012, 4, 28),
    new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 1 }),
  );
  spin.add(groove);

  const rimMat = new THREE.MeshStandardMaterial({ color: rimHex, metalness: 0.9, roughness: 0.25 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x0e0f12, metalness: 0.5, roughness: 0.6 });
  const rr = R * 0.66;
  const face = tw / 2 - 0.02;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr, tw - 0.02, 24, 1, true), darkMat);
  barrel.rotation.x = Math.PI / 2;
  barrel.material.side = THREE.DoubleSide;
  spin.add(barrel);
  const lip = new THREE.Mesh(new THREE.TorusGeometry(rr - 0.005, 0.018, 6, 28), rimMat);
  lip.position.z = face;
  spin.add(lip);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.05, 12), rimMat);
  hub.rotation.x = Math.PI / 2;
  hub.position.z = face;
  spin.add(hub);
  const spoke = (len: number, w: number, th: number, angle: number, twist = 0, z = face - 0.005) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, len, th), rimMat);
    const holder = new THREE.Group();
    holder.rotation.z = angle;
    m.position.y = 0.05 + len / 2;
    m.rotation.y = twist;
    holder.position.z = z;
    holder.add(m);
    spin.add(holder);
  };
  const L = rr - 0.07;
  switch (style) {
    case 'sport5':
      for (let i = 0; i < 5; i++) spoke(L, 0.05, 0.025, (i / 5) * Math.PI * 2);
      break;
    case 'turbine':
      for (let i = 0; i < 12; i++) spoke(L, 0.035, 0.02, (i / 12) * Math.PI * 2, 0.6);
      break;
    case 'mesh':
      for (let i = 0; i < 10; i++) {
        spoke(L + 0.01, 0.018, 0.015, (i / 10) * Math.PI * 2 + 0.22);
        spoke(L + 0.01, 0.018, 0.015, (i / 10) * Math.PI * 2 - 0.22, 0, face - 0.015);
      }
      break;
    case 'classic': {
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(rr - 0.02, rr - 0.02, 0.02, 24), rimMat);
      disc.rotation.x = Math.PI / 2;
      disc.position.z = face - 0.02;
      spin.add(disc);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const hole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.03, 10), darkMat);
        hole.rotation.x = Math.PI / 2;
        hole.position.set(Math.cos(a) * 0.14, Math.sin(a) * 0.14, face - 0.01);
        spin.add(hole);
      }
      break;
    }
    case 'tri':
      for (let i = 0; i < 3; i++) spoke(L, 0.1, 0.03, (i / 3) * Math.PI * 2);
      break;
  }
  // brake caliper (doesn't spin)
  const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.06), new THREE.MeshStandardMaterial({ color: caliperHex, roughness: 0.4 }));
  caliper.position.set(-0.1, 0.1, face - 0.07);
  caliper.rotation.z = 0.6;
  pivot.add(caliper);
  return { pivot, spin };
}

function quad(p0: [number, number], p1: [number, number], halfW: number, lift: number, mat: THREE.Material): THREE.Mesh {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy);
  const nx = -dy / len;
  const ny = dx / len;
  // orient normal upward/outward
  const s = ny < 0 ? -1 : 1;
  const ox = nx * s * lift;
  const oy = ny * s * lift;
  const pos = new Float32Array([
    p0[0] + ox, p0[1] + oy, -halfW,
    p0[0] + ox, p0[1] + oy, halfW,
    p1[0] + ox, p1[1] + oy, halfW,
    p1[0] + ox, p1[1] + oy, -halfW,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
}


/**
 * Merge static descendant meshes of `group` that share a material into one mesh each,
 * so a detailed car costs a handful of draw calls. Objects in `keep` (animated or toggled)
 * and their subtrees are left alone. Materials are shared, so color changes still apply.
 */
function mergeStatic(group: THREE.Object3D, keep: Set<THREE.Object3D>) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const buckets = new Map<THREE.Material, { meshes: THREE.Mesh[]; shadow: boolean }>();
  const visit = (o: THREE.Object3D) => {
    if (keep.has(o)) return;
    const m = o as THREE.Mesh;
    if (m.isMesh && !Array.isArray(m.material)) {
      const b = buckets.get(m.material) ?? { meshes: [], shadow: false };
      b.meshes.push(m);
      b.shadow ||= m.castShadow;
      buckets.set(m.material, b);
    }
    for (const c of o.children) visit(c);
  };
  for (const c of group.children) visit(c);
  for (const [mat, { meshes, shadow }] of buckets) {
    if (meshes.length < 2) continue;
    const geos: THREE.BufferGeometry[] = [];
    for (const m of meshes) {
      let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
      const keepAttrs = ['position', 'normal', 'uv'];
      for (const name of Object.keys(g.attributes)) if (!keepAttrs.includes(name)) g.deleteAttribute(name);
      if (!g.attributes.normal) g.computeVertexNormals();
      if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      g.clearGroups();
      geos.push(g);
    }
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    for (const m of meshes) {
      m.parent?.remove(m);
      m.geometry.dispose();
    }
    const mm = new THREE.Mesh(merged, mat);
    mm.castShadow = shadow;
    group.add(mm);
  }
  // drop now-empty helper groups
  const empties: THREE.Object3D[] = [];
  group.traverse((o) => {
    if (o !== group && !(o as THREE.Mesh).isMesh && !(o as THREE.Sprite).isSprite && o.children.length === 0 && !keep.has(o)) empties.push(o);
  });
  for (const e of empties) e.parent?.remove(e);
}

let glowTexture: THREE.Texture | null = null;
function glowTex(): THREE.Texture {
  if (glowTexture) return glowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glowTexture = new THREE.CanvasTexture(c);
  return glowTexture;
}

export class CarModel {
  root = new THREE.Group(); // body + wheels; tilted slightly for chassis animation
  body = new THREE.Group();
  wheels: { pivot: THREE.Group; spin: THREE.Group; sign: number }[] = [];
  flame: THREE.Mesh;
  flameCore: THREE.Mesh;
  private brakeMat: THREE.MeshBasicMaterial;
  private brakeGlow: THREE.Sprite[] = [];
  private flameMat: THREE.MeshBasicMaterial;
  private antenna?: THREE.Group;
  private antennaV = 0;
  private antennaA = 0;
  private disposables: { dispose(): void }[] = [];
  readonly spec: StyleSpec;

  constructor(
    public readonly design: CarDesign,
    public readonly teamColor: number,
  ) {
    const d = design;
    const spec = (this.spec = STYLES[d.body]);
    this.root.add(this.body);
    const hw = spec.halfWidth;
    const shape = bodyShape(spec, WHEEL_REST_Y);

    // --- painted shell
    const paint = finishMaterial(d.primary, d.finish);
    const depth = 2 * hw - 2 * BEVEL_T;
    const shellGeo = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelThickness: BEVEL_T,
      bevelSize: BEVEL_S,
      bevelSegments: 3,
      curveSegments: 10,
    });
    shellGeo.translate(0, 0, -depth / 2);
    const shell = new THREE.Mesh(shellGeo, paint);
    shell.castShadow = true;
    shell.receiveShadow = true;
    this.body.add(shell);

    const accent = finishMaterial(d.secondary, d.finish === 'chrome' ? 'metallic' : d.finish);
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.55, metalness: 0.4 });

    // --- top racing stripes
    if (d.decal === 'stripes' || d.decal === 'number') {
      for (const z of [-0.14, 0.14]) {
        const sg = new THREE.ExtrudeGeometry(shape, {
          depth: 0.12,
          bevelEnabled: true,
          bevelThickness: 0.005,
          bevelSize: BEVEL_S + 0.008,
          bevelSegments: 1,
          curveSegments: 10,
        });
        sg.translate(0, 0, z - 0.06);
        const stripe = new THREE.Mesh(sg, accent);
        this.body.add(stripe);
      }
    }

    // --- side decals (overlay planes matching the shell's side faces)
    for (const side of [1, -1]) {
      const tex = paintDecal(d, side < 0);
      if (!tex) continue;
      const mat = new THREE.MeshPhysicalMaterial({
        map: tex,
        transparent: true,
        roughness: paint.roughness,
        metalness: paint.metalness,
        clearcoat: paint.clearcoat,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        depthWrite: false,
      });
      const decal = new THREE.Mesh(new THREE.ShapeGeometry(shape, 10), mat);
      decal.position.z = side * (hw + 0.004);
      this.body.add(decal);
    }

    // --- glass
    const glass = new THREE.MeshPhysicalMaterial({ color: 0x0b1018, metalness: 0.2, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.02 });
    const winShape = new THREE.Shape();
    winShape.moveTo(spec.window[0][0], spec.window[0][1]);
    for (const p of spec.window.slice(1)) winShape.lineTo(p[0], p[1]);
    winShape.closePath();
    const winDepth = 2 * hw - 0.06;
    const winGeo = new THREE.ExtrudeGeometry(winShape, { depth: winDepth, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.02, bevelSegments: 1 });
    winGeo.translate(0, 0, -winDepth / 2);
    this.body.add(new THREE.Mesh(winGeo, glass));
    const ws = spec.windshield;
    this.body.add(quad([ws[0], ws[1]], [ws[2], ws[3]], hw * 0.8, BEVEL_S + 0.012, glass));
    if (spec.rearGlass) {
      const rg = spec.rearGlass;
      this.body.add(quad([rg[0], rg[1]], [rg[2], rg[3]], hw * 0.72, BEVEL_S + 0.012, glass));
    }

    // --- lights
    const headHex = d.headlights === 'off' ? 0x2a2e36 : HEADLIGHT_HEX[d.headlights];
    const headMat = new THREE.MeshBasicMaterial({ color: headHex, toneMapped: d.headlights === 'off' });
    for (const s of [-1, 1]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.3), headMat);
      hl.position.set(spec.head[0], spec.head[1], s * (hw - 0.22));
      this.body.add(hl);
      if (d.headlights !== 'off') {
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: headHex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.55 }));
        glow.scale.set(0.7, 0.45, 1);
        glow.position.set(spec.head[0] + 0.08, spec.head[1], s * (hw - 0.22));
        this.body.add(glow);
      }
    }
    this.brakeMat = new THREE.MeshBasicMaterial({ color: 0x8a0d14, toneMapped: false });
    for (const s of [-1, 1]) {
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.34), this.brakeMat);
      tl.position.set(spec.tail[0], spec.tail[1], s * (hw - 0.22));
      this.body.add(tl);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: 0xff2030, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.9 }));
      glow.scale.set(0.8, 0.5, 1);
      glow.position.set(spec.tail[0] - 0.08, spec.tail[1], s * (hw - 0.22));
      glow.visible = false;
      this.body.add(glow);
      this.brakeGlow.push(glow);
    }

    // --- grille, skirts, mirrors, exhausts
    const grille = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, hw * 1.1), trimMat);
    grille.position.set(spec.upper[spec.upper.length - 2][0] - 0.01, -0.16, 0);
    this.body.add(grille);
    const skirtLen = 2 * WHEEL_X - 2 * (R + 0.12);
    for (const s of [-1, 1]) {
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(skirtLen, 0.07, 0.05), accent);
      skirt.position.set(0, spec.bottom + 0.035, s * (hw + 0.01));
      this.body.add(skirt);
      // team identification strip (always shows the car's team in matches)
      const trim = new THREE.Mesh(new THREE.BoxGeometry(skirtLen * 0.9, 0.025, 0.02), new THREE.MeshBasicMaterial({ color: teamColor, toneMapped: false }));
      trim.position.set(0, spec.bottom + 0.085, s * (hw + 0.035));
      this.body.add(trim);
      const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.12), paint);
      mirror.position.set(ws[2] - 0.05, ws[3] + 0.02, s * (hw + 0.06));
      this.body.add(mirror);
    }
    const chrome = new THREE.MeshStandardMaterial({ color: 0xd0d4dc, metalness: 1, roughness: 0.2 });
    for (const s of [-1, 1]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.12, 10), chrome);
      pipe.rotation.z = Math.PI / 2;
      pipe.position.set(spec.upper[0][0] - 0.06, spec.bottom + 0.1, s * 0.38);
      this.body.add(pipe);
    }
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.19, 0.16, 14), trimMat);
    nozzle.rotation.z = Math.PI / 2;
    nozzle.position.set(spec.upper[1][0] - 0.02, 0.0, 0);
    this.body.add(nozzle);

    // --- spoiler
    const sp = spec.spoiler;
    if (d.spoiler === 'ducktail') {
      const lip = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.05, hw * 1.9), accent);
      lip.position.set(sp[0] - 0.08, sp[1] + 0.07, 0);
      lip.rotation.z = 0.32;
      this.body.add(lip);
    } else if (d.spoiler === 'wing' || d.spoiler === 'gt') {
      const gt = d.spoiler === 'gt';
      const h = gt ? 0.38 : 0.22;
      const chord = gt ? 0.42 : 0.32;
      const span = hw * (gt ? 2.0 : 1.8);
      const wing = new THREE.Mesh(new THREE.BoxGeometry(chord, 0.045, span), accent);
      wing.position.set(sp[0] - 0.05, sp[1] + h, 0);
      wing.rotation.z = gt ? 0.14 : 0.08;
      wing.castShadow = true;
      this.body.add(wing);
      for (const s of [-1, 1]) {
        const strut = new THREE.Mesh(new THREE.BoxGeometry(0.07, h, 0.04), trimMat);
        strut.position.set(sp[0] + 0.0, sp[1] + h / 2, s * hw * 0.5);
        strut.rotation.z = gt ? -0.25 : 0;
        this.body.add(strut);
        if (gt) {
          const plate = new THREE.Mesh(new THREE.BoxGeometry(chord + 0.08, 0.2, 0.025), accent);
          plate.position.set(sp[0] - 0.05, sp[1] + h - 0.04, s * span / 2);
          this.body.add(plate);
        }
      }
    }

    // --- toppers
    if (d.topper === 'antenna') {
      this.antenna = new THREE.Group();
      this.antenna.position.set(spec.roof[0] - 0.25, spec.roof[1] + 0.02, hw * 0.45);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.012, 0.7, 6), trimMat);
      rod.position.y = 0.35;
      this.antenna.add(rod);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), accent);
      ball.position.y = 0.72;
      this.antenna.add(ball);
      this.body.add(this.antenna);
    } else if (d.topper === 'lightbar') {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.07, hw * 1.3), trimMat);
      bar.position.set(spec.roof[0] + 0.1, spec.roof[1] + 0.07, 0);
      this.body.add(bar);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.04, hw * 1.2), new THREE.MeshBasicMaterial({ color: headHex === 0x2a2e36 ? 0xffd27a : headHex, toneMapped: false }));
      lamp.position.set(spec.roof[0] + 0.17, spec.roof[1] + 0.07, 0);
      this.body.add(lamp);
    } else if (d.topper === 'scoop') {
      const scoop = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.12, 0.4), accent);
      scoop.position.set(spec.hood[0], spec.hood[1] + 0.07, 0);
      scoop.rotation.z = -0.12;
      this.body.add(scoop);
      const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.07, 0.32), trimMat);
      mouth.position.set(spec.hood[0] + 0.21, spec.hood[1] + 0.08, 0);
      this.body.add(mouth);
    }

    // --- underglow
    if (d.underglow !== 'none') {
      const col = d.underglow === 'team' ? teamColor : GLOW_HEX[d.underglow];
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(3.4, 2.4),
        new THREE.MeshBasicMaterial({ map: glowTex(), color: col, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      glow.rotation.x = -Math.PI / 2;
      glow.position.y = WHEEL_REST_Y - R + 0.03;
      this.root.add(glow);
    }

    // --- fender pods: painted arches over each wheel, Rocket League style
    const fenderGeo = new THREE.CylinderGeometry(R + 0.09, R + 0.09, 0.42, 20, 1, true, -Math.PI * 0.62, Math.PI * 1.24);
    fenderGeo.rotateX(Math.PI / 2);
    const fenderMat = paint.clone();
    fenderMat.side = THREE.DoubleSide;
    const lipGeo = new THREE.TorusGeometry(R + 0.09, 0.03, 6, 20, Math.PI * 1.24);
    for (const o of CAR.wheelOffsets) {
      const side = Math.sign(o[2]);
      const fender = new THREE.Mesh(fenderGeo, fenderMat);
      fender.position.set(o[0], WHEEL_REST_Y + 0.03, side * (WHEEL_Z - 0.02));
      fender.rotation.z = Math.PI; // arc over the top of the wheel, open underneath
      fender.castShadow = true;
      this.body.add(fender);
      for (const zs of [-1, 1]) {
        const lip = new THREE.Mesh(lipGeo, accent);
        lip.position.set(o[0], WHEEL_REST_Y + 0.03, side * (WHEEL_Z - 0.02) + zs * 0.21);
        lip.rotation.z = Math.PI / 2 - Math.PI * 0.62;
        this.body.add(lip);
      }
    }

    // --- wheels
    const caliperHex = d.decal === 'none' ? 0xd02a2a : new THREE.Color(d.secondary).getHex();
    CAR.wheelOffsets.forEach((o) => {
      const side = Math.sign(o[2]);
      const { pivot, spin } = buildWheel(d.wheel, RIM_HEX[d.rim], caliperHex);
      const mirror = new THREE.Group(); // left wheels are mirrored so rims face outward
      if (side < 0) mirror.rotation.y = Math.PI;
      mirror.add(pivot);
      mirror.position.set(o[0], WHEEL_REST_Y, side * WHEEL_Z);
      this.root.add(mirror);
      this.wheels.push({ pivot: mirror, spin, sign: side < 0 ? -1 : 1 });
      void pivot;
    });

    // --- boost flame
    const [core, outer] = this.boostColors(0);
    const flameGeo = new THREE.ConeGeometry(0.2, 1.5, 14, 1, true);
    flameGeo.translate(0, 0.75, 0);
    flameGeo.rotateZ(Math.PI / 2);
    this.flameMat = new THREE.MeshBasicMaterial({ color: outer, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.flame = new THREE.Mesh(flameGeo, this.flameMat);
    this.flame.position.set(spec.upper[1][0] - 0.1, 0.0, 0);
    this.flame.visible = false;
    this.body.add(this.flame);
    const coreGeo = new THREE.ConeGeometry(0.1, 0.85, 10, 1, true);
    coreGeo.translate(0, 0.425, 0);
    coreGeo.rotateZ(Math.PI / 2);
    this.flameCore = new THREE.Mesh(
      coreGeo,
      new THREE.MeshBasicMaterial({ color: core, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    );
    this.flameCore.position.copy(this.flame.position);
    this.flameCore.visible = false;
    this.body.add(this.flameCore);

    // --- batch static geometry (keeps animated / toggled parts separate)
    for (const w of this.wheels) mergeStatic(w.spin, new Set());
    const keep = new Set<THREE.Object3D>([this.flame, this.flameCore]);
    if (this.antenna) keep.add(this.antenna);
    mergeStatic(this.body, keep);

    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        if (m.geometry) this.disposables.push(m.geometry);
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const mt of mats) {
          this.disposables.push(mt);
          const map = (mt as THREE.MeshStandardMaterial).map;
          if (map && map !== glowTexture) this.disposables.push(map);
        }
      }
    });
  }

  /** Boost flame colors [core, outer] at a given time (rainbow cycles). */
  boostColors(time: number): [THREE.Color, THREE.Color] {
    const b = this.design.boost;
    if (b === 'team') {
      const c = new THREE.Color(this.teamColor);
      return [new THREE.Color(0xffffff).lerp(c, 0.15), c];
    }
    if (b === 'rainbow') {
      const c = new THREE.Color().setHSL((time * 0.6) % 1, 1, 0.55);
      return [new THREE.Color(0xffffff), c];
    }
    const [core, outer] = BOOST_HEX[b];
    return [new THREE.Color(core), new THREE.Color(outer)];
  }

  setWheel(i: number, y: number, steer: number, spin: number) {
    const w = this.wheels[i];
    w.pivot.position.y = y;
    w.pivot.rotation.y = (w.sign < 0 ? Math.PI : 0) + steer;
    w.spin.rotation.z = -spin * w.sign;
  }

  setBraking(on: boolean) {
    this.brakeMat.color.setHex(on ? 0xff2a36 : 0x8a0d14);
    for (const g of this.brakeGlow) g.visible = on;
  }

  setBoost(on: boolean, time: number) {
    this.flame.visible = on;
    this.flameCore.visible = on;
    if (on) {
      const fl = 0.8 + Math.random() * 0.45;
      this.flame.scale.set(fl, 1, 1);
      this.flameCore.scale.set(fl * 0.9, 1, 1);
      if (this.design.boost === 'rainbow') this.flameMat.color.copy(this.boostColors(time)[1]);
    }
  }

  /** Cosmetic secondary motion (antenna wobble, chassis lean). */
  animate(dt: number, accelLocal: THREE.Vector3) {
    // chassis lean: pitch back under acceleration, roll out of turns
    const pitch = THREE.MathUtils.clamp(-accelLocal.x * 0.0035, -0.05, 0.05);
    const roll = THREE.MathUtils.clamp(accelLocal.z * 0.004, -0.06, 0.06);
    const k = 1 - Math.exp(-10 * dt);
    this.body.rotation.z += (-pitch - this.body.rotation.z) * k;
    this.body.rotation.x += (roll - this.body.rotation.x) * k;
    if (this.antenna) {
      // spring-damper driven by acceleration
      this.antennaV += (-accelLocal.x * 0.02 - this.antennaA * 60 - this.antennaV * 6) * dt;
      this.antennaA += this.antennaV * dt;
      this.antenna.rotation.z = THREE.MathUtils.clamp(this.antennaA, -0.5, 0.5);
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
