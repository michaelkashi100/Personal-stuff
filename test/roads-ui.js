// Driving is snapped to roads, with a fake OpenStreetMap server whose roads form a 100 m grid. usage: node test/roads-ui.js noisy-records.json
const { chromium } = require('playwright');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
// The fake map: one road along each drive the analysis finds in the file (its smoothed path), plus a decoy road
// running parallel 25 m to the north. The snapped drive must sit on the real road and never on the decoy.
const fs = require('fs'), TL = require('../parser.js'); require('../analyze.js');
const tl = TL.analyze(TL.parseTimeline(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))));
const ROADS = tl.filter((it) => it.kind === 'move' && it.mode === 'drive').map((it) => it.path);
const DECOYS = ROADS.map((r) => r.map(([la, lo]) => [la + 25 / 110540, lo]));
const segDist = (pt, line) => { let best = Infinity; const kx = 111320 * Math.cos(pt[0] * Math.PI / 180); for (let i = 1; i < line.length; i++) { const ax = (line[i - 1][1] - pt[1]) * kx, ay = (line[i - 1][0] - pt[0]) * 110540, bx = (line[i][1] - pt[1]) * kx, by = (line[i][0] - pt[0]) * 110540, dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, u = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0; best = Math.min(best, Math.hypot(ax + u * dx, ay + u * dy)); } return best; };
(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ viewport: { width: 390, height: 844 } });
  let roadCalls = 0, otherCalls = 0;
  await c.route('https://overpass-api.de/**', (route) => {
    const q = decodeURIComponent(route.request().url().split('data=')[1] || ''), m = q.match(/\(([-\d.]+),([-\d.]+),([-\d.]+),([-\d.]+)\)/);
    const [s, w, n, e] = m.slice(1).map(Number), els = [];
    if (/motorway/.test(q)) {
      roadCalls++;
      for (const r of ROADS.concat(DECOYS)) els.push({ type: 'way', tags: { highway: 'primary' }, geometry: r.map(([lat, lon]) => ({ lat, lon })) });
    } else otherCalls++;
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ elements: els }) });
  });
  const p = await c.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8765/index.html'); await p.setInputFiles('#file', process.argv[2]); await p.waitForSelector('#app', { state: 'visible' }); await p.waitForTimeout(800);
  const days = await p.$$eval('#day option', (o) => o.map((x) => x.value));
  for (const d of days) { await p.selectOption('#day', d); await p.waitForTimeout(1500); }
  const mv = await p.evaluate(() => window.__tlMoves());
  const drives = mv.filter((m) => m.mode === 'drive' && m.refined);
  ok(roadCalls > 0, 'viewing a day with a drive downloads the roads (' + roadCalls + ' road squares)');
  ok(drives.length > 0, 'the drive was refined (' + drives.length + ' drive legs)');
  const off = (pt) => Math.min(...ROADS.map((r) => segDist(pt, r))), offDecoy = (pt) => Math.min(...DECOYS.map((r) => segDist(pt, r)));
  let n = 0, onRoad = 0, onDecoy = 0;
  for (const m of drives) for (const pt of m.path.slice(1, -1)) { n++; if (off(pt) < 1.5) onRoad++; else if (offDecoy(pt) < 1.5) onDecoy++; }
  console.log('   ' + onRoad + ' of ' + n + ' drive points on the road, ' + onDecoy + ' on the decoy');
  if (process.env.V) for (const m of drives) m.path.forEach((pt, i) => { const o = off(pt); if (o >= 1.5) console.log('     off', i, '/', m.path.length, o.toFixed(1), 'decoy', offDecoy(pt).toFixed(1)); });
  ok(n > 0 && onRoad / n > 0.95, 'the driving path lies on the road');
  ok(onDecoy / n < 0.01, 'the parallel decoy road 25 m away is (almost) never used (' + onDecoy + '; where the road runs north-south the decoy overlaps it)');
  const walks = mv.filter((m) => m.mode === 'walk' && m.path.length > 3);
  if (walks.length) { let wn = 0, won = 0; for (const m of walks) for (const pt of m.path) { wn++; if (off(pt) < 0.5 || offDecoy(pt) < 0.5) won++; } ok(won / wn < 0.5, 'walking is not forced onto the roads (' + won + ' of ' + wn + ')'); }
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  await b.close(); process.exit(fails ? 1 : 0);
})();
