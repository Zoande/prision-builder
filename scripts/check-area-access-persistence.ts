import assert from "node:assert/strict";
import { AreaSystem } from "../src/sim/areas.ts";
import { Obj, RoomType, World } from "../src/sim/world.ts";

function enclosure(world: World, x0: number, z0: number, w: number, h: number, doorX: number): void {
  for (let x = x0; x < x0 + w; x++) { world.setWall(x, z0, 1); world.setWall(x, z0 + h - 1, 1); }
  for (let z = z0 + 1; z < z0 + h - 1; z++) { world.setWall(x0, z, 1); world.setWall(x0 + w - 1, z, 1); }
  world.setDoor(doorX, z0 + h - 1);
}

const world = new World(64);
enclosure(world, 4, 4, 8, 8, 8);
enclosure(world, 20, 4, 10, 10, 25);
world.recomputeRooms();
const areas = new AreaSystem(world.size); areas.recompute(world);
const smallTile = world.idx(5, 5), mediumTile = world.idx(21, 5), exteriorTile = world.idx(1, 1);
const smallId = areas.areaAt[smallTile], mediumId = areas.areaAt[mediumTile], exteriorId = areas.areaAt[exteriorTile];
assert(smallId > 0 && mediumId > 0 && exteriorId > 0);
assert.notEqual(smallId, mediumId); assert.notEqual(smallId, exteriorId); assert.notEqual(mediumId, exteriorId);

const smallPolicy = areas.access.get(smallId)!;
smallPolicy.roles.visitor = true; smallPolicy.roles.prisoner = true; smallPolicy.roles.guard = false;
smallPolicy.custody.minimum = true; smallPolicy.mixed = false; smallPolicy.reservedCustody = "minimum";
const mediumPolicy = areas.access.get(mediumId)!;
mediumPolicy.roles.visitor = false; mediumPolicy.roles.worker = true; mediumPolicy.custody.protective = true;
const exteriorPolicy = areas.access.get(exteriorId)!;
exteriorPolicy.roles.visitor = true; exteriorPolicy.roles.driver = true; exteriorPolicy.custody.medium = true;

const worldSave = world.saveData(), areaSave = areas.saveData();
assert.equal(areaSave.anchors.length, areas.areas.size, "one compact physical anchor is saved per area");
assert(areaSave.anchors.length < 10, "save stores area anchors rather than all 4096 tile IDs");

// Cold restore with a new, larger enclosed component: recompute order would
// otherwise renumber the existing policies by size.
const restoredWorld = new World(64); restoredWorld.loadData(worldSave);
enclosure(restoredWorld, 38, 20, 24, 24, 49);
restoredWorld.recomputeRooms();
const restored = new AreaSystem(restoredWorld.size);
restored.loadData(JSON.parse(JSON.stringify(areaSave)));
restored.recompute(restoredWorld);
assert.equal(restored.areaAt[smallTile], smallId, "cold restore binds a policy to its physical area, not recompute order");
assert.equal(restored.areaAt[mediumTile], mediumId, "cold restore preserves area identity after component order changes");
assert.equal(restored.areaAt[exteriorTile], exteriorId, "cold restore retains the exterior area identity");
assert.equal(restored.access.get(smallId)?.roles.visitor, true);
assert.equal(restored.access.get(smallId)?.roles.guard, false);
assert.equal(restored.access.get(smallId)?.custody.minimum, true);
assert.equal(restored.access.get(smallId)?.mixed, false);
assert.equal(restored.access.get(smallId)?.reservedCustody, "minimum");
assert.equal(restored.access.get(mediumId)?.roles.worker, true);
assert.equal(restored.access.get(mediumId)?.roles.visitor, false);
assert.equal(restored.access.get(mediumId)?.custody.protective, true);
assert.equal(restored.access.get(exteriorId)?.roles.driver, true);
assert.equal(restored.access.get(exteriorId)?.custody.medium, true);
const addedTile = restoredWorld.idx(39, 21);
assert(restored.areaAt[addedTile] >= areaSave.nextAreaId, "new components receive fresh IDs above the saved high-water mark");
assert([...restored.access.keys()].every((id) => restored.areas.has(id)), "orphaned policies do not accumulate after cold recompute");

// Published v6 saves have no anchors. Their deterministic component ordering
// still restores the original simple layout and policy IDs.
const legacyWorld = new World(64); legacyWorld.loadData(worldSave);
const legacy = new AreaSystem(legacyWorld.size);
legacy.loadData({ nextAreaId: areaSave.nextAreaId, access: areaSave.access });
legacy.recompute(legacyWorld);
assert.equal(legacy.areaAt[smallTile], smallId);
assert.equal(legacy.access.get(smallId)?.roles.visitor, true);
assert.equal(legacy.access.get(mediumId)?.roles.worker, true);
assert(legacy.nextAreaId >= areaSave.nextAreaId, "legacy cold restore keeps area ID allocation monotonic");

// A subsystem reused for another loaded game must discard its previous tile
// map and policies before restoring the saved anchors.
const otherWorld = new World(64); enclosure(otherWorld, 40, 40, 10, 10, 45); otherWorld.recomputeRooms();
const reused = new AreaSystem(otherWorld.size); reused.recompute(otherWorld);
assert.notEqual(reused.areaAt[otherWorld.idx(41, 41)], smallId, "the first fixture uses its own area identity");
reused.loadData(JSON.parse(JSON.stringify(areaSave)));
reused.recompute(restoredWorld);
assert.equal(reused.areaAt[smallTile], smallId, "reused area system restores the second fixture's saved component ID");
assert.equal(reused.access.get(smallId)?.roles.visitor, true, "reused area system replaces old access policies");
assert([...reused.access.keys()].every((id) => reused.areas.has(id)), "reused area system has no old-fixture policies");

