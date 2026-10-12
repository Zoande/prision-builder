import { World, Obj, RoomType } from '../../src/sim/world.ts';
import { Agents } from '../../src/sim/agents.ts';
import { EconomySystem } from '../../src/sim/economy.ts';
import { LogisticsSystem } from '../../src/sim/logistics.ts';
import { ConstructionSystem } from '../../src/sim/construction.ts';
import { KitchenSystem } from '../../src/sim/kitchen.ts';
import { IntakeSystem } from '../../src/sim/intake.ts';
import { InfrastructureSystem } from '../../src/sim/infrastructure.ts';
import { Task2Systems } from '../../src/sim/task2Systems.ts';
import { Task3Systems } from '../../src/sim/task3Systems.ts';
import { seedRng } from '../../src/sim/rng.ts';
import { advanceSimulation } from '../../src/sim/simulation.ts';

export function createPrison(seed=12345, prisoners=12) {
  seedRng(seed);
  const world=new World(500), agents=new Agents(), economy=new EconomySystem();
  const logistics=new LogisticsSystem(economy), construction=new ConstructionSystem(logistics);
  const kitchen=new KitchenSystem(logistics), intake=new IntakeSystem(economy);
  const infrastructure=new InfrastructureSystem(world);
  const task2=new Task2Systems(world.size,economy,logistics), task3=new Task3Systems(task2,economy,logistics);
  const systems={world,agents,economy,logistics,construction,kitchen,intake,task2,task3};
  kitchen.physicalItems=task2.items;
  agents.construction=construction;agents.kitchen=kitchen;agents.task2=task2;agents.task3=task3;
  task2.social=agents.social;task2.escapeOperations=agents.escapeOperations;
  infrastructure.installNewGame();
  const pending: {x:number,z:number,w:number,d:number,type:number}[]=[];
  function room(x:number,z:number,w:number,d:number,type:number,jail=false) {
    for(let tx=x-1;tx<=x+w;tx++){world.setWall(tx,z-1,1);world.setWall(tx,z+d,1);}
    for(let tz=z;tz<z+d;tz++){world.setWall(x-1,tz,1);world.setWall(x+w,tz,1);}
    world.setDoor(x+Math.floor(w/2),z+d,jail);
    for(let tx=x;tx<x+w;tx++)for(let tz=z;tz<z+d;tz++)world.setFloor(tx,tz,1);
    pending.push({x,z,w,d,type});
  }
  function piece(x:number,z:number,kind:number,o=0) {
    if(!world.placePiece(x,z,kind,o)) throw new Error(`Fixture cannot place ${kind} at ${x},${z}`);
  }
  for(let x=305;x<=370;x++){world.setFence(x,329,1);world.setFence(x,405,1);}
  for(let z=330;z<405;z++){world.setFence(305,z,1);world.setFence(370,z,1);}
  world.setFenceGate(370,375,true);
  world.setFenceGate(363,375,false);
  room(320,334,12,9,RoomType.Dorm,true);
  room(340,334,12,9,RoomType.Dorm,true);
  for(const x0 of [320,340]){
    for(let j=0;j<8;j++)piece(x0+1+(j%4)*3,335+Math.floor(j/4)*4,Obj.Bed);
    piece(x0+1,341,Obj.Toilet);piece(x0+5,341,Obj.Toilet);
  }
  room(320,348,8,9,RoomType.Kitchen);
  piece(321,349,Obj.Freezer);piece(324,349,Obj.Freezer);piece(321,352,Obj.Cooker);piece(324,352,Obj.Cooker);piece(321,355,Obj.Sink);
  room(332,348,20,11,RoomType.Canteen);
  for(let j=0;j<4;j++){piece(334+j*4,350,Obj.Table);piece(334+j*4,351,Obj.Bench2);piece(334+j*4,354,Obj.Table);piece(334+j*4,355,Obj.Bench2);}
  piece(334,357,Obj.ServingTable);piece(340,357,Obj.ServingTable);
  room(356,334,10,9,RoomType.StaffRoom);piece(357,335,Obj.CoffeeMachine);piece(360,336,Obj.Sofa);piece(360,339,Obj.Armchair);
  room(356,348,10,10,RoomType.Reception);piece(357,349,Obj.SearchTable);piece(361,349,Obj.UniformRack);piece(357,353,Obj.Bench4);
  room(320,363,8,9,RoomType.ShowerRoom);for(let j=0;j<3;j++)piece(321+j*2,364,Obj.Shower);piece(324,369,Obj.Drain);
  room(332,363,10,9,RoomType.Library);piece(333,364,Obj.BookshelfLarge);piece(337,367,Obj.ReadingDesk);piece(335,369,Obj.Armchair);
  room(345,363,9,9,RoomType.Gym);piece(346,364,Obj.Treadmill);piece(350,364,Obj.PunchingBag);piece(347,368,Obj.WeightBench);
  room(338,381,14,12,RoomType.Infirmary);
  piece(339,382,Obj.MedicalBed);piece(342,382,Obj.MedicalBed);piece(345,382,Obj.MedicalBed);
  piece(339,387,Obj.TreatmentTable);piece(349,382,Obj.MedicineCabinet);piece(348,387,Obj.Sink);
  room(307,348,5,5,RoomType.Solitary,true);piece(308,349,Obj.Bed);piece(310,352,Obj.Toilet);
  room(307,357,5,5,RoomType.Solitary,true);piece(308,358,Obj.Bed);piece(310,361,Obj.Toilet);
  room(307,367,8,7,RoomType.Interview);piece(308,368,Obj.InterviewTable);piece(312,370,Obj.Chair);
  room(307,381,8,8,RoomType.Security);piece(308,382,Obj.MonitorBank);piece(312,385,Obj.AlarmPanel);
  room(307,393,8,7,RoomType.Armoury);piece(308,394,Obj.WeaponLocker);
  room(356,381,11,9,RoomType.CommonRoom);piece(357,382,Obj.Television);piece(361,383,Obj.Sofa);piece(358,386,Obj.ChessTable);
  room(356,393,11,9,RoomType.Morgue);piece(357,394,Obj.MorgueSlab);piece(361,394,Obj.MorgueSlab);
  room(319,397,9,6,RoomType.Chapel);piece(320,398,Obj.Altar);piece(323,400,Obj.Pew);
  for(let x=319;x<335;x++)for(let z=377;z<396;z++)world.setFloor(x,z,1);
  pending.push({x:319,z:377,w:16,d:19,type:RoomType.Yard});
  world.recomputeRoofs();world.recomputeRooms();
  for(const r of pending){const id=world.startRoomPaint(r.x,r.z,r.type);for(let x=r.x;x<r.x+r.w;x++)for(let z=r.z;z<r.z+r.d;z++)world.paintRoomInto(x,z,id);world.endRoomPaint(id);}
  for(const [kind,x,z] of [[Obj.Workman,366,373],[Obj.Workman,365,373],[Obj.Cook,322,354],[Obj.Cook,325,354],[Obj.Cook,326,354],[Obj.Guard,334,360],[Obj.Guard,342,360],[Obj.Guard,358,360],[Obj.Guard,326,375],[Obj.Guard,334,375],[Obj.Guard,340,375],[Obj.Doctor,356,375],[Obj.Doctor,357,375]] ) world.setPerson(x,z,kind,0);
  for(let i=0;i<prisoners;i++)if(!world.setPerson(320+i%12,380+Math.floor(i/12),Obj.Prisoner,0)) throw new Error(`Cannot spawn inmate ${i}`);
  for(let i=0;i<prisoners;i++)economy.markPrisonerProcessed();
  agents.sync(world);task2.installNewGame(world);task3.installNewGame(world,240);
  let time=240;
  function rebuild(){world.recomputeRoofs();world.recomputeRooms();task2.rebuildWorld(world);task3.rebuildWorld(world);}
  function advance(seconds:number){
    for(let remaining=seconds;remaining>1e-9;remaining-=.1){time=advanceSimulation(systems,time,Math.min(.1,remaining));if(agents.takeWorldDirty())rebuild();}
    return time;
  }
  function snapshot() {
    return structuredClone({version:6,savedAt:new Date().toISOString(),worldTime:time,
      world:world.saveData(),agents:agents.saveData(),economy:economy.saveData(),
      logistics:logistics.saveData(),construction:construction.saveData(),kitchen:kitchen.saveData(),
      intake:intake.saveData(),infrastructure:infrastructure.saveData(),task2:task2.saveData(),task3:task3.saveData()});
  }
  function restore(data:ReturnType<typeof snapshot>) {
    world.loadData(data.world);infrastructure.loadData(data.infrastructure);agents.loadData(data.agents);
    economy.loadData(data.economy);logistics.loadData(data.logistics);construction.loadData(data.construction);
    kitchen.loadData(data.kitchen);intake.loadData(data.intake);task2.loadData(data.task2,world);task3.loadData(data.task3,world);
    construction.reconcile(world,new Set(agents.agents.filter(a=>a.kind===Obj.Workman).map(a=>a.id)));
    time=data.worldTime;rebuild();
  }
  return {...systems,infrastructure,advance,rebuild,snapshot,restore,get time(){return time;}};
}
