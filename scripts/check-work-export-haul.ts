import assert from 'node:assert/strict';
import { itemDefV4 } from '../src/sim/itemSystem.ts';
import { REG } from '../src/sim/agent.ts';
import { Obj, RoomType } from '../src/sim/world.ts';
import { JOB_DEFS, JOB_INPUTS } from '../src/sim/work.ts';
import { createPrison } from './scenarios/prison.ts';

const sim = createPrison(37219, 2);
sim.task2.tick(0.1, sim.time, sim.world, sim.agents.agents, false, false);
const worker = sim.agents.agents.find(agent => agent.kind === Obj.Workman)!;
const prisoner = sim.agents.agents.find(agent => agent.kind === Obj.Prisoner)!;
const impostor = sim.agents.agents.find(agent => agent.kind === Obj.Prisoner && agent.id !== prisoner.id);
const outputRoom = [...sim.world.rooms.values()].find(room => room.type === RoomType.Yard && room.valid)!;
const exportsBounds = { x: 379, z: 368, w: 8, d: 10 };
for (let x = exportsBounds.x; x < exportsBounds.x + exportsBounds.w; x++) for (let z = exportsBounds.z; z < exportsBounds.z + exportsBounds.d; z++) {
  sim.world.setFloor(x, z, 1);
  sim.world.roomId[sim.world.idx(x, z)] = 0;
}
assert.ok(sim.world.setFence(378, 375, 1));
assert.ok(sim.world.setFenceGate(378, 375, false));
assert.ok(sim.world.placePiece(380, 373, Obj.LoadingPallet, 0));
const exportId = Math.max(...sim.world.rooms.keys()) + 1;
const exportTiles = new Set<number>();
for (let x = exportsBounds.x; x < exportsBounds.x + exportsBounds.w; x++) for (let z = exportsBounds.z; z < exportsBounds.z + exportsBounds.d; z++) exportTiles.add(sim.world.idx(x, z));
const exportsRoom = { id: exportId, type: RoomType.Exports, access: 0, tiles: exportTiles, valid: false, ambience: 0, guards: 0 };
sim.world.rooms.set(exportId, exportsRoom);
for (const tile of exportTiles) sim.world.roomId[tile] = exportId;
exportsRoom.valid = sim.world.roomIssues(exportsRoom).length === 0;
assert.ok(exportsRoom.valid, 'the physical Exports fixture has a gate and loading pallet');
const deliveryBounds = { x: 379, z: 356, w: 8, d: 10 };
for (let x = deliveryBounds.x; x < deliveryBounds.x + deliveryBounds.w; x++) for (let z = deliveryBounds.z; z < deliveryBounds.z + deliveryBounds.d; z++) {
  sim.world.setFloor(x, z, 1);
  sim.world.roomId[sim.world.idx(x, z)] = 0;
}
assert.ok(sim.world.setFence(378, 360, 1));
assert.ok(sim.world.setFenceGate(378, 360, false));
assert.ok(sim.world.placePiece(380, 357, Obj.LoadingPallet, 0));
const deliveryId = exportId + 1;
const deliveryTiles = new Set<number>();
for (let x = deliveryBounds.x; x < deliveryBounds.x + deliveryBounds.w; x++) for (let z = deliveryBounds.z; z < deliveryBounds.z + deliveryBounds.d; z++) deliveryTiles.add(sim.world.idx(x, z));
const deliveryRoom = { id: deliveryId, type: RoomType.Delivery, access: 0, tiles: deliveryTiles, valid: false, ambience: 0, guards: 0 };
sim.world.rooms.set(deliveryId, deliveryRoom);
for (const tile of deliveryTiles) sim.world.roomId[tile] = deliveryId;
deliveryRoom.valid = sim.world.roomIssues(deliveryRoom).length === 0;
assert.ok(deliveryRoom.valid, `the physical Delivery fixture is valid: ${sim.world.roomIssues(deliveryRoom).map(issue => issue.message).join('; ')}`);

