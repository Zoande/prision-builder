import { Camera } from "./camera";
import { invert } from "./math";
import { DIRS, NEEDS, World, defOf } from "./sim/world";
import {
  Agents, FOOD_KIND, HOLE_ENTRY_KIND, HOLE_SURF_KIND, TRAY_STACK_KIND,
  REG_NAMES, type Agent,
} from "./sim/agents";
import { Item, countItem, itemDef } from "./sim/items";
import { Editor } from "./editor";
import { clockLabel, evalAtmosphere, HOUR_SECONDS, hourOf, isNightAt } from "./daynight";
import { GroundPass } from "./render/groundPass";
import { FloorPass } from "./render/floorPass";
import { WallPass } from "./render/wallPass";
import { RoofPass } from "./render/roofPass";
import { DoorPass } from "./render/doorPass";
import { FencePass } from "./render/fencePass";
import { BedPass } from "./render/bedPass";
import { LightsPass } from "./render/lightsPass";
import { FurniturePass } from "./render/furniturePass";
import { PeoplePass } from "./render/peoplePass";
import { OverlayPass } from "./render/overlayPass";
import { RoomLinePass } from "./render/roomLinePass";
import { SkyPass } from "./render/skyPass";
import { pickGround } from "./render/pick";
import { configureAssets, type Quality } from "./render/assets";
import { GLOBALS_SIZE, writeGlobals } from "./render/shaderCommon";

const WORLD_SIZE = 500; // playable/buildable area (tiles)
const BORDER_TILES = 50; // extra hazed ground around it: no building, camera stays out
const TILE_SCALE = 9;
const FADE_WIDTH = 24; // border haze starts this far inside the playable area
const ROOF_SOLID = 1.0;
const ROOF_GHOST = 0.18;
const FOG_DENSITY = 1 / 380; // haze density at ground level (see FOG_FALLOFF in shaderCommon)

function fail(msg: string): never {
  const el = document.getElementById("err")!;
  el.style.display = "grid";
  el.textContent = msg;
  throw new Error(msg);
}

