// Capture the real visitor and resident at the family table from a cold browser import.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { createVisitationSave } from './visitationFixture.ts';

const root = process.cwd();
const browserPath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const fixture = createVisitationSave(true);
const server = await createServer({ root, configFile: resolve(root, 'vite.config.mjs'), server: { host: '127.0.0.1', port: 0, hmr: false } });
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: .5 });
  await page.route('**/api/save', async route => {
    if (route.request().method() === 'POST') {
      durableSave = route.request().postDataJSON();
      return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(durableSave) });
  });
  await page.route('**/api/sim-log', route => route.fulfill({ contentType: 'application/json', body: '{"ok":true}' }));
  await page.goto(`http://127.0.0.1:${address.port}/?playtest`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__prisonPlaytest && document.querySelector('#hud')?.textContent.includes('fps'), null, { timeout: 120000 });
  const status = await page.evaluate(() => window.__prisonPlaytest.visitation());
  assert(['waitingPrisoner', 'contact'].includes(status.state), `visitor reaches the room before browser import: ${status.state}`);
  const resident = await page.evaluate(() => window.__prisonPlaytest.inspect().agents.find(agent => agent.id === 8801));
  const guest = status.visitors[0];
  assert(Math.hypot(resident.x - guest.x, resident.z - guest.z) < 8,
    `the resident and guest are together in the room: resident=${resident.x},${resident.z} guest=${guest.x},${guest.z}`);
  await page.evaluate(() => window.__prisonPlaytest.camera(351, 93, 16));
  await page.locator('#roofBtn').click();
  await page.waitForTimeout(120);
  await page.screenshot({ path: resolve('/tmp/prison-visitor-room.png') });
  console.log(`Cold browser imported a real in-room visit (${status.state}); resident=${resident.x.toFixed(1)},${resident.z.toFixed(1)} guest=${guest.x.toFixed(1)},${guest.z.toFixed(1)}.`);
  console.log('Screenshot: /tmp/prison-visitor-room.png');
} finally {
  if (browser) await browser.close();
  await server.close();
}
