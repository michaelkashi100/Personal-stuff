const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 780 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8765/index.html');
  await p.setInputFiles('#file', process.argv[2]);
  await p.waitForSelector('#app', { state: 'visible' });
  const at = async (f) => { await p.evaluate((f) => { const r = document.getElementById('scrub'); r.value = Math.round(f * 100000); r.dispatchEvent(new Event('input')); }, f); await p.waitForTimeout(30); return p.evaluate(() => ({ ...window.__tl(), sub: document.getElementById('hudSub').textContent, time: document.getElementById('hudTime').textContent })); };
  console.log('V(ms):', (await at(0)).V);
  const rows = [];
  for (let f = 0; f <= 1.0001; f += 0.025) { const r = await at(Math.min(f, 1)); rows.push(`${f.toFixed(3)} z=${r.zoom.toFixed(2)} hdg=${r.heading.toFixed(0)} ${r.time} | ${r.sub}`); }
  console.log(rows.join('\n'));
  for (const [n, f] of [['stay', 0.01], ['mid', 0.16], ['out', 0.12]]) { await at(f); await p.waitForTimeout(100); await p.screenshot({ path: `${process.argv[3]}/cam_${n}.png` }); }
  // real playback: frames per second and zoom range seen
  await at(0); await p.click('#play');
  const stats = await p.evaluate(() => new Promise((res) => { let n = 0, zmin = 99, zmax = 0; const t0 = performance.now(); (function loop() { n++; const z = window.__tl().zoom; zmin = Math.min(zmin, z); zmax = Math.max(zmax, z); if (performance.now() - t0 < 3000) requestAnimationFrame(loop); else res({ fps: n / 3, zmin, zmax }); })(); }));
  console.log('playback:', JSON.stringify(stats), 'errors:', errs);
  await b.close();
})();
