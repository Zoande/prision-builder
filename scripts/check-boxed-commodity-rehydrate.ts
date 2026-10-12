import { strict as assert } from "node:assert";
import { COMMODITIES, commodityDef } from "../src/sim/commodities.ts";
import { EconomySystem } from "../src/sim/economy.ts";
import { LogisticsSystem } from "../src/sim/logistics.ts";
import { Obj, defOf } from "../src/sim/objects.ts";
import { isSaveV6 } from "../src/sim/saveVersion.ts";

// This script runs in its own Node process. No construction or commodity
// planning has run before the simulated save is loaded.
const kind = Obj.StaffFenceDoor;
const id = `box:${kind}`;
assert.equal(defOf(kind)?.name, "Staff Fence Gate", "Obj 62 is the Staff Fence Gate");
assert.equal(COMMODITIES.some((row) => row.id === id), false, "boxed commodity starts unregistered in a fresh realm");

const cargoRow = { id: 1, commodity: id, quantity: 1, state: "delivery", x: 30, z: 30, reservedBy: null, truckId: -1 };
const save = {
  version: 6,
  savedAt: "2026-10-12T00:00:00.000Z",
  worldTime: 0,
  world: { size: 500, tiles: [], pieces: [], rooms: [], routes: [] },
  agents: { agents: [], rngState: 1 },
  infrastructure: {},
  economy: { cash: 0 },
  logistics: { packages: [cargoRow] },
  construction: {},
  kitchen: { frozenMeals: 0, cleanTrays: 0, cleanSpoons: 0, dirtyTrays: 0, dirtySpoons: 0,
    books: 0, preparedSettings: 0, eatingSettings: 0, borrowedBooks: 0 },
  intake: {},
  task2: {},
  task3: {},
};
assert.equal(isSaveV6(save), true, "version 6 accepts a saved boxed commodity without prior registration");

const logistics = new LogisticsSystem(new EconomySystem());
logistics.loadData(save.logistics);

const [pkg] = logistics.packagesForHandler("workman");
assert.equal(pkg?.commodity, id, "imported boxed salvage is available to workmen");
assert.equal(commodityDef(id).name, "Boxed Staff Fence Gate");
assert.equal(COMMODITIES.some((row) => row.id === id), true, "lookup rehydrates the commodity registry");

console.log("boxed commodity rehydration checks passed");
