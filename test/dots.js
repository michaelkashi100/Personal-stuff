// GPS readings shown as small dots along the way in the replay, with an on/off switch. usage: node test/dots.js citywalk.json [shot.png]
const { chromium } = require('playwright');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8765/index.html'); await p.setInputFiles('#file', process.argv[2]); await p.waitForSelector('#app', { state: 'visible' }); await p.waitForTimeout(800);
  const st = () => p.evaluate(() => window.__tl());
  const n = (await st()).dots;
  ok(n > 100, 'the day\'s GPS readings are drawn as dots (' + n + ')');
  await p.$eval('#scrub', (e) => { e.value = 40000; e.dispatchEvent(new Event('input', { bubbles: true })); }); await p.waitForTimeout(300);
  if (process.argv[3]) await p.screenshot({ path: process.argv[3] });
  await p.click('nav button[data-v=stats]'); await p.waitForTimeout(300);
  await p.click('#swDots'); await p.click('nav button[data-v=map]'); await p.waitForTimeout(300);
  ok((await st()).dots === 0, 'the switch in Insights hides them');
  await p.click('nav button[data-v=stats]'); await p.click('#swDots'); await p.click('nav button[data-v=map]'); await p.waitForTimeout(300);
  ok((await st()).dots === n, 'and shows them again');
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  await b.close(); process.exit(fails ? 1 : 0);
})();
