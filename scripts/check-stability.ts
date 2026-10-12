// Regression checks for editor mutation contracts, erased tile metadata, and
// reusable person render staging.

import assert from "node:assert/strict";
import { blankAgent } from "../src/sim/agent.ts";
import { Agents } from "../src/sim/agents.ts";
import { PersonInstanceStager } from "../src/sim/renderData.ts";
import { Obj, World } from "../src/sim/world.ts";

const w = new World(32);
assert.equal(w.setDoor(4, 4), false, "a door on empty ground is rejected");
assert.equal(w.setFloor(4, 4, 1), true);
assert.equal(w.setFloor(4, 4, 1), false, "repainting the same floor is a no-op");

assert.equal(w.setWall(6, 6, 2), true);
assert.equal(w.setWall(6, 6, 2), false, "repainting the same wall is a no-op");
assert.equal(w.setDoor(6, 6, true), true);
assert.equal(w.setDoor(6, 6, true), false, "reapplying the same open jail door is a no-op");
const door = w.idx(6, 6);
w.jailClosed[door] = 1;
assert.equal(w.erase(6, 6), true);
assert.equal(w.objKind[door], Obj.None);
assert.equal(w.objMat[door], 0);
assert.equal(w.objOrient[door], 0);
assert.equal(w.jailClosed[door], 0);
assert.equal(w.saveData().tiles.some((tile) => tile[0] === door), false, "erased metadata is not serialized");
assert.equal(w.erase(6, 6), false, "erasing an empty tile is a no-op");

assert.equal(w.placePiece(10, 10, Obj.Bed, 2), true);
const bedTiles = w.pieceTiles(w.pieces.values().next().value!);
assert.deepEqual(w.tilesOfKind(Obj.Bed), bedTiles, "kind lookup returns every multi-tile object cell");
const mutableBedResults = w.tilesOfKind(Obj.Bed);
mutableBedResults.pop();
assert.deepEqual(w.tilesOfKind(Obj.Bed), bedTiles, "mutating lookup results cannot corrupt the cache");
assert.equal(w.erase(bedTiles[1] % w.size, (bedTiles[1] / w.size) | 0), true);
assert.deepEqual(w.tilesOfKind(Obj.Bed), [], "erasing a multi-tile piece invalidates cached lookup");
for (const tile of bedTiles) {
  assert.equal(w.objKind[tile], Obj.None);
  assert.equal(w.objOrient[tile], 0);
  assert.equal(w.jailClosed[tile], 0);
}

assert.equal(w.setWall(18, 18, 1), true);
assert.deepEqual(w.tilesOfKind(Obj.Wall), [w.idx(18, 18)]);
assert.equal(w.setFence(20, 20, 1), true);
const fenceTile = w.idx(20, 20);
assert.deepEqual(w.tilesOfKind(Obj.Fence), [fenceTile]);
w.cutFenceAt(fenceTile);
assert.deepEqual(w.tilesOfKind(Obj.Fence), []);
assert.deepEqual(w.tilesOfKind(Obj.CutFence), [fenceTile], "cutting a fence invalidates old and new kinds");
w.repairFenceAt(fenceTile);
assert.deepEqual(w.tilesOfKind(Obj.Fence), [fenceTile], "repairing a fence restores kind lookup");

const emptyWorld = new World(32);
w.loadData(emptyWorld.saveData());
assert.deepEqual(w.tilesOfKind(Obj.Wall), [], "loading an empty map clears cached kinds");
assert.deepEqual(w.tilesOfKind(Obj.Fence), [], "loading an empty map clears every cached kind");

const personWorld = new World(32);
assert.equal(personWorld.setPerson(8, 8, Obj.Prisoner, 0), true);
assert.deepEqual(personWorld.tilesOfKind(Obj.Prisoner), [personWorld.idx(8, 8)]);
const personAgents = new Agents();
personAgents.sync(personWorld);
assert.deepEqual(personWorld.tilesOfKind(Obj.Prisoner), [], "agent synchronization invalidates cleared person markers");
assert.equal(personAgents.agents.length, 1);

const prisoner = blankAgent(Obj.Prisoner);
const guard = blankAgent(Obj.Guard);
const stager = new PersonInstanceStager();
const first = stager.stage([prisoner, guard]);
const prisonerBuffer = first.prisoners.data;
assert.equal(first.prisoners.count, 1);
assert.equal(first.guards.count, 1);
prisoner.x = 3.5;
const second = stager.stage([prisoner, guard]);
assert.equal(second.prisoners.data, prisonerBuffer, "person staging buffer is reused");
assert.equal(second.prisoners.data[0], 3.5);

console.log("stability checks passed");

