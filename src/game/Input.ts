export interface Controls {
  throttle: number; // -1..1
  steer: number; // -1..1 (+ = right)
  pitch: number; // -1..1 (+ = nose down / stick forward)
  yaw: number; // -1..1 (+ = right)
  roll: number; // -1..1 (+ = roll right)
  jump: boolean;
  boost: boolean;
  handbrake: boolean;
}

export function emptyControls(): Controls {
  return { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };
}

/**
 * Control schemes.
 * - 'rl': Rocket League's default PC (mouse + keyboard) bindings.
 * - 'keyboard': everything on the keyboard, for playing without a mouse.
 * Gamepads always use Rocket League's default controller layout.
 */
export type Scheme = 'rl' | 'keyboard';

interface Binding {
  jump: string[];
  boost: string[];
  slide: string[]; // powerslide + free air roll
  rollLeft: string[];
  rollRight: string[];
  ballcam: string[];
  scoreboard: string[];
}

const MOUSE_LEFT = 'Mouse0';
const MOUSE_RIGHT = 'Mouse2';

const BINDINGS: Record<Scheme, Binding> = {
  rl: {
    jump: [MOUSE_RIGHT],
    boost: [MOUSE_LEFT],
    slide: ['ShiftLeft'],
    rollLeft: ['KeyQ'],
    rollRight: ['KeyE'],
    ballcam: ['Space'],
    scoreboard: ['Tab'],
  },
  keyboard: {
    jump: ['Space', 'KeyJ'],
    boost: ['ShiftLeft', 'ShiftRight', 'KeyK'],
    slide: ['KeyC', 'ControlLeft'],
    rollLeft: ['KeyQ'],
    rollRight: ['KeyE'],
    ballcam: ['KeyY'],
    scoreboard: ['Tab'],
  },
};

/** Human-readable guide for a scheme (used by the HUD and menus). */
export function controlGuide(scheme: Scheme, gamepad: boolean): [string, string][] {
  if (gamepad)
    return [
      ['RT / LT', 'Drive · Reverse'],
      ['L-Stick', 'Steer · Air control'],
      ['A', 'Jump · Flip'],
      ['B', 'Boost'],
      ['X', 'Powerslide · Air roll'],
      ['LB / RB', 'Air roll L / R'],
      ['Y', 'Ball cam'],
      ['R-Stick', 'Look around'],
    ];
  if (scheme === 'rl')
    return [
      ['W / S', 'Drive · Reverse'],
      ['A / D', 'Steer'],
      ['R-Click', 'Jump · Flip'],
      ['L-Click', 'Boost'],
      ['L-Shift', 'Powerslide · Air roll'],
      ['Q / E', 'Air roll L / R'],
      ['Space', 'Ball cam'],
      ['Tab', 'Scoreboard'],
    ];
  return [
    ['W / S', 'Drive · Reverse'],
    ['A / D', 'Steer'],
    ['Space', 'Jump · Flip'],
    ['Shift', 'Boost'],
    ['C', 'Powerslide · Air roll'],
    ['Q / E', 'Air roll L / R'],
    ['Y', 'Ball cam'],
    ['Tab', 'Scoreboard'],
  ];
}

const SCHEME_KEY = 'racecraft.controls';
export function loadScheme(): Scheme {
  try {
    const v = localStorage.getItem(SCHEME_KEY);
    if (v === 'rl' || v === 'keyboard') return v;
  } catch {
    /* ignore */
  }
  return 'rl';
}

const DEADZONE = 0.15;
function dz(v: number) {
  if (Math.abs(v) < DEADZONE) return 0;
  return (Math.sign(v) * (Math.abs(v) - DEADZONE)) / (1 - DEADZONE);
}

