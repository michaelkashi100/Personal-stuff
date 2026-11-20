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
    try { $('status').textContent = 'Analyzing your movements…'; await new Promise((r) => setTimeout(r, 30)); tl = TL.analyze(merged); }
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
    data = d; timeline = tl || TL.analyze(d); places = TL.clusterPlaces(timeline);
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
    if (b.dataset.v === 'map') { map.invalidateSize(); if (scenes.items.length) seek(frac); }   // re-frame the camera: it was sized while hidden
  }));

  // ---- Map & replay ----
  function initMap() {
    map = L.map('map', { zoomControl: false, zoomSnap: 0 });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
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
  }

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
    $('day').onchange = () => { const was = playing; showDay(+$('day').value); if (was) startPlay(); };
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
  $('prevDay').onclick = () => { buzz(); const was = playing; goDay(-1, was); };
  $('nextDay').onclick = () => { buzz(); const was = playing; goDay(1, was); };
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
  let scenes = { items: [], V: 0 }, frac = 0, heading = 0, playing = false, lastTs = 0, raf = 0;
  let trail, trailGlow, trailColor = '', carEl, badgeEl, badgeMode = '', hudKey = '', litKey = null;

  const sm = (x) => x * x * (3 - 2 * x);                                  // smoothstep
  const win = (a, b, x) => sm(Math.min(1, Math.max(0, (x - a) / (b - a))));
  const easeMove = (f) => f + 0.75 * (sm(f) - f);                         // slow -> fast -> slow
  const easeInv = (y) => { let lo = 0, hi = 1; for (let i = 0; i < 32; i++) { const m = (lo + hi) / 2; if (easeMove(m) < y) lo = m; else hi = m; } return (lo + hi) / 2; };
  const fmtDur = (ms) => { const m = Math.round(ms / 60000), h = Math.floor(m / 60); return h ? h + ' h' + (m % 60 ? ' ' + (m % 60) + ' m' : '') : m + ' m'; };
  const shortDur = (ms) => ms >= 3.6e6 ? (ms / 3.6e6).toFixed(1).replace(/\.0$/, '') + 'h' : Math.round(ms / 60000) + 'm';
  const fmtDist = (d) => (d >= 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m');
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function bearing(a, b) {
    const dy = b[0] - a[0], dx = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) * Math.PI) / 360);
    return dx === 0 && dy === 0 ? null : ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  }

  // A leg from the analysis, with the geometry helpers the animation needs.
  function moveScene(m) {
    const cum = [0];
    for (let i = 1; i < m.path.length; i++) cum.push(cum[i - 1] + TL.haversine(m.path[i - 1], m.path[i]));
    return { kind: 'move', t0: m.t0, t1: m.t1, mode: m.mode, uncertain: !!m.uncertain, color: MODE_COLOR[m.mode] || MODE_COLOR.other, med: m.med, path: m.path, times: m.times, cum, len: cum[cum.length - 1], bounds: L.latLngBounds(m.path) };
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
    $('hudDay').textContent = dayLabel(d, { weekday: 'short', day: 'numeric', month: 'short' });
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
          .bindTooltip(esc(s.name) + ' · ' + clock(s.t0) + '–' + clock(s.t1) + ' (' + fmtDur(s.t1 - s.t0) + ')').addTo(dayLayer);
      }
    }
    trailGlow = L.polyline([], { weight: 13, opacity: 0.22, lineCap: 'round', interactive: false }).addTo(dayLayer);
    trail = L.polyline([], { weight: 5, opacity: 1, lineCap: 'round', interactive: false }).addTo(dayLayer);
    marker = L.marker([0, 0], { icon: L.divIcon({ className: 'live', html: CAR, iconSize: [30, 30] }), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(dayLayer);
    carEl = marker.getElement().querySelector('.carwrap'); badgeEl = marker.getElement().querySelector('.badge');
    renderBar(items, byMode, still);
    $('scrub').value = 0; seek(0);
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
    $('summary').innerHTML = !items.length ? '' : chip('clock', 'var(--muted)', fmtDur(still) + ' still') +
      Object.entries(byMode).sort((a, b) => b[1] - a[1]).map(([m, d]) => chip(MODE_ICON[m], MODE_COLOR[m], fmtDist(d))).join('');
  }

  function seek(fr) { try { seekInner(fr); } catch (e) { console.error(e); setHud('Replay error', String(e.message).slice(0, 60)); } }
  function seekInner(fr) {
    frac = fr;
    $('fill').style.width = fr * 100 + '%'; $('playhead').style.left = fr * 100 + '%';
    if (!scenes.items.length) { setHud('--:--', 'No trips on this day'); return; }
    const { s, f, p, t, ll, k, bear, left } = locate(fr * scenes.V);
    const cam = cameraFor(s, p, ll);
    map.setView(cam.center, cam.zoom, { animate: false });
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
    const sub = s.kind === 'stay' ? s.name + ' · ' + fmtDur((s.t1 - s.t0) * f)
      : s.uncertain ? 'Travelled · no data in between' : MODE_NAME[mode] + ' · ' + Math.round(s.med * 3.6) + ' km/h · ' + (left / 1000).toFixed(1) + ' km left';
    setHud(clock(t), sub, s.kind === 'stay' ? 'pin' : MODE_ICON[mode], s.kind === 'stay' ? 'var(--accent)' : MODE_COLOR[mode]);
  }
  function setHud(a, b, icon, color) {
    const key = a + '|' + b + '|' + (icon || '');
    if (key === hudKey) return;
    hudKey = key; $('hudTime').textContent = a; $('hudSub').textContent = b;
    const hi = $('hudIcon'); hi.innerHTML = icon ? svg(icon) : ''; hi.style.setProperty('--c', color || 'var(--accent)'); hi.style.display = icon ? 'grid' : 'none';
  }

  // ---- Playback ----
  $('scrub').oninput = () => seek($('scrub').value / 100000);
  function setPlayUi() { const b = $('play'); b.innerHTML = svg(playing ? 'pause' : 'play', 'fill'); b.setAttribute('aria-label', playing ? 'Pause' : 'Play'); }
  // While the replay plays the camera is driven by the animation, so the map ignores touches and the replay keeps going.
  // Pause it and the map is free to pan and zoom again.
  function lockMap(on) { if (!map) return; for (const h of ['dragging', 'touchZoom', 'doubleClickZoom', 'scrollWheelZoom', 'boxZoom', 'keyboard', 'tapHold']) if (map[h]) map[h][on ? 'disable' : 'enable'](); }
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
    if (frac >= 1 && goDay(1, true)) return;                  // pressing play on a finished day continues with the next one
    if (frac >= 1) frac = 0;
    startPlay();
  };
  window.__tl = () => { const el = marker && marker.getElement(), cur = scenes.items.length ? locate(frac * scenes.V).s : null; return { zoom: map.getZoom(), heading, frac, V: scenes.V, items: scenes.items.map((s) => (s.kind === 'move' ? s.mode : 'stay')), cur: cur ? (cur.kind === 'move' ? cur.mode : 'stay') : null, car: !!(el && el.classList.contains('drive')), timeline: timeline.length, day: curDay, playing, dragging: !!(map && map.dragging.enabled()) }; };   // test hook (read-only)

  async function dataInfo() {
    const el = $('dinfo'); if (!el) return;
    let t = savedMeta ? 'Saved copy: ' + mb(savedMeta.size) + ' (' + savedMeta.where + ')' : 'No saved copy' + (saveErr ? ' — ' + saveErr : '');
    try { if (navigator.storage) { const p = await navigator.storage.persisted(), est = await navigator.storage.estimate(); t += ' · protected: ' + (p ? 'yes' : 'no') + ' · site storage ' + mb(est.usage) + ' of ' + mb(est.quota); } } catch (e) {}
    el.textContent = t;
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
    map.invalidateSize();
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
    const p = askPlace, card = $('ask').querySelector('.card'), l = labelFor(p), q = questionFor(p), ctx = ctxText(p);
    const prog = askQueue.length > 1 ? '<div class="progress">Question ' + (askIdx + 1) + ' of ' + askQueue.length + '</div>' : '';
    const foot = '<div class="askfoot"><button class="ghost" id="askLater" type="button">' + (l ? 'Cancel' : 'Not now') + '</button>' +
      (l ? '<button class="ghost danger" id="askRemove" type="button">Remove name</button>' : '<button class="ghost" id="askNever" type="button">Don’t ask about this place</button>') + '</div>';
    if (askStage === 'confirm') {
      const kd = kindById[q.kind];
      card.innerHTML = '<div class="grab"></div>' + prog + '<div class="askhead"><span class="askicon" style="--c:' + kd.color + '">' + svg(kd.icon) + '</span><div><h3 id="askTitle">' + q.title + '</h3><p>' + esc(q.why) + ' ' + esc(ctx) + '.</p></div></div>' +
        '<div class="answers"><button class="btn primary" id="askYes" type="button">' + svg('check') + 'Yes, it’s my ' + esc(kd.label.toLowerCase()) + '</button><button class="btn" id="askNo" type="button">No, it’s something else</button></div>' + foot;
    } else {
      const title = l ? 'Rename this place' : 'What is this place for you?';
      card.innerHTML = '<div class="grab"></div>' + prog + '<div class="askhead"><span class="askicon">' + svg('pin') + '</span><div><h3 id="askTitle">' + title + '</h3><p>' + esc(ctx) + (p.googleName ? ' · Google calls it “' + esc(p.googleName) + '”' : '') + '.</p></div></div>' +
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
    const screens = st.bundle ? new Date(st.bundle * 1000).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'the version in the app';
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
    if (!data) { if (st.fixes > 0) reloadSources(); else $('status').textContent = recState(st).key === 'on' ? 'Recording is on. Your first trip appears here after you start moving.' : $('status').textContent; }
    else if (prev >= 0 && st.fixes !== prev && !playing && $('ask').hidden) reloadSources().then(() => toast('Updated with your latest recordings', 2500));
  }
  window.__tlNativeChanged = refreshNative;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshNative(); });

  // ---- Insights ----
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
      return `<li><button class="row" type="button" data-pid="${p.id}" style="--c:${kd ? kd.color : 'var(--accent)'}"><span class="ico">${svg(kd ? kd.icon : 'pin')}</span><div class="grow"><div class="top"><b>${nm ? esc(nm) : '<i class="unnamed">Unnamed place</i>'}</b><span>${Math.round(p.hours).toLocaleString()} h</span></div><div class="sub">${p.visits} visit${p.visits > 1 ? 's' : ''}${hint}</div><div class="meter"><i style="width:${Math.max(3, (p.hours / maxH) * 100)}%"></i></div></div>${named ? `<span class="editdot">${svg('pencil')}</span>` : '<span class="pill">Name it</span>'}</button></li>`;
    }).join('');
    const sw = (id, label, on) => `<button class="switch" id="${id}" role="switch" aria-checked="${on}" aria-label="${label}" type="button"><span></span></button>`;
    el.innerHTML = `<div class="page"><div id="recWrap"></div><div id="updWrap"></div>` +
      `<div class="card hero-card"><h2>${year ?? 'All time'} in review</h2><div class="big num">${Math.round(s.totalKm).toLocaleString()}<small>km travelled</small></div><p>Across ${s.visitCount.toLocaleString()} stops and ${s.uniquePlaces.toLocaleString()} different places.</p></div>` +
      `<div class="tiles"><div class="tile"><b>${s.activeDays.toLocaleString()}</b><span>active days</span></div><div class="tile"><b>${s.uniquePlaces.toLocaleString()}</b><span>different places</span></div>` +
      (s.longest ? `<div class="tile"><b>${fmtKm(s.longest.dist / 1000).replace(' km', '')}<small style="font-size:13px;color:var(--text-2);font-weight:600"> km</small></b><span>longest ${MODE_NAME[s.longest.mode].toLowerCase()} leg</span></div>` : '') + `</div>` +
      `<div class="card"><h2>How you travelled</h2><ul class="rows">${modeRows || '<li class="empty">No trips yet.</li>'}</ul></div>` +
      `<div class="card"><h2>Your places</h2>${pend ? `<div class="cta"><div class="t"><b>${pend} place${pend > 1 ? 's need' : ' needs'} a name</b><span>A quick question about each.</span></div><button class="btn primary sm" id="askStart" type="button">Start</button></div>` : ''}<ul class="rows">${placeRows || '<li class="empty">No stops yet.</li>'}</ul></div>` +
      `<div class="card"><h2>Playback</h2>` +
      `<div class="setting"><div class="t"><b>Keep screen on</b><span id="awakeNote"></span></div>${sw('swAwake', 'Keep screen on', keepOn)}</div>` +
      `<div class="setting"><div class="t"><b>Continue to the next day</b><span>When a day ends, the replay moves on and keeps playing.</span></div>${sw('swNext', 'Continue to the next day', autoNext)}</div></div>` +
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
