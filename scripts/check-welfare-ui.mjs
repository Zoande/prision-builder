import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { createServer } from 'vite';

const server = await createServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 360, height: 720 } });
  await page.route(`http://127.0.0.1:${address.port}/`, (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="host"></main></body></html>',
  }));
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const { WelfareOverview } = await import('/src/ui/welfareOverview.ts');
    const opened = [], selected = [];
    const view = new WelfareOverview({
      openCatalog: (mode, section) => opened.push({ mode, section }),
      selectResident: (id) => selected.push(id),
    }, document.querySelector('#host'));
    const data = {
      population: 17,
      needs: [
        { id: 'food', label: 'Food', affected: 4, urgent: 2, action: { mode: 'rooms', section: 'rooms:prisoner', label: 'Dining rooms' } },
        { id: 'privacy', label: 'Privacy', affected: 1, urgent: 0, action: { mode: 'rooms', section: 'rooms:prisoner', label: 'Housing' } },
      ],
      concerns: [
        { id: 41, name: 'A <img src=x onerror="alert(1)"> Resident', need: 'Food', percent: 8, detail: 'Meal service check' },
        { id: 42, name: 'Resident B', need: 'Hygiene', percent: 14, detail: 'Shower access check' },
      ],
    };
    view.update(data);
    const concern = view.element.querySelector('.wo-concern');
    concern.focus();
    const firstNode = view.element.firstElementChild;
    view.update(data);
    const focusPreserved = document.activeElement === concern;
    const sameNode = firstNode === view.element.firstElementChild;
    view.element.querySelector('.wo-need button').click();
    concern.click();
    const bounds = view.element.getBoundingClientRect();
    return {
      opened, selected,
      text: view.element.innerText,
      injectedImages: view.element.querySelectorAll('img').length,
      width: bounds.width,
      right: bounds.right,
      scrollWidth: view.element.scrollWidth,
      clientWidth: view.element.clientWidth,
      sameNode,
      focusPreserved,
      buttons: [...view.element.querySelectorAll('button')].length,
    };
  });
  assert.deepEqual(result.opened, [{ mode: 'rooms', section: 'rooms:prisoner' }]);
  assert.deepEqual(result.selected, [41]);
  assert.equal(result.injectedImages, 0, 'resident name is inserted as text, never markup');
  assert.ok(result.text.includes('A <img src=x onerror="alert(1)"> Resident'));
  assert.equal(result.sameNode, true, 'repeat update retains the overview DOM');
  assert.equal(result.focusPreserved, true, 'repeat update leaves focused controls alone');
  assert.ok(result.right <= 360 && result.width > 0, `overview stays inside phone width: ${JSON.stringify(result)}`);
  assert.ok(result.scrollWidth <= result.clientWidth + 1, `overview has no horizontal overflow: ${JSON.stringify(result)}`);
  await page.setViewportSize({ width: 320, height: 640 });
  const narrow = await page.locator('.welfare-overview').evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
  assert.ok(narrow.scrollWidth <= narrow.width + 1, `overview fits 320px viewport: ${JSON.stringify(narrow)}`);
  console.log('Welfare overview DOM, actions, escaping, stable updates, and mobile bounds passed.');
} finally {
  if (browser) await browser.close();
  await server.close();
}
