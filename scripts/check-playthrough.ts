// Gameplay soak using the same clock/update order as the browser.
// npm run check:playthrough -- --days=12 --seeds=12345,9876,773
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createPrison } from './scenarios/prison.ts';
import { Obj, NEEDS } from '../src/sim/world.ts';
import { Item, hasItem } from '../src/sim/items.ts';
import { HOUR_SECONDS } from '../src/sim/time.ts';

const option=(name:string,fallback:string)=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const days=Number(option('days','4'));
const seeds=option('seeds','12345,9876').split(',').map(Number);
assert.ok(Number.isInteger(days)&&days>=2&&days<=60,'days must be between 2 and 60');
assert.ok(seeds.length&&seeds.every(Number.isInteger),'provide integer RNG seeds');
const artifacts='/tmp/prison-builder-playthrough';
mkdirSync(artifacts,{recursive:true});

for(const seed of seeds){
  const sim=createPrison(seed);
  for(const room of sim.world.rooms.values())assert.ok(room.valid,`fixture room ${room.id} invalid: ${room.issue}`);
  const states=new Set<string>();
  const history=new Map<number,{samples:number,foodMin:number,foodMax:number,sleepMin:number,sleepMax:number,lowFoodHours:number,lowSleepHours:number}>();
  let measuredMeals=0, measuredWashes=0, measuredSleep=0, lastDirty=0, lastClean=0;
  const start=performance.now();
  try {
    for(let hour=0;hour<days*24;hour++){
      sim.advance(HOUR_SECONDS);
      const owners=new Map(sim.agents.agents.map(agent=>[agent.id,agent]));
      const live=(id:number)=>{
        const agent=owners.get(id);
        return !!agent&&!['dead','morgue','removed'].includes(agent.state)&&sim.task2.health.state(id)?.alive!==false;
      };
      for(const agent of sim.agents.agents){
        assert.ok(Number.isFinite(agent.x)&&Number.isFinite(agent.z),`nonfinite position ${agent.id}`);
        if(agent.kind!==Obj.Prisoner||!live(agent.id))continue;
        states.add(agent.state);
        for(const need of NEEDS)assert.ok(Number.isFinite(agent.needs[need])&&agent.needs[need]>=0&&agent.needs[need]<=1,`invalid ${need} ${agent.id}`);
        const row=history.get(agent.id)??{samples:0,foodMin:1,foodMax:0,sleepMin:1,sleepMax:0,lowFoodHours:0,lowSleepHours:0};
        row.samples++;row.foodMin=Math.min(row.foodMin,agent.needs.food);row.foodMax=Math.max(row.foodMax,agent.needs.food);
        row.sleepMin=Math.min(row.sleepMin,agent.needs.sleep);row.sleepMax=Math.max(row.sleepMax,agent.needs.sleep);
        const unavailable=agent.cuffed||agent.underground||sim.task2.health.isUnavailable(agent.id);
        row.lowFoodHours=!unavailable&&agent.needs.food<.05?row.lowFoodHours+1:0;
        row.lowSleepHours=!unavailable&&agent.needs.sleep<.05?row.lowSleepHours+1:0;
        assert.ok(row.lowFoodHours<4,`inmate ${agent.id} cannot obtain food for ${row.lowFoodHours} hours (${agent.state})`);
        assert.ok(row.lowSleepHours<6,`inmate ${agent.id} cannot sleep for ${row.lowSleepHours} hours (${agent.state})`);
        history.set(agent.id,row);
        if(agent.state==='using'&&sim.world.objKind[agent.useIdx]===Obj.Bed)measuredSleep++;
      }
      for(const [bed,owner]of sim.agents.claimedBeds)assert.ok(live(owner),`bed ${bed} retained by terminal/missing actor ${owner}`);
      for(const [anchor,claims]of sim.agents.useClaims)for(const owner of claims){
        const actor=owners.get(owner);
        assert.ok(live(owner)&&actor?.state==='using'&&actor.useIdx===anchor,`orphan use claim ${anchor}/${owner}`);
      }
      for(const pkg of sim.logistics.packages.values()){
        assert.ok(Number.isInteger(pkg.quantity)&&pkg.quantity>0,`invalid package ${pkg.id}`);
        if(pkg.reservedBy?.startsWith('cook:')||pkg.reservedBy?.startsWith('workman:'))
          assert.ok(live(Number(pkg.reservedBy.split(':')[1])),`package ${pkg.id} stranded with departed staff`);
      }
      const kitchen=sim.kitchen.saveData();
      for(const owner of kitchen.mealSetClaims??[])assert.ok(live(owner),`meal claimed by departed cook ${owner}`);
      for(const [owner]of [...kitchen.washClaims,...kitchen.spoonWashClaims??[]])assert.ok(live(owner),`washing claimed by departed cook ${owner}`);
      for(const count of [kitchen.frozenMeals,kitchen.cleanTrays,kitchen.dirtyTrays,kitchen.cleanSpoons,kitchen.dirtySpoons,kitchen.preparedSettings,kitchen.eatingSettings])
        assert.ok(Number.isInteger(count)&&count>=0,'kitchen quantities remain nonnegative integers');
      const stock=[...sim.agents.servingStock.values()].reduce((sum,amount)=>sum+amount,0);
      assert.equal(kitchen.preparedSettings,stock+(kitchen.mealSetClaims?.length??0)+(kitchen.anonymousMealSetClaims??0),'each prepared meal has a cook or serving table');
      const diners=sim.agents.agents.filter(agent=>agent.kind===Obj.Prisoner&&hasItem(agent.inv,Item.Tray)).length;
      const tableMeals=[...sim.agents.mealTableMeals.values()].reduce((sum,amount)=>sum+amount,0);
      assert.equal(kitchen.eatingSettings,diners+tableMeals,'every issued meal remains with a diner or on a table');
      if(kitchen.dirtyTrays>lastDirty)measuredMeals+=kitchen.dirtyTrays-lastDirty;
      if(kitchen.cleanTrays>lastClean&&hour>4)measuredWashes+=kitchen.cleanTrays-lastClean;
      lastDirty=kitchen.dirtyTrays;lastClean=kitchen.cleanTrays;
      assert.equal(sim.economy.saveData().prisonerCount,sim.agents.agents.filter(agent=>agent.kind===Obj.Prisoner&&live(agent.id)).length,'grants follow living population');
      assert.ok(Number.isFinite(sim.economy.cash),'economy remains finite');
      if(hour%24===23)console.log(JSON.stringify({seed,day:(hour+1)/24,population:sim.agents.prisonerCount(),cash:Math.round(sim.economy.cash),diagnostics:sim.agents.diagnostics(sim.world),kitchen:{clean:kitchen.cleanTrays,dirty:kitchen.dirtyTrays,prepared:kitchen.preparedSettings,eating:kitchen.eatingSettings},warnings:[...sim.kitchen.warnings,...sim.task2.health.warnings]}));
    }
    for(const [id,row]of history)if(row.samples>=24){
      assert.ok(row.foodMax-row.foodMin>.1,`inmate ${id} food remained frozen`);
      assert.ok(row.sleepMax-row.sleepMin>.1,`inmate ${id} rest remained frozen`);
    }
    assert.ok(measuredMeals>0&&measuredWashes>0&&measuredSleep>0,'meal consumption, washing, and bed use all occur');
    console.log(`Seed ${seed}: ${days} days passed in ${((performance.now()-start)/1000).toFixed(1)}s; ${states.size} states, ${measuredMeals} observed tray returns, ${measuredWashes} clean-stock recoveries, ${measuredSleep} hourly sleeping observations.`);
  } catch(error){
    const path=`${artifacts}/failure-${seed}.json`;
    writeFileSync(path,JSON.stringify(sim.snapshot()));
    console.error(`Reproducible failed playthrough saved to ${path}; world hour ${sim.time/HOUR_SECONDS}`);
    throw error;
  }
}
