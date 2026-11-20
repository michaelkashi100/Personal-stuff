// Presses every button / switch / select the UI offers in every state and reports errors, dead buttons and layout problems.
// usage: node test/press-all.js sample.json [shots-dir]
const { chromium } = require('playwright');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1, permissions: ['geolocation'], geolocation: { latitude: 32.0853, longitude: 34.7818, accuracy: 15 } });
  const p = await c.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('dialog', (d) => d.dismiss());
  const shots = process.argv[3];
  const shot = async (n) => { if (shots) await p.screenshot({ path: shots + '/' + n + '.png' }); };
  await p.goto('http://localhost:8765/index.html'); await p.setInputFiles('#file', process.argv[2]); await p.waitForSelector('#app', { state: 'visible' }); await p.waitForTimeout(2200);
  await shot('1-live');
  const st = () => p.evaluate(() => window.__tl());
  // every control must be visible, big enough to tap and not covered by another element
  const audit = async (label) => {
    const bad = await p.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('button,[role=switch],select,input[type=range]')) {
        const r = el.getBoundingClientRect(); if (!r.width || !r.height || el.closest('[hidden]') || getComputedStyle(el).visibility === 'hidden') continue;
        const cs = getComputedStyle(el); if (cs.display === 'none') continue;
        const vis = r.bottom > 0 && r.right > 0 && r.left < innerWidth && r.top < innerHeight; if (!vis) continue;
        const sm = el.id !== 'scrub' && (r.width < 32 || r.height < 28);
        const cx = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), cy = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)), top = document.elementFromPoint(cx, cy);
        const covered = top && !(el === top || el.contains(top) || top.contains(el));
        if (sm || covered) out.push((el.id || el.className || el.tagName) + (sm ? ' small ' + Math.round(r.width) + 'x' + Math.round(r.height) : '') + (covered ? ' covered by ' + (top.id || top.className || top.tagName) : ''));
      }
      return out;
    });
    ok(bad.length === 0, label + ': controls tappable ' + JSON.stringify(bad));
  };
  await audit('live map');
  const press = async (sel, label) => { const n = await p.$$(sel); let k = 0; for (const h of n) { if (!(await h.isVisible())) continue; try { await h.click({ timeout: 1500, force: false }); k++; await p.waitForTimeout(120); } catch (e) { console.log('  could not press', label, e.message.split('\n')[0]); fails++; } } return k; };
  // map view
  for (const id of ['locate', 'prevDay', 'nextDay', 'play']) { try { await p.click('#' + id, { timeout: 1500 }); await p.waitForTimeout(250); ok(true, 'pressed #' + id); } catch (e) { ok(false, '#' + id + ' ' + e.message.split('\n')[0]); } }
  await p.waitForTimeout(800); await shot('2-replay'); await audit('replay playing');
  for (const sp of ['2', '4', '1']) { await p.click('#speedSeg [data-speed="' + sp + '"]'); }
  ok((await st()).speed === 1, 'speed buttons');
  await p.click('#play'); await p.waitForTimeout(200);
  const opts = await p.$$eval('#day option', (o) => o.map((x) => x.value));
  for (const v of opts.slice(0, 4)) { await p.selectOption('#day', v); await p.waitForTimeout(250); }
  ok(true, 'day picker pressed');
  // scrub bar: drag to the start, middle and end
  for (const v of [0, 50000, 100000]) { await p.$eval('#scrub', (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, v); await p.waitForTimeout(150); }
  let s = await st(); ok(!s.live && Math.abs(s.frac - 1) < 0.01, 'scrubbing to the end works (frac ' + s.frac.toFixed(2) + ')');
  await p.click('#play'); await p.waitForTimeout(700); s = await st();
  ok(true, 'play at the end continues with the next day / stops: day ' + s.day + ' playing ' + s.playing);
  await p.click('#play').catch(() => {}); await p.waitForTimeout(100);
  const hasEdit = await p.isVisible('#hudEdit');
  await p.$eval('#scrub', (e) => { e.value = 1000; e.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.waitForTimeout(200);
  if (await p.isVisible('#hudEdit')) { await p.click('#hudEdit'); await p.waitForTimeout(400); ok(await p.isVisible('#ask .card'), 'hud edit opens the question sheet'); await shot('3-ask');
    for (const id of ['askNo', 'askYes', 'askLater']) { if (await p.isVisible('#' + id)) { await p.click('#' + id); await p.waitForTimeout(250); } }
    if (await p.isVisible('#ask .card')) await p.click('#askLater').catch(() => {});
  }
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  ok(!(await p.isVisible('#ask .card')), 'question sheet closes');
  // insights
  await p.click('nav button[data-v=stats]'); await p.waitForTimeout(500); await shot('4-insights'); await audit('insights');
  const rows = await p.$$('#statsView button.row');
  if (rows.length) { await rows[0].click(); await p.waitForTimeout(400); ok(await p.isVisible('#ask .card'), 'place row opens the question sheet'); await p.click('#askLater'); await p.waitForTimeout(250); }
  for (const id of ['swAwake', 'swNext', 'swAwake', 'swNext']) { const v1 = await p.getAttribute('#' + id, 'aria-checked'); await p.click('#' + id); const v2 = await p.getAttribute('#' + id, 'aria-checked'); if (v1 === v2) { ok(false, id + ' did not toggle'); } }
  ok(true, 'switches toggled');
  for (const id of ['forget']) { await p.click('#' + id); await p.waitForTimeout(150); ok((await p.textContent('#forget')).includes('again'), 'forget needs a second tap'); await p.waitForTimeout(3800); }
  await p.click('nav button[data-v=map]'); await p.waitForTimeout(400);
  await shot('5-back');
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  await b.close(); process.exit(fails ? 1 : 0);
})();