sim.task2.work.refresh(sim.world, sim.time);
const workplace = sim.task2.work.workplaces.get(outputRoom.id)!;
assert.ok(sim.task2.work.assign(prisoner.id, outputRoom.id), 'assign a resident to the valid Yard workplace');
// This focused production fixture starts a resident as fit for work; separate
// handoff checks below deliberately change food, custody, and health state.
prisoner.needs.food = 0.8;
prisoner.needs.sleep = 0.8;
prisoner.needs.hygiene = 0.8;
prisoner.bedIdx = sim.world.tilesOfKind(Obj.Bed)[0] ?? -1;
prisoner.cellRoom = sim.world.rooms.get(sim.world.roomId[prisoner.bedIdx])?.id ?? -1;
prisoner.cuffed = false;
prisoner.escortedBy = -1;
prisoner.state = 'idle';
const workRouteTile = sim.world.idx(Math.floor(prisoner.x), Math.floor(prisoner.z));
const workArea = sim.task2.areas.areaAt[workRouteTile];
const workPolicy = sim.task2.areas.access.get(workArea)!;
const originalRoles = { prisoner: workPolicy.roles.prisoner, worker: workPolicy.roles.worker };
const originalCustody = { minimum: workPolicy.custody.minimum, maximum: workPolicy.custody.maximum };
workPolicy.roles.prisoner = false;
workPolicy.roles.worker = true;
workPolicy.custody.minimum = false;
workPolicy.custody.maximum = true;
const originalProfileCustody = prisoner.profile!.custody;
prisoner.profile!.custody = 'maximum';
prisoner.state = 'toWork';
assert.ok(sim.task2.work.isAuthorizedWorkerAt(prisoner, workRouteTile, sim.world, true, false),
  'the active maximum-custody job satisfies the worker-only route authorization');
assert.equal(sim.task2.work.isAuthorizedWorkerAt(prisoner, workRouteTile, sim.world, false, false), false,
  'the worker-only authorization ends outside the Work regime');
prisoner.sneaking = true;
assert.equal(sim.task2.work.isAuthorizedWorkerAt(prisoner, workRouteTile, sim.world, true, false), false,
  'sneaking invalidates the worker-only authorization');
prisoner.sneaking = false;
const guard = sim.agents.agents.find(agent => agent.kind === Obj.Guard)!;
sim.agents.regime[9] = REG.Work;
sim.agents.curHour = 8;
guard.x = prisoner.x; guard.z = prisoner.z; guard.state = 'patrol'; guard.decideT = 0;
for (let step = 0; step < 8; step++) sim.agents.update(0.1, sim.world, false, 9, sim.time + 80 + step * 0.1);
assert.equal(prisoner.escortedBy, -1, 'a maximum-custody resident assigned to Work is not escorted from a worker-only area');
prisoner.profile!.custody = 'minimum';
prisoner.x = workRouteTile % sim.world.size + 0.5;
prisoner.z = ((workRouteTile / sim.world.size) | 0) + 0.5;
prisoner.state = 'toWork'; prisoner.cuffed = false; prisoner.sneaking = false; prisoner.escortedBy = -1;
guard.x = prisoner.x; guard.z = prisoner.z; guard.state = 'patrol'; guard.decideT = 0;
for (let step = 0; step < 8 && prisoner.escortedBy < 0; step++) {
  sim.agents.update(0.1, sim.world, false, 9, sim.time + 81 + step * 0.1);
  sim.agents.updateGuard(guard, 0.1, sim.world);
}
assert.ok(prisoner.escortedBy >= 0, `a minimum-custody resident without worker-area permission is escorted by the guard; p=${prisoner.state}@${prisoner.x.toFixed(1)},${prisoner.z.toFixed(1)} guard=${guard.state}@${guard.x.toFixed(1)},${guard.z.toFixed(1)} access=${workPolicy.roles.prisoner}/${workPolicy.custody.minimum} worker=${workPolicy.roles.worker}/${workPolicy.custody.minimum} activity=${sim.agents.curActivity}`);
prisoner.escortedBy = -1;
prisoner.profile!.custody = originalProfileCustody;
prisoner.state = 'idle';
sim.agents.curHour = -1;
workPolicy.custody.minimum = originalCustody.minimum;
workPolicy.custody.maximum = originalCustody.maximum;
workPolicy.roles.prisoner = originalRoles.prisoner;
workPolicy.roles.worker = originalRoles.worker;
const yardTile = sim.world.idx(320, 380);
const setOnYard = (agent: typeof prisoner) => {
  agent.x = yardTile % sim.world.size + 0.5;
  agent.z = ((yardTile / sim.world.size) | 0) + 0.5;
  agent.path = null; agent.pathI = 0; agent.cuffed = false; agent.escortedBy = -1;
};
prisoner.profile!.custody = 'minimum';
prisoner.state = 'working'; prisoner.compliant = false; setOnYard(prisoner);
sim.agents.regime[9] = REG.Work; sim.agents.curHour = 9; sim.agents.curActivity = REG.Work;
assert.ok(sim.task2.work.isAuthorizedWorkerAt(prisoner, yardTile, sim.world, true, false),
  `an assigned, active grounds worker is authorized inside the public workplace during Work; assigned=${sim.task2.work.assignments.get(prisoner.id)} room=${outputRoom.id} state=${prisoner.state} cuff=${prisoner.cuffed} escort=${prisoner.escortedBy} sneaking=${prisoner.sneaking} food=${prisoner.needs.food} sleep=${prisoner.needs.sleep} tileRoom=${sim.world.roomId[yardTile]} passable=${sim.world.floorMat[yardTile]} policy=${JSON.stringify(sim.task2.areas.access.get(sim.task2.areas.areaAt[yardTile])?.roles)}`);
