// Drive features 1-3: room drag painting, snipers, guard density bias.
import { Access, Obj, RoomType, World } from "../src/sim/world.ts";
import { Agents } from "../src/sim/agents.ts";

let fails = 0;
const ok = (n: string, c: boolean, e = "") => {
  if (!c) fails++;
  console.log(`${c ? "  ok" : "FAIL"}  ${n}${e ? "  — " + e : ""}`);
};

function enclose(w: World, x0: number, z0: number, x1: number, z1: number) {
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) w.setFloor(x, z, 1);
  for (let x = x0 - 1; x <= x1 + 1; x++) { w.setWall(x, z0 - 1, 1); w.setWall(x, z1 + 1, 1); }
  for (let z = z0 - 1; z <= z1 + 1; z++) { w.setWall(x0 - 1, z, 1); w.setWall(x1 + 1, z, 1); }
  w.setDoor(x0 - 1, z0 + 1);
  w.recomputeRoofs();
  w.recomputeRooms();
}

/** Paint a rect the way a mouse drag does: claim once, then fill. */
function dragRoom(w: World, x0: number, z0: number, x1: number, z1: number, type: number) {
  const id = w.startRoomPaint(x0, z0, type);
  for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++) w.paintRoomInto(x, z, id);
  }
  w.endRoomPaint(id);
  return id;
}

// --- 1. Room drag painting --------------------------------------------------
console.log("\n[room drag]");
{
  const w = new World(48);
  enclose(w, 2, 2, 20, 14);

  const a = dragRoom(w, 3, 3, 8, 8, RoomType.Canteen);
  const room = w.rooms.get(a)!;
  ok("a drag paints the whole rectangle", room.tiles.size === 36,
    `${room.tiles.size} tiles`);

  // Start INSIDE the canteen and drag out of it: it extends the same room.
  const b = dragRoom(w, 5, 5, 12, 10, RoomType.Canteen);
  ok("starting inside a room of that kind extends it", b === a,
    `got room ${b}, expected ${a}`);
  ok("the extension grew it", w.rooms.get(a)!.tiles.size > 36,
    `${w.rooms.get(a)!.tiles.size} tiles`);

  // Start OUTSIDE it and drag over it: the new room overrides.
  const before = w.rooms.get(a)!.tiles.size;
  const c = dragRoom(w, 16, 3, 6, 6, RoomType.Kitchen);
  ok("starting outside makes a NEW room", c !== a);
  ok("...and it overrides the tiles it covers",
    w.rooms.get(a)!.tiles.size < before && w.roomId[w.idx(6, 6)] === c,
    `canteen now ${w.rooms.get(a)?.tiles.size} tiles`);
  ok("the overriding room is the right type",
    w.rooms.get(c)!.type === RoomType.Kitchen);
}

// --- 2. Sniper tower --------------------------------------------------------
console.log("\n[sniper]");
{
  const w = new World(60);
  for (let x = 2; x <= 40; x++) for (let z = 2; z <= 30; z++) w.setFloor(x, z, 1);
  for (let x = 0; x <= 45; x++) w.setFence(x, 32, 1); // the perimeter
  w.placePiece(20, 20, Obj.SniperTower, 0);
  w.setPerson(10, 10, Obj.Prisoner, 0);
  w.recomputeRoofs();
  w.recomputeRooms();

  const agents = new Agents();
  agents.sync(w);
  agents.update(1 / 20, w, false, 10); // manTowers runs here

  const snipers = agents.agents.filter((a) => a.kind === Obj.Sniper);
  ok("a tower posts a sniper by itself", snipers.length === 1);
  ok("he is up the tower", snipers[0]?.elev > 3, `elev ${snipers[0]?.elev}`);

  // A man on the wire, well beyond a foot guard's 26-tile vision.
  const p = agents.agents.find((a) => a.kind === Obj.Prisoner)!;
  p.cuffed = false;
  p.x = 20.5; p.z = 31.5; // at the fence, ~11 tiles from the tower
  p.state = "climbing";
  p.pose = 5;
  p.timer = 999;

  for (let t = 0; t < 400; t++) {
    agents.update(1 / 20, w, false, 10);
    if (p.state === "climbing") { p.timer = 999; } // keep him on the wire
  }
  ok("the sniper shot the climber", p.state === "knockedOut" || p.timesCaught > 0,
    `state ${p.state}, caught ${p.timesCaught}x`);
  ok("the escape is off", p.plan === null);
  ok("a knockout counts as a capture", agents.caughtCount > 0);

  // He comes round on his own if nobody collects him.
  for (let t = 0; t < 1200; t++) agents.update(1 / 20, w, false, 10);
  ok("he comes round eventually", p.state !== "knockedOut", `state ${p.state}`);

  // Demolish the tower and the sniper goes with it.
  w.erase(20, 20);
  agents.update(1 / 20, w, false, 10);
  ok("demolishing the tower retires the sniper",
    agents.agents.filter((a) => a.kind === Obj.Sniper).length === 0);
}

// --- 3. Guards patrol where the prisoners are -------------------------------
console.log("\n[patrol bias]");
{
  const w = new World(80);
  // A big yard with a perimeter fence far to one side, and the prisoners
  // clustered in a room on the other. The old patrol went to the fence.
  for (let x = 2; x <= 60; x++) for (let z = 2; z <= 40; z++) w.setFloor(x, z, 1);
  for (let x = 0; x <= 70; x++) w.setFence(x, 45, 1);
  for (let i = 0; i < 8; i++) w.setPerson(6 + i, 6, Obj.Prisoner, 0);
  w.setPerson(30, 20, Obj.Guard, 0);
  w.setPerson(32, 20, Obj.Guard, 0);
  w.recomputeRoofs();
  w.recomputeRooms();
  for (let x = 2; x <= 60; x++) for (let z = 2; z <= 40; z++) w.paintRoom(x, z, RoomType.Yard);
  w.setRoomAccess(4, 4, Access.Prisoners);
  w.validateRooms();

  const agents = new Agents();
  agents.sync(w);
  for (const a of agents.agents) if (a.kind === Obj.Prisoner) a.cuffed = false;

  let nearCrowd = 0, atFence = 0, samples = 0;
  for (let t = 0; t < 20000; t++) {
    agents.update(1 / 20, w, false, 10);
    if (t % 100 !== 0) continue;
    for (const g of agents.agents) {
      if (g.kind !== Obj.Guard) continue;
      samples++;
      // The crowd sits around (6..13, 6). The fence is at z=45.
      const dCrowd = Math.hypot(g.x - 9, g.z - 6);
      if (dCrowd < 18) nearCrowd++;
      if (g.z > 35) atFence++;
    }
  }
  const pctCrowd = (100 * nearCrowd / samples) | 0;
  const pctFence = (100 * atFence / samples) | 0;
  ok("guards spend most of their time near the prisoners", pctCrowd > 50,
    `${pctCrowd}% near the crowd, ${pctFence}% out at the fence`);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
