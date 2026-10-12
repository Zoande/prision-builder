import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { existsSync,mkdirSync } from 'node:fs';
const server=await preview({preview:{host:'127.0.0.1',port:0}});
let browser;
try{
 const address=server.httpServer.address();
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox','--enable-unsafe-webgpu','--use-angle=swiftshader','--use-vulkan=swiftshader','--enable-features=Vulkan','--disable-features=VulkanFromANGLE','--disable-dev-shm-usage']});
 const page=await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:.5});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/save',route=>route.fulfill({contentType:'application/json',body:'null'}));
 await page.route('**/api/sim-log',route=>route.fulfill({contentType:'text/plain',body:''}));
 await page.goto(`http://127.0.0.1:${address.port}`,{waitUntil:'domcontentloaded',timeout:120000});
 await page.waitForFunction(()=>document.querySelector('#hud').textContent.includes('fps')||document.querySelector('#err').textContent,null,{timeout:120000});
 assert.equal(await page.locator('#err').textContent(),'','production WebGPU initialization');
 await page.locator('.mode-btn[data-mode=objects]').click();
 await page.locator('#catalogSearch').fill('Freezer');
 await page.locator('#palette .build-item').filter({hasText:'Freezer'}).click();
 assert.match(await page.locator('#detailName').textContent(),/Freezer/);
 await page.keyboard.press('Escape');
 const raster=await page.screenshot({timeout:30000,clip:{x:400,y:240,width:550,height:400}});
 assert.ok(raster.length>12000,'production scene renders terrain');
 mkdirSync('/tmp/prison-builder-playtest',{recursive:true});
 await page.screenshot({timeout:30000,path:'/tmp/prison-builder-playtest/production.png'});
 assert.deepEqual(errors,[],'production chunks/shaders have no runtime errors');
 assert.equal(await page.evaluate(()=>typeof window.__prisonPlaytest),'undefined','production omits the development test bridge');
 console.log('Production bundles, WebGPU terrain and usable catalog: passed');
}finally{
 if(browser)await browser.close();
 await new Promise((resolve,reject)=>server.httpServer.close(error=>error?reject(error):resolve()));
}
