// Regression checks for editor mutation contracts, erased tile metadata, and
// reusable person render staging.

import assert from "node:assert/strict";
import { blankAgent } from "../src/sim/agent.ts";
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
assert.equal(w.erase(bedTiles[1] % w.size, (bedTiles[1] / w.size) | 0), true);
for (const tile of bedTiles) {
  assert.equal(w.objKind[tile], Obj.None);
  assert.equal(w.objOrient[tile], 0);
  assert.equal(w.jailClosed[tile], 0);
}

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

