// Saved-file flow: pick once -> reload opens directly -> change file -> forget -> corrupt copy.
// usage: node persist.js sample.json other.json
const { chromium } = require('playwright');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 780 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  const days = () => p.locator('#day option').count();
  const url = 'http://localhost:8765/index.html';
  await p.goto(url);
  ok(await p.isVisible('#pick'), 'first visit shows the picker');
  await p.setInputFiles('#file', process.argv[2]);
  await p.waitForSelector('#app', { state: 'visible' });
  const n1 = await days(); ok(n1 > 0, 'file loads (' + n1 + ' days)');

  const t = Date.now(); await p.reload(); await p.waitForSelector('#app', { state: 'visible' });
  ok((await days()) === n1 && !(await p.isVisible('#pick')), 'reload opens straight into the app, no picker (' + (Date.now() - t) + ' ms)');

  await p.setInputFiles('#file', process.argv[3]);                       // "Change file" while the app is open
  await p.waitForTimeout(800);
  const n2 = await days(); ok(n2 > 0 && n2 !== n1 || process.argv[3] === process.argv[2], 'changing the file while the app is open works (' + n2 + ' days)');
  await p.reload(); await p.waitForSelector('#app', { state: 'visible' });
  ok((await days()) === n2, 'the replaced file is what gets remembered');

  await p.click('nav button[data-v=stats]'); await p.click('#forget'); await p.click('#forget');   // two taps confirm
  await p.waitForSelector('#pick', { state: 'visible' });
  await p.reload(); await p.waitForTimeout(500);
  ok((await p.isVisible('#pick')) && !(await p.isVisible('#app')), 'after "Forget my data" the picker returns and stays');

  await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('timeline', 1); r.onsuccess = () => { const t = r.result.transaction('files', 'readwrite'); t.objectStore('files').put([{ name: 'bad.json', blob: new Blob(['{nope']) }], 'current'); t.oncomplete = res; }; }));
  await p.reload(); await p.waitForTimeout(800);
  const st = await p.textContent('#status');
  ok(/Could not read file/.test(st) && (await p.isVisible('#pick')), 'corrupt saved copy -> readable error + picker (' + st.slice(0, 40) + '…)');
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  await b.close();
})();
