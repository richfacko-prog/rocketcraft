import * as THREE from 'three';
import { TEAM_COLORS, carRideHeight } from './Config';
import {
  BODY_STYLES,
  BOOST_COLORS,
  BOOST_HEX,
  CarDesign,
  DECALS,
  FINISHES,
  GLOW_HEX,
  HEADLIGHTS,
  HEADLIGHT_HEX,
  LABELS,
  RIM_COLORS,
  RIM_HEX,
  SPOILERS,
  TOPPERS,
  TRAILS,
  UNDERGLOWS,
  WHEEL_STYLES,
  saveDesign,
  validateDesign,
} from './CarDesign';
import { CarModel, WHEEL_REST_Y } from './CarModel';
import { Particles } from './Particles';
import { DesignProvider, DesignResult, createDesignProvider } from './DesignAssistant';

const PAINT_SWATCHES = [
  '#2f8cff', '#1e7bff', '#14244f', '#22d3ee', '#2fbf4a', '#7be82a', '#ffd21f', '#d9a925',
  '#ff7a1a', '#e0242c', '#a8101a', '#ff5fb4', '#8a3cff', '#f2f4f7', '#c4cad4', '#50555f', '#121318',
];

const BODY_BLURB: Record<string, string> = {
  striker: 'Balanced hatch-coupe',
  viper: 'Long, low supercar',
  brute: 'Tall, boxy brawler',
  wedge: 'Futuristic wedge',
};

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');

const EXAMPLES = [
  'Build a futuristic black-and-electric-blue supercar with gold rims, a low body, a large rear wing, and bright blue boost flames.',
  'Matte army green off-road truck with black rims, camo, a roof light bar and orange boost.',
  'Glossy red classic racer with white racing stripes, number 23 and chrome rims.',
  'Pearl white stealth wedge with turbine wheels, pink underglow and plasma boost.',
];

type Tab = { id: string; title: string; build: (el: HTMLElement) => void };

export class Garage {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  open = false;
  draft: CarDesign;
  private saved: CarDesign;
  private model: CarModel | null = null;
  private turntable = new THREE.Group();
  private particles: Particles;
  private yaw = -0.7;
  private pitch = 0.22;
  private dist = 7.2;
  private autoSpin = true;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private boostTimer = 0;
  private time = 0;
  private wheelSpin = 0;
  private provider: DesignProvider = createDesignProvider();
  private lastResult: DesignResult | null = null;
  private variation = 0;
  private busy = false;
  private $ = (id: string) => document.getElementById(id)!;
  private optionEls: { key: keyof CarDesign; value: string; el: HTMLElement }[] = [];
  private activeTab = 'body';

  constructor(
    private canvas: HTMLCanvasElement,
    envMap: THREE.Texture,
    initial: CarDesign,
    private onEquip: (d: CarDesign) => void,
  ) {
    this.draft = { ...initial };
    this.saved = { ...initial };
    this.camera = new THREE.PerspectiveCamera(34, window.innerWidth / window.innerHeight, 0.1, 200);
    this.buildScene(envMap);
    this.particles = new Particles(this.scene);
    this.buildUI();
    this.bindPointer();
    this.rebuildModel();
  }

