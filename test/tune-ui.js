// Path lab: marking fixes wrong / right, and "Tune automatically" (worker). usage: node test/tune-ui.js citywalk.json
const { chromium } = require('playwright');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await c.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8765/index.html'); await p.setInputFiles('#file', process.argv[2]); await p.waitForSelector('#app', { state: 'visible' }); await p.waitForTimeout(1200);
  await p.click('#labBtn'); await p.waitForTimeout(600);
  ok(await p.isVisible('#tuneStart'), 'the Path lab has "Tune automatically"');
  // mark a confident fix as wrong
  let L = await p.evaluate(() => window.__tlLab());
  const i = L.c.findIndex((x, k) => x > 0.9 && k > 50 && !L.why[k]);
  const pt = await p.evaluate(([a, bb]) => window.__tlPt(a, bb), L.fixes[i]);
  await p.touchscreen.tap(pt.x, pt.y); await p.waitForTimeout(300);
  ok(await p.isVisible('[data-mark="0"]'), 'a tapped fix offers Wrong / Right');
  await p.click('[data-mark="0"]'); await p.waitForTimeout(300);
  L = await p.evaluate(() => window.__tlLab());
  ok(L.c[i] === 0 && L.why[i] === 'marked', 'marking it wrong leaves it out right away');
  ok((await p.getAttribute('[data-mark="0"]', 'aria-pressed')) === 'true', 'the Wrong button shows it is marked');
  ok(/1 wrong/.test(await p.textContent('#labTune')), 'the tuning box counts the mark');
  await p.click('[data-mark="0"]'); await p.waitForTimeout(300);
  ok((await p.evaluate(() => JSON.parse(localStorage.getItem('tl-marks')).length)) === 0, 'tapping Wrong again removes the mark');
  await p.click('[data-mark="1"]'); await p.waitForTimeout(200);
  ok((await p.evaluate(() => JSON.parse(localStorage.getItem('tl-marks'))[0].ok)) === true, 'a fix can be marked right');
  // tune
  await p.click('#tuneStart'); await p.waitForTimeout(300);
  ok(await p.isVisible('#labTune .tune-bar'), 'tuning shows its progress');
  await p.waitForSelector('#tuneDiscard', { timeout: 90000 });
  const txt = await p.textContent('#labTune');
  console.log('   ' + txt.replace(/\s+/g, ' ').slice(0, 260));
  ok(/Distance to the hidden readings: [\d.]+ m → [\d.]+ m/.test(txt), 'it reports the before / after score');
  ok(/Your GPS: wobbles about ±\d+ m/.test(txt) || /Not enough long stays/.test(txt), 'it reports what it learned about your GPS');
  const canApply = !(await p.isDisabled('#tuneApply'));
  if (canApply) {
    await p.click('#tuneApply'); await p.waitForTimeout(1500);
    ok(!(await p.isVisible('#lab .card')) && Object.keys(await p.evaluate(() => JSON.parse(localStorage.getItem('tl-clean') || '{}'))).length > 0, '"Use these" saves the tuned settings and closes the lab');
    await p.click('#labBtn'); await p.waitForTimeout(500);
    ok(await p.isVisible('#tuneStart'), 'the lab opens again normally after applying');
  } else { await p.click('#tuneDiscard'); console.log('   (nothing to change: apply skipped)'); }
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  await b.close(); process.exit(fails ? 1 : 0);
})();