assert.equal(sim.task2.work.isAuthorizedWorkerAt(prisoner, yardTile, sim.world, false, false), false,
  'the workplace authorization ends when Work is not scheduled');
assert.equal(sim.task2.work.isAuthorizedWorkerAt(impostor!, yardTile, sim.world, true, false), false,
  'an unassigned resident cannot use the work authorization');
guard.x = prisoner.x; guard.z = prisoner.z; guard.state = 'patrol'; guard.decideT = 0;
for (let step = 0; step < 8; step++) sim.agents.update(0.1, sim.world, false, 9, sim.time + 82 + step * 0.1);
assert.equal(prisoner.escortedBy, -1,
  'guard enforcement does not march an assigned, active, defiant resident out of a public workplace');
setOnYard(impostor!); impostor!.state = 'working'; impostor!.compliant = false;
assert.equal(sim.task2.work.isAuthorizedWorkerAt(impostor!, yardTile, sim.world, true, false), false,
  'an unassigned impostor remains unauthorized even in a public workplace during Work');
assert.equal(sim.task2.work.isAuthorizedWorkerAt(prisoner, yardTile, sim.world, false, false), false,
  'an assigned grounds worker has no Work authorization after hours');
impostor!.escortedBy = -1; prisoner.state = 'idle'; prisoner.compliant = true;
for (const defId of ['shovel', 'pruning-shears', 'fertilizer']) {
  const stock = sim.task2.items.create(defId, sim.time);
  assert.ok(sim.task2.items.moveToContainer(stock.id, workplace.stockContainer, sim.time, -1));
}
sim.logistics.packages.clear();
const inputPackageId = Math.max(0, ...sim.logistics.packages.keys()) + 1;
sim.logistics.packages.set(inputPackageId, { id: inputPackageId, commodity: 'shovel', quantity: 1,
  state: 'delivery', x: 380.5, z: 357.5, reservedBy: null, truckId: -1 });
worker.x = 379.5; worker.z = 356.5; worker.path = null; worker.pathI = 0; worker.state = 'idle';
for (let step = 0; step < 20 && sim.logistics.packages.get(inputPackageId)?.state !== 'carried'; step++)
  sim.agents.updateWorkman(worker, 0.25, sim.world);
assert.equal(sim.logistics.packages.get(inputPackageId)?.state, 'carried',
  `the normal workman dispatcher claims a Delivery pallet package from a diagonal approach; ${worker.state}@${worker.x.toFixed(1)},${worker.z.toFixed(1)} path=${worker.path?.length ?? '-'}:${worker.pathI}; warnings=${[...sim.task2.work.warnings].join(';')}`);
assert.equal(sim.task2.work.saveData().inputHauls.find(([id]) => id === worker.id)?.[1].phase, 'dropoff',
  'the physical delivery package is carried for workplace stocking');
for (let step = 0; step < 600 && sim.logistics.packages.has(inputPackageId); step++)
  sim.agents.updateWorkman(worker, 0.25, sim.world);