  // ---------------------------------------------------------------- scene
  private buildScene(envMap: THREE.Texture) {
    const s = this.scene;
    s.background = new THREE.Color(0x070a12);
    s.fog = new THREE.Fog(0x070a12, 18, 45);
    s.environment = envMap;
    s.environmentIntensity = 0.6;
    s.add(new THREE.HemisphereLight(0xc8dcff, 0x10131c, 0.9));
    const key = new THREE.SpotLight(0xffffff, 120, 30, 0.55, 0.5, 1.6);
    key.position.set(4, 9, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0005;
    s.add(key);
    s.add(key.target);
    const rimBlue = new THREE.PointLight(TEAM_COLORS[0], 40, 20, 1.6);
    rimBlue.position.set(-5, 2.5, -4);
    s.add(rimBlue);
    const rimOrange = new THREE.PointLight(TEAM_COLORS[1], 30, 20, 1.6);
    rimOrange.position.set(5, 2, -5);
    s.add(rimOrange);
    // podium
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(40, 64),
      new THREE.MeshStandardMaterial({ color: 0x0b0e16, roughness: 0.9 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    s.add(floor);
    const podium = new THREE.Mesh(
      new THREE.CylinderGeometry(3.6, 3.8, 0.18, 64),
      new THREE.MeshStandardMaterial({ color: 0x161b27, roughness: 0.25, metalness: 0.7 }),
    );
    podium.position.y = 0.09;
    podium.receiveShadow = true;
    this.turntable.add(podium);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(3.7, 0.03, 8, 96),
      new THREE.MeshBasicMaterial({ color: 0x4aa0ff, toneMapped: false }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.18;
    this.turntable.add(ring);
    s.add(this.turntable);
    // backdrop light strips
    const stripMat = new THREE.MeshBasicMaterial({ color: 0x9fc4ff, toneMapped: false });
    for (let i = 0; i < 14; i++) {
      const a = Math.PI * 0.15 + (i / 13) * Math.PI * 0.7;
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 6, 0.08), stripMat);
      strip.position.set(Math.cos(a + Math.PI) * 14, 3 + (i % 2) * 0.6, Math.sin(a + Math.PI) * 14);
      s.add(strip);
    }
  }

  private rebuildModel() {
    if (this.model) {
      this.turntable.remove(this.model.root);
      this.model.dispose();
    }
    this.model = new CarModel(this.draft, TEAM_COLORS[0]);
    this.model.root.position.y = 0.18 + carRideHeight();
    this.model.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    this.turntable.add(this.model.root);
  }

  setDraft(d: CarDesign, markDirty = true) {
    this.draft = validateDesign(d);
    this.rebuildModel();
    this.syncUI();
    if (markDirty) this.setStatus(this.isDirty() ? 'Unsaved changes' : '', this.isDirty() ? 'warn' : '');
  }

  private isDirty() {
    return JSON.stringify(this.draft) !== JSON.stringify(this.saved);
  }

  render(renderer: THREE.WebGLRenderer, dt: number) {
    this.time += dt;
    if (this.autoSpin && !this.dragging) this.yaw += dt * 0.25;
    const target = new THREE.Vector3(0, 0.9, 0);
    this.camera.position.set(
      Math.sin(this.yaw) * Math.cos(this.pitch) * this.dist,
      0.9 + Math.sin(this.pitch) * this.dist,
      Math.cos(this.yaw) * Math.cos(this.pitch) * this.dist,
    );
    this.camera.lookAt(target);
    const m = this.model;
    if (m) {
      const boosting = this.boostTimer > 0;
      this.boostTimer -= dt;
      this.wheelSpin += dt * (boosting ? 18 : 0);
      for (let i = 0; i < 4; i++) m.setWheel(i, WHEEL_REST_Y, i < 2 ? -0.32 : 0, this.wheelSpin);
      m.setBoost(boosting, this.time);
      m.setBraking(!boosting && Math.sin(this.time * 1.5) > 0.6);
      m.animate(dt, new THREE.Vector3(boosting ? 25 : 0, 0, 0));
      if (boosting) {
        const [core, outer] = m.boostColors(this.time);
        const back = m.root.localToWorld(new THREE.Vector3(m.spec.upper[1][0] - 0.4, 0, 0));
        const dir = new THREE.Vector3(-1, 0, 0).applyQuaternion(m.root.getWorldQuaternion(new THREE.Quaternion()));
        const style = this.draft.trail;
        if (style === 'sparkle') this.particles.glow.emit({ pos: back, vel: dir.multiplyScalar(6), spread: 3, color: 0xffffff, color2: outer, size: 0.25, sizeEnd: 0.03, life: 0.6, count: 3, gravity: 3 });
        else if (style === 'plasma') this.particles.glow.emit({ pos: back, vel: dir.multiplyScalar(4), spread: 0.4, color: core, color2: outer, size: 0.9, sizeEnd: 0.3, life: 0.5, count: 2, alpha: 0.8 });
        else this.particles.glow.emit({ pos: back, vel: dir.multiplyScalar(7), spread: 1.2, color: core, color2: outer, size: 0.6, sizeEnd: 0.1, life: 0.3, count: 2 });
      }
    }
    this.particles.setViewport(renderer.domElement.height, this.camera.fov);
    this.particles.update(dt);
    renderer.render(this.scene, this.camera);
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  show(current: CarDesign) {
    this.saved = { ...current };
    this.open = true;
    this.setDraft(current, false);
    this.setStatus('', '');
    this.$('garage').classList.remove('hidden');
  }

  hide() {
    this.open = false;
    this.$('garage').classList.add('hidden');
  }

  // ---------------------------------------------------------------- input
  private bindPointer() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (!this.open) return;
      this.dragging = true;
      this.autoSpin = false;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.open || !this.dragging) return;
      this.yaw -= (e.clientX - this.lastX) * 0.008;
      this.pitch = THREE.MathUtils.clamp(this.pitch + (e.clientY - this.lastY) * 0.005, 0.02, 1.1);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    const end = () => (this.dragging = false);
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener(
      'wheel',
      (e) => {
        if (!this.open) return;
        this.dist = THREE.MathUtils.clamp(this.dist + Math.sign(e.deltaY) * 0.5, 4.2, 12);
      },
      { passive: true },
    );
  }

  // ---------------------------------------------------------------- UI
  private setStatus(text: string, kind: '' | 'ok' | 'warn' | 'err') {
    const s = this.$('g-status');
    s.textContent = text;
    s.className = `g-status ${kind}`;
  }

  private chip(parent: HTMLElement, key: keyof CarDesign, value: string, label: string, swatch?: string) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = swatch ? 'g-swatch' : 'g-chip';
    if (swatch) {
      b.style.setProperty('--sw', swatch);
      b.title = label;
      b.setAttribute('aria-label', label);
    } else b.textContent = label;
    b.addEventListener('click', () => {
      this.setDraft({ ...this.draft, [key]: value } as CarDesign);
      if (key === 'boost' || key === 'trail') this.boostTimer = 2.2;
    });
    parent.appendChild(b);
    this.optionEls.push({ key, value, el: b });
    return b;
  }

