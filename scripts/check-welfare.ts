import assert from 'node:assert/strict';
import { blankAgent } from '../src/sim/agent.ts';
import { WelfareSystem } from '../src/sim/welfare.ts';
import { Obj, RoomType, World } from '../src/sim/world.ts';

const world=new World(64), welfare=new WelfareSystem();
const resident=blankAgent(Obj.Prisoner), guard=blankAgent(Obj.Guard);
resident.id=1;resident.x=10.5;resident.z=10.5;resident.state='idle';resident.cuffed=false;resident.needs.safety=.1;resident.needs.privacy=.1;
guard.id=2;guard.x=12.5;guard.z=10.5;guard.state='idle';
welfare.refresh(world,[resident,guard]);welfare.tick(resident,30,world);
assert.ok(resident.needs.safety>.1,'visible on-duty staff restore safety');
resident.needs.safety=.1;guard.state='staffBreak';
welfare.refresh(world,[resident,guard]);welfare.tick(resident,30,world);
assert.equal(resident.needs.safety,.1,'staff on break provide no active coverage');
guard.state='idle';world.setWall(11,10,1);
welfare.refresh(world,[resident,guard]);welfare.tick(resident,30,world);
assert.equal(resident.needs.safety,.1,'guards behind opaque barriers are not perceived');
world.erase(11,10);
const fighter=blankAgent(Obj.Prisoner);fighter.id=3;fighter.state='fighting';fighter.x=11.5;fighter.z=10.5;
resident.needs.safety=.5;
welfare.refresh(world,[resident,guard,fighter]);welfare.tick(resident,30,world);
assert.ok(resident.needs.safety<.5,'nearby violence reduces safety despite staff presence');

const home={id:1,type:RoomType.Cell,access:0,valid:true,ambience:0,guards:0,tiles:new Set<number>()};
world.rooms.set(1,home);resident.cellRoom=1;
for(let z=9;z<=11;z++)for(let x=9;x<=11;x++){const tile=world.idx(x,z);home.tiles.add(tile);world.roomId[tile]=1;}
resident.needs.privacy=.1;welfare.refresh(world,[resident]);welfare.tick(resident,60,world);
const privateGain=resident.needs.privacy;
assert.ok(privateGain>.1,'time in own cell restores privacy');
home.type=RoomType.Dorm;fighter.state='idle';fighter.x=10.5;resident.needs.privacy=.1;
welfare.refresh(world,[resident,fighter]);welfare.tick(resident,60,world);
assert.ok(resident.needs.privacy>.1&&resident.needs.privacy<privateGain,'shared dormitory provides less privacy than an individual cell');
resident.cellRoom=2;resident.needs.privacy=.1;
welfare.refresh(world,[resident]);welfare.tick(resident,60,world);
assert.equal(resident.needs.privacy,.1,'other inmates housing cannot substitute for assigned privacy');
console.log('Contextual safety, visibility, violence, and cell/dorm privacy: passed');
