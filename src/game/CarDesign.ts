// Car customization: the allowlist of supported parts, validation, and local persistence.
// Everything that reaches the renderer goes through validateDesign(), so any source
// (UI, saved data, the local design assistant, or a future server-side AI endpoint)
// can only ever produce values from these lists.

export const BODY_STYLES = ['striker', 'viper', 'brute', 'wedge'] as const;
export const FINISHES = ['gloss', 'metallic', 'matte', 'pearl', 'chrome'] as const;
export const WHEEL_STYLES = ['sport5', 'turbine', 'mesh', 'classic', 'tri'] as const;
export const RIM_COLORS = ['silver', 'black', 'gold', 'white', 'gunmetal', 'red', 'blue', 'bronze'] as const;
export const SPOILERS = ['none', 'ducktail', 'wing', 'gt'] as const;
export const DECALS = ['none', 'stripes', 'flames', 'lightning', 'number', 'camo', 'split'] as const;
export const BOOST_COLORS = ['team', 'blue', 'red', 'green', 'purple', 'gold', 'white', 'pink', 'rainbow'] as const;
export const TRAILS = ['flame', 'plasma', 'sparkle'] as const;
export const HEADLIGHTS = ['white', 'warm', 'ice', 'off'] as const;
export const UNDERGLOWS = ['none', 'team', 'blue', 'pink', 'green', 'gold', 'white'] as const;
export const TOPPERS = ['none', 'antenna', 'lightbar', 'scoop'] as const;

export type BodyStyle = (typeof BODY_STYLES)[number];
export type Finish = (typeof FINISHES)[number];
export type WheelStyle = (typeof WHEEL_STYLES)[number];
export type RimColor = (typeof RIM_COLORS)[number];
export type Spoiler = (typeof SPOILERS)[number];
export type Decal = (typeof DECALS)[number];
export type BoostColor = (typeof BOOST_COLORS)[number];
export type Trail = (typeof TRAILS)[number];
export type Headlight = (typeof HEADLIGHTS)[number];
export type Underglow = (typeof UNDERGLOWS)[number];
export type Topper = (typeof TOPPERS)[number];

export interface CarDesign {
  body: BodyStyle;
  primary: string; // #rrggbb
  secondary: string; // #rrggbb
  finish: Finish;
  wheel: WheelStyle;
  rim: RimColor;
  spoiler: Spoiler;
  decal: Decal;
  number: number; // 0-99, used by the "number" decal
  boost: BoostColor;
  trail: Trail;
  headlights: Headlight;
  underglow: Underglow;
  topper: Topper;
}

export const DEFAULT_DESIGN: CarDesign = {
  body: 'striker',
  primary: '#2f8cff',
  secondary: '#f2f5fa',
  finish: 'metallic',
  wheel: 'sport5',
  rim: 'silver',
  spoiler: 'wing',
  decal: 'stripes',
  number: 7,
  boost: 'team',
  trail: 'flame',
  headlights: 'white',
  underglow: 'none',
  topper: 'none',
};

/** Human-readable labels for the garage UI. */
export const LABELS: Record<string, string> = {
  striker: 'Striker',
  viper: 'Viper',
  brute: 'Brute',
  wedge: 'Wedge',
  gloss: 'Gloss',
  metallic: 'Metallic',
  matte: 'Matte',
  pearl: 'Pearl',
  chrome: 'Chrome',
  sport5: '5-Spoke',
  turbine: 'Turbine',
  mesh: 'Mesh',
  classic: 'Classic',
  tri: 'Tri-Blade',
  none: 'None',
  ducktail: 'Ducktail',
  wing: 'Wing',
  gt: 'GT Wing',
  stripes: 'Stripes',
  flames: 'Flames',
  lightning: 'Lightning',
  number: 'Race Number',
  camo: 'Digital Camo',
  split: 'Two-Tone',
  team: 'Team',
  flame: 'Flame',
  plasma: 'Plasma',
  sparkle: 'Sparkle',
  white: 'White',
  warm: 'Warm',
  ice: 'Ice Blue',
  off: 'Off',
  antenna: 'Antenna',
  lightbar: 'Light Bar',
  scoop: 'Hood Scoop',
  rainbow: 'Rainbow',
};

export const RIM_HEX: Record<RimColor, number> = {
  silver: 0xc4cad4,
  black: 0x1a1c22,
  gold: 0xd9a925,
  white: 0xf2f2f2,
  gunmetal: 0x50555f,
  red: 0xd92b2b,
  blue: 0x2f6fff,
  bronze: 0xa86b32,
};