async function main() {
  const canvas = document.getElementById("gfx") as HTMLCanvasElement;

  if (!("gpu" in navigator)) fail("WebGPU is not available. Try Chrome/Edge 113+.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) fail("No suitable GPU adapter found.");
  const bcSupported = adapter.features.has("texture-compression-bc");
  const device = await adapter.requestDevice({
    requiredFeatures: bcSupported ? ["texture-compression-bc"] : [],
  });
  device.lost.then((info) => fail(`GPU device lost: ${info.message}`));

  const ctx = canvas.getContext("webgpu") as GPUCanvasContext;
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: "opaque" });

  // Texture quality (High 4K / Low 1K), persisted.
  const quality: Quality = localStorage.getItem("texQuality") === "1k" ? "1k" : "4k";
  configureAssets({ quality, bcSupported });
  const qualBtn = document.getElementById("qualBtn") as HTMLButtonElement;
  if (!bcSupported) { qualBtn.textContent = "Quality: Raw (no BC)"; qualBtn.disabled = true; }
  else {
    qualBtn.textContent = quality === "4k" ? "Quality: High (4K)" : "Quality: Low (1K)";
    qualBtn.addEventListener("click", () => {
      localStorage.setItem("texQuality", quality === "4k" ? "1k" : "4k");
      location.reload();
    });
  }

  // --- Simulation (empty world) -----------------------------------------
  const world = new World(WORLD_SIZE);

  // --- Shared uniforms + passes -----------------------------------------
  const uniformBuf = device.createBuffer({
    size: GLOBALS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const uni = new Float32Array(GLOBALS_SIZE / 4);

  // World light grid: one texel per tile, filled by the sim's lightField().
  const lightTex = device.createTexture({
    size: [WORLD_SIZE, WORLD_SIZE, 1], format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  // Zero it via a render-pass clear. This driver doesn't honor the spec'd
  // zero-initialization (and fumbled a giant writeTexture clear too), which
  // showed up as phantom pink light over the whole map.
  {
    const enc = device.createCommandEncoder();
    const clearPass = enc.beginRenderPass({
      colorAttachments: [{
        view: lightTex.createView(),
        loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 },
      }],
    });
    clearPass.end();
    device.queue.submit([enc.finish()]);
  }
  const light = {
    view: lightTex.createView(),
    samp: device.createSampler({
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
      magFilter: "linear", minFilter: "linear",
    }),
  };

  const [ground, floors, walls, roof, doors, fences, beds] = await Promise.all([
    GroundPass.create(device, format, uniformBuf, WORLD_SIZE, light),
    FloorPass.create(device, format, uniformBuf, light),
    WallPass.create(device, format, uniformBuf, light),
    RoofPass.create(device, format, uniformBuf, light),
    DoorPass.create(device, format, uniformBuf, light),
    FencePass.create(device, format, uniformBuf, light),
    BedPass.create(device, format, uniformBuf, light),
  ]);
  const lights = LightsPass.create(device, format, uniformBuf, light.view, light.samp);
  const furniture = FurniturePass.create(device, format, uniformBuf, light);
  const people = PeoplePass.create(device, format, uniformBuf, light);
  const overlay = OverlayPass.create(device, format, uniformBuf);
  const roomLines = RoomLinePass.create(device, format, uniformBuf);
  const sky = SkyPass.create(device, format, uniformBuf);

  // --- Living agents -----------------------------------------------------
  const agents = new Agents();
  let saveDirty = false;

  function refreshFurniture() {
    const byKind = world.furnitureInstances();
    byKind.set(FOOD_KIND, agents.foodInstances(world));
    byKind.set(TRAY_STACK_KIND, agents.trayStackInstances(world));
    const holes = agents.holeInstances(world);
    byKind.set(HOLE_ENTRY_KIND, holes.entries);
    byKind.set(HOLE_SURF_KIND, holes.surfs);
    furniture.setInstances(device, byKind);
  }

  // Push current sim state into all instance buffers.
  function rebuild() {
    agents.sync(world); // person tiles placed by the editor come alive
    world.recomputeRoofs();
    world.recomputeRooms();
    roomLines.set(device, world.roomOutline());
    floors.setInstances(device, world.floorsByMat());
    walls.setInstances(device, world.wallsByMat());
    fences.setInstances(device, world.fencesByMat());
    doors.setInstances(device, world.doorInstances(), world.jailDoorInstances());
    beds.setInstances(device, world.bedInstances());
    refreshFurniture();
    roof.setInstances(device, world.roofsByMat());
    lights.setInstances(device, world.lightInstances());
    const lf = world.lightField();
    if (lf) {
      // Pad rows to the 256-byte alignment D3D12 stages through; unaligned
      // rows produced speckled garbage texels on this driver.
      const rowBytes = lf.w * 4;
      const bpr = Math.ceil(rowBytes / 256) * 256;
      let src = lf.data;
      if (bpr !== rowBytes) {
        const padded = new Uint8Array(bpr * lf.h);
        for (let r = 0; r < lf.h; r++) {
          padded.set(lf.data.subarray(r * rowBytes, (r + 1) * rowBytes), r * bpr);
        }
        src = padded;
      }
      device.queue.writeTexture(
        { texture: lightTex, origin: [lf.x0, lf.z0] },
        src as BufferSource,
        { bytesPerRow: bpr, rowsPerImage: lf.h },
        [lf.w, lf.h, 1],
      );
    }
  }
  let dirty = false;

  // --- Depth target / resize --------------------------------------------
  let depthTex: GPUTexture | null = null;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width === w && canvas.height === h && depthTex) return;
    canvas.width = w; canvas.height = h;
    depthTex?.destroy();
    depthTex = device.createTexture({
      size: [w, h], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }
  resize();
  window.addEventListener("resize", resize);

  // --- Camera + editor ---------------------------------------------------
  const camera = new Camera(WORLD_SIZE, canvas, BORDER_TILES - 20);
  camera.target = [WORLD_SIZE / 2, 0, WORLD_SIZE / 2];
  camera.distance = 90;

  // World clock driving the day/night cycle; start at 08:00 on day 1.
  let worldTime = 8 * HOUR_SECONDS;
  try {
    const res = await fetch("/api/save");
    const data = await res.json();
    if (data?.world && data?.agents) {
      world.loadData(data.world);
      agents.loadData(data.agents);
      if (typeof data.worldTime === "number") worldTime = data.worldTime;
    }
  } catch {
    // File-backed saves only exist in the Vite dev server.
  }
  rebuild();

  // --- Game speed + clock + regime UI ------------------------------------
  let speed = 1;
  const speedsEl = document.getElementById("speeds")!;
  const speedBtns: HTMLButtonElement[] = [];
  for (const s of [0, 1, 2, 3, 5, 10]) {
    const b = document.createElement("button");
    b.className = "spd";
    b.textContent = s === 0 ? "⏸" : `${s}x`;
    if (s === 1) b.classList.add("on");
    b.onclick = () => {
      speed = s;
      speedBtns.forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
    };
    speedsEl.appendChild(b);
    speedBtns.push(b);
  }

  const clockEl = document.getElementById("clock")!;
  const regimeBtn = document.getElementById("regimeBtn") as HTMLButtonElement;
  const regimePanel = document.getElementById("regimePanel")!;
  const REG_COLORS = ["#6b7280", "#4f7dbf", "#caa84f", "#7fae5a", "#8fb8c8", "#5b5f8f"];
  function buildRegimePanel() {
    regimePanel.innerHTML = "";
    for (let h = 0; h < 24; h++) {
      const row = document.createElement("div");
      row.className = "reg-row";
      const label = document.createElement("span");
      label.className = "reg-hour";
      label.textContent = `${String(h).padStart(2, "0")}:00`;
      const act = document.createElement("div");
      act.className = "reg-act";
      const paint = () => {
        act.textContent = REG_NAMES[agents.regime[h]];
        act.style.background = REG_COLORS[agents.regime[h]] + "55";
        act.style.borderColor = REG_COLORS[agents.regime[h]];
      };
      paint();
      act.onclick = () => {
        agents.regime[h] = (agents.regime[h] + 1) % REG_NAMES.length;
        saveDirty = true;
        paint();
      };
      row.appendChild(label);
      row.appendChild(act);
      regimePanel.appendChild(row);
    }
  }
  buildRegimePanel();
  regimeBtn.addEventListener("click", () => {
    regimePanel.style.display = regimePanel.style.display === "flex" ? "none" : "flex";
  });

  const editor = new Editor();
  editor.onChange = () => { camera.buildMode = editor.active; };

  // Roof transparency toggle.
  let roofAlpha = ROOF_SOLID;
  const roofBtn = document.getElementById("roofBtn") as HTMLButtonElement;
  roofBtn.addEventListener("click", () => {
    const solid = roofAlpha === ROOF_SOLID;
    roofAlpha = solid ? ROOF_GHOST : ROOF_SOLID;
    roofBtn.textContent = solid ? "Roof: Transparent" : "Roof: Solid";
    roofBtn.classList.toggle("off", solid);
  });

  // --- Build placement (left button while a tool is active) -------------
  let painting = false, lastTX = -99999, lastTZ = -99999;
  let dragStart: { x: number; z: number } | null = null;
  let dragAxis: "x" | "z" | null = null;
  let dragPlaced = new Set<string>();
  let hoverTile: { x: number; z: number } | null = null;

  function tileFromEvent(e: PointerEvent): { x: number; z: number } | null {
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((e.clientY - rect.top) / rect.height) * 2;
    const vp = camera.viewProj(canvas.width / canvas.height);
    const hit = pickGround(vp, camera.eye(), ndcX, ndcY);
    if (!hit) return null;
    const tx = Math.floor(hit[0]), tz = Math.floor(hit[1]);
    if (!world.inBounds(tx, tz)) return null;
    return { x: tx, z: tz };
  }

  function applyBuildAt(tx: number, tz: number) {
    if (!world.inBounds(tx, tz)) return;
    const key = `${tx},${tz}`;
    if (dragPlaced.has(key)) return;
    dragPlaced.add(key);
    if (editor.apply(world, tx, tz)) { dirty = true; saveDirty = true; }
    // Tools that act on live agents rather than tiles.
    if (editor.tool?.cat === "erase") { agents.eraseAt(tx, tz); saveDirty = true; }
    if (editor.tool?.cat === "baton") { agents.giveBatonAt(tx, tz); saveDirty = true; }
  }

  function applyFloorRect(to: { x: number; z: number }) {
    if (!dragStart) return;
    const x0 = Math.min(dragStart.x, to.x), x1 = Math.max(dragStart.x, to.x);
    const z0 = Math.min(dragStart.z, to.z), z1 = Math.max(dragStart.z, to.z);
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) applyBuildAt(x, z);
    }
  }

  function applyLockedLine(to: { x: number; z: number }) {
    if (!dragStart) return;
    const dx = to.x - dragStart.x;
    const dz = to.z - dragStart.z;
    if (!dragAxis && (dx !== 0 || dz !== 0)) dragAxis = Math.abs(dx) >= Math.abs(dz) ? "x" : "z";
    if (!dragAxis) { applyBuildAt(dragStart.x, dragStart.z); return; }
    if (dragAxis === "x") {
      const x0 = Math.min(dragStart.x, to.x), x1 = Math.max(dragStart.x, to.x);
      for (let x = x0; x <= x1; x++) applyBuildAt(x, dragStart.z);
    } else {
      const z0 = Math.min(dragStart.z, to.z), z1 = Math.max(dragStart.z, to.z);
      for (let z = z0; z <= z1; z++) applyBuildAt(dragStart.x, z);
    }
  }

  function previewTiles(): { x: number; z: number }[] {
    if (!editor.tool || !hoverTile) return [];
    const cat = editor.tool.cat;
    const start = painting && dragStart ? dragStart : hoverTile;
    const out: { x: number; z: number }[] = [];
    const add = (x: number, z: number) => { if (world.inBounds(x, z)) out.push({ x, z }); };
    if (cat === "floor" || cat === "room") {
      const x0 = Math.min(start.x, hoverTile.x), x1 = Math.max(start.x, hoverTile.x);
      const z0 = Math.min(start.z, hoverTile.z), z1 = Math.max(start.z, hoverTile.z);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) add(x, z);
      return out;
    }
    if (cat === "wall" || cat === "fence") {
      const dx = hoverTile.x - start.x, dz = hoverTile.z - start.z;
      const axis = dragAxis ?? (Math.abs(dx) >= Math.abs(dz) ? "x" : "z");
      if (axis === "x") {
        const x0 = Math.min(start.x, hoverTile.x), x1 = Math.max(start.x, hoverTile.x);
        for (let x = x0; x <= x1; x++) add(x, start.z);
      } else {
        const z0 = Math.min(start.z, hoverTile.z), z1 = Math.max(start.z, hoverTile.z);
        for (let z = z0; z <= z1; z++) add(start.x, z);
      }
      return out;
    }
    if (cat === "piece") {
      // Ghost the object's real footprint, rotated the way it will be placed.
      const d = defOf(editor.tool!.mat);
      if (d) {
        const o = editor.orient & 3;
        const [ax, az] = DIRS[o];
        const [bx, bz] = DIRS[(o + 1) & 3];
        for (let a = 0; a < d.w; a++) {
          for (let b = 0; b < d.d; b++) {
            add(hoverTile.x + ax * a + bx * b, hoverTile.z + az * a + bz * b);
          }
        }
      }
      return out;
    }
    add(hoverTile.x, hoverTile.z);
    return out;
  }

  function paintAt(e: PointerEvent) {
    const tile = tileFromEvent(e);
    if (!tile) return;
    hoverTile = tile;
    const tx = tile.x, tz = tile.z;
    lastTX = tx; lastTZ = tz;
    const cat = editor.tool?.cat;
    if (cat === "floor" || cat === "room") applyFloorRect(tile);
    else if (cat === "wall" || cat === "fence") applyLockedLine(tile);
    else {
      if (tx === lastTX && tz === lastTZ && dragPlaced.has(`${tx},${tz}`)) return;
      applyBuildAt(tx, tz);
    }
  }

  // Agent inspection (click with no tool active).
  let selected: Agent | null = null;
  let overlayT = 0;
  function selectAt(e: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((e.clientY - rect.top) / rect.height) * 2;
    const vp = camera.viewProj(canvas.width / canvas.height);
    const hit = pickGround(vp, camera.eye(), ndcX, ndcY);
    if (!hit) return;
    selected = agents.agentNear(hit[0], hit[1], 1.5);
    overlayT = 0;
    if (!selected) overlay.clear();
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (!editor.active) { selectAt(e); return; }
    const tile = tileFromEvent(e);
    if (!tile) return;
    painting = true;
    lastTX = lastTZ = -99999;
    dragStart = tile;
    dragAxis = null;
    dragPlaced = new Set();
    if (editor.tool?.cat === "room") {
      editor.roomDrag = world.startRoomPaint(tile.x, tile.z, editor.tool.mat);
    }
    paintAt(e);
  });
  canvas.addEventListener("pointermove", (e) => { if (painting) paintAt(e); });
  addEventListener("pointerup", (e) => {
    if (e.button !== 0) return;
    painting = false;
    dragStart = null;
    dragAxis = null;
    dragPlaced = new Set();
    if (editor.roomDrag > 0) {
      world.endRoomPaint(editor.roomDrag);
      editor.roomDrag = 0;
      dirty = true;
      saveDirty = true;
    }
  });
  addEventListener("keydown", (e) => {
    if (e.key === "r" || e.key === "R") {
      // Editor owns the actual orientation change; this just ensures the
      // overlay redraws even if the mouse is not moving.
      hoverTile = hoverTile ? { ...hoverTile } : hoverTile;
    }
  });

  // --- Hover tooltips ------------------------------------------------------
  const tip = document.getElementById("tip")!;
  const STATE_TEXT: Record<string, string> = {
    idle: "Standing around", exploring: "Exploring", wandering: "Wandering",
    toEat: "Going to eat leftovers", eating: "Eating", toSleep: "Heading to bed",
    sleeping: "Sleeping", toSit: "Going to sit down", sitting: "Sitting",
    toOutside: "Heading outside", outside: "Getting fresh air",
    cuffed: "Handcuffed — waiting for a cell", escorted: "Being escorted",
    climbing: "CLIMBING THE FENCE", cutting: "CUTTING THE FENCE",
    sneakWait: "Waiting for a clear moment", toBreach: "Sneaking toward the fence",
    fleeing: "MAKING A RUN FOR IT", retreating: "Sneaking back home",
    toTunnel: "Heading to his tunnel", crawling: "Crawling through the tunnel",
    crawlingBack: "Crawling back out", digging: "DIGGING A TUNNEL",
    toTrip: "Slipping down his tunnel", crawlingOut: "Crawling up for air",
    queueing: "Queueing for food", toServe: "Going to get served",
    toTable: "Carrying his meal to a table", yardTime: "Enjoying the yard",
    toYard: "Heading to the yard", showering: "Showering",
    toShower: "Heading to the showers", inCell: "In his cell",
    regimeToCell: "Returning to his cell",
    patrol: "Patrolling", chasing: "CHASING A PRISONER",
    escorting: "Escorting a prisoner", stakeout: "Staking out a tunnel hole",
    intakeGo: "Fetching a new inmate", intakeEscort: "Escorting an inmate to his cell",
    regimeGo: "Fetching a regime-breaker", regimeEscort: "Marching a prisoner into line",
    toDoor: "Going to a jail door", doorWork: "Working a jail door",
    toCooker: "Heading to the stove", cooking: "Cooking a meal",
    delivering: "Stocking the serving table", toServeDuty: "Taking serving duty",
    manning: "Serving meals", toJob: "Heading to a repair job", repairing: "Repairing",
  };
  function tipText(ag: Agent): string {
    const kind = ag.kind === 8 ? "Prisoner" : ag.kind === 9 ? "Guard" :
      ag.kind === 20 ? "Cook" : "Workman";
    const doing = STATE_TEXT[ag.state] ?? ag.state;
    let s = `${kind} #${ag.id}\n${doing}${ag.underground ? " (underground)" : ""}`;
    if (ag.known) {
      const pc = (v: number) => `${Math.round(v * 100)}%`.padStart(4);
      const n = ag.needs;
      // Two needs per line, straight off the NEEDS list — a new need shows up
      // here without touching this code.
      const rows: string[] = [];
      for (let i = 0; i < NEEDS.length; i += 2) {
        rows.push(NEEDS.slice(i, i + 2)
          .map((k) => `${k.padEnd(9)}${pc(n[k])}`).join("  "));
      }
      s += `\n${rows.join("\n")}\n` +
        `escape desire ${pc(ag.escapeDesire)}  feasibility ${pc(ag.escapeFeasibility)}`;
      const hands = ag.inv.hands
        .map((x) => `${itemDef(x.kind)?.name ?? "?"}${x.count > 1 ? ` x${x.count}` : ""}`);
      const pockets = ag.inv.pockets
        .filter((x) => x !== null)
        .map((x) => `${itemDef(x!.kind)?.name ?? "?"}${x!.count > 1 ? ` x${x!.count}` : ""}`);
      s += `\nhands: ${hands.length ? hands.join(", ") : "empty"}` +
        `\npockets: ${pockets.length ? pockets.join(", ") : "empty"}`;
      const hidden = agents.stashOfBed(ag.bedIdx);
      if (hidden.length > 0) {
        s += `\nunder the bunk: ${hidden
          .map((x) => `${itemDef(x.kind)?.name ?? "?"}${x.count > 1 ? ` x${x.count}` : ""}`)
          .join(", ")}`;
      }
      if (ag.plan) {
        s += `\nPLANNING ESCAPE: ${ag.plan.method} (${ag.plan.stage})` +
          (ag.plan.method === "cut" ? `  cutters ${countItem(ag.inv, Item.Cutter)}/${ag.plan.needed}` : "") +
          (ag.plan.method === "dig" ? `  spoons ${countItem(ag.inv, Item.Spoon)}` : "");
      }
      s += `\n${ag.cellRoom >= 0 ? "has a cell" : "no cell"}` +
        (ag.cuffed ? " · handcuffed" : "") +
        (ag.compliant ? " · following regime" : " · DEFYING REGIME") +
        (ag.timesCaught > 0 ? ` · caught ${ag.timesCaught}x` : "");
    }
    return s;
  }
  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((e.clientY - rect.top) / rect.height) * 2;
    const hit = pickGround(camera.viewProj(canvas.width / canvas.height), camera.eye(), ndcX, ndcY);
    hoverTile = hit && world.inBounds(Math.floor(hit[0]), Math.floor(hit[1]))
      ? { x: Math.floor(hit[0]), z: Math.floor(hit[1]) }
      : null;
    const ag = hit ? agents.agentNear(hit[0], hit[1], 1.2) : null;
    if (!ag) { tip.style.display = "none"; return; }
    tip.textContent = tipText(ag);
    tip.style.display = "block";
    tip.style.left = `${Math.min(e.clientX + 16, innerWidth - 360)}px`;
    tip.style.top = `${Math.min(e.clientY + 12, innerHeight - 200)}px`;
  });
  canvas.addEventListener("mouseleave", () => { tip.style.display = "none"; hoverTile = null; });

  // --- Room labels + warning markers -------------------------------------
  const roomOverlay = document.getElementById("roomOverlay")!;
  const capEl = document.getElementById("cap")!;
  function projectToScreen(viewProj: Float32Array, x: number, y: number, z: number): [number, number] | null {
    const cx = viewProj[0] * x + viewProj[4] * y + viewProj[8] * z + viewProj[12];
    const cy = viewProj[1] * x + viewProj[5] * y + viewProj[9] * z + viewProj[13];
    const cw = viewProj[3] * x + viewProj[7] * y + viewProj[11] * z + viewProj[15];
    if (cw <= 0.0001) return null;
    const nx = cx / cw, ny = cy / cw;
    if (nx < -1.1 || nx > 1.1 || ny < -1.1 || ny > 1.1) return null;
    return [((nx + 1) * 0.5) * innerWidth, ((1 - ny) * 0.5) * innerHeight];
  }

  function attachWarningTip(el: HTMLElement, issue: string) {
    el.addEventListener("mousemove", (e) => {
      tip.textContent = issue;
      tip.style.display = "block";
      tip.style.left = `${Math.min(e.clientX + 16, innerWidth - 360)}px`;
      tip.style.top = `${Math.min(e.clientY + 12, innerHeight - 120)}px`;
    });
    el.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  }

  function addWarning(viewProj: Float32Array, x: number, z: number, issue: string) {
    const p = projectToScreen(viewProj, x, 1.0, z);
    if (!p) return;
    const el = document.createElement("div");
    el.className = "warn-mark";
    el.textContent = "!";
    el.style.left = `${p[0]}px`;
    el.style.top = `${p[1]}px`;
    attachWarningTip(el, issue);
    roomOverlay.appendChild(el);
  }

  function addPreviewTile(viewProj: Float32Array, x: number, z: number) {
    const corners = [
      projectToScreen(viewProj, x, 0.08, z),
      projectToScreen(viewProj, x + 1, 0.08, z),
      projectToScreen(viewProj, x + 1, 0.08, z + 1),
      projectToScreen(viewProj, x, 0.08, z + 1),
    ];
    if (corners.some((p) => !p)) return;
    const pts = corners as [number, number][];
    const minX = Math.min(...pts.map((p) => p[0]));
    const minY = Math.min(...pts.map((p) => p[1]));
    const maxX = Math.max(...pts.map((p) => p[0]));
    const maxY = Math.max(...pts.map((p) => p[1]));
    const el = document.createElement("div");
    el.className = "build-preview";
    el.style.left = `${minX}px`;
    el.style.top = `${minY}px`;
    el.style.width = `${Math.max(1, maxX - minX)}px`;
    el.style.height = `${Math.max(1, maxY - minY)}px`;
    el.style.clipPath = `polygon(${pts.map((p) => `${p[0] - minX}px ${p[1] - minY}px`).join(",")})`;
    roomOverlay.appendChild(el);
  }

  function previewShowsFacing(): boolean {
    const cat = editor.tool?.cat;
    return cat === "piece" ||
      cat === "prisoner" || cat === "guard" || cat === "cook" || cat === "workman";
  }

  function addPreviewArrow(viewProj: Float32Array) {
    if (!hoverTile || !previewShowsFacing()) return;
    const dirs = [[0.42, 0], [0, 0.42], [-0.42, 0], [0, -0.42]];
    const [dx, dz] = dirs[editor.orient & 3];
    const c = projectToScreen(viewProj, hoverTile.x + 0.5, 0.18, hoverTile.z + 0.5);
    const f = projectToScreen(viewProj, hoverTile.x + 0.5 + dx, 0.18, hoverTile.z + 0.5 + dz);
    if (!c || !f) return;
    const len = Math.hypot(f[0] - c[0], f[1] - c[1]);
    if (len < 4) return;
    const el = document.createElement("div");
    el.className = "build-preview-arrow";
    el.style.left = `${c[0]}px`;
    el.style.top = `${c[1]}px`;
    el.style.width = `${len}px`;
    el.style.transform = `rotate(${Math.atan2(f[1] - c[1], f[0] - c[0])}rad)`;
    roomOverlay.appendChild(el);
  }

  function renderWorldOverlay(viewProj: Float32Array) {
    roomOverlay.innerHTML = "";
    for (const t of previewTiles()) addPreviewTile(viewProj, t.x, t.z);
    addPreviewArrow(viewProj);
    capEl.textContent = `Prisoners: ${agents.prisonerCount()}/${world.prisonerCapacity()}`;
    for (const r of world.roomLabels()) {
      const p = projectToScreen(viewProj, r.x, 0.12, r.z);
      if (!p) continue;
      const label = document.createElement("div");
      label.className = "room-label";
      // Show the furnishing score once there's anything in the room worth
      // scoring — this is how the player sees decor doing something.
      label.textContent = r.ambience > 0
        ? `${r.name}  ${Math.round(r.ambience * 100)}%`
        : r.name;
      label.style.left = `${p[0]}px`;
      label.style.top = `${p[1]}px`;
      roomOverlay.appendChild(label);
      if (!r.valid) addWarning(viewProj, r.x, r.z, `${r.name} is invalid: ${r.issue}`);
    }
    for (const i of agents.issueLabels(world)) addWarning(viewProj, i.x, i.z, i.issue);
  }

  let saveInFlight = false;
  let saveTimer = 0;
  async function saveNow() {
    if (saveInFlight) return;
    saveInFlight = true;
    try {
      await fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          savedAt: new Date().toISOString(),
          worldTime,
          world: world.saveData(),
          agents: agents.saveData(),
        }),
      });
      saveDirty = false;
    } catch {
      // Running from a static build or file URL: no prototype save endpoint.
    } finally {
      saveInFlight = false;
    }
  }

  // --- Simulation diagnostics log ----------------------------------------
  interface Track {
    x: number;
    z: number;
    state: string;
    stillFor: number;
  }
  const simTrack = new Map<number, Track>();
  let simLogTimer = 0;
  let lastLogWorldTime = worldTime;
  let simLogInFlight = false;

  async function writeSimLog(sample: unknown) {
    if (simLogInFlight) return;
    simLogInFlight = true;
    try {
      await fetch("/api/sim-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sample),
      });
    } catch {
      // Dev server only. Static builds just skip diagnostic logging.
    } finally {
      simLogInFlight = false;
    }
  }

  function simLogSample() {
    const worldDelta = Math.max(0, worldTime - lastLogWorldTime);
    lastLogWorldTime = worldTime;
    const attention: unknown[] = [];
    for (const ag of agents.agents) {
      if (ag.kind !== 8) continue;
      const prev = simTrack.get(ag.id);
      const moved = prev ? Math.hypot(ag.x - prev.x, ag.z - prev.z) : Infinity;
      const sameState = prev?.state === ag.state;
      const stillFor = prev && sameState && moved < 0.15 ? prev.stillFor + worldDelta : 0;
      simTrack.set(ag.id, { x: ag.x, z: ag.z, state: ag.state, stillFor });
      const n = ag.needs;
      const reasons: string[] = [];
      if (stillFor > 90 && !["sleeping", "eating", "showering", "sitting", "inCell", "cuffed"].includes(ag.state)) {
        reasons.push(`same state/tile ${Math.round(stillFor)}s`);
      }
      if (ag.state === "idle" && stillFor > 45) reasons.push(`idle ${Math.round(stillFor)}s`);
      if (ag.cuffed) reasons.push("cuffed");
      if (ag.cellRoom < 0) reasons.push("no cell");
      if (!ag.compliant) reasons.push("not compliant");
      for (const k of NEEDS) {
        if (n[k] < 0.25) reasons.push(`low ${k} ${n[k].toFixed(2)}`);
      }
      if (ag.plan) reasons.push(`escape ${ag.plan.method}/${ag.plan.stage}`);
      if (ag.sneaking) reasons.push("sneaking");
      if (ag.risk > 0.05) reasons.push(`risk ${ag.risk.toFixed(2)}`);
      if (reasons.length > 0) {
        const needs: Record<string, number> = {};
        for (const k of NEEDS) needs[k] = Number(n[k].toFixed(2));
        attention.push({
          id: ag.id,
          state: ag.state,
          pos: [Number(ag.x.toFixed(1)), Number(ag.z.toFixed(1))],
          reasons,
          path: ag.path ? `${ag.pathI}/${ag.path.length}` : null,
          needs,
          known: ag.known?.size ?? 0,
          bed: ag.bedIdx,
        });
      }
    }
    const liveIds = new Set(agents.agents.map((a) => a.id));
    for (const id of [...simTrack.keys()]) if (!liveIds.has(id)) simTrack.delete(id);
    const invalidRooms = world.roomLabels()
      .filter((r) => !r.valid)
      .map((r) => ({ id: r.id, name: r.name, issue: r.issue, pos: [Number(r.x.toFixed(1)), Number(r.z.toFixed(1))] }));
    return {
      t: new Date().toISOString(),
      dayClock: clockLabel(worldTime),
      worldTime: Math.round(worldTime),
      speed,
      regime: REG_NAMES[agents.currentActivity()],
      capacity: { prisoners: agents.prisonerCount(), beds: world.prisonerCapacity() },
      diagnostics: agents.diagnostics(world),
      invalidRooms,
      issues: agents.issueLabels(world),
      attention,
    };
  }

  void fetch("/api/sim-log", { method: "DELETE" }).then(() => writeSimLog({
    t: new Date().toISOString(),
    event: "sim-log-start",
    note: "Samples are appended every 10 real seconds while the game is open.",
  })).catch(() => undefined);

  // --- Loop --------------------------------------------------------------
  const hud = document.getElementById("hud")!;
  let last = performance.now();
  let fpsAccum = 0, fpsFrames = 0, fps = 0;

  function frame(now: number) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    resize();
    camera.update(dt);
    if (dirty) { rebuild(); dirty = false; }

    // Advance the world clock at the selected speed; substep the sim so
    // high speeds don't let agents tunnel through walls.
    let simDt = dt * speed;
    worldTime += simDt;
    while (simDt > 0) {
      const step = Math.min(0.1, simDt);
      agents.update(step, world, isNightAt(worldTime), hourOf(worldTime));
      simDt -= step;
    }
    const atmo = evalAtmosphere(worldTime);

    // Clock + regime UI.
    clockEl.textContent = clockLabel(worldTime);
    regimeBtn.textContent = `Regime: ${REG_NAMES[agents.regime[Math.floor(hourOf(worldTime))]]}`;

    people.update(device, agents.personInstances());
    if (agents.takeWorldDirty()) { dirty = true; saveDirty = true; } // fences cut / repaired
    else if (agents.takeMealsDirty()) { refreshFurniture(); saveDirty = true; }
    if (selected && !agents.agents.includes(selected)) { selected = null; overlay.clear(); }
    overlayT -= dt;
    if (selected && overlayT <= 0) {
      overlayT = 0.5;
      overlay.set(device, agents.knownOverlay(selected, world));
    }

    const aspect = canvas.width / canvas.height;
    const viewProj = camera.viewProj(aspect);
    renderWorldOverlay(viewProj);
    saveTimer += dt;
    if (saveTimer >= 5) {
      saveTimer = 0;
      if (saveDirty || speed > 0) void saveNow();
    }
    simLogTimer += dt;
    if (simLogTimer >= 10) {
      simLogTimer = 0;
      void writeSimLog(simLogSample());
    }
    writeGlobals(uni, {
      viewProj,
      invViewProj: invert(viewProj),
      lightDir: atmo.lightDir,
      worldSize: WORLD_SIZE,
      eye: camera.eye(),
      tileScale: TILE_SCALE,
      sunDir: atmo.sunDir,
      fadeWidth: FADE_WIDTH,
      sunColor: atmo.sunColor,
      roofAlpha,
      ambDown: atmo.ambDown,
      time: worldTime,
      ambUp: atmo.ambUp,
      fogDensity: FOG_DENSITY,
      fogColor: atmo.fogColor,
      border: BORDER_TILES,
      skyHorizon: atmo.skyHorizon,
      skyZenith: atmo.skyZenith,
    });
    device.queue.writeBuffer(uniformBuf, 0, uni);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: ctx.getCurrentTexture().createView(),
        loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
      depthStencilAttachment: {
        view: depthTex!.createView(),
        depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1.0,
      },
    });
    ground.draw(pass);
    floors.draw(pass);
    walls.draw(pass);
    fences.draw(pass);
    doors.draw(pass);
    beds.draw(pass);
    lights.draw(pass);
    furniture.draw(pass);
    people.draw(pass);
    roomLines.draw(pass);
    if (selected) overlay.draw(pass); // debug: selected agent's memory
    sky.draw(pass); // fills only pixels the scene left empty
    roof.draw(pass); // translucent, last (blends over the sky)
    pass.end();
    device.queue.submit([encoder.finish()]);

    fpsAccum += dt; fpsFrames++;
    if (fpsAccum >= 0.5) { fps = fpsFrames / fpsAccum; fpsAccum = 0; fpsFrames = 0; }
    const tool = editor.tool ? `${editor.tool.cat}` : "none";
    const waiting = agents.agents.filter((a) => a.cuffed && a.escortedBy < 0).length;
    let text =
      `Prison Builder — editor   escaped: ${agents.escapedCount}   caught: ${agents.caughtCount}` +
      (waiting > 0 ? `   waiting for cell: ${waiting}` : "") + `\n` +
      `left: build (${tool}) / click a person to inspect   R: rotate   Esc: deselect\n` +
      `middle-drag: orbit   right-drag / WASD: pan   wheel: zoom   ${fps.toFixed(0)} fps`;
    if (selected) {
      const kindName =
        selected.kind === 8 ? "Prisoner" : selected.kind === 9 ? "Guard" :
        selected.kind === 20 ? "Cook" : "Workman";
      const pc = (v: number) => `${Math.round(v * 100)}%`;
      text += `\n— ${kindName} #${selected.id}: ${selected.state}` +
        (selected.underground ? " (underground)" : "") +
        (selected.cuffed ? "   [handcuffed]" : "") +
        (selected.cellRoom >= 0 ? "   [has cell]" : "") +
        (selected.baton ? "   [baton]" : "");
      if (selected.known) {
        const n = selected.needs;
        text +=
          `\n   food ${pc(n.food)}   sleep ${pc(n.sleep)}   outdoors ${pc(n.outdoors)}   comfort ${pc(n.comfort)}` +
          `\n   knows ${selected.known.size} tiles   bed ${selected.bedIdx >= 0 ? "claimed" : "none"}` +
          `   objects ${[...selected.objMem!.values()].reduce((a, m) => a + m.size, 0)}` +
          `\n   escape: desire ${pc(selected.escapeDesire)}   feasibility ${pc(selected.escapeFeasibility)}` +
          `   caught ${selected.timesCaught}x` +
          `   carrying ${selected.inv.hands.reduce((a, x) => a + x.count, 0)}` +
          `   hidden ${agents.stashOfBed(selected.bedIdx).reduce((a, x) => a + x.count, 0)}` +
          (selected.plan ? `\n   plan: ${selected.plan.method} (${selected.plan.stage}, ${selected.plan.needed} fences)` : "");
      }
    }
    hud.textContent = text;

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((e) => fail(String(e?.stack ?? e)));
