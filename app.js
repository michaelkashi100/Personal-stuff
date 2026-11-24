(function () {
  const $ = (id) => document.getElementById(id);
  // A stale cached page can be paired with newer scripts (an old index.html without analyze.js). Detect that,
  // clear our old app caches (never the saved timeline) and refresh once; if it persists, say what to do.
  if (typeof TL.analyze !== 'function') {
    let tried = false;
    try { tried = sessionStorage.getItem('tl-refresh') === '1'; sessionStorage.setItem('tl-refresh', '1'); } catch (e) {}
    if (!tried) {
      (async () => {
        try {
          for (const k of await caches.keys()) if (k.startsWith('timeline-v')) await caches.delete(k);
          for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
        } catch (e) {}
        location.reload();
      })();
    } else $('status').textContent = 'Some app files did not load. Wait a minute, then close this tab and open the site again.';
    return;
  }
  try { sessionStorage.removeItem('tl-refresh'); } catch (e) {}
  let data = null, timeline = [], places = [], map, dayLayer, marker;
  // Inside the Android app a native recorder is available as window.TLNative (it records in the background and keeps the data on the phone).
  const NATIVE = typeof window.TLNative === 'object' && window.TLNative ? window.TLNative : null;
  const nat = (fn, ...a) => { try { const r = NATIVE[fn](...a); return typeof r === 'string' && r[0] === '{' ? JSON.parse(r) : r; } catch (e) { return null; } };
  const nativeSource = () => ({ name: 'Recorded on this phone', ephemeral: true, text: () => Promise.resolve(String(NATIVE.recordsJson(0))) });
  const savedSource = (e) => ({ name: e.name, text: () => (e.text != null ? Promise.resolve(e.text) : e.blob.text()) });
  let nativeStatus = null, nativeFixes = -1, reloadingNative = false;
  // Phone use (Android app, "Usage access"): sessions with the screen on, [start, end] in ms, sorted. phoneSince = when the copy began.
  let phone = [], phoneSince = 0;
  function loadPhone() {
    let next = [], since = 0;
    if (NATIVE && nativeStatus && nativeStatus.bridge >= 3 && nativeStatus.usage) {
      try { const a = JSON.parse(String(NATIVE.screenJson(0))); if (Array.isArray(a)) { next = a; since = nativeStatus.usageSince || 0; } } catch (e) {}
    }
    const changed = next.length !== phone.length || since !== phoneSince || (next.length > 0 && next[next.length - 1][1] !== phone[phone.length - 1][1]);
    phone = next; phoneSince = since; return changed;
  }
  const phoneOn = () => phoneSince > 0;
  function phoneMs(a, b) {                                     // time with the screen on between a and b
    if (!phone.length || b <= a) return 0;
    let lo = 0, hi = phone.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (phone[m][1] <= a) lo = m + 1; else hi = m; }
    let sum = 0;
    for (let i = lo; i < phone.length && phone[i][0] < b; i++) sum += Math.max(0, Math.min(b, phone[i][1]) - Math.max(a, phone[i][0]));
    return sum;
  }
  const DAY = 86400000;
  const MODE_COLOR = { drive: '#f87171', walk: '#4ade80', run: '#a3e635', bike: '#fbbf24', transit: '#a78bfa', flight: '#fb923c', other: '#94a3b8' };
  const MODE_NAME = { drive: 'Driving', walk: 'Walking', run: 'Running', bike: 'Cycling', transit: 'Transit', flight: 'Flying', other: 'Moving' };
  const MODE_ICON = { drive: 'car', walk: 'footprints', run: 'footprints', bike: 'bike', transit: 'train', flight: 'plane', other: 'route' };

  // One icon language for the whole app: 24px grid, 2px round strokes (the .ic class sets the stroke).
  const ICON = {
    car: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
    footprints: '<path d="M4 16v-2.4C4 11.5 3 10.5 3 8c0-2.7 1.5-6 4.5-6C9.4 2 10 3.8 10 5.5c0 3.1-2 5.7-2 8.7V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.4c0-2.1 1-3.1 1-5.6 0-2.7-1.5-6-4.5-6C14.6 6 14 7.8 14 9.5c0 3.1 2 5.7 2 8.7V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/>',
    bike: '<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>',
    train: '<path d="M8 3.1V7a4 4 0 0 0 8 0V3.1"/><path d="m9 15-1-1"/><path d="m15 15 1-1"/><path d="M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z"/><path d="m8 19-2 3"/><path d="m16 19 2 3"/>',
    plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
    route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
    map: '<path d="M14.1 5.55a2 2 0 0 0 1.8 0l3.66-1.83A1 1 0 0 1 21 4.62v12.76a1 1 0 0 1-.55.9l-4.55 2.28a2 2 0 0 1-1.79 0l-4.21-2.1a2 2 0 0 0-1.79 0l-3.66 1.83A1 1 0 0 1 3 19.38V6.62a1 1 0 0 1 .55-.9l4.55-2.28a2 2 0 0 1 1.79 0z"/><path d="M15 5.76v15"/><path d="M9 3.24v15"/>',
    chart: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
    play: '<polygon points="7 4 20 12 7 20 7 4"/>',
    pause: '<rect x="6" y="4" width="4.5" height="16" rx="1.2"/><rect x="13.5" y="4" width="4.5" height="16" rx="1.2"/>',
    prev: '<path d="m15 18-6-6 6-6"/>',
    next: '<path d="m9 18 6-6-6-6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
    briefcase: '<rect width="20" height="14" x="2" y="7" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
    school: '<path d="M21.42 10.92a1 1 0 0 0-.02-1.84L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0z"/><path d="M22 10v6"/><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"/>',
    gym: '<path d="M6.5 6.5v11"/><path d="M17.5 6.5v11"/><path d="M3.5 9v6"/><path d="M20.5 9v6"/><path d="M6.5 12h11"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
    food: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    locate: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 1v3"/><path d="M12 20v3"/><path d="M1 12h3"/><path d="M20 12h3"/>',
    phone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
    sliders: '<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  };
  const svg = (name, cls) => '<svg class="ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + (ICON[name] || '') + '</svg>';
  const hydrate = (root) => root.querySelectorAll('[data-icon]').forEach((el) => { if (!el.firstChild) el.innerHTML = svg(el.dataset.icon); });

  // ---- Remember the file: a private copy kept in this browser's own storage on this device ----
  // Saved as slimmed-down text in IndexedDB; Cache Storage is the fallback. Failures are reported, never swallowed.
  const CACHE_NAME = 'timeline-data', CACHE_URL = './saved-timeline.json';
  let savedMeta = null, saveErr = '';
  const errName = (e) => (e && (e.name || e.message)) || 'error';
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open('timeline', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = async (mode, fn) => {
    const db = await idb();
    try {
      return await new Promise((res, rej) => {
        const t = db.transaction('files', mode), q = fn(t.objectStore('files'));
        t.oncomplete = () => res(q && q.result);
        t.onerror = (ev) => rej((ev.target && ev.target.error) || t.error || new Error('storage error'));
        t.onabort = () => rej(t.error || new Error('storage aborted'));
      });
    } finally { db.close(); }
  };
  const textSize = (list) => list.reduce((a, f) => a + (f.text ? f.text.length : f.blob ? f.blob.size : 0), 0);
  async function saveFiles(list) {                          // list: [{ name, text }]
    const size = textSize(list);
    let first = '';
    try { await tx('readwrite', (st) => st.put(list, 'current')); return { ok: true, where: 'browser storage', size }; } catch (e) { first = errName(e); }
    try { const c = await caches.open(CACHE_NAME); await c.put(CACHE_URL, new Response(JSON.stringify(list))); return { ok: true, where: 'cache storage', size }; }
    catch (e) { return { ok: false, size, error: first + ' / ' + errName(e) }; }
  }
  async function loadFiles() {
    try { const v = await tx('readonly', (st) => st.get('current')); if (v && v.length) { savedMeta = { size: textSize(v), where: 'browser storage' }; return v; } } catch (e) { saveErr = 'read: ' + errName(e); }
    try { const c = await caches.open(CACHE_NAME), r = await c.match(CACHE_URL); if (r) { const v = await r.json(); if (v && v.length) { savedMeta = { size: textSize(v), where: 'cache storage' }; return v; } } } catch (e) { saveErr = 'read: ' + errName(e); }
    return null;
  }
  async function clearFiles() {
    try { await tx('readwrite', (st) => st.delete('current')); } catch (e) {}
    try { await caches.delete(CACHE_NAME); } catch (e) {}
  }
  // Keep only what the analysis reads (drops wifi scans and other bulk); still Google's original format.
  function slim(json) {
    if (Array.isArray(json)) return json;
    const raw = (arr) => (arr || []).filter((r) => r && (r.position || r.activityRecord)).map((r) => (r.position
      ? { position: { LatLng: r.position.LatLng || r.position.latLng, accuracyMeters: r.position.accuracyMeters, speedMetersPerSecond: r.position.speedMetersPerSecond, timestamp: r.position.timestamp } }
      : { activityRecord: { probableActivities: (r.activityRecord.probableActivities || []).slice(0, 2), timestamp: r.activityRecord.timestamp } }));
    if (json.semanticSegments) return { semanticSegments: json.semanticSegments, rawSignals: raw(json.rawSignals) };
    if (json.timelineObjects) return { timelineObjects: json.timelineObjects };
    if (json.locations) return { locations: json.locations.map((l) => ({ latitudeE7: l.latitudeE7, longitudeE7: l.longitudeE7, accuracy: l.accuracy, velocity: l.velocity, timestamp: l.timestamp, activity: (l.activity || []).slice(0, 1) })) };
    if (json.rawSignals) return { rawSignals: raw(json.rawSignals) };
    return json;
  }
  let toastTimer = 0;
  function toast(msg, ms) { const el = $('toast'); el.textContent = msg; el.style.display = 'block'; clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.style.display = 'none'), ms || 4000); }
  const mb = (n) => (n < 1e6 ? Math.max(1, Math.round(n / 1e3)) + ' KB' : (n / 1e6).toFixed(1) + ' MB');

  // ---- Import ----
  const setLoading = (on, msg) => { $('import').classList.toggle('loading', on); if (msg != null) { $('status').textContent = msg; $('status').classList.remove('error'); } };
  const fail = (msg) => { if (data) toast(msg, 9000); else { $('import').style.visibility = 'visible'; setLoading(false); $('status').textContent = msg; $('status').classList.add('error'); } };
  // sources: [{ name, text() }]. Parse everything first; only keep the copy once it parsed fine.
  // ---- GPS cleaning settings (Path lab), stretches you confirmed, and which Wi-Fi network is which place ----
  const readLS = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } };
  const writeLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const cleanOpts = () => ({ params: readLS('tl-clean', {}), trusted: readLS('tl-trust', []), placeWifi: readLS('tl-wifi', []) });
  function learnWifi(tl) {                                     // a stay on a Wi-Fi network teaches its place that network (scrambled code only)
    const list = readLS('tl-wifi', []); let changed = false;
    for (const it of tl) if (it.kind === 'stay' && it.wifi && it.t1 - it.t0 >= 20 * 60000) {
      let p = list.find((x) => TL.haversine([x.lat, x.lng], [it.lat, it.lng]) < 120);
      if (!p) { p = { lat: it.lat, lng: it.lng, hashes: [] }; list.push(p); }
      if (!p.hashes.includes(it.wifi)) { p.hashes = p.hashes.concat(it.wifi).slice(-5); changed = true; }
    }
    if (changed) writeLS('tl-wifi', list.slice(-200));
  }
  function reanalyze(msg) {                                    // same data, new settings
    if (!data) return;
    const fr = frac, d = curDay;
    start(data, TL.analyze(data, cleanOpts()));
    if (d != null && dayList.includes(d)) { showDay(d); seek(fr); }
    if (msg) toast(msg, 2500);
  }

  async function loadFromSources(sources, save) {
    const merged = { visits: [], trips: [], points: [], hints: [] }, keep = [];
    setLoading(true, '');
    try {
      for (const f of sources) {
        $('status').textContent = 'Reading ' + f.name + '…';
        const json = JSON.parse(await f.text());
        const d = TL.parseTimeline(json);
        // concat, not push(...arr): spreading a huge array overflows the call stack.
        merged.visits = merged.visits.concat(d.visits); merged.trips = merged.trips.concat(d.trips); merged.points = merged.points.concat(d.points); merged.hints = merged.hints.concat(d.hints);
        if (save && !f.ephemeral) keep.push({ name: f.name, text: JSON.stringify(slim(json)) });
      }
    } catch (err) {
      // Show where it failed (first stack frames only; no file contents) to make problems diagnosable.
      const where = String(err.stack || '').split('\n').slice(1, 3).map((x) => x.trim().replace(/^at /, '').slice(0, 80)).join(' | ');
      fail('Could not read file: ' + err.message + (where ? ' [' + where + ']' : ''));
      return false;
    }
    let tl;
    try { $('status').textContent = 'Analyzing your movements…'; await new Promise((r) => setTimeout(r, 30)); tl = TL.analyze(merged, cleanOpts()); }
    catch (err) { fail('Could not analyse the data: ' + err.message); return false; }
    if (!tl.length) {                                          // nothing to show (yet): say so, and do not save a copy that shows nothing
      if (data) toast('No trips or stops found in that data.', 4000);
      else { setLoading(false, NATIVE ? 'Recording is on. Your first trip appears here after you start moving.' : 'No trips or stops found in this file.'); $('import').style.visibility = 'visible'; }
      return false;
    }
    let res = null;
    if (save && keep.length) {
      res = await saveFiles(keep);
      if (res.ok) { savedMeta = { size: res.size, where: res.where }; saveErr = ''; if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); }
      else { savedMeta = null; saveErr = res.error; }
    }
    try { start(merged, tl); }
    catch (err) { fail('Could not show the data: ' + err.message); return false; }
    if (res) toast(res.ok ? 'Saved on this phone · ' + mb(res.size) : "Couldn't save a copy: " + res.error, res.ok ? 3500 : 9000);
    return true;
  }
  $('pick').onclick = () => $('file').click();
  $('file').onchange = (e) => {
    const files = [...e.target.files];
    e.target.value = '';                                     // allow picking the same file again later
    if (files.length) { const srcs = files.map((f) => ({ name: f.name, text: () => f.text() })); if (NATIVE && nativeStatus && nativeStatus.fixes > 0) srcs.push(nativeSource()); loadFromSources(srcs, true); }
  };

  function start(d, tl) {
    d.visits.sort((a, b) => a.start - b.start); d.trips.sort((a, b) => a.start - b.start);
    const first = !data;
    if (map) { stop(); map.remove(); map = null; }           // "Change file" / new recordings while the app is open
    data = d; timeline = tl || TL.analyze(d, cleanOpts()); places = TL.clusterPlaces(timeline); loadPhone(); learnWifi(timeline);
    $('import').style.display = 'none';
    $('app').style.display = 'flex';
    initMap(); initDays(); renderStats();
    if (first) document.querySelector('nav button').click();   // only the first time: a refresh keeps you where you were
    keepAwake(); scheduleAsk();
  }

  // ---- Tabs ----
  document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => {
    document.body.classList.toggle('on-stats', b.dataset.v === 'stats');
    document.querySelectorAll('nav button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', String(x === b)); });
    $('mapView').style.display = b.dataset.v === 'map' ? 'block' : 'none';
    $('statsView').style.display = b.dataset.v === 'stats' ? 'block' : 'none';
    syncLoc();
    if (b.dataset.v === 'stats') osmInfo();
    if (b.dataset.v === 'map') { map.invalidateSize(); if (scenes.items.length) seek(frac); if (live) { setFollow(true); flyMe(); } }   // re-frame the camera: it was sized while hidden
  }));

  // ---- Map & replay ----
  function initMap() {
    map = L.map('map', { zoomControl: false, zoomSnap: 0 });
    // Always something to look at: a coarse, stretched layer sits under the sharp one, so a tile that is still loading (or failed)
    // shows the blurry map instead of black. The sharp layer loads while moving, keeps a wide margin and retries failed tiles.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, maxNativeZoom: 12, zIndex: 1, keepBuffer: 4, updateWhenIdle: true }).addTo(map);
    const sharp = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap', zIndex: 2, updateWhenIdle: false, updateInterval: 100, keepBuffer: 8 }).addTo(map);
    sharp.on('tileerror', (e) => { const t = e.tile; if (t && !t.__retry) { t.__retry = 1; const u = t.src; setTimeout(() => { t.src = u + (u.includes('?') ? '&' : '?') + 'r=1'; }, 1500); } });
    dayLayer = L.layerGroup().addTo(map);
    // Background: the cleaned places and routes (not the raw, noisy fixes), drawn on a canvas and capped at ~3k points.
    const all = [];
    for (const it of timeline) { if (it.kind === 'stay') all.push([it.lat, it.lng]); else for (const p of it.path) all.push(p); }
    const step = Math.max(1, Math.ceil(all.length / 3000));
    const canvas = L.canvas({ padding: 0.5 });
    for (let i = 0; i < all.length; i += step) L.circleMarker(all[i], { renderer: canvas, radius: 3, stroke: false, fillColor: '#38bdf8', fillOpacity: 0.25, interactive: false }).addTo(map);
    if (all.length) {
      let a = 90, b = 180, c = -90, d = -180;   // bounds without spreading into Math.min/max
      for (const p of all) { if (p[0] < a) a = p[0]; if (p[0] > c) c = p[0]; if (p[1] < b) b = p[1]; if (p[1] > d) d = p[1]; }
      map.fitBounds([[a, b], [c, d]], { padding: [20, 20] });
    } else map.setView([0, 0], 2);
    initMe();
  }

  // ---- Live location (blue dot, like Google Maps) ----
  // "Live" is the default state: the map follows you. Pressing play, scrubbing or choosing a day switches to replay;
  // the locate button comes back. Dragging or pinching the map pauses following and it resumes by itself after 20 s.
  let me = null, meDot = null, meAcc = null, meWatch = null, meDenied = false;
  let live = true, follow = true, resumeT = 0, progUntil = 0, followZoom = 17, liveTimer = 0;
  function initMe() {
    meDot = meAcc = null;
    map.on('dragstart zoomstart', userMoved);
    map.on('zoomend', () => { if (live && Date.now() > progUntil) followZoom = map.getZoom(); });
    if (me) drawMe();
    syncLoc();
    clearInterval(liveTimer); liveTimer = setInterval(() => { if (live && data) renderLive(); }, 15000);
    setFollow(follow);
    if (live) renderLive();
  }
  function userMoved() {
    if (!live || Date.now() < progUntil) return;
    setFollow(false);
    clearTimeout(resumeT);
    resumeT = setTimeout(() => { if (live && !playing && !document.hidden) { setFollow(true); flyMe(); } }, 20000);
  }
  function setFollow(on) {
    follow = on;
    const b = $('locate'), act = on && live;
    b.classList.toggle('on', act); b.setAttribute('aria-pressed', String(act));
    b.setAttribute('aria-label', act ? 'Following your location' : 'Show my location');
  }
  function drawMe() {
    if (!map || !me) return;
    const ll = [me.lat, me.lng];
    if (!meDot) {
      meAcc = L.circle(ll, { radius: me.acc, stroke: false, fillColor: '#3b82f6', fillOpacity: 0.14, interactive: false }).addTo(map);
      meDot = L.marker(ll, { icon: L.divIcon({ className: 'me', html: '<i class="mepulse"></i><i class="medot"></i>', iconSize: [22, 22] }), interactive: false, keyboard: false, zIndexOffset: 500 }).addTo(map);
    } else { meDot.setLatLng(ll); meAcc.setLatLng(ll); meAcc.setRadius(me.acc); }
    if (live && follow) flyMe();
    if (live) renderLive();
  }
  // Centre on you (keeps the zoom you chose, street level by default). Every move is ours, so it must not count as a drag.
  function flyMe() {
    if (!map || !me || !live) return;
    progUntil = Date.now() + 1000;
    map.invalidateSize();
    map.setView([me.lat, me.lng], Math.min(19, Math.max(14, followZoom)), { animate: true, duration: 0.7 });
  }
  const nearPlace = () => { if (!me) return null; let best = null, bd = 120; for (const p of places) { const d = TL.haversine([me.lat, me.lng], [p.lat, p.lng]); if (d < bd) { bd = d; best = p; } } return best; };
  function renderLive() {
    if (!live) return;
    const np = nearPlace();
    setHudPhone('');
    $('hudDay').textContent = 'Now';
    updateHudEdit(np ? { kind: 'stay', place: np } : { kind: 'move' });
    const nm = np ? (placeLabelText(np) || 'Unnamed place') : '';
    setHud(clock(Date.now()), !me ? (meDenied ? 'Location is off' : 'Finding you…') : nm ? 'You are at ' + nm : 'You are here', 'pin', '#3b82f6', me && np ? [np.lat, np.lng] : null);
  }
  function goLive() {
    stop(); live = true; hudKey = ''; setFollow(true);
    if (marker) { const el = marker.getElement(); if (el) el.style.visibility = 'hidden'; }
    if (curDay != null) $('hudDay').textContent = 'Now';
    if (me) flyMe(); else { meDenied = false; syncLoc(); toast('Finding your location…', 2500); }
    renderLive();
  }
  function leaveLive() {
    if (!live) return;
    live = false; clearTimeout(resumeT); setFollow(false); hudKey = '';
    if (marker) { const el = marker.getElement(); if (el) el.style.visibility = ''; }
    if (curDay != null) $('hudDay').textContent = dayLabel(curDay, { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function syncLoc() {
    const want = !!(map && navigator.geolocation && document.visibilityState === 'visible' && !document.body.classList.contains('on-stats'));
    if (!want) { if (meWatch != null) { navigator.geolocation.clearWatch(meWatch); meWatch = null; } return; }
    if (meWatch != null) return;
    try {
      meWatch = navigator.geolocation.watchPosition((p) => {
        meDenied = false;
        me = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.max(p.coords.accuracy || 30, 8) };
        drawMe();
      }, (err) => {
        if (err && err.code === 1) {                             // denied: stop and say so
          if (meWatch != null) { navigator.geolocation.clearWatch(meWatch); meWatch = null; }
          if (!meDenied) { meDenied = true; if (meAsked) toast('Allow location to see where you are on the map.', 5000); if (live) renderLive(); }   // the HUD already says it; a toast only when you asked
        } else if (meWatch != null) {                            // a temporary gap (no signal, timeout): start a fresh watch shortly
          navigator.geolocation.clearWatch(meWatch); meWatch = null;
          setTimeout(syncLoc, 1000);
        }
      }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
    } catch (e) { meWatch = null; }
  }
  document.addEventListener('visibilitychange', () => { syncLoc(); if (document.visibilityState === 'visible' && live) { setFollow(true); flyMe(); } });
  let meAsked = false;
  $('locate').onclick = () => { buzz(); meAsked = true; if (meDenied) toast('Allow location to see where you are on the map.', 5000); goLive(); };

  const dayKey = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  let dayList = [], dayTrips = new Map(), curDay = null, speed = 1, autoNext = true, keepOn = true, wake = null;
  try { autoNext = localStorage.getItem('tl-autonext') !== '0'; keepOn = localStorage.getItem('tl-awake') !== '0'; } catch (e) {}
  const buzz = () => { try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) {} };
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const dayLabel = (d, o) => new Date(d).toLocaleDateString(undefined, o || { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  function initDays() {
    const days = new Set(), trips = new Map();
    let inTrip = false;
    for (const it of timeline) {
      if (it.kind === 'stay') {
        for (let d = dayKey(it.t0), n = 0; d < it.t1 && n < 31; d = dayKey(d + DAY + 7200000), n++) days.add(d);
        inTrip = false;
      } else {
        days.add(dayKey(it.t0));
        if (!inTrip) trips.set(dayKey(it.t0), (trips.get(dayKey(it.t0)) || 0) + 1);   // consecutive legs = one trip
        inTrip = true;
      }
    }
    const sorted = [...days].sort((a, b) => a - b), nTrips = (d) => trips.get(d) || 0, withTrips = sorted.filter((d) => nTrips(d) > 0);
    dayList = withTrips.length ? withTrips : sorted;            // days without a trip have nothing to replay
    dayTrips = trips;
    const multiYear = new Set(dayList.map((d) => new Date(d).getFullYear())).size > 1, optLabel = (d) => dayLabel(d, multiYear ? undefined : { weekday: 'short', day: 'numeric', month: 'short' });
    $('day').innerHTML = dayList.map((d) => `<option value="${d}">${optLabel(d)}${nTrips(d) ? ' · ' + nTrips(d) + (nTrips(d) > 1 ? ' trips' : ' trip') : ''}</option>`).join('');
    $('day').onchange = () => { leaveLive(); const was = playing; showDay(+$('day').value); if (was) startPlay(); };
    let was = NaN; try { was = Number(sessionStorage.getItem('tl-day')); } catch (e) {}
    if (dayList.length) showDay(dayList.includes(was) ? was : dayList[dayList.length - 1]);
  }
  // Move to another day (the next one when a day finishes) and optionally keep playing.
  function goDay(delta, play) {
    const i = dayList.indexOf(curDay) + delta;
    if (i < 0 || i >= dayList.length) return false;
    showDay(dayList[i]); banner(dayList[i]);
    if (play) startPlay();
    return true;
  }
  function banner(d) {
    const el = $('dayBanner'), n = dayTrips.get(d) || 0;
    el.querySelector('b').textContent = dayLabel(d, { weekday: 'long', day: 'numeric', month: 'long' });
    el.querySelector('span').textContent = n ? n + (n > 1 ? ' trips' : ' trip') + ' · ' + dayLabel(d, { year: 'numeric' }) : dayLabel(d, { year: 'numeric' });
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  }
  $('prevDay').onclick = () => { buzz(); leaveLive(); const was = playing; goDay(-1, was); };
  $('nextDay').onclick = () => { buzz(); leaveLive(); const was = playing; goDay(1, was); };
  $('speedSeg').querySelectorAll('button').forEach((b) => (b.onclick = () => {
    speed = +b.dataset.speed; buzz();
    $('speedSeg').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  }));

  // ---- Keep the screen on while the app is open ----
  async function keepAwake() {
    if (NATIVE) { try { NATIVE.keepScreenOn(!!keepOn); } catch (e) {} wakeInfo(); return; }
    if (!keepOn || wake || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; wakeInfo(); }); } catch (e) { wake = null; }
    wakeInfo();
  }
  function releaseAwake() { if (NATIVE) { try { NATIVE.keepScreenOn(false); } catch (e) {} wakeInfo(); return; } if (wake) { try { wake.release(); } catch (e) {} wake = null; } wakeInfo(); }
  function wakeInfo() {
    const el = $('awakeNote'); if (!el) return;
    el.textContent = NATIVE ? (keepOn ? 'Active. The screen will not dim while the app is open.' : 'Off. The screen may dim.') : !('wakeLock' in navigator) ? 'Not supported by this browser.' : !keepOn ? 'Off. The screen may dim.' : wake ? 'Active. The screen will not dim.' : 'On. Active while this page is visible.';
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && data) keepAwake(); });
  document.addEventListener('pointerdown', () => { if (data) keepAwake(); }, { passive: true });   // some browsers only grant it after a touch

  // ---- Scenes: a day is an alternating list of stays and trips (a trip = one or more legs, each with its own mode) ----
  // The replay runs on its own "animation clock" (ms): a trip takes 4.5-14 s depending on distance, a stay is a ~2 s
  // fast-forward of the real clock. Everything on screen is a pure function of that clock.
  const MIN_STAY = 2 * 60000, STAY_MS = 2200, Z_IN = 17;
  let zoomBias = 0, scenes = { items: [], V: 0 }, frac = 0, heading = 0, playing = false, lastTs = 0, raf = 0;
  let trail, trailGlow, trailColor = '', carEl, badgeEl, badgeMode = '', hudKey = '', litKey = null;

  const sm = (x) => x * x * (3 - 2 * x);                                  // smoothstep
  const win = (a, b, x) => sm(Math.min(1, Math.max(0, (x - a) / (b - a))));
  const easeMove = (f) => f + 0.75 * (sm(f) - f);                         // slow -> fast -> slow
  const easeInv = (y) => { let lo = 0, hi = 1; for (let i = 0; i < 32; i++) { const m = (lo + hi) / 2; if (easeMove(m) < y) lo = m; else hi = m; } return (lo + hi) / 2; };
  const fmtDur = (ms) => { const m = Math.round(ms / 60000), h = Math.floor(m / 60); return h ? h + ' h' + (m % 60 ? ' ' + (m % 60) + ' m' : '') : m + ' m'; };
  const shortDur = (ms) => ms >= 3.6e6 ? (ms / 3.6e6).toFixed(1).replace(/\.0$/, '') + 'h' : Math.round(ms / 60000) + 'm';
  const fmtDist = (d) => (d >= 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m');
  const clock = (t) => { const d = new Date(t); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };   // always 24-hour
  function bearing(a, b) {
    const dy = b[0] - a[0], dx = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) * Math.PI) / 360);
    return dx === 0 && dy === 0 ? null : ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  }

  // A leg from the analysis, with the geometry helpers the animation needs.
  function moveScene(m) {
    const cum = [0];
    for (let i = 1; i < m.path.length; i++) cum.push(cum[i - 1] + TL.haversine(m.path[i - 1], m.path[i]));
    return { kind: 'move', t0: m.t0, t1: m.t1, mode: m.mode, uncertain: !!m.uncertain, reason: m.reason || '', color: MODE_COLOR[m.mode] || MODE_COLOR.other, med: m.med, path: m.path, times: m.times, cum, len: cum[cum.length - 1], bounds: L.latLngBounds(m.path) };
  }
  // Point (and segment index) at a distance along a leg; binary search over cumulative distance.
  function pointAt(s, d) {
    if (s.len <= 0) return { ll: s.path[0], k: 1 };
    d = Math.max(0, Math.min(s.len, d));
    let lo = 1, hi = s.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (s.cum[mid] < d) lo = mid + 1; else hi = mid; }
    const a = s.path[lo - 1], b = s.path[lo], u = (d - s.cum[lo - 1]) / (s.cum[lo] - s.cum[lo - 1] || 1);
    return { ll: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], k: lo, u };
  }
  // Real clock time at a distance along a leg (follows the recorded stop-and-go instead of assuming a constant pace).
  function timeAtDist(s, d) {
    if (s.len <= 0 || s.path.length < 2) return s.t0;
    const { k, u } = pointAt(s, d);
    return s.times[k - 1] + (s.times[k] - s.times[k - 1]) * u;
  }
  const startBearing = (s) => { const d = Math.max(25, s.len * 0.02); return bearing(s.path[0], pointAt(s, d).ll); };
  const endBearing = (s) => { const d = Math.max(25, s.len * 0.02); return bearing(pointAt(s, s.len - d).ll, s.path[s.path.length - 1]); };

  function buildScenes(d) {
    const end = d + DAY, raw = [];
    for (const it of timeline) {
      if (it.t1 <= d) continue;
      if (it.t0 >= end) break;
      if (it.kind === 'stay') {
        const t0 = Math.max(it.t0, d), t1 = Math.min(it.t1, end);
        if (t1 - t0 >= MIN_STAY) raw.push({ kind: 'stay', t0, t1, lat: it.lat, lng: it.lng, name: stayName(it), place: it.place, nd: it.nd });
      } else if (it.t0 >= d) raw.push(moveScene(it));          // a leg belongs to the day it starts
    }
    // Consecutive legs form one trip: one camera move and one slow-fast-slow speed profile, whatever the modes.
    const out = []; let off = 0;
    for (let i = 0; i < raw.length;) {
      if (raw[i].kind === 'stay') { const s = raw[i++]; s.vlen = STAY_MS; s.v0 = off; off += STAY_MS; out.push(s); continue; }
      const legs = []; while (i < raw.length && raw[i].kind === 'move') legs.push(raw[i++]);
      const len = legs.reduce((a, l) => a + l.len, 0), g = { legs, len, v0: off, vlen: len < 30 ? 1500 : Math.min(14000, 4500 + 1600 * Math.sqrt(len / 1000)), bounds: legs[0].bounds };
      let g0 = 0;
      for (const l of legs) {
        g.bounds = g.bounds.extend(l.bounds);
        l.group = g; l.g0 = g0;
        const ta = len > 0 ? easeInv(g0 / len) : 0, tb = len > 0 ? easeInv((g0 + l.len) / len) : 1;
        l.v0 = g.v0 + ta * g.vlen; l.vlen = Math.max(1, (tb - ta) * g.vlen);       // the bar follows the eased progress
        g0 += l.len; out.push(l);
      }
      off += g.vlen;
    }
    out.forEach((s, i) => { s.prev = out[i - 1]; s.next = out[i + 1]; });
    return { items: out, V: off };
  }

  function locate(v) {
    let s = scenes.items[0];
    for (const it of scenes.items) { if (it.v0 <= v) s = it; else break; }
    if (s.kind === 'stay') { const f = sm(Math.min(1, Math.max(0, (v - s.v0) / s.vlen))); return { s, f, p: 0, t: s.t0 + (s.t1 - s.t0) * f, ll: [s.lat, s.lng] }; }
    const g = s.group, p = easeMove(Math.min(1, Math.max(0, (v - g.v0) / g.vlen))), dg = g.len * p, d = Math.max(0, Math.min(s.len, dg - s.g0));
    const cur = pointAt(s, d), step = Math.max(25, s.len * 0.02);
    const bear = s.len > 0 ? bearing(pointAt(s, d - step / 2).ll, pointAt(s, d + step).ll) : null;
    return { s, f: p, p, t: timeAtDist(s, d), ll: cur.ll, k: cur.k, bear, left: Math.max(0, g.len - dg) };
  }

  // Camera: zoomed in on the traveller by default; during a trip the view grows from "street level around the
  // marker" to "the whole trip", holds, then shrinks back. Interpolating the view *box* (not zoom and centre
  // separately) keeps the marker inside the frame. The same easing drives the speed along the trip.
  function cameraFor(s, p, carLL) {
    if (s.kind === 'stay') return { center: [s.lat, s.lng], zoom: Z_IN };
    const g = s.group, size = map.getSize(), sx = Math.max(50, size.x - 70), sy = Math.max(50, size.y - 90);
    if (!g.tb) {                                    // trip box in pixels at street zoom
      const a = map.project(g.bounds.getSouthWest(), Z_IN), b = map.project(g.bounds.getNorthEast(), Z_IN);
      g.tb = { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) };
    }
    const c = map.project(carLL, Z_IN), w = win(0, 0.2, p) * (1 - win(0.8, 1, p)), lerp = (a, b) => a + (b - a) * w;
    const x0 = lerp(c.x - sx / 2, Math.min(c.x - sx / 2, g.tb.x0)), x1 = lerp(c.x + sx / 2, Math.max(c.x + sx / 2, g.tb.x1));
    const y0 = lerp(c.y - sy / 2, Math.min(c.y - sy / 2, g.tb.y0)), y1 = lerp(c.y + sy / 2, Math.max(c.y + sy / 2, g.tb.y1));
    const zoom = Math.max(2, Z_IN - Math.log2(Math.max((x1 - x0) / sx, (y1 - y0) / sy)));
    const ctr = map.unproject(L.point((x0 + x1) / 2, (y0 + y1) / 2), Z_IN);
    return { center: [ctr.lat, ctr.lng], zoom };
  }

  const CAR = '<div class="ring"></div><div class="dot"></div><div class="badge"></div><div class="carwrap"><svg viewBox="0 0 24 44" width="30" height="55">' +
    '<rect x="0.5" y="8" width="3" height="9" rx="1.5" fill="#0b1220"/><rect x="20.5" y="8" width="3" height="9" rx="1.5" fill="#0b1220"/>' +
    '<rect x="0.5" y="27" width="3" height="9" rx="1.5" fill="#0b1220"/><rect x="20.5" y="27" width="3" height="9" rx="1.5" fill="#0b1220"/>' +
    '<rect x="3" y="2" width="18" height="40" rx="8" fill="#5cbcf6" stroke="#fff" stroke-width="2"/>' +
    '<rect x="6" y="10" width="12" height="9" rx="2.5" fill="#0b1220" opacity=".85"/><rect x="7" y="29" width="10" height="6" rx="2" fill="#0b1220" opacity=".6"/>' +
    '<rect x="5.5" y="3.5" width="3.5" height="2" rx="1" fill="#fde68a"/><rect x="15" y="3.5" width="3.5" height="2" rx="1" fill="#fde68a"/></svg></div>';

  function showDay(d) {
    stop(); map.invalidateSize(); dayLayer.clearLayers(); hudKey = ''; trailColor = ''; heading = 0; badgeMode = ''; litKey = null; curDay = d; hudPlace = null;
    try { sessionStorage.setItem('tl-day', String(d)); } catch (e) {}
    $('day').value = String(d);
    $('hudDay').textContent = live ? 'Now' : dayLabel(d, { weekday: 'short', day: 'numeric', month: 'short' });
    const idx = dayList.indexOf(d); $('prevDay').disabled = idx <= 0; $('nextDay').disabled = idx < 0 || idx >= dayList.length - 1;
    scenes = buildScenes(d);
    const items = scenes.items, byMode = {};
    let still = 0;
    for (const s of items) {
      if (s.kind === 'move') {
        byMode[s.mode] = (byMode[s.mode] || 0) + s.len;
        s.line = L.polyline(s.path, { color: s.color, weight: 3, opacity: 0.4, dashArray: s.uncertain ? '2 8' : null, interactive: false }).addTo(dayLayer);
      } else {
        still += s.t1 - s.t0;
        const r = Math.min(16, 6 + 3 * Math.sqrt((s.t1 - s.t0) / 3.6e6));            // bigger circle = longer stay
        L.circleMarker([s.lat, s.lng], { radius: r, color: '#e2e8f0', weight: 1.5, fillColor: '#e2e8f0', fillOpacity: 0.16 })
          .bindTooltip(esc(s.name) + ' · ' + clock(s.t0) + '–' + clock(s.t1) + ' (' + fmtDur(s.t1 - s.t0) + ')' + (phoneOn() && s.t1 > phoneSince ? ' · ' + fmtDur(phoneMs(Math.max(s.t0, phoneSince), s.t1)) + ' on phone' : '')).addTo(dayLayer);
      }
    }
    trailGlow = L.polyline([], { weight: 13, opacity: 0.22, lineCap: 'round', interactive: false }).addTo(dayLayer);
    trail = L.polyline([], { weight: 5, opacity: 1, lineCap: 'round', interactive: false }).addTo(dayLayer);
    marker = L.marker([0, 0], { icon: L.divIcon({ className: 'live', html: CAR, iconSize: [30, 30] }), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(dayLayer);
    if (live) marker.getElement().style.visibility = 'hidden';
    carEl = marker.getElement().querySelector('.carwrap'); badgeEl = marker.getElement().querySelector('.badge');
    renderBar(items, byMode, still);
    $('scrub').value = 0; seek(0);
    setTimeout(() => { if (curDay === d && !playing) refineDay(d); }, 400);
  }

  // Timeline bar: coloured blocks = movement by mode, hatched blocks = time spent still (with its duration).
  const chip = (icon, color, text) => `<span class="chip" style="--c:${color}">${svg(icon)}<b>${text}</b></span>`;
  function renderBar(items, byMode, still) {
    const V = scenes.V || 1, px = $('bar').clientWidth || 340;
    $('bar').innerHTML = items.map((s) => {
      const left = (s.v0 / V) * 100, w = (s.vlen / V) * 100;
      return s.kind === 'move'
        ? `<div class="seg" style="left:${left}%;width:${w}%;background:${s.color}"></div>`
        : `<div class="seg still" style="left:${left}%;width:${w}%">${(s.vlen / V) * px >= 24 ? '<span>' + shortDur(s.t1 - s.t0) + '</span>' : ''}</div>`;
    }).join('');
    let stillCov = 0, onPhone = 0;
    if (phoneOn()) for (const s of items) if (s.kind === 'stay' && s.t1 > phoneSince) { const a = Math.max(s.t0, phoneSince); stillCov += s.t1 - a; onPhone += phoneMs(a, s.t1); }
    $('summary').innerHTML = !items.length ? '' : chip('clock', 'var(--muted)', fmtDur(still) + ' still') + (stillCov > 0 ? chip('phone', '#a78bfa', fmtDur(onPhone) + ' on phone') : '') +
      Object.entries(byMode).sort((a, b) => b[1] - a[1]).map(([m, d]) => chip(MODE_ICON[m], MODE_COLOR[m], fmtDist(d))).join('');
  }

  function seek(fr) { try { seekInner(fr); } catch (e) { console.error(e); setHud('Replay error', String(e.message).slice(0, 60)); } }
  function seekInner(fr) {
    frac = fr;
    $('fill').style.width = fr * 100 + '%'; $('playhead').style.left = fr * 100 + '%';
    if (live) { renderLive(); return; }                         // live: the map belongs to you, the replay is only a day picker
    if (!scenes.items.length) { setHud('--:--', 'No trips on this day'); return; }
    const { s, f, p, t, ll, k, bear, left } = locate(fr * scenes.V);
    const cam = cameraFor(s, p, ll);
    // pinch while playing = zoom bias; zooming in is only applied while parked (on a trip the car must stay in frame)
    const z = Math.max(2, Math.min(19, cam.zoom + (s.kind === 'stay' ? zoomBias : Math.min(0, zoomBias))));
    map.setView(cam.center, z, { animate: false });
    marker.setLatLng(ll);
    // Routes of the current trip light up as they are driven; the progressive trail follows the current leg.
    const grp = s.kind === 'move' ? s.group : s.prev && s.prev.kind === 'move' ? s.prev.group : null, key = (grp ? scenes.items.indexOf(grp.legs[0]) : -1) + ':' + (s.kind === 'move' ? scenes.items.indexOf(s) : 'x');
    if (key !== litKey) { litKey = key; for (const it of scenes.items) if (it.kind === 'move') { const on = grp && it.group === grp && (s.kind === 'stay' || it.g0 <= s.g0); it.line.setStyle({ opacity: on ? 0.85 : 0.4 }); } }
    const src = s.kind === 'move' ? s : s.prev && s.prev.kind === 'move' ? s.prev : null;
    const color = src ? src.color : '';
    if (color !== trailColor) { trailColor = color; if (color) { trail.setStyle({ color }); trailGlow.setStyle({ color }); } }
    const pts = !src ? [] : s.kind === 'move' ? src.path.slice(0, k).concat([ll]) : src.path;
    trail.setLatLngs(pts); trailGlow.setLatLngs(pts);
    // heading: face the direction of travel; while parked, turn toward the next route
    const target = s.kind === 'move' ? bear : s.next && s.next.kind === 'move' ? startBearing(s.next) : s.prev && s.prev.kind === 'move' ? endBearing(s.prev) : null;
    if (target != null) heading = (heading + (((target - heading + 540) % 360) - 180) * 0.3 + 360) % 360;
    if (carEl) carEl.style.transform = 'rotate(' + heading.toFixed(1) + 'deg)';
    // marker: a car only while driving, a mode badge for other movement, a dot (pulsing when parked) otherwise
    const mode = s.kind === 'move' ? s.mode : '', el = marker.getElement();
    if (el) { el.classList.toggle('stay', s.kind === 'stay'); el.classList.toggle('drive', mode === 'drive'); el.classList.toggle('badge-on', !!mode && mode !== 'drive' && mode !== 'other'); }
    if (mode !== badgeMode) { badgeMode = mode; if (badgeEl) { badgeEl.innerHTML = mode ? svg(MODE_ICON[mode]) : ''; badgeEl.style.setProperty('--c', MODE_COLOR[mode] || 'var(--accent)'); } }
    updateHudEdit(s);
    setHudPhone(s.kind === 'stay' && phoneOn() && s.t1 > phoneSince ? fmtDur(phoneMs(Math.max(s.t0, phoneSince), t)) + ' on phone' : '');
    const sub = s.kind === 'stay' ? s.name + ' · ' + fmtDur((s.t1 - s.t0) * f)
      : s.uncertain ? (s.reason === 'disturbed' ? 'GPS disturbed · position ignored' : 'Travelled · no data in between') : MODE_NAME[mode] + ' · ' + Math.round(s.med * 3.6) + ' km/h · ' + (left / 1000).toFixed(1) + ' km left';
    setHud(clock(t), sub, s.kind === 'stay' ? 'pin' : MODE_ICON[mode], s.kind === 'stay' ? 'var(--accent)' : MODE_COLOR[mode], s.kind === 'stay' ? [s.lat, s.lng] : null);
  }
  let phoneTxt = null;
  function setHudPhone(txt) { if (txt === phoneTxt) return; phoneTxt = txt; const el = $('hudPhone'); el.hidden = !txt; el.innerHTML = txt ? svg('phone') + '<span>' + esc(txt) + '</span>' : ''; }
  let thumbKey = '';
  function setHud(a, b, icon, color, thumb) {
    const tk = thumb ? thumb[0].toFixed(5) + ',' + thumb[1].toFixed(5) : '';
    if (tk !== thumbKey) { thumbKey = tk; const el = $('hudThumb'); el.innerHTML = thumb ? placeThumb(thumb[0], thumb[1], 150, 64) : ''; el.hidden = !thumb; }
    const key = a + '|' + b + '|' + (icon || '');
    if (key === hudKey) return;
    hudKey = key; $('hudTime').textContent = a; $('hudSub').textContent = b;
    const hi = $('hudIcon'); hi.innerHTML = icon ? svg(icon) : ''; hi.style.setProperty('--c', color || 'var(--accent)'); hi.style.display = icon ? 'grid' : 'none';
  }

  // ---- Playback ----
  $('scrub').oninput = () => { leaveLive(); seek($('scrub').value / 100000); };
  function setPlayUi() { const b = $('play'); b.innerHTML = svg(playing ? 'pause' : 'play', 'fill'); b.setAttribute('aria-label', playing ? 'Pause' : 'Play'); }
  // While the replay plays the camera is driven by the animation, so the map ignores touches and the replay keeps going.
  // Pause it and the map is free to pan and zoom again.
  function lockMap(on) { $('map').classList.toggle('locked', on); if (!map) return; for (const h of ['dragging', 'touchZoom', 'doubleClickZoom', 'scrollWheelZoom', 'boxZoom', 'keyboard', 'tapHold']) if (map[h]) map[h][on ? 'disable' : 'enable'](); }
  function stop() { playing = false; cancelAnimationFrame(raf); setPlayUi(); lockMap(false); }
  function startPlay() {
    if (!scenes.items.length) return;
    playing = true; setPlayUi(); lockMap(true); lastTs = performance.now(); cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); keepAwake();
  }
  function tick(ts) {
    if (!playing) return;
    const dt = Math.min(80, ts - lastTs); lastTs = ts;
    seek(Math.min(1, frac + (dt * speed) / scenes.V));
    $('scrub').value = Math.round(frac * 100000);
    if (frac >= 1) {                                          // day finished: go on to the next day, never replay the same one
      if (autoNext && goDay(1, true)) return;
      stop(); if (dayList.length > 1) toast('That was the last day.');
      return;
    }
    raf = requestAnimationFrame(tick);
  }
  $('play').onclick = () => {
    buzz();
    if (playing) return stop();
    if (!scenes.items.length) return;
    leaveLive();
    if (frac >= 1 && goDay(1, true)) return;                  // pressing play on a finished day continues with the next one
    if (frac >= 1) frac = 0;
    startPlay();
  };

  // ---- Gestures (what a swipe, pinch or tap does depends on the state) ----
  //  Live (following you)      : the map is yours: drag / pinch / double-tap as usual. Dragging pauses following (it resumes after 20 s or via the locate button).
  //  Replay playing (map locked): tap = pause, double-tap = reset zoom, pinch = zoom out/in, swipe left/right = next/previous day, swipe up/down = faster/slower.
  //  Replay paused             : the map is free again (drag, pinch, double-tap).
  //  Bottom panel              : swipe left/right = next/previous day.   Top bar: swipe left/right = Insights / Replay.
  //  Insights                  : swipe right = back to Replay.           Question sheet: swipe down = "Not now".
  const SPEEDS = [1, 2, 4];
  function setSpeed(i) {
    i = Math.max(0, Math.min(SPEEDS.length - 1, i)); const cur = SPEEDS.indexOf(speed);
    if (i === cur) { toast(i ? 'Fastest speed' : 'Slowest speed', 1200); return; }
    $('speedSeg').querySelectorAll('button')[i].click(); toast(SPEEDS[i] + '× speed', 1200);
  }
  function swipeDay(delta) {
    if (!dayList.length) return;
    const i = dayList.indexOf(curDay) + delta;
    if (i < 0 || i >= dayList.length) { toast(delta > 0 ? 'That is the last day.' : 'That is the first day.', 1600); return; }
    buzz(); leaveLive(); goDay(delta, playing);
  }
  function swipeOn(el, h, ok) {
    let x0 = 0, y0 = 0, t0 = 0, on = false;
    el.addEventListener('touchstart', (e) => { on = e.touches.length === 1 && (!ok || ok(e)); if (on) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now(); } }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (!on) return; on = false;
      const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
      if (Date.now() - t0 > 700) return;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.8) (dx < 0 ? h.left : h.right) && (dx < 0 ? h.left : h.right)();
      else if (Math.abs(dy) > 70 && Math.abs(dy) > Math.abs(dx) * 1.8) (dy < 0 ? h.up : h.down) && (dy < 0 ? h.up : h.down)();
    }, { passive: true });
    el.addEventListener('touchcancel', () => { on = false; }, { passive: true });
  }
  const notControl = (e) => !e.target.closest('#barwrap,select,.speed,button,input');
  const showTab = (v) => { const b = document.querySelector('nav button[data-v=' + v + ']'); if (b && !b.classList.contains('on')) b.click(); };
  swipeOn($('controls'), { left: () => swipeDay(1), right: () => swipeDay(-1) }, notControl);
  swipeOn($('topbar'), { left: () => showTab('stats'), right: () => showTab('map') });
  swipeOn($('statsView'), { right: () => showTab('map') }, (e) => !e.target.closest('input,select,[role=switch]'));
  swipeOn($('ask'), { down: () => { const b = $('askLater'); if (b && $('ask').querySelector('.card').scrollTop < 4) b.click(); } }, (e) => !e.target.closest('input'));

  (function mapGestures() {
    const el = $('map'), dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    let x0 = 0, y0 = 0, t0 = 0, pinch = null, multi = false, tapT = 0, lastTap = 0;
    el.addEventListener('touchstart', (e) => {
      if (!playing) return;
      if (e.touches.length >= 2) { pinch = { d: dist(e.touches), b: zoomBias }; multi = true; return; }
      multi = false; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (!playing || !pinch || e.touches.length < 2) return;
      zoomBias = Math.max(-3, Math.min(1.5, pinch.b + Math.log2(dist(e.touches) / pinch.d)));
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (e.touches.length) return;
      if (!playing || multi) { multi = false; pinch = null; return; }
      const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0, dt = Date.now() - t0;
      if (dt < 700 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.8) swipeDay(dx < 0 ? 1 : -1);
      else if (dt < 700 && Math.abs(dy) > 70 && Math.abs(dy) > Math.abs(dx) * 1.8) setSpeed(SPEEDS.indexOf(speed) + (dy < 0 ? 1 : -1));
      else if (Math.abs(dx) < 14 && Math.abs(dy) < 14 && dt < 320) {
        const now = Date.now();
        if (now - lastTap < 320) { clearTimeout(tapT); lastTap = 0; zoomBias = 0; toast('Zoom reset', 1200); }
        else { lastTap = now; clearTimeout(tapT); tapT = setTimeout(() => { if (playing) { buzz(); stop(); } }, 330); }
      }
    }, { passive: true });
  })();


  // ---- Path lab: the raw GPS, each fix's confidence, the likely path, and the settings behind them, live ----
  const LAB_PART = { prior: 'Starting point (how often GPS jumps here)', fit: 'Distance from the path the other fixes describe', turn: 'Turn / out-and-back', speed: 'Speed (could you get here and back?)', accel: 'Acceleration', signal: 'Signal quality', alt: 'Altitude', build: 'Buildings', fam: 'Usual route' };
  const LAB_WHY = { never: 'Ignored: a country you are never in (GPS interference).', abroad: 'Ignored: abroad, but too short or sudden to be a real trip.', wifi: 'Same Wi-Fi network: you were not moving, this fix wandered off.' };
  let lab = null, labFixes = null, labDataRef = null;
  const confColor = (c) => { const h = Math.round(120 * Math.max(0, Math.min(1, c))); return 'hsl(' + h + ',85%,52%)'; };
  function labAllFixes() {                                     // every fix of the loaded data, once per data set
    if (labDataRef !== data) { labDataRef = data; labFixes = TL.collectFixes(data).filter((f) => f.acc <= TL.CFG.maxAcc); }
    return labFixes;
  }
  function labDayFixes(d) {
    const all = labAllFixes(), a = d - 30 * 60000, b = d + DAY + 30 * 60000;
    let lo = 0, hi = all.length; while (lo < hi) { const m = (lo + hi) >> 1; if (all[m].t < a) lo = m + 1; else hi = m; }
    const out = []; for (let i = lo; i < all.length && all[i].t <= b; i++) out.push(all[i]);
    return out;
  }
  function openLab() {
    if (!data || curDay == null) return;
    stop(); leaveLive(); buzz();
    const saved = readLS('tl-clean', {});
    lab = { P: Object.assign({}, TL.cleanApi.DEFAULTS, saved), saved: JSON.stringify(saved), show: { raw: true, path: true, dots: true }, layer: L.layerGroup(), canvas: L.canvas({ padding: 0.5 }), sel: null };
    map.removeLayer(dayLayer); lab.layer.addTo(map);
    $('lab').hidden = false; document.body.classList.add('lab-open'); map.invalidateSize();
    renderLabPanel(); runLab(true);
    if (TL.osm && osmOn() && lab.res) {                         // buildings for this day, then decide again with them
      const L0 = lab, pts = []; for (let i = 0; i < lab.F.length; i++) if (!lab.res.still[i] && lab.res.route[i] && lab.res.c[i] >= lab.res.P.keep) pts.push(lab.res.route[i]);
      const st = $('labStats'); if (st && pts.length) st.textContent += ' · loading buildings…';
      TL.osm.indexFor(pts, { onError: () => {} }).then((idx) => { if (lab !== L0) return; lab.idx = idx; runLab(false); if (!idx && pts.length) { const e = $('labStats'); if (e) e.textContent += ' · no building data (offline?)'; } }).catch(() => {});
    }
  }
  function closeLab() {
    if (!lab) return;
    lab.layer.remove(); if (map.hasLayer(lab.canvas)) map.removeLayer(lab.canvas);   // also cancels a pending canvas redraw
    dayLayer.addTo(map); lab = null;
    $('lab').hidden = true; document.body.classList.remove('lab-open');
    map.invalidateSize(); seek(frac);
  }
  function runLab(fit) {
    if (!lab) return;
    const F = labDayFixes(curDay), t0 = performance.now();
    const today = dayKey(Date.now()) === curDay;
    const res = F.length ? TL.cleanApi.clean(F, { params: lab.P, trusted: readLS('tl-trust', []), placeWifi: readLS('tl-wifi', []), live: today && !!NATIVE, buildings: lab.idx || undefined }) : null;
    if (res && lab.idx) TL.osm.refinePath(res.route, lab.idx, res.still, res.P);
    lab.F = F; lab.res = res; lab.ms = performance.now() - t0;
    drawLab(fit); labStats();
  }
  function drawLab(fit) {
    const g = lab.layer; g.clearLayers();
    const F = lab.F, res = lab.res; if (!res) return;
    const raw = [], keepPath = [], tent = [];
    for (let i = 0; i < F.length; i++) {
      if (res.why[i] === 'never' || res.why[i] === 'abroad') continue;     // far away: not drawn on this map
      raw.push([F[i].lat, F[i].lng]);
      if (res.route[i] && res.c[i] >= res.P.keep) (i >= res.tentativeFrom ? tent : keepPath).push(res.route[i]);
    }
    if (tent.length && keepPath.length) tent.unshift(keepPath[keepPath.length - 1]);
    if (lab.show.raw) L.polyline(raw, { color: '#94a3b8', weight: 1.5, opacity: 0.7, interactive: false }).addTo(g);
    if (lab.show.path) {
      L.polyline(keepPath, { color: '#0b1220', weight: 7, opacity: 0.55, interactive: false }).addTo(g);
      L.polyline(keepPath, { color: '#5cbcf6', weight: 4, opacity: 1, interactive: false }).addTo(g);
      if (tent.length > 1) L.polyline(tent, { color: '#5cbcf6', weight: 4, opacity: 0.9, dashArray: '6 7', interactive: false }).addTo(g);
    }
    if (lab.show.dots) for (let i = 0; i < F.length; i++) {
      if (res.why[i] === 'never' || res.why[i] === 'abroad') continue;
      const m = L.circleMarker([F[i].lat, F[i].lng], { renderer: lab.canvas, radius: i === lab.sel ? 8 : 4.5, color: '#0b1220', weight: 1, fillColor: confColor(res.c[i]), fillOpacity: 0.95 });
      m.on('click', () => { lab.sel = i; drawLab(false); labDetail(i); });
      m.addTo(g);
    }
    if (fit && raw.length) map.fitBounds(L.latLngBounds(raw), { padding: [30, 30] });
  }
  function labStats() {
    const el = $('labStats'); if (!el || !lab.res) { if (el) el.textContent = 'No GPS fixes on this day.'; return; }
    const r = lab.res; let doubt = 0, ign = 0, low = 0;
    for (let i = 0; i < lab.F.length; i++) { if (r.why[i] === 'never' || r.why[i] === 'abroad') ign++; else if (r.c[i] < 0.5) doubt++; if (r.c[i] < r.P.keep) low++; }
    el.textContent = lab.F.length + ' fixes · ' + doubt + ' doubted' + (ign ? ' · ' + ign + ' ignored (impossible place)' : '') + ' · ' + low + ' left out' + (lab.idx ? ' · ' + lab.idx.buildings + ' buildings' : '') + ' · ' + Math.round(lab.ms) + ' ms';
  }
  function labDetail(i) {
    const el = $('labDetail'), r = lab.res, f = lab.F[i], parts = r.parts[i];
    const rows = parts ? Object.entries(parts).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).map(([k, v]) => `<li><span>${LAB_PART[k]}</span><b class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${v.toFixed(1)}</b></li>`).join('') : '';
    el.innerHTML = `<div class="lab-det"><div class="lab-det-h"><span class="dot" style="background:${confColor(r.c[i])}"></span><b>${Math.round(r.c[i] * 100)}% sure this is real</b><span class="t">${clock(f.t)} · ±${Math.round(f.acc)} m${f.src ? ' · ' + f.src.toUpperCase() : ''}${f.alt != null ? ' · ' + Math.round(f.alt) + ' m high' : ''}</span></div>` +
      (r.why[i] && LAB_WHY[r.why[i]] ? `<p class="note">${LAB_WHY[r.why[i]]}</p>` : '') +
      (rows ? `<ul class="lab-parts">${rows}</ul><p class="note">Positive numbers say "looks real", negative "looks like a jump". Added together they give the confidence.</p>` : '') + '</div>';
    el.hidden = false;
  }
  function renderLabPanel() {
    const S = TL.cleanApi.SLIDERS, groups = [];
    for (const s of S) { let g = groups.find((x) => x.name === s[5]); if (!g) groups.push(g = { name: s[5], items: [] }); g.items.push(s); }
    const dec = (st) => (st >= 1 ? 0 : st >= 0.1 ? 1 : 2);
    const fmtv = (v, st) => Number(v).toFixed(dec(st));
    $('lab').querySelector('.card').innerHTML =
      `<div class="grab"></div><div class="lab-h"><div><h3>Path lab</h3><span>${dayLabel(curDay, { weekday: 'short', day: 'numeric', month: 'short' })}</span></div><button class="iconbtn" id="labClose" type="button" aria-label="Close the Path lab">${svg('check')}</button></div>` +
      `<div class="lab-toggles">${[['raw', 'Raw GPS'], ['path', 'Likely path'], ['dots', 'Confidence']].map(([k, t]) => `<button type="button" class="chipbtn" data-show="${k}" aria-pressed="${lab.show[k]}">${t}</button>`).join('')}</div>` +
      `<div class="lab-legend"><span>jump</span><i></i><span>real</span></div><p class="note" id="labStats"></p><div id="labDetail" hidden></div>` +
      groups.map((g) => `<details class="lab-g"${g.name === 'Decision' ? ' open' : ''}><summary>${g.name}</summary>` + g.items.map(([key, label, min, max, st]) =>
        `<label class="lab-s"><span><b>${label}</b><output id="lv_${key}">${fmtv(lab.P[key], st)}</output></span><input type="range" min="${min}" max="${max}" step="${st}" value="${lab.P[key]}" data-key="${key}" data-st="${st}" aria-label="${label}"></label>`).join('') + '</details>').join('') +
      `<div class="actions"><button class="btn" id="labReset" type="button">${svg('refresh')}Defaults</button><button class="btn primary" id="labApply" type="button">${svg('check')}Use everywhere</button></div>` +
      `<p class="note">Changes here only affect this view until you tap “Use everywhere”.</p>`;
    let t = 0;
    $('lab').querySelectorAll('input[type=range]').forEach((inp) => (inp.oninput = () => {
      lab.P[inp.dataset.key] = +inp.value; $('lv_' + inp.dataset.key).textContent = fmtv(inp.value, +inp.dataset.st);
      clearTimeout(t); t = setTimeout(() => { runLab(false); if (lab.sel != null && lab.sel < lab.F.length) labDetail(lab.sel); }, 90);
    }));
    $('lab').querySelectorAll('[data-show]').forEach((b) => (b.onclick = () => { lab.show[b.dataset.show] = !lab.show[b.dataset.show]; b.setAttribute('aria-pressed', String(lab.show[b.dataset.show])); drawLab(false); }));
    $('labClose').onclick = closeLab;
    $('labReset').onclick = () => { lab.P = Object.assign({}, TL.cleanApi.DEFAULTS); renderLabPanel(); runLab(false); toast('Back to the default settings (not saved yet)', 2200); };
    $('labApply').onclick = () => {
      const diff = {}; for (const k in lab.P) if (lab.P[k] !== TL.cleanApi.DEFAULTS[k]) diff[k] = lab.P[k];
      writeLS('tl-clean', diff); buzz(); closeLab(); reanalyze('Saved. Every day now uses these settings.');
    };
  }
  $('labBtn').onclick = () => (lab ? closeLab() : openLab());
  swipeOn($('lab'), { down: () => { const c = $('lab').querySelector('.card'); if (c.scrollTop < 4) closeLab(); } }, (e) => !e.target.closest('input,details'));


  // ---- Buildings & streets (OpenStreetMap) for the likely path of the day you look at ----
  const osmOn = () => readLS('tl-osm', true) !== false;
  const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
  const refining = new Set();
  async function refineDay(d) {
    if (!TL.osm || !data || refining.has(d)) return;
    const moves = timeline.filter((it) => it.kind === 'move' && it.t0 >= d && it.t0 < d + DAY && !it.uncertain && !it.refined);
    if (!moves.length) return;
    const F = labDayFixes(d); if (F.length < 5) return;
    const P = Object.assign({}, TL.cleanApi.DEFAULTS, readLS('tl-clean', {})), ctx = { params: P, noParts: true, trusted: readLS('tl-trust', []), placeWifi: readLS('tl-wifi', []) };
    const key = d + '|' + F.length + '|' + F[F.length - 1].t + '|' + hashStr(JSON.stringify(P));
    refining.add(d);
    try {
      let paths = await TL.osm.getDay(key).catch(() => null);
      if (!paths) {
        if (!osmOn()) return;
        const r0 = TL.cleanApi.clean(F, ctx), moving = [];
        for (let i = 0; i < F.length; i++) if (!r0.still[i] && r0.route[i] && r0.c[i] >= P.keep) moving.push(r0.route[i]);
        const idx = await TL.osm.indexFor(moving);
        if (!idx) return;
        const res = TL.cleanApi.clean(F, Object.assign({ buildings: idx }, ctx)), route = TL.osm.refinePath(res.route.slice(), idx, res.still, P);
        paths = moves.map((m) => {
          const pts = [], ts = [];
          for (let i = 0; i < F.length; i++) if (F[i].t > m.t0 && F[i].t < m.t1 && route[i] && res.c[i] >= P.keep) { pts.push(route[i]); ts.push(F[i].t); }
          return pts.length >= 2 ? { t0: m.t0, path: pts, times: ts } : null;
        });
        TL.osm.putDay(key, paths).catch(() => {});
      }
      let changed = false;
      for (const p of paths) {
        const m = p && moves.find((x) => x.t0 === p.t0);
        if (!m || m.refined) continue;
        m.path = [m.path[0]].concat(p.path, [m.path[m.path.length - 1]]); m.times = [m.times[0]].concat(p.times, [m.times[m.times.length - 1]]);
        m.refined = true; changed = true;
      }
      if (changed && curDay === d && !playing && !lab && !live) refreshDay();
    } catch (e) { /* no buildings this time: the path stays as analysed */ }
    finally { refining.delete(d); }
  }
  function osmCard() {
    if (!TL.osm) return '';
    const sw = `<button class="switch" id="swOsm" role="switch" aria-checked="${osmOn()}" aria-label="Use building outlines" type="button"><span></span></button>`;
    return `<div class="card"><h2>Buildings &amp; streets</h2><div class="setting"><div class="t"><b>Use building outlines</b><span>The likely path avoids walking through buildings and follows streets. Outlines come from OpenStreetMap for the squares you passed through on the day you view; the server only learns which square.</span></div>${sw}</div><p class="note" id="osmInfo"></p><div class="actions"><button class="btn" id="osmClear" type="button">${svg('trash')}Clear downloaded outlines</button></div></div>`;
  }
  function osmInfo() {
    const el = $('osmInfo'); if (!el || !TL.osm) return;
    TL.osm.usage().then((u) => { el.textContent = 'On this phone: ' + u.tiles + ' square' + (u.tiles === 1 ? '' : 's') + ', ' + mb(u.bytes) + '. Squares unused for ' + TL.osm.KEEP_DAYS + ' days are deleted, and the oldest go first above ' + mb(TL.osm.MAX_BYTES) + '.'; }).catch(() => { el.textContent = ''; });
  }

  // Rotating the phone / resizing: the map needs to know, and in live mode it stays centred on you.
  let resizeT = 0;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (!map) return; map.invalidateSize(); if (live && follow) flyMe(); else if (!live && scenes.items.length) seek(frac); }, 150); });
  // The Back button (Android app): close what is open first, then leave the replay for the live map, and only then leave the app.
  window.__tlBack = () => {
    if (lab) { closeLab(); return true; }
    if (!$('ask').hidden) { const b = $('askLater'); if (b) b.click(); else closeAsk(); return true; }
    if (document.body.classList.contains('on-stats')) { showTab('map'); return true; }
    if (!live && data) { goLive(); return true; }
    return false;
  };
  window.__tlPt = (lat, lng) => { const q = map.latLngToContainerPoint([lat, lng]), r = $('map').getBoundingClientRect(); return { x: r.left + q.x, y: r.top + q.y }; };   // test hook
  window.__tlLab = () => (lab && lab.res ? { n: lab.F.length, sel: lab.sel, c: Array.from(lab.res.c), why: lab.res.why, fixes: lab.F.map((f) => [f.lat, f.lng]) } : null);   // test hook (read-only)
  window.__tl = () => { const el = marker && marker.getElement(), cur = scenes.items.length ? locate(frac * scenes.V).s : null; return { zoom: map.getZoom(), heading, frac, V: scenes.V, items: scenes.items.map((s) => (s.kind === 'move' ? s.mode : 'stay')), cur: cur ? (cur.kind === 'move' ? cur.mode : 'stay') : null, car: !!(el && el.classList.contains('drive')), timeline: timeline.length, day: curDay, playing, dragging: !!(map && map.dragging.enabled()), live, follow, zoomBias, speed, centre: map ? [map.getCenter().lat, map.getCenter().lng] : null, me }; };   // test hook (read-only)

  async function dataInfo() {
    const el = $('dinfo'); if (!el) return;
    let t = savedMeta ? 'Saved copy: ' + mb(savedMeta.size) + ' (' + savedMeta.where + ')' : 'No saved copy' + (saveErr ? ' — ' + saveErr : '');
    try { if (navigator.storage) { const p = await navigator.storage.persisted(), est = await navigator.storage.estimate(); t += ' · protected: ' + (p ? 'yes' : 'no') + ' · site storage ' + mb(est.usage) + ' of ' + mb(est.quota); } } catch (e) {}
    el.textContent = t;
  }

  // ---- Place pictures: the map tiles around a place (same tiles the map already loads, so nothing new leaves the phone) ----
  function placeThumb(lat, lng, w, h) {
    const z = 17, n = 2 ** z, sn = Math.sin((lat * Math.PI) / 180);
    const px = ((lng + 180) / 360) * n * 256, py = (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * n * 256, left = px - w / 2, top = py - h / 2;
    let html = '';
    for (let ty = Math.floor(top / 256); ty <= Math.floor((top + h - 1) / 256); ty++) for (let tx = Math.floor(left / 256); tx <= Math.floor((left + w - 1) / 256); tx++) {
      if (ty < 0 || ty >= n) continue;
      html += '<img alt="" draggable="false" src="https://tile.openstreetmap.org/' + z + '/' + (((tx % n) + n) % n) + '/' + ty + '.png" style="left:' + Math.round(tx * 256 - left) + 'px;top:' + Math.round(ty * 256 - top) + 'px">';
    }
    return '<div class="thumb" style="width:' + w + 'px;height:' + h + 'px">' + html + '<span class="tpin"></span></div>';
  }

  // ---- Places: the names you give them ----
  const KINDS = [
    { id: 'home', label: 'Home', icon: 'home', color: '#5cbcf6' }, { id: 'work', label: 'Work', icon: 'briefcase', color: '#fbbf24' },
    { id: 'school', label: 'School', icon: 'school', color: '#a78bfa' }, { id: 'gym', label: 'Gym', icon: 'gym', color: '#4ade80' },
    { id: 'people', label: 'Family & friends', icon: 'users', color: '#fb7185' }, { id: 'shop', label: 'Shopping', icon: 'bag', color: '#fb923c' },
    { id: 'food', label: 'Food & drink', icon: 'food', color: '#f87171' }, { id: 'other', label: 'Other', icon: 'star', color: '#94a3b8' },
  ];
  const kindById = Object.fromEntries(KINDS.map((k) => [k.id, k]));
  let labels = []; try { const v = JSON.parse(localStorage.getItem('tl-places') || '[]'); if (Array.isArray(v)) labels = v; } catch (e) {}
  const saveLabels = () => { try { localStorage.setItem('tl-places', JSON.stringify(labels)); } catch (e) {} };
  const labelFor = (p) => { let best = null, bd = 150; for (const l of labels) { const d = TL.haversine([p.lat, p.lng], [l.lat, l.lng]); if (d < bd) { bd = d; best = l; } } return best; };
  const labelName = (p) => { const l = p && labelFor(p); return l && !l.skip && l.name ? l.name : ''; };
  const googleKind = (t) => ({ HOME: 'home', WORK: 'work', GYM: 'gym', SCHOOL: 'school', UNIVERSITY: 'school' })[String(t || '').toUpperCase()] || null;
  const stayName = (s) => labelName(s.place) || (!s.name || s.name === 'Stopped' ? 'Unnamed place' : s.name);
  const placeKind = (p) => { const l = labelFor(p); return kindById[(l && !l.skip && l.kind) || p.guess || googleKind(p.googleType)] || null; };
  const placeLabelText = (p) => labelName(p) || p.googleName || (googleKind(p.googleType) ? kindById[googleKind(p.googleType)].label : '');
  const askSnoozed = () => { try { return Number(localStorage.getItem('tl-ask-snooze') || 0) > Date.now(); } catch (e) { return false; } };
  const isPending = (p) => !labelFor(p) && !p.googleName && (p.visits >= 3 || p.hours >= 6);   // the places that matter, not yet named
  const pendingPlaces = () => places.filter(isPending).sort((a, b) => (b.guess ? 1 : 0) - (a.guess ? 1 : 0) || b.hours - a.hours);
  function whenText(p) {
    const tot = p.nightH + p.dayH + p.eveH || 1;
    if (p.nightH / tot > 0.5) return 'mostly overnight';
    if (p.dayH / tot > 0.6) return 'mostly during the day';
    if (p.eveH / tot > 0.5) return 'mostly in the evening';
    let hr = 0; p.startHours.forEach((v, i) => { if (v > p.startHours[hr]) hr = i; });
    return 'usually around ' + String(hr).padStart(2, '0') + ':00';
  }
  const ctxText = (p) => p.visits + (p.visits > 1 ? ' visits' : ' visit') + ' · ' + Math.round(p.hours) + ' h in total · ' + whenText(p);
  // The question to ask about a place: a yes/no when we have a good guess, an open question otherwise.
  function questionFor(p) {
    const k = p.guess || googleKind(p.googleType);
    if (!k) return null;
    const titles = { home: 'Is this your home?', work: 'Is this where you work?', school: 'Is this where you study?', gym: 'Is this your gym?' };
    const why = p.guess === 'home' ? "You're here most nights." : p.guess === 'work' ? "You're here on most days." : 'Google marked this place as ' + kindById[k].label.toLowerCase() + '.';
    return { kind: k, title: titles[k] || 'Is this “' + kindById[k].label + '”?', why };
  }

  let askPlace = null, askQueue = [], askIdx = 0, askStage = '', askKind = null, askMarker = null, prevTab = 'map', askedOnce = false, hudPlace = null;
  function focusPlace() {                                      // show the place on the map, in the part the sheet does not cover
    if (askMarker) { askMarker.remove(); askMarker = null; }
    if (!map || !askPlace) return;
    map.invalidateSize(); progUntil = Date.now() + 1500;
    const p = askPlace, c = map.unproject(map.project([p.lat, p.lng], 16).add(L.point(0, Math.min(150, map.getSize().y * 0.2))), 16);
    map.setView(c, 16, { animate: false });
    askMarker = L.circleMarker([p.lat, p.lng], { radius: 16, color: '#5cbcf6', weight: 3, fillColor: '#5cbcf6', fillOpacity: 0.22, interactive: false }).addTo(map);
  }
  function openAsk(list, idx) {
    if (!list || !list.length) return;
    stop(); askQueue = list; askIdx = idx || 0; askPlace = list[askIdx];
    const on = document.querySelector('nav button.on'); prevTab = on ? on.dataset.v : 'map';
    if (prevTab !== 'map') document.querySelector('nav button[data-v=map]').click();
    askStage = labelFor(askPlace) || !questionFor(askPlace) ? 'choose' : 'confirm';
    const l = labelFor(askPlace); askKind = l && l.kind ? l.kind : null;
    focusPlace(); renderAsk(); $('ask').hidden = false;
  }
  function closeAsk() {
    $('ask').hidden = true; askPlace = null;
    if (askMarker) { askMarker.remove(); askMarker = null; }
    if (prevTab !== 'map') { const b = document.querySelector('nav button[data-v=' + prevTab + ']'); if (b) b.click(); }
    if (live) { setFollow(true); flyMe(); }
  }
  function nextAsk() {
    if (askIdx + 1 < askQueue.length) { askIdx++; askPlace = askQueue[askIdx]; const q = questionFor(askPlace); askStage = q ? 'confirm' : 'choose'; askKind = null; focusPlace(); renderAsk(); }
    else closeAsk();
  }
  function refreshDay() { const fr = frac; showDay(curDay); $('scrub').value = Math.round(fr * 100000); seek(fr); }
  function saveLabel(p, name, kind, skip) {
    const l = labelFor(p);
    if (l) Object.assign(l, { name, kind, skip: !!skip }); else labels.push({ lat: p.lat, lng: p.lng, name, kind, skip: !!skip });
    saveLabels(); refreshDay(); renderStats();
  }
  function renderAsk() {
    const p = askPlace, pw = Math.max(200, Math.min(520, window.innerWidth - 36)), card = $('ask').querySelector('.card'), l = labelFor(p), q = questionFor(p), ctx = ctxText(p);
    const prog = askQueue.length > 1 ? '<div class="progress">Question ' + (askIdx + 1) + ' of ' + askQueue.length + '</div>' : '';
    const foot = '<div class="askfoot"><button class="ghost" id="askLater" type="button">' + (l ? 'Cancel' : 'Not now') + '</button>' +
      (l ? '<button class="ghost danger" id="askRemove" type="button">Remove name</button>' : '<button class="ghost" id="askNever" type="button">Don’t ask about this place</button>') + '</div>';
    if (askStage === 'confirm') {
      const kd = kindById[q.kind];
      card.innerHTML = '<div class="grab"></div>' + prog + '<div class="askhead"><span class="askicon" style="--c:' + kd.color + '">' + svg(kd.icon) + '</span><div><h3 id="askTitle">' + q.title + '</h3><p>' + esc(q.why) + ' ' + esc(ctx) + '.</p></div></div><div class="askpic">' + placeThumb(p.lat, p.lng, pw, 84) + '</div>' +
        '<div class="answers"><button class="btn primary" id="askYes" type="button">' + svg('check') + 'Yes, it’s my ' + esc(kd.label.toLowerCase()) + '</button><button class="btn" id="askNo" type="button">No, it’s something else</button></div>' + foot;
    } else {
      const title = l ? 'Rename this place' : 'What is this place for you?';
      card.innerHTML = '<div class="grab"></div>' + prog + '<div class="askhead"><span class="askicon">' + svg('pin') + '</span><div><h3 id="askTitle">' + title + '</h3><p>' + esc(ctx) + (p.googleName ? ' · Google calls it “' + esc(p.googleName) + '”' : '') + '.</p></div></div><div class="askpic">' + placeThumb(p.lat, p.lng, pw, 84) + '</div>' +
        '<div class="kinds">' + KINDS.map((k) => '<button class="kind" type="button" data-kind="' + k.id + '" style="--c:' + k.color + '" aria-pressed="' + (askKind === k.id) + '">' + svg(k.icon) + '<span>' + esc(k.label) + '</span></button>').join('') + '</div>' +
        '<div class="field"><input id="askName" type="text" maxlength="60" autocomplete="off" placeholder="Name it, e.g. Dana’s place (optional)" value="' + esc(l ? l.name || '' : '') + '"></div>' +
        '<div class="answers" style="margin-top:12px"><button class="btn primary" id="askSave" type="button">Save</button></div>' + foot;
      const input = $('askName'), save = $('askSave'), sync = () => { save.disabled = !(askKind || input.value.trim()); };
      input.oninput = sync; sync();
      input.onkeydown = (e) => { if (e.key === 'Enter' && !save.disabled) save.click(); };
    }
  }
  $('ask').addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t || !askPlace) return;
    const p = askPlace;
    if (t.id === 'askYes') { const kd = kindById[questionFor(p).kind]; saveLabel(p, kd.label, kd.id); toast('Saved: ' + kd.label, 2200); nextAsk(); }
    else if (t.id === 'askNo') { askStage = 'choose'; askKind = null; renderAsk(); const i = $('askName'); if (i) i.focus(); }
    else if (t.classList.contains('kind')) { askKind = askKind === t.dataset.kind ? null : t.dataset.kind; card_sync(); }
    else if (t.id === 'askSave') {
      const typed = $('askName').value.trim(), kind = askKind || 'other', name = typed || kindById[kind].label;
      saveLabel(p, name, kind); toast('Saved: ' + name, 2200); nextAsk();
    }
    else if (t.id === 'askNever') { saveLabel(p, '', null, true); toast('We won’t ask about this place again.', 2400); nextAsk(); }
    else if (t.id === 'askRemove') { labels = labels.filter((x) => x !== labelFor(p)); saveLabels(); refreshDay(); renderStats(); toast('Name removed', 2000); closeAsk(); }
    else if (t.id === 'askLater') { if (!labelFor(p)) { try { localStorage.setItem('tl-ask-snooze', String(Date.now() + 864e5)); } catch (x) {} } closeAsk(); }
  });
  function card_sync() { document.querySelectorAll('#ask .kind').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === askKind))); const save = $('askSave'); if (save) save.disabled = !(askKind || $('askName').value.trim()); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('ask').hidden) { const b = $('askLater'); if (b) b.click(); } });

  function updateHudEdit(s) {                                  // the name/rename button on the HUD while stopped somewhere
    const b = $('hudEdit'), p = s.kind === 'stay' ? s.place : null;
    if (p === hudPlace) return;
    hudPlace = p; b.hidden = !p;
    if (p) { const named = !!labelName(p); b.classList.toggle('need', !named); b.querySelector('.lbl').textContent = named ? '' : 'Name'; b.setAttribute('aria-label', named ? 'Rename this place' : 'Name this place'); }
  }
  $('hudEdit').onclick = () => { if (hudPlace) openAsk([hudPlace]); };

  // Once per visit, gently ask about the most visited place that still has no name (never during playback, and not again for a day after "Not now").
  function scheduleAsk() {
    if (askedOnce || (navigator.webdriver && !window.__forceAsk)) return;
    setTimeout(() => {
      if (askedOnce || askSnoozed() || playing || askPlace || !data || !$('ask').hidden) return;
      const list = pendingPlaces().slice(0, 3);
      if (list.length) { askedOnce = true; openAsk(list); }
    }, 2400);
  }

  // ---- Recording (Android app) ----
  const APK_URL = 'https://github.com/michaelkashi100/Personal-stuff/releases/download/android-latest/timeline.apk';
  function recState(st) {
    if (!st.recording) return { key: 'off', label: 'Off', text: 'Recording is off. Start it to build your timeline automatically.' };
    if (!st.fine) return { key: 'perm', label: 'Needs location permission', text: 'Allow location access so trips can be recorded.' };
    if (!st.bg) return { key: 'perm', label: 'Needs “Allow all the time”', text: 'Open App permissions, then Location, then choose “Allow all the time”. Without it Android stops recording when the app is closed.' };
    if (!st.activity) return { key: 'perm', label: 'Needs physical activity', text: 'Allow “Physical activity” so recording only wakes up when you start moving. That is what keeps the battery use near zero.' };
    return { key: 'on', label: 'Recording', text: 'Nothing runs while you are still. GPS is used only while you move.' };
  }
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago'; };
  function renderRecording() {
    const el = $('recWrap'); if (!el) return;
    if (!NATIVE) {                                            // a browser on Android: offer the app
      el.innerHTML = /Android/i.test(navigator.userAgent) ? `<div class="card"><h2>Record automatically</h2><p class="note" style="margin-top:0">A browser cannot track you in the background. The Android app records your trips with almost no battery use and keeps everything on your phone.</p><div class="actions"><a class="btn primary" href="${APK_URL}" rel="noopener">${svg('upload')}Get the Android app</a></div></div>` : '';
      hydrate(el); return;
    }
    const st = nativeStatus || nat('status') || {}, rs = recState(st);
    const info = st.fixes > 0 ? `${Number(st.fixes).toLocaleString()} locations saved on this phone since ${new Date(st.first).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}. Last: ${ago(st.last)}.` : 'No locations recorded yet.';
    el.innerHTML = `<div class="card"><h2>Recording</h2><div class="recstate ${rs.key}"><i></i><b>${rs.label}</b></div><p class="note">${rs.text}</p><p class="note">${info}</p><div class="actions">` +
      (rs.key === 'on' ? '<button class="btn" id="recToggle" type="button">Pause recording</button>' : `<button class="btn primary" id="recToggle" type="button">${rs.key === 'perm' ? 'Fix permissions' : 'Start recording'}</button>`) +
      '<button class="btn" id="recBattery" type="button">Battery settings</button></div>' +
      '<div class="actions"><button class="btn" id="recApp" type="button">App permissions</button><button class="btn" id="recBackup" type="button">Save a backup</button></div>' +
      '<p class="note">Choose “Unrestricted” in battery settings so Android does not stop the recorder. Locations never leave this phone.</p>' +
      '<div class="actions"><button class="btn danger" id="recWipe" type="button"><span data-icon="trash"></span><span class="lbl">Delete recorded locations</span></button></div></div>';
    hydrate(el);
    $('recToggle').onclick = () => { buzz(); NATIVE.setRecording(rs.key !== 'on'); };
    $('recBattery').onclick = () => NATIVE.openSettings('battery');
    $('recApp').onclick = () => NATIVE.openSettings('app');
    $('recBackup').onclick = () => { const r = nat('exportBackup'); toast(r && r.ok ? 'Saved to Downloads: ' + r.name : 'Could not save a backup' + (r && r.error ? ': ' + r.error : ''), 5000); };
    let t = 0;
    $('recWipe').onclick = () => {
      const b = $('recWipe'), lbl = b.querySelector('.lbl');
      if (!b.classList.contains('armed')) { b.classList.add('armed'); lbl.textContent = 'Tap again to confirm'; clearTimeout(t); t = setTimeout(() => { b.classList.remove('armed'); lbl.textContent = 'Delete recorded locations'; }, 3500); return; }
      NATIVE.clearRecorded(); location.reload();                     // starts again from what is left (an imported file, or nothing)
    };
  }
  // App updates (Android app): the screens and analysis update themselves; the recorder asks for one tap.
  function renderUpdates() {
    const el = $('updWrap'); if (!el) return;
    if (!NATIVE) { el.innerHTML = ''; return; }
    const st = nativeStatus || nat('status') || {};
    if (!(st.bridge >= 2)) {                                   // an APK from before automatic updates existed: it needs one last manual install
      el.innerHTML = `<div class="card"><h2>App updates</h2><p class="note" style="margin-top:0">This version of the app cannot update itself yet. Install the latest one once; after that updates arrive on their own.</p><div class="actions"><a class="btn primary" href="${APK_URL}" rel="noopener">${svg('upload')}Get the latest app</a></div></div>`;
      hydrate(el); return;
    }
    const newApk = st.latestBuild > st.build;
    const screens = st.bundle ? (new Date(st.bundle * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + clock(st.bundle * 1000)) : 'the version in the app';
    const sw = (id, label, on) => `<button class="switch" id="${id}" role="switch" aria-checked="${on}" aria-label="${label}" type="button"><span></span></button>`;
    el.innerHTML = `<div class="card"><h2>App updates</h2>` +
      (newApk ? `<div class="cta"><div class="t"><b>A new version of the recorder is ready</b><span>Build ${st.latestBuild}. Android asks you to confirm once.</span></div><button class="btn primary sm" id="updInstall" type="button"${st.installing ? ' disabled' : ''}>${st.installing ? 'Working…' : 'Update now'}</button></div>` : '') +
      `<p class="note" style="margin-top:${newApk ? 8 : 0}px">Recorder build ${st.build}. Screens and analysis from ${screens}.</p>` +
      (st.checking ? '<p class="note">Checking for updates…</p>' : st.updateMsg ? `<p class="note">${esc(st.updateMsg)}</p>` : '') +
      `<div class="setting"><div class="t"><b>Update automatically</b><span>Screens and analysis update in the background. Nothing but the update itself is downloaded.</span></div>${sw('swAuto', 'Update automatically', st.autoUpdate)}</div>` +
      `<div class="actions"><button class="btn" id="updCheck" type="button"${st.checking ? ' disabled' : ''}>${svg('refresh')}Check for updates</button></div></div>`;
    hydrate(el);
    $('updCheck').onclick = () => { buzz(); NATIVE.checkForUpdates(); };
    const inst = $('updInstall'); if (inst) inst.onclick = () => { buzz(); NATIVE.installUpdate(); };
    $('swAuto').onclick = () => { const on = $('swAuto').getAttribute('aria-checked') !== 'true'; $('swAuto').setAttribute('aria-checked', String(on)); buzz(); NATIVE.setAutoUpdate(on); };
  }
  // The app downloaded newer screens: load them (your data and the viewed day are kept).
  window.__tlBundleUpdated = () => { toast('Updated. Reloading…', 1500); setTimeout(() => location.reload(), 700); };

  async function reloadSources() {
    if (reloadingNative) return; reloadingNative = true;
    try {
      const saved = await loadFiles(), srcs = (saved || []).map(savedSource);
      if (NATIVE && nativeStatus && nativeStatus.fixes > 0) srcs.push(nativeSource());
      if (srcs.length) await loadFromSources(srcs, false);
    } finally { reloadingNative = false; }
  }
  // Called by the app when it comes to the front or the recorder's state changes.
  function refreshNative() {
    if (!NATIVE) return;
    const st = nat('status'); if (!st) return;
    const prev = nativeFixes; nativeStatus = st; nativeFixes = st.fixes;
    renderRecording(); renderUpdates();
    if (data && loadPhone() && !playing && $('ask').hidden) { refreshDay(); renderStats(); }
    if (!data) { if (st.fixes > 0) reloadSources(); else $('status').textContent = recState(st).key === 'on' ? 'Recording is on. Your first trip appears here after you start moving.' : $('status').textContent; }
    else if (prev >= 0 && st.fixes !== prev && !playing && $('ask').hidden) reloadSources().then(() => toast('Updated with your latest recordings', 2500));
  }
  window.__tlNativeChanged = () => { if (!me) { meDenied = false; syncLoc(); } return refreshNative(); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshNative(); });

  // ---- Insights ----
  // Stretches the cleaning ignored because the GPS put you where you never are (spoofing near the northern border,
  // or a "trip" abroad too short / too sudden to be real). A trip abroad can be confirmed; the Middle East cannot.
  function ignoredCard() {
    const rm = (timeline && timeline.removed) || [];
    if (!rm.length) return '';
    const fmt = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + clock(t);
    const rows = rm.slice(-8).reverse().map((r) => `<li class="ign"><div class="grow"><b>${fmt(r.t0)} · ${fmtDur(Math.max(60000, r.t1 - r.t0))}</b><span>${r.why === 'never' ? 'GPS placed you in a country you are never in (usually GPS interference). Ignored.' : 'Abroad, but too short or too sudden to be a real trip. Ignored.'}</span></div>${r.why === 'abroad' ? `<button class="btn sm" type="button" data-trust="${r.t0},${r.t1}">I was there</button>` : ''}</li>`).join('');
    return `<div class="card"><h2>Ignored locations</h2><p class="note" style="margin-top:0">${rm.length} stretch${rm.length > 1 ? 'es' : ''} where the GPS put you somewhere you could not have been.</p><ul class="rows">${rows}</ul></div>`;
  }
  // Time on the phone while standing still (Android app only: it needs "Usage access", the same data Digital Wellbeing uses).
  function phoneCard(year) {
    if (!NATIVE) return '';
    const st = nativeStatus || nat('status') || {};
    if (!(st.bridge >= 3)) return `<div class="card"><h2>Phone time while still</h2><p class="note" style="margin-top:0">Needs the newest version of the app. Open “App updates” above and install it.</p></div>`;
    if (!st.usage) return `<div class="card"><h2>Phone time while still</h2><p class="note" style="margin-top:0">See how much of the time you stand still is spent on your phone. Turn on “Usage access” for Timeline in Android settings: it is the same screen-time information Digital Wellbeing uses. Only when the screen was on is kept, never which apps. It stays on this phone.</p><div class="actions"><button class="btn primary" id="usageAllow" type="button">${svg('phone')}Allow usage access</button></div></div>`;
    let still = 0, used = 0; const per = new Map(), days = new Set();
    for (const it of timeline) {
      if (it.kind !== 'stay' || it.t1 <= phoneSince || new Date(it.t0).getFullYear() !== year && new Date(it.t1).getFullYear() !== year) continue;
      const a = Math.max(it.t0, phoneSince), u = phoneMs(a, it.t1); still += it.t1 - a; used += u;
      if (u > 0) { days.add(dayKey(a)); if (it.place) { const r = per.get(it.place) || { p: it.place, ms: 0 }; r.ms += u; per.set(it.place, r); } }
    }
    const since = new Date(phoneSince).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    if (still < 60000) return `<div class="card"><h2>Phone time while still</h2><p class="note" style="margin-top:0">Collecting since ${since}. Android keeps only about a week of screen history, so this fills up from now on.</p></div>`;
    const rows = [...per.values()].sort((a, b) => b.ms - a.ms).slice(0, 5), maxMs = rows.length ? rows[0].ms : 1;
    const rowHtml = rows.map((r) => { const nm = placeLabelText(r.p), kd = placeKind(r.p); return `<li class="row" style="--c:${kd ? kd.color : 'var(--accent)'}"><span class="ico">${svg(kd ? kd.icon : 'pin')}</span><div class="grow"><div class="top"><b>${nm ? esc(nm) : '<i class="unnamed">Unnamed place</i>'}</b><span>${fmtDur(r.ms)}</span></div><div class="meter"><i style="width:${Math.max(3, (r.ms / maxMs) * 100)}%"></i></div></div></li>`; }).join('');
    return `<div class="card"><h2>Phone time while still</h2><div class="big num">${fmtDur(used)}<small>on the phone</small></div><p>${Math.round((used / still) * 100)}% of the ${fmtDur(still)} you were still, since ${since}${days.size > 1 ? ' (about ' + fmtDur(used / days.size) + ' on a day with phone use)' : ''}.</p>${rowHtml ? `<ul class="rows">${rowHtml}</ul>` : ''}</div>`;
  }
  const fmtKm = (v) => (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1)) + ' km';
  function renderStats() {
    const el = $('statsView');
    if (!timeline.length) { el.innerHTML = '<div class="page"><div class="empty">Nothing to show yet.</div></div>'; return; }
    const years = [...new Set(timeline.map((s) => new Date(s.t0).getFullYear()))].sort();
    const year = years[years.length - 1] ?? null;
    const s = TL.statsFromTimeline(timeline, year);
    const modes = Object.entries(s.byModeKm).sort((a, b) => b[1] - a[1]), maxKm = modes.length ? modes[0][1] || 1 : 1;
    const modeRows = modes.map(([k, v]) => `<li class="row" style="--c:${MODE_COLOR[k]}"><span class="ico">${svg(MODE_ICON[k])}</span><div class="grow"><div class="top"><b>${MODE_NAME[k]}</b><span>${fmtKm(v)}</span></div><div class="meter"><i style="width:${Math.max(3, (v / maxKm) * 100)}%"></i></div></div></li>`).join('');
    const shown = places.slice(0, 8), maxH = shown.length ? shown[0].hours || 1 : 1, pend = pendingPlaces().length;
    const placeRows = shown.map((p) => {
      const nm = placeLabelText(p), kd = placeKind(p), named = !!labelFor(p) && !!labelName(p), hint = !named && p.guess ? ' · looks like your ' + p.guess : '';
      return `<li><button class="row" type="button" data-pid="${p.id}" style="--c:${kd ? kd.color : 'var(--accent)'}"><span class="ico pic">${placeThumb(p.lat, p.lng, 52, 52)}<em>${svg(kd ? kd.icon : 'pin')}</em></span><div class="grow"><div class="top"><b>${nm ? esc(nm) : '<i class="unnamed">Unnamed place</i>'}</b><span>${Math.round(p.hours).toLocaleString()} h</span></div><div class="sub">${p.visits} visit${p.visits > 1 ? 's' : ''}${hint}</div><div class="meter"><i style="width:${Math.max(3, (p.hours / maxH) * 100)}%"></i></div></div>${named ? `<span class="editdot">${svg('pencil')}</span>` : '<span class="pill">Name it</span>'}</button></li>`;
    }).join('');
    const sw = (id, label, on) => `<button class="switch" id="${id}" role="switch" aria-checked="${on}" aria-label="${label}" type="button"><span></span></button>`;
    el.innerHTML = `<div class="page"><div id="recWrap"></div><div id="updWrap"></div>` +
      `<div class="card hero-card"><h2>${year ?? 'All time'} in review</h2><div class="big num">${Math.round(s.totalKm).toLocaleString()}<small>km travelled</small></div><p>Across ${s.visitCount.toLocaleString()} stops and ${s.uniquePlaces.toLocaleString()} different places.</p></div>` +
      `<div class="tiles"><div class="tile"><b>${s.activeDays.toLocaleString()}</b><span>active days</span></div><div class="tile"><b>${s.uniquePlaces.toLocaleString()}</b><span>different places</span></div>` +
      (s.longest ? `<div class="tile"><b>${fmtKm(s.longest.dist / 1000).replace(' km', '')}<small style="font-size:13px;color:var(--text-2);font-weight:600"> km</small></b><span>longest ${MODE_NAME[s.longest.mode].toLowerCase()} leg</span></div>` : '') + `</div>` +
      `<div class="card"><h2>How you travelled</h2><ul class="rows">${modeRows || '<li class="empty">No trips yet.</li>'}</ul></div>` +
      phoneCard(year) + ignoredCard() +
      `<div class="card"><h2>Your places</h2>${pend ? `<div class="cta"><div class="t"><b>${pend} place${pend > 1 ? 's need' : ' needs'} a name</b><span>A quick question about each.</span></div><button class="btn primary sm" id="askStart" type="button">Start</button></div>` : ''}<ul class="rows">${placeRows || '<li class="empty">No stops yet.</li>'}</ul></div>` +
      `<div class="card"><h2>Playback</h2>` +
      `<div class="setting"><div class="t"><b>Keep screen on</b><span id="awakeNote"></span></div>${sw('swAwake', 'Keep screen on', keepOn)}</div>` +
      `<div class="setting"><div class="t"><b>Continue to the next day</b><span>When a day ends, the replay moves on and keeps playing.</span></div>${sw('swNext', 'Continue to the next day', autoNext)}</div></div>` +
      osmCard() +
      `<div class="card"><h2>Your data</h2><p class="note" id="dinfo" style="margin-top:0"></p><div class="actions"><button class="btn" id="chg" type="button"><span data-icon="refresh"></span>Change file</button><button class="btn danger" id="forget" type="button"><span data-icon="trash"></span><span class="lbl">Forget my data</span></button></div><p class="note">Your file and place names are kept only in this browser, on this phone. Nothing is uploaded.</p></div>` +
      `</div>`;
    hydrate(el);
    el.querySelectorAll('button.row[data-pid]').forEach((b) => (b.onclick = () => { const p = places.find((x) => String(x.id) === b.dataset.pid); if (p) openAsk([p]); }));
    const st = $('askStart'); if (st) st.onclick = () => openAsk(pendingPlaces().slice(0, 5));
    const toggle = (id, get, set) => { const b = $(id); b.onclick = () => { const on = !get(); set(on); b.setAttribute('aria-checked', String(on)); buzz(); }; };
    toggle('swAwake', () => keepOn, (on) => { keepOn = on; try { localStorage.setItem('tl-awake', on ? '1' : '0'); } catch (e) {} if (on) keepAwake(); else releaseAwake(); wakeInfo(); });
    toggle('swNext', () => autoNext, (on) => { autoNext = on; try { localStorage.setItem('tl-autonext', on ? '1' : '0'); } catch (e) {} });
    $('chg').onclick = () => $('file').click();
    let armedT = 0;
    $('forget').onclick = async () => {                       // two taps, so it cannot be hit by accident
      const b = $('forget'), lbl = b.querySelector('.lbl');
      if (!b.classList.contains('armed')) { b.classList.add('armed'); lbl.textContent = 'Tap again to confirm'; clearTimeout(armedT); armedT = setTimeout(() => { b.classList.remove('armed'); lbl.textContent = 'Forget my data'; }, 3500); return; }
      await clearFiles(); try { localStorage.removeItem('tl-places'); localStorage.removeItem('tl-ask-snooze'); } catch (e) {} location.reload();
    };
    el.querySelectorAll('[data-trust]').forEach((b) => (b.onclick = () => {
      const [a, c] = b.dataset.trust.split(',').map(Number), tr = readLS('tl-trust', []);
      tr.push([a - 60000, c + 60000]); writeLS('tl-trust', tr); buzz(); reanalyze('Kept as a real trip');
    }));
    const so = $('swOsm'); if (so) so.onclick = () => { const on = !osmOn(); writeLS('tl-osm', on); so.setAttribute('aria-checked', String(on)); buzz(); if (on && curDay != null) refineDay(curDay); };
    const oc = $('osmClear'); if (oc) oc.onclick = () => TL.osm.clearAll().then(() => { toast('Downloaded outlines deleted', 2000); osmInfo(); });
    osmInfo();
    const ua = $('usageAllow'); if (ua) ua.onclick = () => { buzz(); NATIVE.openSettings('usage'); };
    renderRecording(); renderUpdates(); wakeInfo(); dataInfo();
  }

  // Open the saved copy (and, in the Android app, the recorded locations) automatically; show the picker only when there is nothing.
  hydrate(document); setPlayUi();
  if (NATIVE) {
    $('startRec').hidden = false; $('pick').classList.remove('primary'); $('pick').lastChild.textContent = 'Import a Google Timeline file';
    document.querySelector('#import .lead').textContent = 'Records your days on this phone with almost no battery use. Everything stays here.';
    $('startRec').onclick = () => { buzz(); NATIVE.setRecording(true); $('status').textContent = 'Allow location “all the time” when Android asks, then physical activity.'; };
    nativeStatus = nat('status'); nativeFixes = nativeStatus ? nativeStatus.fixes : 0;
  }
  $('import').style.visibility = 'hidden';
  loadFiles().then((saved) => {
    $('import').style.visibility = 'visible';
    const srcs = (saved || []).map(savedSource);
    if (NATIVE && nativeStatus && nativeStatus.fixes > 0) srcs.push(nativeSource());
    if (srcs.length) { setLoading(true, 'Loading your timeline…'); return loadFromSources(srcs, false); }
    if (NATIVE && nativeStatus && recState(nativeStatus).key === 'on') $('status').textContent = 'Recording is on. Your first trip appears here after you start moving.';
  }).catch(() => { $('import').style.visibility = 'visible'; });

  // New versions apply by themselves. Reloading is safe now: the saved copy reopens straight away, and the viewed day is restored.
  if (!NATIVE && 'serviceWorker' in navigator && location.protocol.startsWith('http')) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true; if (data) toast('Updating to the latest version…', 1500);
      setTimeout(() => location.reload(), data ? 500 : 0);
    });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.update();
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });   // coming back to an old tab checks for a new version
    }).catch(() => {});
  }
})();
