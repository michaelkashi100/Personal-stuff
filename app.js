(function () {
  const $ = (id) => document.getElementById(id);
  let data = null, map, heat = [], dayLayer, marker, timer = null;
  const DAY = 86400000;
  const COLORS = { walking: '#4ade80', 'on foot': '#4ade80', cycling: '#facc15', 'in passenger vehicle': '#f87171', driving: '#f87171', 'in train': '#a78bfa', 'in subway': '#a78bfa', flying: '#fb923c', path: '#38bdf8', unknown: '#94a3b8' };

  // ---- Import ----
  $('pick').onclick = () => $('file').click();
  $('file').onchange = async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const merged = { visits: [], trips: [], points: [] };
    try {
      for (const f of files) {
        $('status').textContent = 'Reading ' + f.name + '…';
        const d = TL.parseTimeline(JSON.parse(await f.text()));
        // concat, not push(...arr): spreading a huge array overflows the call stack.
        merged.visits = merged.visits.concat(d.visits); merged.trips = merged.trips.concat(d.trips); merged.points = merged.points.concat(d.points);
      }
    } catch (err) {
      // Show where it failed (first stack frames only; no file contents) to make problems diagnosable.
      const where = String(err.stack || '').split('\n').slice(1, 3).map((s) => s.trim().replace(/^at /, '').slice(0, 80)).join(' | ');
      $('status').textContent = 'Could not read file: ' + err.message + (where ? ' [' + where + ']' : '');
      return;
    }
    start(merged);
  };

  function start(d) {
    d.visits.sort((a, b) => a.start - b.start); d.trips.sort((a, b) => a.start - b.start);
    data = d;
    $('import').style.display = 'none';
    $('app').style.display = 'flex';
    initMap(); initDays(); renderStats();
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
    map = L.map('map', { zoomControl: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    dayLayer = L.layerGroup().addTo(map);
    const all = data.visits.map((v) => [v.lat, v.lng]).concat(data.points.map((p) => [p.lat, p.lng]));
    // Background dots: draw on a canvas and cap at ~15k points so big files stay fast on a phone.
    const step = Math.max(1, Math.ceil(all.length / 15000));
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
    $('day').innerHTML = sorted.map((d) => `<option value="${d}">${new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</option>`).join('');
    $('day').onchange = () => showDay(+$('day').value);
    if (sorted.length) showDay(sorted[sorted.length - 1]), ($('day').value = sorted[sorted.length - 1]);
  }

  // Build timeline of [time, lat, lng] for the day.
  let track = [];
  function showDay(d) {
    stop(); dayLayer.clearLayers(); track = [];
    const end = d + DAY;
    for (const t of data.trips) {
      if (t.start < d || t.start >= end || t.path.length < 2) continue;
      const color = COLORS[t.type] || COLORS.unknown;
      L.polyline(t.path, { color, weight: 4, opacity: 0.85 }).addTo(dayLayer);
      const n = t.path.length, dur = Math.max(1, t.end - t.start);
      t.path.forEach((p, i) => track.push([t.start + (dur * i) / (n - 1), p[0], p[1]]));
    }
    for (const v of data.visits) {
      if (v.start < d || v.start >= end) continue;
      L.circleMarker([v.lat, v.lng], { radius: 8, color: '#fff', weight: 2, fillColor: '#f43f5e', fillOpacity: 1 })
        .bindTooltip((v.name || v.type) + ' · ' + new Date(v.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })).addTo(dayLayer);
      track.push([v.start, v.lat, v.lng]);
    }
    for (const p of data.points) if (p.t >= d && p.t < end) track.push([p.t, p.lat, p.lng]);
    track.sort((a, b) => a[0] - b[0]);
    marker = L.circleMarker([0, 0], { radius: 9, color: '#fff', weight: 3, fillColor: '#38bdf8', fillOpacity: 1 });
    if (track.length) {
      marker.setLatLng([track[0][1], track[0][2]]).addTo(dayLayer);
      map.fitBounds(track.map((t) => [t[1], t[2]]), { padding: [40, 40], maxZoom: 16 });
    }
    $('scrub').value = 0; label(0);
  }

  function label(frac) {
    if (!track.length) { $('dayLabel').textContent = 'no data'; return; }
    const t0 = track[0][0], t1 = track[track.length - 1][0];
    $('dayLabel').textContent = new Date(t0 + (t1 - t0) * frac).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function seek(frac) {
    if (!track.length) return;
    const t0 = track[0][0], t1 = track[track.length - 1][0], t = t0 + (t1 - t0) * frac;
    let i = 0; while (i < track.length - 1 && track[i + 1][0] <= t) i++;
    const a = track[i], b = track[Math.min(i + 1, track.length - 1)];
    const k = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
    marker.setLatLng([a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);
    label(frac);
  }
  $('scrub').oninput = () => seek($('scrub').value / 1000);
  function stop() { if (timer) clearInterval(timer); timer = null; $('play').textContent = '▶ Play'; }
  $('play').onclick = () => {
    if (timer) return stop();
    if (+$('scrub').value >= 1000) $('scrub').value = 0;
    $('play').textContent = '⏸ Pause';
    timer = setInterval(() => {
      const v = Math.min(1000, +$('scrub').value + +$('speed').value);
      $('scrub').value = v; seek(v / 1000);
      if (v >= 1000) stop();
    }, 40);
  };

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
      `<div class="card"><div class="lbl">Where you spent the most time</div><ul>${top || '<li>none</li>'}</ul></div>`;
  }

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
