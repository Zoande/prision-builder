// Golden-master check for the simulation.
//
// Builds a fixed prison, drives it for a fixed number of ticks off a fixed RNG
// seed, and hashes the whole resulting state. The sim is deterministic, so the
// hash is a fingerprint of its BEHAVIOUR.
//
// This exists to make refactoring safe. A pure code move must leave the hash
// bit-identical; if it doesn't, the move changed something. Run it before and
// after any restructuring of sim/.
//
//   npm run sim-check            print the hash and compare to EXPECTED
//   npm run sim-check -- --bless overwrite EXPECTED (only when a behaviour
//                                change is INTENDED — say so in the commit)

import { readFileSync, writeFileSync } from "node:fs";
import { Access, Obj, RoomType, World } from "../src/sim/world.ts";
import { Agents } from "../src/sim/agents.ts";
import { seedRng } from "../src/sim/rng.ts";

const TICKS = 60000; // 50 game-minutes at 20 ticks/s
const HASH_FILE = "scripts/sim-golden.hash";

/** FNV-1a over the state dump. Order matters, which is the point. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** A prison that exercises every subsystem the sim has.
 *
 *  The perimeter is WIRE, not wall, and the yard reaches it — otherwise no
 *  prisoner can ever see the fence, no escape plan can ever be formed, and the
 *  whole escape/tunnel/chase half of the sim would go unexercised by this check.
 *  Two men are seeded with intent so the cut and dig paths both run. */