assert.ok(!sim.logistics.packages.has(inputPackageId), 'the workman completes the physical delivery from pallet to workplace stock');
assert.equal(sim.task2.items.itemsIn(workplace.stockContainer).filter(item => item.defId === 'shovel').length, 2,
  'workplace stock receives the exact delivered shovel quantity');
worker.path = null; worker.pathI = 0; worker.state = 'idle';
for (let step = 0; step < 600 && !sim.task2.work.activeTools.has(prisoner.id); step++)
  sim.task2.work.updateWorker(prisoner, 0.1, sim.time + step * 0.1, sim.world);
assert.ok(sim.task2.work.activeTools.has(prisoner.id), `the assigned worker claims a controlled tool before work; ${prisoner.state}@${prisoner.x.toFixed(1)},${prisoner.z.toFixed(1)} needs=${prisoner.needs.food}/${prisoner.needs.sleep} cuff=${prisoner.cuffed} escort=${prisoner.escortedBy} unavailable=${sim.task2.health.isUnavailable(prisoner.id)} workplace=${workplace.blocked}; path=${prisoner.path?.length ?? 'none'}:${prisoner.pathI}; stock=${sim.task2.items.itemsIn(workplace.stockContainer).map(row => row.defId).join(',')}`);
const leasedTool = sim.task2.work.activeTools.get(prisoner.id)!;
const savedFood = prisoner.needs.food;
prisoner.needs.food = 0.1;
assert.equal(sim.task2.work.updateWorker(prisoner, 0.1, sim.time + 61, sim.world), false, 'urgent hunger yields the Work activity to ordinary resident care');
assert.equal(sim.task2.work.activeTools.has(prisoner.id), false, 'urgent care returns the controlled tool lease');
assert.equal(sim.task2.items.items.get(leasedTool)?.containerId, workplace.stockContainer, 'the returned work tool is physically restocked');
prisoner.needs.food = savedFood;
for (let step = 0; step < 20 && !sim.task2.work.activeTools.has(prisoner.id); step++)
  sim.task2.work.updateWorker(prisoner, 0.1, sim.time + 62 + step * 0.1, sim.world);
assert.ok(sim.task2.work.activeTools.has(prisoner.id), 'the worker can reclaim the tool after care');
prisoner.cuffed = true;
prisoner.state = 'cuffed';
assert.equal(sim.task2.work.updateWorker(prisoner, 0.1, sim.time + 65, sim.world), false, 'cuffed workers yield to custody escort');
assert.equal(sim.task2.items.items.get(leasedTool)?.containerId, workplace.stockContainer, 'cuffing returns the tool to workplace stock');
prisoner.cuffed = false;
prisoner.state = 'idle';
for (let step = 0; step < 20 && !sim.task2.work.activeTools.has(prisoner.id); step++)
  sim.task2.work.updateWorker(prisoner, 0.1, sim.time + 66 + step * 0.1, sim.world);
assert.ok(sim.task2.work.activeTools.has(prisoner.id), 'the worker can reclaim the tool after custody clears');
prisoner.escortedBy = sim.agents.agents.find(agent => agent.kind === Obj.Guard)!.id;
prisoner.state = 'escorted';
assert.equal(sim.task2.work.updateWorker(prisoner, 0.1, sim.time + 69, sim.world), false, 'an escorted worker yields to the escort');
assert.equal(sim.task2.items.items.get(leasedTool)?.containerId, workplace.stockContainer, 'escort handoff returns the tool');
prisoner.escortedBy = -1;
prisoner.state = 'idle';
for (let step = 0; step < 20 && !sim.task2.work.activeTools.has(prisoner.id); step++)
  sim.task2.work.updateWorker(prisoner, 0.1, sim.time + 70 + step * 0.1, sim.world);
assert.ok(sim.task2.work.activeTools.has(prisoner.id), 'the worker can reclaim the tool after escort');
assert.equal(sim.task2.work.updateWorker(prisoner, 0.1, sim.time + 73, sim.world, true), false, 'medical unavailability yields to care routing');
assert.equal(sim.task2.items.items.get(leasedTool)?.containerId, workplace.stockContainer, 'medical handoff returns the tool');
for (let step = 0; step < 600 && workplace.completed === 0; step++)
  sim.task2.work.updateWorker(prisoner, 0.1, sim.time + step * 0.1, sim.world);
