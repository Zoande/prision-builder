# Prison Builder

A prison-management sandbox rendered in the browser with **WebGPU**. You paint
construction orders onto a tile grid, receive physical supplies by truck, and
watch workmen build the prison while staff and distinct, socially connected
prisoners follow a daily regime.

Everything is hand-rolled — no game or 3D engine. The renderer is a set of small
WGSL passes; the simulation is a plain TypeScript tile world.

## Requirements

- A **WebGPU-capable browser** (Chrome/Edge 113+). The page shows an error banner
  if WebGPU is unavailable.
- **Node 22.18+ or Node 24+** — the dev scripts import `.ts` files directly and rely on Node's
  native type stripping.

## Quick start

```bash
npm ci
npm run dev      # vite dev server
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server, including the save / sim-log endpoints below. |
| `npm run build` | Typecheck (`tsc`) then bundle to `dist/`. |
| `npm run preview` | Serve the built `dist/`. |
| `npm run runtime-textures` | Rebuild committed 1K derivatives from licensed 4K sources. |
| `npm run textures` | Re-encode the compressed textures (see below). |
| `npm run check` | Simulation regressions covering construction, supplies, meals, intake, behavior, security, health, work, management, escape preparation, and saves. |
| `npm run sim-check` | Compare deterministic simulation behavior against its reviewed golden snapshot. |
| `npm run check:playthrough` | Play two seeded prisons for four days each, checking live services, needs, population, and ownership. |
| `npm run check:browser` | Use Chromium with real WebGPU to test canvas construction, catalogs, controls, saving, and responsive UI. |
| `npm run check:production` | After `npm run build`, verify bundled WebGPU rendering and catalog controls in Chromium. |
| `npm run check:ui` | Chromium component checks for care, needs, policy, work search, and institutional dashboards. |

## Controls

Camera is an orbit rig over the ground plane:

- **Left-drag with a build tool** — show a transient blue construction preview;
  release to commit one grouped order.
- **Left-click a planned ghost** — cancel every unfinished target in its group.
- **Middle-drag** — orbit, always.
- **Right-drag / WASD** — pan. **Wheel** — zoom.
- **R** — rotate the pending object. **Esc/right-click** — discard the current
  transient preview.
- **Space** — pause or resume. Keyboard shortcuts yield to text inputs.
- **Click without a tool selected** — inspect a resident, room, or fixture.

Tools live in the build palette (bottom of screen): floors, walls, fences, doors
and jail doors, furniture, logistics fixtures, staff, room painting, and access
zones. Prisoners arrive through scheduled intake rather than a normal placement
tool. Search spans every catalog category, including logistics fixtures and
specialized rooms. Room inspectors show missing requirements and link directly
to the relevant tools. Staff mode includes a searchable live duty roster.
Logistics mode opens stock, vehicles, exports, work assignments, and deployment.
Intelligence mode shows the inmate roster and information the institution has
learned; resident inspectors show welfare needs. Policy and management controls
let you adjust searches, discipline, staffing, and active procedures.
Open **Intelligence → Needs** for prison-wide urgent needs and links to affected
residents. Work assignments, deployment and access lists can be searched, and
policy fields show their names and explanations on phones.

New prisons start paused. **Getting started** links to the tools for a delivery
yard, workmen, Reception, housing, meals, and guards, and shows their current
readiness. Supply deliveries require a valid road-connected Delivery Yard and
Loading Pallet. Kitchen and library stock arrive physically and staff carry
them to their destinations; clear routes matter as much as buying furniture.

The browser check uses `/usr/bin/chromium` when available, or Playwright's
installed Chromium. Set `CHROMIUM_PATH` to use another executable; otherwise
install it with `npx playwright install chromium`. Screenshots and runtime
errors go to `/tmp/prison-builder-playtest` (override with `PLAYTEST_ARTIFACTS`).
The test supplies isolated save endpoints and never overwrites your dev save.
For a longer simulation soak:

```bash
npm run check:playthrough -- --days=12 --seeds=12345,9876,773
```

A failed soak writes its full replayable state to
`/tmp/prison-builder-playthrough/failure-<seed>.json`.

## Layout

```
src/
  main.ts          bootstrap, frame loop, HUD wiring
  editor.ts        build palette + tool selection
  camera.ts        orbit camera
  daynight.ts      sun/sky cycle
  textures.ts      texture loading entry
  math.ts          vec/mat helpers
  *.wgsl           shaders, one per pass
  render/          one module per draw pass (walls, floors, beds, people, ...)
    assets.ts      texture resolution: compressed KTX → raw fallback
    ktx.ts         KTX/BC7 container parsing
    materials.ts   material table (name → texture pair)
  sim/
    world.ts       tile grid: floors, objects, auto-roofing, rooms
    agents.ts      prisoner / guard / staff behaviour and scheduling
    construction.ts grouped plans, reservations, work and demolition
    logistics.ts   packages, manifests, trucks, pallets and exports
    economy.ts     cash, payroll, fees, grants, interest and ledger
    kitchen.ts     frozen meals, trays, spoons, washing and books
    infrastructure.ts immutable road and starter delivery yard
    intake.ts      seeded daily transports and Reception processing
    profiles.ts    deterministic identity, aptitude, personality, crime and skill generation
    social.ts      sparse relationships, conversations, cliques and sourced rumors
    escapeOperations.ts shared conspiracies, roles, supply caches and tunnel graphs
