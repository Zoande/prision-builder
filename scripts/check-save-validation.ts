import assert from "node:assert/strict";
import { createPrison } from "./scenarios/prison.ts";
import { Obj } from "../src/sim/objects.ts";
import { Item } from "../src/sim/items.ts";
import { isSaveV6 } from "../src/sim/saveVersion.ts";

const sim = createPrison(321, 2);
sim.advance(30);
const native = sim.snapshot();
assert.ok(isSaveV6(native), "native runtime snapshot passes import validation");
const valid = JSON.parse(JSON.stringify(native)) as typeof native;
assert.ok(isSaveV6(valid), "JSON round-tripped native snapshot passes import validation");
const publishedV6 = JSON.parse(JSON.stringify(valid));
delete publishedV6.agents.rngState;
assert.ok(isSaveV6(publishedV6), "published v6 saves without the later RNG checkpoint remain importable");
const withCargoAndInventory = JSON.parse(JSON.stringify(valid));
withCargoAndInventory.logistics.packages = [
  { id: 9001, commodity: "frozen-meal", quantity: 12, state: "delivery", x: 1, z: 1, reservedBy: null, truckId: -1 },
];
withCargoAndInventory.agents.agents[0].inv.hands = [{ kind: Item.Spoon, count: 1 }];
assert.ok(isSaveV6(withCargoAndInventory), "valid cargo and inventory records remain importable");

function rejected(label: string, mutate: (save: any) => void): void {
  const save = JSON.parse(JSON.stringify(valid));
  mutate(save);
  assert.equal(isSaveV6(save), false, `${label} is rejected`);
}

rejected("null inventory hand", save => { save.agents.agents[0].inv.hands = [null]; });
rejected("negative inventory stack", save => { save.agents.agents[0].inv.hands = [{ kind: Item.Spoon, count: -1 }]; });
rejected("unknown inventory item", save => { save.agents.agents[0].inv.pockets[0] = { kind: 999, count: 1 }; });
rejected("zero RNG stream state", save => { save.agents.rngState = 0; });
rejected("string RNG stream state", save => { save.agents.rngState = "123"; });
rejected("oversized RNG stream state", save => { save.agents.rngState = 0x1_0000_0000; });
rejected("string frozen meal stock", save => { save.kitchen.frozenMeals = "plenty"; });
rejected("negative frozen meal stock", save => { save.kitchen.frozenMeals = -1; });
rejected("infinite economy cash", save => { save.economy.cash = Infinity; });
rejected("string economy cash", save => { save.economy.cash = "infinite"; });
rejected("person kind stored as a furniture piece", save => {
  save.world.pieces.push({ id: 999999, kind: Obj.Prisoner, x: 1, z: 1, w: 1, d: 1, orient: 0 });
});

const packageRecord = { id: 9001, commodity: "frozen-meal", quantity: 12, state: "delivery", x: 1, z: 1, reservedBy: null, truckId: -1 };
rejected("zero cargo quantity", save => { save.logistics.packages = [{ ...packageRecord, quantity: 0 }]; });
rejected("string cargo quantity", save => { save.logistics.packages = [{ ...packageRecord, quantity: "12" }]; });
rejected("unknown cargo state", save => { save.logistics.packages = [{ ...packageRecord, state: "teleported" }]; });
rejected("duplicate cargo ids", save => { save.logistics.packages = [packageRecord, { ...packageRecord }]; });
rejected("unknown cargo commodity", save => { save.logistics.packages = [{ ...packageRecord, commodity: "unobtainium" }]; });

console.log("Native save validation and malformed inventory, stock, cargo, economy, and piece rejection: passed");
