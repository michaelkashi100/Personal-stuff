// Real-world save failures. usage: node persist-robust.js sample.json tmpdir
const { chromium } = require('playwright'); const fs = require('fs');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const url = 'http://localhost:8765/index.html';
const savedSize = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('timeline', 1); r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').get('current'); q.onsuccess = () => res((q.result || []).reduce((a, f) => a + (f.text ? f.text.length : 0), 0)); }; r.onerror = () => res(-1); }));
(async () => {
  const b = await chromium.launch();
  const mk = async (init) => { const c = await b.newContext({ viewport: { width: 390, height: 780 } }); if (init) await c.addInitScript(init); const p = await c.newPage(); p.errs = []; p.on('pageerror', (e) => p.errs.push(e.message)); return p; };
  const days = (p) => p.locator('#day option').count();

  // (a) a bulky export (raw signals) is saved slimmed down, and reopens
  const big = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); big.rawSignals = Array.from({ length: 200000 }, (_, i) => ({ wifiScan: { deliveryTime: 't' + i, devicesRecords: [{ mac: i, rawRssi: -60 }] } }));
  const bigPath = process.argv[3] + '/bulky.json'; fs.writeFileSync(bigPath, JSON.stringify(big));
  let p = await mk();
  await p.goto(url); await p.setInputFiles('#file', bigPath); await p.waitForSelector('#app', { state: 'visible' });
  const n = await days(p), orig = fs.statSync(bigPath).size, sv = await savedSize(p);
  ok(sv > 0 && sv < orig * 0.1, `bulky file ${(orig / 1e6).toFixed(1)} MB saves as ${(sv / 1e6).toFixed(2)} MB`);
  ok(/Saved on this phone/.test(await p.textContent('#toast')), 'toast confirms the save: "' + (await p.textContent('#toast')) + '"');
  await p.reload(); await p.waitForSelector('#app', { state: 'visible' });
  ok((await days(p)) === n, 'slimmed copy reopens with the same days');
  await p.click('nav button[data-v=stats]'); await p.waitForTimeout(300);
  console.log('     stats card:', await p.textContent('#dinfo'));
  ok(p.errs.length === 0, 'no page errors');

  // (b) IndexedDB unusable -> Cache Storage fallback
  p = await mk(() => { indexedDB.open = () => { throw new DOMException('blocked', 'SecurityError'); }; });
  await p.goto(url); await p.setInputFiles('#file', process.argv[2]); await p.waitForSelector('#app', { state: 'visible' });
  ok(/Saved on this phone/.test(await p.textContent('#toast')), 'IndexedDB blocked: save still succeeds via cache');
  await p.reload(); await p.waitForSelector('#app', { state: 'visible', timeout: 5000 });
  ok((await days(p)) > 0, 'IndexedDB blocked: reload reopens from cache storage');
  await p.click('nav button[data-v=stats]'); await p.waitForTimeout(300);
  ok(/cache storage/.test(await p.textContent('#dinfo')), 'stats card says where it is saved');

  // (c) nothing works -> visible error, app still usable
  p = await mk(() => { indexedDB.open = () => { throw new DOMException('blocked', 'SecurityError'); }; Object.defineProperty(window, 'caches', { value: { open: () => Promise.reject(new DOMException('no', 'QuotaExceededError')), delete: () => Promise.resolve() } }); });
  await p.goto(url); await p.setInputFiles('#file', process.argv[2]); await p.waitForSelector('#app', { state: 'visible' });
  const t = await p.textContent('#toast');
  ok(/Couldn't save a copy/.test(t) && /SecurityError/.test(t), 'all storage blocked: error is shown: "' + t + '"');
  ok((await days(p)) > 0 && p.errs.length === 0, 'app still works for this visit, no page errors');

  // (d) a copy saved by the previous build (Blob records) still opens
  p = await mk(); await p.goto(url);
  await p.evaluate(async (txt) => new Promise((res) => { const r = indexedDB.open('timeline', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => { const t = r.result.transaction('files', 'readwrite'); t.objectStore('files').put([{ name: 'old.json', blob: new Blob([txt]) }], 'current'); t.oncomplete = res; }; }), fs.readFileSync(process.argv[2], 'utf8'));
  await p.reload(); await p.waitForSelector('#app', { state: 'visible', timeout: 5000 });
  ok((await days(p)) > 0, 'previous-build saved copy still opens');
  await b.close();
})();
