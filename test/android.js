// Fusion test on an Android-style export. usage: node android.js android.json
const { chromium } = require('playwright');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 780 } }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8765/index.html'); await p.setInputFiles('#file', process.argv[2]); await p.waitForSelector('#app', { state: 'visible' });
  const hook = () => p.evaluate(() => window.__tl());
  const exp = ['stay', 'walk', 'drive', 'walk', 'stay', 'walk', 'stay', 'walk', 'stay', 'bike', 'stay', 'walk', 'stay'];
  let h = await hook(); ok(JSON.stringify(h.items) === JSON.stringify(exp), 'stays + modes recovered from raw signals (+ Google hints): ' + h.items.join(','));
  const names = await p.evaluate(() => [...document.querySelectorAll('.leaflet-tooltip-pane, .leaflet-interactive')].length);
  await p.click('nav button[data-v=stats]'); const stats = await p.innerText('#statsView');
  ok(/Home/.test(stats) && /Work/.test(stats), 'stays are named from Google visits (Home / Work)');
  ok(/Saved copy/.test(stats) && !/No saved copy/.test(stats), 'a (slim) copy was saved');
  await p.reload(); await p.waitForSelector('#app', { state: 'visible' }); h = await hook();
  ok(JSON.stringify(h.items) === JSON.stringify(exp), 'the saved slim copy reproduces the same analysis after reload');
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs)); await b.close();
})();