  private section(parent: HTMLElement, title: string): HTMLElement {
    const sec = document.createElement('div');
    sec.className = 'g-sec';
    const h = document.createElement('h4');
    h.textContent = title;
    sec.appendChild(h);
    const row = document.createElement('div');
    row.className = 'g-row';
    sec.appendChild(row);
    parent.appendChild(sec);
    return row;
  }

  private colorSection(parent: HTMLElement, title: string, key: 'primary' | 'secondary') {
    const row = this.section(parent, title);
    for (const c of PAINT_SWATCHES) this.chip(row, key, c, c, c);
    const custom = document.createElement('label');
    custom.className = 'g-custom';
    const input = document.createElement('input');
    input.type = 'color';
    input.id = `g-color-${key}`;
    input.addEventListener('input', () => this.setDraft({ ...this.draft, [key]: input.value }));
    custom.appendChild(input);
    custom.appendChild(document.createTextNode('Custom'));
    row.appendChild(custom);
  }

  private buildUI() {
    const tabs: Tab[] = [
      {
        id: 'body',
        title: 'Body',
        build: (el) => {
          const row = this.section(el, 'Body style');
          row.classList.add('g-cards');
          for (const b of BODY_STYLES) {
            const card = this.chip(row, 'body', b, LABELS[b]);
            card.classList.add('g-card');
            const small = document.createElement('small');
            small.textContent = BODY_BLURB[b];
            card.appendChild(small);
          }
          const note = document.createElement('p');
          note.className = 'g-note';
          note.textContent = 'Every body uses the same hitbox, so looks never change how the car plays.';
          el.appendChild(note);
        },
      },
      {
        id: 'paint',
        title: 'Paint',
        build: (el) => {
          this.colorSection(el, 'Primary color', 'primary');
          this.colorSection(el, 'Secondary color', 'secondary');
          const row = this.section(el, 'Finish');
          for (const f of FINISHES) this.chip(row, 'finish', f, LABELS[f]);
        },
      },
      {
        id: 'wheels',
        title: 'Wheels',
        build: (el) => {
          const row = this.section(el, 'Rim design');
          for (const w of WHEEL_STYLES) this.chip(row, 'wheel', w, LABELS[w]);
          const rr = this.section(el, 'Rim color');
          for (const r of RIM_COLORS) this.chip(rr, 'rim', r, r[0].toUpperCase() + r.slice(1), hex(RIM_HEX[r]));
        },
      },
      {
        id: 'style',
        title: 'Aero & Decals',
        build: (el) => {
          const sr = this.section(el, 'Spoiler');
          for (const s of SPOILERS) this.chip(sr, 'spoiler', s, LABELS[s]);
          const dr = this.section(el, 'Decal');
          for (const d of DECALS) this.chip(dr, 'decal', d, LABELS[d]);
          const nr = this.section(el, 'Race number (for the Race Number decal)');
          const num = document.createElement('input');
          num.type = 'number';
          num.min = '0';
          num.max = '99';
          num.id = 'g-number';
          num.className = 'g-num';
          num.addEventListener('change', () => this.setDraft({ ...this.draft, number: Math.round(Number(num.value)) }));
          nr.appendChild(num);
        },
      },
      {
        id: 'boost',
        title: 'Boost',
        build: (el) => {
          const br = this.section(el, 'Boost color');
          for (const b of BOOST_COLORS) {
            const sw = b === 'team' ? hex(TEAM_COLORS[0]) : b === 'rainbow' ? 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' : hex(BOOST_HEX[b][1]);
            this.chip(br, 'boost', b, LABELS[b] ?? b, sw);
          }
          const tr = this.section(el, 'Boost trail');
          for (const t of TRAILS) this.chip(tr, 'trail', t, LABELS[t]);
          const test = document.createElement('button');
          test.type = 'button';
          test.className = 'g-chip g-test';
          test.textContent = 'Test boost';
          test.addEventListener('click', () => (this.boostTimer = 2.5));
          tr.appendChild(test);
        },
      },
      {
        id: 'extras',
        title: 'Extras',
        build: (el) => {
          const hr = this.section(el, 'Headlights');
          for (const h of HEADLIGHTS) this.chip(hr, 'headlights', h, LABELS[h], h === 'off' ? '#22252c' : hex(HEADLIGHT_HEX[h]));
          const ur = this.section(el, 'Underglow');
          for (const u of UNDERGLOWS) this.chip(ur, 'underglow', u, LABELS[u] ?? u, u === 'none' ? 'linear-gradient(135deg,#22252c 45%,#e0242c 48%,#e0242c 52%,#22252c 55%)' : u === 'team' ? hex(TEAM_COLORS[0]) : hex(GLOW_HEX[u]));
          const tr = this.section(el, 'Accessory');
          for (const t of TOPPERS) this.chip(tr, 'topper', t, LABELS[t]);
        },
      },
    ];
    const tabBar = this.$('g-tabs');
    const panes = this.$('g-panes');
    for (const t of tabs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'g-tab';
      b.textContent = t.title;
      b.dataset.tab = t.id;
      if (t.id === 'body') b.dataset.default = '';
      b.addEventListener('click', () => this.selectTab(t.id));
      tabBar.appendChild(b);
      const pane = document.createElement('div');
      pane.className = 'g-pane';
      pane.dataset.tab = t.id;
      t.build(pane);
      panes.appendChild(pane);
    }
    this.selectTab('body');

    // top bar
    this.$('g-save').addEventListener('click', () => this.equip());
    this.$('g-revert').addEventListener('click', () => this.setDraft(this.saved));
    this.$('g-random').addEventListener('click', () => {
      this.variation++;
      void this.provider.generate('', this.variation + Math.floor(Math.random() * 1000)).then((r) => this.setDraft(r.design));
    });

    // designer
    this.$('g-ai-label').textContent = this.provider.label;
    this.$('g-ai-badge').textContent = this.provider.isAI ? 'AI' : 'LOCAL';
    const ex = this.$('g-examples');
    for (const e of EXAMPLES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'g-example';
      b.textContent = e.length > 58 ? e.slice(0, 56) + '…' : e;
      b.title = e;
      b.addEventListener('click', () => {
        (this.$('g-prompt') as HTMLTextAreaElement).value = e;
        void this.runDesigner(0);
      });
      ex.appendChild(b);
    }
    this.$('g-generate').addEventListener('click', () => void this.runDesigner(0));
    this.$('g-regen').addEventListener('click', () => void this.runDesigner(this.variation + 1));
    this.$('g-preview').addEventListener('click', () => {
      if (this.lastResult) this.setDraft(this.lastResult.design);
    });
    this.$('g-apply').addEventListener('click', () => {
      if (!this.lastResult) return;
      this.setDraft(this.lastResult.design);
      this.equip();
    });
    (this.$('g-prompt') as HTMLTextAreaElement).addEventListener('keydown', (e) => {
      e.stopPropagation(); // typing must not drive the car / toggle the camera
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void this.runDesigner(0);
    });
    (this.$('g-prompt') as HTMLTextAreaElement).addEventListener('keyup', (e) => e.stopPropagation());
  }

