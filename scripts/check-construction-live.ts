import assert from 'node:assert/strict';
import { ConstructionSystem } from '../src/sim/construction.ts';
import { LogisticsSystem } from '../src/sim/logistics.ts';
import { EconomySystem } from '../src/sim/economy.ts';
import { Obj, World } from '../src/sim/world.ts';
import { createPrison } from './scenarios/prison.ts';

// Bulk payloads stay physical: one target owns exactly its recipe; the surplus
// is staged nearby. Interrupting a staged target cannot grant free materials.
{
  const world=new World(60), logistics=new LogisticsSystem(new EconomySystem()), construction=new ConstructionSystem(logistics);
  logistics.addSalvage('concrete',6,1,1);
  const group=construction.plan({cat:'floor',mat:1},Array.from({length:6},(_,i)=>({x:20+i,z:20})),0,0,world)!;
  const first=construction.claimNext(1,19,20,world)!;
  assert.equal(logistics.packages.get(first.packageId)!.quantity,5,'carry a full bulk package');
  assert.equal(logistics.saveData().requests.length,0,'in-flight payload covers all local targets without duplicate procurement');
  construction.pickUpBundle(group.id,first.target.id,first.packageId,1,19,20);
  construction.deliverBundle(group.id,first.target.id,first.packageId,1);
  assert.equal(first.target.delivered.concrete,1,'only the exact floor recipe is committed');
  assert.equal(logistics.quantity('concrete'),5,'the surplus remains available physical stock');
  const work=construction.claimNext(1,19,20,world)!;
  assert.equal(work.phase,'work');
  construction.releaseWorker(1);
  assert.deepEqual(work.target.delivered,{},'released materials are not still credited to the old target');
  assert.equal(logistics.quantity('concrete'),6);
  construction.tick(3);
  const nearer=construction.claimNext(2,20,20,world)!;
  assert.equal(logistics.packages.get(nearer.packageId)!.x,20,'reuse site stock before remote delivery stock');
  construction.pickUpBundle(group.id,nearer.target.id,nearer.packageId,2,20,20);
  construction.deliverBundle(group.id,nearer.target.id,nearer.packageId,2);
  for(let attempts=0;group.state!=='complete'&&attempts<30;attempts++){
    const claim=construction.claimNext(2,20,20,world)!;
    assert.ok(claim);
    if(claim.phase==='haul'){
      construction.pickUpBundle(group.id,claim.target.id,claim.packageId,2,20,20);
      construction.deliverBundle(group.id,claim.target.id,claim.packageId,2);
    }else assert.ok(construction.complete(group.id,claim.target.id,2,world));
  }
  assert.equal(group.state,'complete');
  assert.equal([...logistics.packages.values()].reduce((sum,pkg)=>sum+pkg.quantity,0),0,'six floors consume exactly six concrete');
  assert.equal(logistics.saveData().requests.length,0);
}

// Adjacent bridges need two commodities. Once concrete is delivered to the
// first bridge, the neighbor's concrete demand must not delay its metal.
{
  const world=new World(500), logistics=new LogisticsSystem(new EconomySystem()), construction=new ConstructionSystem(logistics);
  logistics.addSalvage('concrete',40,360,100);logistics.addSalvage('metal',20,360,100);
  const group=construction.plan({cat:'piece',mat:Obj.SecureBridge},[{x:370,z:100},{x:370,z:104}],0,0,world)!;
  assert.equal(group.targets.length,2);
  for(let attempts=0;group.state!=='complete'&&attempts<40;attempts++){
    const claim=construction.claimNext(1,370,100,world)!;
    assert.ok(claim);
    if(claim.phase==='haul'){
      construction.pickUpBundle(group.id,claim.target.id,claim.packageId,1,370,100);
      construction.deliverBundle(group.id,claim.target.id,claim.packageId,1);
    }else assert.ok(construction.complete(group.id,claim.target.id,1,world));
  }
  assert.equal(group.state,'complete','finish both multi-commodity structures');
  assert.equal(world.piecesOfKind(Obj.SecureBridge).length,2);
  assert.equal(logistics.packages.size,0,'consume exactly both recipes');
}

// Real workers, trucks and pathfinding run an expansion. Fire a worker while
// carrying a bulk package, then reload while work is in progress; the survivor
// must reuse recovered cargo and finish without orphan claims or extra stock.
{
  const sim=createPrison(7781,0);
  const tiles=Array.from({length:24},(_,i)=>({x:316+i%8,z:410+Math.floor(i/8)}));
  const planned=sim.construction.plan({cat:'floor',mat:1},tiles,0,sim.time,sim.world)!;
  let fired=false,reloaded=false,elapsed=0;
  for(;elapsed<720;elapsed++){
    sim.advance(1);
    const group=sim.construction.groups.get(planned.id)!;
    if(!fired){
      const worker=sim.agents.agents.find(a=>a.kind===Obj.Workman&&a.buildGroup===group.id&&
        [...sim.logistics.packages.values()].some(p=>p.state==='carried'&&p.reservedBy===`build:${group.id}:${a.buildTarget}`));
      if(worker){sim.agents.removeAgent(worker);fired=true;}
    }
    if(fired&&!reloaded&&group.targets.some(target=>target.completed)){
      sim.restore(JSON.parse(JSON.stringify(sim.snapshot())));reloaded=true;
    }
    if(group.state==='complete')break;
  }
  const group=sim.construction.groups.get(planned.id)!;
  assert.ok(fired&&reloaded,'exercise actual hauling interruption and live reload');
  assert.equal(group.state,'complete',`expansion finishes in one day; ${group.targets.filter(t=>t.completed).length}/24 complete`);
  for(const tile of tiles)assert.equal(sim.world.floorMat[sim.world.idx(tile.x,tile.z)],1);
  assert.ok(group.targets.every(target=>target.claimedBy===-1));
  const remaining=[...sim.logistics.packages.values()].filter(pkg=>pkg.commodity==='concrete');
  assert.equal(remaining.reduce((sum,pkg)=>sum+pkg.quantity,0),0,'purchase exactly the required concrete despite fire/reload');
  console.log(`Live 24-tile expansion, fired carrier and save/reload recovered in ${elapsed}s.`);
}
console.log('Bulk construction, nearest stock reuse and exact material ownership: passed');
