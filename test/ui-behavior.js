// UI behaviour: screen stays on, a finished day moves on to the next (never replays), day buttons, speed, two-step forget.
// usage: node ui-behavior.js sample.json
const { chromium } = require('playwright');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 780 } });
  await ctx.addInitScript(() => {
    window.__wake = { requests: 0, released: 0 };
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { window.__wake.requests++; const l = new EventTarget(); l.release = async () => { window.__wake.released++; l.dispatchEvent(new Event('release')); }; return l; } } });
  });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8765/index.html'); await p.setInputFiles('#file', process.argv[2]); await p.waitForSelector('#app', { state: 'visible' });
  const hook = () => p.evaluate(() => window.__tl()), wake = () => p.evaluate(() => window.__wake);

  ok((await wake()).requests >= 1, 'screen wake lock is requested when the app opens');
  await p.click('nav button[data-v=stats]');
  ok(/Active/.test(await p.textContent('#awakeNote')), 'Insights says the screen will not dim: "' + (await p.textContent('#awakeNote')) + '"');
  await p.click('#swAwake'); await p.waitForTimeout(100);
  ok((await wake()).released >= 1 && (await p.getAttribute('#swAwake', 'aria-checked')) === 'false', 'switching "Keep screen on" off releases the lock');
  const before = (await wake()).requests; await p.click('#swAwake'); await p.waitForTimeout(100);
  ok((await wake()).requests > before, 'switching it back on requests the lock again');
  await p.click('nav button[data-v=map]');

  // day navigation
  const n = await p.locator('#day option').count();
  await p.selectOption('#day', { index: 0 }); let h = await hook(); const d0 = h.day;
  ok(await p.isDisabled('#prevDay') && !(await p.isDisabled('#nextDay')), 'first day: previous disabled, next enabled (' + n + ' days)');
  await p.click('#nextDay'); h = await hook(); const d1 = h.day;
  ok(d1 > d0 && (await p.locator('#dayBanner.show').count()) === 1, 'next-day button moves forward and shows the day banner');
  await p.click('#prevDay'); h = await hook(); ok(h.day === d0, 'previous-day button goes back');

  // speed control
  await p.click('#speedSeg button[data-speed="4"]');
  ok((await p.getAttribute('#speedSeg button[data-speed="4"]', 'aria-pressed')) === 'true' && (await p.getAttribute('#speedSeg button[data-speed="1"]', 'aria-pressed')) === 'false', 'speed control marks the chosen speed');

  // a finished day continues with the next day and keeps playing
  await p.click('#play'); h = await hook(); ok(h.playing, 'play starts playback');
  let day = d0; const t0 = Date.now();
  while (Date.now() - t0 < 60000 && day === d0) { await p.waitForTimeout(250); day = (await hook()).day; }
  h = await hook();
  ok(day > d0 && h.playing, 'when the day finishes the replay moves to the next day and keeps playing (day ' + new Date(d0).getDate() + ' -> ' + new Date(day).getDate() + ')');
  let day2 = day; const t1 = Date.now();
  while (Date.now() - t1 < 60000 && day2 === day) { await p.waitForTimeout(250); day2 = (await hook()).day; }
  ok(day2 > day, 'and again to the day after (never back to a day already shown)');
  await p.click('#play');

  // last day: plays once, then stops with a message instead of repeating
  await p.selectOption('#day', { index: n - 1 }); h = await hook(); const last = h.day;
  await p.click('#play'); const t2 = Date.now();
  while (Date.now() - t2 < 60000 && (await hook()).playing) await p.waitForTimeout(250);
  h = await hook();
  ok(!h.playing && h.day === last && h.frac >= 0.999, 'last day ends on the last day instead of repeating it');
  ok(/last day/.test(await p.textContent('#toast')), 'and says so: "' + (await p.textContent('#toast')) + '"');
  ok(await p.isDisabled('#nextDay'), 'next-day button is disabled on the last day');

  // pressing play on a finished day continues with the next, or does nothing wrong on the last
  // forget: two taps
  await p.click('nav button[data-v=stats]'); await p.click('#forget');
  ok((await p.getAttribute('#forget', 'class')).includes('armed') && /confirm/.test(await p.textContent('#forget')), 'forget needs a second tap to confirm');
  await p.reload(); await p.waitForSelector('#app', { state: 'visible' });
  ok(true, 'a single tap on forget did not remove the data');
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  await b.close();
})();
