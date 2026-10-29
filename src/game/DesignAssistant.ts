// Dream-car design assistant.
//
// LocalDesignProvider turns a free-text description into a CarDesign using keyword
// extraction and sensible defaults. It runs entirely in the browser and is NOT an AI model.
//
// RemoteDesignProvider is the hook for a real AI service later: it POSTs the prompt to
// YOUR OWN server endpoint (set VITE_DESIGN_API_URL at build time). That server holds the
// API key and calls the model; the browser never sees a key. Whatever comes back is treated
// as untrusted data and passed through validateDesign(), exactly like local results.
// Generated text is never executed.

import {
  BODY_STYLES,
  CarDesign,
  DECALS,
  FINISHES,
  HEADLIGHTS,
  LABELS,
  RIM_COLORS,
  SPOILERS,
  TOPPERS,
  TRAILS,
  UNDERGLOWS,
  WHEEL_STYLES,
  validateDesign,
  type BoostColor,
  type RimColor,
  type Underglow,
} from './CarDesign';

export interface DesignResult {
  design: CarDesign;
  /** What the provider understood, one line per part, shown to the player. */
  summary: { part: string; value: string; from: string }[];
  notes: string[];
  source: 'local' | 'remote';
}

export interface DesignProvider {
  readonly label: string;
  readonly isAI: boolean;
  generate(prompt: string, variation: number): Promise<DesignResult>;
}

// ---------------------------------------------------------------------------
// Vocabulary

/** Color words → hex. Multi-word names are matched before single words. */
const COLORS: Record<string, string> = {
  'electric blue': '#1e7bff',
  'royal blue': '#2443c9',
  'sky blue': '#6cc4ff',
  'baby blue': '#9fd2ff',
  'navy blue': '#14244f',
  'neon green': '#39ff5a',
  'lime green': '#7be82a',
  'forest green': '#1f6a33',
  'hot pink': '#ff3fa8',
  'neon pink': '#ff3fd2',
  'blood red': '#a8101a',
  'fire red': '#ff2a1a',
  'candy red': '#d1121f',
  'neon yellow': '#e9ff2a',
  'gun metal': '#50555f',
  'off white': '#ece9e1',
  black: '#121318',
  white: '#f2f4f7',
  silver: '#c4cad4',
  chrome: '#c4cad4',
  grey: '#80868f',
  gray: '#80868f',
  graphite: '#3a3e46',
  gunmetal: '#50555f',
  red: '#e0242c',
  crimson: '#b5121e',
  scarlet: '#ff2a1a',
  maroon: '#6a0f1a',
  orange: '#ff7a1a',
  tangerine: '#ff8f2a',
  yellow: '#ffd21f',
  gold: '#d9a925',
  golden: '#d9a925',
  bronze: '#a86b32',
  copper: '#b8642e',
  green: '#2fbf4a',
  lime: '#7be82a',
  emerald: '#0f9d58',
  mint: '#8ff0c4',
  olive: '#6b7a2a',
  teal: '#14a3a0',
  cyan: '#22d3ee',
  turquoise: '#2ad4c4',
  aqua: '#2ad4e0',
  blue: '#2f6fff',
  navy: '#14244f',
  cobalt: '#1f4fd0',
  purple: '#8a3cff',
  violet: '#7a3cff',
  lavender: '#b9a2ff',
  magenta: '#e0219a',
  pink: '#ff5fb4',
  brown: '#6b4428',
  beige: '#d9c7a3',
  cream: '#f0e6cc',
  midnight: '#0e1430',
};
const COLOR_NAMES = Object.keys(COLORS).sort((a, b) => b.length - a.length);

/** Map a color word to the closest supported rim / boost / underglow option. */
function rimFor(c: string): RimColor | null {
  if (/gold|golden|yellow/.test(c)) return 'gold';
  if (/black|midnight|graphite/.test(c)) return 'black';
  if (/silver|chrome|white|off white/.test(c)) return /white/.test(c) ? 'white' : 'silver';
  if (/gun ?metal|grey|gray/.test(c)) return 'gunmetal';
  if (/red|crimson|scarlet|maroon/.test(c)) return 'red';
  if (/blue|navy|cobalt|cyan|teal|aqua|turquoise/.test(c)) return 'blue';
  if (/bronze|copper|brown|orange/.test(c)) return 'bronze';
  return null;
}
function boostFor(c: string): BoostColor | null {
  if (/rainbow|multi/.test(c)) return 'rainbow';
  if (/pink|magenta/.test(c)) return 'pink';
  if (/purple|violet|lavender/.test(c)) return 'purple';
  if (/green|lime|emerald|mint|teal/.test(c)) return 'green';
  if (/gold|yellow|orange|bronze|copper/.test(c)) return 'gold';
  if (/red|crimson|scarlet|maroon/.test(c)) return 'red';
  if (/blue|navy|cobalt|cyan|aqua|turquoise/.test(c)) return 'blue';
  if (/white|silver|grey|gray/.test(c)) return 'white';
  return null;
}
function glowFor(c: string): Underglow | null {
  const b = boostFor(c);
  if (!b || b === 'rainbow') return null;
  if (b === 'red') return 'pink';
  if (b === 'purple') return 'pink';
  return b as Underglow;
}