/** Keyboard + mouse + Gamepad API input. */
export class Input {
  private keys = new Set<string>();
  private pressedOnce = new Set<string>();
  private padPrev: boolean[] = [];
  usingGamepad = false;
  scheme: Scheme = loadScheme();
  /** True while the scoreboard key is held. */
  scoreboardHeld = false;

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (e.ctrlKey && ['KeyS', 'KeyD', 'KeyA', 'KeyR', 'KeyQ', 'KeyE'].includes(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressedOnce.add(e.code);
      this.keys.add(e.code);
      this.usingGamepad = false;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement)?.closest?.('button, input, textarea, .menu, .garage, .online')) return;
      const code = `Mouse${e.button}`;
      if (!this.keys.has(code)) this.pressedOnce.add(code);
      this.keys.add(code);
      this.usingGamepad = false;
    });
    window.addEventListener('mouseup', (e) => this.keys.delete(`Mouse${e.button}`));
    window.addEventListener('contextmenu', (e) => {
      if (!(e.target as HTMLElement)?.closest?.('input, textarea')) e.preventDefault();
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if ((e.target as HTMLElement)?.closest?.('.menu, .garage, .online')) return;
        this.pressedOnce.add(e.deltaY > 0 ? 'WheelDown' : 'WheelUp');
      },
      { passive: true },
    );
  }

  setScheme(s: Scheme) {
    this.scheme = s;
    try {
      localStorage.setItem(SCHEME_KEY, s);
    } catch {
      /* ignore */
    }
  }

  private pad(): Gamepad | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  private any(codes: string[]) {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  /** Edge-triggered UI actions: 'ballcam', 'pause', 'skip', ... Call once per frame. */
  consumeActions(): Set<string> {
    const out = new Set<string>();
    const b = BINDINGS[this.scheme];
    const once = (codes: string[]) => codes.some((c) => this.pressedOnce.has(c));
    if (once(b.ballcam)) out.add('ballcam');
    if (this.pressedOnce.has('Escape') || this.pressedOnce.has('KeyP')) out.add('pause');
    if (once(b.jump) || this.pressedOnce.has('Enter')) out.add('skip');
    if (this.pressedOnce.has('KeyM')) out.add('mute');
    if (this.pressedOnce.has('KeyH')) out.add('guide');
    if (this.pressedOnce.has('BracketLeft') || this.pressedOnce.has('WheelUp')) out.add('camNear');
    if (this.pressedOnce.has('BracketRight') || this.pressedOnce.has('WheelDown')) out.add('camFar');
    this.pressedOnce.clear();
    this.scoreboardHeld = this.any(b.scoreboard);
    const p = this.pad();
    if (p) {
      const pb = p.buttons.map((x) => x.pressed);
      const edge = (i: number) => pb[i] && !this.padPrev[i];
      if (edge(3)) out.add('ballcam');
      if (edge(9)) out.add('pause');
      if (edge(0)) out.add('skip');
      if (pb[8]) this.scoreboardHeld = true; // Back / View
      if (pb.some((x) => x) || p.axes.some((a) => Math.abs(a) > 0.3)) this.usingGamepad = true;
      this.padPrev = pb;
    }
    return out;
  }

  /** Right-stick camera look (x: -1..1 left/right, y: -1..1 up/down). */
  readLook(): { x: number; y: number } {
    const p = this.pad();
    if (!p) return { x: 0, y: 0 };
    return { x: dz(p.axes[2] ?? 0), y: dz(p.axes[3] ?? 0) };
  }

  read(): Controls {
    const c = emptyControls();
    const b = BINDINGS[this.scheme];
    const k = (code: string) => this.keys.has(code);
    const fwd = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
    const side = (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0);
    c.throttle = fwd;
    c.steer = side;
    c.pitch = fwd; // W = nose down in the air, like Rocket League
    c.yaw = side;
    c.jump = this.any(b.jump);
    c.boost = this.any(b.boost);
    c.handbrake = this.any(b.slide);
    // free air roll: hold powerslide and steer
    if (c.handbrake) c.roll = side;
    // directional air roll
    const rl = this.any(b.rollLeft);
    const rr = this.any(b.rollRight);
    if (rl !== rr) c.roll = rr ? 1 : -1;

    const p = this.pad();
    if (p) {
      const ax = dz(p.axes[0] ?? 0);
      const ay = dz(p.axes[1] ?? 0);
      const rt = p.buttons[7]?.value ?? 0;
      const lt = p.buttons[6]?.value ?? 0;
      const pb = (i: number) => !!p.buttons[i]?.pressed;
      const padThrottle = rt - lt;
      if (Math.abs(padThrottle) > 0.02) c.throttle = padThrottle;
      if (ax) {
        c.steer = ax;
        c.yaw = ax;
      }
      if (ay) c.pitch = -ay; // stick up = nose down
      c.jump = c.jump || pb(0);
      c.boost = c.boost || pb(1);
      const hb = pb(2);
      c.handbrake = c.handbrake || hb;
      if (hb) c.roll = ax;
      if (pb(4)) c.roll = -1; // LB air roll left
      if (pb(5)) c.roll = 1; // RB air roll right
    }
    if (c.handbrake && c.roll !== 0) c.yaw = 0;
    return c;
  }
}
