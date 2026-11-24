// Building outlines and streets from OpenStreetMap, for the GPS cleaning (inside a building while moving = suspicious;
// the likely path is kept outside buildings and drawn a little toward streets and footpaths).
//
// Downloaded only for the ~600 m squares a day's movement passes through, kept on the phone in a small cache, and
// thrown away when no longer used: squares unused for 14 days go, and the oldest go first above 20 MB. A day that has
// been refined keeps only its finished result (a few KB), so old days never need the buildings again.
// A download tells the OpenStreetMap server (overpass-api.de) which square was asked for, nothing else.
(function (root) {
  const Z = 16, KEEP_DAYS = 14, MAX_BYTES = 20e6, MAX_TILES_PER_DAY = 40;
  const ENDPOINT = 'https://overpass-api.de/api/interpreter';
  const RAD = Math.PI / 180;

  // ---- slippy-map squares ----
  const tileOf = (lat, lng) => { const n = 2 ** Z, s = Math.sin(lat * RAD); return [Math.floor(((lng + 180) / 360) * n), Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n)]; };
  const tileBox = (x, y) => { const n = 2 ** Z, lng = (v) => (v / n) * 360 - 180, lat = (v) => Math.atan(Math.sinh(Math.PI * (1 - (2 * v) / n))) / RAD; return { s: lat(y + 1), n: lat(y), w: lng(x), e: lng(x + 1) }; };
  const tileKey = (x, y) => Z + '/' + x + '/' + y;

  // ---- compact geometry: flat Int32 arrays of 1e-5 degrees ----
  function compact(json) {
    const b = [], r = [];
    for (const el of json.elements || []) {
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
      const flat = []; for (const g of el.geometry) flat.push(Math.round(g.lat * 1e5), Math.round(g.lon * 1e5));
      if (el.tags && el.tags.building) { if (el.geometry.length >= 4) b.push(flat); }
      else if (el.tags && el.tags.highway) r.push(flat);
    }
    return { b, r };
  }

  // ---- index: polygons / lines bucketed on a ~50 m grid ----
  function buildIndex(tiles) {
    const B = [], R = [], grid = new Map(), rgrid = new Map(), G = 0.0005;
    const cellsOf = (f) => { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (let i = 0; i < f.length; i += 2) { a = Math.min(a, f[i]); b = Math.max(b, f[i]); c = Math.min(c, f[i + 1]); d = Math.max(d, f[i + 1]); } return [Math.floor(a / 1e5 / G), Math.floor(b / 1e5 / G), Math.floor(c / 1e5 / G), Math.floor(d / 1e5 / G)]; };
    const add = (g, arr, f) => { const id = arr.push(f) - 1, [y0, y1, x0, x1] = cellsOf(f); if ((y1 - y0 + 1) * (x1 - x0 + 1) > 400) return; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const k = y * 1e6 + x; let l = g.get(k); if (!l) g.set(k, (l = [])); l.push(id); } };
    for (const t of tiles) { for (const f of t.b) add(grid, B, f); for (const f of t.r) add(rgrid, R, f); }
    const near = (g, lat, lng) => g.get(Math.floor(lat / G) * 1e6 + Math.floor(lng / G)) || [];
    const kx = (lat) => 111320 * Math.cos(lat * RAD), ky = 110540;
    function inside(f, lat, lng) {
      const y = lat * 1e5, x = lng * 1e5; let ins = false;
      for (let i = 0, j = f.length - 2; i < f.length; j = i, i += 2) { const yi = f[i], xi = f[i + 1], yj = f[j], xj = f[j + 1]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins; }
      return ins;
    }
    function nearestOnLine(f, lat, lng, closed) {           // nearest point on a polyline / polygon outline, in metres
      const sx = kx(lat), best = { d: Infinity, lat, lng };
      const n = f.length;
      for (let i = 0; i + 2 < n + (closed ? 2 : 0); i += 2) {
        const j = (i + 2) % n;
        const ay = (f[i] / 1e5 - lat) * ky, ax = (f[i + 1] / 1e5 - lng) * sx, by = (f[j] / 1e5 - lat) * ky, bx = (f[j + 1] / 1e5 - lng) * sx;
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, u = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
        const px = ax + u * dx, py = ay + u * dy, d = Math.sqrt(px * px + py * py);
        if (d < best.d) { best.d = d; best.lat = lat + py / ky; best.lng = lng + px / sx; }
      }
      return best;
    }
    const containing = (lat, lng) => { for (const id of near(grid, lat, lng)) if (inside(B[id], lat, lng)) return B[id]; return null; };
    return {
      buildings: B.length, streets: R.length,
      depth(lat, lng) { const f = containing(lat, lng); return f ? nearestOnLine(f, lat, lng, true).d : 0; },
      density(lat, lng) {                                    // share of a ~40 m square around the point covered by buildings
        let n = 0; const dy = 15 / ky, dx = 15 / kx(lat);
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (containing(lat + a * dy, lng + b * dx)) n++;
        return n / 9;
      },
      outside(lat, lng) {                                    // the nearest spot just outside a building (or the point itself)
        const f = containing(lat, lng); if (!f) return null;
        const p = nearestOnLine(f, lat, lng, true), d = p.d || 1, push = 1.5 / d;   // 1.5 m beyond the wall
        return [p.lat + (p.lat - lat) * push, p.lng + (p.lng - lng) * push];
      },
      street(lat, lng, maxM) {                               // nearest street / footpath within maxM metres
        let best = null;
        const seen = new Set();
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const id of near(rgrid, lat + a * G, lng + b * G)) {   // neighbouring cells too
          if (seen.has(id)) continue; seen.add(id);
          const p = nearestOnLine(R[id], lat, lng, false); if (p.d <= maxM && (!best || p.d < best.d)) best = p;
        }
        return best;
      },
    };
  }

  // Keep the likely path out of buildings (while moving) and pull it gently toward streets and footpaths.
  function refinePath(pts, idx, still, P) {                 // pts: [[lat,lng]...] (changed in place)
    const pull = P.wRoad == null ? 0.5 : P.wRoad;
    for (let i = 0; i < pts.length; i++) {
      if (!pts[i] || (still && still[i])) continue;
      let [lat, lng] = pts[i];
      if (pull > 0) { const s = idx.street(lat, lng, 12); if (s) { lat += (s.lat - lat) * pull; lng += (s.lng - lng) * pull; } }
      const o = idx.outside(lat, lng); if (o) { lat = o[0]; lng = o[1]; }
      pts[i] = [lat, lng];
    }
    return pts;
  }

  // ---- cache on the phone (IndexedDB), with eviction ----
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('timeline-osm', 1);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('tiles'); d.createObjectStore('days'); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  const tx = (store, mode, fn) => db().then((d) => new Promise((res, rej) => { const t = d.transaction(store, mode), s = t.objectStore(store); let out; Promise.resolve(fn(s)).then((v) => (out = v)); t.oncomplete = () => res(out); t.onerror = () => rej(t.error); }));
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function getTile(key) { const v = await tx('tiles', 'readonly', (s) => reqP(s.get(key))); return v || null; }
  async function putTile(key, data, bytes) { await tx('tiles', 'readwrite', (s) => s.put({ t: Date.now(), bytes, data }, key)); }
  async function touch(keys) { await tx('tiles', 'readwrite', async (s) => { for (const k of keys) { const v = await reqP(s.get(k)); if (v) { v.t = Date.now(); s.put(v, k); } } }); }
  async function evict(now) {
    now = now || Date.now();
    const all = await tx('tiles', 'readonly', (s) => new Promise((res) => { const out = []; s.openCursor().onsuccess = (e) => { const c = e.target.result; if (c) { out.push({ k: c.key, t: c.value.t, b: c.value.bytes }); c.continue(); } else res(out); }; }));
    all.sort((a, b) => a.t - b.t);
    let total = all.reduce((a, x) => a + x.b, 0); const drop = [];
    for (const x of all) if (now - x.t > KEEP_DAYS * 86400000 || total > MAX_BYTES) { drop.push(x.k); total -= x.b; }
    if (drop.length) await tx('tiles', 'readwrite', (s) => { for (const k of drop) s.delete(k); });
    const days = await tx('days', 'readonly', (s) => new Promise((res) => { const out = []; s.openCursor().onsuccess = (e) => { const c = e.target.result; if (c) { out.push({ k: c.key, t: c.value.t }); c.continue(); } else res(out); }; }));
    if (days.length > 400) { days.sort((a, b) => a.t - b.t); await tx('days', 'readwrite', (s) => { for (const x of days.slice(0, days.length - 400)) s.delete(x.k); }); }
    return { dropped: drop.length, bytes: total, tiles: all.length - drop.length };
  }
  async function usage() {
    const all = await tx('tiles', 'readonly', (s) => new Promise((res) => { let n = 0, b = 0; s.openCursor().onsuccess = (e) => { const c = e.target.result; if (c) { n++; b += c.value.bytes; c.continue(); } else res({ tiles: n, bytes: b }); }; }));
    return all;
  }
  async function clearAll() { await tx('tiles', 'readwrite', (s) => s.clear()); await tx('days', 'readwrite', (s) => s.clear()); }
  async function getDay(key) { const v = await tx('days', 'readonly', (s) => reqP(s.get(key))); return v ? v.data : null; }
  async function putDay(key, data) { await tx('days', 'readwrite', (s) => s.put({ t: Date.now(), data }, key)); }

  async function download(x, y) {
    const bx = tileBox(x, y), bb = `(${bx.s.toFixed(6)},${bx.w.toFixed(6)},${bx.n.toFixed(6)},${bx.e.toFixed(6)})`;
    const q = `[out:json][timeout:25];(way["building"]${bb};way["highway"]${bb};);out geom;`;
    const r = await fetch(ENDPOINT + '?data=' + encodeURIComponent(q), { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!r.ok) throw new Error('map data HTTP ' + r.status);
    return compact(await r.json());
  }

  // Squares for a list of positions (moving parts only), loaded from the cache or downloaded. Returns an index or null.
  let inflight = null;
  async function indexFor(points, opts) {
    opts = opts || {};
    const need = new Map();
    for (const p of points) { const [x, y] = tileOf(p[0], p[1]); need.set(tileKey(x, y), [x, y]); if (need.size > MAX_TILES_PER_DAY) break; }
    if (!need.size) return null;
    const tiles = [], used = [];
    for (const [k, xy] of need) {
      let v = null; try { v = await getTile(k); } catch (e) { v = null; }
      if (v) { tiles.push(v.data); used.push(k); continue; }
      if (opts.offline) continue;
      try {
        while (inflight) await inflight;                       // one download at a time (fair use of the free server)
        let done; inflight = new Promise((r) => (done = r));
        const data = await download(xy[0], xy[1]).finally(() => { inflight = null; done(); });
        tiles.push(data);
        try { await putTile(k, data, JSON.stringify(data).length); } catch (e) { /* storage full: use it this time only */ }
      } catch (e) { if (opts.onError) opts.onError(e); }
    }
    if (used.length) touch(used).catch(() => {});
    evict().catch(() => {});
    return tiles.length ? buildIndex(tiles) : null;
  }

  const api = { indexFor, buildIndex, refinePath, compact, tileOf, tileBox, evict, usage, clearAll, getDay, putDay, ENDPOINT, KEEP_DAYS, MAX_BYTES };
  if (typeof module !== 'undefined') module.exports = api; else { root.TL = root.TL || {}; root.TL.osm = api; }
})(typeof self !== 'undefined' ? self : this);
