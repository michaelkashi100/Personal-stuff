// Dense sweep: car must stay inside the map frame at every point of the day.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 780 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8765/index.html');
  await p.setInputFiles('#file', process.argv[2]);
  await p.waitForSelector('#app', { state: 'visible' });
  const res = await p.evaluate(async () => {
    const out = []; const m = document.getElementById('map').getBoundingClientRect();
    for (let f = 0; f <= 1.0001; f += 0.005) {
      const r = document.getElementById('scrub'); r.value = Math.round(Math.min(f, 1) * 100000); r.dispatchEvent(new Event('input'));
      const c = document.querySelector('.live .carwrap').getBoundingClientRect();
      out.push({ f, z: window.__tl().zoom, dx: c.x + c.width / 2 - (m.x + m.width / 2), dy: c.y + c.height / 2 - (m.y + m.height / 2) });
    }
    return { out, w: m.width, h: m.height };
  });
  const maxdx = Math.max(...res.out.map((r) => Math.abs(r.dx))), maxdy = Math.max(...res.out.map((r) => Math.abs(r.dy)));
  const zs = res.out.map((r) => r.z); const stepJump = Math.max(...zs.slice(1).map((z, i) => Math.abs(z - zs[i])));
  console.log(`map ${res.w}x${res.h} | max car offset from centre: x=${maxdx.toFixed(0)} (limit ${res.w / 2}), y=${maxdy.toFixed(0)} (limit ${res.h / 2}) | zoom range ${Math.min(...zs).toFixed(2)}-${Math.max(...zs).toFixed(2)} | biggest zoom step ${stepJump.toFixed(2)} | errors ${errs.length}`);
  await b.close();
})();
