// Regression for importing a v6 save with a boxed Staff Fence Gate package
// into a fresh browser realm, then advancing time and moving the camera.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer, preview } from 'vite';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPrison } from './scenarios/prison.ts';
import { Obj } from '../src/sim/world.ts';
import { COMPRESSED_TEXTURE_NAMES } from '../src/render/textureQuality.ts';

const sourceRoot = resolve(process.env.PLAYTEST_ROOT || process.cwd());
const production = process.env.PLAYTEST_PRODUCTION === '1';
const root = sourceRoot;
const browserPath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const server = production
  ? await preview({ root, preview: { host: '127.0.0.1', port: 0 } })
  : await createServer({ root, configFile: resolve(root, 'vite.config.mjs'), server: { host: '127.0.0.1', port: 0, hmr: false } });
const errors = [];
const assetResponses = [];
const fallbackWarnings = [];
let browser;
let persisted = null;

try {
  const prison = createPrison(62062, 6);
  // A real fence gate plus an outstanding build order and one available boxed
  // package exercises fresh-realm registry reconstruction on import.
  const group = prison.construction.plan({ cat: 'fencestaffdoor', mat: 0 }, [{ x: 306, z: 329 }], 0, prison.time, prison.world);
  assert.ok(group, 'fixture must contain a Staff Fence Gate construction order');
  prison.logistics.addSalvage(`box:${Obj.StaffFenceDoor}`, 1, 364, 372);
  const save = prison.snapshot();
  // Published v6 saves predate the optional RNG checkpoint.
  delete save.agents.rngState;
  assert.ok(save.logistics.packages.some(pkg => pkg.commodity === 'box:62'));
  assert.ok(save.construction.groups.some(row => row.targets.some(target => target.recipe['box:62'] === 1)));

  if (!production) await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--use-vulkan=swiftshader', '--enable-features=Vulkan', '--disable-features=VulkanFromANGLE', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: .5 });
  let page = await context.newPage();
  const trackPage = current => {
    current.on('pageerror', error => errors.push(error.message));
    current.on('console', message => {
      if (message.type() === 'warning' && message.text().includes('[assets] listed compressed texture failed')) fallbackWarnings.push(message.text());
    });
    current.on('response', response => {
      if (response.url().includes('/textures/')) assetResponses.push({
        url: new URL(response.url()).pathname, status: response.status(), type: response.headers()['content-type'] || '',
      });
    });
  };
  trackPage(page);
  await context.route('**/api/save', async route => {
    const req = route.request();
    if (req.method() === 'POST') {
      persisted = req.postDataJSON();
      console.log('Save endpoint received the imported v6 payload');
    }
    await route.fulfill({ contentType: 'application/json', body: req.method() === 'GET' ? 'null' : '{"ok":true}' });
  });
  // Dev diagnostics are optional. Keep the test server response explicit so a
  // missing standalone sim-log endpoint cannot obscure a simulation failure.
  await context.route('**/api/sim-log', route => route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }));

  const origin = `http://127.0.0.1:${address.port}`;
  await page.goto(`${origin}/${production ? '' : '?playtest'}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  console.log('Fresh client initialized');
  await page.waitForFunction(() => window.__prisonPlaytest || document.querySelector('#hud')?.textContent.includes('fps') || document.querySelector('#err').textContent, null, { timeout: 120000 });
  assert.equal(await page.locator('#err').textContent(), '', 'fresh browser initializes WebGPU');
  const importNavigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).then(() => 'navigation', error => error);
  await page.locator('#importSaveFile').setInputFiles({
    name: 'boxed-staff-gate-v6.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(save)),
  });
  const importOutcome = await Promise.race([
    importNavigation,
    page.waitForFunction(() => document.querySelector('#notice')?.classList.contains('show'), null, { timeout: 30000 }).then(() => 'notice', () => 'notice-timeout'),
  ]);
  if (importOutcome !== 'navigation') throw new Error(`Import did not reload: ${importOutcome}; notice=${await page.locator('#notice').textContent()}; persisted=${!!persisted}`);
  console.log('Save file imported and page reloaded');
  assert.equal(persisted?.version, 6, 'import persists a version-6 save');
  assert.ok(persisted?.logistics.packages.some(pkg => pkg.commodity === 'box:62'), 'import persists boxed gate stock');
  await page.waitForFunction(() => window.__prisonPlaytest || document.querySelector('#hud')?.textContent.includes('fps') || document.querySelector('#err').textContent, null, { timeout: 120000 });
  assert.equal(await page.locator('#err').textContent(), '', 'imported save initializes without a runtime error');

  async function checkRunningAndCamera(label) {
    let beforeTime;
    if (!production) {
      const before = await page.evaluate(() => window.__prisonPlaytest.inspect());
      assert.equal(before.agents.length, 19, `${label}: imported workers and population remain loaded`);
      beforeTime = before.time;
    }
    const clockBefore = await page.locator('#clock .clock-time').textContent();
    await page.locator('#speeds .spd').last().click();
    await page.waitForFunction(old => document.querySelector('#clock .clock-time').textContent !== old, clockBefore, { timeout: 20000 });
    if (!production) {
      const after = await page.evaluate(() => window.__prisonPlaytest.inspect());
      assert.ok(after.time > beforeTime, `${label}: simulation clock advances (${beforeTime} -> ${after.time})`);
    }
    await page.locator('#speeds .spd').first().click();
    await page.waitForTimeout(300);

    const beforePan = production
      ? await page.locator('#gfx').screenshot()
      : await page.evaluate(() => window.__prisonPlaytest.screenTile(350, 375));
    await page.keyboard.down('w');
    await page.waitForTimeout(450);
    await page.keyboard.up('w');
    const afterPan = production
      ? await page.locator('#gfx').screenshot()
      : await page.evaluate(() => window.__prisonPlaytest.screenTile(350, 375));
    assert.ok(production ? !beforePan.equals(afterPan) : Math.abs(afterPan.x - beforePan.x) + Math.abs(afterPan.y - beforePan.y) > 1,
      `${label}: WASD moves the camera`);
  }

  // Imported save starts the fresh module registry. Quality controls are only
  // offered when both complete generated KTX sets are available locally.
  const initialQualityTitle = await page.locator('#qualBtn').getAttribute('title');
  const qualityCanToggle = !(await page.locator('#qualBtn').isDisabled());
  const compressedRoot = resolve(root, 'public/textures/compressed');
  const compressedFiles = new Set(existsSync(compressedRoot) ? readdirSync(compressedRoot) : []);
  const completePair = COMPRESSED_TEXTURE_NAMES.every(name => ['1k', '4k'].every(quality => compressedFiles.has(`${name}.${quality}.ktx`)));
  if (!completePair) assert.equal(qualityCanToggle, false, 'this build cannot offer a quality toggle without both complete texture sets');
  if (compressedFiles.size === 0) assert.equal(await page.locator('#qualBtn').textContent(), '1K', 'raw-only build displays its actual texture resolution');
  if (qualityCanToggle) {
    assert.match(initialQualityTitle, /High \(4K/);
    await checkRunningAndCamera('default 4K');

    await page.locator('#qualBtn').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('texQuality')), '1k', 'quality button selects the 1K compressed set');
    await page.close();
    page = await context.newPage();
    trackPage(page);
    await page.goto(production ? origin : `${origin}/?playtest`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => document.querySelector('#hud')?.textContent.includes('fps') || document.querySelector('#err').textContent, null, { timeout: 120000 });
    assert.equal(await page.locator('#err').textContent(), '', 'low-quality reload retains valid save');
    assert.match(await page.locator('#qualBtn').getAttribute('title'), /Low \(1K/);
    await checkRunningAndCamera('1K after toggle');

    await page.locator('#qualBtn').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('texQuality')), '4k', 'quality button restores the 4K compressed set');
    await page.close();
    page = await context.newPage();
    trackPage(page);
    await page.goto(production ? origin : `${origin}/?playtest`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => document.querySelector('#hud')?.textContent.includes('fps') || document.querySelector('#err').textContent, null, { timeout: 120000 });
    assert.equal(await page.locator('#err').textContent(), '', 'high-quality reload retains valid save');
    assert.match(await page.locator('#qualBtn').getAttribute('title'), /High \(4K/);
    await checkRunningAndCamera('4K restored after toggle');
  } else {
    assert.match(initialQualityTitle, /Texture quality: 1K \(|Mixed resolution:|Low \(1K\)|High \(4K\)/,
      'disabled quality control describes the quality this build can provide');
    await checkRunningAndCamera(initialQualityTitle);
    if (initialQualityTitle.includes('higher resolutions unavailable in this build')) {
      await page.evaluate(() => localStorage.setItem('texQuality', '4k'));
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForFunction(isProduction => (isProduction || window.__prisonPlaytest) && document.querySelector('#hud')?.textContent.includes('fps'), production, { timeout: 120000 });
      assert.equal(await page.evaluate(() => localStorage.getItem('texQuality')), '4k', 'the saved high-quality preference is retained when raw 1K is the only available path');
      assert.match(await page.locator('#qualBtn').getAttribute('title'), /Texture quality: 1K \(higher resolutions unavailable in this build\)/);
      assert.equal(await page.locator('#qualBtn').isDisabled(), true, 'an unavailable high-resolution toggle remains disabled after reload');
      await checkRunningAndCamera('raw 1K after stored high preference reload');
    }
  }

  assert.deepEqual(errors, [], 'no uncaught browser runtime errors');
  console.log('Fresh v6 import with box:62 cargo, simulation clock, WASD camera, supported quality mode, and compressed-manifest checks: passed');
  const compressed = assetResponses.filter(row => row.url.includes('/textures/compressed/'));
  const rawNormal = assetResponses.find(row => row.url === '/textures/galv_nrm.png');
  const missingCompressed = compressed.filter(row => row.status >= 400 || row.type.includes('text/html'));
  assert.deepEqual(missingCompressed, [], 'the build-time manifest never requests absent compressed files');
  console.log(`Texture responses: ${compressed.length} compressed URLs (${missingCompressed.length} absent or SPA-fallback), galv_nrm.png ${rawNormal?.status ?? 'not requested'}`);
  console.log(`Compressed fallback warnings: ${fallbackWarnings.length}`);
} finally {
  if (browser) await browser.close();
  await server.close();
}
