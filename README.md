# Racecraft

Rocket League–style 3D car soccer that runs in the browser. Built with Vite, TypeScript, Three.js and Rapier (`@dimforge/rapier3d-compat`). No paid assets or services: every model, texture and sound is generated in code.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
```

## Deploy (Cloudflare Workers, free plan)

The game and its multiplayer server deploy together as one Worker (`wrangler.jsonc`):

- Build command: `npx vite build --base=./`
- Deploy command: `npx wrangler deploy`

In the Cloudflare dashboard (*Workers & Pages → your Worker → Settings → Build*), connect this GitHub repository; every push to `main` then redeploys. Durable Objects with SQLite storage are included in the Workers Free plan.

Local development: run `npm run dev:api` (the Worker on port 8787) and `npm run dev` (Vite on 5173, which proxies `/api` to the Worker).

## Modes

- **Play vs bots**: 1v1 or 2v2 (you and a bot teammate against two bots), Rookie / Pro / All-Star.
- **Play online**: see below.

## Controls

Two keyboard schemes (pick one on the main menu); gamepads always use Rocket League's default layout.

| Action | Rocket League (default, mouse + keyboard) | Keyboard only | Gamepad |
| --- | --- | --- | --- |
| Throttle / reverse | W / S | W / S | RT / LT |
| Steer · yaw in the air | A / D | A / D | Left stick |
| Pitch in the air | W / S | W / S | Left stick |
| Jump · double jump · flip (jump + direction) | Right mouse | Space | A |
| Boost | Left mouse | Shift | B |
| Powerslide · free air roll (+ A/D) | Left Shift | C | X |
| Air roll left / right | Q / E | Q / E | LB / RB |
| Ball cam on / off | Space | Y | Y |
| Scoreboard (hold) | Tab | Tab | Back / View |
| Look around | | | Right stick |
| Camera distance | [ ] or mouse wheel | [ ] | |
| Pause | Esc | Esc | Start |

Menus work without a mouse: arrow keys / D-pad to move, Enter / A to select, Esc / B to go back.

## Online play

**Play Online** on the main menu:

- **Quick Play**: 1v1 or 2v2 matchmaking. In 2v2, bots fill empty seats after 20 seconds.
- **Private room**: create a 1v1 or 2v2 room and share its 5-letter code; friends join with the code, pick sides, and the host starts (empty seats become bots).
- **Teams**: create a team (you get a 6-letter team code) or join one with a code. When two teammates have the Teams tab open, **Find team battle** matches you against another team in a 2v2. Results change the team rating.
- **Leaderboard**: top players (MMR, Elo-based, starts at 1000) and top teams. Only online matches count.

Players are anonymous: the browser stores a random player id and secret token (`racecraft.identity.v1` in localStorage). Clearing site data creates a new player.

### How the netcode works

- Each player simulates their own car locally (no input lag) and streams its state 20 times a second.
- One player per match is the host: their browser runs the ball, score, clock, boost pads, demos and bots, and streams the world 20 times a second. Other players' cars are drawn 0.1 s in the past and interpolated.
- When you touch the ball, your client reports the touch to the host immediately, so dribbles and shots feel responsive; between touches your ball is gently corrected toward the host's.
- If the host leaves mid-match, the match ends for everyone (no result is recorded).
- The server (`worker/`) is a Cloudflare Worker with two Durable Objects: `Lobby` (players, teams, leaderboard, matchmaking, stored in SQLite) and `Room` (one per match; relays messages, only lets the host send host-only messages, and reports results using its own roster so names can't be faked).

## World scale

1 world unit = 51.2 Rocket League units (uu). The field is 200 × 160 units (RL: 10240 × 8192 uu) with a 40-unit ceiling. Goals are 35 × 12.5 × 16 units. The car hitbox matches RL's Octane (118 × 84 × 36 uu) and the ball has RL's 92.75 uu radius. Speeds, accelerations, jump impulses, boost and the hit model are RL's values converted with the same factor (`UU` in `src/game/Config.ts`), so sizes and speeds stay consistent with each other.

## Garage

Open **Garage** from the main menu. Every option changes the rendered car:

- Body style: Striker, Viper, Brute, Wedge. All four share the same physics hitbox.
- Primary and secondary paint (swatches or any custom color)
- Paint finish: gloss, metallic, matte, pearl, chrome
- Rim design (5) and rim color (8)
- Spoiler: none, ducktail, wing, GT wing
- Decals: stripes, flames, lightning, race number, digital camo, two-tone
- Boost color (9, including team and rainbow) and boost trail (flame, plasma, sparkle)
- Headlights, underglow, and an accessory (antenna, light bar, hood scoop)

**Save & Equip** stores the design in the browser's `localStorage` (`racecraft.design.v1`). Your match car then uses it. Bots get random designs in their team's colors, and every car has a team-colored side strip.

### Dream Car Designer

Type a description, for example: *"futuristic black-and-electric-blue supercar with gold rims, a low body, a large rear wing, and bright blue boost flames."*

- **Generate** interprets the text and previews the design on the turntable.
- **Regenerate** keeps what you asked for and remixes the parts you didn't mention.
- **Preview** shows the generated design again after manual edits.
- **Apply to car** saves it and equips it.

The built-in designer is **not an AI model**. It is a local keyword parser (`src/game/DesignAssistant.ts`): color words are matched with their context ("gold rims", "blue boost"), along with style, finish, wheel, spoiler, decal and accessory keywords. It needs no network access and no API key. Every result goes through `validateDesign()` (`src/game/CarDesign.ts`), which only accepts values from the allowlists. Generated text is never executed.

#### Connecting a real AI model later

The client already supports a server endpoint. API keys must stay on a server and never go in client code.

1. Build a small server endpoint (for example `POST /api/design`). It receives:
   ```json
   { "prompt": "…", "variation": 0, "allowed": { "body": ["striker", "viper", "brute", "wedge"], "finish": ["…"], "…": [] } }
   ```
   It calls the AI model with the key from its own environment, and returns:
   ```json
   { "design": { "body": "viper", "primary": "#121318", "secondary": "#1e7bff", "…": "…" },
     "summary": [{ "part": "Body", "value": "Viper", "from": "low supercar" }],
     "notes": ["…"] }
   ```
2. Build the client with `VITE_DESIGN_API_URL=https://your-server/api/design npm run build`.