  private selectTab(id: string) {
    this.activeTab = id;
    document.querySelectorAll<HTMLElement>('#g-tabs .g-tab').forEach((b) => b.classList.toggle('sel', b.dataset.tab === id));
    document.querySelectorAll<HTMLElement>('#g-panes .g-pane').forEach((p) => p.classList.toggle('show', p.dataset.tab === id));
  }

  private syncUI() {
    for (const o of this.optionEls) o.el.classList.toggle('sel', String(this.draft[o.key]) === o.value);
    (document.getElementById('g-color-primary') as HTMLInputElement | null)?.setAttribute('value', this.draft.primary);
    const p = document.getElementById('g-color-primary') as HTMLInputElement | null;
    const s = document.getElementById('g-color-secondary') as HTMLInputElement | null;
    if (p) p.value = this.draft.primary;
    if (s) s.value = this.draft.secondary;
    const n = document.getElementById('g-number') as HTMLInputElement | null;
    if (n) n.value = String(this.draft.number);
    void this.activeTab;
  }

  private equip() {
    const ok = saveDesign(this.draft);
    this.saved = { ...this.draft };
    this.onEquip({ ...this.draft });
    this.setStatus(ok ? 'Saved · your car is equipped' : 'Equipped for this session (this browser blocks saving)', ok ? 'ok' : 'warn');
  }

