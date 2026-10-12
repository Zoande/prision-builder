// Real WebGPU and canvas interaction regression. Requires a Chromium browser.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createPrison } from './scenarios/prison.ts';

const browserPath=process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const server=await createServer({root:process.cwd(),server:{host:'127.0.0.1',port:0,hmr:false}});
let browser;
const errors=[];
const artifactDir=process.env.PLAYTEST_ARTIFACTS || '/tmp/prison-builder-playtest';
mkdirSync(artifactDir,{recursive:true});
try {
  await server.listen();
  const address=server.httpServer.address();
  browser=await chromium.launch({executablePath:browserPath,headless:true,args:['--no-sandbox','--enable-unsafe-webgpu','--use-angle=swiftshader','--use-vulkan=swiftshader','--enable-features=Vulkan','--disable-features=VulkanFromANGLE','--disable-dev-shm-usage']});
  const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:.5});
  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  let mirror=null;
  await page.route('**/api/save', async route=>{
    const request=route.request();
    if(request.method()==='POST')mirror=request.postDataJSON();
    if(request.method()==='DELETE')mirror=null;
    await route.fulfill({contentType:'application/json',body:request.method()==='GET'?JSON.stringify(mirror):'{"ok":true}'});
  });
  await page.route('**/api/sim-log',route=>route.fulfill({contentType:'text/plain',body:''}));
  async function ready(){
    await page.waitForFunction(()=>window.__prisonPlaytest || document.querySelector('#err').textContent,null,{timeout:120000});
    await page.waitForFunction(()=>document.querySelector('#hud').textContent.includes('fps') || document.querySelector('#err').textContent,null,{timeout:120000});
    assert.equal(await page.locator('#err').textContent(),'','WebGPU must initialize');
  }
  await page.goto(`http://127.0.0.1:${address.port}/?playtest`,{waitUntil:'domcontentloaded',timeout:120000});
  await ready();
  console.log("Browser ready");
  assert.equal(await page.evaluate(()=>window.__prisonPlaytest.inspect().speed),0,'new prison starts paused');
  await page.locator('.mode-btn[data-mode=objects]').click();
  const search=page.locator('#catalogSearch');
  for(const name of ['Loading Pallet','Freezer','Sink','Uniform Rack','Search Table','Gatehouse','Records Desk']){
    await search.fill(name);
    const button=page.locator('#palette .build-item').filter({hasText:name}).first();
    await button.waitFor({state:'visible'});
    await button.click();
    assert.match(await page.locator('#detailName').textContent(),new RegExp(name));
  }
  console.log('Catalog prerequisites reachable');
  await page.keyboard.press('Escape');
  const yardPoint=await page.evaluate(()=>window.__prisonPlaytest.screenTile(364,372));
  await page.mouse.click(yardPoint.x,yardPoint.y);
  await page.locator('.facility-inspector.is-open').waitFor({state:'visible'});
  assert.match(await page.locator('.facility-inspector').textContent(),/Delivery Yard/);
  assert.match(await page.locator('.facility-inspector').textContent(),/Operational/);
  await page.locator('.facility-inspector button').filter({hasText:'Assign guard'}).click();
  assert.match(await page.locator('.facility-inspector').textContent(),/Guards assigned: 1/);
  await page.locator('.fi-close').click();
  await page.locator('.mode-btn[data-mode=staff]').click();
  await page.locator('#cats button[data-section="security:patrol"]').click();
  await page.locator('#palette .build-item').filter({hasText:'Blue Beat'}).click();
  assert.match(await page.locator('#detailName').textContent(),/Blue Beat/);
  await page.locator('#roofBtn').click();
  assert.equal(await page.locator('#roofBtn').getAttribute('aria-pressed'),'true');
  await page.locator('#roofBtn').click();
  await search.fill('a building that does not exist');
  assert.equal(await page.locator('#palette .build-item').count(),0);
  assert.match(await page.locator('#palette').textContent(),/No .*match/i);
  await page.locator('#guideBtn').click();
  await page.locator('[data-open-guide-catalog="staff|staff:people"]').first().click();
  assert.equal(await search.inputValue(),'','guide links clear stale search');
  await page.locator('#palette .build-item').filter({hasText:'Workman'}).click();
  assert.match(await page.locator('#detailCost').textContent(),/\$400/);
  const tile=await page.evaluate(()=>window.__prisonPlaytest.screenTile(366,373));
  await page.mouse.click(tile.x,tile.y);
  await page.waitForFunction(()=>window.__prisonPlaytest.inspect().agents.some(a=>a.kind===22),null,{timeout:30000});
  await page.locator('#cats button[data-section="staff:people"]').click();
  await page.locator('.staff-roster.is-open').waitFor({state:'visible'});
  assert.match(await page.locator('.staff-roster').textContent(),/Workman/);
  await page.locator('.staff-roster .sr-entry').first().click();
  assert.ok(await page.locator('#inspector.show').isVisible());
  await page.locator('#inspectClose').click();
  await page.locator('.staff-roster.is-open').waitFor({state:'visible'});
  await page.locator('.mode-btn[data-mode=build]').click();
  await search.fill('');
  await page.locator('#palette .build-item').filter({hasText:'Concrete'}).first().click();
  assert.match(await page.locator('#detailCost').textContent(),/\$20/);
  const floorTile=await page.evaluate(()=>window.__prisonPlaytest.screenTile(360,373));
  await page.mouse.click(floorTile.x,floorTile.y);
  await page.waitForFunction(()=>window.__prisonPlaytest.inspect().orders.length===1,null,{timeout:30000});
  console.log('Canvas order submitted');
  await page.evaluate(()=>window.__prisonPlaytest.advance(100));
  const after=await page.evaluate(()=>window.__prisonPlaytest.inspect());
  assert.equal(after.orders[0].state,'complete','live workman hauls and completes canvas order');
  assert.equal(after.floor[373*500+360],1);
  assert.ok(after.cash<20000,'construction/hiring costs are charged');
  // Check the rasterized scene itself, not just DOM overlays or an open GPU adapter.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(4000);
  const terrain=await page.screenshot({timeout:30000,clip:{x:400,y:250,width:550,height:400}});
  assert.ok(terrain.length>12000,`terrain must render, got ${terrain.length} PNG bytes`);
  await page.screenshot({timeout:30000,path:`${artifactDir}/construction.png`});
  await page.locator('.mode-btn[data-mode=admin]').click();
  await page.locator('#palette .build-item').filter({hasText:'Erase'}).click();
  assert.ok(await page.locator('#build').isVisible(),'demolition tool is reachable');
  // UI text input must not rotate, pan, or invoke demolition shortcuts.
  await search.fill('Records Desk');
  const beforeCamera=await page.evaluate(()=>window.__prisonPlaytest.screenTile(360,373));
  await search.press('ArrowLeft');await search.press('r');await search.press('Backspace');
  const afterCamera=await page.evaluate(()=>window.__prisonPlaytest.screenTile(360,373));
  assert.deepEqual(afterCamera,beforeCamera);
  await page.locator('.mode-btn[data-mode=policy]').click();
  const number=page.locator('#policyDashboard input[type=number]').first();
  await number.fill('7');await page.waitForTimeout(1000);
  assert.equal(await number.inputValue(),'7','refresh must preserve a focused edit');
  await number.press('Tab');
  await page.keyboard.press('Escape');
  const savedCameraPoint=await page.evaluate(()=>window.__prisonPlaytest.screenTile(360,373));
  await page.locator('#saveNowBtn').click();
  await page.waitForFunction(()=>document.querySelector('#saveStatus').textContent.startsWith('Saved'),null,{timeout:30000});
  assert.ok(mirror && mirror.version===6);
  await page.reload({waitUntil:'domcontentloaded',timeout:120000});await ready();
  assert.equal((await page.evaluate(()=>window.__prisonPlaytest.inspect())).floor[373*500+360],1,'saved floor survives reload');
  const restoredCameraPoint=await page.evaluate(()=>window.__prisonPlaytest.screenTile(360,373));
  assert.ok(Math.abs(savedCameraPoint.x-restoredCameraPoint.x)<.01&&Math.abs(savedCameraPoint.y-restoredCameraPoint.y)<.01,'reload restores the camera to the saved prison view');
  await page.locator('#speeds .spd').first().click();
  for(const [width,height] of [[1024,768],[640,800],[360,800],[320,780]]){
    await page.setViewportSize({width,height});
    if(width<=720){
      const layout=await page.evaluate(()=>{
        const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width};};
        return {status:rect('status'),clock:rect('clockbox'),nav:rect('sideRail')};
      });
      assert.ok(layout.status.width>100&&layout.status.right<=layout.clock.x,'population and financials fit beside clock');
      assert.ok(layout.status.bottom<=layout.nav.y&&layout.clock.bottom<=layout.nav.y,'clock and status do not overlap navigation');
      await page.locator('#emergencyToggleBtn').click();
      for(const command of ['alarm','lockdown','shakedown','armed-response','none']){
        const bounds=await page.locator(`[data-emergency="${command}"]`).boundingBox();
        assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width,'every emergency command remains reachable');
      }
      await page.locator('[data-emergency="alarm"]').click();
      await page.waitForFunction(()=>document.querySelector('#emergencyCurrentStatus').textContent==='Alarm',null,{timeout:30000});
      await page.locator('#emergencyToggleBtn').click();
      await page.locator('[data-emergency="none"]').click();
    }
    await page.locator('.mode-btn[data-mode=objects]').click();
    await search.fill('Freezer');
    await page.locator('#palette .build-item').filter({hasText:'Freezer'}).click();
    assert.ok(await page.locator('#detailCopy').isVisible(),`placement help visible at ${width}px`);
    assert.ok(await page.locator('#detailCost').isVisible(),`cost visible at ${width}px`);
    const detail=await page.locator('#itemDetail').boundingBox();
    assert.ok(detail.x>=0&&detail.x+detail.width<=width+1&&detail.y>=0&&detail.y+detail.height<=height,`detail stays in viewport at ${width}px`);
    await page.screenshot({timeout:30000,path:`${artifactDir}/ui-${width}.png`});
    await page.keyboard.press('Escape');
  }
  // Exercise populated information panels by importing a real mature prison
  // through the same file input a player uses.
  await page.locator('#importSaveFile').setInputFiles({name:'broken-save.json',mimeType:'application/json',buffer:Buffer.from('{"version":6,"world":{},"agents":{}}')});
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('complete version-6 save'),null,{timeout:30000});
  assert.equal((await page.evaluate(()=>window.__prisonPlaytest.inspect())).floor[373*500+360],1,'a rejected import preserves the current prison');
  const populated=createPrison(9876,16);
  populated.advance(10);
  await Promise.all([
    page.waitForNavigation({waitUntil:'domcontentloaded',timeout:120000}),
    page.locator('#importSaveFile').setInputFiles({name:'playtest-prison.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(populated.snapshot()))}),
  ]);
  await ready();
  await page.locator('#speeds .spd').first().click();
  for(const [width,height]of [[1440,900],[360,800]]){
    await page.setViewportSize({width,height});
    await page.locator('.mode-btn[data-mode=intelligence]').click();
    assert.equal(await page.locator('#intelRoster .intel-person').count(),16);
    await page.locator('#intelRoster .intel-person').first().click();
    assert.match(await page.locator('#intelProfile').textContent(),/Official record/);
    assert.match(await page.locator('#intelProfile').textContent(),/Welfare/);
    assert.match(await page.locator('#intelProfile').textContent(),/Family/);
    assert.match(await page.locator('#intelProfile').textContent(),/Privacy/);
    assert.match(await page.locator('#intelProfile').textContent(),/Safety/);
    const profileBounds=await page.locator('#intelProfile').boundingBox();
    assert.ok(profileBounds.width>200&&profileBounds.height>100,'populated inmate profile has readable space');
    await page.screenshot({timeout:30000,path:`${artifactDir}/intelligence-${width}.png`});
    await page.locator('.mode-btn[data-mode=staff]').click();
    await page.locator('.staff-roster.is-open').waitFor({state:'visible'});
    assert.equal(await page.locator('.staff-roster .sr-entry').count(),13);
    await page.locator('.staff-roster .sr-entry').first().click();
    assert.ok(await page.locator('#inspectClose').isVisible());
    await page.screenshot({timeout:30000,path:`${artifactDir}/staff-${width}.png`});
    await page.locator('#inspectClose').click();
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors,[],'no page runtime errors');
  console.log('WebGPU terrain, canvas hiring/building, catalog, guide, controls, persistence, and responsive UI: passed');
  console.log(`Screenshots: ${artifactDir}`);
} finally {
  if(browser)await browser.close();
  await server.close();
  writeFileSync(`${artifactDir}/page-errors.json`,JSON.stringify(errors,null,2));
}
