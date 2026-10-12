import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { host: '127.0.0.1', port: 0, hmr: false } });
let browser;
const deployment = `<div class="dash-tabs"><button class="dash-tab on">deployment</button></div><div class="profile-sub">Set persistent staffing by structural area.</div><div class="matrix">${Array.from({ length: 24 }, (_, i) => `<div class="matrix-row"><header><strong>Area ${i + 1}${i === 16 ? ' · Exterior' : ''}</strong><span>128 tiles</span></header><div class="toggle-grid"><span>guard <button class="tiny-btn" data-deploy="${i + 1}:guard:-1">−</button> <b>2</b> <button class="tiny-btn" data-deploy="${i + 1}:guard:1">+</button></span></div></div>`).join('')}</div>`;
const access = `<div class="dash-tabs"><button class="dash-tab on">access</button></div><div class="matrix"><div class="matrix-row"><header><strong>Area 3</strong><label>Mixed <input type="checkbox" data-area-mixed="3"></label></header><div class="toggle-grid"><label><input type="checkbox" data-area-custody="3:protective">protective</label><label><input type="checkbox" data-area-role="3:armed-guard">armed-guard</label></div></div></div>`;
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
  await page.setContent(`<style>${styles}</style><nav id="sideRail"><div id="modeNav">Navigation</div></nav><aside id="financialsDashboard" class="show"><div class="log-title">Financials</div><div class="log-summary">${['Cash', 'Net / hour', 'Performance'].map((x) => `<div class="log-kpi"><small>${x}</small><strong>$1,234,567</strong></div>`).join('')}</div><table class="log-table"><thead><tr><th>Time</th><th>Type</th><th>Memo</th><th>Amount</th></tr></thead><tbody><tr><td>Day 1 08:00</td><td>Contract invoice</td><td>Long memo for materials and quarterly institutional supply review</td><td>−$1,234,567</td></tr></tbody></table></aside><aside id="logisticsDashboard" class="show">${deployment}</aside><aside id="saveControls"></aside><aside id="saveStatus"></aside>`);
  await page.evaluate(async () => {
    const { annotateInstitutionalDashboard } = await import('/src/ui/institutionalDashboard.ts');
    const finances = document.querySelector('#financialsDashboard');
    const logistics = document.querySelector('#logisticsDashboard');
    annotateInstitutionalDashboard(finances);
    annotateInstitutionalDashboard(logistics);
    window.__annotateInstitutionalDashboard = annotateInstitutionalDashboard;
  });
  const financialBounds = await page.locator('#financialsDashboard').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: element.clientWidth, scrollWidth: element.scrollWidth, tableWidth: element.querySelector('table').scrollWidth };
  });
  assert.ok(financialBounds.left >= 0 && financialBounds.right <= 360, `Financials fits phone width: ${JSON.stringify(financialBounds)}`);
  assert.ok(financialBounds.top >= 220 && financialBounds.bottom <= 740, `Financials leaves navigation reachable: ${JSON.stringify(financialBounds)}`);
  assert.ok(financialBounds.tableWidth <= financialBounds.width + 1, `ledger wraps instead of forcing horizontal scroll: ${JSON.stringify(financialBounds)}`);
  assert.equal(await page.locator('#saveControls').evaluate((element) => getComputedStyle(element).display), 'none', 'save toolbar does not cover financial content');

  const areaSearch = page.locator('.area-filter-search');
  assert.equal(await page.locator('.area-filter-count').textContent(), '24 areas');
  await areaSearch.fill('17');
  assert.equal(await page.locator('#logisticsDashboard .matrix-row:visible').count(), 1, 'area number filter finds one structural area');
  assert.match(await page.locator('#logisticsDashboard .matrix-row:visible header').textContent(), /Area 17/);
  assert.match(await page.locator('.area-filter-count').textContent(), /1 of 24/);
  await page.locator('#logisticsDashboard').evaluate((element, markup) => { element.innerHTML = markup; }, deployment);
  await page.evaluate(() => window.__annotateInstitutionalDashboard(document.querySelector('#logisticsDashboard')));
  assert.equal(await page.locator('.area-filter-search').inputValue(), '17', 'area query survives frequent dashboard refreshes');
  assert.equal(await page.locator('#logisticsDashboard .matrix-row:visible').count(), 1);
  assert.equal(await page.locator('[data-deploy="17:guard:1"]').getAttribute('aria-label'), 'increase guard target in Area 17 · Exterior');

  await page.locator('#logisticsDashboard').evaluate((element, markup) => { element.innerHTML = markup; }, access);
  await page.evaluate(() => window.__annotateInstitutionalDashboard(document.querySelector('#logisticsDashboard')));
  assert.equal(await page.locator('[data-area-mixed]').getAttribute('aria-label'), 'Allow mixed custody classes in Area 3');
  assert.equal(await page.locator('[data-area-custody]').getAttribute('aria-label'), 'Allow protective custody in Area 3');
  assert.equal(await page.locator('[data-area-role]').getAttribute('aria-label'), 'Allow armed guard access in Area 3');
  await page.setViewportSize({ width: 320, height: 640 });
  const narrow = await page.locator('#financialsDashboard').evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, right: element.getBoundingClientRect().right }));
  assert.ok(narrow.right <= 320 && narrow.scrollWidth <= narrow.width + 1, `Financials fits 320px width: ${JSON.stringify(narrow)}`);
  console.log('Financials mobile bounds, ledger wrapping, searchable area controls, retained query, and accessible labels passed in Chromium.');
} finally {
  if (browser) await browser.close();
  await server.close();
}
