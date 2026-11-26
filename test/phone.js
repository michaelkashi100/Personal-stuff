// Phone time while still, with a simulated native bridge. usage: node test/phone.js sample.json
const { chromium } = require('playwright');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch();
  const mk = async (nat) => {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addInitScript((n) => {
      const day = 86400000, start = Date.parse('2026-06-01T00:00:00'), sessions = [];
      for (let t = start; t < start + 12 * day; t += 3600000) sessions.push([t + 600000, t + 600000 + 300000]);   // 5 min every hour
      window.__calls = [];
      window.TLNative = {
        status: () => JSON.stringify({ native: true, recording: false, fine: true, bg: true, activity: true, notifications: true, fixes: 0, first: 0, last: 0, build: 3, bundle: 1, latestBuild: 3, autoUpdate: true, checking: false, installing: false, updateMsg: '', bridge: 3, usage: true, usageSince: start, ...n }),
        screenJson: () => JSON.stringify(sessions), recordsJson: () => '', setRecording() {}, keepScreenOn() {},
        openSettings: (k) => window.__calls.push('settings:' + k), exportBackup: () => '{}', checkForUpdates() {}, installUpdate() {}, setAutoUpdate() {}, clearRecorded() {},
      };
    }, nat);
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto('http://localhost:8765/index.html'); await p.setInputFiles('#file', process.argv[2]); await p.waitForSelector('#app', { state: 'visible' }); await p.waitForTimeout(1800);
    return { p, errs };
  };
  // 1. permission granted, data present
  let { p, errs } = await mk({});
  const sum = await p.textContent('#summary');
  ok(/on phone/.test(sum), 'summary chip shows time on the phone: ' + sum.replace(/\s+/g, ' ').trim());
  // park the replay inside a stay (first scene) and look at the HUD
  await p.click('#play'); await p.click('#play'); await p.waitForTimeout(100);
  await p.$eval('#scrub', (e) => { e.value = 1000; e.dispatchEvent(new Event('input', { bubbles: true })); }); await p.waitForTimeout(150);
  ok(/on phone/.test(await p.textContent('#hudPhone')), 'phone time is tracked while at a stop (the HUD itself shows only the clock): ' + (await p.textContent('#hudPhone')));
  await p.$eval('#scrub', (e) => { e.value = 50000; e.dispatchEvent(new Event('input', { bubbles: true })); }); await p.waitForTimeout(150);
  await p.click('nav button[data-v=stats]'); await p.waitForTimeout(400);
  const card = await p.textContent('#statsView');
  ok(/Phone time while still/.test(card) && /\d+% of the/.test(card), 'Insights has the phone-time card with a share');
  ok(!/\b[AP]M\b/.test(card), 'no AM/PM in Insights');
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  // 2. permission missing: call to action
  ({ p, errs } = await mk({ usage: false }));
  ok(!/on phone/.test(await p.textContent('#summary')), 'without usage access there is no phone chip');
  await p.click('nav button[data-v=stats]'); await p.waitForTimeout(300);
  ok(await p.isVisible('#usageAllow'), 'Insights offers "Allow usage access"');
  await p.click('#usageAllow'); ok((await p.evaluate(() => window.__calls)).includes('settings:usage'), 'it opens the usage access settings');
  ok(errs.length === 0, 'no page errors (no permission) ' + JSON.stringify(errs));
  // 3. old app version
  ({ p, errs } = await mk({ bridge: 2, usage: false }));
  await p.click('nav button[data-v=stats]'); await p.waitForTimeout(300);
  ok(/newest version of the app/.test(await p.textContent('#statsView')), 'an older app is told to update');
  await b.close(); process.exit(fails ? 1 : 0);
})();