/** Boost flame colors: [core, outer]. `team` and `rainbow` are resolved at render time. */
export const BOOST_HEX: Record<Exclude<BoostColor, 'team' | 'rainbow'>, [number, number]> = {
  blue: [0xe6f3ff, 0x2a7bff],
  red: [0xfff0e0, 0xff2a1a],
  green: [0xf0ffe8, 0x2fe05a],
  purple: [0xf6e8ff, 0xa040ff],
  gold: [0xfffbe0, 0xffb020],
  white: [0xffffff, 0xb8c8e0],
  pink: [0xfff0f8, 0xff3fa8],
};

export const GLOW_HEX: Record<Exclude<Underglow, 'none' | 'team'>, number> = {
  blue: 0x2a7bff,
  pink: 0xff3fa8,
  green: 0x2fe05a,
  gold: 0xffb020,
  white: 0xe8f0ff,
};

export const HEADLIGHT_HEX: Record<Exclude<Headlight, 'off'>, number> = {
  white: 0xf2f8ff,
  warm: 0xffd9a0,
  ice: 0x9fd8ff,
};

const HEX_RE = /^#[0-9a-f]{6}$/i;

function pick<T extends string>(list: readonly T[], v: unknown, fallback: T): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Coerce any input into a valid design. Unknown or malformed fields fall back to defaults. */
export function validateDesign(input: unknown, base: CarDesign = DEFAULT_DESIGN): CarDesign {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const hex = (v: unknown, fb: string) => (typeof v === 'string' && HEX_RE.test(v) ? v.toLowerCase() : fb);
  const num = Number(o.number);
  return {
    body: pick(BODY_STYLES, o.body, base.body),
    primary: hex(o.primary, base.primary),
    secondary: hex(o.secondary, base.secondary),
    finish: pick(FINISHES, o.finish, base.finish),
    wheel: pick(WHEEL_STYLES, o.wheel, base.wheel),
    rim: pick(RIM_COLORS, o.rim, base.rim),
    spoiler: pick(SPOILERS, o.spoiler, base.spoiler),
    decal: pick(DECALS, o.decal, base.decal),
    number: Number.isInteger(num) && num >= 0 && num <= 99 ? num : base.number,
    boost: pick(BOOST_COLORS, o.boost, base.boost),
    trail: pick(TRAILS, o.trail, base.trail),
    headlights: pick(HEADLIGHTS, o.headlights, base.headlights),
    underglow: pick(UNDERGLOWS, o.underglow, base.underglow),
    topper: pick(TOPPERS, o.topper, base.topper),
  };
}

const STORAGE_KEY = 'racecraft.design.v1';

export function loadDesign(): CarDesign {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return validateDesign(JSON.parse(raw));
  } catch {
    /* storage blocked or corrupt: use defaults */
  }
  return { ...DEFAULT_DESIGN };
}

export function saveDesign(d: CarDesign): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(validateDesign(d)));
    return true;
  } catch {
    return false;
  }
}

/** A plausible random design for bots, tinted toward their team color so teams stay readable. */
export function botDesign(team: 0 | 1, seed: number): CarDesign {
  let x = (seed * 9301 + 49297) % 233280;
  const rnd = () => {
    x = (x * 9301 + 49297) % 233280;
    return x / 233280;
  };
  const r = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)];
  const primaries = team === 0 ? ['#2f8cff', '#1f5fd0', '#3aa0ff', '#2468e0'] : ['#ff8a1e', '#ff6a10', '#ffa030', '#e86a12'];
  return validateDesign({
    body: r(BODY_STYLES),
    primary: r(primaries),
    secondary: r(['#f2f5fa', '#15171d', '#c4cad4', '#ffd23a']),
    finish: r(['gloss', 'metallic', 'pearl']),
    wheel: r(WHEEL_STYLES),
    rim: r(['silver', 'black', 'gunmetal', 'white']),
    spoiler: r(SPOILERS),
    decal: r(['none', 'stripes', 'flames', 'lightning', 'number', 'split']),
    number: Math.floor(rnd() * 99) + 1,
    boost: 'team',
    trail: 'flame',
    headlights: 'white',
    underglow: 'none',
    topper: r(['none', 'none', 'antenna', 'lightbar']),
  });
}