assert.equal(workplace.completed, 1, `the resident completes a real paid contract job with physical inputs; ${prisoner.state}@${prisoner.x.toFixed(1)},${prisoner.z.toFixed(1)} workplace=${workplace.blocked}; stock=${sim.task2.items.itemsIn(workplace.stockContainer).map(row => row.defId).join(',')}; hands=${sim.task2.items.itemsIn(`agent:${prisoner.id}:hands`).map(row => row.defId).join(',')}`);
sim.task2.work.tick(0.1, 270, sim.world, sim.agents.agents, sim.task2.health, true);
assert.ok(sim.economy.ledger.some(entry => entry.kind === 'work-wage' && entry.amount === -2), 'the standard-risk job pays its hourly packet');
const item = sim.task2.items.itemsIn(workplace.outputContainer).find(row => row.defId === 'produce-crate')!;
assert.ok(item, 'resident production creates physical contract output');
sim.task2.items.ensureContainer({ id: `agent:${worker.id}:hands`, name: 'Worker hands', x: worker.x, z: worker.z,
  capacity: 2, concealment: 0, bodyCapacity: 0, lockedTier: 'none', ownerId: worker.id, tags: ['hands'] });
assert.ok(sim.task2.items.moveToContainer(item.id, `agent:${worker.id}:hands`, sim.time, worker.id));
// The worker approaches from the diagonal corner: the pallet is impassable,
// so drop-off must find a cardinal adjacent stance instead of routing onto it.
worker.x = 379.5; worker.z = 372.5; worker.path = null; worker.pathI = 0;
sim.task2.work.hauls.set(worker.id, { itemId: item.id, phase: 'dropoff' });
for (let step = 0; step < 40 && !sim.logistics.externalExports.has(item.id); step++)
  sim.task2.work.updateHauler(worker, 0.25, sim.time + step * 0.25, sim.world, false);
assert.ok(sim.logistics.externalExports.has(item.id),
  `a workman drops output at the Exports pallet from a diagonal approach; warnings: ${[...sim.task2.work.warnings].join('; ')}; worker=${worker.x.toFixed(1)},${worker.z.toFixed(1)} ${worker.state} path=${worker.path?.length ?? 'none'}:${worker.pathI}; item=${sim.task2.items.items.get(item.id)?.locationKind}/${sim.task2.items.items.get(item.id)?.containerId}`);
assert.equal(sim.task2.items.items.get(item.id)?.containerId, 'institution:work-exports');

// Keep unrelated onboarding deliveries from delaying this single scheduled
// export pickup; the Delivery room itself remains present and valid.
sim.logistics.requests.length = 0;
sim.logistics.trucks.length = 0;
for (let step = 0; step < 120 && !sim.economy.ledger.some(entry => entry.kind === 'export'); step++)
  sim.logistics.tick(1, 480 + step, sim.world);
assert.ok(sim.economy.ledger.some(entry => entry.kind === 'fee' && entry.memo === 'Export collection truck'), 'the scheduled collection truck charges its fee');
assert.ok(sim.economy.ledger.some(entry => entry.kind === 'export' && entry.amount > 0), 'the collection truck credits the exported item');

// Two actual Yard rooms request their own shared tools and fertilizer through
// WorkSystem.refresh; LogisticsSystem allocates the resulting live sources and
// the standard workman dispatcher moves every purchased package off the pallet.
const secondYardBounds = { x: 355, z: 361, w: 10, d: 10 };
for (let x = secondYardBounds.x; x < secondYardBounds.x + secondYardBounds.w; x++)
  for (let z = secondYardBounds.z; z < secondYardBounds.z + secondYardBounds.d; z++) sim.world.setFloor(x, z, 1);
const secondYardId = sim.world.startRoomPaint(secondYardBounds.x, secondYardBounds.z, RoomType.Yard);
for (let x = secondYardBounds.x; x < secondYardBounds.x + secondYardBounds.w; x++)
  for (let z = secondYardBounds.z; z < secondYardBounds.z + secondYardBounds.d; z++) sim.world.paintRoomInto(x, z, secondYardId);
