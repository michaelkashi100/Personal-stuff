const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 780 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8765/index.html');
  const t = Date.now(); await p.setInputFiles('#file', process.argv[2]);
  await p.waitForSelector('#app', { state: 'visible', timeout: 120000 });
  console.log('loaded in', Date.now() - t, 'ms | days:', await p.locator('#day option').count(), '| status:', JSON.stringify(await p.textContent('#status')), '| errors:', errs);
  await b.close();
})();
