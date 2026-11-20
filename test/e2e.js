const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 780 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.goto('file:///home/user/Personal-stuff/index.html');
  await p.setInputFiles('#file', process.argv[2]);
  await p.waitForSelector('#app', { state: 'visible' });
  console.log('days:', await p.locator('#day option').count());
  await p.click('#play'); await p.waitForTimeout(600);
  console.log('label:', await p.textContent('#dayLabel'));
  await p.screenshot({ path: process.argv[3] + '/map.png' });
  await p.click('nav button[data-v=stats]');
  console.log((await p.innerText('#statsView')).replace(/\n+/g, ' | '));
  await p.screenshot({ path: process.argv[3] + '/stats.png' });
  console.log('errors:', errs);
  await b.close();
})();