sim.world.endRoomPaint(secondYardId);
const secondYard = sim.world.rooms.get(secondYardId)!;
assert.ok(secondYard.valid, `the second physical Yard room is valid: ${sim.world.roomIssues(secondYard).map(issue => issue.message).join('; ')}`);
sim.task2.rebuildWorld(sim.world);
sim.task2.work.refresh(sim.world, 990);
sim.task2.work.unassign(prisoner.id, 1000);
sim.task2.work.unassign(impostor!.id, 1000);
for (const roomId of [outputRoom.id, secondYard.id]) {
  const stockContainer = sim.task2.work.workplaces.get(roomId)?.stockContainer;
  if (stockContainer) for (const stock of sim.task2.items.itemsIn(stockContainer)) sim.task2.items.destroy(stock.id, 1000, -1, 'procurement-check-reset');
}
for (const workplace of sim.task2.work.workplaces.values()) {
  if ([outputRoom.id, secondYard.id].includes(workplace.roomId)) continue;
  const def = JOB_DEFS.find(job => job.id === workplace.jobId)!;
  const stock = sim.task2.items.itemsIn(workplace.stockContainer);
  for (const toolId of def.toolIds) {
    const target = Math.max(1, Math.min(3, workplace.capacity || 1));
    while (stock.filter(item => item.defId === toolId).length < target) {
      const item = sim.task2.items.create(toolId, 1000);
      sim.task2.items.moveToContainer(item.id, workplace.stockContainer, 1000, -1);
      stock.push(item);
    }
  }
  for (const [inputId, perJob] of Object.entries(JOB_INPUTS[def.id] ?? {})) {
    const target = Math.max(4, workplace.capacity * perJob * 3);
    while (stock.filter(item => item.defId === inputId).length < target) {
      const item = sim.task2.items.create(inputId, 1000);
      sim.task2.items.moveToContainer(item.id, workplace.stockContainer, 1000, -1);
      stock.push(item);
    }
  }
}
sim.logistics.loadData({ packages: [], trucks: [], requests: [], demands: [], externalExports: [], collectedExternal: [],
  nextPackageId: 1, nextRequestId: 1, nextTruckId: 1, lastExportDay: -1 });
const noAssignmentPurchaseCount = sim.economy.ledger.filter(entry => entry.kind === 'purchase').length;
for (let step = 0; step <= 80; step++) {
  const time = 990 + step * 0.1;
  sim.task2.work.refresh(sim.world, time);
  sim.logistics.tick(0.1, time, sim.world);
}
assert.equal(sim.logistics.saveData().demands.filter(row => row.source.startsWith('work:')).length, 0,
  'valid but unassigned workrooms create no inmate-work procurement demand');
assert.equal(sim.economy.ledger.filter(entry => entry.kind === 'purchase').length, noAssignmentPurchaseCount,
  'vacant production rooms neither buy nor dispatch work supplies');
assert.ok(sim.task2.work.assign(impostor!.id, secondYard.id), 'a live resident can be assigned to test its demand lifecycle');
sim.task2.work.refresh(sim.world, 999);
assert.ok(sim.logistics.saveData().demands.some(row => row.source === `work:${secondYard.id}`),
  'assigning a resident activates that room’s work stock demand');
sim.task2.work.releaseAgent(impostor!, 999.1);
sim.task2.work.refresh(sim.world, 999.2);
assert.ok(!sim.task2.work.assignments.has(impostor!.id) &&
  !sim.logistics.saveData().demands.some(row => row.source === `work:${secondYard.id}`),
  'releasing a departing or dead worker clears its assignment and vacant-room demand');
assert.equal(sim.economy.ledger.filter(entry => entry.kind === 'purchase').length, noAssignmentPurchaseCount,
  'a departing worker whose demand is cleared before consolidation incurs no supply charge');