type Scored<T> = { value: T; words: string[] }[];

function score<T extends string>(text: string, table: [T, RegExp][]): { value: T; from: string } | null {
  const hits: Scored<T> = [];
  for (const [value, re] of table) {
    const m = text.match(new RegExp(re.source, 'g'));
    if (m) hits.push({ value, words: m });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => b.words.length - a.words.length);
  return { value: hits[0].value, from: hits[0].words.join(', ') };
}

const BODY_WORDS: [CarDesign['body'], RegExp][] = [
  ['viper', /\b(super ?car|hyper ?car|exotic|low|sleek|race ?car|racing|sports? ?car|lambo\w*|ferrari|fast|aerodynamic|slick|long)\b/],
  ['brute', /\b(truck|tank|boxy|off-?road|heavy|tough|bulky|big body|suv|monster|armou?red|brute|rugged|beefy|chunky|muscle)\b/],
  ['wedge', /\b(futuristic|future|sci-?fi|cyber\w*|wedge|space ?ship|concept|angular|sharp|stealth|tron|neon|robot\w*|alien)\b/],
  ['striker', /\b(classic|hatch\w*|balanced|compact|rally|street|everyday|octane|all-?rounder|simple|small)\b/],
];
const FINISH_WORDS: [CarDesign['finish'], RegExp][] = [
  ['matte', /\b(matte?|flat|satin|murdered[- ]out)\b/],
  ['chrome', /\b(chrome|mirror|mirrored|liquid metal)\b/],
  ['pearl', /\b(pearl\w*|iridescent|holo\w*|chameleon|color[- ]?shift\w*|opal)\b/],
  ['metallic', /\b(metallic|metal flake|candy|flake)\b/],
  ['gloss', /\b(gloss\w*|shiny|wet look|polished)\b/],
];
const WHEEL_WORDS: [CarDesign['wheel'], RegExp][] = [
  ['turbine', /\b(turbine|fan|jet|futuristic wheels|aero wheels)\b/],
  ['mesh', /\b(mesh|bbs|lattice|web)\b/],
  ['classic', /\b(classic wheels|vintage|retro|disc|dish|steelies)\b/],
  ['tri', /\b(tri|three[- ]spoke|3[- ]spoke|blade)\b/],
  ['sport5', /\b(5[- ]spoke|five[- ]spoke|sport wheels|spoke)\b/],
];
const TRAIL_WORDS: [CarDesign['trail'], RegExp][] = [
  ['plasma', /\b(plasma|laser|energy|ion|electric boost)\b/],
  ['sparkle', /\b(sparkl\w*|glitter|stars?|sparks?|stardust|magic)\b/],
  ['flame', /\b(flame|flames|fire|fiery|blaze|inferno|rocket)\b/],
];
const TOPPER_WORDS: [CarDesign['topper'], RegExp][] = [
  ['antenna', /\b(antenna|flag|aerial ball)\b/],
  ['lightbar', /\b(light ?bar|roof lights?|rally lights?|spotlights?)\b/],
  ['scoop', /\b(scoop|hood scoop|air intake|intake|blower)\b/],
];

// ---------------------------------------------------------------------------

function rng(seed: number) {
  let x = (seed * 2654435761) % 4294967296 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 100000) / 100000;
  };
}

export class LocalDesignProvider implements DesignProvider {
  readonly label = 'Local designer · keyword matching in your browser (no AI service connected)';
  readonly isAI = false;

