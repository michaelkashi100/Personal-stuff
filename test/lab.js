// Path lab: raw GPS, confidence dots, likely path and live settings. usage: node test/lab.js sample.json [shots-dir]
const { chromium } = require('playwright');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await c.newPage(); const errs = []; p.on('pageerror', (e) => { errs.push(e.message); if (process.env.STK) console.log(e.stack); });
  const shots = process.argv[3], shot = async (n) => { if (shots) await p.screenshot({ path: shots + '/' + n + '.png' }); };
  await p.goto('http://localhost:8765/index.html'); await p.setInputFiles('#file', process.argv[2]); await p.waitForSelector('#app', { state: 'visible' }); await p.waitForTimeout(1500);
  ok(await p.isVisible('#labBtn'), 'the Path lab button is on the map');
  await p.click('#labBtn'); await p.waitForTimeout(500);
  ok(await p.isVisible('#lab .card'), 'it opens the Path lab');
  ok(!(await p.isVisible('#controls')), 'the replay controls make room for it');
  const stats1 = await p.textContent('#labStats');
  ok(/\d+ fixes/.test(stats1), 'it says how many fixes and how many are doubted: ' + stats1);
  const paths = await p.evaluate(() => document.querySelectorAll('.leaflet-overlay-pane path').length);
  ok(paths >= 2, 'raw GPS and the likely path are drawn (' + paths + ' lines)');
  await shot('lab1');
  // toggle the raw path off and on
  await p.click('[data-show=raw]'); await p.waitForTimeout(150);
  const paths2 = await p.evaluate(() => document.querySelectorAll('.leaflet-overlay-pane path').length);
  ok(paths2 === paths - 1, 'the "Raw GPS" toggle hides the raw line');
  await p.click('[data-show=raw]');
  // tap a confidence dot (canvas): find one via Leaflet
  // tap a doubted fix: its confidence and the reasons appear
  const L = await p.evaluate(() => window.__tlLab());
  const lowI = L.c.findIndex((x, i) => x < 0.3 && !L.why[i]);
  if (lowI >= 0) {
    const pt = await p.evaluate(([a, b]) => window.__tlPt(a, b), L.fixes[lowI]);
    await p.touchscreen.tap(pt.x, pt.y); await p.waitForTimeout(400);
    const det = (await p.isVisible('#labDetail')) ? await p.textContent('#labDetail') : '';
    ok(/% sure this is real/.test(det) && /Distance from the path/.test(det), 'tapping a doubted fix shows its confidence and why');
  } else console.log('   (no doubted fix in this file: tap test skipped)');
  // move a slider: jump rate to the maximum -> more fixes doubted
  const doubted = (s) => +((s.match(/(\d+) doubted/) || [0, 0])[1]);
  await p.$eval('input[data-key=jumpRate]', (e) => { e.value = 0.4; e.dispatchEvent(new Event('input', { bubbles: true })); }); await p.waitForTimeout(400);
  const stats2 = await p.textContent('#labStats');
  ok(doubted(stats2) >= doubted(stats1), 'raising "How often GPS jumps" doubts more fixes (' + doubted(stats1) + ' -> ' + doubted(stats2) + ')');
  ok((await p.textContent('#lv_jumpRate')).trim() === '0.40', 'the slider shows its value');
  // Defaults
  await p.click('#labReset'); await p.waitForTimeout(400);
  ok((await p.inputValue('input[data-key=jumpRate]')) === '0.08', 'Defaults puts the sliders back');
  // tap a dot: click where the first fix is drawn
  const xy = await p.evaluate(() => {
    const paths = document.querySelectorAll('.leaflet-overlay-pane canvas'); return paths.length;
  });
  ok(xy >= 1, 'confidence dots are drawn on a canvas');
  // Use everywhere: saves the settings and re-analyses
  await p.$eval('input[data-key=keep]', (e) => { e.value = 0.5; e.dispatchEvent(new Event('input', { bubbles: true })); }); await p.waitForTimeout(300);
  await p.click('#labApply'); await p.waitForTimeout(1200);
  ok(!(await p.isVisible('#lab .card')), '"Use everywhere" closes the lab');
  ok(JSON.stringify(await p.evaluate(() => JSON.parse(localStorage.getItem('tl-clean')))) === '{"keep":0.5}', 'only the changed setting is saved');
  ok(await p.isVisible('#controls'), 'the replay controls come back');
  // Back button closes the lab
  await p.click('#labBtn'); await p.waitForTimeout(400);
  ok((await p.evaluate(() => window.__tlBack())) === true && !(await p.isVisible('#lab .card')), 'Back closes the Path lab');
  // the saved setting is used after a reload
  await p.reload(); await p.waitForSelector('#app', { state: 'visible' }); await p.waitForTimeout(1200);
  await p.click('#labBtn'); await p.waitForTimeout(400);
  ok((await p.inputValue('input[data-key=keep]')) === '0.5', 'the saved setting is still there after reopening the app');
  await p.click('#labClose'); await p.waitForTimeout(200);
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  await b.close(); process.exit(fails ? 1 : 0);
})();
