import { Camera } from "./camera";
import { invert } from "./math";
import { DIRS, NEEDS, Obj, RoomType, World, defOf } from "./sim/world";
import {
  Agents, CARGO_KIND, DRIVER_KIND, FOOD_KIND, HOLE_ENTRY_KIND, HOLE_SURF_KIND,
  INTAKE_TRUCK_KIND, MEDICAL_VEHICLE_KIND, OUTSIDE_VEHICLE_KIND, TRAY_STACK_KIND, TRUCK_KIND, VISITOR_VEHICLE_KIND,
  REG, REG_NAMES, type Agent, type IssueLabel,
} from "./sim/agents";
import {
  PersonInstanceStager, foodInstances, holeInstances, trayStackInstances,
  logisticsInstances,
} from "./sim/renderData";
import { Item, countItem, itemDef } from "./sim/items";
import { Editor } from "./editor";
import { clockLabel, dayOf, evalAtmosphere, HOUR_SECONDS, hourOf, isNightAt } from "./daynight";
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
import { GhostPass } from "./render/ghostPass";
import { pickGround } from "./render/pick";
import { configureAssets, type Quality } from "./render/assets";
import { GLOBALS_SIZE, writeGlobals } from "./render/shaderCommon";
import { WorldOverlay, type PreviewTile } from "./ui/worldOverlay";
import { EconomySystem } from "./sim/economy";
import { LogisticsSystem } from "./sim/logistics";
import { ConstructionSystem } from "./sim/construction";
import { InfrastructureSystem } from "./sim/infrastructure";
import { KitchenSystem } from "./sim/kitchen";
import { IntakeSystem } from "./sim/intake";
import { commodityDef, recipeCost } from "./sim/commodities";
import { Task2Systems } from "./sim/task2Systems";
import { Task3Systems } from "./sim/task3Systems";
import { ProblemRegistry } from "./sim/problems";
import { SAVE_VERSION, isSaveV6 } from "./sim/saveVersion";
import { BrowserSaveRepository } from "./sim/saveRepository";
import { ITEM_DEFS_V4, itemDefV4 } from "./sim/itemSystem";
import { incidentCategoryForItem } from "./sim/institution";
import {
  APTITUDE_IDS, APTITUDE_NAMES, CUSTODY_COLORS, CUSTODY_NAMES,
  PERSONALITY_IDS, PERSONALITY_NAMES, SKILL_IDS, SKILL_NAMES, crimeName,
} from "./sim/profiles";

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
  let adapter: GPUAdapter | null = null;
  let adapterError: unknown;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  } catch (error) {
    adapterError = error;
    // A few Windows drivers reject the power preference even though WebGPU is
    // available. Retry with the browser's default adapter selection.
    try {
      adapter = await navigator.gpu.requestAdapter();
    } catch (retryError) {
      adapterError = retryError;
    }
  }
  if (!adapter) {
    const detail = adapterError instanceof Error ? adapterError.message : String(adapterError ?? "no adapter");
    fail(`WebGPU could not initialize (${detail}). Open this app at the Vite URL (http://localhost:5173) in Chrome or Edge, rather than opening index.html directly.`);
  }
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
  if (!bcSupported) { qualBtn.textContent = "RAW"; qualBtn.title = "Raw textures (BC compression unavailable)"; qualBtn.disabled = true; }
  else {
    qualBtn.textContent = quality === "4k" ? "HQ" : "LQ";
    qualBtn.title = quality === "4k" ? "Texture quality: High (4K)" : "Texture quality: Low (1K)";
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
  const ghosts = GhostPass.create(device, format, uniformBuf);
  const people = PeoplePass.create(device, format, uniformBuf, light);
  const overlay = OverlayPass.create(device, format, uniformBuf);
  const roomLines = RoomLinePass.create(device, format, uniformBuf);
  const sky = SkyPass.create(device, format, uniformBuf);

  // --- Living agents -----------------------------------------------------
  const agents = new Agents();
  const economy = new EconomySystem();
  const logistics = new LogisticsSystem(economy);
  const construction = new ConstructionSystem(logistics);
  const kitchen = new KitchenSystem(logistics);
  const intake = new IntakeSystem(economy);
  const infrastructure = new InfrastructureSystem(world);
  const task2 = new Task2Systems(WORLD_SIZE, economy, logistics);
  const task3 = new Task3Systems(task2, economy, logistics);
  const problems = new ProblemRegistry();
  kitchen.physicalItems = task2.items;
  agents.construction = construction;
  agents.kitchen = kitchen;
  agents.task2 = task2;
  agents.task3 = task3;
  task2.social = agents.social;
  task2.escapeOperations = agents.escapeOperations;
  const personStager = new PersonInstanceStager();
  let saveDirty = false;

  function refreshFurniture() {
    const byKind = world.furnitureInstances();
    byKind.set(FOOD_KIND, foodInstances(agents, world));
    byKind.set(TRAY_STACK_KIND, trayStackInstances(agents, world));
    const holes = holeInstances(agents, world);
    byKind.set(HOLE_ENTRY_KIND, holes.entries);
    byKind.set(HOLE_SURF_KIND, holes.surfs);
    const logisticsRender = logisticsInstances(logistics, intake);
    byKind.set(TRUCK_KIND, logisticsRender.trucks);
    byKind.set(INTAKE_TRUCK_KIND, logisticsRender.intakeTrucks);
    byKind.set(CARGO_KIND, logisticsRender.cargo);
    byKind.set(DRIVER_KIND, logisticsRender.drivers);
    const external = { visitor: [] as number[], medical: [] as number[], outside: [] as number[] };
    for (const vehicle of task3.escape.externalVehicles.values()) external[vehicle.kind].push(vehicle.x - 1, vehicle.z - 3, 0);
    byKind.set(VISITOR_VEHICLE_KIND, new Float32Array(external.visitor));
    byKind.set(MEDICAL_VEHICLE_KIND, new Float32Array(external.medical));
    byKind.set(OUTSIDE_VEHICLE_KIND, new Float32Array(external.outside));
    furniture.setInstances(device, byKind);
  }

  // Push current sim state into all instance buffers.
  function rebuild() {
    agents.sync(world); // person tiles placed by the editor come alive
    world.recomputeRoofs();
    world.recomputeRooms();
    task2.rebuildWorld(world);
    task3.rebuildWorld(world);
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
  const saveRepository = new BrowserSaveRepository();
  let loadedV6 = false;
  let incompatibleSave = false;
  let incompatibleData: unknown = null;
  try {
    const data = await saveRepository.load();
    if (isSaveV6(data)) {
      world.loadData(data.world);
      infrastructure.loadData(data.infrastructure);
      agents.loadData(data.agents);
      economy.loadData(data.economy ?? {});
      logistics.loadData(data.logistics ?? {});
      construction.loadData(data.construction ?? {});
      kitchen.loadData(data.kitchen ?? {});
      intake.loadData(data.intake ?? {});
      task2.loadData(data.task2 ?? {}, world);
      task3.loadData(data.task3 ?? {}, world);
      construction.reconcile(world, new Set(agents.agents.filter((agent) => agent.kind === Obj.Workman).map((agent) => agent.id)));
      if (typeof data.worldTime === "number") worldTime = data.worldTime;
      loadedV6 = true;
    } else if (data && typeof data === "object" && ("world" in data || [1, 2, 3, 4, 5].includes(Number((data as { version?: unknown }).version)))) {
      incompatibleSave = true;
      incompatibleData = data;
    }
  } catch {
    // A fresh game remains available when persistence is unavailable.
  }
  if (!loadedV6) {
    infrastructure.installNewGame();
    task2.installNewGame(world);
    task3.installNewGame(world, worldTime);
    camera.target = [368, 0, 375];
    camera.distance = 72;
  }
  rebuild();

  // --- Game speed + clock + regime UI ------------------------------------
  let speed = loadedV6 ? 1 : 0;
  const speedsEl = document.getElementById("speeds")!;
  const speedBtns: HTMLButtonElement[] = [];
  for (const s of [0, 1, 2, 3, 5, 10]) {
    const b = document.createElement("button");
    b.className = "spd";
    b.textContent = s === 0 ? "⏸" : `${s}x`;
    if (s === speed) b.classList.add("on");
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
  const noticeEl = document.getElementById("notice")!;
  let noticeTimer = 0;
  function notify(message: string): void {
    noticeEl.textContent = message;
    noticeEl.classList.add("show");
    noticeTimer = 4;
  }
  function downloadJson(value: unknown, filename: string): void {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  const startMenu = document.getElementById("startMenu")!;
  if (incompatibleSave) startMenu.classList.add("show");
  document.getElementById("downloadOldBtn")!.addEventListener("click", () => {
    if (incompatibleData) downloadJson(incompatibleData, "prison-builder-v5-backup.json");
  });
  document.getElementById("freshStartBtn")!.addEventListener("click", async () => {
    await saveRepository.delete();
    incompatibleSave = false;
    incompatibleData = null;
    startMenu.classList.remove("show");
    saveDirty = true;
    notify("Fresh v6 prison started. The game is paused while you prepare.");
  });
  document.getElementById("saveNowBtn")!.addEventListener("click", () => void saveNow());
  document.getElementById("exportSaveBtn")!.addEventListener("click", () => downloadJson(saveSnapshot(), "prison-builder-v6-save.json"));
  const importFile = document.getElementById("importSaveFile") as HTMLInputElement;
  document.getElementById("importSaveBtn")!.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", async () => {
    const file = importFile.files?.[0];
    if (!file) return;
    try {
      const value = JSON.parse(await file.text()) as unknown;
      if (!isSaveV6(value)) throw new Error("Only a complete version-6 save can be imported");
      await saveRepository.save(value);
      location.reload();
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error));
    }
  });
  document.getElementById("newGameBtn")!.addEventListener("click", async () => {
    if (!confirm("Start a new prison? Export your current save first if you want to keep it.")) return;
    await saveRepository.delete();
    location.reload();
  });

  const buildPanel = document.getElementById("build")!;
  const logisticsDashboard = document.getElementById("logisticsDashboard")!;
  const financialsDashboard = document.getElementById("financialsDashboard")!;
  const policyDashboard = document.getElementById("policyDashboard")!;
  const intelligenceDashboard = document.getElementById("intelligenceDashboard")!;
  let activeMode = "";
  document.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode ?? "build";
      if (activeMode === mode) {
        activeMode = "";
        btn.classList.remove("on");
        buildPanel.classList.remove("open");
        editor.clear();
        logisticsDashboard.classList.remove("show");
        financialsDashboard.classList.remove("show");
        policyDashboard.classList.remove("show");
        intelligenceDashboard.classList.remove("show");
        return;
      }
      document.querySelectorAll(".mode-btn").forEach((x) => x.classList.remove("on"));
      btn.classList.add("on");
      activeMode = mode;
      buildPanel.classList.toggle("open", !["financials", "intelligence", "policy", "admin"].includes(mode));
      editor.setMode(mode);
      logisticsDashboard.classList.toggle("show", mode === "logistics");
      financialsDashboard.classList.toggle("show", mode === "financials");
      policyDashboard.classList.toggle("show", mode === "policy");
      intelligenceDashboard.classList.toggle("show", mode === "intelligence");
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-emergency]").forEach((button) => button.onclick = () => {
    task2.security.command((button.dataset.emergency ?? "none") as never, worldTime, agents.agents);
    saveDirty = true;
  });

  // Roof transparency toggle.
  let roofAlpha = ROOF_SOLID;
  const roofBtn = document.getElementById("roofBtn") as HTMLButtonElement;
  roofBtn.addEventListener("click", () => {
    const solid = roofAlpha === ROOF_SOLID;
    roofAlpha = solid ? ROOF_GHOST : ROOF_SOLID;
    roofBtn.textContent = solid ? "\u25B1" : "\u2302";
    roofBtn.title = solid ? "Roof: Transparent" : "Roof: Solid";
    roofBtn.classList.toggle("off", solid);
  });

  // --- Build placement (left button while a tool is active) -------------
  let painting = false, lastTX = -99999, lastTZ = -99999;
  let dragStart: { x: number; z: number } | null = null;
  let dragAxis: "x" | "z" | null = null;
  let dragPlaced = new Set<string>();
  let hoverTile: { x: number; z: number } | null = null;

  function isOrderTool(): boolean {
    const cat = editor.tool?.cat;
    return !!cat && [
      "floor", "wall", "fence", "door", "staffdoor", "jaildoor", "fencedoor",
      "fencestaffdoor", "fencejaildoor", "lamp", "walllight", "rooflight", "piece", "erase",
    ].includes(cat);
  }

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
    const cat = editor.tool?.cat;
    if (cat === "guard" || cat === "cook" || cat === "workman" || cat === "person") {
      const i = world.idx(tx, tz);
      if (world.objKind[i] !== Obj.None || world.pieceAt[i] !== 0 || world.infrastructure[i]) {
        notify("That tile is occupied. Clear it before hiring staff there.");
        return;
      }
      const kind = cat === "person" ? editor.tool!.mat : cat === "guard" ? Obj.Guard : cat === "cook" ? Obj.Cook : Obj.Workman;
      if (!task3.canHire(kind, agents.agents)) { notify("That management role is already filled."); return; }
      if (!economy.hire(kind, worldTime)) {
        notify(`Hiring requires $${economy.hireFee(kind).toLocaleString()}; only $${Math.max(0, Math.floor(economy.cash)).toLocaleString()} is available.`);
        return;
      }
    }
    if (!isOrderTool() && editor.apply(world, tx, tz)) { dirty = true; saveDirty = true; }
    // Deployment acts on the guard roster, not on tiles, so it lives here.
    const dcat = editor.tool?.cat;
    if (dcat === "deploy" || dcat === "undeploy") {
      const step = dcat === "deploy" ? 1 : -1;
      let changed = false;
      const route = world.routeAtTile(tx, tz);
      if (route > 0) {
        const before = agents.routeQuota(route);
        const after = Math.max(0, before + step);
        if (after !== before) { agents.setRouteQuota(route, after); changed = true; }
      } else {
        const room = world.roomAt(world.idx(tx, tz));
        if (room) {
          const after = Math.max(0, room.guards + step);
          if (after !== room.guards) { room.guards = after; changed = true; }
        }
      }
      if (changed) { dirty = true; saveDirty = true; }
    }
    // Tools that act on live agents rather than tiles.
    if (editor.tool?.cat === "baton" && agents.giveBatonAt(tx, tz)) saveDirty = true;
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

  const previewScratch: PreviewTile[] = [];
  function previewTiles(): number {
    let count = 0;
    const add = (x: number, z: number, tone: "blue" | "red" = "blue", planned = false) => {
      if (!world.inBounds(x, z)) return;
      let tile = previewScratch[count];
      if (!tile) { tile = { x, z, tone, planned }; previewScratch.push(tile); }
      else { tile.x = x; tile.z = z; tile.tone = tone; tile.planned = planned; }
      count++;
    };
    if (!editor.tool || !hoverTile) return count;
    const cat = editor.tool.cat;
    const start = painting && dragStart ? dragStart : hoverTile;
    const transient = orderTargets();
    const transientGhosts = isOrderTool() ? construction.preview(editor.tool, transient, editor.orient, world) : [];
    const invalid = transientGhosts.some((g) => !g.valid);
    const tone: "blue" | "red" = cat === "erase" || invalid ? "red" : "blue";
    if (cat === "floor" || cat === "room") {
      const x0 = Math.min(start.x, hoverTile.x), x1 = Math.max(start.x, hoverTile.x);
      const z0 = Math.min(start.z, hoverTile.z), z1 = Math.max(start.z, hoverTile.z);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) add(x, z, tone);
      return count;
    }
    if (cat === "wall" || cat === "fence") {
      const dx = hoverTile.x - start.x, dz = hoverTile.z - start.z;
      const axis = dragAxis ?? (Math.abs(dx) >= Math.abs(dz) ? "x" : "z");
      if (axis === "x") {
        const x0 = Math.min(start.x, hoverTile.x), x1 = Math.max(start.x, hoverTile.x);
        for (let x = x0; x <= x1; x++) add(x, start.z, tone);
      } else {
        const z0 = Math.min(start.z, hoverTile.z), z1 = Math.max(start.z, hoverTile.z);
        for (let z = z0; z <= z1; z++) add(start.x, z, tone);
      }
      return count;
    }
    if (cat === "piece") {
      // Ghost the object's real footprint, rotated the way it will be placed.
      const d = defOf(editor.tool!.mat);
      if (d) {
        const ghost = transientGhosts[0], anchorX = ghost?.x ?? hoverTile.x, anchorZ = ghost?.z ?? hoverTile.z;
        const o = ghost?.orient ?? (editor.orient & 3);
        const [ax, az] = DIRS[o];
        const [bx, bz] = DIRS[(o + 1) & 3];
        for (let a = 0; a < d.w; a++) {
          for (let b = 0; b < d.d; b++) {
            add(anchorX + ax * a + bx * b, anchorZ + az * a + bz * b, tone);
          }
        }
      }
      return count;
    }
    add(hoverTile.x, hoverTile.z, tone);
    return count;
  }

  function paintAt(e: PointerEvent) {
    const tile = tileFromEvent(e);
    if (!tile) return;
    hoverTile = tile;
    const tx = tile.x, tz = tile.z;
    lastTX = tx; lastTZ = tz;
    const cat = editor.tool?.cat;
    if (isOrderTool()) return; // dragging only changes the transient preview
    if (cat === "deploy" || cat === "undeploy") {
      if (!dragPlaced.has(`${tx},${tz}`)) applyBuildAt(tx, tz);
      return;
    }
    if (cat === "floor" || cat === "room") applyFloorRect(tile);
    else if (cat === "wall" || cat === "fence") applyLockedLine(tile);
    else {
      if (tx === lastTX && tz === lastTZ && dragPlaced.has(`${tx},${tz}`)) return;
      applyBuildAt(tx, tz);
    }
  }

  function orderTargets(): { x: number; z: number }[] {
    if (!editor.tool || !hoverTile) return [];
    const cat = editor.tool.cat;
    const start = dragStart ?? hoverTile;
    const result: { x: number; z: number }[] = [];
    if (cat === "floor") {
      const x0 = Math.min(start.x, hoverTile.x), x1 = Math.max(start.x, hoverTile.x);
      const z0 = Math.min(start.z, hoverTile.z), z1 = Math.max(start.z, hoverTile.z);
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) result.push({ x, z });
    } else if (cat === "wall" || cat === "fence") {
      const dx = hoverTile.x - start.x, dz = hoverTile.z - start.z;
      const axis = dragAxis ?? (Math.abs(dx) >= Math.abs(dz) ? "x" : "z");
      if (axis === "x") {
        const x0 = Math.min(start.x, hoverTile.x), x1 = Math.max(start.x, hoverTile.x);
        for (let x = x0; x <= x1; x++) result.push({ x, z: start.z });
      } else {
        const z0 = Math.min(start.z, hoverTile.z), z1 = Math.max(start.z, hoverTile.z);
        for (let z = z0; z <= z1; z++) result.push({ x: start.x, z });
      }
    } else {
      result.push({ ...hoverTile });
    }
    return result;
  }

  function commitOrder(): boolean {
    if (!editor.tool) return false;
    const targets = orderTargets();
    if (targets.length === 0) return false;
    if (editor.tool.cat === "erase") {
      const target = targets[0];
      const agent = agents.agentNear(target.x + 0.5, target.z + 0.5, 0.6);
      if (agent) {
        if (agent.kind === Obj.Prisoner) return false; // prisoners are intake-controlled
        agents.removeAgent(agent); // firing is immediate and has no refund
        saveDirty = true;
        return true;
      }
    }
    const group = construction.plan(editor.tool, targets, editor.orient, worldTime, world);
    if (!group) {
      notify(construction.lastIssue?.message ?? "Nothing can be built at that location.");
      return false;
    }
    saveDirty = true;
    return true;
  }

  // Agent inspection (click with no tool active).
  let selected: Agent | null = null;
  let overlayT = 0;
  let staffLayerWasUp = false;
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
    updateInspector();
  }

  const inspector = document.getElementById("inspector")!;
  const inspectName = document.getElementById("inspectName")!;
  const inspectState = document.getElementById("inspectState")!;
  const inspectStats = document.getElementById("inspectStats")!;
  const inspectProfile = document.getElementById("inspectProfile")!;
  const agentKindName = (kind: number): string => ({ [Obj.Prisoner]: "Prisoner", [Obj.Guard]: "Guard", [Obj.Cook]: "Cook",
    [Obj.Workman]: "Workman", [Obj.Doctor]: "Doctor", [Obj.Investigator]: "Investigator", [Obj.DogHandler]: "Dog Handler",
    [Obj.ArmedGuard]: "Armed Guard", [Obj.SecurityDog]: "Security Dog", [Obj.Sniper]: "Sniper",
    [Obj.ChiefOfficer]: "Chief Officer", [Obj.Foreman]: "Foreman", [Obj.Accountant]: "Accountant" }[kind] ?? "Staff");
  const inspectValues = new Map<string, HTMLElement>();
  for (const label of ["Food", "Rest", "Comfort", "Outdoors", "Social", "Stress"]) {
    const stat = document.createElement("div");
    stat.className = "inspect-stat";
    const small = document.createElement("small");
    small.textContent = label;
    const value = document.createElement("strong");
    stat.append(small, value);
    inspectStats.appendChild(stat);
    inspectValues.set(label, value);
  }
  function updateInspector() {
    if (!selected) { inspector.classList.remove("show"); return; }
    const kind = agentKindName(selected.kind);
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const profile = selected.profile;
    inspectStats.style.display = "none"; // exact private needs/emotions belong to developer diagnostics, not player intelligence
    const name = profile ? `${profile.firstName} ${profile.lastName}` : `${kind} #${selected.id}`;
    const socialAction = selected.socialAction === "arguing" ? " · arguing" : selected.socialAction === "talking" ? " · socializing" : "";
    const state = (STATE_TEXT[selected.state] ?? selected.state) + socialAction;
    if (inspectName.textContent !== name) inspectName.textContent = name;
    if (inspectState.textContent !== state) inspectState.textContent = state;
    const setValue = (label: string, value: string) => {
      const el = inspectValues.get(label)!;
      if (el.textContent !== value) el.textContent = value;
    };
    setValue("Food", pct(selected.needs.food));
    setValue("Rest", pct(selected.needs.sleep));
    setValue("Comfort", pct(selected.needs.comfort));
    setValue("Outdoors", pct(selected.needs.outdoors));
    setValue("Social", pct(selected.needs.social));
    setValue("Stress", selected.mind ? pct(selected.mind.stress) : "—");
    if (profile) {
      inspectProfile.textContent = `${CUSTODY_NAMES[profile.custody]} · ${crimeName(profile.conviction.crimeId)}\n` +
        `Sentence ${profile.sentenceMonths} months · ${profile.servedMonths} served\n` +
        `${task2.institution.knownAssessment(selected.id).cases} active intelligence case(s)` +
        (selected.protectiveCustody ? " · Protective Custody" : "");
    } else inspectProfile.textContent = "";
    inspector.classList.add("show");
  }

  const intelRoster = document.getElementById("intelRoster")!;
  const intelProfile = document.getElementById("intelProfile")!;
  const intelSearch = document.getElementById("intelSearch") as HTMLInputElement;
  const html = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  function selectIntelligenceAgent(id: number): void {
    selected = agents.agents.find((a) => a.id === id) ?? null;
    overlayT = 0;
    updateInspector();
    updateIntelligenceUi();
  }
  function profileBar(label: string, value: number, max = 10): string {
    return `<div class="profile-row"><span>${html(label)}</span><span class="profile-bar"><i style="width:${Math.round(value / max * 100)}%"></i></span><b>${Math.round(value)}</b></div>`;
  }
  function updateDebugIntelligenceUi(): void {
    const query = intelSearch.value.trim().toLowerCase();
    const prisoners = agents.agents.filter((a) => a.kind === Obj.Prisoner && a.profile).sort((a, b) => a.id - b.id);
    intelRoster.innerHTML = prisoners.filter((a) => {
      const p = a.profile!;
      return !query || `${p.firstName} ${p.lastName} ${crimeName(p.conviction.crimeId)} ${p.labels.join(" ")}`.toLowerCase().includes(query);
    }).map((a) => {
      const p = a.profile!, color = CUSTODY_COLORS[p.custody].map((v) => Math.round(v * 255));
      return `<button class="intel-person${selected?.id === a.id ? " on" : ""}" data-agent="${a.id}"><strong><i class="custody-dot" style="background:rgb(${color.join(",")})"></i>${html(p.firstName)} ${html(p.lastName)}</strong><small>${CUSTODY_NAMES[p.custody]} · ${html(crimeName(p.conviction.crimeId))} · INT ${p.aptitudes.intelligence}</small></button>`;
    }).join("") || `<div class="profile-sub">No matching inmates.</div>`;
    intelRoster.querySelectorAll<HTMLButtonElement>("[data-agent]").forEach((el) => el.onclick = () => selectIntelligenceAgent(Number(el.dataset.agent)));
    if (!selected?.profile) {
      intelProfile.innerHTML = `<div class="profile-title">Developer diagnostic</div><div class="profile-sub">This renderer is not connected to the normal player interface.</div>`;
      return;
    }
    const p = selected.profile, mind = selected.mind!;
    const color = CUSTODY_COLORS[p.custody].map((v) => Math.round(v * 255));
    const bonds = agents.social.bondsFrom(selected.id).slice(0, 10);
    const facts = agents.social.intelFor(selected.id).slice(0, 12);
    const clique = agents.social.cliqueFor(selected.id);
    const op = agents.escapeOperations.operationFor(selected);
    const aptitudes = APTITUDE_IDS.map((id) => profileBar(APTITUDE_NAMES[id], p.aptitudes[id])).join("");
    const personalities = PERSONALITY_IDS.map((id) => profileBar(`${PERSONALITY_NAMES[id][0]} / ${PERSONALITY_NAMES[id][1]}`, (p.personality[id] + 1) * 5)).join("");
    const skills = SKILL_IDS.filter((id) => p.skills[id].level > 0).map((id) => profileBar(SKILL_NAMES[id], p.skills[id].level)).join("") || `<div class="profile-sub">No developed skills.</div>`;
    const relationRows = bonds.map((b) => {
      const other = agents.agents.find((a) => a.id === b.to)?.profile;
      return `<li>${other ? html(`${other.firstName} ${other.lastName}`) : `Inmate #${b.to}`} — affinity ${Math.round(b.affinity * 100)}, trust ${Math.round(b.trust * 100)}, respect ${Math.round(b.respect * 100)}, fear ${Math.round(b.fear * 100)}${b.grievances ? `, ${b.grievances} grievance${b.grievances === 1 ? "" : "s"}` : ""}</li>`;
    }).join("") || `<li>No meaningful relationships yet.</li>`;
    const factRows = facts.map((f) => `<li>${f.firsthand ? "Confirmed" : "Rumor"} ${html(f.type)}: ${html(f.subject)} — ${Math.round(f.confidence * 100)}% confidence${f.sourceId !== selected!.id ? `, source #${f.sourceId}` : ""}</li>`).join("") || `<li>No recorded intelligence yet.</li>`;
    const operationRows = op ? op.members.map((m) => {
      const member = agents.agents.find((a) => a.id === m.agentId)?.profile;
      return `<li>${member ? html(`${member.firstName} ${member.lastName}`) : `#${m.agentId}`} — ${m.role}${m.parentId >= 0 ? `, reports to #${m.parentId}` : ""}${m.ready ? " · ready" : " · waiting"}</li>`;
    }).join("") : "";
    intelProfile.innerHTML = `<div class="profile-title"><i class="custody-dot" style="background:rgb(${color.join(",")})"></i>${html(p.firstName)} ${html(p.lastName)}</div>` +
      `<div class="profile-sub">Inmate #${selected.id} · ${CUSTODY_NAMES[p.custody]} custody · age ${p.age} · ${html(crimeName(p.conviction.crimeId))} · ${p.sentenceMonths} month sentence (${p.servedMonths} served)</div>` +
      `<div class="profile-labels">${p.labels.map((l) => `<span class="profile-label">${html(l)}</span>`).join("")}</div>` +
      `<div class="profile-kpis"><div class="profile-kpi"><small>Stress</small><strong>${Math.round(mind.stress * 100)}%</strong></div><div class="profile-kpi"><small>Anger</small><strong>${Math.round(mind.anger * 100)}%</strong></div><div class="profile-kpi"><small>Confidence</small><strong>${Math.round(mind.confidence * 100)}%</strong></div><div class="profile-kpi"><small>Reputation</small><strong>${Math.round(mind.reputation * 100)}%</strong></div></div>` +
      `<div class="profile-section"><h3>Aptitudes</h3><div class="profile-grid">${aptitudes}</div></div>` +
      `<div class="profile-section"><h3>Personality</h3><div class="profile-grid">${personalities}</div></div>` +
      `<div class="profile-section"><h3>Skills</h3><div class="profile-grid">${skills}</div></div>` +
      `<div class="profile-section"><h3>Record</h3><ul class="profile-list"><li>Current: ${html(crimeName(p.conviction.crimeId))}, ${p.conviction.sentenceMonths} months</li>${p.priors.map((r) => `<li>Prior at age ${r.ageAtConviction}: ${html(crimeName(r.crimeId))}, ${r.sentenceMonths} months</li>`).join("") || "<li>No prior convictions.</li>"}</ul></div>` +
      `<div class="profile-section"><h3>Social${clique ? ` · Clique ${clique.id} (${clique.members.length})` : ""}</h3><ul class="profile-list">${relationRows}</ul></div>` +
      `<div class="profile-section"><h3>Intelligence</h3><ul class="profile-list">${factRows}</ul></div>` +
      `<div class="profile-section"><h3>Escape operation</h3>${op ? `<div class="profile-sub">${html(agents.escapeOperations.operationSummary(op.id))}<br>${html(op.blocker || "No current blocker")} · cache ${op.cache.spoons} spoons / ${op.cache.cutters} cutters</div><ul class="profile-list">${operationRows}</ul>` : `<div class="profile-sub">No active operation.</div>`}</div>`;
  }
  void updateDebugIntelligenceUi; // retained as an unreachable developer diagnostic renderer
  function updateIntelligenceUi(): void {
    const query = intelSearch.value.trim().toLowerCase();
    const prisoners = agents.agents.filter((a) => a.kind === Obj.Prisoner && a.profile).sort((a, b) => a.id - b.id);
    intelRoster.innerHTML = prisoners.filter((a) => {
      const p = a.profile!;
      return !query || `${p.firstName} ${p.lastName} ${crimeName(p.conviction.crimeId)} ${p.custody}`.toLowerCase().includes(query);
    }).map((a) => {
      const p = a.profile!, color = CUSTODY_COLORS[p.custody].map((v) => Math.round(v * 255));
      const known = task2.institution.knownAssessment(a.id);
      return `<button class="intel-person${selected?.id === a.id ? " on" : ""}" data-agent="${a.id}"><strong><i class="custody-dot" style="background:rgb(${color.join(",")})"></i>${html(p.firstName)} ${html(p.lastName)}</strong><small>${CUSTODY_NAMES[p.custody]}${a.protectiveCustody ? " / Protective" : ""} · ${html(crimeName(p.conviction.crimeId))} · ${known.cases} case(s)</small></button>`;
    }).join("") || `<div class="profile-sub">No matching official records.</div>`;
    intelRoster.querySelectorAll<HTMLButtonElement>("[data-agent]").forEach((el) => el.onclick = () => selectIntelligenceAgent(Number(el.dataset.agent)));
    if (!selected?.profile) {
      intelProfile.innerHTML = `<div class="profile-title">Select an inmate</div><div class="profile-sub">Only official records and sourced staff intelligence are shown. Traits, private relationships, money, stashes, gangs, and escape plans are not omnisciently exposed.</div>`;
      return;
    }
    const p = selected.profile, color = CUSTODY_COLORS[p.custody].map((v) => Math.round(v * 255));
    const cases = [...task2.institution.cases.values()].filter((c) => c.subjectIds.includes(selected!.id) && c.status !== "resolved");
    const caseRows = cases.map((c) => {
      const evidence = c.evidenceIds.map((id) => task2.institution.evidence.get(id)).filter((e) => e?.shared)
        .map((e) => `<li>${html(e!.summary)} · ${Math.round(e!.confidence * 100)}% · ${html(e!.sourceType)}</li>`).join("");
      return `<div class="matrix-row"><header><strong>${html(c.title)}</strong><span>${Math.round(c.confidence * 100)}% · ${c.status}</span></header><ul class="profile-list">${evidence || "<li>No shared evidence.</li>"}</ul>${c.alternatives.length ? `<small>Alternative: ${html(c.alternatives[0])}</small>` : ""}</div>`;
    }).join("") || `<div class="profile-sub">No evidence-backed active cases.</div>`;
    const discipline = task2.institution.punishments.filter((o) => o.prisonerId === selected!.id)
      .map((o) => `<li>${html(task2.institution.incidents.get(o.incidentId)?.category ?? "incident")} · ${o.state}${o.search !== "none" ? ` · ${o.search} search` : ""}${o.interrogate ? " · interview" : ""}</li>`).join("") || `<li>No formal discipline.</li>`;
    const medical = task2.health.state(selected.id);
    const formalInjuries = medical?.injuries.filter((i) => i.treated).map((i) => `${i.region} ${i.type}`).join(", ") || "No treated injuries on record";
    const managementRows = [...task3.management.reports.values()].filter((report) => report.expiresAt > worldTime &&
      (report.summary.includes(`inmate ${selected!.id}`) || report.evidenceIds.some((id) => task2.institution.evidence.get(id)?.subjectId === selected!.id)))
      .sort((a, b) => b.createdAt - a.createdAt).map((report) => `<li>${html(report.title)} · ${Math.round(report.confidence * 100)}%: ${html(report.summary)}</li>`).join("") || `<li>No management report names this inmate.</li>`;
    const gangKnown = cases.some((c) => c.incidentIds.some((id) => task2.institution.incidents.get(id)?.category === "gang"));
    const gang = gangKnown ? task2.gangs.gangFor(selected.id) : null;
    const knownTerritory = gang ? task3.territories.knownTerritories(task2.institution).filter((row) => row.controllerId === gang.id || row.contestedBy === gang.id) : [];
    const territoryRows = knownTerritory.map((row) => `<li>Area ${row.areaId}: ${html(row.state)} influence${row.state === "contested" ? "; competing affiliation also indicated" : ""}</li>`).join("") || `<li>No evidence-supported territory assessment.</li>`;
    intelProfile.innerHTML = `<div class="profile-title"><i class="custody-dot" style="background:rgb(${color.join(",")})"></i>${html(p.firstName)} ${html(p.lastName)}</div>` +
      `<div class="profile-sub">Inmate #${selected.id} · ${CUSTODY_NAMES[p.custody]} custody${selected.protectiveCustody ? " · Protective Custody" : ""} · age ${p.age} · ${p.sentenceMonths} month sentence (${p.servedMonths} served)</div>` +
      `<div class="profile-section"><h3>Official record</h3><ul class="profile-list"><li>Current conviction: ${html(crimeName(p.conviction.crimeId))}, ${p.conviction.sentenceMonths} months</li>${p.priors.map((r) => `<li>Prior at age ${r.ageAtConviction}: ${html(crimeName(r.crimeId))}, ${r.sentenceMonths} months</li>`).join("") || "<li>No prior convictions.</li>"}<li>Medical: ${html(formalInjuries)}</li></ul></div>` +
      `<div class="profile-section"><h3>Case assessments</h3><div class="matrix">${caseRows}</div></div>` +
      `<div class="profile-section"><h3>Analyst reports</h3><ul class="profile-list">${managementRows}</ul></div>` +
      `<div class="profile-section"><h3>Known affiliation footprint</h3><ul class="profile-list">${territoryRows}</ul></div>` +
      `<div class="profile-section"><h3>Formal discipline</h3><ul class="profile-list">${discipline}</ul></div>` +
      `<div class="profile-section"><h3>Information limits</h3><div class="profile-sub">Unreported traits, emotions, affiliations, relationships, possessions, contacts, caches, and plans remain unknown. Confidence reflects shared evidence, not ground truth.</div></div>`;
  }
  intelSearch.addEventListener("input", updateIntelligenceUi);

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const tile = tileFromEvent(e);
    if (!tile) return;
    // Persistent planned ghosts always win the click, even if another build
    // tool is selected. Cancellation keeps already completed group targets.
    if (construction.cancelAt(tile.x, tile.z, world)) {
      saveDirty = true;
      return;
    }
    if (!editor.active) { selectAt(e); return; }
    painting = true;
    lastTX = lastTZ = -99999;
    dragStart = tile;
    dragAxis = null;
    dragPlaced = new Set();
    if (editor.tool?.cat === "room") {
      editor.roomDrag = world.startRoomPaint(tile.x, tile.z, editor.tool.mat);
    }
    if (editor.tool?.cat === "patrol") {
      editor.routeDrag = world.startRoute(editor.tool.mat);
    }
    if (!isOrderTool()) paintAt(e);
  });
  canvas.addEventListener("pointermove", (e) => {
    const tile = tileFromEvent(e);
    if (tile) {
      hoverTile = tile;
      if (painting && dragStart && !dragAxis) {
        const dx = tile.x - dragStart.x, dz = tile.z - dragStart.z;
        if (dx !== 0 || dz !== 0) dragAxis = Math.abs(dx) >= Math.abs(dz) ? "x" : "z";
      }
    }
    if (painting && !isOrderTool()) paintAt(e);
  });
  addEventListener("pointerup", (e) => {
    if (e.button !== 0) return;
    if (!painting) return;
    if (isOrderTool()) commitOrder();
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
    if (editor.routeDrag > 0) {
      world.endRoute(editor.routeDrag);
      editor.routeDrag = 0;
      dirty = true;
      saveDirty = true;
    }
  });
  const discardTransient = () => {
    painting = false;
    dragStart = null;
    dragAxis = null;
    dragPlaced.clear();
    if (editor.roomDrag > 0) { world.endRoomPaint(editor.roomDrag); editor.roomDrag = 0; }
    if (editor.routeDrag > 0) { world.removeRoute(editor.routeDrag); editor.routeDrag = 0; }
  };
  canvas.addEventListener("pointercancel", discardTransient);
  canvas.addEventListener("contextmenu", (e) => {
    if (!painting) return;
    e.preventDefault();
    discardTransient();
  });
  addEventListener("keydown", (e) => {
    if ((e.key === "Delete" || e.key === "Backspace") && hoverTile && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault();
      const group = construction.planDemolition(hoverTile.x, hoverTile.z, worldTime, world);
      if (group) { saveDirty = true; notify(`Demolition order ${group.id} created.`); }
      else notify("That location cannot be demolished.");
    }
    if (e.key === "Escape" && painting) discardTransient();
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
    toBuildCargo: "Collecting construction materials", deliverBuildCargo: "Delivering construction materials",
    toBuild: "Walking to a construction site", constructing: "Building", demolishing: "Demolishing",
    toBookCargo: "Collecting library stock", deliverBookCargo: "Stocking the library",
    toExportCargo: "Collecting export goods", deliverExportCargo: "Delivering goods to Exports",
  };
  function debugTipText(ag: Agent): string {
    const kind = ag.kind === 8 ? "Prisoner" : ag.kind === 9 ? "Guard" :
      ag.kind === 20 ? "Cook" : "Workman";
    const doing = STATE_TEXT[ag.state] ?? ag.state;
    const identity = ag.profile ? `${ag.profile.firstName} ${ag.profile.lastName}\n${CUSTODY_NAMES[ag.profile.custody]} · ${crimeName(ag.profile.conviction.crimeId)}` : `${kind} #${ag.id}`;
    let s = `${identity}\n${doing}${ag.socialAction !== "none" ? ` · ${ag.socialAction}` : ""}${ag.underground ? " (underground)" : ""}`;
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
      if (ag.profile && ag.mind) s += `\n${ag.profile.labels.join(" · ")}\nstress ${pc(ag.mind.stress)}  anger ${pc(ag.mind.anger)}  confidence ${pc(ag.mind.confidence)}`;
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
      if (ag.escapeOperationId >= 0) s += `\nOPERATION: ${agents.escapeOperations.operationSummary(ag.escapeOperationId)} · ${ag.escapeRole}`;
      s += `\n${ag.cellRoom >= 0 ? "has a cell" : "no cell"}` +
        (ag.cuffed ? " · handcuffed" : "") +
        (ag.compliant ? " · following regime" : " · DEFYING REGIME") +
        (ag.timesCaught > 0 ? ` · caught ${ag.timesCaught}x` : "");
    }
    return s;
  }
  void debugTipText;
  function tipText(ag: Agent): string {
    const staffNames: Record<number, string> = { [Obj.Guard]: "Guard", [Obj.Cook]: "Cook", [Obj.Workman]: "Workman",
      [Obj.Doctor]: "Doctor", [Obj.Investigator]: "Investigator", [Obj.DogHandler]: "Dog Handler",
      [Obj.ArmedGuard]: "Armed Guard", [Obj.SecurityDog]: "Security Dog", [Obj.Sniper]: "Sniper",
      [Obj.ChiefOfficer]: "Chief Officer", [Obj.Foreman]: "Foreman", [Obj.Accountant]: "Accountant" };
    const kind = ag.kind === Obj.Prisoner ? "Prisoner" : staffNames[ag.kind] ?? "Staff";
    const identity = ag.profile ? `${ag.profile.firstName} ${ag.profile.lastName}\n${CUSTODY_NAMES[ag.profile.custody]} · ${crimeName(ag.profile.conviction.crimeId)}` : `${kind} #${ag.id}`;
    const cases = task2.institution.knownAssessment(ag.id).cases;
    const visible = task2.items.itemsIn(`agent:${ag.id}:hands`).map((item) => itemDefV4(item.defId).name);
    return `${identity}\n${STATE_TEXT[ag.state] ?? ag.state}${ag.socialAction !== "none" ? ` · ${ag.socialAction}` : ""}` +
      (ag.cuffed ? " · restrained" : "") + (cases ? `\n${cases} evidence-backed case(s)` : "") +
      (visible.length ? `\nVisible in hands: ${visible.join(", ")}` : "");
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
    const group = hoverTile ? construction.groupAt(hoverTile.x, hoverTile.z, world) : null;
    if (!ag && !group) { tip.style.display = "none"; return; }
    if (ag) tip.textContent = tipText(ag);
    else if (group) {
      const done = group.targets.filter((target) => target.completed).length;
      const recipe = construction.groupRecipe(group);
      const resources = Object.entries(recipe).map(([id, amount]) => `${commodityDef(id).name} ${amount}`).join(", ") || "none";
      tip.textContent = `${group.operation.toUpperCase()} GROUP ${group.id}\n` +
        `${done}/${group.targets.length} targets complete · ${group.state}\n` +
        `Resources: ${resources}\n${group.blocker || "Click to cancel unfinished targets"}`;
    }
    tip.style.display = "block";
    tip.style.left = `${Math.min(e.clientX + 16, innerWidth - 360)}px`;
    tip.style.top = `${Math.min(e.clientY + 12, innerHeight - 200)}px`;
  });
  canvas.addEventListener("mouseleave", () => { tip.style.display = "none"; hoverTile = null; });

  // --- Retained room labels + warning markers ----------------------------
  const problemButton = document.getElementById("problemButton") as HTMLButtonElement;
  const problemCount = document.getElementById("problemCount")!;
  const problemsPanel = document.getElementById("problemsPanel")!;
  const worldOverlay = new WorldOverlay(
    document.getElementById("roomOverlay")!,
    document.getElementById("cap")!,
    tip,
    () => {
      problemsPanel.classList.add("show");
      problemButton.setAttribute("aria-expanded", "true");
    },
  );
  problemButton.onclick = () => {
    const show = !problemsPanel.classList.contains("show");
    problemsPanel.classList.toggle("show", show);
    problemButton.setAttribute("aria-expanded", String(show));
  };

  function openCatalog(mode: string, section: string): void {
    const button = document.querySelector<HTMLButtonElement>(`.mode-btn[data-mode="${mode}"]`);
    if (activeMode !== mode) button?.click();
    editor.selectCategory(section);
  }

  function renderProblems(): void {
    const rows = problems.list();
    problemCount.textContent = String(rows.length);
    problemButton.classList.toggle("has-critical", rows.some((problem) => problem.severity === "critical"));
    const problemRows = rows.map((problem) => {
      const actions = problem.actions.map((action) => {
        if (action.kind === "catalog") return `<button data-catalog="${html(action.mode)}|${html(action.section)}">${html(action.label)}</button>`;
        if (action.kind === "order") return `<button data-order="${action.orderId}">${html(action.label)}</button>`;
        return `<button data-center="${problem.x},${problem.z}">${html(action.label)}</button>`;
      }).join("");
      return `<div class="problem-row ${problem.severity}"><small>${html(problem.source)} \u00b7 ${html(problem.severity)}</small>${html(problem.message)}<div class="problem-actions">${actions}</div></div>`;
    }).join("") || `<div class="profile-sub">No operational problems.</div>`;
    const activeGroups = [...construction.groups.values()].filter((group) => group.state !== "complete" && group.state !== "cancelled");
    const queueRows = activeGroups.map((group) => {
      const done = group.targets.filter((target) => target.completed).length;
      const targetStates = [...new Set(group.targets.filter((target) => !target.completed).map((target) => target.state))].join(", ");
      return `<div class="queue-row"><header><strong>${group.operation} #${group.id}</strong><span>${done}/${group.targets.length} complete</span></header>` +
        `<p>${html(group.blocker || targetStates || group.state)}</p><div class="queue-actions"><button data-center="${group.targets[0]?.x ?? 0},${group.targets[0]?.z ?? 0}">Center</button>` +
        `<button data-retry-order="${group.id}">Retry</button><button data-cancel-order="${group.id}">Cancel</button></div></div>`;
    }).join("") || `<div class="profile-sub">No active construction orders.</div>`;
    problemsPanel.innerHTML = `<div class="problem-head"><span>Operational problems</span><span>${rows.length}</span></div>${problemRows}<section class="queue-section"><div class="problem-head">Construction queue</div>${queueRows}</section>`;
    problemsPanel.querySelectorAll<HTMLButtonElement>("[data-center]").forEach((button) => button.onclick = () => {
      const [x, z] = button.dataset.center!.split(",").map(Number);
      camera.target = [x, 0, z];
      camera.distance = Math.min(camera.distance, 52);
    });
    problemsPanel.querySelectorAll<HTMLButtonElement>("[data-catalog]").forEach((button) => button.onclick = () => {
      const [mode, section] = button.dataset.catalog!.split("|");
      openCatalog(mode, section);
    });
    problemsPanel.querySelectorAll<HTMLButtonElement>("[data-order]").forEach((button) => button.onclick = () => {
      const group = construction.groups.get(Number(button.dataset.order));
      const target = group?.targets.find((row) => !row.completed);
      if (target) camera.target = [target.x, 0, target.z];
    });
    problemsPanel.querySelectorAll<HTMLButtonElement>("[data-retry-order]").forEach((button) => button.onclick = () => {
      if (construction.retryGroup(Number(button.dataset.retryOrder))) notify("Construction order queued for another attempt.");
    });
    problemsPanel.querySelectorAll<HTMLButtonElement>("[data-cancel-order]").forEach((button) => button.onclick = () => {
      if (construction.cancelGroup(Number(button.dataset.cancelOrder))) { saveDirty = true; notify("Construction order cancelled; unused materials are available for other work."); }
    });
  }
  let worldOverlayDataT = 0;

  function previewShowsFacing(): boolean {
    const cat = editor.tool?.cat;
    return cat === "piece" ||
      cat === "prisoner" || cat === "guard" || cat === "cook" || cat === "workman";
  }

  function refreshWorldOverlayData() {
    problems.clear();
    const rooms = world.roomLabels();
    const issues: IssueLabel[] = agents.issueLabels(world);
    for (const room of rooms) {
      if (!room.valid) issues.push({
        id: `room-${room.id}`,
        x: room.x,
        z: room.z,
        issue: `${room.name} is invalid: ${room.issue}`,
      });
      if (!room.valid) {
        const model = world.rooms.get(room.id);
        const details = model ? world.roomIssues(model) : [];
        const catalog = details.find((detail) => detail.suggestedCatalog)?.suggestedCatalog ?? "";
        problems.add({
          id: `room-${room.id}`, severity: room.name === "Reception" || room.name === "Delivery Yard" ? "critical" : "warning",
          source: "room", message: `${room.name}: ${room.issue}`, x: room.x, z: room.z,
          actions: [
            { kind: "center", label: "Center" },
            ...(catalog ? [{ kind: "catalog" as const, label: "Build requirement", mode: catalog.startsWith("objects:") ? "objects" : "build", section: catalog }] : []),
          ],
        });
      }
    }
    if (incompatibleSave) issues.push({
      id: "save-v1", x: 366, z: 375,
      issue: "The older save is incompatible. This is a fresh version 6 gameplay-polish world.",
    });
    let warningI = 0;
    const activeOrders = [...construction.groups.values()].some((group) => group.state !== "complete" && group.state !== "cancelled");
    if (activeOrders && !agents.agents.some((agent) => agent.kind === Obj.Workman)) issues.push({
      id: "no-workmen", x: 366.5, z: 375.5, issue: "Construction is waiting: hire a workman.",
    });
    if (activeOrders && !agents.agents.some((agent) => agent.kind === Obj.Workman)) problems.add({
      id: "no-workmen", severity: "critical", source: "staff", message: "Construction is waiting: hire a workman.",
      x: 366.5, z: 375.5, actions: [{ kind: "catalog", label: "Hire workman", mode: "staff", section: "staff:people" }],
    });
    for (const group of construction.groups.values()) {
      if (group.state === "complete" || group.state === "cancelled") continue;
      const blocked = group.targets.find((target) => target.state === "blocked");
      if (!blocked && group.state !== "waiting-resources") continue;
      problems.add({
        id: `construction-${group.id}`, severity: blocked ? "warning" : "info", source: "construction",
        message: `Order ${group.id}: ${blocked?.blocker || group.blocker || "Waiting for materials"}`,
        x: blocked?.x ?? group.targets[0]?.x ?? 0, z: blocked?.z ?? group.targets[0]?.z ?? 0,
        actions: [{ kind: "order", label: "Open order", orderId: group.id }],
      });
    }
    const hasSalvage = [...logistics.packages.values()].some((pkg) => pkg.state === "site");
    const validExports = [...world.rooms.values()].some((room) => room.type === RoomType.Exports && room.valid);
    if (hasSalvage && !validExports) issues.push({
      id: "no-exports", x: 367.5, z: 376.5, issue: "Recovered goods are waiting for a valid Exports room.",
    });
    const validReception = [...world.rooms.values()].some((room) => room.type === RoomType.Reception && room.valid);
    if (!validReception) issues.push({
      id: "no-reception", x: 369.5, z: 374.5, issue: "No valid Reception: the next prisoner transport will wait on the road.",
    });
    if (!validReception) problems.add({
      id: "no-reception", severity: "critical", source: "intake",
      message: "No valid Reception. Intake remains paused until one is operational.",
      x: 369.5, z: 374.5, actions: [{ kind: "catalog", label: "Build Reception", mode: "rooms", section: "rooms:staff" }],
    });
    for (const bridge of world.piecesOfKind(Obj.SecureBridge)) if (!world.bridgeIsSecure(bridge)) issues.push({
      id: `bridge-${bridge.id}`, x: bridge.x + bridge.w / 2, z: bridge.z + 1,
      issue: "Secure Bridge ends are not enclosed by connected walls or fences.",
    });
    for (const warning of logistics.warnings) issues.push({
      id: `logistics-${warningI++}`, x: 370.5, z: 375.5 + warningI,
      issue: warning,
    });
    for (const warning of logistics.warnings) problems.add({
      id: `logistics-${warning}`, severity: warning.includes("Insufficient") ? "critical" : "warning", source: "logistics",
      message: warning, x: 370.5, z: 375.5,
      actions: [{ kind: "catalog", label: "Open facilities", mode: "logistics", section: "objects:logistics" }],
    });
    for (const warning of kitchen.warnings) issues.push({
      id: `kitchen-${warningI++}`, x: 368.5, z: 373.5 + warningI,
      issue: warning,
    });
    for (const warning of kitchen.warnings) problems.add({
      id: `kitchen-${warning}`, severity: "warning", source: "kitchen", message: warning, x: 368.5, z: 373.5,
      actions: [{ kind: "catalog", label: "Open dining objects", mode: "objects", section: "objects:dining" }],
    });
    for (const warning of intake.warnings) issues.push({
      id: `intake-${warningI++}`, x: 374.5, z: 370.5 + warningI,
      issue: warning,
    });
    for (const warning of intake.warnings) problems.add({
      id: `intake-${warning}`, severity: "critical", source: "intake", message: warning, x: 374.5, z: 370.5,
      actions: [{ kind: "catalog", label: "Open Reception", mode: "rooms", section: "rooms:staff" }],
    });
    for (const warning of task2.warnings) issues.push({
      id: `task2-${warningI++}`, x: 369.5, z: 376.5 + warningI, issue: warning,
    });
    for (const warning of task2.work.warnings) problems.add({
      id: `work-${warning}`, severity: "warning", source: "work", message: warning, x: 369.5, z: 376.5,
      actions: [{ kind: "catalog", label: "Open work facilities", mode: "objects", section: "objects:work" }],
    });
    for (const warning of task3.warnings) issues.push({
      id: `task3-${warningI++}`, x: 371.5, z: 376.5 + warningI, issue: warning,
    });
    worldOverlay.updateData(rooms, issues, agents.prisonerCount(), world.prisonerCapacity());
    renderProblems();
  }

  let saveInFlight = false;
  let saveTimer = 0;
  const saveStatusEl = document.getElementById("saveStatus")!;
  function saveSnapshot(): unknown {
    return {
      version: SAVE_VERSION,
      savedAt: new Date().toISOString(),
      worldTime,
      world: world.saveData(),
      agents: agents.saveData(),
      infrastructure: infrastructure.saveData(),
      economy: economy.saveData(),
      logistics: logistics.saveData(),
      construction: construction.saveData(),
      kitchen: kitchen.saveData(),
      intake: intake.saveData(),
      task2: task2.saveData(),
      task3: task3.saveData(),
    };
  }
  async function saveNow() {
    if (saveInFlight) return;
    saveInFlight = true;
    saveStatusEl.textContent = "Saving\u2026";
    try {
      await saveRepository.save(saveSnapshot());
      saveDirty = false;
      saveStatusEl.textContent = `Saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    } catch (error) {
      saveStatusEl.textContent = "Save failed";
      notify(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
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
      // States where standing still for a long time is the whole point, so they
      // are not evidence of a stuck agent.
      const RESTING = [
        "using", "sleepFloor", "reading", "inCell", "cuffed", "queueing",
        "knockedOut", "stakeout", "manning", "cooking", "scanning", "aiming",
      ];
      if (stillFor > 90 && !RESTING.includes(ag.state)) {
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
  const escapedEl = document.getElementById("escaped");
  const caughtEl = document.getElementById("caught");
  const cashEl = document.getElementById("cash");
  const netHourlyEl = document.getElementById("netHourly");
  let last = performance.now();
  let fpsAccum = 0, fpsFrames = 0, fps = 0;
  let clockUiKey = "";
  let logisticsUiT = 0;
  let intelligenceUiT = 0;
  let logisticsRenderT = 0;
  let ghostRenderT = 0;

  function updateLegacyLogisticsUi(): void {
    const lines = logistics.stockLines();
    const stockRows = lines.length > 0 ? lines.map((line) =>
      `<tr><td>${commodityDef(line.commodity).name}</td><td>${line.available}</td><td>${line.inTransit}</td><td>${line.reserved}</td></tr>`).join("")
      : `<tr><td colspan="4">No stock ordered</td></tr>`;
    const blocked = logistics.trucks.filter((truck) => truck.state === "blocked").length +
      intake.vehicles.filter((vehicle) => vehicle.state === "waiting" && vehicle.warning).length;
    const recent = economy.ledger.slice(-8).reverse().map((entry) =>
      `${entry.amount >= 0 ? "+" : "−"}$${Math.abs(Math.round(entry.amount))}  ${entry.memo}`).join("<br>") || "No ledger entries yet";
    const daily = new Map<string, number>();
    for (const entry of economy.ledger) if (entry.time >= worldTime - HOUR_SECONDS * 24) {
      daily.set(entry.kind, (daily.get(entry.kind) ?? 0) + entry.amount);
    }
    const dailyRows = ["grant", "wage", "purchase", "loss", "fee", "export", "interest", "hire"]
      .map((kind) => `<tr><td>${kind}</td><td>${(daily.get(kind) ?? 0) >= 0 ? "+" : "−"}$${Math.abs(Math.round(daily.get(kind) ?? 0))}</td></tr>`).join("");
    logisticsDashboard.innerHTML = `<div class="log-title">Physical logistics</div>` +
      `<div class="log-summary"><div class="log-kpi"><small>Vehicles</small><strong>${logistics.trucks.length + intake.vehicles.length}</strong></div>` +
      `<div class="log-kpi"><small>Blocked</small><strong>${blocked}</strong></div>` +
      `<div class="log-kpi"><small>Exports</small><strong>$${Math.round(logistics.expectedExportCredit())}</strong></div></div>` +
      `<table class="log-table"><thead><tr><th>Commodity</th><th>Here</th><th>Transit</th><th>Reserved</th></tr></thead><tbody>${stockRows}</tbody></table>` +
      `<table class="log-table"><thead><tr><th>Last 24 hours</th><th>Amount</th></tr></thead><tbody>${dailyRows}</tbody></table>` +
      `<div class="log-ledger"><strong>Recent ledger</strong><br>${recent}</div>`;

    const detail = document.querySelector<HTMLElement>("#detailCost strong");
    if (detail && editor.tool && isOrderTool()) {
      const count = Math.max(1, orderTargets().length);
      const recipe = construction.estimate(editor.tool, count);
      const parts = Object.entries(recipe).map(([id, need]) => {
        const available = Math.max(0, logistics.quantity(id) - logistics.reserved(id));
        const ordered = logistics.incoming(id);
        const missing = Math.max(0, need - available - ordered);
        return `${commodityDef(id).name} ${available}/${need}${ordered ? ` +${ordered} inbound` : ""}${missing ? ` (${missing} missing)` : ""}`;
      });
      detail.textContent = `$${recipeCost(recipe).toLocaleString()} · ${parts.join(", ")}`;
    }
  }

  void updateLegacyLogisticsUi;
  let logisticsTab: "shipments" | "deployment" | "access" | "work" = "shipments";
  const logisticsTabs = ["shipments", "deployment", "access", "work"] as const;
  function tabBar(): string { return `<div class="dash-tabs">${logisticsTabs.map((tab) => `<button class="dash-tab${logisticsTab === tab ? " on" : ""}" data-logtab="${tab}">${tab}</button>`).join("")}</div>`; }

  function updateLogisticsUi(): void {
    let body = "";
    if (logisticsTab === "shipments") {
      const lines = logistics.stockLines();
      const stockRows = lines.length ? lines.map((line) => `<tr><td>${html(commodityDef(line.commodity).name)}</td><td>${line.available}</td><td>${line.inTransit}</td><td>${line.reserved}</td></tr>`).join("") : `<tr><td colspan="4">No stock ordered</td></tr>`;
      const blocked = logistics.trucks.filter((truck) => truck.state === "blocked").length + intake.vehicles.filter((vehicle) => vehicle.state === "waiting" && vehicle.warning).length + [...task3.escape.externalVehicles.values()].filter((vehicle) => vehicle.state === "blocked").length;
      const forecast = intake.forecast(worldTime, world, agents);
      const palletRows = logistics.palletUtilization(world).map((row) => `<div class="matrix-row"><header><strong>Delivery Yard ${row.roomId}</strong><span>${row.used}/${row.capacity} pallet slots used</span></header></div>`).join("");
      const vehicleRows = logistics.trucks.map((truck) => `<div class="matrix-row"><header><strong>${truck.kind} truck ${truck.id}</strong><span>${truck.state}</span></header><small>${truck.packageIds.length} package${truck.packageIds.length === 1 ? "" : "s"}${truck.warning ? ` \u00b7 ${html(truck.warning)}` : ""}</small></div>`).join("");
      body = `<div class="log-summary"><div class="log-kpi"><small>Vehicles</small><strong>${logistics.trucks.length + intake.vehicles.length + task3.escape.externalVehicles.size}</strong></div><div class="log-kpi"><small>Blocked</small><strong>${blocked}</strong></div><div class="log-kpi"><small>Unique items</small><strong>${[...task2.items.items.values()].filter((i) => i.locationKind !== "destroyed").length}</strong></div></div>` +
        `<table class="log-table"><thead><tr><th>Commodity</th><th>Here</th><th>Transit</th><th>Reserved</th></tr></thead><tbody>${stockRows}</tbody></table>` +
        `<div class="log-ledger">Controlled discrepancies: ${task2.items.controlledDiscrepancies().length} · Export credit expected: $${Math.round(logistics.expectedExportCredit())}</div>`;
      body += `<div class="log-ledger">Next intake: Day ${forecast.day} \u00b7 ${forecast.ready ? `up to ${forecast.capacity} available bed${forecast.capacity === 1 ? "" : "s"}` : "paused until Reception and beds are ready"}</div>` +
        `<div class="profile-section"><h3>Facilities</h3><div class="problem-actions"><button data-open-catalog="objects:logistics">Build logistics objects</button><button data-open-catalog="rooms:logistics">Paint Delivery / Exports</button></div><div class="matrix">${palletRows || "No valid Delivery Yard."}</div></div>` +
        `<div class="profile-section"><h3>Vehicle manifests</h3><div class="matrix">${vehicleRows || "No active vehicles."}</div></div>`;
      const gates = [...task3.facility.gatehouses.values()].map((gate) => `<div class="matrix-row"><header><strong>Gatehouse ${gate.pieceId}</strong><span>${gate.guardId >= 0 ? `Manned by guard ${gate.guardId}` : "Unmanned"}</span></header><label>Outgoing inspection <select class="work-select" data-gate-inspection="${gate.pieceId}">${["none", "spot", "standard", "full"].map((value) => `<option ${gate.inspection === value ? "selected" : ""}>${value}</option>`).join("")}</select></label>${gate.warning ? `<small>${html(gate.warning)}</small>` : ""}</div>`).join("");
      body += `<div class="profile-section"><h3>Road control</h3><div class="matrix">${gates || `<div class="profile-sub">No Gatehouse is built. Outgoing vehicles cannot be inspected at the road boundary.</div>`}</div></div>`;
    } else if (logisticsTab === "deployment") {
      const roles = ["guard", "armed-guard", "investigator", "dog-handler", "doctor", "cook", "workman", "chief", "foreman", "accountant"] as const;
      body = `<div class="profile-sub">Set persistent staffing by structural area. Fatigued staff temporarily leave their assignment open for a qualified spare.</div><div class="matrix">` +
        [...task2.areas.areas.values()].sort((a, b) => a.id - b.id).map((area) => {
          const row = task2.security.deploymentTargets.get(area.id) ?? {};
          return `<div class="matrix-row"><header><strong>Area ${area.id}${area.exterior ? " · Exterior" : ""}</strong><span>${area.tiles.size.toLocaleString()} tiles</span></header><div class="toggle-grid">${roles.map((role) => {
            const n = row[role] ?? 0; return `<span>${role} <button class="tiny-btn" data-deploy="${area.id}:${role}:-1">−</button> <b>${n}</b> <button class="tiny-btn" data-deploy="${area.id}:${role}:1">+</button></span>`;
          }).join("")}</div></div>`;
        }).join("") + `</div>`;
    } else if (logisticsTab === "access") {
      const roles = ["prisoner", "worker", "guard", "armed-guard", "investigator", "dog-handler", "doctor", "cook", "workman", "chief", "foreman", "accountant", "staff", "driver", "visitor"] as const;
      const custody = ["minimum", "medium", "maximum", "supermax", "protective"] as const;
      body = `<div class="profile-sub">Access is binary by structural area. With mixing disabled, the first admitted custody class reserves the area until it empties.</div><div class="matrix">` +
        [...task2.areas.areas.values()].sort((a, b) => a.id - b.id).map((area) => {
          const p = task2.areas.access.get(area.id)!;
          return `<div class="matrix-row"><header><strong>Area ${area.id}${area.exterior ? " · Exterior" : ""}</strong><label>Mixed <input type="checkbox" data-area-mixed="${area.id}" ${p.mixed ? "checked" : ""}></label></header>` +
            `<div class="toggle-grid">${custody.map((c) => `<label><input type="checkbox" data-area-custody="${area.id}:${c}" ${p.custody[c] ? "checked" : ""}>${c}</label>`).join("")}</div>` +
            `<div class="toggle-grid">${roles.map((r) => `<label><input type="checkbox" data-area-role="${area.id}:${r}" ${p.roles[r] ? "checked" : ""}>${r}</label>`).join("")}</div>` +
            (!p.mixed && p.reservedCustody ? `<small>Reserved now: ${p.reservedCustody}</small>` : "") + `</div>`;
        }).join("") + `</div>`;
    } else {
      const workplaces = [...task2.work.workplaces.values()].sort((a, b) => a.roomId - b.roomId);
      const workerRows = agents.agents.filter((a) => a.kind === Obj.Prisoner && a.profile).sort((a, b) => a.id - b.id).map((agent) => {
        const current = task2.work.assignments.get(agent.id) ?? -1;
        return `<div class="matrix-row"><header><strong>${html(`${agent.profile!.firstName} ${agent.profile!.lastName}`)}</strong><span>${CUSTODY_NAMES[agent.profile!.custody]}</span></header><select class="work-select" data-work-agent="${agent.id}"><option value="-1">Unassigned</option>${workplaces.map((w) => `<option value="${w.roomId}" ${current === w.roomId ? "selected" : ""}>${html(w.jobId)} · room ${w.roomId} (${w.assigned.length}/${w.capacity})</option>`).join("")}</select></div>`;
      }).join("");
      body = `<div class="matrix">${workplaces.map((w) => `<div class="matrix-row"><header><strong>${html(w.jobId)} · room ${w.roomId}</strong><span>${w.active.length}/${w.assigned.length}/${w.capacity} active/assigned/capacity</span></header><label>Supervision <select class="work-select" data-supervision="${w.roomId}">${["none", "periodic", "constant"].map((s) => `<option ${w.supervision === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>${w.blocked ? `<small>${html(w.blocked)}</small>` : ""}</div>`).join("")}</div><div class="profile-section"><h3>Inmate assignments</h3><div class="matrix">${workerRows || "No inmates available."}</div></div>`;
    }
    logisticsDashboard.innerHTML = `<div class="log-title">Institutional logistics</div>${tabBar()}${body}`;
    logisticsDashboard.querySelectorAll<HTMLButtonElement>("[data-logtab]").forEach((button) => button.onclick = () => { logisticsTab = button.dataset.logtab as typeof logisticsTab; updateLogisticsUi(); });
    logisticsDashboard.querySelectorAll<HTMLButtonElement>("[data-open-catalog]").forEach((button) => button.onclick = () => openCatalog("logistics", button.dataset.openCatalog!));
    logisticsDashboard.querySelectorAll<HTMLButtonElement>("[data-deploy]").forEach((button) => button.onclick = () => {
      const [area, role, delta] = button.dataset.deploy!.split(":"); const row = task2.security.deploymentTargets.get(Number(area)) ?? {};
      task2.security.setDeployment(Number(area), role as never, (row[role as keyof typeof row] ?? 0) + Number(delta)); saveDirty = true; updateLogisticsUi();
    });
    logisticsDashboard.querySelectorAll<HTMLInputElement>("[data-area-mixed]").forEach((input) => input.onchange = () => { task2.areas.access.get(Number(input.dataset.areaMixed))!.mixed = input.checked; saveDirty = true; });
    logisticsDashboard.querySelectorAll<HTMLInputElement>("[data-area-custody]").forEach((input) => input.onchange = () => { const [area, key] = input.dataset.areaCustody!.split(":"); (task2.areas.access.get(Number(area))!.custody as Record<string, boolean>)[key] = input.checked; saveDirty = true; });
    logisticsDashboard.querySelectorAll<HTMLInputElement>("[data-area-role]").forEach((input) => input.onchange = () => { const [area, key] = input.dataset.areaRole!.split(":"); (task2.areas.access.get(Number(area))!.roles as Record<string, boolean>)[key] = input.checked; saveDirty = true; });
    logisticsDashboard.querySelectorAll<HTMLSelectElement>("[data-work-agent]").forEach((select) => select.onchange = () => { const id = Number(select.dataset.workAgent); task2.work.unassign(id); if (Number(select.value) >= 0) task2.work.assign(id, Number(select.value)); saveDirty = true; });
    logisticsDashboard.querySelectorAll<HTMLSelectElement>("[data-supervision]").forEach((select) => select.onchange = () => { const w = task2.work.workplaces.get(Number(select.dataset.supervision)); if (w) w.supervision = select.value as never; saveDirty = true; });
    logisticsDashboard.querySelectorAll<HTMLSelectElement>("[data-gate-inspection]").forEach((select) => select.onchange = () => { task3.facility.setInspection(Number(select.dataset.gateInspection), select.value as never); saveDirty = true; updateLogisticsUi(); });
    const detail = document.querySelector<HTMLElement>("#detailCost strong");
    if (detail && editor.tool && isOrderTool()) {
      const recipe = construction.estimate(editor.tool, Math.max(1, orderTargets().length));
      const invalid = construction.preview(editor.tool, orderTargets(), editor.orient, world).find((target) => !target.valid);
      detail.textContent = invalid
        ? `Cannot place: ${invalid.blocker}`
        : `$${recipeCost(recipe).toLocaleString()} · ${Object.entries(recipe).map(([id, n]) => `${commodityDef(id).name} ${Math.max(0, logistics.quantity(id) - logistics.reserved(id))}/${n}`).join(", ")}`;
    } else if (detail && editor.tool?.cat === "person") {
      detail.textContent = `$${economy.hireFee(editor.tool.mat).toLocaleString()} hire · $${economy.hourlyWage(editor.tool.mat)}/hour`;
    }
  }

  function updateFinancialsUi(): void {
    const daily = new Map<string, number>(); for (const entry of economy.ledger) if (entry.time >= worldTime - HOUR_SECONDS * 24) daily.set(entry.kind, (daily.get(entry.kind) ?? 0) + entry.amount);
    const recent = economy.ledger.slice(-30).reverse().map((entry) => `<tr><td>${clockLabel(entry.time)}</td><td>${html(entry.kind)}</td><td>${html(entry.memo)}</td><td>${entry.amount >= 0 ? "+" : "−"}$${Math.abs(Math.round(entry.amount))}</td></tr>`).join("");
    financialsDashboard.innerHTML = `<div class="log-title">Financials</div><div class="log-summary"><div class="log-kpi"><small>Cash</small><strong>${economy.cash < 0 ? "−" : ""}$${Math.abs(Math.round(economy.cash)).toLocaleString()}</strong></div><div class="log-kpi"><small>Net / hour</small><strong>$${economy.netHourly()}</strong></div><div class="log-kpi"><small>Performance</small><strong>${Math.round(economy.performanceMultiplier * 100)}%</strong></div></div>` +
      `<table class="log-table"><thead><tr><th>Last 24 hours</th><th>Net</th></tr></thead><tbody>${[...daily].map(([k, v]) => `<tr><td>${html(k)}</td><td>${v >= 0 ? "+" : "−"}$${Math.abs(Math.round(v))}</td></tr>`).join("")}</tbody></table>` +
      `<div class="profile-section"><h3>Ledger</h3><table class="log-table"><thead><tr><th>Time</th><th>Type</th><th>Memo</th><th>Amount</th></tr></thead><tbody>${recent || `<tr><td colspan="4">No entries</td></tr>`}</tbody></table></div>`;
    const procedures = ["spoon-count", "tray-count", "key-signout", "tool-count", "shipment-manifest", "till-reconcile", "floor-survey", "dual-evidence"] as const;
    const reportRows = [...task3.management.reports.values()].filter((report) => report.expiresAt > worldTime).sort((a, b) => b.createdAt - a.createdAt).map((report) => `<div class="matrix-row"><header><strong>${html(report.title)}</strong><span>${html(report.manager)} · ${Math.round(report.confidence * 100)}%</span></header><div>${html(report.summary)}</div><small>${html(report.recommendation)}</small></div>`).join("");
    financialsDashboard.innerHTML += `<div class="profile-section"><h3>Temporary controls</h3><div class="profile-sub">Controls improve detection but consume staff time. A compromised employee may warn an inmate or quietly bypass the procedure.</div><div class="toggle-grid">${procedures.map((id) => { const active = task3.management.procedure(id, worldTime), manager = task3.management.procedureManager(id), enabled = task3.management.canActivateProcedure(id); return `<button class="tiny-btn${active ? " on" : ""}" data-procedure="${id}" ${!active && !enabled ? "disabled" : ""}>${html(id)} · ${manager}${active ? ` · ${Math.max(1, Math.ceil((active.activeUntil - worldTime) / HOUR_SECONDS))}h` : ""}</button>`; }).join("")}</div></div>` +
      `<div class="profile-section"><h3>Management reports</h3><div class="matrix">${reportRows || `<div class="profile-sub">No current reports. Each manager needs a separate valid Management Office and time to inspect records or the facility.</div>`}</div></div>`;
    financialsDashboard.querySelectorAll<HTMLButtonElement>("[data-procedure]").forEach((button) => button.onclick = () => {
      const id = button.dataset.procedure as typeof procedures[number];
      if (task3.management.procedure(id, worldTime)) task3.management.deactivateProcedure(id);
      else task3.management.activateProcedure(id, worldTime, 24);
      saveDirty = true; updateFinancialsUi();
    });
  }

  function updatePolicyUi(): void {
    const option = (value: string, current: string) => `<option ${value === current ? "selected" : ""}>${value}</option>`;
    const baseRules = task2.institution.rules.filter((r) => !r.itemDefId);
    const itemPolicies = ITEM_DEFS_V4.filter((def) => def.legality !== "legal" || def.controlled).map((def) => {
      const category = incidentCategoryForItem(def.id);
      return { def, category, rule: task2.institution.ruleFor(category, def.id),
        overridden: task2.institution.rules.some((r) => r.category === category && r.itemDefId === def.id) };
    });
    policyDashboard.innerHTML = `<div class="log-title">Policy</div><div class="profile-sub">Automatic responses execute only after the configured evidence threshold is met. Item-specific overrides inherit these category defaults.</div>` +
      `<div class="policy-row"><b>Incident</b><b>Evidence</b><b>Force ceiling</b><b>Search</b><b>Hours</b><b>Interview</b><b>Custody ↑</b><b>Protect</b></div>` +
      baseRules.map((r, index) => `<div class="policy-row"><strong>${html(r.category)}</strong>` +
        `<select data-policy="${index}:threshold">${["suspected", "probable", "confirmed"].map((v) => option(v, r.threshold)).join("")}</select>` +
        `<select data-policy="${index}:force">${["order", "restraint", "baton", "spray", "taser", "dog", "riot", "less-lethal", "lethal"].map((v) => option(v, r.force)).join("")}</select>` +
        `<select data-policy="${index}:search">${["none", "person", "cell", "workplace", "targeted", "full"].map((v) => option(v, r.search)).join("")}</select>` +
        `<input type="number" min="0" max="72" value="${r.solitaryHours}" data-policy="${index}:solitaryHours">` +
        `<input type="checkbox" ${r.interrogate ? "checked" : ""} data-policy="${index}:interrogate"><input type="checkbox" ${r.custodyUp ? "checked" : ""} data-policy="${index}:custodyUp"><input type="checkbox" ${r.protectiveOffer ? "checked" : ""} data-policy="${index}:protectiveOffer">` +
        `<input type="checkbox" ${r.confiscate ? "checked" : ""} data-policy="${index}:confiscate"><input type="checkbox" ${r.medicalCheck ? "checked" : ""} data-policy="${index}:medicalCheck"></div>`).join("") +
      `<div class="profile-section"><h3>Item-specific responses</h3><div class="profile-sub">Changing a field creates an override; unchanged rows inherit their listed incident category.</div>` +
      `<div class="policy-row"><b>Item / category</b><b>Evidence</b><b>Force ceiling</b><b>Search</b><b>Hours</b><b>Interview</b><b>Custody up</b><b>Protect</b><b>Seize</b><b>Medical</b></div>` +
      itemPolicies.map(({ def, category, rule: r, overridden }, index) => `<div class="policy-row"><strong>${html(def.name)}<small>${html(category)}${overridden ? " · override" : " · inherited"}</small></strong>` +
        `<select data-item-policy="${index}:threshold">${["suspected", "probable", "confirmed"].map((v) => option(v, r.threshold)).join("")}</select>` +
        `<select data-item-policy="${index}:force">${["order", "restraint", "baton", "spray", "taser", "dog", "riot", "less-lethal", "lethal"].map((v) => option(v, r.force)).join("")}</select>` +
        `<select data-item-policy="${index}:search">${["none", "person", "cell", "workplace", "targeted", "full"].map((v) => option(v, r.search)).join("")}</select>` +
        `<input type="number" min="0" max="72" value="${r.solitaryHours}" data-item-policy="${index}:solitaryHours">` +
        `<input type="checkbox" ${r.interrogate ? "checked" : ""} data-item-policy="${index}:interrogate"><input type="checkbox" ${r.custodyUp ? "checked" : ""} data-item-policy="${index}:custodyUp"><input type="checkbox" ${r.protectiveOffer ? "checked" : ""} data-item-policy="${index}:protectiveOffer">` +
        `<input type="checkbox" ${r.confiscate ? "checked" : ""} data-item-policy="${index}:confiscate"><input type="checkbox" ${r.medicalCheck ? "checked" : ""} data-item-policy="${index}:medicalCheck"></div>`).join("") + `</div>` +
      `<div class="profile-section"><h3>Mail inspection</h3><select class="work-select" id="mailInspection">${["none", "sample", "all"].map((v) => option(v, task2.market.mailInspection)).join("")}</select></div>`;
    const categoryHeader = policyDashboard.querySelector<HTMLElement>(".policy-row");
    if (categoryHeader?.children.length === 8) categoryHeader.insertAdjacentHTML("beforeend", "<b>Seize</b><b>Medical</b>");
    policyDashboard.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-policy]").forEach((input) => input.onchange = () => {
      const [indexText, field] = input.dataset.policy!.split(":"), rule = baseRules[Number(indexText)] as unknown as Record<string, unknown>;
      rule[field] = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : field === "solitaryHours" ? Number(input.value) : input.value; saveDirty = true;
    });
    policyDashboard.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-item-policy]").forEach((input) => input.onchange = () => {
      const [indexText, field] = input.dataset.itemPolicy!.split(":"), row = itemPolicies[Number(indexText)];
      const value = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : field === "solitaryHours" ? Number(input.value) : input.value;
      task2.institution.setItemOverride(row.category, row.def.id, { [field]: value }); saveDirty = true;
    });
    const mail = policyDashboard.querySelector<HTMLSelectElement>("#mailInspection"); if (mail) mail.onchange = () => { task2.market.mailInspection = mail.value as never; saveDirty = true; };
  }

  function frame(now: number) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    resize();
    camera.update(dt);
    if (noticeTimer > 0) {
      noticeTimer -= dt;
      if (noticeTimer <= 0) noticeEl.classList.remove("show");
    }
    if (dirty) { rebuild(); dirty = false; }

    // Advance the world clock at the selected speed; substep the sim so
    // high speeds don't let agents tunnel through walls.
    let simDt = dt * speed;
    worldTime += simDt;
    const staffCounts = new Map<number, number>();
    for (const ag of agents.agents) if (ag.kind !== Obj.Prisoner) staffCounts.set(ag.kind, (staffCounts.get(ag.kind) ?? 0) + 1);
    economy.setStaffCounts(staffCounts);
    economy.tick(worldTime, staffCounts);
    kitchen.tick(worldTime, world);
    if (agents.repairJobs.length > 0) {
      const repairDemand = { metal: 0, concrete: 0 };
      for (const job of agents.repairJobs) {
        if (job.claimedBy >= 0) continue;
        if (job.kind === "fence") repairDemand.metal++;
        else repairDemand.concrete += 2;
      }
      logistics.request(repairDemand, worldTime, false, "security-repairs");
    }
    agents.staffPerformance = economy.performanceMultiplier;
    while (simDt > 0) {
      const step = Math.min(0.1, simDt);
      logistics.tick(step, worldTime, world);
      construction.tick(step);
      intake.tick(step, worldTime, world, agents);
      agents.roadVehicleZ = [
        ...logistics.trucks.filter((truck) => truck.state === "arriving" || truck.state === "departing").map((truck) => truck.z),
        ...intake.vehicles.filter((vehicle) => vehicle.state === "arriving" || vehicle.state === "departing").map((vehicle) => vehicle.z),
        ...[...task3.escape.externalVehicles.values()].filter((vehicle) => vehicle.state === "arriving" || vehicle.state === "departing").map((vehicle) => vehicle.z),
      ];
      task2.tick(step, worldTime, world, agents.agents,
        agents.currentActivity() === REG.Work, agents.currentActivity() === REG.RollCall);
      task3.tick(step, worldTime, world, agents.agents, agents.social, agents.escapeOperations, agents.tunnels);
      for (const id of task3.consumeEscaped()) agents.markEscapedBySystem(id);
      agents.update(step, world, isNightAt(worldTime), hourOf(worldTime), worldTime);
      simDt -= step;
    }
    const atmo = evalAtmosphere(worldTime);

    // Clock + regime UI.
    const clockHour = hourOf(worldTime);
    const clockMinutes = Math.floor((clockHour - Math.floor(clockHour)) * 60);
    const day = dayOf(worldTime), hour = Math.floor(clockHour), night = isNightAt(worldTime);
    const nextClockUiKey = `${day}:${hour}:${clockMinutes}:${night ? 1 : 0}`;
    if (nextClockUiKey !== clockUiKey) {
      clockUiKey = nextClockUiKey;
      clockEl.innerHTML = `<span class="clock-day">DAY ${day}</span>` +
        `<span class="clock-time">${String(hour).padStart(2, "0")}:${String(clockMinutes).padStart(2, "0")}</span>` +
        `<span class="clock-sun">${night ? "☾" : "☀"}</span>`;
    }
    const regimeText = `Regime: ${REG_NAMES[agents.regime[hour]]}`;
    if (regimeBtn.textContent !== regimeText) regimeBtn.textContent = regimeText;
    const escapedText = String(agents.escapedCount), caughtText = String(agents.caughtCount);
    if (escapedEl && escapedEl.textContent !== escapedText) escapedEl.textContent = escapedText;
    if (caughtEl && caughtEl.textContent !== caughtText) caughtEl.textContent = caughtText;
    const cashText = `${economy.cash < 0 ? "−" : ""}$${Math.abs(Math.round(economy.cash)).toLocaleString()}`;
    const net = economy.netHourly();
    const netText = `${net >= 0 ? "+" : "−"}$${Math.abs(Math.round(net)).toLocaleString()}`;
    if (cashEl && cashEl.textContent !== cashText) {
      cashEl.textContent = cashText;
      cashEl.style.color = economy.cash < 0 ? "#e18a82" : "";
    }
    if (netHourlyEl && netHourlyEl.textContent !== netText) netHourlyEl.textContent = netText;
    logisticsUiT -= dt;
    if (logisticsUiT <= 0) {
      logisticsUiT = 0.5;
      if (activeMode === "logistics") updateLogisticsUi();
      else if (activeMode === "financials") updateFinancialsUi();
      else if (activeMode === "policy") updatePolicyUi();
    }
    intelligenceUiT -= dt;
    if (intelligenceUiT <= 0) { intelligenceUiT = 0.5; if (activeMode === "intelligence") updateIntelligenceUi(); }
    logisticsRenderT -= dt;
    if (logisticsRenderT <= 0) { logisticsRenderT = 0.2; refreshFurniture(); }
    ghostRenderT -= dt;
    if (ghostRenderT <= 0) {
      ghostRenderT = 0.08;
      const renderedGhosts = construction.persistentGhosts();
      if (editor.tool && hoverTile && isOrderTool()) {
        renderedGhosts.push(...construction.preview(editor.tool, orderTargets(), editor.orient, world));
      }
      ghosts.set(device, renderedGhosts);
    }

    people.update(device, personStager.stage(agents.agents));
    if (agents.takeWorldDirty()) { dirty = true; saveDirty = true; } // fences cut / repaired
    else if (agents.takeMealsDirty()) { refreshFurniture(); saveDirty = true; }
    if (selected && !agents.agents.includes(selected)) { selected = null; overlay.clear(); updateInspector(); }
    if (selected) updateInspector();
    overlayT -= dt;
    // The overlay does two jobs and never both at once: while a staff tool is
    // up it shows the beats and the posted rooms; otherwise, the selected
    // agent's memory.
    if (editor.showStaffLayer) {
      if (overlayT <= 0) {
        overlayT = 0.25;
        const routes = world.routeOverlay();
        const posted = world.postedOverlay();
        const both = new Float32Array(routes.length + posted.length);
        both.set(posted, 0);
        both.set(routes, posted.length); // beats draw over the room tint
        overlay.set(device, both);
      }
    } else if (selected && overlayT <= 0) {
      overlayT = 0.5;
      const points: number[] = [];
      for (const c of task2.institution.cases.values()) if (c.subjectIds.includes(selected.id)) for (const incidentId of c.incidentIds) {
        const incident = task2.institution.incidents.get(incidentId);
        if (incident) points.push(Math.floor(incident.x), Math.floor(incident.z), 7);
      }
      overlay.set(device, new Float32Array(points));
    } else if (!selected && staffLayerWasUp) {
      overlay.clear();
    }
    staffLayerWasUp = editor.showStaffLayer;

    const aspect = canvas.width / canvas.height;
    const viewProj = camera.viewProj(aspect);
    worldOverlayDataT -= dt;
    if (worldOverlayDataT <= 0) {
      worldOverlayDataT = 0.25;
      refreshWorldOverlayData();
    }
    const previewCount = previewTiles();
    worldOverlay.render(
      viewProj,
      previewScratch,
      previewCount,
      previewShowsFacing() ? editor.orient : null,
      hoverTile,
    );
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
    ghosts.draw(pass);
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