function buildPrison(): { world: World; agents: Agents } {
  const w = new World(96);

  // Perimeter wire, and a tower to watch it.
  for (let x = 2; x <= 72; x++) { w.setFence(x, 2, 1); w.setFence(x, 62, 1); }
  for (let z = 2; z <= 62; z++) { w.setFence(2, z, 1); w.setFence(72, z, 1); }
  w.placePiece(66, 56, Obj.SniperTower, 0);

  // Yard: open ground inside the wire.
  for (let x = 4; x <= 70; x++) for (let z = 4; z <= 60; z++) w.setFloor(x, z, 1);

  // Cell block: six cells, two bunks each, a jail door apiece.
  for (let c = 0; c < 6; c++) {
    const x0 = 8 + c * 8;
    for (let x = x0 - 1; x <= x0 + 5; x++) { w.setWall(x, 7, 1); w.setWall(x, 15, 1); }
    for (let z = 7; z <= 15; z++) { w.setWall(x0 - 1, z, 1); w.setWall(x0 + 5, z, 1); }
    w.setDoor(x0 + 2, 15);
    w.setDoor(x0 + 2, 15, true); // jail door
    w.placePiece(x0, 9, Obj.Bed, 0);
    w.placePiece(x0, 12, Obj.Bed, 0);
    w.placePiece(x0 + 4, 9, Obj.Toilet, 0);
    w.placePiece(x0 + 4, 13, Obj.Toilet, 0);
  }

  // Kitchen (its own room, so the cook actually cooks) beside the canteen.
  for (let x = 11; x <= 21; x++) { w.setWall(x, 21, 1); w.setWall(x, 31, 1); }
  for (let z = 21; z <= 31; z++) { w.setWall(11, z, 1); w.setWall(21, z, 1); }
  w.setDoor(21, 26);
  w.placePiece(14, 24, Obj.Cooker, 0);
  w.placePiece(17, 24, Obj.Cooker, 0);

  // Canteen.
  for (let x = 22; x <= 38; x++) { w.setWall(x, 21, 1); w.setWall(x, 31, 1); }
  for (let z = 21; z <= 31; z++) w.setWall(38, z, 1);
  w.setDoor(30, 31);
  w.placePiece(23, 23, Obj.ServingTable, 0);
  w.placePiece(23, 26, Obj.ServingTable, 0);
  for (let n = 0; n < 3; n++) {
    w.placePiece(28 + n * 3, 24, Obj.Table, 0);
    w.placePiece(28 + n * 3, 25, Obj.Bench2, 0);
  }

  // Shower room.
  for (let x = 44; x <= 52; x++) { w.setWall(x, 21, 1); w.setWall(x, 29, 1); }
  for (let z = 21; z <= 29; z++) { w.setWall(44, z, 1); w.setWall(52, z, 1); }
  w.setDoor(48, 29);
  for (let n = 0; n < 3; n++) w.placePiece(46 + n * 2, 23, Obj.Shower, 0);
  w.placePiece(48, 26, Obj.Drain, 0);

  // Library + common room, to exercise books, seats and ambience.
  for (let x = 56; x <= 68; x++) { w.setWall(x, 8, 1); w.setWall(x, 20, 1); }
  for (let z = 8; z <= 20; z++) { w.setWall(56, z, 1); w.setWall(68, z, 1); }
  w.setDoor(62, 20);
  w.placePiece(58, 10, Obj.BookshelfLarge, 0);
  w.placePiece(62, 10, Obj.BookshelfTall, 0);
  w.placePiece(58, 14, Obj.ReadingDesk, 0);
  w.placePiece(64, 14, Obj.Armchair, 0);
  w.placePiece(66, 14, Obj.Sofa, 0);
  w.placePiece(60, 17, Obj.Television, 0);
  w.placePiece(64, 17, Obj.PottedPlant, 0);

  // Yard kit.
  w.placePiece(20, 40, Obj.Treadmill, 0);
  w.placePiece(22, 40, Obj.PunchingBag, 0);
  w.placePiece(26, 40, Obj.Altar, 0);
  w.placePiece(28, 42, Obj.Pew, 0);
  w.placePiece(34, 44, Obj.Bench4, 0);

  // People.
  for (let i = 0; i < 12; i++) w.setPerson(10 + i * 3, 36, Obj.Prisoner, i & 3);
  for (let i = 0; i < 5; i++) w.setPerson(48 + i * 2, 40, Obj.Guard, i & 3);
  w.setPerson(15, 26, Obj.Cook, 0);
  w.setPerson(18, 26, Obj.Cook, 0);
  w.setPerson(40, 45, Obj.Workman, 0);

  w.recomputeRoofs();
  w.recomputeRooms();

  // Rooms.
  for (let c = 0; c < 6; c++) {
    const x0 = 8 + c * 8;
    const id = w.startRoomPaint(x0, 8, RoomType.Cell);
    for (let x = x0; x <= x0 + 4; x++) for (let z = 8; z <= 14; z++) w.paintRoomInto(x, z, id);
    w.endRoomPaint(id);
  }
  const kitchen = w.startRoomPaint(12, 22, RoomType.Kitchen);
  for (let x = 12; x <= 20; x++) for (let z = 22; z <= 30; z++) w.paintRoomInto(x, z, kitchen);
  w.endRoomPaint(kitchen);

  const canteen = w.startRoomPaint(22, 22, RoomType.Canteen);
  for (let x = 22; x <= 37; x++) for (let z = 22; z <= 30; z++) w.paintRoomInto(x, z, canteen);
  w.endRoomPaint(canteen);

  const showers = w.startRoomPaint(45, 22, RoomType.ShowerRoom);
  for (let x = 45; x <= 51; x++) for (let z = 22; z <= 28; z++) w.paintRoomInto(x, z, showers);
  w.endRoomPaint(showers);

  const lib = w.startRoomPaint(57, 9, RoomType.Library);
  for (let x = 57; x <= 67; x++) for (let z = 9; z <= 19; z++) w.paintRoomInto(x, z, lib);
  w.endRoomPaint(lib);

  const yardId = w.startRoomPaint(6, 34, RoomType.Yard);
  for (let x = 6; x <= 44; x++) for (let z = 34; z <= 50; z++) w.paintRoomInto(x, z, yardId);
  w.endRoomPaint(yardId);

  for (const [x, z] of [[23, 23], [46, 23], [58, 10], [10, 36]]) {
    w.setRoomAccess(x, z, Access.Prisoners);
  }
  w.validateRooms();

  // A beat along the wire, and a guard posted in the canteen.
  const beat = w.startRoute(0);
  for (let x = 10; x <= 50; x++) w.addRouteTile(beat, x, 55);
  w.endRoute(beat);
  w.rooms.get(canteen)!.guards = 1;

  const agents = new Agents();
  agents.sync(w);
  agents.setRouteQuota(beat, 1);

  // Two men who mean to get out — one through the wire, one under it. Without
  // these the escape half of the sim would never run inside 50 game-minutes.
  const cons = agents.agents.filter((a) => a.kind === Obj.Prisoner);
  cons[0].planBias = "cut";
  cons[0].desire = 1;
  cons[1].planBias = "dig";
  cons[1].desire = 1;

  return { world: w, agents };
}