scripts/
  compress-textures.mjs   offline texture encoder
  check-roofs.ts          roof recompute check
public/textures/          runtime textures (raw + generated compressed/)
assets/textures-src/      third-party 4K sources (untracked)
```

## Textures

Two tiers, resolved at load time by [`src/render/assets.ts`](src/render/assets.ts):

1. **Compressed** — `public/textures/compressed/<name>.{1k,4k}.ktx`, raw BC7
   blocks in a KTX container, uploaded straight to the GPU. Used when the device
   reports BC support. The in-app **Quality** button picks the 1k or 4k tier.
2. **Raw** — the JPG/PNGs in `public/textures/`, capped at 1K. Used as the
   fallback when BC is unsupported or a KTX fails to load.

The raw textures are committed, so **the app runs from a fresh clone** — you just
get the uncompressed tier.

The browser-facing raw files are all at most 1K. Licensed 4K galvanized,
corroded-metal and fabric sources stay under `assets/textures-src/`; rebuild their
committed runtime derivatives with `npm run runtime-textures`.

### Regenerating the compressed tier

`npm run textures` encodes source PNG/JPG → Basis UASTC (+mips) → BC7 KTX via the
`basisu` binary from the `basis_universal` package. It is idempotent — existing
outputs are skipped unless you pass `--force`:

```bash
npm run textures -- --force
```

The 4K inputs are licensed third-party downloads (Poliigon, ambientCG), so they
are **not** in the repo — they live under `assets/textures-src/`, and the manifest
at the top of [`scripts/compress-textures.mjs`](scripts/compress-textures.mjs)
maps each one to its output. Without that folder the 4k entries can't be rebuilt;
the 1k entries re-encode from `public/textures/` alone. Encoding is slow
(UASTC level 2, near-lossless).

## Dev-server endpoints

`vite.config.mjs` adds a small middleware so the prototype can persist to disk.
Both files are gitignored local state. Production saves use browser storage;
the development endpoint mirrors version-6 autosaves for diagnostics. Earlier
versions are intentionally incompatible and can be exported before starting a
fresh prison.

| Route | Methods | File |
| --- | --- | --- |
| `/api/save` | `GET`, `POST` | `prototype-save.json` |
| `/api/sim-log` | `GET`, `POST`, `DELETE` | `sim-log.jsonl` |

These exist **only in dev** — a production `dist/` build has no server.
