// The car faces where it is going: during every trip, step through the replay and count sudden flips of direction.
// usage: node test/heading.js file.json [file2.json ...]
const { chromium } = require('playwright');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch();
  for (const file of process.argv.slice(2)) {
    const p = await b.newPage({ viewport: { width: 390, height: 780 } }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8765/index.html'); await p.setInputFiles('#file', file); await p.waitForSelector('#app', { state: 'visible' }); await p.waitForTimeout(800);
    const days = await p.$$eval('#day option', (o) => o.map((x) => x.value));
    let samples = 0, flips = 0, sumDelta = 0, lag = 0;
    for (const d of days) {
      await p.selectOption('#day', d); await p.waitForTimeout(150);
      const r = await p.evaluate(() => {
        const out = []; const sc = document.getElementById('scrub');
        for (let v = 0; v <= 100000; v += 250) { sc.value = v; sc.dispatchEvent(new Event('input', { bubbles: true })); const h = window.__tl(); out.push(h.cur !== 'stay' && h.target != null ? h.target : null); if (h.target != null && Math.abs(((h.heading - h.target + 540) % 360) - 180) > 1) out.lagged = (out.lagged || 0) + 1; }
        return { out, lagged: out.lagged || 0 };
      });
      lag += r.lagged; const rr = r.out;
      for (let i = 1; i < rr.length; i++) if (rr[i] != null && rr[i - 1] != null) { const dlt = Math.abs(((rr[i] - rr[i - 1] + 540) % 360) - 180); samples++; sumDelta += dlt; if (dlt > 120) { flips++; if (process.env.V) console.log("   flip", dlt.toFixed(0), "at step", i, "of day", d); } }
    }
    console.log(`   ${file.split('/').pop()}: ${samples} steps, ${flips} sudden reversals (>120 deg), mean change ${(sumDelta / Math.max(1, samples)).toFixed(1)} deg`);
    ok(samples > 0 && flips / samples < 0.01, file.split('/').pop() + ': the car does not flip direction (' + flips + ' flips)');
    ok(lag === 0, file.split('/').pop() + ': when paused, the car always faces the direction of travel (' + lag + ' times it did not)');
    ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
    await p.close();
  }
  await b.close(); process.exit(fails ? 1 : 0);
})();
