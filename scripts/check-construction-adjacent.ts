import assert from 'node:assert/strict';
import { Obj, World } from '../src/sim/world.ts';
import { createPrison } from './scenarios/prison.ts';

const sim = createPrison(42107, 0);
const worker = sim.agents.agents.find(agent => agent.kind === Obj.Workman)!;
const wx = Math.floor(worker.x), wz = Math.floor(worker.z);
const target = { x: wx, z: wz + 1 };
sim.logistics.addSalvage('concrete', 2, wx, wz);
const group = sim.construction.plan({ cat: 'wall', mat: 1 }, [target], 0, sim.time, sim.world)!;
assert.ok(group, 'accept the ready wall order');
const haul = sim.construction.claimNext(worker.id, wx, wz, sim.world, sim.time)!;
assert.equal(haul.phase, 'haul');
assert.ok(sim.construction.pickUpBundle(group.id, haul.target.id, haul.packageId, worker.id, wx, wz));
assert.ok(sim.construction.deliverBundle(group.id, haul.target.id, haul.packageId, worker.id));
const work = sim.construction.claimNext(worker.id, wx, wz, sim.world, sim.time)!;
assert.equal(work.phase, 'work');

// A preceding wall completion can leave a builder standing on the new wall.
// Model that immediate post-completion state while the adjacent order is ready.
worker.buildGroup = group.id;
worker.buildTarget = work.target.id;
worker.state = 'toBuild';
worker.path = null;
worker.pathI = 0;
assert.ok(sim.world.setWall(wx, wz, 1), 'the prior wall blocks the builder’s current tile');
sim.world.recomputeRooms(); sim.rebuild();

for (let elapsed = 0; elapsed < 12 && group.state !== 'complete'; elapsed++) sim.advance(1);
assert.equal(group.state, 'complete', `adjacent ready wall finishes after the worker steps out; ${group.blocker}`);
assert.equal(sim.world.objKind[sim.world.idx(target.x, target.z)], Obj.Wall);
assert.notEqual(sim.world.objKind[sim.world.idx(Math.floor(worker.x), Math.floor(worker.z))], Obj.Wall,
  'the worker reaches an open construction stance instead of working from inside a wall');
assert.equal(work.target.delivered.concrete, 2, 'the wall keeps its exact concrete recipe');
console.log('A builder trapped on a completed wall steps onto an open stance and completes the adjacent ready order.');
