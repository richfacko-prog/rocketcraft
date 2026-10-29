// Mouse-free menu navigation.
// Arrow keys / D-pad / left stick move focus between the controls of whichever menu is on
// screen (spatially: "right" goes to the nearest control to the right), Enter / Space /
// gamepad A activate it, Esc / gamepad B go back. The mouse keeps working as usual.

const OVERLAYS = ['pause', 'end', 'garage', 'online', 'menu'] as const;
const FOCUSABLE = 'button:not(:disabled), input:not([type=hidden]), textarea, select';

type Dir = 'up' | 'down' | 'left' | 'right';

export class MenuNav {
  private padPrev: boolean[] = [];
  private stickDir: Dir | null = null;
  private stickRepeat = 0;

  constructor(private back: (overlay: string) => void) {
    window.addEventListener('keydown', (e) => this.onKey(e), true);
    window.addEventListener('mousemove', () => document.body.classList.remove('nav-active'));
    // focus a sensible default whenever a menu appears
    const obs = new MutationObserver(() => this.autofocus());
    for (const id of OVERLAYS) {
      const el = document.getElementById(id);
      if (el) obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    }
    this.autofocus();
  }

  /** The menu currently on top, or null while driving. */
  active(): HTMLElement | null {
    for (const id of OVERLAYS) {
      const el = document.getElementById(id);
      if (el && !el.classList.contains('hidden')) return el;
    }
    return null;
  }

  private lastActive: HTMLElement | null = null;
  private autofocus() {
    const ov = this.active();
    if (ov === this.lastActive) return;
    this.lastActive = ov;
    if (!ov) return;
    const def = ov.querySelector<HTMLElement>('[data-default]') ?? ov.querySelector<HTMLElement>(FOCUSABLE);
    // focusVisible makes the ring show even if the last input was a mouse click
    def?.focus({ preventScroll: true, focusVisible: document.body.classList.contains('nav-active') } as FocusOptions);
  }

  private candidates(ov: HTMLElement): HTMLElement[] {
    return [...ov.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    });
  }

  move(dir: Dir) {
    const ov = this.active();
    if (!ov) return;
    document.body.classList.add('nav-active');
    const list = this.candidates(ov);
    if (!list.length) return;
    const cur = document.activeElement as HTMLElement | null;
    if (!cur || !ov.contains(cur) || cur === document.body) {
      list[0].focus({ focusVisible: true } as FocusOptions);
      return;
    }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of list) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const bx = b.left + b.width / 2;
      const by = b.top + b.height / 2;
      const dx = bx - ax;
      const dy = by - ay;
      const primary = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
      const secondary = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      if (primary <= 2) continue;
      // left/right only moves within the same row
      const sameRow = Math.abs(dy) < Math.max(a.height, b.height) * 0.6;
      const horizontal = dir === 'left' || dir === 'right';
      if (horizontal && !sameRow) continue;
      const score = primary + secondary * 2.2;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) {
      best.focus({ focusVisible: true } as FocusOptions);
      best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  private onKey(e: KeyboardEvent) {
    const ov = this.active();
    if (!ov) return;
    const t = e.target as HTMLElement;
    const typing = t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && ['text', 'number', 'search'].includes(t.type));
    const dirs: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    if (e.key === 'Escape') {
      if (typing) {
        t.blur();
        e.preventDefault();
        return;
      }
      if (ov.id === 'garage') {
        e.preventDefault();
        this.back('garage');
      }
      return; // pause/resume is handled by the game's own Esc handling
    }
    if (typing) return;
    const range = t instanceof HTMLInputElement && t.type === 'range';
    const dir = dirs[e.key];
    if (dir && !(range && (dir === 'left' || dir === 'right'))) {
      e.preventDefault();
      e.stopPropagation();
      this.move(dir);
      return;
    }
    if (e.key === 'Tab') document.body.classList.add('nav-active');
    if (e.key === 'Enter' || e.key === ' ') {
      document.body.classList.add('nav-active');
      // nothing focused yet: Enter starts the default action of this menu
      if (!ov.contains(document.activeElement) || document.activeElement === document.body) {
        e.preventDefault();
        ov.querySelector<HTMLElement>('[data-default]')?.click();
      } else if (t instanceof HTMLInputElement && t.type === 'checkbox' && e.key === 'Enter') {
        e.preventDefault();
        t.click();
      }
      // otherwise the browser's native button activation handles it
      e.stopPropagation();
    }
  }

  /** Gamepad menu control; call once per frame. */
  pollGamepad(dt: number) {
    const ov = this.active();
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let p: Gamepad | null = null;
    for (const g of pads) if (g && g.connected) p = g;
    if (!p) return;
    const b = p.buttons.map((x) => x.pressed);
    const edge = (i: number) => b[i] && !this.padPrev[i];
    if (ov) {
      if (edge(12)) this.move('up');
      if (edge(13)) this.move('down');
      if (edge(14)) this.move('left');
      if (edge(15)) this.move('right');
      // left stick with auto-repeat
      const ax = p.axes[0] ?? 0;
      const ay = p.axes[1] ?? 0;
      const sd: Dir | null = Math.abs(ax) > 0.6 || Math.abs(ay) > 0.6 ? (Math.abs(ax) > Math.abs(ay) ? (ax > 0 ? 'right' : 'left') : ay > 0 ? 'down' : 'up') : null;
      if (sd !== this.stickDir) {
        this.stickDir = sd;
        this.stickRepeat = 0.35;
        if (sd) this.move(sd);
      } else if (sd) {
        this.stickRepeat -= dt;
        if (this.stickRepeat <= 0) {
          this.stickRepeat = 0.14;
          this.move(sd);
        }
      }
      if (edge(0)) {
        document.body.classList.add('nav-active');
        const cur = document.activeElement as HTMLElement | null;
        if (cur && ov.contains(cur) && cur !== document.body) cur.click();
        else ov.querySelector<HTMLElement>('[data-default]')?.click();
      }
      if (edge(1) && (ov.id === 'garage' || ov.id === 'pause')) this.back(ov.id);
    }
    this.padPrev = b;
  }
}
