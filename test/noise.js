// Wobble filtering + drive detection. usage: node noise.js noisy-visits.json noisy-records.json
const { chromium } = require('playwright');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch();
  const open = async (file) => { const p = await b.newPage({ viewport: { width: 390, height: 780 } }); p.errs = []; p.on('pageerror', (e) => p.errs.push(e.message)); await p.goto('http://localhost:8765/index.html'); await p.setInputFiles('#file', file); await p.waitForSelector('#app', { state: 'visible' }); return p; };
  const hook = (p) => p.evaluate(() => window.__tl());
  const sweep = async (p) => { const bad = []; for (let f = 0; f <= 1.0001; f += 0.01) { await p.evaluate((f) => { const r = document.getElementById('scrub'); r.value = Math.round(Math.min(f, 1) * 100000); r.dispatchEvent(new Event('input')); }, f); const h = await hook(p); if (h.car !== (h.cur === 'drive')) bad.push(f.toFixed(2) + ':' + h.cur + '/' + h.car); } return bad; };

  let p = await open(process.argv[2]);
  await p.selectOption('#day', { index: 0 });
  let h = await hook(p), sum = await p.textContent('#summary');
  ok(JSON.stringify(h.items) === JSON.stringify(['stay', 'drive', 'stay', 'walk', 'stay']), 'day 1: fake 55 m walk is ignored, Home is one stay, then drive / work / walk / gym -> ' + h.items.join(','));
  ok(/moving 3\d m/.test(sum), 'day 1 summary counts only the real trips: "' + sum + '"');
  let bad = await sweep(p); ok(bad.length === 0, 'day 1: car shown only while driving ' + (bad.length ? bad.join(' ') : ''));
  await p.selectOption('#day', { index: 1 });
  h = await hook(p); ok(JSON.stringify(h.items) === JSON.stringify(['stay', 'drive', 'stay', 'walk', 'stay']), 'day 2: label "walking" at 40 km/h -> drive; label "driving" at 2 km/h -> walk -> ' + h.items.join(','));
  bad = await sweep(p); ok(bad.length === 0, 'day 2: car only while driving');
  ok(p.errs.length === 0, 'no page errors');

  p = await open(process.argv[3]); h = await hook(p);
  ok(JSON.stringify(h.items) === JSON.stringify(['stay', 'drive', 'stay']), 'records: spikes + junk fixes + jitter -> stay, drive, stay -> ' + h.items.join(','));
  bad = await sweep(p); ok(bad.length === 0, 'records: car only while driving');
  console.log('     summary:', await p.textContent('#summary'));
  await b.close();
})();
