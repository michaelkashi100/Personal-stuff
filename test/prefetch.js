// Before the replay moves, the map squares it will show are downloaded. usage: node test/prefetch.js file.json
const { chromium } = require('playwright');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
(async () => {
  const b = await chromium.launch(); const c = await b.newContext({ viewport: { width: 390, height: 844 } });
  const seen = new Set(); let phase = 'before', missed = new Set(), during = new Set();
  await c.route('https://tile.openstreetmap.org/**', async (route) => {
    const u = route.request().url();
    if (phase === 'playing') { during.add(u); if (!seen.has(u)) missed.add(u); } else seen.add(u);
    await new Promise((r) => setTimeout(r, 30));                     // a slow-ish network
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  await c.addInitScript(() => { window.__forcePrefetch = true; try { localStorage.setItem('tl-autonext', '0'); } catch (e) {} });   // one day only: the next day's squares are fetched in the background while playing
  const p = await c.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8765/index.html'); await p.setInputFiles('#file', process.argv[2]); await p.waitForSelector('#app', { state: 'visible' }); await p.waitForTimeout(800);
  await p.click('#play'); await p.waitForTimeout(150);
  const t1 = await p.evaluate(() => window.__tlTiles());
  ok(t1.day && t1.day.total > 0, 'pressing play lists the map squares the whole replay needs (' + (t1.day && t1.day.total) + ')');
  ok(t1.day.done === t1.day.total || (t1.waiting && (await p.getAttribute('#play', 'class')).includes('loading')), 'and waits for them (unless already loaded), with progress on the play button');
  ok(!t1.waiting || /Loading the map/.test(await p.textContent('#toast')), 'it says what it is doing while it waits');
  await p.waitForFunction(() => window.__tl().playing, null, { timeout: 60000 });
  const t2 = await p.evaluate(() => window.__tlTiles());
  ok(t2.day.done === t2.day.total, 'it starts once everything is loaded (' + t2.day.done + '/' + t2.day.total + ')');
  phase = 'playing';
  await p.evaluate(() => { document.querySelector('[data-speed="4"]').click(); });
  await p.waitForFunction(() => window.__tl().frac > 0.97 || !window.__tl().playing, null, { timeout: 120000 }).catch(() => {});
  if (process.env.V) console.log([...missed].join(' '));
  console.log('   during the replay: ' + during.size + ' squares shown, ' + missed.size + ' not loaded in advance');
  ok(missed.size <= Math.max(1, 0.05 * during.size), 'almost every square shown during the replay was already loaded');
  // "start now" while loading
  await p.evaluate(() => { if (window.__tl().playing) document.getElementById('play').click(); });
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  await b.close(); process.exit(fails ? 1 : 0);
})();
