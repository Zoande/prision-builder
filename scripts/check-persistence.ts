import assert from 'node:assert/strict';
import { createPrison } from './scenarios/prison.ts';
import { isSaveV6 } from '../src/sim/saveVersion.ts';
const sim=createPrison();
sim.advance(30);
const data=sim.snapshot();
assert.ok(isSaveV6(data),'full live snapshot is importable');
const firstAgent=data.agents.agents[0];
for(const bad of [{...data,worldTime:NaN},{...data,worldTime:-1},{...data,kitchen:null},{...data,world:{...data.world,size:50}}, {...data,agents:{...data.agents,agents:[...data.agents.agents,firstAgent]}}, {...data,world:{...data.world,tiles:[[250000,1,0,0,0,0]]}}, {...data,world:{...data.world,tiles:[[100,1,0,0,0,0],[100,1,0,0,0,0]]}},
 {...data,agents:{...data.agents,agents:[{...firstAgent,needs:null}]}}, {...data,agents:{...data.agents,agents:[{...firstAgent,kind:999}]}},
 {...data,world:{...data.world,pieces:[{...data.world.pieces[0],x:-10}]}}, {...data,world:{...data.world,rooms:[{...data.world.rooms[0],tiles:[250000]}]}},
 {...data,view:{target:[NaN,0,0],yaw:0,pitch:1,distance:72}}])assert.equal(isSaveV6(bad),false,'malformed save rejected before mutation');
const beforeItems=sim.task2.items.items.size;
const beforePeople=sim.agents.agents.length;
sim.restore(JSON.parse(JSON.stringify(data)));
assert.equal(sim.task2.items.items.size,beforeItems,'loading creates no extra physical items');
assert.equal(sim.agents.agents.length,beforePeople,'loading creates no extra people');
assert.equal(sim.time,data.worldTime);
sim.advance(30);
assert.ok(isSaveV6(sim.snapshot()),'resumed game remains saveable');
const owners=new Set(sim.agents.agents.map(a=>a.id));
for(const [bed,owner]of sim.agents.claimedBeds){assert.ok(owners.has(owner),`bed ${bed} has living owner`);}
console.log('Live simulation snapshot, malformed import rejection, and resumed item/agent ownership: passed');
