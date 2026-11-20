(function () {
  const $ = (id) => document.getElementById(id);
  let data = null, map, dayLayer, marker, timer = null;
  const DAY = 86400000;
  const COLORS = { walking: '#4ade80', 'on foot': '#4ade80', cycling: '#facc15', 'in passenger vehicle': '#f87171', driving: '#f87171', 'in train': '#a78bfa', 'in subway': '#a78bfa', flying: '#fb923c', path: '#38bdf8', unknown: '#94a3b8' };

  // ---- Remember the file: a private copy kept in this browser's own storage on this device ----
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open('timeline', 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const tx = async (mode, fn) => { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('files', mode), q = fn(t.objectStore('files')); t.oncomplete = () => res(q && q.result); t.onerror = t.onabort = () => rej(t.error); }); };
  const saveFiles = (list) => tx('readwrite', (st) => st.put(list, 'current')).catch(() => {});          // list: [{ name, blob }]
  const loadFiles = () => tx('readonly', (st) => st.get('current')).catch(() => null);
  const clearFiles = () => tx('readwrite', (st) => st.delete('current')).catch(() => {});

  // ---- Import ----
  const fail = (msg) => { if (data) alert(msg); else { $('import').style.visibility = 'visible'; $('pick').style.display = ''; $('status').textContent = msg; } };
  // sources: [{ name, text() }]. Parse everything first; only keep the copy once it parsed fine.
  async function loadFromSources(sources, save) {
    const merged = { visits: [], trips: [], points: [] }, keep = [];
    try {
      for (const f of sources) {
        $('status').textContent = 'Reading ' + f.name + '…';
        const text = await f.text();
        const d = TL.parseTimeline(JSON.parse(text));
        // concat, not push(...arr): spreading a huge array overflows the call stack.
        merged.visits = merged.visits.concat(d.visits); merged.trips = merged.trips.concat(d.trips); merged.points = merged.points.concat(d.points);
        if (save) keep.push({ name: f.name, blob: new Blob([text], { type: 'application/json' }) });
      }
    } catch (err) {
      // Show where it failed (first stack frames only; no file contents) to make problems diagnosable.
      const where = String(err.stack || '').split('\n').slice(1, 3).map((x) => x.trim().replace(/^at /, '').slice(0, 80)).join(' | ');
      fail('Could not read file: ' + err.message + (where ? ' [' + where + ']' : ''));
      return false;
    }
    if (save) { await saveFiles(keep); if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); }
    start(merged);
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
    data = d;
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
    const all = data.visits.map((v) => [v.lat, v.lng]).concat(data.points.map((p) => [p.lat, p.lng]));
    // Background dots: draw on a canvas and cap at ~3k points so big files stay fast on a phone.
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
    const days = new Set();
    data.visits.forEach((v) => days.add(dayKey(v.start)));
    data.trips.forEach((t) => days.add(dayKey(t.start)));
    data.points.forEach((p) => days.add(dayKey(p.t)));
    const sorted = [...days].filter((d) => !isNaN(d)).sort((a, b) => a - b);
    const cnt = new Map();                                   // trips per day (GPS 'path' pieces only if there is nothing else)
    for (const t of data.trips) { const k = dayKey(t.start), c = cnt.get(k) || { a: 0, p: 0 }; if (t.type === 'path') c.p++; else c.a++; cnt.set(k, c); }
    const trips = (d) => { const c = cnt.get(d); return c ? c.a || c.p : 0; };
    const stopsBy = new Map(); for (const v of data.visits) stopsBy.set(dayKey(v.start), (stopsBy.get(dayKey(v.start)) || 0) + 1);
    const stops = (d) => stopsBy.get(d) || 0;
    $('day').innerHTML = sorted.map((d) => `<option value="${d}">${new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}${trips(d) ? ' · ' + trips(d) + ' trip' + (trips(d) > 1 ? 's' : '') : stops(d) > 1 ? ' · ' + stops(d) + ' stops' : ''}</option>`).join('');
    $('day').onchange = () => showDay(+$('day').value);
    const pick = [...sorted].reverse().find((d) => trips(d) > 0 || stops(d) > 1) ?? sorted[sorted.length - 1];   // latest day with movement
    if (pick != null) showDay(pick), ($('day').value = pick);
  }

  // ---- Scenes: a day is an alternating list of moves and stays ----
  // The replay runs on its own "animation clock" (ms): a move takes 4.5-14 s depending on distance,
  // a stay is a ~2 s fast-forward of the real clock. Everything on screen is a pure function of that clock.
  const MIN_STAY = 2 * 60000, MIN_GAP = 10 * 60000, STAY_MS = 2200, Z_IN = 17;
  let scenes = { items: [], V: 0 }, frac = 0, heading = 0, playing = false, lastTs = 0, raf = 0;
  let trail, trailGlow, trailColor = '', carEl, hudKey = '';

  const sm = (x) => x * x * (3 - 2 * x);                                  // smoothstep
  const win = (a, b, x) => sm(Math.min(1, Math.max(0, (x - a) / (b - a))));
  const easeMove = (f) => f + 0.75 * (sm(f) - f);                         // slow -> fast -> slow
  const fmtDur = (ms) => { const m = Math.round(ms / 60000), h = Math.floor(m / 60); return h ? h + ' h' + (m % 60 ? ' ' + (m % 60) + ' m' : '') : m + ' m'; };
  const shortDur = (ms) => ms >= 3.6e6 ? (ms / 3.6e6).toFixed(1).replace(/\.0$/, '') + 'h' : Math.round(ms / 60000) + 'm';
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const modeName = (t) => ({ 'in passenger vehicle': 'Driving', driving: 'Driving', walking: 'Walking', 'on foot': 'Walking', running: 'Running', cycling: 'Cycling', 'in train': 'Train', 'in subway': 'Metro', 'in bus': 'Bus', flying: 'Flying' })[t] || 'Moving';
  function placeLabel(v) {
    const n = v.name || '';
    if (n && !/^[A-Za-z0-9_-]{20,}$/.test(n)) return n;           // skip opaque place IDs
    const t = (v.type || '').toLowerCase().replace(/_/g, ' ');
    return t && t !== 'unknown' && t !== 'place' ? t[0].toUpperCase() + t.slice(1) : 'Stopped';
  }
  function bearing(a, b) {
    const dy = b[0] - a[0], dx = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) * Math.PI) / 360);
    return dx === 0 && dy === 0 ? null : ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  }

  function makeMove(path, t0, t1, type) {
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + TL.haversine(path[i - 1], path[i]));
    const len = cum[cum.length - 1];
    return { kind: 'move', t0, t1, type, path, cum, len, bounds: L.latLngBounds(path), vlen: len < 30 ? 1500 : Math.min(14000, 4500 + 1600 * Math.sqrt(len / 1000)) };
  }
  // Point (and segment index) at a distance along a move; binary search over cumulative distance.
  function pointAt(s, d) {
    if (s.len <= 0) return { ll: s.path[0], k: 1 };
    d = Math.max(0, Math.min(s.len, d));
    let lo = 1, hi = s.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (s.cum[mid] < d) lo = mid + 1; else hi = mid; }
    const a = s.path[lo - 1], b = s.path[lo], u = (d - s.cum[lo - 1]) / (s.cum[lo] - s.cum[lo - 1] || 1);
    return { ll: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], k: lo };
  }
  const startBearing = (s) => { const d = Math.max(25, s.len * 0.02); return bearing(s.path[0], pointAt(s, d).ll); };
  const endBearing = (s) => { const d = Math.max(25, s.len * 0.02); return bearing(pointAt(s, s.len - d).ll, s.path[s.path.length - 1]); };

  // Records.json has no visits: derive stays where the points stay within 150 m for 10+ minutes.
  function scenesFromPoints(d, end, items) {
    const pts = data.points.filter((p) => p.t >= d && p.t < end).sort((a, b) => a.t - b.t);
    const ll = (p) => [p.lat, p.lng];
    let run = [], i = 0;
    const flush = () => { if (run.length > 1) items.push(makeMove(run.map(ll), run[0].t, run[run.length - 1].t, 'path')); run = []; };
    while (i < pts.length) {
      let j = i;
      while (j + 1 < pts.length && TL.haversine(ll(pts[i]), ll(pts[j + 1])) < 150) j++;
      if (pts[j].t - pts[i].t >= 10 * 60000) {
        run.push(pts[i]); flush();
        items.push({ kind: 'stay', t0: pts[i].t, t1: pts[j].t, lat: pts[i].lat, lng: pts[i].lng, name: 'Stopped' });
        i = j + 1;
      } else { run.push(pts[i]); i++; }
    }
    flush();
  }

  function buildScenes(d) {
    const end = d + DAY, items = [];
    const trips = data.trips.filter((t) => t.start >= d && t.start < end && t.path.length >= 2);
    const paths = trips.filter((t) => t.type === 'path'), used = new Set();
    for (const a of trips.filter((t) => t.type !== 'path')) {
      const p = paths.find((q) => !used.has(q) && q.start < a.end && q.end > a.start);   // richer GPS geometry, if any
      if (p) used.add(p);
      items.push(makeMove(p ? p.path : a.path, a.start, a.end, a.type));
    }
    for (const p of paths) if (!used.has(p)) items.push(makeMove(p.path, p.start, p.end, 'path'));
    for (const v of data.visits) {
      const t0 = Math.max(v.start, d), t1 = Math.min(v.end, end);
      if (t1 - t0 >= MIN_STAY) items.push({ kind: 'stay', t0, t1, lat: v.lat, lng: v.lng, name: placeLabel(v) });
    }
    if (!items.length) scenesFromPoints(d, end, items);
    items.sort((a, b) => a.t0 - b.t0);
    const out = [];
    for (const it of items) {
      const prev = out[out.length - 1];
      if (prev && prev.kind === 'stay' && it.kind === 'stay' && TL.haversine([prev.lat, prev.lng], [it.lat, it.lng]) > 100) {
        // arrived somewhere, then somewhere else, with no recorded trip between: draw the leg between them
        out.push(makeMove([[prev.lat, prev.lng], [it.lat, it.lng]], prev.t1, Math.max(prev.t1, it.t0), 'unknown'));
      } else if (prev && prev.kind === 'move' && it.t0 - prev.t1 > MIN_GAP) {   // unexplained gap after a move = time spent where it ended
        const q = prev.path[prev.path.length - 1];
        if (it.kind === 'move' || TL.haversine(q, [it.lat, it.lng]) > 150) out.push({ kind: 'stay', t0: prev.t1, t1: it.t0, lat: q[0], lng: q[1], name: 'Stopped' });
      }
      out.push(it);
    }
    let off = 0;
    out.forEach((s, i) => { if (s.kind === 'stay') s.vlen = STAY_MS; s.v0 = off; off += s.vlen; s.prev = out[i - 1]; s.next = out[i + 1]; });
    return { items: out, V: off };
  }

  function locate(v) {
    let s = scenes.items[0];
    for (const it of scenes.items) { if (it.v0 <= v) s = it; else break; }
    const f0 = Math.min(1, Math.max(0, (v - s.v0) / s.vlen));
    if (s.kind === 'stay') { const f = sm(f0); return { s, f, p: 0, t: s.t0 + (s.t1 - s.t0) * f, ll: [s.lat, s.lng] }; }
    const p = easeMove(f0), d = s.len * p, cur = pointAt(s, d), step = Math.max(25, s.len * 0.02);
    const bear = s.len > 0 ? bearing(pointAt(s, d - step / 2).ll, pointAt(s, d + step).ll) : null;
    return { s, f: f0, p, t: s.t0 + (s.t1 - s.t0) * p, ll: cur.ll, k: cur.k, bear };
  }

  // Camera: zoomed in on the car by default; during a move the view grows from "street level around the car"
  // to "the whole trip", holds, then shrinks back. Interpolating the view *box* (not zoom and centre separately)
  // guarantees the car is always inside the frame. The same easing drives the car's speed.
  function cameraFor(s, p, carLL) {
    if (s.kind === 'stay') return { center: [s.lat, s.lng], zoom: Z_IN };
    const size = map.getSize(), sx = Math.max(50, size.x - 70), sy = Math.max(50, size.y - 90);
    if (!s.tb) {                                    // trip box in pixels at street zoom
      const a = map.project(s.bounds.getSouthWest(), Z_IN), b = map.project(s.bounds.getNorthEast(), Z_IN);
      s.tb = { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) };
    }
    const c = map.project(carLL, Z_IN), w = win(0, 0.2, p) * (1 - win(0.8, 1, p)), lerp = (a, b) => a + (b - a) * w;
    const x0 = lerp(c.x - sx / 2, Math.min(c.x - sx / 2, s.tb.x0)), x1 = lerp(c.x + sx / 2, Math.max(c.x + sx / 2, s.tb.x1));
    const y0 = lerp(c.y - sy / 2, Math.min(c.y - sy / 2, s.tb.y0)), y1 = lerp(c.y + sy / 2, Math.max(c.y + sy / 2, s.tb.y1));
    const zoom = Math.max(2, Z_IN - Math.log2(Math.max((x1 - x0) / sx, (y1 - y0) / sy)));
    const ctr = map.unproject(L.point((x0 + x1) / 2, (y0 + y1) / 2), Z_IN);
    return { center: [ctr.lat, ctr.lng], zoom };
  }

  const CAR = '<div class="ring"></div><div class="carwrap"><svg viewBox="0 0 24 44" width="30" height="55">' +
    '<rect x="0.5" y="8" width="3" height="9" rx="1.5" fill="#0b1220"/><rect x="20.5" y="8" width="3" height="9" rx="1.5" fill="#0b1220"/>' +
    '<rect x="0.5" y="27" width="3" height="9" rx="1.5" fill="#0b1220"/><rect x="20.5" y="27" width="3" height="9" rx="1.5" fill="#0b1220"/>' +
    '<rect x="3" y="2" width="18" height="40" rx="8" fill="#38bdf8" stroke="#fff" stroke-width="2"/>' +
    '<rect x="6" y="10" width="12" height="9" rx="2.5" fill="#0b1220" opacity=".85"/><rect x="7" y="29" width="10" height="6" rx="2" fill="#0b1220" opacity=".6"/>' +
    '<rect x="5.5" y="3.5" width="3.5" height="2" rx="1" fill="#fde68a"/><rect x="15" y="3.5" width="3.5" height="2" rx="1" fill="#fde68a"/></svg></div>';

  function showDay(d) {
    stop(); map.invalidateSize(); dayLayer.clearLayers(); hudKey = ''; trailColor = ''; heading = 0;
    scenes = buildScenes(d);
    const items = scenes.items;
    let moving = 0, still = 0;
    for (const s of items) {
      if (s.kind === 'move') {
        moving += s.t1 - s.t0;
        L.polyline(s.path, { color: COLORS[s.type] || COLORS.unknown, weight: 3, opacity: 0.4, interactive: false }).addTo(dayLayer);
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
    carEl = marker.getElement().querySelector('.carwrap');
    renderBar(items, moving, still);
    $('scrub').value = 0; seek(0);
  }

  // Timeline bar: coloured blocks = movement, hatched blocks = time spent still (with its duration).
  function renderBar(items, moving, still) {
    const V = scenes.V || 1, px = $('bar').clientWidth || 340;
    $('bar').innerHTML = items.map((s) => {
      const left = (s.v0 / V) * 100, w = (s.vlen / V) * 100;
      return s.kind === 'move'
        ? `<div class="seg" style="left:${left}%;width:${w}%;background:${COLORS[s.type] || COLORS.unknown}"></div>`
        : `<div class="seg still" style="left:${left}%;width:${w}%">${(s.vlen / V) * px >= 24 ? '<span>' + shortDur(s.t1 - s.t0) + '</span>' : ''}</div>`;
    }).join('');
    $('summary').textContent = items.length ? 'moving ' + fmtDur(moving) + ' · still ' + fmtDur(still) : '';
  }

  function seek(fr) { try { seekInner(fr); } catch (e) { console.error(e); setHud('Replay error', String(e.message).slice(0, 60)); } }
  function seekInner(fr) {
    frac = fr;
    $('fill').style.width = fr * 100 + '%'; $('playhead').style.left = fr * 100 + '%';
    if (!scenes.items.length) { setHud('--:--', 'no data for this day'); return; }
    const { s, f, p, t, ll, k, bear } = locate(fr * scenes.V);
    const cam = cameraFor(s, p, ll);
    map.setView(cam.center, cam.zoom, { animate: false });
    marker.setLatLng(ll);
    // trail: the part of the current move already driven (or the whole previous move while parked)
    const src = s.kind === 'move' ? s : s.prev && s.prev.kind === 'move' ? s.prev : null;
    const color = src ? COLORS[src.type] || COLORS.unknown : '';
    if (color !== trailColor) { trailColor = color; if (color) { trail.setStyle({ color }); trailGlow.setStyle({ color }); } }
    const pts = !src ? [] : s.kind === 'move' ? src.path.slice(0, k).concat([ll]) : src.path;
    trail.setLatLngs(pts); trailGlow.setLatLngs(pts);
    // heading: face the direction of travel; while parked, turn toward the next route
    let target = s.kind === 'move' ? bear : s.next && s.next.kind === 'move' ? startBearing(s.next) : s.prev && s.prev.kind === 'move' ? endBearing(s.prev) : null;
    if (target != null) heading = (heading + (((target - heading + 540) % 360) - 180) * 0.3 + 360) % 360;
    if (carEl) carEl.style.transform = 'rotate(' + heading.toFixed(1) + 'deg)';
    const el = marker.getElement(); if (el) el.classList.toggle('stay', s.kind === 'stay');
    const sub = s.kind === 'stay' ? s.name + ' · ' + fmtDur((s.t1 - s.t0) * f) : modeName(s.type) + ' · ' + (Math.max(0, s.len * (1 - p)) / 1000).toFixed(1) + ' km left';
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
  window.__tl = () => ({ zoom: map.getZoom(), heading, frac, V: scenes.V });   // test hook (read-only)

  // ---- Stats ----
  function renderStats() {
    const years = [...new Set(data.visits.map((v) => new Date(v.start).getFullYear()).concat(data.trips.map((t) => new Date(t.start).getFullYear())))].sort();
    const year = years[years.length - 1] ?? null;
    const s = TL.computeStats(data, year);
    const el = $('statsView');
    const card = (big, lbl) => `<div class="card"><div class="big">${big}</div><div class="lbl">${lbl}</div></div>`;
    const modes = Object.entries(s.byTypeKm).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<li>${k}: ${v.toFixed(1)} km</li>`).join('');
    const top = s.topPlaces.map((p) => `<li>${p.name || p.lat.toFixed(3) + ', ' + p.lng.toFixed(3)} — ${p.hours.toFixed(0)} h (${p.visits} visits)</li>`).join('');
    el.innerHTML = `<h2 style="margin-top:0">${year ?? 'All time'} in review</h2>` +
      card(s.totalKm.toFixed(0) + ' km', 'distance travelled') +
      card(s.activeDays, 'days with recorded movement') +
      card(s.uniquePlaces, `different places (${s.visitCount} visits)`) +
      (s.longest ? card((s.longest.dist / 1000).toFixed(1) + ' km', `longest single trip (${s.longest.type}, ${new Date(s.longest.start).toLocaleDateString()})`) : '') +
      `<div class="card"><div class="lbl">By activity</div><ul>${modes || '<li>none</li>'}</ul></div>` +
      `<div class="card"><div class="lbl">Where you spent the most time</div><ul>${top || '<li>none</li>'}</ul></div>` +
      `<div class="card"><div class="lbl">Your data is saved only on this phone.</div><p style="margin:10px 0 0"><button class="btn2" id="chg">Change file</button> <button class="btn2" id="forget">Forget my data</button></p></div>`;
    $('chg').onclick = () => $('file').click();
    $('forget').onclick = async () => { await clearFiles(); location.reload(); };
  }

  // Self-updating: check for a new version on every open, and reload into it automatically
  // while still on the import screen (never mid-session, so loaded data isn't lost).
  // Open the saved copy automatically; show the picker only when there is none (or it can't be read).
  $('import').style.visibility = 'hidden';
  loadFiles().then((saved) => {
    if (saved && saved.length) {
      $('import').style.visibility = 'visible'; $('pick').style.display = 'none'; $('status').textContent = 'Loading your saved timeline…';
      return loadFromSources(saved.map((e) => ({ name: e.name, text: () => e.blob.text() })), false);
    }
    $('import').style.visibility = 'visible';
  }).catch(() => { $('import').style.visibility = 'visible'; });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !data) location.reload(); });
    navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => {});
  }
})();