assert.ok(sim.task2.work.assign(prisoner.id, outputRoom.id), 'the existing Yard has an assigned worker for its procurement demand');
assert.ok(sim.task2.work.assign(impostor!.id, secondYard.id), 'the second Yard has an assigned worker for its procurement demand');
const procurementStart = 1000;
sim.task2.work.refresh(sim.world, procurementStart);
const existingYardWork = sim.task2.work.workplaces.get(outputRoom.id)!;
const secondYardWork = sim.task2.work.workplaces.get(secondYard.id)!;
const yardSources = new Set([`work:${outputRoom.id}`, `work:${secondYard.id}`]);
const sharedDemand = (commodity: string) => sim.logistics.saveData().demands
  .filter(row => yardSources.has(row.source) && row.commodity === commodity)
  .reduce((sum, row) => sum + row.quantity, 0);
const expectedShared = { shovel: 6, 'pruning-shears': 6, fertilizer: 60 };
for (const [commodity, expected] of Object.entries(expectedShared)) assert.equal(sharedDemand(commodity), expected,
  `the two real Yard source demands aggregate the exact ${commodity} requirement without subtracting their shared pipeline`);
const initialDemandAges = new Map(sim.logistics.saveData().demands.filter(row => yardSources.has(row.source))
  .map(row => [`${row.source}::${row.commodity}`, row.createdAt]));
const purchasesBefore = sim.economy.ledger.filter(entry => entry.kind === 'purchase').length;
const packageSummary = (commodity: string) => [...sim.logistics.packages.values()]
  .filter(pkg => pkg.commodity === commodity).reduce((sum, pkg) => sum + pkg.quantity, 0);
worker.x = 379.5; worker.z = 356.5; worker.path = null; worker.pathI = 0; worker.state = 'idle';
let completedSharedStock = false;
let procurementStep = 0;
for (; procurementStep < 75; procurementStep++) {
  const time = procurementStart + procurementStep * 0.1;
  sim.task2.work.refresh(sim.world, time);
  sim.logistics.tick(0.1, time, sim.world);
  for (const row of sim.logistics.saveData().demands.filter(row => yardSources.has(row.source)))
    assert.equal(row.createdAt, initialDemandAges.get(`${row.source}::${row.commodity}`), 'continuous workplace refresh preserves the source demand age through truck consolidation');
}
sim.task2.work.refresh(sim.world, procurementStart + 7.5);
sim.logistics.tick(0.1, procurementStart + 7.5, sim.world);
assert.equal(sim.economy.ledger.filter(entry => entry.kind === 'purchase').length - purchasesBefore, 1,
  'both continuously refreshed Yard demands consolidate into one paid procurement');
for (const [commodity, expected] of Object.entries(expectedShared)) assert.equal(packageSummary(commodity), expected,
  `the paid inbound cargo contains the exact aggregate ${commodity} quantity for both Yards`);
const secondSource = `work:${secondYard.id}`;
sim.task2.work.unassign(impostor!.id, procurementStart + 7.6);
sim.task2.work.refresh(sim.world, procurementStart + 7.6);
assert.ok(!sim.logistics.saveData().demands.some(row => row.source === secondSource),
  'unassigning a resident clears that vacant workplace demand');
for (const [commodity, expected] of Object.entries(expectedShared)) assert.equal(packageSummary(commodity), expected,
  `already paid ${commodity} cargo remains in transit when one workplace becomes vacant`);
assert.ok(sim.task2.work.assign(impostor!.id, secondYard.id), 'the second Yard can be staffed again');
sim.task2.work.refresh(sim.world, procurementStart + 7.7);
assert.equal(sim.economy.ledger.filter(entry => entry.kind === 'purchase').length - purchasesBefore, 1,
  'reassigning a room reuses its already paid in-transit cargo instead of buying again');
assert.equal(sim.logistics.saveData().requests.length, 0,
  'free in-transit cargo satisfies both rooms after the second assignment returns');
secondYard.valid = false;
sim.task2.work.refresh(sim.world, procurementStart + 7.8);
assert.ok(!sim.task2.work.workplaces.has(secondYard.id) && !sim.task2.work.assignments.has(impostor!.id),
  'invalidating a workplace removes its assignment');
assert.ok(!sim.logistics.saveData().demands.some(row => row.source === secondSource),
  'invalidating a workplace clears its procurement source');
for (const [commodity, expected] of Object.entries(expectedShared)) assert.equal(packageSummary(commodity), expected,
  `invalidating a workplace retains its already paid ${commodity} cargo`);
