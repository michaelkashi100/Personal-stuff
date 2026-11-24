// Building outlines in the app, with a fake OpenStreetMap server. usage: node test/osm.js citywalk.json
const { chromium } = require('playwright');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await c.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  let calls = 0, other = 0;
  await c.route('https://overpass-api.de/**', (route) => {
    calls++;
    const q = decodeURIComponent(route.request().url().split('data=')[1] || ''), m = q.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
    const [s, w, n, e] = m.slice(1).map(Number), cy = (s + n) / 2, cx = (w + e) / 2, h = 0.0003;
    const ring = [[cy - h, cx - h], [cy - h, cx + h], [cy + h, cx + h], [cy + h, cx - h], [cy - h, cx - h]].map(([lat, lon]) => ({ lat, lon }));
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ elements: [{ type: 'way', tags: { building: 'yes' }, geometry: ring }, { type: 'way', tags: { highway: 'footway' }, geometry: [{ lat: s, lon: cx }, { lat: n, lon: cx }] }] }) });
  });
  p.on('request', (r) => { if (!/localhost|overpass-api|tile.openstreetmap/.test(r.url())) other++; });
  await p.goto('http://localhost:8765/index.html'); await p.setInputFiles('#file', process.argv[2]); await p.waitForSelector('#app', { state: 'visible' }); await p.waitForTimeout(1500);
  await p.click('#play'); await p.waitForTimeout(200); await p.click('#play'); await p.waitForTimeout(1500);   // view the day: it gets refined in the background
  const afterDay = calls;
  ok(afterDay > 0 && afterDay <= 40, 'viewing a day downloads the squares it passes through (' + afterDay + ')');
  const days = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('timeline-osm'); r.onsuccess = () => { const t = r.result.transaction('days').objectStore('days').count(); t.onsuccess = () => res(t.result); }; }));
  ok(days === 1, 'the finished day is kept as a small result');
  await p.click('#labBtn'); await p.waitForTimeout(1200);
  ok(/buildings/.test(await p.textContent('#labStats')), 'the Path lab uses the buildings: ' + (await p.textContent('#labStats')));
  ok(calls === afterDay, 'nothing is downloaded twice (cache)');
  await p.click('#labClose'); await p.waitForTimeout(200);
  await p.click('nav button[data-v=stats]'); await p.waitForTimeout(500);
  console.log('usage now', JSON.stringify(await p.evaluate(() => TL.osm.usage()))); const info = await p.textContent('#osmInfo');
  ok(/On this phone: \d+ square/.test(info), 'Insights says what is stored: ' + info);
  const ev = await p.evaluate(() => TL.osm.evict(Date.now() + 15 * 86400000).then(() => TL.osm.usage()));
  ok(ev.tiles === 0, 'squares unused for 14 days are deleted');
  await p.click('#swOsm'); await p.waitForTimeout(100);
  ok((await p.evaluate(() => localStorage.getItem('tl-osm'))) === 'false', 'the switch turns building outlines off');
  await p.click('#osmClear'); await p.waitForTimeout(300);
  await p.click('nav button[data-v=map]'); await p.waitForTimeout(300);
  const before = calls; await p.click('#labBtn'); await p.waitForTimeout(1000);
  ok(calls === before, 'when off, nothing is downloaded');
  ok(other === 0, 'no request goes anywhere else');
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  await b.close(); process.exit(fails ? 1 : 0);
})();
