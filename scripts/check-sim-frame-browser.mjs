// Prove an unexpected simulation error pauses once while frame, camera, and
// recovery controls remain live, and that pending unsaved work is not autosaved.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.env.PLAYTEST_ROOT || process.cwd());
const browserPath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const server = await createServer({ root, configFile: resolve(root, 'vite.config.mjs'), server: { host: '127.0.0.1', port: 0, hmr: false } });
const pageErrors = [];
const consoleErrors = [];
let browser;
let durableSave = null;
let savePosts = 0;

try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--use-vulkan=swiftshader', '--enable-features=Vulkan', '--disable-features=VulkanFromANGLE', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: .5, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.route('**/api/save', async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      savePosts++;
      durableSave = request.postDataJSON();
      return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(durableSave) });
  });
  await page.route('**/api/sim-log', route => route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }));

  await page.goto(`http://127.0.0.1:${address.port}/?playtest`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__prisonPlaytest && document.querySelector('#hud')?.textContent.includes('fps'), null, { timeout: 120000 });
  assert.equal(await page.locator('#err').textContent(), '', 'fresh game initializes WebGPU');

  const postsBeforeBaseline = savePosts;
  await page.locator('#saveNowBtn').click();
  await page.waitForFunction(() => document.querySelector('#saveStatus').textContent.startsWith('Saved '), null, { timeout: 20000 });
  assert.ok(savePosts > postsBeforeBaseline, 'a known-good baseline save was written before fault injection');
  const baseline = structuredClone(durableSave);

  await page.evaluate(() => window.__prisonPlaytest.injectSimulationFailure());
  await page.waitForFunction(() => document.querySelector('#simulationFault').classList.contains('show'), null, { timeout: 20000 });
  assert.match(await page.locator('#simulationFaultMessage').textContent(), /Simulation paused after an error: DEV injected simulation failure/);
  assert.equal(await page.locator('#speeds .spd').first().getAttribute('aria-pressed'), 'true', 'pause control is selected');
  assert.equal(await page.locator('#speeds .spd').nth(1).isDisabled(), true, 'nonzero simulation speeds are disabled');
  assert.equal(await page.locator('#saveNowBtn').isDisabled(), true, 'manual autosave cannot overwrite the last successful save');
  await page.locator('#simulationFault summary').click();
  assert.match(await page.locator('#simulationFaultDetails').textContent(), /DEV injected simulation failure/);

  const pausedState = await page.evaluate(() => window.__prisonPlaytest.inspect());
  const pausedClock = await page.locator('#clock .clock-time').textContent();
  await page.waitForTimeout(500);
  const laterState = await page.evaluate(() => window.__prisonPlaytest.inspect());
  assert.equal(laterState.time, pausedState.time, 'world time remains frozen after the failed frame');
  assert.equal(await page.locator('#clock .clock-time').textContent(), pausedClock, 'visible clock remains frozen');

  const beforePan = await page.evaluate(() => window.__prisonPlaytest.screenTile(350, 375));
  await page.keyboard.down('w');
  await page.waitForTimeout(450);
  await page.keyboard.up('w');
  const afterPan = await page.evaluate(() => window.__prisonPlaytest.screenTile(350, 375));
  assert.ok(Math.abs(afterPan.x - beforePan.x) + Math.abs(afterPan.y - beforePan.y) > 1, 'WASD camera pan still works after the simulation fault');

  const downloadWait = page.waitForEvent('download');
  await page.locator('#exportSimulationDiagnosticBtn').click();
  const download = await downloadWait;
  assert.equal(download.suggestedFilename(), 'prison-builder-simulation-diagnostic.json');
  const diagnostic = JSON.parse(await readFile(await download.path(), 'utf8'));
  assert.equal(diagnostic.error.message, 'DEV injected simulation failure');
  assert.equal(diagnostic.save.version, 6, 'diagnostic includes the current save snapshot');

  await page.waitForTimeout(5200);
  assert.equal(savePosts, 1, 'faulted unsaved work never replaces the last good save');
  assert.deepEqual(durableSave, baseline, 'last successful save remains unchanged');
  assert.equal(await page.locator('#reloadSavedGameBtn').isEnabled(), true, 'saved-game recovery remains available');
  const reload = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.locator('#reloadSavedGameBtn').click();
  await reload;
  await page.waitForFunction(() => window.__prisonPlaytest && document.querySelector('#hud')?.textContent.includes('fps'), null, { timeout: 120000 });
  const restored = await page.evaluate(() => window.__prisonPlaytest.inspect());
  assert.ok(Math.abs(restored.time - baseline.worldTime) < .2, 'reload restores the last successful save');
  assert.equal(await page.locator('#simulationFault').isVisible(), false, 'reloaded good save clears the fault panel');
  assert.deepEqual(pageErrors, [], `browser has no uncaught errors: ${pageErrors.join('; ')}`);
  assert.equal(consoleErrors.length, 1, 'the captured frame fault is reported once without repeated console spam');
  assert.match(consoleErrors[0], /Simulation\/frame failure/);
  console.log('Simulation fault pause, visible details, frozen clock, WASD pan, diagnostic export, autosave protection, and saved-game reload: passed');
} finally {
  if (browser) await browser.close();
  await server.close();
}
