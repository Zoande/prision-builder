import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { host: '127.0.0.1', port: 0, hmr: false } });
let browser;
const fixture = `<div class="dash-tabs"><button class="dash-tab">shipments</button><button class="dash-tab on">work</button></div>
<section class="profile-section"><h3>Inmate assignments</h3><div class="matrix">
<div class="matrix-row"><header><strong>Alex Morgan</strong><span>Minimum</span></header><select class="work-select" data-work-agent="1"><option value="-1" selected>Unassigned</option><option value="2">laundry · room 2 (0/3)</option></select></div>
<div class="matrix-row"><header><strong>Taylor Reed</strong><span>Medium</span></header><select class="work-select" data-work-agent="2"><option value="-1">Unassigned</option><option value="4" selected>woodshop · room 4 (2/6)</option></select></div>
<div class="matrix-row"><header><strong>Robin Ellis</strong><span>Protective</span></header><select class="work-select" data-work-agent="3"><option value="-1">Unassigned</option><option value="5" selected>kitchen · room 5 (1/4)</option></select></div>
</div></section>`;
try {
  await server.listen();
  const address = server.httpServer.address();
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 360, height: 740 } });
  await page.route(`http://127.0.0.1:${address.port}/`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>' }));
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' });
  const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const styles = [...index.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n');
  await page.setContent(`<style>${styles}</style><aside id="logisticsDashboard" class="show">${fixture}</aside>`);
  await page.evaluate(async () => {
    const { annotateWorkAssignments } = await import('/src/ui/workAssignments.ts');
    const dashboard = document.querySelector('#logisticsDashboard');
    annotateWorkAssignments(dashboard);
    window.__annotateWorkAssignments = annotateWorkAssignments;
  });
  const search = page.locator('.work-assignment-search');
  assert.equal(await page.locator('.work-assignment-count').textContent(), '3 inmates');
  await search.fill('woodshop');
  assert.equal(await page.locator('.matrix-row:visible').count(), 1, 'current workplace search finds its matching inmate');
  assert.equal(await page.locator('.matrix-row:visible header strong').textContent(), 'Taylor Reed');
  assert.equal(await page.locator('.work-assignment-count').textContent(), '1 of 3 inmates');
  await search.fill('protective');
  assert.equal(await page.locator('.matrix-row:visible header strong').textContent(), 'Robin Ellis', 'custody label can be searched');

  await page.locator('#logisticsDashboard').evaluate((dashboard, markup) => { dashboard.innerHTML = markup; }, fixture);
  await page.evaluate(() => window.__annotateWorkAssignments(document.querySelector('#logisticsDashboard')));
  assert.equal(await page.locator('.work-assignment-search').inputValue(), 'protective', 'filter query survives dashboard rerender');
  assert.equal(await page.locator('.matrix-row:visible header strong').textContent(), 'Robin Ellis');
  const bounds = await page.locator('#logisticsDashboard').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: element.clientWidth, scrollWidth: element.scrollWidth };
  });
  assert.ok(bounds.left >= 0 && bounds.right <= 360, `work dashboard fits mobile viewport: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.scrollWidth <= bounds.width + 1, `work dashboard has no horizontal overflow: ${JSON.stringify(bounds)}`);
  await page.setViewportSize({ width: 320, height: 640 });
  const narrow = await page.locator('#logisticsDashboard').evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
  assert.ok(narrow.scrollWidth <= narrow.width + 1, `work dashboard fits 320px viewport: ${JSON.stringify(narrow)}`);
  console.log('Work assignment search, retained filters, and mobile dashboard bounds passed in Chromium.');
} finally {
  if (browser) await browser.close();
  await server.close();
}
