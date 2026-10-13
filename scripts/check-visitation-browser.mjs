// Import a real v6 save into a fresh browser, watch an ordinary family visit,
// and verify visitor rendering, persistence, and simulation recovery.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createVisitationSave } from './visitationFixture.ts';

const root = process.cwd();
const browserPath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const fixture = createVisitationSave();
const server = await createServer({ root, configFile: resolve(root, 'vite.config.mjs'), server: { host: '127.0.0.1', port: 0, hmr: false } });
const pageErrors = [], failedRequests = [], compressedFallbackRequests = [];
let browser;
let durableSave = fixture;

try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--use-vulkan=swiftshader',
      '--enable-features=Vulkan', '--disable-features=VulkanFromANGLE', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: .5 });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => {
    const message = `${request.method()} ${request.url()}: ${request.failure()?.errorText}`;
    if (request.url().includes('/textures/compressed/')) compressedFallbackRequests.push(message);
    else failedRequests.push(message);
  });
  await page.route('**/api/save', async route => {
    if (route.request().method() === 'POST') {
      durableSave = route.request().postDataJSON();
      return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    }
    if (route.request().method() === 'DELETE') return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(durableSave) });
  });
  await page.route('**/api/sim-log', route => route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }));
  await page.goto(`http://127.0.0.1:${address.port}/?playtest`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__prisonPlaytest && document.querySelector('#hud')?.textContent.includes('fps'), null, { timeout: 120000 });
  assert.equal(await page.locator('#err').textContent(), '', 'the imported save initializes WebGPU in a clean browser');
  const initialStatus = await page.evaluate(() => window.__prisonPlaytest.visitation());
  assert.equal(initialStatus.state, 'toScreening', 'browser imports an in-progress physical family visit from the v6 save');
  assert.equal(initialStatus.visitors.length, 1, 'the imported save reconstructs a physical visitor');
  const startClock = await page.locator('#clockbox .clock-time').textContent();

  const visitorStart = initialStatus.visitors[0];
  // Frame the real guest and resident together, with the roof made transparent
  // so the saved-world screenshot shows the visit in the room.
  await page.evaluate(() => window.__prisonPlaytest.camera(359, 99, 30));
  await page.locator('#roofBtn').click();
  await page.waitForTimeout(120);
  await page.screenshot({ path: resolve('/tmp/prison-visitor-live.png') });
  await page.locator('#saveNowBtn').click();
  await page.waitForFunction(() => document.querySelector('#saveStatus')?.textContent.startsWith('Saved '), null, { timeout: 20000 });
  assert.ok(durableSave.task3.visitation?.session, 'active visitor session is saved');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__prisonPlaytest && document.querySelector('#hud')?.textContent.includes('fps'), null, { timeout: 120000 });
  const restored = await page.evaluate(() => window.__prisonPlaytest.visitation());
  assert.equal(restored.visitors.length, 1, 'active visitor is reconstructed after a full page reload');
  assert.equal(restored.visitors[0].id, visitorStart.id, 'reload retains the same visitor');
  assert(['toScreening', 'waitingScreen'].includes(restored.state), 'reload resumes the same ingress sequence');
  const beforeMove = restored.visitors[0];
  const beforePath = await page.evaluate(() => {
    const save = window.__prisonPlaytest.snapshot();
    const visit = save.task3.visitation;
    return { visitor: visit.visitors[0], session: visit.session, time: save.worldTime };
  });
  await page.evaluate(() => window.__prisonPlaytest.advance(8));
  await page.waitForTimeout(80);
  const afterMove = await page.evaluate(() => window.__prisonPlaytest.visitation());
  assert(Math.hypot(afterMove.visitors[0].x - beforeMove.x, afterMove.visitors[0].z - beforeMove.z) > .5,
    `visitor moves along the persisted route after reload; before=${JSON.stringify(beforePath)} after=${JSON.stringify({status:afterMove, time:(await page.evaluate(() => window.__prisonPlaytest.snapshot().worldTime))})}`);
  assert.notEqual(await page.locator('#clockbox .clock-time').textContent(), startClock, 'visible prison clock advances throughout the visit');
  assert.deepEqual(pageErrors, [], `browser has no uncaught errors: ${pageErrors.join('; ')}`);
  assert.deepEqual(failedRequests, [], `browser requests all succeed: ${failedRequests.join('; ')}`);
  console.log(`Fresh-browser v6 import, WebGPU rendering, visible visitor, active-session save/reload, visitor movement, and clock progress: passed; raw-texture fallback requests=${compressedFallbackRequests.length}`);
  console.log('Screenshot: /tmp/prison-visitor-live.png');
} finally {
  if (browser) await browser.close();
  await server.close();
}
