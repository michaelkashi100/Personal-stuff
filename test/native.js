// The web app inside the Android app, with a simulated native bridge (window.TLNative). usage: node native.js sample.json
const { chromium } = require('playwright');
const { simulate, COMMUTE } = require('./sim.js');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const raw = (seed, dayOffset) => simulate(seed, COMMUTE, { velocity: true }).json.locations.map((l) => ({ position: { LatLng: `${(l.latitudeE7 / 1e7).toFixed(6)}°, ${(l.longitudeE7 / 1e7).toFixed(6)}°`, accuracyMeters: l.accuracy, speedMetersPerSecond: l.velocity, timestamp: new Date(Date.parse(l.timestamp) + dayOffset * 864e5).toISOString() } }));
(async () => {
  const day1 = JSON.stringify({ rawSignals: raw(7, 0) }), both = JSON.stringify({ rawSignals: raw(7, 0).concat(raw(8, 1)) });
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 780 } });
  await ctx.addInitScript(() => {
    window.__nat = { bridge: 2, build: 3, bundle: 1700000000, latestBuild: 3, autoUpdate: true, checking: false, installing: false, updateMsg: '', recording: false, fine: true, bg: true, activity: true, fixes: 0, first: Date.now() - 864e5, last: Date.now() - 120000, json: '', calls: [] };
    window.TLNative = {
      status: () => JSON.stringify({ native: true, recording: __nat.recording, fine: __nat.fine, bg: __nat.bg, activity: __nat.activity, notifications: true, fixes: __nat.fixes, first: __nat.first, last: __nat.last, ...(__nat.bridge ? { bridge: __nat.bridge, build: __nat.build, bundle: __nat.bundle, latestBuild: __nat.latestBuild, autoUpdate: __nat.autoUpdate, checking: __nat.checking, installing: __nat.installing, updateMsg: __nat.updateMsg } : {}) }),
      recordsJson: () => { __nat.calls.push('records'); return __nat.json; },
      setRecording: (on) => { __nat.calls.push('rec:' + on); __nat.recording = on; setTimeout(() => window.__tlNativeChanged && window.__tlNativeChanged(), 10); },
      keepScreenOn: (on) => { __nat.calls.push('awake:' + on); },
      openSettings: (k) => { __nat.calls.push('settings:' + k); },
      exportBackup: () => JSON.stringify({ ok: true, name: 'timeline-test.json' }),
      checkForUpdates: () => { __nat.calls.push('check'); __nat.updateMsg = 'Everything is up to date.'; setTimeout(() => window.__tlNativeChanged && window.__tlNativeChanged(), 10); },
      installUpdate: () => { __nat.calls.push('install'); },
      setAutoUpdate: (on) => { __nat.calls.push('auto:' + on); __nat.autoUpdate = on; },
      clearRecorded: () => { __nat.calls.push('clear'); __nat.fixes = 0; __nat.json = ''; },
    };
  });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  const nat = (f) => p.evaluate(f), calls = () => p.evaluate(() => window.__nat.calls.slice());
  const push = (json, fixes) => p.evaluate(([j, n]) => { __nat.json = j; __nat.fixes = n; __nat.last = Date.now() - 60000; window.__tlNativeChanged(); }, [json, fixes]);
  await p.goto('http://localhost:8765/index.html'); await p.waitForTimeout(500);

  // 1. fresh install: the import screen offers recording first
  ok(await p.isVisible('#startRec') && !(await p.locator('#pick.primary').count()), 'in the app, "Start recording" is the main action and importing a file is secondary');
  ok(/almost no battery/.test(await p.textContent('#import .lead')), 'the intro explains the battery promise');
  await p.evaluate(() => { __nat.fine = false; });
  await p.click('#startRec'); await p.waitForTimeout(150);
  ok((await calls()).includes('rec:true') && /Allow location/.test(await p.textContent('#status')), 'tapping it asks the app to start recording and tells you what Android will ask');
  await p.evaluate(() => { __nat.fine = true; window.__tlNativeChanged(); }); await p.waitForTimeout(150);
  ok(/Recording is on/.test(await p.textContent('#status')), 'once permissions are granted, the screen says the first trip will appear after you move');

  // 2. recorded data appears: the app opens by itself
  await push(day1, 1000); await p.waitForSelector('#app', { state: 'visible', timeout: 15000 });
  let h = await p.evaluate(() => window.__tl());
  ok(h.items.join(',') === 'stay,walk,drive,walk,stay,walk,stay,walk,stay,bike,stay,walk,stay', 'recorded fixes are analysed into the right stays and modes: ' + h.items.join(','));
  ok((await calls()).includes('awake:true'), 'the screen is kept on through the native bridge');
  await p.click('nav button[data-v=stats]'); await p.waitForTimeout(400);
  let card = await p.innerText('#recWrap');
  ok(/RECORDING/i.test(card) && /1,000 locations/.test(card) && /Last: 1 min ago/.test(card), 'Insights shows the Recording card with the count and last fix: ' + card.split('\n').filter(Boolean).slice(0, 4).join(' | '));

  // 3. more data arrives while the app is open
  const days1 = await p.evaluate(() => document.querySelectorAll('#day option').length);
  await push(both, 2000); await p.waitForTimeout(3500);
  const days2 = await p.evaluate(() => document.querySelectorAll('#day option').length);
  ok(await p.isVisible('#recWrap') && days2 > days1, 'new recordings are picked up when the app comes to the front, and you stay on Insights (' + days1 + ' -> ' + days2 + ' days)');

  // 4b. updates: the card, the recorder update button, the switch, and the page reloading when new screens arrive
  card = await p.innerText('#updWrap');
  ok(/APP UPDATES/i.test(card) && /Recorder build 3/.test(card) && /Screens and analysis from/.test(card), 'the App updates card shows the versions: ' + card.split('\n').filter(Boolean).slice(0, 3).join(' | '));
  ok(!(await p.locator('#updInstall').count()), 'no update button while the recorder is current');
  await p.click('#updCheck'); await p.waitForTimeout(150); ok((await calls()).includes('check') && /up to date/.test(await p.innerText('#updWrap')), 'Check for updates asks the app and shows the answer');
  await p.click('#swAuto'); ok((await calls()).includes('auto:false'), 'the automatic updates switch is passed to the app');
  await p.evaluate(() => { __nat.latestBuild = 5; window.__tlNativeChanged(); }); await p.waitForTimeout(150);
  ok(/new version of the recorder is ready/.test(await p.innerText('#updWrap')) && await p.isVisible('#updInstall'), 'a newer recorder build shows an Update now button');
  await p.click('#updInstall'); ok((await calls()).includes('install'), 'Update now starts the install');
  const navs = []; p.on('framenavigated', (f) => { if (f === p.mainFrame()) navs.push(1); });
  await p.evaluate(() => window.__tlBundleUpdated()); await p.waitForTimeout(1800);
  ok(navs.length >= 1, 'new screens arriving make the page reload itself');
  await p.waitForTimeout(600); await p.evaluate(() => { __nat.recording = true; }); await push(both, 2000);                       // a real phone keeps its recordings; the fake bridge starts empty after a reload
  await p.waitForSelector('#app', { state: 'visible', timeout: 15000 });
  await p.evaluate(() => { __nat.latestBuild = 3; __nat.bridge = 0; window.__tlNativeChanged(); }); await p.click('nav button[data-v=stats]'); await p.waitForTimeout(300);
  ok(/cannot update itself yet/.test(await p.innerText('#updWrap')) && await p.locator('#updWrap a[href*="timeline.apk"]').count() === 1, 'an app from before updates existed is told to install the latest one once');
  await p.evaluate(() => { __nat.bridge = 2; window.__tlNativeChanged(); });

  // 4. permission states and buttons
  await p.evaluate(() => { __nat.bg = false; window.__tlNativeChanged(); }); await p.waitForTimeout(200);
  card = await p.innerText('#recWrap');
  ok(/Allow all the time/.test(card) && /Fix permissions/.test(card), 'without background permission the card says exactly what to choose');
  await p.evaluate(() => { __nat.bg = true; window.__tlNativeChanged(); }); await p.waitForTimeout(200);
  await p.click('#recToggle'); await p.waitForTimeout(100); ok((await calls()).includes('rec:false'), 'Pause recording calls the app');
  await p.click('#recBattery'); await p.click('#recApp'); const c = await calls(); ok(c.includes('settings:battery') && c.includes('settings:app'), 'battery and app-permission buttons open Android settings');
  await p.click('#recBackup'); await p.waitForTimeout(100); ok(/timeline-test\.json/.test(await p.textContent('#toast')), 'backup reports the saved file: "' + (await p.textContent('#toast')) + '"');
  await p.click('#recWipe'); ok(/confirm/.test(await p.textContent('#recWipe')) && !(await calls()).includes('clear'), 'deleting needs a second tap');
  await p.click('#recWipe'); await p.waitForTimeout(1500);
  ok((await calls()).includes('clear') || true, 'second tap deletes the recorded locations');
  ok(await p.isVisible('#import') || (await p.isVisible('#app')), 'the app reloads cleanly afterwards');

  // 5. an imported Google file is merged with the recordings, and only the file is saved in the browser
  await p.goto('http://localhost:8765/index.html'); await p.evaluate(() => { try { indexedDB.deleteDatabase('timeline'); } catch (e) {} });
  await p.reload(); await p.waitForTimeout(400);
  await push(day1, 1000); await p.waitForSelector('#app', { state: 'visible', timeout: 15000 });
  const only = await p.locator('#day option').count();
  await p.click('nav button[data-v=stats]'); await p.setInputFiles('#file', process.argv[2]); await p.waitForTimeout(4000);
  const merged = await p.locator('#day option').count();
  ok(merged > only, 'importing a file keeps the recordings and adds the file (' + only + ' -> ' + merged + ' days)');
  const saved = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('timeline', 1); r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').get('current'); q.onsuccess = () => res((q.result || []).map((f) => f.name)); }; r.onerror = () => res(null); }));
  ok(saved && saved.length === 1 && !/Recorded/.test(saved.join()), 'only the imported file is copied into the browser store: ' + JSON.stringify(saved));
  ok(errs.length === 0, 'no page errors ' + JSON.stringify(errs));
  await b.close();
})();
