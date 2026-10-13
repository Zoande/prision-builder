// Fresh prison campaign through player controls only: hire a builder, order a
// cell shell and fit-out, paint it as a cell, and verify the room is ready.
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { Obj, RoomType } from '../src/sim/world.ts';

const root = process.cwd();
const browserPath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const server = await createServer({ root, configFile: resolve(root, 'vite.config.mjs'), server: { host: '127.0.0.1', port: 0, hmr: false } });
const pageErrors = [], failedRequests = [];
let browser, durableSave = null;

try {
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ executablePath: browserPath, headless: true,
    args: ['--no-sandbox', '--enable-unsafe-webgpu', '--use-angle=swiftshader', '--use-vulkan=swiftshader',
      '--enable-features=Vulkan', '--disable-features=VulkanFromANGLE', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: .5 });
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));
  await page.route('**/api/save', async route => {
    const method = route.request().method();
    if (method === 'POST') { durableSave = route.request().postDataJSON(); return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }); }
    if (method === 'DELETE') { durableSave = null; return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }); }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(durableSave) });
  });
  await page.route('**/api/sim-log', route => route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }));
  await page.goto(`http://127.0.0.1:${address.port}/?playtest`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__prisonPlaytest && document.querySelector('#hud')?.textContent.includes('fps'), null, { timeout: 120000 });
  assert.equal(await page.locator('#err').textContent(), '', 'fresh prison initializes WebGPU');
  const fresh = await page.evaluate(() => window.__prisonPlaytest.inspect());
  assert.equal(fresh.speed, 0, 'fresh prison starts paused');
  assert.equal(fresh.cash, 20000, 'campaign starts with normal new-game cash');
  assert.equal(fresh.agents.length, 0, 'campaign begins without a builder');

  const search = page.locator('#catalogSearch');
  async function choose(mode, section, name) {
    const modeButton = page.locator(`.mode-btn[data-mode="${mode}"]`);
    if (await modeButton.getAttribute('aria-pressed') !== 'true') await modeButton.click();
    // Opening a catalog makes its search field visible. Clear the query before
    // choosing a category because search filters the category list too.
    await search.fill('');
    await page.locator(`#cats button[data-section="${section}"]`).click();
    await search.fill(name);
    const itemTitle = page.locator('.item-title').getByText(name, { exact: true });
    const item = page.locator('#palette .build-item').filter({ has: itemTitle }).first();
    await item.waitFor({ state: 'visible', timeout: 15000 });
    await item.click();
    const detail = await page.locator('#detailName').textContent();
    assert.match(detail, new RegExp(name, 'i'), `catalog selects ${name}; detail=${JSON.stringify(detail)}, results=${JSON.stringify(await page.locator('#palette .build-item').allTextContents())}`);
  }
  async function clickTile(x, z) {
    const point = await page.evaluate(([tx, tz]) => window.__prisonPlaytest.screenTile(tx, tz), [x, z]);
    await page.mouse.click(point.x, point.y);
  }
  async function closeCatalog(mode) {
    await page.locator(`.mode-btn[data-mode="${mode}"]`).click();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#build')).visibility === 'hidden');
  }
  async function openBuiltCellInspector() {
    const tiles = [];
    for (let z = 361; z <= 363; z++) for (let x = 351; x <= 353; x++) tiles.push({ x, z });
    const agents = await page.evaluate(() => window.__prisonPlaytest.inspect().agents);
    // Staff selection wins over the room inspector when a worker is close to
    // the click. Try the interior tile furthest from every agent first.
    tiles.sort((a, b) => {
      const distance = tile => agents.length ? Math.min(...agents.map(agent => Math.hypot(agent.x - tile.x - .5, agent.z - tile.z - .5))) : Infinity;
      return distance(b) - distance(a);
    });
    const inspector = page.locator('.facility-inspector.is-open');
    for (const tile of tiles) {
      await clickTile(tile.x, tile.z);
      await page.waitForTimeout(100);
      if (await inspector.isVisible()) return inspector;
    }
    throw new Error(`Built Cell inspector did not open; agent positions=${JSON.stringify(agents)}`);
  }
  async function dragTiles(x0, z0, x1, z1) {
    const [from, to] = await page.evaluate(([[ax, az], [bx, bz]]) => [
      window.__prisonPlaytest.screenTile(ax, az), window.__prisonPlaytest.screenTile(bx, bz),
    ], [[x0, z0], [x1, z1]]);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
  }
  async function advanceUntil(predicate, label, seconds = 300, step = 10) {
    for (let elapsed = 0; elapsed < seconds; elapsed += step) {
      if (await page.evaluate(predicate)) return elapsed;
      for (let chunk = 0; chunk < step; chunk++) {
        await page.evaluate(() => window.__prisonPlaytest.advance(1));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
      }
    }
    assert(await page.evaluate(predicate), `${label} within ${seconds} simulated seconds`);
    return seconds;
  }
  async function orderCount() { return page.evaluate(() => window.__prisonPlaytest.inspect().orders.length); }

  // A real catalog hire on an empty tile in the starter delivery yard.
  await choose('staff', 'staff:people', 'Workman');
  await clickTile(366, 373);
  await page.waitForFunction(() => window.__prisonPlaytest.inspect().agents.some(agent => agent.kind === 22), null, { timeout: 20000 });
  assert.equal((await page.evaluate(() => window.__prisonPlaytest.inspect())).cash, 19600, 'builder hire fee is charged');

  // Build a second one-bed cell adjacent to the starter yard by painting the
  // inner concrete floor, four wall runs and a jail door through the UI.
  // The external boundary is x=350..354, z=360..364; the room is 351..353,
  // 361..363. Every order uses a real construction group and incoming stock.
  const shell = [
    ['build', 'build:floors', 'Concrete', 351, 361, 353, 363],
    ['build', 'build:walls', 'Rammed Earth', 350, 360, 354, 360],
    ['build', 'build:walls', 'Rammed Earth', 350, 364, 354, 364],
    ['build', 'build:walls', 'Rammed Earth', 350, 361, 350, 363],
    ['build', 'build:walls', 'Rammed Earth', 354, 361, 354, 363],
  ];
  for (const [mode, section, item, x0, z0, x1, z1] of shell) {
    await choose(mode, section, item);
    const before = await orderCount();
    await dragTiles(x0, z0, x1, z1);
    await page.waitForFunction(count => window.__prisonPlaytest.inspect().orders.length > count, before, { timeout: 15000 });
  }
  await advanceUntil(() => window.__prisonPlaytest.inspect().orders.every(order => order.state === 'complete'),
    'all floor and wall orders complete', 900, 20);

  await choose('objects', 'objects:doors', 'Jail Door');
  let before = await orderCount();
  await clickTile(352, 364);
  await page.waitForFunction(count => window.__prisonPlaytest.inspect().orders.length > count, before, { timeout: 15000 });
  await advanceUntil(() => window.__prisonPlaytest.inspect().orders.every(order => order.state === 'complete'),
    'jail door order completes', 300, 10);

  // Painting a room is a direct editor action, then the room inspector guides
  // the missing bed/toilet requirements to actual furniture catalog orders.
  await choose('rooms', 'rooms:prisoner', 'Cell');
  await dragTiles(351, 361, 353, 363);
  await page.waitForFunction(() => window.__prisonPlaytest.inspect().rooms.some(room => room.type === 4), null, { timeout: 15000 });
  const labels = await page.evaluate(() => window.__prisonPlaytest.snapshot().world.rooms);
  assert(labels.some(room => room.type === RoomType.Cell), 'painted cell is represented in the saved world');

  // Open the facility requirement panel from the actual painted room.
  await closeCatalog('rooms');
  const inspector = await openBuiltCellInspector();
  assert.match(await inspector.textContent(), /Needs a bed/);
  assert.match(await inspector.textContent(), /Needs a toilet/);
  await page.screenshot({ path: '/tmp/prison-player-cell-requirements.png' });

  await inspector.locator('.fi-requirements button').filter({ hasText: 'Find item' }).first().click();
  await page.locator('#cats button[data-section="objects:cells"]').waitFor({ state: 'visible' });
  await search.fill('Bed');
  await page.locator('#palette .build-item').filter({ hasText: 'Bed' }).first().click();
  assert.match(await page.locator('#detailName').textContent(), /Bed/);
  before = await orderCount();
  await clickTile(351, 361);
  await page.waitForFunction(count => window.__prisonPlaytest.inspect().orders.length > count, before, { timeout: 15000 });
  await advanceUntil(() => window.__prisonPlaytest.inspect().orders.every(order => order.state === 'complete'), 'bed order completes', 300, 10);
  await choose('objects', 'objects:cells', 'Toilet');
  before = await orderCount();
  await clickTile(353, 363);
  await page.waitForFunction(count => window.__prisonPlaytest.inspect().orders.length > count, before, { timeout: 15000 });
  await advanceUntil(() => window.__prisonPlaytest.inspect().orders.every(order => order.state === 'complete'), 'toilet order completes', 300, 10);

  // Verify actual operating state via the room inspector, then save and cold
  // reload through the ordinary browser save boundary.
  await closeCatalog('objects');
  await openBuiltCellInspector();
  assert.match(await inspector.textContent(), /Operational/);
  // Use the real roof toggle and camera controls for a readable operational
  // screenshot of the completed player-built room.
  await page.locator('#roofBtn').click();
  await page.evaluate(() => window.__prisonPlaytest.camera(352, 362, 42));
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/prison-player-cell-operational.png' });

  // Hire a guard through the catalog, verify both roles in the workforce
  // roster, then post the guard using the room's facility action.
  await choose('staff', 'staff:people', 'Guard');
  await clickTile(370, 380);
  await page.waitForFunction(kind => window.__prisonPlaytest.inspect().agents.some(agent => agent.kind === kind), Obj.Guard, { timeout: 20000 });
  await page.locator('#cats button[data-section="staff:people"]').click();
  const roster = page.locator('.staff-roster.is-open');
  await roster.waitFor({ state: 'visible' });
  assert.match(await roster.textContent(), /Workman/);
  assert.match(await roster.textContent(), /Guard/);
  await openBuiltCellInspector();
  await inspector.locator('button').filter({ hasText: 'Assign guard' }).click();
  assert.match(await inspector.textContent(), /Guards assigned: 1/);

  await page.locator('#saveNowBtn').click();
  await page.waitForFunction(() => document.querySelector('#saveStatus')?.textContent.startsWith('Saved '), null, { timeout: 30000 });
  assert.equal(durableSave?.version, 6, 'the player-built prison is saved as v6');
  writeFileSync('/tmp/prison-player-cell-v6-save.json', JSON.stringify(durableSave));
  const cashAfter = (await page.evaluate(() => window.__prisonPlaytest.inspect())).cash;
  assert(cashAfter < 19600, 'materials are charged to the player-built orders');
  const roomBeforeReload = await page.evaluate(() => window.__prisonPlaytest.inspect().rooms.find(room => room.type === 4));
  assert(roomBeforeReload?.valid, 'the new cell is operational before save');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__prisonPlaytest && document.querySelector('#hud')?.textContent.includes('fps'), null, { timeout: 120000 });
  const roomAfterReload = await page.evaluate(() => window.__prisonPlaytest.inspect().rooms.find(room => room.type === 4));
  assert.deepEqual(roomAfterReload, roomBeforeReload, 'operational cell survives a cold page reload');
  const normalClockStart = await page.evaluate(() => window.__prisonPlaytest.inspect().time);
  await page.waitForFunction(start => window.__prisonPlaytest.inspect().time > start, normalClockStart, { timeout: 5000 });
  await page.locator('#speeds .spd[aria-label="Pause simulation"]').click();
  assert.equal(await page.evaluate(() => window.__prisonPlaytest.inspect().speed), 0, 'normal speed controls pause the running prison');
  assert.deepEqual(pageErrors, [], `no browser errors: ${pageErrors.join('; ')}`);
  assert.deepEqual(failedRequests, [], `all browser requests succeed: ${failedRequests.join('; ')}`);
  console.log(`Fresh UI-built cell passed: builder hired, ${await orderCount()} construction groups, room operational before/after cold reload; cash ${cashAfter}.`);
  console.log('Screenshots: /tmp/prison-player-cell-requirements.png, /tmp/prison-player-cell-operational.png');
} finally {
  if (browser) await browser.close();
  await server.close();
}
