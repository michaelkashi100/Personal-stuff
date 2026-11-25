// GPS cleaning: every fix gets a confidence 0..1 ("how likely is this a real position") and the likely path is
// rebuilt from the fixes, each pulling as much as its confidence allows.
//
//   1. places    hard rules: never in the Middle East outside Israel; abroad only as a real trip (long enough, reached
//                at a believable speed). Anything else there is GPS spoofing / an error: confidence 0.
//   2. smoother  a constant-velocity Kalman filter + fixed-lag smoother (each point is decided using the next `lag`
//                fixes: it "sees a little into the future"). Smooth straight-ish motion is the default assumption.
//   3. evidence  per fix, log-likelihood ratios (positive = looks real, negative = looks like a jump):
//                fit (distance from the path the *other* fixes describe), turn (sharp turns / out-and-back),
//                speed, acceleration, signal quality, altitude, buildings, familiar routes
//   4. combine   z = ln((1-pi)/pi) + sum(w_k * clamp(l_k, -6, +3)),  c = 1 / (1 + e^-z);  repeat 2-4 three times
//   5. Wi-Fi     the same Wi-Fi network for 5+ minutes = you were not moving: one position for the whole stretch
//
// Pure functions, no DOM: used by analyze.js, the Path lab and the tests.
(function (root) {
  const RAD = Math.PI / 180;
  const d4 = (la1, ln1, la2, ln2) => {
    const dLat = (la2 - la1) * RAD, dLng = (ln2 - ln1) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * RAD) * Math.cos(la2 * RAD) * Math.sin(dLng / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(h));
  };
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const pos = (x) => (x > 0 ? x : 0);
  const sq = (x) => x * x;
  const hyp = (x, y) => Math.sqrt(x * x + y * y);          // Math.hypot is several times slower

  // Every number the decisions depend on. The Path lab shows them as sliders.
  const DEFAULTS = {
    lag: 10,                       // fixes the smoother looks ahead before a point is final
    jumpRate: 0.08,                // how often a fix is a jump when nothing else is known
    sigmaMin: 8,                   // m: never trust a fix more than this, whatever the phone claims
    jumpRadius: 150,               // m: how far a jump typically lands
    wFit: 1,
    wTurn: 0.8, kWalk: 1.0, kBike: 1.5, kCar: 2.5,
    wSpeed: 1, vWalk: 2.5, vBike: 9, vCar: 40,
    wAccel: 0.6, aWalk: 1.5, aBike: 2.5, aCar: 4,
    wSignal: 1, srcGps: 0.5, srcFused: 0, srcUnknown: -0.3, srcWifi: -0.7, srcCell: -2,
    wAlt: 0.7, altTol: 25,
    snapDrive: 1, snapRadius: 40,  // driving: how firmly the path is put on the road, and how far away a road may be
    dwellMin: 3,                   // minutes: a stop this long makes any turn (even going back the way you came) normal
    wBuild: 1, lambdaBuild: 2, stopZoneMin: 2, wRoad: 0.5,
    urbanBoost: 2,
    wFam: 0.5, famDays: 3,
    wifiMinMin: 5,                 // minutes on the same Wi-Fi network = not moving
    abroadMinH: 8,                 // hours: a real trip abroad lasts at least this long
    keep: 0.3,                     // fixes below this confidence are left out of stays and trips
  };
  // Sliders: [key, label, min, max, step, group]
  const SLIDERS = [
    ['lag', 'Look ahead (fixes)', 0, 30, 1, 'Decision'], ['jumpRate', 'How often GPS jumps', 0.01, 0.4, 0.01, 'Decision'], ['keep', 'Leave out below', 0.05, 0.9, 0.05, 'Decision'],
    ['wFit', 'Distance from path: weight', 0, 2, 0.1, 'Position'], ['sigmaMin', 'Best possible accuracy (m)', 2, 30, 1, 'Position'], ['jumpRadius', 'Typical jump size (m)', 30, 500, 10, 'Position'],
    ['wTurn', 'Turns: weight', 0, 2, 0.1, 'Turns'], ['kWalk', 'Walking: turn cost', 0, 4, 0.1, 'Turns'], ['kBike', 'Cycling: turn cost', 0, 4, 0.1, 'Turns'], ['kCar', 'Driving: turn cost', 0, 6, 0.1, 'Turns'], ['dwellMin', 'A stop this long excuses any turn (min)', 0.5, 30, 0.5, 'Turns'],
    ['wSpeed', 'Speed: weight', 0, 2, 0.1, 'Motion'], ['vWalk', 'Walking: top speed (m/s)', 1, 6, 0.1, 'Motion'], ['vBike', 'Cycling: top speed (m/s)', 4, 20, 0.5, 'Motion'], ['vCar', 'Driving: top speed (m/s)', 15, 70, 1, 'Motion'],
    ['wAccel', 'Acceleration: weight', 0, 2, 0.1, 'Motion'],
    ['wSignal', 'Signal quality: weight', 0, 2, 0.1, 'Signal'], ['srcWifi', 'Wi-Fi position', -3, 1, 0.1, 'Signal'], ['srcCell', 'Cell-tower position', -4, 1, 0.1, 'Signal'],
    ['wAlt', 'Altitude: weight', 0, 2, 0.1, 'Altitude'], ['altTol', 'Altitude tolerance (m)', 5, 80, 1, 'Altitude'],
    ['wBuild', 'Buildings: weight', 0, 2, 0.1, 'Surroundings'], ['urbanBoost', 'Dense city: more jumps', 0, 5, 0.1, 'Surroundings'], ['stopZoneMin', 'Inside allowed near stops (min)', 0, 10, 0.5, 'Surroundings'], ['wRoad', 'Pull toward streets & paths', 0, 1, 0.05, 'Surroundings'], ['snapDrive', 'Driving: snap to roads', 0, 1, 0.05, 'Surroundings'], ['snapRadius', 'Driving: farthest road (m)', 10, 80, 5, 'Surroundings'],
    ['wFam', 'Usual routes: weight', 0, 2, 0.1, 'Habits'], ['wifiMinMin', 'Same Wi-Fi = still after (min)', 1, 30, 1, 'Habits'], ['abroadMinH', 'Shortest real trip abroad (h)', 1, 48, 1, 'Places'],
  ];

  // ---------- 1. places ----------
  // Israel incl. the West Bank, Gaza and the Golan (lat, lng), coast first. Rough outline: a 5 km margin is added on top.
  const ISRAEL = [[33.093, 35.10], [32.93, 35.06], [32.83, 34.95], [32.50, 34.88], [32.08, 34.75], [31.80, 34.62], [31.60, 34.48], [31.33, 34.20],
    [31.22, 34.27], [30.56, 34.54], [29.95, 34.73], [29.49, 34.90], [29.55, 34.98], [30.0, 35.08], [30.5, 35.18], [31.0, 35.40], [31.2, 35.45], [31.5, 35.50],
    [31.77, 35.56], [32.0, 35.53], [32.3, 35.57], [32.63, 35.57], [32.68, 35.73], [32.72, 35.90], [32.85, 35.92], [33.05, 35.86], [33.20, 35.86], [33.32, 35.82],
    [33.33, 35.76], [33.28, 35.58], [33.10, 35.45], [33.08, 35.30]];
  // The rest of the Middle East (Egypt, Lebanon, Syria, Jordan, Iraq, Arabia, the Gulf, Yemen, Iran). Not Turkey, not Cyprus.
  const MIDEAST = [[31.6, 25.0], [22.0, 25.0], [22.0, 37.0], [12.5, 43.3], [12.0, 52.0], [22.5, 60.0], [25.3, 61.6], [29.8, 60.9], [37.0, 61.2], [38.1, 57.3],
    [37.4, 54.0], [38.4, 48.9], [39.4, 48.0], [39.8, 44.8], [37.14, 44.78], [37.1, 42.4], [36.7, 40.0], [36.65, 38.0], [36.8, 36.65], [35.9, 36.0], [35.85, 35.82],
    [34.45, 35.78], [33.9, 35.42], [33.27, 35.15]].concat(ISRAEL.slice(0, 8), [[31.13, 33.8], [31.27, 32.3], [31.2, 29.9]]);
  function inPoly(lat, lng, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ya, xa] = poly[i], [yb, xb] = poly[j];
      if ((ya > lat) !== (yb > lat) && lng < ((xb - xa) * (lat - ya)) / (yb - ya) + xa) inside = !inside;
    }
    return inside;
  }
  function distToPoly(lat, lng, poly) {                       // metres to the outline (0 inside)
    if (inPoly(lat, lng, poly)) return 0;
    const kx = 111320 * Math.cos(lat * RAD), ky = 110540;
    let best = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const ax = (poly[j][1] - lng) * kx, ay = (poly[j][0] - lat) * ky, bx = (poly[i][1] - lng) * kx, by = (poly[i][0] - lat) * ky;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, u = l2 ? clamp(-(ax * dx + ay * dy) / l2, 0, 1) : 0;
      best = Math.min(best, hyp(ax + u * dx, ay + u * dy));
    }
    return best;
  }
  // the sea off Israel's coast (sailing, the first minutes of a flight) is home too: GPS spoofing does not put you there
  const HOME_SEA = ISRAEL.slice(0, 8).concat([[31.33, 33.9], [33.093, 33.9]]);
  const HOME_MARGIN = 5000;
  const regionCache = new Map();
  function regionOf(lat, lng) {
    const key = Math.round(lat * 200) * 100000 + Math.round(lng * 200);   // ~500 m cells; borders get the exact test
    const hit = regionCache.get(key);
    if (hit && hit !== 'edge') return hit;
    const r = regionExact(lat, lng);
    if (!hit) {
      const corners = [[0.003, 0.003], [-0.003, 0.003], [0.003, -0.003], [-0.003, -0.003]].map(([a, b]) => regionExact(lat + a, lng + b));
      regionCache.set(key, corners.every((x) => x === r) ? r : 'edge');
      if (regionCache.size > 200000) regionCache.clear();
    }
    return r;
  }
  function regionExact(lat, lng) {
    if (lat > 28.5 && lat < 34.2 && lng > 33.4 && lng < 36.6 && (inPoly(lat, lng, HOME_SEA) || distToPoly(lat, lng, ISRAEL) <= HOME_MARGIN)) return 'home';
    return inPoly(lat, lng, MIDEAST) ? 'never' : 'abroad';
  }

  // Region rules over the whole sequence. Returns per-fix { hard: 0|null, why }.
  function regionRules(F, P, trusted) {
    const n = F.length, reg = new Array(n), out = new Array(n).fill(null);
    for (let i = 0; i < n; i++) reg[i] = regionOf(F[i].lat, F[i].lng);
    const isTrusted = (t) => trusted.some((r) => t >= r[0] && t <= r[1]);
    for (let i = 0; i < n; i++) if (reg[i] === 'never' && !isTrusted(F[i].t)) out[i] = { hard: 0, why: 'never' };
    // abroad stretches (ignoring 'never' fixes inside them)
    for (let i = 0; i < n;) {
      if (reg[i] !== 'abroad') { i++; continue; }
      let j = i; while (j + 1 < n && reg[j + 1] !== 'home') j++;
      const idx = []; for (let k = i; k <= j; k++) if (reg[k] === 'abroad') idx.push(k);
      const a = F[idx[0]], b = F[idx[idx.length - 1]], dur = b.t - a.t;
      let prev = -1; for (let k = i - 1; k >= 0; k--) if (reg[k] === 'home') { prev = k; break; }
      const next = j + 1 < n ? j + 1 : -1;
      const fast = (p, q) => { const dt = Math.abs(q.t - p.t) / 1000; return dt > 0 && d4(p.lat, p.lng, q.lat, q.lng) / dt > 310; };   // > ~1100 km/h
      const accs = idx.map((k) => F[k].acc || 50).sort((x, y) => x - y), medAcc = accs[accs.length >> 1];
      const ongoing = next < 0;                                 // still there at the end of the data: judge by what we have
      const ok = (dur >= P.abroadMinH * 3600000 || (ongoing && dur >= 2 * 3600000)) && !(prev >= 0 && fast(F[prev], a)) && !(next >= 0 && fast(b, F[next])) && medAcc <= 200;
      if (!ok && !isTrusted(a.t)) for (const k of idx) out[k] = { hard: 0, why: 'abroad' };
      i = j + 1;
    }
    return { reg, out };
  }

  // ---------- 2. smoother ----------
  // Constant-velocity model per axis; R = measurement variance (big = weak pull). Fixed-lag RTS: point i uses fixes up to i+lag.
  function smoothAxis(z, R, T, qOf, lag) {
    const n = z.length, xf = new Float64Array(2 * n), Pf = new Float64Array(3 * n), xp = new Float64Array(2 * n), Pp = new Float64Array(3 * n);
    let x0 = z[0], x1 = 0, p00 = R[0], p01 = 0, p11 = 100;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const dt = Math.max(0.5, (T[i] - T[i - 1]) / 1000), q = qOf(i);
        x0 = x0 + dt * x1;
        const n00 = p00 + 2 * dt * p01 + dt * dt * p11 + (q * dt * dt * dt) / 3, n01 = p01 + dt * p11 + (q * dt * dt) / 2, n11 = p11 + q * dt;
        p00 = n00; p01 = n01; p11 = Math.min(n11, 2500);          // speed uncertainty capped (50 m/s) after long gaps
      }
      xp[2 * i] = x0; xp[2 * i + 1] = x1; Pp[3 * i] = p00; Pp[3 * i + 1] = p01; Pp[3 * i + 2] = p11;
      const s = p00 + R[i], k0 = p00 / s, k1 = p01 / s, inn = z[i] - x0;
      x0 += k0 * inn; x1 += k1 * inn;
      const a00 = (1 - k0) * p00, a01 = (1 - k0) * p01, a11 = p11 - k1 * p01;
      p00 = a00; p01 = a01; p11 = a11;
      xf[2 * i] = x0; xf[2 * i + 1] = x1; Pf[3 * i] = p00; Pf[3 * i + 1] = p01; Pf[3 * i + 2] = p11;
    }
    const xs = new Float64Array(n), vs = new Float64Array(n), ps = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const end = Math.min(n - 1, i + lag);
      let s0 = xf[2 * end], s1 = xf[2 * end + 1], q00 = Pf[3 * end], q01 = Pf[3 * end + 1], q11 = Pf[3 * end + 2];
      for (let k = end - 1; k >= i; k--) {
        const dt = Math.max(0.5, (T[k + 1] - T[k]) / 1000);
        const f00 = Pf[3 * k], f01 = Pf[3 * k + 1], f11 = Pf[3 * k + 2];
        const m00 = Pp[3 * (k + 1)], m01 = Pp[3 * (k + 1) + 1], m11 = Pp[3 * (k + 1) + 2], det = m00 * m11 - m01 * m01 || 1e-9;
        const i00 = m11 / det, i01 = -m01 / det, i11 = m00 / det;
        const c00 = f00 + dt * f01, c01 = f01, c10 = f01 + dt * f11, c11 = f11;       // C = Pf * F^T
        const g00 = c00 * i00 + c01 * i01, g01 = c00 * i01 + c01 * i11, g10 = c10 * i00 + c11 * i01, g11 = c10 * i01 + c11 * i11;
        const e0 = s0 - xp[2 * (k + 1)], e1 = s1 - xp[2 * (k + 1) + 1];
        const n0 = xf[2 * k] + g00 * e0 + g01 * e1, n1 = xf[2 * k + 1] + g10 * e0 + g11 * e1;
        const d00 = q00 - m00, d01 = q01 - m01, d11 = q11 - m11;
        const h00 = g00 * d00 + g01 * d01, h01 = g00 * d01 + g01 * d11, h10 = g10 * d00 + g11 * d01, h11 = g10 * d01 + g11 * d11;
        q00 = f00 + h00 * g00 + h01 * g01; q01 = f01 + h00 * g10 + h01 * g11; q11 = f11 + h10 * g10 + h11 * g11;
        s0 = n0; s1 = n1;
      }
      xs[i] = s0; vs[i] = s1; ps[i] = Math.max(1e-6, q00);
    }
    return { xs, vs, ps };
  }

  // ---------- helpers ----------
  const MODE_STILL = 0, MODE_WALK = 1, MODE_BIKE = 2, MODE_CAR = 3, MODE_FLY = 4;
  const modeOfSpeed = (v) => (v < 0.5 ? MODE_STILL : v < 2.3 ? MODE_WALK : v < 7 ? MODE_BIKE : v < 70 ? MODE_CAR : MODE_FLY);
  const SRCKEY = { gps: 'srcGps', fused: 'srcFused', unknown: 'srcUnknown', wifi: 'srcWifi', cell: 'srcCell' };
  const dayOf = (t) => Math.floor(t / 86400000);
  const cellKey = (lat, lng) => Math.round(lat / 0.00018) + ':' + Math.round(lng / 0.00021);   // ~20 m squares

  // Segments: one local metric frame per stretch without big gaps or jumps (keeps the flat-earth error tiny).
  function segments(F, keepIdx) {
    const segs = []; let cur = [];
    for (const i of keepIdx) {
      const p = cur.length ? F[cur[cur.length - 1]] : null;
      if (p && (F[i].t - p.t > 15 * 60000 || d4(p.lat, p.lng, F[i].lat, F[i].lng) > 50000)) { segs.push(cur); cur = []; }
      cur.push(i);
    }
    if (cur.length) segs.push(cur);
    return segs;
  }

  /**
   * F: fixes sorted by time { t, lat, lng, acc, v?, alt?, vacc?, src?, sat?, cn0?, wifiN?, wifiH? }
   * opts: { params, trusted: [[t0,t1]..], buildings: { depth(lat,lng)->m inside, density(lat,lng)->0..1 }?, placeWifi: [{lat,lng,hashes}]?, familiar: Map? }
   * returns { c: Float64Array, why: [], route: [[lat,lng]..] (null for excluded), parts: per-fix evidence, tentativeFrom: index }
   */
  function clean(F, opts) {
    opts = opts || {};
    const P = Object.assign({}, DEFAULTS, opts.params || {});
    const n = F.length, c = new Float64Array(n).fill(1), why = new Array(n).fill(''), parts = new Array(n);
    const route = new Array(n).fill(null), still = new Uint8Array(n), mode = new Uint8Array(n);
    if (!n) return { c, why, route, parts, tentativeFrom: 0, P };
    const { reg, out: hard } = regionRules(F, P, opts.trusted || []);
    for (let i = 0; i < n; i++) if (hard[i]) { c[i] = 0; why[i] = hard[i].why; }
    // spoofing context: GPS around 'never' fixes is suspect, Wi-Fi / cell positions are not affected by it
    const spoof = new Uint8Array(n);
    for (let i = 0, last = -Infinity; i < n; i++) { if (why[i] === 'never') last = F[i].t; if (F[i].t - last < 30 * 60000) spoof[i] = 1; }
    for (let i = n - 1, next = Infinity; i >= 0; i--) { if (why[i] === 'never') next = F[i].t; if (next - F[i].t < 30 * 60000) spoof[i] = 1; }

    const keepIdx = []; for (let i = 0; i < n; i++) if (c[i] > 0) keepIdx.push(i);
    const segs = segments(F, keepIdx);
    const sig2 = (i) => sq(Math.max(F[i].acc || 20, 1)) + sq(P.sigmaMin);
    const fam = opts.familiar || null;
    // fixes you marked in the Path lab: [{t, ok}] -> Map(t -> true / false)
    const marks = opts.marks && opts.marks.length ? new Map(opts.marks.map((x) => [x.t, !!x.ok])) : null;

    for (const seg of segs) {
      const m = seg.length, lat0 = F[seg[0]].lat, lng0 = F[seg[0]].lng, kx = 111320 * Math.cos(lat0 * RAD), ky = 110540;
      const X = new Float64Array(m), Y = new Float64Array(m), T = new Float64Array(m), R = new Float64Array(m), w = new Float64Array(m).fill(1);
      for (let k = 0; k < m; k++) { const f = F[seg[k]]; X[k] = (f.lng - lng0) * kx; Y[k] = (f.lat - lat0) * ky; T[k] = f.t; }
      let sx, sy, speed = new Float64Array(m), localV = new Float64Array(m);
      // speed (consensus): for pairs of fixes around this one (one before, one after), would going through this fix
      // fit the time between them at the speed you were moving? A jump, or a short visit to a wrong spot, forces a
      // detour that the pairs around it cannot explain; the many genuine fixes outvote the few wrong ones.
      const rawV = new Float64Array(m), lCons = new Float64Array(m);
      // speeds over a ~5-fix baseline: GPS noise between two neighbouring fixes would otherwise look like extra speed
      for (let k = 1; k < m; k++) { const b = Math.max(0, k - 5); rawV[k] = hyp(X[k] - X[b], Y[k] - Y[b]) / Math.max(0.5, (T[k] - T[b]) / 1000); }
      // typical speed around each fix, looked at separately just before and just after it (a low quantile: jumps only ever
      // add speed). The faster side counts, so the first fixes after you leave a long stop are not judged at standstill speed.
      const lowQ = (from, to) => {
        const vals = [], st = Math.max(1, Math.ceil((to - from + 1) / 16));
        for (let q = Math.max(1, from); q <= to; q += st) vals.push(rawV[q]);
        if (!vals.length) return 0;
        vals.sort((a, b) => a - b); return vals[Math.floor(vals.length * 0.3)];
      };
      for (let k = 0, lo = 0, hi = 0; k < m; k++) {
        while (T[lo] < T[k] - 60000) lo++;
        while (hi + 1 < m && T[hi + 1] <= T[k] + 60000) hi++;
        // speeds are measured over 5 fixes, so neither side may use a stretch that touches this fix itself
        const back = k > 1 ? lowQ(lo, k - 1) : 0, f0 = k + 6, f1 = Math.min(m - 1, hi + 6), fwd = f0 <= f1 ? lowQ(f0, f1) : 0;
        const hiV = Math.max(back, fwd), loV = Math.min(back, fwd);
        // starting or stopping (one side much faster): the faster side; otherwise both sides together (steadier)
        localV[k] = hiV > 3 * Math.max(0.5, loV) ? hiV : lowQ(lo, f1);
      }
      const SG = new Float64Array(m); for (let k = 0; k < m; k++) SG[k] = Math.sqrt(sig2(seg[k]));
      const sg = (k) => SG[k];
      // three rounds: a pair only vouches for a fix as much as both of its own fixes are trusted
      const pri = Math.log((1 - P.jumpRate) / P.jumpRate), wc = new Float64Array(m).fill(1), DP = new Float64Array(9), DQ = new Float64Array(9);
      const gaps = []; for (let k = 1; k < m; k++) gaps.push(T[k] - T[k - 1]); gaps.sort((a, b) => a - b);
      const maxDt = Math.max(45, 4 * (gaps.length ? gaps[gaps.length >> 1] : 0) / 1000);
      for (let round = 0; round < 3; round++) {
        for (let k = 0; k < m; k++) {
          const md = modeOfSpeed(localV[k]), vtop = md <= MODE_WALK ? P.vWalk : md === MODE_BIKE ? P.vBike : md === MODE_CAR ? P.vCar : 320;
          const v = Math.min(vtop, 1.5 * localV[k] + 0.7);
          let sw = 0, sr = 0;
          for (let j = 1; j <= 8; j++) { DP[j] = k - j >= 0 ? hyp(X[k] - X[k - j], Y[k] - Y[k - j]) : 0; DQ[j] = k + j < m ? hyp(X[k + j] - X[k], Y[k + j] - Y[k]) : 0; }
          for (let p = Math.max(0, k - 8); p < k; p++) for (let q = Math.max(k + 1, p + 5); q <= Math.min(m - 1, k + 8); q++) {
            const dt = (T[q] - T[p]) / 1000; if (dt > maxDt) continue;
            const via = DP[k - p] + DQ[q - k];
            const allowed = v * dt + sg(p) + sg(q) + 1.5 * sg(k);
            const wq = wc[p] * wc[q]; sw += wq; if (via <= allowed) sr += wq;
          }
          lCons[k] = sw > 1e-3 ? 6 * (sr / sw - 0.65) : 0;
        }
        for (let k = 0; k < m; k++) wc[k] = 1 / (1 + Math.exp(-2 * clamp(lCons[k], -6, 3)));
      }
      for (let k = 0; k < m; k++) w[k] = 1 / (1 + Math.exp(-(pri + P.wSpeed * clamp(lCons[k], -6, 3))));
      // evidence that does not depend on the path: computed once
      const SIG = new Float64Array(m), ALTDZ = new Float64Array(m).fill(-1), ALTTOL = new Float64Array(m), ALTVZ = new Float64Array(m).fill(-1);
      const DEP = new Float64Array(m), URB = new Float64Array(m), FAM = new Float64Array(m), PI = new Float64Array(m), STALE = new Uint8Array(m), buf = [];
      for (let k = 0; k < m; k++) {
        const i = seg[k], f = F[i];
        let lSig = 0;                                          // signal quality: source, satellites, strength, sudden accuracy change
        if (f.src) lSig += P[SRCKEY[f.src] || 'srcUnknown'];
        if (spoof[i]) lSig += f.src === 'wifi' || f.src === 'cell' ? 1 : -1;
        if (f.sat >= 0 && f.sat < 6) lSig -= 0.8;
        if (f.cn0 > 0) lSig += clamp(0.5 * (f.cn0 - 30) / 5, -1.5, 1.5);
        buf.length = 0; for (let q = Math.max(0, k - 5); q <= Math.min(m - 1, k + 5); q++) if (q !== k) buf.push(F[seg[q]].acc || 20);
        if (buf.length) { buf.sort((a, b) => a - b); lSig -= 0.5 * Math.abs(Math.log((f.acc || 20) / buf[buf.length >> 1])); }
        SIG[k] = lSig;
        if (k > 0) { const p = F[seg[k - 1]]; if (p.lat === f.lat && p.lng === f.lng && f.t - p.t > 30000) STALE[k] = 1; }
        if (f.alt != null) {                                   // altitude vs the neighbours
          buf.length = 0; for (let q = Math.max(0, k - 5); q <= Math.min(m - 1, k + 5); q++) if (q !== k && F[seg[q]].alt != null) buf.push(F[seg[q]].alt);
          if (buf.length >= 3) {
            buf.sort((a, b) => a - b);
            ALTTOL[k] = Math.max(P.altTol, 2 * (f.vacc || 0)); ALTDZ[k] = Math.abs(f.alt - buf[buf.length >> 1]);
            const pq = k > 0 ? F[seg[k - 1]] : null;
            if (pq && pq.alt != null) ALTVZ[k] = Math.abs(f.alt - pq.alt) / Math.max(1, (f.t - pq.t) / 1000);
          }
        }
        if (opts.buildings) { DEP[k] = opts.buildings.depth(f.lat, f.lng); URB[k] = opts.buildings.density(f.lat, f.lng); }
        if (fam) { const e = fam.get(cellKey(f.lat, f.lng)); if (e) { const other = e.size - (e.has(dayOf(f.t)) ? 1 : 0); if (other > 0) FAM[k] = Math.min(1, Math.log(1 + other / P.famDays)); } }
        PI[k] = clamp(P.jumpRate * (1 + P.urbanBoost * URB[k]) * ((f.wifiN || 0) >= 10 ? 1.5 : 1) * (spoof[i] && f.src !== 'wifi' && f.src !== 'cell' ? 3 : 1), 0.005, 0.9);
      }
      const ITER = n > 100000 ? 2 : 3;                        // very long histories: one refinement less
      // time spent around each fix (within ~40 m): at work all day, then back the way you came, is not a suspicious U-turn
      const DWELL = new Float64Array(m);
      for (let k = 0; k < m; k++) {
        const Rr = Math.max(40, 2 * SG[k]);
        let lo = k, hi = k;
        while (lo > 0 && k - lo < 400 && hyp(X[lo - 1] - X[k], Y[lo - 1] - Y[k]) <= Rr) lo--;
        while (hi < m - 1 && hi - k < 400 && hyp(X[hi + 1] - X[k], Y[hi + 1] - Y[k]) <= Rr) hi++;
        DWELL[k] = T[hi] - T[lo];
      }
      const dwellExcuse = (k) => (P.dwellMin > 0 ? clamp(1 - DWELL[k] / (P.dwellMin * 60000), 0, 1) : 1);
      for (let it = 0; it < ITER; it++) {
        for (let k = 0; k < m; k++) R[k] = sig2(seg[k]) / Math.max(w[k], 0.02);
        const qOf = it === 0 ? () => 2.0 : (k) => { const md = modeOfSpeed(localV[k]); return md === MODE_STILL ? 0.05 : md === MODE_WALK ? 0.5 : md === MODE_BIKE ? 1.2 : md === MODE_CAR ? 4 : 20; };
        sx = smoothAxis(X, R, T, qOf, P.lag); sy = smoothAxis(Y, R, T, qOf, P.lag);
        for (let k = 0; k < m; k++) speed[k] = hyp(sx.vs[k], sy.vs[k]);
        if (it > 0) {                                           // typical speed from the path: mean over +-90 s (prefix sums)
          const cs = new Float64Array(m + 1); for (let k = 0; k < m; k++) cs[k + 1] = cs[k] + speed[k];
          for (let k = 0, lo = 0, hi = 0; k < m; k++) {
            while (T[lo] < T[k] - 90000) lo++;
            while (hi + 1 < m && T[hi + 1] <= T[k] + 90000) hi++;
            localV[k] = (cs[hi + 1] - cs[lo]) / (hi - lo + 1);
          }
        }
        for (let k = 0; k < m; k++) { mode[seg[k]] = modeOfSpeed(localV[k]); still[seg[k]] = mode[seg[k]] === MODE_STILL ? 1 : 0; }
        // nearness to a stop, for "being inside is fine here" (fades out over stopZoneMin minutes)
        const nearStop = new Float64Array(m), zone = P.stopZoneMin * 60000;
        for (let k = 0, last = -Infinity; k < m; k++) { if (still[seg[k]]) last = T[k]; nearStop[k] = zone > 0 ? pos(1 - (T[k] - last) / zone) : still[seg[k]]; }
        for (let k = m - 1, next = Infinity; k >= 0; k--) { if (still[seg[k]]) next = T[k]; if (zone > 0) nearStop[k] = Math.max(nearStop[k], pos(1 - (next - T[k]) / zone)); }
        // ---- evidence per fix ----
        for (let k = 0; k < m; k++) {
          const i = seg[k], f = F[i], s2 = sig2(i), md = mode[i];
          // fit: where the other fixes put you (leave-one-out from the smoother) vs this fix
          const R0 = R[k], hx = Math.min(0.95, sx.ps[k] / R0), hy = Math.min(0.95, sy.ps[k] / R0);
          const ox = (sx.xs[k] - hx * X[k]) / (1 - hx), oy = (sy.xs[k] - hy * Y[k]) / (1 - hy);
          const pv = (sx.ps[k] / (1 - hx) + sy.ps[k] / (1 - hy)) / 2, st = s2 + pv, r2 = sq(X[k] - ox) + sq(Y[k] - oy);
          const lFit = Math.log((Math.PI * sq(P.jumpRadius)) / (2 * Math.PI * st)) - r2 / (2 * st);
          // turn (incl. out-and-back) and speed, against the smoothed neighbours
          let lTurn = 0, lSpeed = lCons[k], lAccel = 0;
          if (k > 0 && k < m - 1) {                               // also at stops: an out-and-back from where you sit is a jump
            const ax = X[k] - sx.xs[k - 1], ay = Y[k] - sy.xs[k - 1], bx = sx.xs[k + 1] - X[k], by = sy.xs[k + 1] - Y[k];
            const a = hyp(ax, ay), b = hyp(bx, by), sg = Math.sqrt(s2);
            const dtIn = Math.max(0.5, (T[k] - T[k - 1]) / 1000), dtOut = Math.max(0.5, (T[k + 1] - T[k]) / 1000), gap = Math.min(1, 60 / Math.max(dtIn, dtOut));
            if (a > 0 && b > 0) {
              const cos = (ax * bx + ay * by) / (a * b), g = clamp((Math.min(a, b) - sg) / sg, 0, 1);
              const kap = md <= MODE_WALK ? P.kWalk : md === MODE_BIKE ? P.kBike : md === MODE_CAR ? P.kCar : P.kCar * 2;
              lTurn = -kap * (1 - cos) * g * gap * dwellExcuse(k);
            }
            if (f.v >= 0) lSpeed -= 0.5 * sq((f.v - speed[k]) / (2 + 0.3 * speed[k])) * gap;
            const amax = md === MODE_WALK ? P.aWalk : md === MODE_BIKE ? P.aBike : P.aCar;
            lAccel = -sq(pos(Math.abs(a / dtIn - speed[k - 1]) / dtIn - amax) / amax) * gap;
          }
          let lSig = SIG[k] - (STALE[k] && md !== MODE_STILL ? 2 : 0);
          let lAlt = 0;
          if (ALTDZ[k] >= 0) {
            const tol = ALTTOL[k], dz = ALTDZ[k];
            lAlt = -sq(pos(dz - tol) / tol);
            if (ALTVZ[k] >= 0) { const vzMax = md === MODE_CAR ? 5 : md === MODE_FLY ? 30 : 2; lAlt -= sq(pos(ALTVZ[k] - vzMax) / vzMax) * (dz > tol / 2 ? 1 : 0); }
          }
          const lBuild = DEP[k] > 0 ? -P.lambdaBuild * Math.min(1, DEP[k] / 10) * (1 - nearStop[k]) : 0;
          const lFam = md !== MODE_STILL ? FAM[k] : 0, pi = PI[k];
          const tPrior = Math.log((1 - pi) / pi), tFit = P.wFit * clamp(lFit, -6, 3), tTurn = P.wTurn * clamp(lTurn, -6, 3), tSpeed = P.wSpeed * clamp(lSpeed, -6, 3),
            tAccel = P.wAccel * clamp(lAccel, -6, 3), tSig = P.wSignal * clamp(lSig, -6, 3), tAlt = P.wAlt * clamp(lAlt, -6, 3), tBuild = P.wBuild * clamp(lBuild, -6, 3), tFam = P.wFam * clamp(lFam, -6, 3);
          const z = tPrior + tFit + tTurn + tSpeed + tAccel + tSig + tAlt + tBuild + tFam;
          c[i] = 1 / (1 + Math.exp(-z));
          if (marks) { const mk = marks.get(f.t); if (mk === false) { c[i] = 0; why[i] = 'marked'; } else if (mk === true) c[i] = Math.max(c[i], 0.99); }   // your own marks win
          w[k] = c[i];
          if (it === ITER - 1 && !opts.noParts) parts[i] = { prior: tPrior, fit: tFit, turn: tTurn, speed: tSpeed, accel: tAccel, signal: tSig, alt: tAlt, build: tBuild, fam: tFam };
        }
      }
      for (let k = 0; k < m; k++) route[seg[k]] = [lat0 + sy.xs[k] / ky, lng0 + sx.xs[k] / kx];
    }
    // Wi-Fi: the same network for wifiMinMin+ minutes = not moving. One position (a known place, or the median of the good fixes).
    for (let i = 0; i < n;) {
      const h = F[i].wifiH; if (!h || !c[i]) { i++; continue; }
      let j = i; while (j + 1 < n && (F[j + 1].wifiH === h || !F[j + 1].wifiH) && F[j + 1].t - F[j].t < 10 * 60000) j++;
      while (j > i && F[j].wifiH !== h) j--;
      if (F[j].t - F[i].t >= P.wifiMinMin * 60000) {
        const place = (opts.placeWifi || []).find((p) => p.hashes && p.hashes.includes(h));
        let lat, lng;
        if (place) { lat = place.lat; lng = place.lng; }
        else { const la = [], lo = []; for (let k = i; k <= j; k++) if (c[k] >= 0.5) { la.push(F[k].lat); lo.push(F[k].lng); } la.sort((a, b) => a - b); lo.sort((a, b) => a - b); lat = la.length ? la[la.length >> 1] : F[i].lat; lng = lo.length ? lo[lo.length >> 1] : F[i].lng; }
        for (let k = i; k <= j; k++) {
          if (!c[k]) continue;
          route[k] = [lat, lng]; still[k] = 1;
          const dd = d4(lat, lng, F[k].lat, F[k].lng), s = Math.sqrt(sig2(k));
          if (dd > 3 * s) { c[k] = Math.min(c[k], 0.1); why[k] = why[k] || 'wifi'; }
        }
      }
      i = j + 1;
    }
    let tentativeFrom = n;
    if (opts.live) for (let i = n - 1, cnt = 0; i >= 0 && cnt < P.lag; i--) if (c[i] > 0) { tentativeFrom = i; cnt++; }
    return { c, why, route, parts, still, mode, reg, tentativeFrom, P };
  }

  // Squares passed on several days (from confident, moving fixes): the "usual routes" memory.
  function familiarity(F, res) {
    const map = new Map();
    for (let i = 0; i < F.length; i++) {
      if (res.c[i] < 0.9 || res.still[i]) continue;
      const k = cellKey(F[i].lat, F[i].lng), e = map.get(k);
      if (!e) map.set(k, new Set([dayOf(F[i].t)])); else if (e.size < 64) e.add(dayOf(F[i].t));
    }
    return map;
  }

  const api = { clean, familiarity, regionOf, DEFAULTS, SLIDERS, cellKey };
  if (typeof module !== 'undefined') module.exports = api;
  else { root.TL = root.TL || {}; root.TL.clean = clean; root.TL.cleanApi = api; }
})(typeof self !== 'undefined' ? self : this);
