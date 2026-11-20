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
  let data = null, timeline = [], map, dayLayer, marker;
  const DAY = 86400000;
  const MODE_COLOR = { drive: '#f87171', walk: '#4ade80', run: '#86efac', bike: '#facc15', transit: '#a78bfa', flight: '#fb923c', other: '#94a3b8' };
  const MODE_NAME = { drive: 'Driving', walk: 'Walking', run: 'Running', bike: 'Cycling', transit: 'Transit', flight: 'Flying', other: 'Moving' };
  const MODE_ICON = { drive: '🚗', walk: '🚶', run: '🏃', bike: '🚲', transit: '🚆', flight: '✈️', other: '•' };

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
  const fail = (msg) => { if (data) alert(msg); else { $('import').style.visibility = 'visible'; $('pick').style.display = ''; $('status').textContent = msg; } };
  // sources: [{ name, text() }]. Parse everything first; only keep the copy once it parsed fine.
  async function loadFromSources(sources, save) {
    const merged = { visits: [], trips: [], points: [], hints: [] }, keep = [];
    try {
      for (const f of sources) {
        $('status').textContent = 'Reading ' + f.name + '…';
        const json = JSON.parse(await f.text());
        const d = TL.parseTimeline(json);
        // concat, not push(...arr): spreading a huge array overflows the call stack.
        merged.visits = merged.visits.concat(d.visits); merged.trips = merged.trips.concat(d.trips); merged.points = merged.points.concat(d.points); merged.hints = merged.hints.concat(d.hints);
        if (save) keep.push({ name: f.name, text: JSON.stringify(slim(json)) });
      }
    } catch (err) {
      // Show where it failed (first stack frames only; no file contents) to make problems diagnosable.
      const where = String(err.stack || '').split('\n').slice(1, 3).map((x) => x.trim().replace(/^at /, '').slice(0, 80)).join(' | ');
      fail('Could not read file: ' + err.message + (where ? ' [' + where + ']' : ''));
      return false;
    }
    let res = null;
    if (save) {
      res = await saveFiles(keep);
      if (res.ok) { savedMeta = { size: res.size, where: res.where }; saveErr = ''; if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); }
      else { savedMeta = null; saveErr = res.error; }
    }
    try { $('status').textContent = 'Analyzing your movements…'; await new Promise((r) => setTimeout(r, 30)); start(merged); }
    catch (err) { fail('Could not analyse the data: ' + err.message); return false; }
    if (res) toast(res.ok ? 'Saved on this phone · ' + mb(res.size) : "Couldn't save a copy: " + res.error, res.ok ? 3500 : 9000);
    return true;
  }
  $('pick').onclick = () => $('file').click();
  $('file').onchange = (e) => {
    const files = [...e.target.files];
    e.target.value = '';                                     // allow picking the same file again later
    if (files.length) loadFromSources(files.map((f) => ({ name: f.name, text: () => f.text() })), true);
  };

  function start(d) {
    d.visits.sort((a, b) => a.start - b.start); d.trips.sort((a, b) => a.start - b.start);
    if (map) { stop(); map.remove(); map = null; }           // "Change file" while the app is open
    data = d; timeline = TL.analyze(d);
    $('import').style.display = 'none';
    $('app').style.display = 'flex';
    initMap(); initDays(); renderStats();
    document.querySelector('nav button').click();
  }

  // ---- Tabs ----
  document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
    $('mapView').style.display = b.dataset.v === 'map' ? 'block' : 'none';
    $('statsView').style.display = b.dataset.v === 'stats' ? 'block' : 'none';
    if (b.dataset.v === 'map') map.invalidateSize();
  }));

  // ---- Map & replay ----
  function initMap() {
    map = L.map('map', { zoomControl: false, zoomSnap: 0 });
    map.getContainer().addEventListener('pointerdown', () => stop());   // touching the map pauses the replay
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
  function initDays() {
    const days = new Set(), trips = new Map(), stops = new Map();
    let inTrip = false;
    for (const it of timeline) {
      if (it.kind === 'stay') {
        for (let d = dayKey(it.t0), n = 0; d < it.t1 && n < 31; d = dayKey(d + DAY + 7200000), n++) days.add(d);
        stops.set(dayKey(it.t0), (stops.get(dayKey(it.t0)) || 0) + 1); inTrip = false;
      } else {
        days.add(dayKey(it.t0));
        if (!inTrip) trips.set(dayKey(it.t0), (trips.get(dayKey(it.t0)) || 0) + 1);   // consecutive legs = one trip
        inTrip = true;
      }
    }
    const sorted = [...days].sort((a, b) => a - b), nTrips = (d) => trips.get(d) || 0;
    $('day').innerHTML = sorted.map((d) => `<option value="${d}">${new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}${nTrips(d) ? ' · ' + nTrips(d) + ' trip' + (nTrips(d) > 1 ? 's' : '') : ''}</option>`).join('');
    $('day').onchange = () => showDay(+$('day').value);
    const pick = [...sorted].reverse().find((d) => nTrips(d) > 0) ?? sorted[sorted.length - 1];   // latest day with movement
    if (pick != null) showDay(pick), ($('day').value = pick);
  }

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
        if (t1 - t0 >= MIN_STAY) raw.push({ kind: 'stay', t0, t1, lat: it.lat, lng: it.lng, name: it.name, nd: it.nd });
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
    '<rect x="3" y="2" width="18" height="40" rx="8" fill="#38bdf8" stroke="#fff" stroke-width="2"/>' +
    '<rect x="6" y="10" width="12" height="9" rx="2.5" fill="#0b1220" opacity=".85"/><rect x="7" y="29" width="10" height="6" rx="2" fill="#0b1220" opacity=".6"/>' +
    '<rect x="5.5" y="3.5" width="3.5" height="2" rx="1" fill="#fde68a"/><rect x="15" y="3.5" width="3.5" height="2" rx="1" fill="#fde68a"/></svg></div>';

  function showDay(d) {
    stop(); map.invalidateSize(); dayLayer.clearLayers(); hudKey = ''; trailColor = ''; heading = 0; badgeMode = ''; litKey = null;
    scenes = buildScenes(d);
    const items = scenes.items, byMode = {};
    let still = 0;
    for (const s of items) {
      if (s.kind === 'move') {
        byMode[s.mode] = (byMode[s.mode] || 0) + s.len;
        s.line = L.polyline(s.path, { color: s.color, weight: 3, opacity: 0.4, dashArray: s.uncertain ? '2 8' : null, interactive: false }).addTo(dayLayer);
      } else {
        still += s.t1 - s.t0;
        const r = Math.min(18, 7 + 3 * Math.sqrt((s.t1 - s.t0) / 3.6e6));            // bigger circle = longer stay
        L.circleMarker([s.lat, s.lng], { radius: r, color: '#fff', weight: 2, fillColor: '#f43f5e', fillOpacity: 0.55 })
          .bindTooltip(s.name + ' · ' + clock(s.t0) + '–' + clock(s.t1) + ' (' + fmtDur(s.t1 - s.t0) + ')').addTo(dayLayer);
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
  function renderBar(items, byMode, still) {
    const V = scenes.V || 1, px = $('bar').clientWidth || 340;
    $('bar').innerHTML = items.map((s) => {
      const left = (s.v0 / V) * 100, w = (s.vlen / V) * 100;
      return s.kind === 'move'
        ? `<div class="seg" style="left:${left}%;width:${w}%;background:${s.color}"></div>`
        : `<div class="seg still" style="left:${left}%;width:${w}%">${(s.vlen / V) * px >= 24 ? '<span>' + shortDur(s.t1 - s.t0) + '</span>' : ''}</div>`;
    }).join('');
    const parts = Object.entries(byMode).sort((a, b) => b[1] - a[1]).map(([m, d]) => MODE_ICON[m] + ' ' + (d >= 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m'));
    $('summary').textContent = items.length ? ['still ' + fmtDur(still)].concat(parts).join(' · ') : '';
  }

  function seek(fr) { try { seekInner(fr); } catch (e) { console.error(e); setHud('Replay error', String(e.message).slice(0, 60)); } }
  function seekInner(fr) {
    frac = fr;
    $('fill').style.width = fr * 100 + '%'; $('playhead').style.left = fr * 100 + '%';
    if (!scenes.items.length) { setHud('--:--', 'no data for this day'); return; }
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
    if (mode !== badgeMode) { badgeMode = mode; if (badgeEl) badgeEl.textContent = MODE_ICON[mode] || ''; }
    const sub = s.kind === 'stay' ? s.name + ' · ' + fmtDur((s.t1 - s.t0) * f)
      : s.uncertain ? 'Travelled · no data in between' : MODE_NAME[mode] + ' · ' + Math.round(s.med * 3.6) + ' km/h · ' + (left / 1000).toFixed(1) + ' km left';
    setHud(clock(t), sub);
  }
  function setHud(a, b) { const key = a + '|' + b; if (key !== hudKey) { hudKey = key; $('hudTime').textContent = a; $('hudSub').textContent = b; } }

  $('scrub').oninput = () => seek($('scrub').value / 100000);
  function stop() { playing = false; cancelAnimationFrame(raf); $('play').textContent = '▶ Play'; }
  function tick(ts) {
    if (!playing) return;
    const dt = Math.min(80, ts - lastTs); lastTs = ts;
    seek(Math.min(1, frac + (dt * +$('speed').value) / scenes.V));
    $('scrub').value = Math.round(frac * 100000);
    if (frac >= 1) return stop();
    raf = requestAnimationFrame(tick);
  }
  $('play').onclick = () => {
    if (playing) return stop();
    if (!scenes.items.length) return;
    if (frac >= 1) frac = 0;
    playing = true; $('play').textContent = '⏸ Pause'; lastTs = performance.now();
    raf = requestAnimationFrame(tick);
  };
  window.__tl = () => { const el = marker && marker.getElement(), cur = scenes.items.length ? locate(frac * scenes.V).s : null; return { zoom: map.getZoom(), heading, frac, V: scenes.V, items: scenes.items.map((s) => (s.kind === 'move' ? s.mode : 'stay')), cur: cur ? (cur.kind === 'move' ? cur.mode : 'stay') : null, car: !!(el && el.classList.contains('drive')), timeline: timeline.length }; };   // test hook (read-only)

  async function dataInfo() {
    const el = $('dinfo'); if (!el) return;
    let t = savedMeta ? 'Saved copy: ' + mb(savedMeta.size) + ' (' + savedMeta.where + ')' : 'No saved copy' + (saveErr ? ' — ' + saveErr : '');
    try { if (navigator.storage) { const p = await navigator.storage.persisted(), est = await navigator.storage.estimate(); t += ' · protected: ' + (p ? 'yes' : 'no') + ' · site storage ' + mb(est.usage) + ' of ' + mb(est.quota); } } catch (e) {}
    el.textContent = t;
  }

  // ---- Stats ----
  function renderStats() {
    const years = [...new Set(timeline.map((s) => new Date(s.t0).getFullYear()))].sort();
    const year = years[years.length - 1] ?? null;
    const s = TL.statsFromTimeline(timeline, year);
    const el = $('statsView');
    const card = (big, lbl) => `<div class="card"><div class="big">${big}</div><div class="lbl">${lbl}</div></div>`;
    const modes = Object.entries(s.byModeKm).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<li>${MODE_ICON[k]} ${MODE_NAME[k]}: ${v.toFixed(1)} km</li>`).join('');
    const top = s.topPlaces.map((p) => `<li>${p.name || p.lat.toFixed(3) + ', ' + p.lng.toFixed(3)} — ${p.hours.toFixed(0)} h (${p.visits} visits)</li>`).join('');
    el.innerHTML = `<h2 style="margin-top:0">${year ?? 'All time'} in review</h2>` +
      card(s.totalKm.toFixed(0) + ' km', 'distance travelled') +
      card(s.activeDays, 'days with recorded movement') +
      card(s.uniquePlaces, `different places (${s.visitCount} visits)`) +
      (s.longest ? card((s.longest.dist / 1000).toFixed(1) + ' km', `longest single leg (${MODE_NAME[s.longest.mode].toLowerCase()}, ${new Date(s.longest.start).toLocaleDateString()})`) : '') +
      `<div class="card"><div class="lbl">By how you travelled</div><ul>${modes || '<li>none</li>'}</ul></div>` +
      `<div class="card"><div class="lbl">Where you spent the most time</div><ul>${top || '<li>none</li>'}</ul></div>` +
      `<div class="card"><div class="lbl">Your data is saved only on this phone.</div><div id="dinfo" class="lbl" style="margin-top:6px"></div><p style="margin:10px 0 0"><button class="btn2" id="chg">Change file</button> <button class="btn2" id="forget">Forget my data</button></p></div>`;
    $('chg').onclick = () => $('file').click();
    $('forget').onclick = async () => { await clearFiles(); location.reload(); };
    dataInfo();
  }

  // Self-updating: check for a new version on every open, and reload into it automatically
  // while still on the import screen (never mid-session, so loaded data isn't lost).
  // Open the saved copy automatically; show the picker only when there is none (or it can't be read).
  $('import').style.visibility = 'hidden';
  loadFiles().then((saved) => {
    if (saved && saved.length) {
      $('import').style.visibility = 'visible'; $('pick').style.display = 'none'; $('status').textContent = 'Loading your saved timeline…';
      return loadFromSources(saved.map((e) => ({ name: e.name, text: () => (e.text != null ? Promise.resolve(e.text) : e.blob.text()) })), false);
    }
    $('import').style.visibility = 'visible';
  }).catch(() => { $('import').style.visibility = 'visible'; });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !data) location.reload(); });
    navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => {});
  }
})();