  private async runDesigner(variation: number) {
    if (this.busy) return;
    const prompt = (this.$('g-prompt') as HTMLTextAreaElement).value.trim();
    const out = this.$('g-result');
    if (!prompt) {
      out.textContent = 'Describe a car first, or pick one of the examples.';
      out.className = 'g-result err';
      return;
    }
    this.busy = true;
    this.variation = variation;
    try {
      const r = await this.provider.generate(prompt, variation);
      this.lastResult = r;
      this.setDraft(r.design);
      this.boostTimer = 1.8;
      this.renderResult(r);
      for (const id of ['g-regen', 'g-preview', 'g-apply']) (this.$(id) as HTMLButtonElement).disabled = false;
    } catch (e) {
      out.textContent = `The designer couldn't build that: ${(e as Error).message}`;
      out.className = 'g-result err';
    } finally {
      this.busy = false;
    }
  }

  /** Builds the result card with textContent only (the prompt is untrusted text). */
  private renderResult(r: DesignResult) {
    const out = this.$('g-result');
    out.className = 'g-result';
    out.replaceChildren();
    const head = document.createElement('div');
    head.className = 'g-res-head';
    head.textContent = this.variation ? `Variation ${this.variation} · previewing on the turntable` : 'Interpreted design · previewing on the turntable';
    out.appendChild(head);
    const list = document.createElement('dl');
    for (const s of r.summary) {
      const dt = document.createElement('dt');
      dt.textContent = s.part;
      const dd = document.createElement('dd');
      dd.textContent = s.value;
      if (s.from) {
        const sm = document.createElement('small');
        sm.textContent = ` from “${s.from}”`;
        dd.appendChild(sm);
      }
      list.append(dt, dd);
    }
    out.appendChild(list);
    for (const n of r.notes) {
      const p = document.createElement('p');
      p.className = 'g-res-note';
      p.textContent = n;
      out.appendChild(p);
    }
  }
}