`createDesignProvider()` then switches to `RemoteDesignProvider`. Its response is still validated against the allowlists, so the model can only pick supported parts.

## Code layout

- `src/main.ts`: boot, renderer, menus, pause/settings, and the render loop
- `src/game/Config.ts`: world scale and tuning constants
- `src/game/Arena.ts`: arena SDF and colliders, field, boost pads, stadium, futuristic goals
- `src/game/Car.ts`: car physics (suspension, drive, boost, jumps, flips, air control, wall grip) and network interpolation for remote cars
- `src/game/CarModel.ts`: procedural car models (4 body styles, fender pods, decals, wheels, lights)
- `src/game/CarDesign.ts`, `Garage.ts`, `DesignAssistant.ts`: garage, customization and the Dream Car Designer
- `src/game/Ball.ts`: ball, Rocket League hit model, dribble assist, path prediction
- `src/game/AI.ts`: bots
- `src/game/Match.ts`: match flow, offline and online (host / client roles)
- `src/game/Camera.ts`, `HUD.ts`, `Input.ts`, `MenuNav.ts`, `Audio.ts`, `Particles.ts`
- `src/net/protocol.ts`, `src/net/api.ts`: shared message types and the client API
- `src/ui/Online.ts`: online menu (quick play, rooms, teams, leaderboard)
- `worker/`: Cloudflare Worker (`index.ts`), `Lobby` and `Room` Durable Objects

Physics runs at a fixed 120 Hz step, and rendering interpolates between steps.
