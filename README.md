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
- **Node 22+** — the dev scripts import `.ts` files directly and rely on Node's
  native type stripping.

## Quick start

```bash
npm install
npm run dev      # vite dev server
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server, including the save / sim-log endpoints below. |
| `npm run build` | Typecheck (`tsc`) then bundle to `dist/`. |
| `npm run preview` | Serve the built `dist/`. |
| `npm run runtime-textures` | Rebuild committed 1K derivatives from licensed 4K sources. |
| `npm run textures` | Re-encode the compressed textures (see below). |
| `npm run check` | Run roof, stability, asset, construction, logistics, economy, kitchen, and intake checks. |

## Controls

Camera is an orbit rig over the ground plane:

- **Left-drag with a build tool** — show a transient blue construction preview;
  release to commit one grouped order.
- **Left-click a planned ghost** — cancel every unfinished target in its group.
- **Middle-drag** — orbit, always.
- **Right-drag / WASD** — pan. **Wheel** — zoom.
- **R** — rotate the pending object. **Esc/right-click** — discard the current
  transient preview.

Tools live in the build palette (bottom of screen): floors, walls, fences, doors
and jail doors, furniture, logistics fixtures, staff, room painting, and access
zones. Prisoners arrive through scheduled intake rather than a normal placement
tool. Logistics mode opens stock, vehicle, export, and ledger data. Intelligence
mode opens the complete inmate roster: identity, custody, aptitudes, personality,
skills, criminal record, emotions, relationships, sourced intelligence, cliques,
and shared escape operations.

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
Both files are gitignored local state. Saves are version 3. Earlier versions are
intentionally incompatible with the prisoner-social simulation and are not
migrated by this milestone.

| Route | Methods | File |
| --- | --- | --- |
| `/api/save` | `GET`, `POST` | `prototype-save.json` |
| `/api/sim-log` | `GET`, `POST`, `DELETE` | `sim-log.jsonl` |

These exist **only in dev** — a production `dist/` build has no server.