function dump(w: World, a: Agents): string {
  const parts: string[] = [];
  const n = (v: number) => (Math.round(v * 1000) / 1000).toString();

  // Agents, in id order so the dump doesn't depend on array shuffling.
  for (const ag of [...a.agents].sort((p, q) => p.id - q.id)) {
    parts.push([
      ag.id, ag.kind, n(ag.x), n(ag.z), n(ag.heading), ag.pose, ag.state,
      ag.bedIdx, ag.cellRoom, ag.useIdx, ag.routeId, ag.postRoom, ag.postIdx,
      ag.cuffed ? 1 : 0, ag.underground ? 1 : 0, ag.timesCaught,
      n(ag.escapeDesire), n(ag.risk), ag.cutterMeals,
      ag.plan ? `${ag.plan.method}/${ag.plan.stage}/${ag.plan.needed}` : "-",
      ag.profile ? `profile=${ag.profile.custody}/${ag.profile.aptitudes.intelligence}/${ag.profile.aptitudes.strength}/${ag.profile.aptitudes.charisma}/${ag.profile.labels.join("+")}` : "profile=-",
      ag.mind ? `mind=${n(ag.mind.stress)}/${n(ag.mind.anger)}/${n(ag.mind.confidence)}/${n(ag.mind.reputation)}` : "mind=-",
      `social=${n(ag.needs.social)}/${ag.socialAction}/${ag.socialGroup}`,
      `operation=${ag.escapeOperationId}/${ag.escapeRole}`,
      ag.inv.hands.map((h) => `${h.kind}x${h.count}`).join("+") || "-",
      ag.inv.pockets.map((h) => (h ? `${h.kind}x${h.count}` : "-")).join("+"),
      Object.entries(ag.needs).map(([k, v]) => `${k}=${n(v as number)}`).join(","),
      ag.objMem ? [...ag.objMem].map(([k, s]) => `${k}:${s.size}`).sort().join(",") : "-",
    ].join("|"));
  }

  // Sim-wide stores.
  parts.push(`escaped=${a.escapedCount} caught=${a.caughtCount}`);
  parts.push(`tunnels=${a.tunnels.map((t) => `${t.entry}/${t.believed}/${t.surfHole}`).sort().join(",")}`);
  parts.push(`cutFences=${[...a.cutFences].sort((x, y) => x - y).join(",")}`);
  parts.push(`repairs=${a.repairJobs.map((j) => `${j.kind}:${j.idx}`).sort().join(",")}`);
  parts.push(`doors=${a.doorTasks.map((t) => `${t.idx}:${t.close ? 1 : 0}`).sort().join(",")}`);
  parts.push(`meals=${[...a.mealTables].sort((x, y) => x - y).join(",")}`);
  parts.push(`stock=${[...a.servingStock].sort((x, y) => x[0] - y[0]).map(([k, v]) => `${k}=${v}`).join(",")}`);
  parts.push(`stashes=${[...a.stashes].sort((x, y) => x[0] - y[0])
    .map(([bed, items]) => `${bed}:${items.map((i) => `${i.kind}x${i.count}`).join("+")}`).join(",")}`);
  parts.push(`bonds=${[...a.social.bonds.values()].sort((x, y) => x.from - y.from || x.to - y.to)
    .map((b) => `${b.from}>${b.to}:${n(b.familiarity)}/${n(b.affinity)}/${n(b.trust)}/${n(b.respect)}/${n(b.fear)}`).join(",")}`);
  parts.push(`intel=${[...a.social.intel].sort((x, y) => x[0] - y[0])
    .map(([id, facts]) => `${id}:${[...facts.values()].sort((x, y) => x.key.localeCompare(y.key)).map((f) => `${f.key}/${n(f.confidence)}/${f.firsthand ? 1 : 0}`).join("+")}`).join(",")}`);
  parts.push(`operations=${[...a.escapeOperations.operations.values()].sort((x, y) => x.id - y.id)
    .map((o) => `${o.id}:${o.method}/${o.state}/${o.architectId}/${o.leaderId}/${n(o.cohesion)}/${n(o.exposure)}:${o.members.map((m) => `${m.agentId}-${m.role}-${m.parentId}-${m.ready ? 1 : 0}`).join("+")}`).join(",")}`);
  parts.push(`tunnelNetworks=${[...a.escapeOperations.tunnels.values()].sort((x, y) => x.id - y.id)
    .map((t) => `${t.id}:${t.entries.map((e) => `${e.tile}/${n(e.progress)}/${e.connected ? 1 : 0}`).join("+")}:${t.surfaceTile}`).join(",")}`);

  // World tiles that the sim can mutate.
  const cut: number[] = [];
  for (let i = 0; i < w.objKind.length; i++) if (w.objKind[i] === Obj.CutFence) cut.push(i);
  parts.push(`worldCut=${cut.join(",")}`);
  parts.push(`jailClosed=${[...w.jailClosed].reduce((acc, v, i) => v ? acc + i + "," : acc, "")}`);

  return parts.join("\n");
}

