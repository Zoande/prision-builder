# Prison Builder

A prison-management sandbox rendered in the browser with **WebGPU**. You paint
floors, walls, fences and doors onto a tile grid, furnish rooms, staff them, and
watch prisoners, guards and cooks act out a daily regime under a day/night cycle.

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
| `npm run textures` | Re-encode the compressed textures (see below). |
| `npm run check` | Sanity-check `World.recomputeRoofs()` on a 6x6 room. |

## Controls

Camera is an orbit rig over the ground plane:

- **Left-drag** — orbit, but only when no build tool is selected; with a tool
  active, left-drag places instead.
- **Middle-drag** — orbit, always.
- **Right-drag / WASD** — pan. **Wheel** — zoom.
- **R** — rotate the pending object. **Esc** — clear the current tool.

Tools live in the build palette (bottom of screen): floors, walls, fences, doors
and jail doors, beds, toilets, showers, tables, benches, cookers, lights, people
(prisoner / guard / cook / workman), plus room painting and access zones.

## Layout

```
src/
  main.ts          bootstrap, frame loop, HUD wiring
  editor.ts        build palette + tool → world mutations
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
    agents.ts      prisoner / guard / cook behaviour and scheduling
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
2. **Raw** — the JPG/PNGs in `public/textures/`, capped at 2048px. Used as the
   fallback when BC is unsupported or a KTX fails to load, and it's the only tier
   for the galvanized / corroded / fabric materials.

The raw textures are committed, so **the app runs from a fresh clone** — you just
get the uncompressed tier.

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
Both files are gitignored local state.

| Route | Methods | File |
| --- | --- | --- |
| `/api/save` | `GET`, `POST` | `prototype-save.json` |
| `/api/sim-log` | `GET`, `POST`, `DELETE` | `sim-log.jsonl` |

These exist **only in dev** — a production `dist/` build has no server.
