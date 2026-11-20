// Naming places: proactive question, Insights list, HUD button, persistence, skip. usage: node places-ui.js android.json [shotdir]
const { chromium } = require('playwright');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { window.__forceAsk = true; });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  const shot = process.argv[3];
  await p.goto('http://localhost:8765/index.html'); await p.setInputFiles('#file', process.argv[2]); await p.waitForSelector('#app', { state: 'visible' });
  const labels = () => p.evaluate(() => JSON.parse(localStorage.getItem('tl-places') || '[]'));

  // 1. a first question appears by itself, about the place that most clearly is home
  await p.waitForSelector('#ask:not([hidden])', { timeout: 6000 });
  ok(/Is this your home\?/.test(await p.textContent('#askTitle')), 'first question: "' + (await p.textContent('#askTitle')) + '"');
  ok(/visits?/.test(await p.textContent('#ask .askhead p')) && /\bh in total/.test(await p.textContent('#ask .askhead p')), 'it says how much time you spend there: "' + (await p.textContent('#ask .askhead p')).trim() + '"');
  if (shot) await p.screenshot({ path: shot + '/pl_ask1.png' });
  await p.click('#askYes'); await p.waitForTimeout(300);
  let l = await labels(); ok(l.length >= 1 && l[0].name === 'Home' && l[0].kind === 'home', 'yes saves it as Home (' + JSON.stringify(l[0]) + ')');
  ok(/Question 2 of 2/.test(await p.textContent('#ask .progress')), 'the next question follows in the same session (' + (await p.textContent('#ask .progress')).trim() + ')');

  // 2. "no" leads to the open question, with kinds and a name field
  await p.click('#askNo');
  ok(/What is this place for you\?/.test(await p.textContent('#askTitle')) && (await p.locator('.kind').count()) === 8, 'no: asks what the place is for you, with 8 kinds');
  ok(await p.isDisabled('#askSave'), 'save is disabled until a kind or a name is given');
  await p.click('.kind[data-kind="food"]'); await p.fill('#askName', 'Joe’s Cafe');
  if (shot) await p.screenshot({ path: shot + '/pl_ask2.png' });
  await p.click('#askSave'); await p.waitForTimeout(300);
  l = await labels(); ok(l.some((x) => x.name === 'Joe’s Cafe' && x.kind === 'food'), 'a custom name and kind are saved');
  await p.waitForTimeout(300);
  ok(await p.locator('#ask[hidden]').count() === 1 || /place for you|Is this/.test(await p.textContent('#askTitle')), 'the sheet moves on or closes');
  if (await p.locator('#ask:not([hidden])').count()) await p.click('#askLater');

  // 3. Insights lists the places with their names
  await p.click('nav button[data-v=stats]'); await p.waitForTimeout(500);
  const stats = await p.innerText('#statsView');
  ok(/your places/i.test(stats) && /Home/.test(stats) && /Joe’s Cafe/.test(stats), 'Insights shows "Your places" with the names you gave');
  if (shot) await p.screenshot({ path: shot + '/pl_stats.png' });

  // 3b. a place that looks like work gets the work question
  await p.click('button.row[data-pid]:has-text("Work")'); await p.waitForSelector('#ask:not([hidden])');
  ok(/Is this where you work\?/.test(await p.textContent('#askTitle')), 'asking about a work-like place: "' + (await p.textContent('#askTitle')) + '"');
  if (shot) await p.screenshot({ path: shot + '/pl_ask_work.png' });
  await p.click('#askLater'); await p.click('nav button[data-v=stats]'); await p.waitForTimeout(300);

  // 4. renaming from Insights, and removing a name
  await p.click('button.row[data-pid]:has-text("Joe")'); await p.waitForSelector('#ask:not([hidden])');
  ok(/Rename this place/.test(await p.textContent('#askTitle')) && (await p.inputValue('#askName')) === 'Joe’s Cafe', 'tapping a named place opens it for renaming');
  await p.fill('#askName', 'Joe’s Coffee'); await p.click('#askSave'); await p.waitForTimeout(300);
  ok((await labels()).some((x) => x.name === 'Joe’s Coffee'), 'renaming works');
  if (await p.locator('#ask:not([hidden])').count()) await p.click('#askLater');
  await p.click('nav button[data-v=stats]');

  // 5. the HUD shows the name and has a rename button while stopped
  await p.click('nav button[data-v=map]'); await p.evaluate(() => { const r = document.getElementById('scrub'); r.value = 1000; r.dispatchEvent(new Event('input')); }); await p.waitForTimeout(200);
  ok(await p.isVisible('#hudEdit'), 'the HUD has a name/rename button while stopped at a place');
  await p.click('#hudEdit'); await p.waitForSelector('#ask:not([hidden])'); ok(true, 'it opens the question for that place'); await p.click('#askLater');

  // 6. names survive a reload; "don't ask again" removes a place from the questions
  await p.reload(); await p.waitForSelector('#app', { state: 'visible' }); await p.waitForTimeout(3500);
  ok((await labels()).length >= 2, 'names are still there after reload');
  if (await p.locator('#ask:not([hidden])').count()) { const t = await p.textContent('#askTitle'); const never = p.locator('#askNever'); if (await never.count()) { await never.click(); ok((await labels()).some((x) => x.skip), 'don\'t ask about this place is remembered (' + t + ')'); } }
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  await b.close();
})();
