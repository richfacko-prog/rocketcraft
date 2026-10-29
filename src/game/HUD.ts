import { UU } from './Config';
import * as THREE from 'three';
import type { Car } from './Car';
import { controlGuide, type Scheme } from './Input';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  parent.appendChild(e);
  return e;
}

export function formatClock(t: number, overtime: boolean) {
  const s = Math.max(0, overtime ? Math.floor(t) : Math.ceil(t));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${overtime ? '+' : ''}${m}:${r.toString().padStart(2, '0')}`;
}

export interface HudContext {
  gamepad: boolean;
  countdown: boolean;
  scheme: Scheme;
}

export class HUD {
  root: HTMLElement;
  private blueScore: HTMLElement;
  private orangeScore: HTMLElement;
  private clock: HTMLElement;
  private otTag: HTMLElement;
  private boostCanvas: HTMLCanvasElement;
  private boostCtx: CanvasRenderingContext2D;
  private speedEl: HTMLElement;
  private center: HTMLElement;
  private sub: HTMLElement;
  private indicator: HTMLElement;
  private replayTag: HTMLElement;
  private feed: HTMLElement;
  private camTag: HTMLElement;
  private guide: HTMLElement;
  private guideList: HTMLElement;
  private hint: HTMLElement;
  private ssBadge: HTMLElement;
  private board: HTMLElement;
  private boardKey = '';
  private lastBoost = -1;
  private lastBoosting = false;
  private centerTimer = 0;
  private guideMode = '';
  private hintText = '';
  guideHidden = false;

  constructor() {
    this.root = el('div', 'hud hidden', document.body);
    // top center: score + clock
    const sb = el('div', 'scoreboard', this.root);
    this.blueScore = el('div', 'score blue', sb, '0');
    const mid = el('div', 'clockbox', sb);
    this.clock = el('div', 'clock', mid, '5:00');
    this.otTag = el('div', 'ot hidden', mid, 'OVERTIME');
    this.orangeScore = el('div', 'score orange', sb, '0');

    // bottom bar
    const bottom = el('div', 'hud-bottom', this.root);
    // bottom left: controls + camera status
    const left = el('div', 'hud-left', bottom);
    this.guide = el('div', 'guide', left);
    el('div', 'guide-head', this.guide, '<span>CONTROLS</span><span class="guide-toggle"><kbd>H</kbd> hide</span>');
    this.guideList = el('div', 'guide-list', this.guide);
    this.camTag = el('div', 'camtag', left, '');
    // bottom center: hints
    const centerCol = el('div', 'hud-center', bottom);
    this.ssBadge = el('div', 'ss-badge', centerCol, 'SUPERSONIC');
    this.hint = el('div', 'hint', centerCol, '');
    // bottom right: boost + speed
    const right = el('div', 'hud-right', bottom);
    const bw = el('div', 'boostwrap', right);
    this.boostCanvas = el('canvas', 'boost', bw);
    this.boostCanvas.width = 240;
    this.boostCanvas.height = 240;
    this.boostCtx = this.boostCanvas.getContext('2d')!;
    const sp = el('div', 'speed', bw);
    this.speedEl = el('span', 'speed-num', sp, '0');
    el('span', 'speed-unit', sp, 'KM/H');

    this.center = el('div', 'center', this.root);
    this.sub = el('div', 'center-sub', this.root);
    this.indicator = el('div', 'ball-indicator hidden', this.root, '<div class="arrow"></div>');
    this.replayTag = el('div', 'replay hidden', this.root, '<span class="dot"></span> REPLAY <small>Jump to skip</small>');
    this.feed = el('div', 'feed', this.root);
    this.board = el('div', 'board hidden', this.root);
    this.renderGuide(false, 'rl');
  }

  show(v: boolean) {
    this.root.classList.toggle('hidden', !v);
  }

  /** Tab scoreboard (rows are rendered with textContent: names come from other players). */
  showScoreboard(on: boolean, rows: { name: string; team: number; score: number; goals: number; assists: number; saves: number; shots: number; absent?: boolean }[]) {
    this.board.classList.toggle('hidden', !on);
    if (!on) return;
    const key = JSON.stringify(rows);
    if (key === this.boardKey) return;
    this.boardKey = key;
    this.board.replaceChildren();
    for (const team of [0, 1]) {
      const table = document.createElement('table');
      table.className = `board-team t${team}`;
      const head = table.insertRow();
      for (const h of [team === 0 ? 'BLUE' : 'ORANGE', 'SCORE', 'GOALS', 'ASSISTS', 'SAVES', 'SHOTS']) {
        const th = document.createElement('th');
        th.textContent = h;
        head.appendChild(th);
      }
      for (const r of rows.filter((x) => x.team === team).sort((a, b) => b.score - a.score)) {
        const tr = table.insertRow();
        if (r.absent) tr.className = 'gone';
        for (const v of [r.name, r.score, r.goals, r.assists, r.saves, r.shots]) tr.insertCell().textContent = String(v);
      }
      this.board.appendChild(table);
    }
  }

  toggleGuide() {
    this.guideHidden = !this.guideHidden;
    this.guide.classList.toggle('collapsed', this.guideHidden);
  }

  private renderGuide(gamepad: boolean, scheme: Scheme) {
    const mode = gamepad ? 'pad' : scheme;
    if (mode === this.guideMode) return;
    this.guideMode = mode;
    const list = controlGuide(scheme, gamepad);
    this.guideList.innerHTML = list.map(([k, a]) => `<div class="g-row"><kbd>${k}</kbd><span>${a}</span></div>`).join('');
  }

  setScore(blue: number, orange: number) {
    this.blueScore.textContent = String(blue);
    this.orangeScore.textContent = String(orange);
  }

  bumpScore(team: 0 | 1) {
    const e = team === 0 ? this.blueScore : this.orangeScore;
    e.classList.remove('bump');
    void e.offsetWidth;
    e.classList.add('bump');
  }

  setClock(t: number, overtime: boolean) {
    this.clock.textContent = formatClock(t, overtime);
    this.otTag.classList.toggle('hidden', !overtime);
    this.clock.classList.toggle('low', !overtime && t <= 30);
  }

  setBallCam(on: boolean, key = 'Space') {
    this.camTag.innerHTML = `<span class="cam-dot"></span>${on ? 'BALL CAM' : 'CAR CAM'}<kbd>${key}</kbd>`;
    this.camTag.classList.toggle('on', on);
  }

  message(text: string, sub = '', duration = 1.5, cls = '') {
    this.center.textContent = text;
    this.center.className = `center show ${cls}`;
    this.sub.textContent = sub;
    this.sub.className = `center-sub ${sub ? 'show' : ''}`;
    this.centerTimer = duration;
  }

  clearMessage() {
    this.centerTimer = 0;
    this.center.className = 'center';
    this.sub.className = 'center-sub';
  }

  hideIndicator() {
    this.indicator.classList.add('hidden');
  }

  replay(on: boolean) {
    this.replayTag.classList.toggle('hidden', !on);
    this.root.classList.toggle('replaying', on);
  }

  toast(text: string, color = '#fff') {
    const t = el('div', 'toast', this.feed);
    t.textContent = text;
    t.style.borderLeftColor = color;
    setTimeout(() => t.classList.add('out'), 2600);
    setTimeout(() => t.remove(), 3200);
    while (this.feed.children.length > 5) this.feed.firstChild?.remove();
  }

  /** Pick the single most useful contextual hint for the current situation. */
  private pickHint(car: Car, ctx: HudContext): string {
    const rl = ctx.scheme === 'rl';
    const jump = ctx.gamepad ? 'A' : rl ? 'Right-click' : 'Space';
    const boost = ctx.gamepad ? 'B' : rl ? 'Left-click' : 'Shift';
    const slide = ctx.gamepad ? 'X' : rl ? 'L-Shift' : 'C';
    if (car.demolished) return 'Demolished — respawning…';
    if (ctx.countdown) return `Hold ${boost} to boost off the line`;
    if (!car.onGround && car.wheelContacts === 0) {
      if (car.up.y < -0.2 && car.speed < 6) return `Press ${jump} to flip upright`;
      if (car.hasFlip) return `${jump} again to double jump · add a direction to flip`;
      if (car.boost > 0) return `${boost} + pitch to fly · ${slide} + steer to air roll`;
      return '';
    }
    if (car.sticking) return `Driving on the wall · ${jump} to leave it`;
    if (car.boost < 12) return 'Low boost — drive over the glowing pads';
    if (car.speed < 3) return `${jump} to jump · ${boost} to boost`;
    return '';
  }

  update(dt: number, car: Car, ballPos: THREE.Vector3, camera: THREE.PerspectiveCamera, showIndicator: boolean, ctx: HudContext) {
    if (this.centerTimer > 0) {
      this.centerTimer -= dt;
      if (this.centerTimer <= 0) this.clearMessage();
    }
    this.renderGuide(ctx.gamepad, ctx.scheme);
    const b = Math.round(car.boost);
    if (b !== this.lastBoost || car.boosting !== this.lastBoosting) {
      this.lastBoost = b;
      this.lastBoosting = car.boosting;
      this.drawBoost(b, car.boosting);
    }
    const kmh = Math.round((car.speed / UU) * 0.036);
    this.speedEl.textContent = String(kmh);
    this.ssBadge.classList.toggle('on', car.supersonic);

    const h = this.pickHint(car, ctx);
    if (h !== this.hintText) {
      this.hintText = h;
      if (h) this.hint.textContent = h;
      this.hint.classList.toggle('on', !!h);
    }

    // off-screen ball indicator
    const p = ballPos.clone().project(camera);
    const behind = ballPos.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3())) < 0;
    const onScreen = !behind && Math.abs(p.x) < 0.95 && Math.abs(p.y) < 0.92;
    if (!showIndicator || onScreen) {
      this.indicator.classList.add('hidden');
    } else {
      let x = p.x;
      let y = p.y;
      if (behind) {
        x = -x;
        y = -y;
      }
      const len = Math.hypot(x, y) || 1;
      x /= len;
      y /= len;
      const w = window.innerWidth;
      const hh = window.innerHeight;
      const sx = w / 2 + x * (w / 2 - 70);
      const sy = hh / 2 - y * (hh / 2 - 110);
      const ang = Math.atan2(-y, x);
      this.indicator.classList.remove('hidden');
      this.indicator.style.transform = `translate(${sx - 28}px, ${sy - 28}px) rotate(${ang}rad)`;
    }
  }

  private drawBoost(v: number, boosting: boolean) {
    const g = this.boostCtx;
    const W = 240;
    g.clearRect(0, 0, W, W);
    const cx = W / 2;
    const cy = W / 2;
    const r = 96;
    const start = Math.PI * 0.75;
    const end = Math.PI * 2.25;
    // segmented gauge, 4 boost per segment
    g.lineCap = 'butt';
    g.lineWidth = 18;
    const segs = 25;
    const gap = 0.012;
    for (let i = 0; i < segs; i++) {
      const a0 = start + ((end - start) * i) / segs + gap;
      const a1 = start + ((end - start) * (i + 1)) / segs - gap;
      const filled = i < Math.ceil((v / 100) * segs);
      g.strokeStyle = filled ? (v < 25 ? '#ff5a3a' : boosting ? '#ffe27a' : '#ffb52e') : 'rgba(255,255,255,0.10)';
      g.shadowColor = '#ff9a20';
      g.shadowBlur = filled ? 14 : 0;
      g.beginPath();
      g.arc(cx, cy, r, a0, a1);
      g.stroke();
    }
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(8,11,20,0.72)';
    g.beginPath();
    g.arc(cx, cy, r - 18, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.font = 'italic 700 74px "Rajdhani", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(v), cx, cy - 6);
    g.font = '600 18px "Rajdhani", system-ui, sans-serif';
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.fillText('BOOST', cx, cy + 40);
  }
}
