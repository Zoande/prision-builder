import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ root: process.cwd(), server: { host: '127.0.0.1', port: 0, hmr: false } });
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route(`http://127.0.0.1:${address.port}/`, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>' }));
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'domcontentloaded' });
  const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const styles = [...index.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n');
  await page.setContent(`<style>${styles}</style><aside id="policyDashboard" class="show"><div class="log-title">Policy</div>
    <div class="profile-sub">Automatic responses execute after the configured evidence threshold is met.</div>
    <div class="policy-row"><b>Incident</b><b>Evidence</b><b>Force ceiling</b><b>Search</b><b>Hours</b><b>Interview</b><b>Custody ↑</b><b>Protect</b><b>Seize</b><b>Medical</b></div>
    <div class="policy-row"><strong>assault-inmate</strong><select data-policy="0:threshold"><option>suspected</option><option>probable</option><option>confirmed</option></select><select data-policy="0:force"><option>order</option><option>restraint</option><option>lethal</option></select><select data-policy="0:search"><option>none</option><option>person</option><option>full</option></select><input type="number" min="0" max="72" value="12" data-policy="0:solitaryHours"><input type="checkbox" checked data-policy="0:interrogate"><input type="checkbox" data-policy="0:custodyUp"><input type="checkbox" data-policy="0:protectiveOffer"><input type="checkbox" checked data-policy="0:confiscate"><input type="checkbox" checked data-policy="0:medicalCheck"></div>
    <section class="profile-section"><h3>Item-specific responses</h3><div class="profile-sub">Unchanged rows inherit their category defaults.</div>
    <div class="policy-row"><b>Item / category</b><b>Evidence</b><b>Force ceiling</b><b>Search</b><b>Hours</b><b>Interview</b><b>Custody up</b><b>Protect</b><b>Seize</b><b>Medical</b></div>
    <div class="policy-row"><strong>Metal file<small>tool · inherited</small></strong><select data-item-policy="0:threshold"><option>probable</option><option>confirmed</option></select><select data-item-policy="0:force"><option>restraint</option><option>lethal</option></select><select data-item-policy="0:search"><option>cell</option><option>full</option></select><input type="number" value="8" data-item-policy="0:solitaryHours"><input type="checkbox" data-item-policy="0:interrogate"><input type="checkbox" data-item-policy="0:custodyUp"><input type="checkbox" data-item-policy="0:protectiveOffer"><input type="checkbox" checked data-item-policy="0:confiscate"><input type="checkbox" data-item-policy="0:medicalCheck"></div></section></aside>`);
  const annotated = await page.evaluate(async () => {
    const { annotatePolicyControls } = await import('/src/ui/policyControls.ts');
    const dashboard = document.querySelector('#policyDashboard');
    annotatePolicyControls(dashboard);
    return {
      controls: dashboard.querySelectorAll('select[data-policy], input[data-policy], select[data-item-policy], input[data-item-policy]').length,
      named: [...dashboard.querySelectorAll('select[data-policy], input[data-policy], select[data-item-policy], input[data-item-policy]')].every((control) => control.getAttribute('aria-label') && control.title),
      mobileLabels: dashboard.querySelectorAll('.policy-field-label').length,
      desktopHeader: dashboard.querySelector('.policy-header')?.children.length,
      forceTitle: dashboard.querySelector('[data-policy$="force"]').title,
      thresholdName: dashboard.querySelector('[data-policy$="threshold"]').getAttribute('aria-label'),
    };
  });
  assert.equal(annotated.controls, 18);
  assert.equal(annotated.named, true, 'every live policy control has an accessible name and explanation');
  assert.equal(annotated.mobileLabels, 18, 'every input has a visible mobile label');
  assert.equal(annotated.desktopHeader, 10, 'desktop column headings remain available');
  assert.match(annotated.forceTitle, /maximum force permitted.*lethal permits deadly force/i);
  assert.match(annotated.thresholdName, /assault-inmate: Evidence threshold/);

  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 740 });
    const bounds = await page.evaluate(() => {
      const panel = document.querySelector('#policyDashboard');
      const rows = [...panel.querySelectorAll('.policy-fields')];
      const box = panel.getBoundingClientRect();
      return {
        left: box.left, right: box.right,
        panelWidth: panel.clientWidth, panelScrollWidth: panel.scrollWidth,
        rowOverflow: rows.some((row) => row.scrollWidth > row.clientWidth + 1),
        cards: rows.every((row) => getComputedStyle(row).gridTemplateColumns.split(' ').length === 2),
        firstLabelVisible: getComputedStyle(rows[0].querySelector('.policy-field-label')).position !== 'absolute',
      };
    });
    assert.ok(bounds.left >= 0 && bounds.right <= width, `${width}px panel fits viewport: ${JSON.stringify(bounds)}`);
    assert.ok(bounds.panelScrollWidth <= bounds.panelWidth + 1, `${width}px dashboard has no horizontal scroll: ${JSON.stringify(bounds)}`);
    assert.equal(bounds.rowOverflow, false, `${width}px policy cards fit`);
    assert.equal(bounds.cards, true, `${width}px policy rows stack into two-column cards`);
    assert.equal(bounds.firstLabelVisible, true, `${width}px input label is visible`);
  }
  console.log('Policy control labels, descriptions, and 360/320px cards passed in Chromium.');
} finally {
  if (browser) await browser.close();
  await server.close();
}
