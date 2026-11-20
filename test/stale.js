// A stale page without analyze.js must recover (refresh once), and the normal page must still work.
const { chromium } = require('playwright');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch(); let p = await (await b.newContext()).newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  let loads = 0; await p.route('**/index.html', async (r) => { loads++; const res = await r.fetch(); await r.fulfill({ response: res, body: (await res.text()).replace('<script src="analyze.js"></script>', '') }); });
  await p.goto('http://localhost:8765/index.html'); await p.waitForTimeout(1500);
  ok(loads >= 2, 'a page missing analyze.js reloads itself once (' + loads + ' loads)');
  ok(/updated/.test(await p.textContent('#status')), 'and then says what to do instead of looping: "' + (await p.textContent('#status')) + '"');
  p = await (await b.newContext()).newPage(); await p.goto('http://localhost:8765/index.html'); await p.waitForTimeout(500);
  ok(await p.isVisible('#pick'), 'normal page shows the picker, no refresh loop');
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs)); await b.close();
})();
