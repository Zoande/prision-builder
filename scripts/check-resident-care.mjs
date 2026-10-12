import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { residentCareMarkup } from '../src/ui/residentCare.ts';

const facts = {
  state: 'Waiting for escort',
  housing: 'No assigned bed',
  escort: 'Guard requested 2h ago',
  medical: 'Untreated injury: arm cut',
  discipline: 'Solitary ends in 01:20',
  warnings: ['Bed unavailable', '<img src=x onerror="window.pwned=true">'],
  actions: [{ label: 'Assign a bed', mode: 'staff', section: 'staff:people' }],
};
const markup = residentCareMarkup(facts);
assert.equal(residentCareMarkup(facts), markup, 'unchanged facts produce stable markup');
assert.ok(markup.includes('&lt;img src=x onerror=&quot;window.pwned=true&quot;&gt;'), 'warning text is escaped');
assert.ok(!markup.includes('<img'), 'untrusted warning cannot create an element');
assert.ok(markup.includes('data-mode="staff" data-section="staff:people"'), 'catalog action exposes routing data');

const document = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const styles = [...document.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n');
const browserPath = process.env.CHROMIUM_PATH || (process.platform === 'linux' ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 740 } });
  await page.setContent(`<style>${styles}</style><aside id="inspector" class="show"><header class="inspector-head"><div class="inspector-kicker">Selected resident</div></header><div id="inspectCare">${markup}</div></aside><div id="intelProfile" class="intel-profile">${markup}</div>`);
  assert.equal(await page.locator('#inspectCare img').count(), 0, 'malicious warning does not create an image');
  assert.match(await page.locator('#inspectCare').innerText(), /Untreated injury: arm cut/);
  await page.locator('#inspectCare [data-care-action="catalog"]').click();
  assert.deepEqual(await page.locator('#inspectCare [data-care-action="catalog"]').evaluate((button) => ({
    mode: button.dataset.mode,
    section: button.dataset.section,
  })), { mode: 'staff', section: 'staff:people' });
  const bounds = await page.evaluate(() => ['#inspector', '#inspectCare', '#intelProfile'].map((selector) => {
    const rect = document.querySelector(selector).getBoundingClientRect();
    return { selector, left: rect.left, right: rect.right, width: rect.width, scrollWidth: document.querySelector(selector).scrollWidth };
  }));
  for (const bound of bounds) {
    assert.ok(bound.left >= 0 && bound.right <= 360, `${bound.selector} stays within 360px viewport: ${JSON.stringify(bound)}`);
    assert.ok(bound.scrollWidth <= bound.width + 1, `${bound.selector} has no horizontal overflow: ${JSON.stringify(bound)}`);
  }
  await page.setViewportSize({ width: 320, height: 640 });
  const narrow = await page.locator('#intelProfile').evaluate((el) => ({ width: el.clientWidth, scrollWidth: el.scrollWidth }));
  assert.ok(narrow.scrollWidth <= narrow.width + 1, `care card fits 320px profile: ${JSON.stringify(narrow)}`);
  console.log('Resident care markup escaping, stable rendering, actions, and mobile bounds passed.');
} finally {
  await browser.close();
}