  async generate(prompt: string, variation: number): Promise<DesignResult> {
    const text = ' ' + prompt.toLowerCase().replace(/[^a-z0-9#\s.'-]/g, ' ').replace(/\s+/g, ' ') + ' ';
    const summary: DesignResult['summary'] = [];
    const notes: string[] = [];
    const set: Partial<CarDesign> = {};
    const add = (part: string, value: string, from: string) => summary.push({ part, value: LABELS[value] ?? value, from });
    const addColor = (part: string, name: string) => summary.push({ part, value: name, from: name });

    // --- colors with context ------------------------------------------------
    // Find every color mention with its position, then look at the next few words
    // to decide which part it belongs to.
    const mentions: { name: string; at: number; end: number }[] = [];
    const taken: boolean[] = new Array(text.length).fill(false);
    for (const name of COLOR_NAMES) {
      const re = new RegExp(`(?<![a-z])${name.replace(' ', '[ -]')}(?![a-z])`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        if (taken.slice(m.index, m.index + m[0].length).some(Boolean)) continue;
        for (let i = m.index; i < m.index + m[0].length; i++) taken[i] = true;
        mentions.push({ name, at: m.index, end: m.index + m[0].length });
      }
    }
    mentions.sort((a, b) => a.at - b.at);
    const bodyColors: string[] = [];
    for (const mt of mentions) {
      // the noun this color describes: words after it, skipping other colors and "and"
      const after = text.slice(mt.end, mt.end + 48).replace(/^[\s-]*(and|&)?[\s-]*/, ' ');
      const lead = after.slice(0, 40);
      const before = text.slice(Math.max(0, mt.at - 18), mt.at);
      const hex = COLORS[mt.name];
      const nounRe = (re: RegExp) => new RegExp(`^(?:\\s*(?:${COLOR_NAMES.join('|').replace(/ /g, '[ -]')}|and|&|-|bright|dark|light|deep|neon|glowing))*\\s*(?:${re.source})`);
      if (nounRe(/rims?|wheels?|alloys?/).test(lead)) {
        const r = rimFor(mt.name);
        if (r && !set.rim) {
          set.rim = r;
          add('Rims', r, `${mt.name} rims`);
        }
      } else if (nounRe(/boost|flames?|fire|trail|exhaust|thrust/).test(lead) || /boost\s*$/.test(before)) {
        const b = boostFor(mt.name);
        if (b && !set.boost) {
          set.boost = b;
          add('Boost color', b, `${mt.name} boost`);
        }
      } else if (nounRe(/under ?glow|glow|neon|underbody/).test(lead)) {
        const g = glowFor(mt.name);
        if (g && !set.underglow) {
          set.underglow = g;
          add('Underglow', g, `${mt.name} glow`);
        }
      } else if (nounRe(/head ?lights?|lights|lamps|eyes/).test(lead)) {
        const v = /blue|cyan|ice|aqua/.test(mt.name) ? 'ice' : /yellow|gold|orange|warm/.test(mt.name) ? 'warm' : 'white';
        if (!set.headlights) {
          set.headlights = v;
          add('Headlights', v, `${mt.name} headlights`);
        }
      } else if (nounRe(/stripes?|accents?|trim|decals?|graphics?|livery|details?|wing|spoiler|calipers?/).test(lead)) {
        if (!set.secondary) {
          set.secondary = hex;
          summary.push({ part: 'Secondary paint', value: mt.name, from: `${mt.name} accents` });
        }
      } else {
        bodyColors.push(mt.name);
      }
    }
    if (bodyColors[0]) {
      set.primary = COLORS[bodyColors[0]];
      addColor('Primary paint', bodyColors[0]);
    }
    if (bodyColors[1] && !set.secondary) {
      set.secondary = COLORS[bodyColors[1]];
      addColor('Secondary paint', bodyColors[1]);
    }

    // --- shape and parts --------------------------------------------------
    const partless = text
      .replace(/\b[a-z-]+ (rims?|wheels?|alloys?)\b/g, ' ')
      .replace(/\bracing (stripes?|number)\b/g, ' ')
      .replace(/\b(head ?lights?|under ?glow)\b/g, ' ');
    const body = score(partless, BODY_WORDS);
    if (body) {
      set.body = body.value;
      add('Body', body.value, body.from);
    }
    const finish = score(partless, FINISH_WORDS);
    if (finish) {
      set.finish = finish.value;
      add('Finish', finish.value, finish.from);
    }
    const wheel = score(text, WHEEL_WORDS);
    if (wheel) {
      set.wheel = wheel.value;
      add('Wheels', wheel.value, wheel.from);
    }
    if (/\bno (spoiler|wing)|without (a )?(spoiler|wing)|wingless\b/.test(text)) {
      set.spoiler = 'none';
      add('Spoiler', 'none', 'no spoiler');
    } else if (/\b(large|big|huge|massive|giant|tall|gt|racing) (rear )?(wing|spoiler)|gt wing|swan ?neck\b/.test(text)) {
      set.spoiler = 'gt';
      add('Spoiler', 'gt', 'large rear wing');
    } else if (/\b(duck ?tail|lip spoiler|subtle spoiler|small spoiler|lip)\b/.test(text)) {
      set.spoiler = 'ducktail';
      add('Spoiler', 'ducktail', 'small spoiler');
    } else if (/\b(wing|spoiler)\b/.test(text)) {
      set.spoiler = 'wing';
      add('Spoiler', 'wing', 'wing');
    }

    // decals ("boost flames" describes the boost, not the paint job)
    const decalText = text.replace(/\b(boost|exhaust|thrust)\s+(flames?|fire)\b/g, ' ').replace(/(flames?|fire)\s+(boost|trail|exhaust)/g, ' ');
    const numMatch = text.match(/(?:number|no\.?|#)\s*(\d{1,2})\b/);
    if (/\b(no|without) (decals?|graphics|stripes|livery)|\bclean (look|paint)\b/.test(text)) {
      set.decal = 'none';
      add('Decal', 'none', 'clean');
    } else if (numMatch || /\brace number|racing number\b/.test(text)) {
      set.decal = 'number';
      if (numMatch) set.number = Math.min(99, parseInt(numMatch[1], 10));
      add('Decal', 'number', numMatch ? `#${numMatch[1]}` : 'race number');
    } else {
      const decal = score(decalText, [
        ['flames', /\b(flames?|fire|hot ?rod)\b/],
        ['stripes', /\b(stripes?|striped|racing stripes?|pinstripes?)\b/],
        ['lightning', /\b(lightning|bolts?|thunder|zigzag)\b/],
        ['camo', /\b(camo\w*|military|army|digital pattern)\b/],
        ['split', /\b(two[- ]tone|split|dual[- ]tone|half)\b/],
      ] as [CarDesign['decal'], RegExp][]);
      if (decal) {
        set.decal = decal.value;
        add('Decal', decal.value, decal.from);
      }
    }

    const trail = score(text.replace(/\b(flames?|fire) (decals?|paint|livery|job)\b/g, ' '), TRAIL_WORDS);
    if (trail && /boost|trail|flame|plasma|spark|exhaust|thrust|energy|laser|fire|rocket/.test(text)) {
      set.trail = trail.value;
      add('Boost trail', trail.value, trail.from);
    }
    if (/\brainbow\b/.test(text) && !set.boost) {
      set.boost = 'rainbow';
      add('Boost color', 'rainbow', 'rainbow');
    }
    if (/\b(no|without) (head ?lights|lights)|lights off|blacked[- ]out lights\b/.test(text)) {
      set.headlights = 'off';
      add('Headlights', 'off', 'lights off');
    }
    if (/\bunder ?glow|neon underbody|glow underneath\b/.test(text) && !set.underglow) {
      set.underglow = 'team';
      add('Underglow', 'team', 'underglow');
    }
    const topper = score(text, TOPPER_WORDS);
    if (topper) {
      set.topper = topper.value;
      add('Accessory', topper.value, topper.from);
    }

    // --- defaults for anything not mentioned ------------------------------
    // variation 0 = themed defaults; higher variations remix the unspecified parts.
    const r = rng(variation * 7919 + prompt.length * 31 + 1);
    const pick = <T>(list: readonly T[]) => list[Math.floor(r() * list.length)];
    const style = set.body ?? (variation ? pick(BODY_STYLES) : 'striker');
    const themed: Partial<CarDesign> = {
      striker: { wheel: 'sport5', spoiler: 'wing', trail: 'flame', finish: 'metallic' },
      viper: { wheel: 'mesh', spoiler: 'ducktail', trail: 'flame', finish: 'gloss' },
      brute: { wheel: 'classic', spoiler: 'none', trail: 'flame', finish: 'matte' },
      wedge: { wheel: 'turbine', spoiler: 'wing', trail: 'plasma', finish: 'pearl' },
    }[style] as Partial<CarDesign>;
    const primary = set.primary ?? (variation ? pick(['#2f8cff', '#e0242c', '#121318', '#f2f4f7', '#ffd21f', '#2fbf4a', '#8a3cff']) : '#2f8cff');
    const contrast = (hex: string) => {
      const c = parseInt(hex.slice(1), 16);
      const lum = ((c >> 16) & 255) * 0.3 + ((c >> 8) & 255) * 0.59 + (c & 255) * 0.11;
      return lum > 140 ? '#121318' : '#f2f4f7';
    };
    const design: Partial<CarDesign> = {
      body: style,
      primary,
      secondary: set.secondary ?? (variation ? pick(['#f2f4f7', '#121318', '#d9a925', '#22d3ee', '#ff7a1a']) : contrast(primary)),
      finish: set.finish ?? (variation ? pick(FINISHES) : themed.finish),
      wheel: set.wheel ?? (variation ? pick(WHEEL_STYLES) : themed.wheel),
      rim: set.rim ?? (variation ? pick(RIM_COLORS) : 'silver'),
      spoiler: set.spoiler ?? (variation ? pick(SPOILERS) : themed.spoiler),
      decal: set.decal ?? (variation ? pick(DECALS) : 'stripes'),
      number: set.number ?? (variation ? Math.floor(r() * 99) + 1 : 7),
      boost: set.boost ?? 'team',
      trail: set.trail ?? (variation ? pick(TRAILS) : themed.trail),
      headlights: set.headlights ?? (variation ? pick(HEADLIGHTS.filter((h) => h !== 'off')) : 'white'),
      underglow: set.underglow ?? (variation ? pick(UNDERGLOWS) : 'none'),
      topper: set.topper ?? (variation ? pick(TOPPERS) : 'none'),
    };

    if (!summary.length) notes.push('No recognizable car words found, so this is a default design. Try colors, "supercar", "matte", "gold rims", "big wing"…');
    else {
      const missing = (['body', 'primary', 'wheel', 'spoiler', 'decal'] as const).filter((k) => set[k] === undefined);
      if (missing.length) notes.push(`Not specified, filled in ${variation ? 'with a random remix' : 'with matching defaults'}: ${missing.map((k) => (k === 'primary' ? 'paint' : k)).join(', ')}.`);
    }
    if (/\b(doors?|convertible|engine|interior|seats?|tint(ed)?|carbon fiber|wheel size|bigger wheels|lowered|lift kit)\b/.test(text)) {
      notes.push('Some details (like doors, interior or engine) are not customizable parts yet and were skipped.');
    }
    return { design: validateDesign(design), summary, notes, source: 'local' };
  }
}

/**
 * Calls your own server endpoint, which in turn calls an AI model with a key kept server-side.
 * Expected response JSON: { design: Partial<CarDesign>, summary?: [...], notes?: string[] }.
 * The response is validated against the allowlists before use.
 */
export class RemoteDesignProvider implements DesignProvider {
  readonly isAI = true;
  constructor(
    private endpoint: string,
    readonly label = 'AI designer (server endpoint)',
  ) {}

  async generate(prompt: string, variation: number): Promise<DesignResult> {
    const allowed = { body: BODY_STYLES, finish: FINISHES, wheel: WHEEL_STYLES, rim: RIM_COLORS, spoiler: SPOILERS, decal: DECALS, trail: TRAILS, headlights: HEADLIGHTS, underglow: UNDERGLOWS, topper: TOPPERS };
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt.slice(0, 600), variation, allowed }),
    });
    if (!res.ok) throw new Error(`Design service returned ${res.status}`);
    const data = (await res.json()) as { design?: unknown; summary?: unknown; notes?: unknown };
    const summary = Array.isArray(data.summary)
      ? data.summary
          .filter((s): s is { part: string; value: string; from: string } => !!s && typeof s === 'object')
          .map((s) => ({ part: String(s.part).slice(0, 40), value: String(s.value).slice(0, 40), from: String(s.from ?? '').slice(0, 60) }))
          .slice(0, 16)
      : [];
    const notes = Array.isArray(data.notes) ? data.notes.map((n) => String(n).slice(0, 200)).slice(0, 4) : [];
    return { design: validateDesign(data.design), summary, notes, source: 'remote' };
  }
}

/** Remote provider only when a server endpoint is configured at build time; otherwise local. */
export function createDesignProvider(): DesignProvider {
  const url = (import.meta.env.VITE_DESIGN_API_URL as string | undefined)?.trim();
  return url ? new RemoteDesignProvider(url) : new LocalDesignProvider();
}