secondYard.valid = true;
sim.task2.rebuildWorld(sim.world);
sim.task2.work.refresh(sim.world, procurementStart + 7.9);
assert.ok(sim.task2.work.assign(impostor!.id, secondYard.id), 'a repaired Yard can accept its previous resident assignment');
sim.task2.work.refresh(sim.world, procurementStart + 8);
assert.equal(sim.economy.ledger.filter(entry => entry.kind === 'purchase').length - purchasesBefore, 1,
  'repaired and restaffed workplaces reuse preserved in-transit purchases');
for (procurementStep = 0; procurementStep < 12000 && !completedSharedStock; procurementStep++) {
  const time = procurementStart + 8 + procurementStep * 0.1;
  sim.task2.work.refresh(sim.world, time);
  sim.logistics.tick(0.1, time, sim.world);
  sim.agents.updateWorkman(worker, 0.1, sim.world);
  const bothStocks = [existingYardWork, secondYardWork].map(workplace => sim.task2.items.itemsIn(workplace.stockContainer));
  completedSharedStock = bothStocks.reduce((sum, stock) => sum + stock.filter(item => item.defId === 'shovel').length, 0) === expectedShared.shovel &&
    bothStocks.reduce((sum, stock) => sum + stock.filter(item => item.defId === 'pruning-shears').length, 0) === expectedShared['pruning-shears'] &&
    bothStocks.reduce((sum, stock) => sum + stock.filter(item => item.defId === 'fertilizer').length, 0) === expectedShared.fertilizer;
}
assert.ok(completedSharedStock,
  `shared Yard procurement reaches real local stock via two physical workrooms and standard workman dispatch in ${procurementStep} steps; stockA=${sim.task2.items.itemsIn(existingYardWork.stockContainer).map(item => item.defId).join(',')} stockB=${sim.task2.items.itemsIn(secondYardWork.stockContainer).map(item => item.defId).join(',')} packages=${[...sim.logistics.packages.values()].map(pkg => `${pkg.commodity}:${pkg.quantity}:${pkg.state}@${pkg.x.toFixed(1)},${pkg.z.toFixed(1)}`).join('|')} worker=${worker.state}@${worker.x.toFixed(1)},${worker.z.toFixed(1)} path=${worker.path?.length ?? 'none'}:${worker.pathI} trucks=${sim.logistics.trucks.map(truck => `${truck.kind}/${truck.state}/${truck.warning}`).join(',')} warnings=${[...sim.logistics.warnings].join(';')}`);
assert.equal(sim.economy.ledger.filter(entry => entry.kind === 'purchase').length - purchasesBefore, 1,
  'continuous workplace refresh consolidates both rooms into one actual procurement purchase');
for (const [commodity, expected] of Object.entries(expectedShared)) {
  const totalStock = [existingYardWork, secondYardWork].reduce((sum, workplace) =>
    sum + sim.task2.items.itemsIn(workplace.stockContainer).filter(item => item.defId === commodity).length, 0);
  assert.equal(totalStock, expected, `${commodity} packages are split into exact physical stock across the two Yard rooms`);
  assert.equal(packageSummary(commodity), 0, `the ${commodity} delivery is physically removed from the pallet and consumed into workplace stock`);
}
const secondStockBeforeVacancy = Object.fromEntries(Object.keys(expectedShared).map(commodity => [commodity,
  sim.task2.items.itemsIn(secondYardWork.stockContainer).filter(item => item.defId === commodity).length]));
sim.task2.work.unassign(impostor!.id, 2000);
sim.task2.work.refresh(sim.world, 2000);
assert.ok(!sim.logistics.saveData().demands.some(row => row.source === secondSource),
  'vacating a stocked workplace clears future procurement');
for (const [commodity, count] of Object.entries(secondStockBeforeVacancy)) assert.equal(
  sim.task2.items.itemsIn(secondYardWork.stockContainer).filter(item => item.defId === commodity).length, count,
  `already delivered ${commodity} stock remains in the vacant workplace for later assignment`);
assert.equal(sim.economy.ledger.filter(entry => entry.kind === 'purchase').length - purchasesBefore, 1,
  'stock cleanup never creates a second work supply charge');
console.log('Real shared Yard demands refresh continuously, consolidate once, and reach exact stock through the physical delivery pallet and workman route; work contracts also export and pay.');