function run(): string {
  seedRng(12345);
  const { world, agents } = buildPrison();
  for (let t = 0; t < TICKS; t++) {
    const hour = (t / 20 / 60) % 24;
    agents.update(1 / 20, world, hour < 6 || hour >= 21, hour);
  }
  return dump(world, agents);
}

if (process.argv.includes("--peek")) {
  seedRng(12345);
  const { world, agents } = buildPrison();
  const seen: Record<string, number> = {};
  for (let t = 0; t < TICKS; t++) {
    const hour = (t / 20 / 60) % 24;
    agents.update(1 / 20, world, hour < 6 || hour >= 21, hour);
    for (const a of agents.agents) seen[a.state] = (seen[a.state] ?? 0) + 1;
  }
  console.log("states seen:", JSON.stringify(seen, null, 0));
  console.log("escaped", agents.escapedCount, "caught", agents.caughtCount,
    "tunnels", agents.tunnels.length, "plans",
    agents.agents.filter((a) => a.plan).length);
  process.exit(0);
}

const bless = process.argv.includes("--bless");
const state = run();
const h = hash(state);

// Determinism is the whole premise: a second identical run must agree.
const h2 = hash(run());
if (h !== h2) {
  console.error(`NOT DETERMINISTIC: ${h} vs ${h2} on two identical runs.`);
  console.error("Something in sim/ is still using Math.random(), Date, or Map/Set iteration order that varies.");
  process.exit(1);
}

if (bless) {
  writeFileSync(HASH_FILE, h + "\n");
  console.log(`blessed: ${h}`);
  process.exit(0);
}

let expected = "";
try { expected = readFileSync(HASH_FILE, "utf8").trim(); } catch { /* first run */ }

if (!expected) {
  console.log(`no golden hash yet. run with --bless to record: ${h}`);
  process.exit(1);
}
if (expected !== h) {
  console.error(`SIM BEHAVIOUR CHANGED\n  expected ${expected}\n  got      ${h}`);
  console.error("If that was intentional, re-bless it. If you were refactoring, it wasn't.");
  process.exit(1);
}
console.log(`sim unchanged: ${h}  (${TICKS} ticks, ${state.split("\n").length} state lines)`);