// Splitting a component keeps the old identity with the largest overlapping
// fragment and assigns the other fragment a fresh ID.
const splitWorld = new World(64); splitWorld.loadData(worldSave); splitWorld.recomputeRooms();
const split = new AreaSystem(splitWorld.size); split.loadData(JSON.parse(JSON.stringify(areaSave))); split.recompute(splitWorld);
for (let x = 0; x < 64; x++) splitWorld.setWall(x, 32, 1);
split.recompute(splitWorld);
const lowerExteriorId = split.areaAt[splitWorld.idx(1, 63)];
const upperExteriorId = split.areaAt[exteriorTile];
assert.notEqual(lowerExteriorId, upperExteriorId, "wall divides the old exterior component into two IDs");
assert([lowerExteriorId, upperExteriorId].includes(exteriorId), "largest overlapping split fragment keeps the old ID");
const newSplitId = lowerExteriorId === exteriorId ? upperExteriorId : lowerExteriorId;
assert(newSplitId >= areaSave.nextAreaId, "split-off component receives a fresh ID above the saved high-water mark");
assert(split.access.has(newSplitId), "new split fragment gets a default access policy");
assert([...split.access.keys()].every((id) => split.areas.has(id)), "split leaves no stale access records");

// When a breach merges components, the largest overlap keeps its ID and the
// access table drops the component identity that no longer exists.
const mergeWorld = new World(64); mergeWorld.loadData(worldSave); mergeWorld.recomputeRooms();
const merge = new AreaSystem(mergeWorld.size); merge.loadData(JSON.parse(JSON.stringify(areaSave))); merge.recompute(mergeWorld);
const preMergeSmallId = merge.areaAt[smallTile], preMergeExteriorId = merge.areaAt[exteriorTile];
mergeWorld.erase(4, 6);
merge.recompute(mergeWorld);
assert.equal(merge.areaAt[smallTile], preMergeExteriorId, "breached room joins the dominant exterior component");
assert.notEqual(preMergeSmallId, preMergeExteriorId);
assert(!merge.access.has(preMergeSmallId), "merged-away component access policy is removed");
assert([...merge.access.keys()].every((id) => merge.areas.has(id)), "merge leaves no stale access records");

// New prisons need ordinary visitor access on public outdoor space and inside
// a designated visitation area, while custody rooms retain their restrictions.
const accessWorld = new World(64);
enclosure(accessWorld, 4, 20, 10, 10, 8);
enclosure(accessWorld, 24, 20, 12, 12, 30);
const cellTiles = new Set<number>(), visitationTiles = new Set<number>();
for (let z = 21; z < 29; z++) for (let x = 5; x < 13; x++) {
  const tile = accessWorld.idx(x, z); accessWorld.roomId[tile] = 101; cellTiles.add(tile);
}
for (let z = 21; z < 31; z++) for (let x = 25; x < 35; x++) {
  const tile = accessWorld.idx(x, z); accessWorld.roomId[tile] = 102; visitationTiles.add(tile);
}
accessWorld.rooms.set(101, { id: 101, type: RoomType.Cell, access: 0, tiles: cellTiles, valid: true, ambience: 0, guards: 0 });
accessWorld.rooms.set(102, { id: 102, type: RoomType.Visitation, access: 0, tiles: visitationTiles, valid: true, ambience: 0, guards: 0 });
assert(accessWorld.placePiece(27, 24, Obj.VisitTable, 0));
assert(accessWorld.placePiece(31, 24, Obj.VisitorSearchDesk, 0));
const defaulted = new AreaSystem(accessWorld.size); defaulted.recompute(accessWorld);
const publicAreaId = defaulted.areaAt[accessWorld.idx(1, 1)];
const cellAreaId = defaulted.areaAt[accessWorld.idx(6, 22)];
const visitationAreaId = defaulted.areaAt[accessWorld.idx(26, 22)];
assert.equal(defaulted.access.get(publicAreaId)?.roles.visitor, true, "public exterior admits ordinary visitors by default");
assert.equal(defaulted.access.get(visitationAreaId)?.roles.visitor, true, "a valid visitation room admits its scheduled visitor by default");
assert.equal(defaulted.access.get(cellAreaId)?.roles.visitor, false, "visitor defaults do not open cell areas");
assert.equal(defaulted.access.get(cellAreaId)?.roles.prisoner, true, "cell access remains restricted to prisoner custody policy");
const explicitlyDenied = defaulted.saveData();
for (const areaId of [publicAreaId, visitationAreaId]) {
  const policy = explicitlyDenied.access.find((row) => row.areaId === areaId)!;
  policy.roles.visitor = false;
}
const deniedRestore = new AreaSystem(accessWorld.size);
deniedRestore.loadData(explicitlyDenied); deniedRestore.recompute(accessWorld);
assert.equal(deniedRestore.access.get(publicAreaId)?.roles.visitor, false, "cold restore preserves a deliberate public-area visitor denial");
assert.equal(deniedRestore.access.get(visitationAreaId)?.roles.visitor, false, "cold restore does not auto-unlock a deliberate room visitor denial");
console.log("cold area-access restore, topology reorder, role/custody preservation, and legacy v6 fallback passed");
