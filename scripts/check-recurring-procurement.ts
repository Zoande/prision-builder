import assert from 'node:assert/strict';
import { commodityDef } from '../src/sim/commodities.ts';
import { EconomySystem } from '../src/sim/economy.ts';
import { itemDefV4 } from '../src/sim/itemSystem.ts';
import { LogisticsSystem } from '../src/sim/logistics.ts';
import { JOB_DEFS, JOB_INPUTS } from '../src/sim/work.ts';
import { World } from '../src/sim/world.ts';

for (const job of JOB_DEFS) {
  const requested = [...job.toolIds, ...Object.keys(JOB_INPUTS[job.id] ?? {})];
  for (const id of requested) {
    assert.ok(commodityDef(id), `${job.id} work demand ${id} has an orderable commodity definition`);
    assert.ok(itemDefV4(id), `${job.id} work demand ${id} can be represented as physical stock`);
  }
  const output = itemDefV4(job.outputId);
  if (output.tags.includes('contract-output')) assert.ok(output.baseValue > 0, `${job.id} export output has a positive item value`);
}

const economy = new EconomySystem();
const logistics = new LogisticsSystem(economy);
const world = new World(32);
const source = 'check-recurring-procurement:rolling-demand';
let continuingRequestId = -1;
for (let step = 0; step <= 80; step++) {
  const time = step / 10;
  logistics.request({ bandage: step < 10 ? 1 : 2 }, time, false, source);
  const pending = logistics.saveData().requests.find(row => row.source === source);
  if (step < 75) {
    assert.equal(pending?.createdAt, 0, 'a live demand preserves its initial procurement age');
    if (continuingRequestId < 0) continuingRequestId = pending?.id ?? -1;
    assert.equal(pending?.id, continuingRequestId, 'quantity refresh updates the same purchase request ID');
  }
  logistics.tick(0.1, time, world);
}
assert.equal(logistics.trucks.filter(truck => truck.kind === 'inbound').length, 1,
  'continuous demand dispatches a single consolidated truck');
assert.deepEqual([...logistics.packages.values()].map(pkg => [pkg.commodity, pkg.quantity]), [['bandage', 2]],
  'the one dispatched package carries the latest requested quantity');
assert.equal(economy.ledger.filter(entry => entry.kind === 'purchase').length, 1,
  'consolidation charges a single purchase');
logistics.request({ bandage: 0 }, 8.1, false, source);
assert.ok(!logistics.saveData().demands.some(row => row.source === source), 'zero demand clears the old source');
logistics.request({ bandage: 1 }, 10, false, source);
assert.equal(logistics.saveData().demands.find(row => row.source === source)?.createdAt, 10,
  'demand that returns after clearing starts a fresh consolidation window');

// A live producer can be fully covered by unreserved physical stock for a
// moment, which removes its purchase request. If that stock is claimed before
// the demand ends, the replacement request must keep the original age.
const coveredEconomy = new EconomySystem();
const coveredLogistics = new LogisticsSystem(coveredEconomy);
const coveredSource = 'check-recurring-procurement:covered-demand';
coveredLogistics.request({ bandage: 1 }, 0, false, coveredSource);
coveredLogistics.packages.set(1, { id: 1, commodity: 'bandage', quantity: 1, state: 'delivery',
  x: 10.5, z: 10.5, reservedBy: null, truckId: -1 });
coveredLogistics.request({ bandage: 1 }, 1, false, coveredSource);
assert.ok(!coveredLogistics.saveData().requests.some(row => row.source === coveredSource),
  'free physical stock temporarily covers a continuing producer demand');
assert.equal(coveredLogistics.saveData().demands.find(row => row.source === coveredSource)?.createdAt, 0,
  'the covered producer demand retains its age');
coveredLogistics.packages.get(1)!.reservedBy = 'work-input:fixture';
coveredLogistics.request({ bandage: 1 }, 2, false, coveredSource);
const restoredRequest = coveredLogistics.saveData().requests.find(row => row.source === coveredSource);
assert.equal(restoredRequest?.createdAt, 0,
  'a replacement purchase request inherits the still-live demand age after stock is claimed');
coveredLogistics.tick(0.1, 7.5, world);
assert.deepEqual([...coveredLogistics.packages.values()].filter(pkg => pkg.state === 'in-transit')
  .map(pkg => [pkg.commodity, pkg.quantity]), [['bandage', 1]],
  'the replacement demand dispatches at its original consolidation deadline');
assert.equal(coveredEconomy.ledger.filter(entry => entry.kind === 'purchase').length, 1,
  'a temporarily covered demand charges one eventual purchase');

console.log('Every workplace recipe resolves to physical stock; recurring and temporarily covered demand retain age through exact procurement.');
