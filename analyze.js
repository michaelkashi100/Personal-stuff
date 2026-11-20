// Trajectory analysis: noisy timed position fixes -> a clean timeline of stays and legs, each leg with a
// guessed travel mode (walk / run / bike / drive / transit / flight).
//
//   1. collect   merge every fix we have (GPS points, path points, and Google's visit / activity endpoints)
//   2. clean     drop poor fixes and isolated GPS spikes
//   3. stays     noise-adaptive stay detection: the fixes stay inside a radius that grows with the reported accuracy
//   4. legs      the movement between stays is smoothed, windowed into speed statistics, and labelled with a
//                Viterbi pass over walk/run/bike/drive/transit/flight (Google's own activity hints act as a prior)
//   5. tidy      short stops inside a drive (traffic) are not arrivals; stays are named from Google's visits
(function (root) {
  const P = typeof module !== 'undefined' ? require('./parser.js') : root.TL;
  const RAD = Math.PI / 180;
  const d4 = (la1, ln1, la2, ln2) => {
    const dLat = (la2 - la1) * RAD, dLng = (ln2 - ln1) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * RAD) * Math.cos(la2 * RAD) * Math.sin(dLng / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(h));
  };
  const dist = (a, b) => d4(a.lat, a.lng, b.lat, b.lng);
  const CFG = { minStay: 5 * 60000, maxAcc: 150, rMin: 80, rMax: 200, mergeDist: 150, trafficStay: 12 * 60000, minLegDist: 60 };

  const MODES = ['walk', 'run', 'bike', 'drive', 'transit', 'flight'];
  function labelMode(type) {
    const t = String(type || '').toLowerCase().replace(/_/g, ' ');
    if (/passenger vehicle|in vehicle|road vehicle|^driving$|motorcycl|taxi|^in car$/.test(t)) return 'drive';
    if (/running|jog/.test(t)) return 'run';
    if (/walk|on foot|hik/.test(t)) return 'walk';
    if (/cycl|bicycle|bike/.test(t)) return 'bike';
    if (/rail|train|subway|tram|metro|bus|ferry/.test(t)) return 'transit';
    if (/fly|flight|plane/.test(t)) return 'flight';
    return null;
  }
  // Plausibility of each mode for a window's median / 90th-percentile speed (km/h): 0 outside [a,d], 1 inside [b,c].
  const trap = (x, a, b, c, d) => (x <= a || x >= d ? 0.001 : x < b ? 0.001 + (x - a) / (b - a) : x <= c ? 1 : 0.001 + (d - x) / (d - c));
  const SC = {
    walk: (m, p) => trap(m, 0.2, 1.5, 5.8, 8.5) * trap(p, 0.4, 2, 8.5, 12),
    run: (m, p) => 0.6 * trap(m, 6.5, 8.5, 13, 16) * trap(p, 8, 10, 19, 24),
    bike: (m, p) => 0.7 * trap(m, 8, 12, 23, 29) * trap(p, 10, 15, 32, 42),
    drive: (m, p) => trap(m, 9, 22, 120, 150) * trap(p, 20, 32, 135, 175),
    transit: (m, p) => 0.3 * trap(m, 30, 55, 250, 330) * trap(p, 40, 70, 300, 400),
    flight: (m, p) => trap(m, 150, 250, 950, 1100) * trap(p, 180, 300, 1000, 1200),
  };
  const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))] : 0);

  // ---------- 1. collect ----------
  function collect(data) {
    const F = [], pts = data.points.filter((p) => p.t === p.t);
    for (const p of pts) F.push({ t: p.t, lat: p.lat, lng: p.lng, acc: p.acc > 0 ? p.acc : 20, v: p.v });
    const times = pts.map((p) => p.t).sort((a, b) => a - b);
    const gapTo = (t) => {                                     // ms to the nearest dense fix
      let lo = 0, hi = times.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] < t) lo = m + 1; else hi = m; }
      return Math.min(lo < times.length ? times[lo] - t : Infinity, lo > 0 ? t - times[lo - 1] : Infinity);
    };
    const add = (t, lat, lng, acc) => { if (t === t && gapTo(t) > 120000) F.push({ t, lat, lng, acc }); };   // anchors only where fixes are missing
    for (const tr of data.trips) {
      if (tr.type === 'path' || tr.path.length < 2 || !(tr.end >= tr.start)) continue;   // path points already arrive as timed fixes
      const cum = [0];
      for (let i = 1; i < tr.path.length; i++) cum.push(cum[i - 1] + d4(tr.path[i - 1][0], tr.path[i - 1][1], tr.path[i][0], tr.path[i][1]));
      const tot = cum[cum.length - 1];
      tr.path.forEach((q, i) => add(tr.start + (tr.end - tr.start) * (tot > 0 ? cum[i] / tot : i / (tr.path.length - 1)), q[0], q[1], 25));
    }
    for (const v of data.visits) if (v.end >= v.start) { add(v.start, v.lat, v.lng, 30); add(v.end, v.lat, v.lng, 30); }
    F.sort((a, b) => a.t - b.t);
    const out = [];
    for (const f of F) { const q = out[out.length - 1]; if (q && q.t === f.t) { if (f.acc < q.acc) out[out.length - 1] = f; } else out.push(f); }
    return out;
  }

  // ---------- 2. clean ----------
  // A spike is 1-3 fixes far from both neighbours that bracket them, where the neighbours are close to each other.
  function despike(F) {
    const out = [];
    for (let i = 0; i < F.length; i++) {
      const q = out[out.length - 1];
      let skip = 0;
      if (q) for (let k = 1; k <= 3 && !skip; k++) {
        const n = F[i + k];
        if (!n || n.t - F[i].t > 600000) break;
        const a = dist(q, F[i]), b = dist(F[i + k - 1], n), c = dist(q, n);
        if (c < 0.4 * Math.min(a, b) && Math.min(a, b) > 250) skip = k;
      }
      if (skip) i += skip - 1; else out.push(F[i]);
    }
    return out;
  }

  // ---------- 3. stays ----------
  function detectStays(F) {
    const n = F.length, stays = [];
    let i = 0;
    while (i < n) {
      let j = i, cl = F[i].lat, cg = F[i].lng, cnt = 1, sa = F[i].acc, k = i + 1;
      const soft = [];                                           // recent fixes in the soft zone (just outside the radius)
      while (k < n) {
        const p = F[k], dd = d4(cl, cg, p.lat, p.lng);
        const R = Math.min(CFG.rMax, Math.max(CFG.rMin, (2.5 * sa) / cnt));
        if (dd <= R) { j = k; cl += (p.lat - cl) / (cnt + 1); cg += (p.lng - cg) / (cnt + 1); cnt++; sa += p.acc; soft.push(0); k++; continue; }
        // indoor GPS wanders: a fix just outside the radius is tolerated (but never moves the centre) unless
        // most of the recent fixes are out there, which means the user really is leaving
        if (dd <= 2.4 * R) { soft.push(1); if (soft.slice(-8).reduce((x, y) => x + y, 0) < 5) { j = k; k++; continue; } break; }
        let back = -1;                                           // an outlier fix that is followed by a return to the cluster
        for (let m = 1; m <= 3 && k + m < n; m++) { const q = F[k + m]; if (q.t - p.t > 180000) break; if (d4(cl, cg, q.lat, q.lng) <= R) { back = k + m; break; } }
        if (back < 0) break;
        k = back;
      }
      if (F[j].t - F[i].t >= CFG.minStay) {
        const r0 = Math.max(40, 0.5 * Math.min(CFG.rMax, Math.max(CFG.rMin, (2.5 * sa) / cnt)));   // still on the approach / departure
        let a = i, b = j;
        while (a < b - 1 && d4(cl, cg, F[a].lat, F[a].lng) > r0) a++;
        while (b > a + 1 && d4(cl, cg, F[b].lat, F[b].lng) > r0) b--;
        if (F[b].t - F[a].t < CFG.minStay) { a = i; b = j; }
        stays.push({ i0: a, i1: b, t0: F[a].t, t1: F[b].t, lat: cl, lng: cg, n: cnt });
        i = j + 1;
      } else i++;
    }
    // stays split by a brief wobble at the same place become one
    const out = [];
    for (const s of stays) {
      const p = out[out.length - 1];
      if (p && s.t0 - p.t1 < 60 * 60000 && d4(p.lat, p.lng, s.lat, s.lng) < CFG.mergeDist) {
        const ds = []; let path = 0;
        for (let x = p.i1; x <= s.i0; x++) { ds.push(d4(p.lat, p.lng, F[x].lat, F[x].lng)); if (x > p.i1) path += dist(F[x - 1], F[x]); }
        ds.sort((a, b) => a - b);
        // Noise, not a trip: either a short excursion that stays near the centre (robust to a few outlier fixes), or a
        // long zig-zag path that never gets far from where it started and comes back (indoor GPS flipping between spots).
        const ex = pct(ds, 0.95);
        if ((s.t0 - p.t1 < 15 * 60000 && pct(ds, 0.8) < 220) || (ex < 260 && path > 6 * Math.max(ex, 30))) { p.lat = (p.lat * p.n + s.lat * s.n) / (p.n + s.n); p.lng = (p.lng * p.n + s.lng * s.n) / (p.n + s.n); p.n += s.n; p.i1 = s.i1; p.t1 = s.t1; continue; }
      }
      out.push(s);
    }
    return out;
  }

  // ---------- 4. legs ----------
  function smoothPts(pts) {
    const n = pts.length, out = new Array(n);
    let lo = 0, hi = 0;
    for (let i = 0; i < n; i++) {
      if (i === 0 || i === n - 1) { out[i] = { t: pts[i].t, lat: pts[i].lat, lng: pts[i].lng, acc: pts[i].acc, v: pts[i].v }; continue; }
      while (pts[lo].t < pts[i].t - 6000) lo++;
      while (hi + 1 < n && pts[hi + 1].t <= pts[i].t + 6000) hi++;
      let sw = 0, sla = 0, sln = 0;
      for (let k = lo; k <= hi; k++) { const w = 1 / (pts[k].acc * pts[k].acc); sw += w; sla += w * pts[k].lat; sln += w * pts[k].lng; }
      out[i] = { t: pts[i].t, lat: sla / sw, lng: sln / sw, acc: pts[i].acc, v: pts[i].v };
    }
    return out;
  }
  function speedsOf(pts) {                                         // m/s per fix, over a >= 7.5 s baseline
    const n = pts.length, v = new Array(n);
    for (let i = 0; i < n; i++) {
      let a = i, b = i;
      while (a > 0 && pts[i].t - pts[a].t < 7500) a--;
      while (b < n - 1 && pts[b].t - pts[i].t < 7500) b++;
      const dt = (pts[b].t - pts[a].t) / 1000;
      v[i] = pts[i].v >= 0 && pts[i].acc <= 50 ? pts[i].v : dt > 0 ? dist(pts[a], pts[b]) / dt : 0;   // device speed when it is trustworthy
    }
    return v;
  }
  function makeWindows(pts, v) {                                   // ~90 s windows every ~30 s (skipping empty stretches)
    const n = pts.length, tEnd = pts[n - 1].t, wins = [];
    const dts = []; for (let i = 1; i < n; i++) dts.push(pts[i].t - pts[i - 1].t);
    dts.sort((a, b) => a - b);
    const half = Math.min(300000, Math.max(45000, 2 * pct(dts, 0.5))), step = Math.max(30000, half * 0.66);   // longer windows when fixes are sparse
    const lower = (t) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (pts[m].t < t) lo = m + 1; else hi = m; } return lo; };
    let tc = pts[0].t;
    for (;;) {
      let i0 = lower(tc - half), i1 = lower(tc + half + 1) - 1;
      if (i1 < i0) { i0 = Math.min(n - 1, i0); i1 = i0; }
      const s = v.slice(i0, i1 + 1).sort((a, b) => a - b);
      wins.push({ tc, i0, i1, med: pct(s, 0.5), p90: pct(s, 0.9), half });
      if (tc >= tEnd) break;
      let next = tc + step;
      const j = lower(tc + half + 1);
      next = j < n ? Math.max(next, pts[j].t - half) : tEnd;
      tc = Math.min(tEnd, next);
    }
    return wins;
  }
  function viterbi(wins, hintVotes) {
    const S = MODES.length, n = wins.length, NEG = -1e9;
    const em = wins.map((w) => {
      const votes = hintVotes(w), tot = Object.values(votes).reduce((a, b) => a + b, 0);
      return MODES.map((m) => {
        const boost = tot > 0 ? 1 + 2.5 * ((votes[m] || 0) / tot) * Math.min(1, tot / 2) : 1;
        return Math.log(Math.max(1e-3, SC[m](w.med * 3.6, w.p90 * 3.6) * boost));
      });
    });
    const foot = (a) => a === 0 || a === 1;
    const cost = (a, b) => (a === b ? 0 : foot(a) && foot(b) ? 1 : (a === 2 && b === 3) || (a === 3 && b === 2) ? 5.5 : 3.5);   // bike <-> car with no stop is unlikely
    const dp = [em[0].slice()], bp = [new Array(S).fill(0)];
    for (let t = 1; t < n; t++) {
      dp.push(new Array(S).fill(NEG)); bp.push(new Array(S).fill(0));
      for (let s = 0; s < S; s++) for (let r = 0; r < S; r++) { const c = dp[t - 1][r] - cost(r, s) + em[t][s]; if (c > dp[t][s]) { dp[t][s] = c; bp[t][s] = r; } }
    }
    let best = 0; for (let s = 1; s < S; s++) if (dp[n - 1][s] > dp[n - 1][best]) best = s;
    const lab = new Array(n); lab[n - 1] = best;
    for (let t = n - 1; t > 0; t--) lab[t - 1] = bp[t][lab[t]];
    return lab.map((s) => MODES[s]);
  }
  function rdp(pts, eps) {
    const n = pts.length;
    if (n <= 2) return n === 2 ? [0, 1] : [0];
    const la0 = pts[0].lat, kx = Math.cos(la0 * RAD) * 111320;
    const X = (i) => (pts[i].lng - pts[0].lng) * kx, Y = (i) => (pts[i].lat - la0) * 111320;
    const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
    const st = [[0, n - 1]];
    while (st.length) {
      const [a, b] = st.pop(), ax = X(a), ay = Y(a), dx = X(b) - ax, dy = Y(b) - ay, L2 = dx * dx + dy * dy;
      let mx = 0, mi = -1;
      for (let i = a + 1; i < b; i++) {
        let t = L2 ? ((X(i) - ax) * dx + (Y(i) - ay) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
        const d = Math.hypot(X(i) - (ax + t * dx), Y(i) - (ay + t * dy));
        if (d > mx) { mx = d; mi = i; }
      }
      if (mx > eps && mi > 0) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
    }
    const idx = []; for (let i = 0; i < n; i++) if (keep[i]) idx.push(i);
    return idx;
  }

  function legsFrom(pts, hints, head, tail) {                      // pts: timed fixes of one stretch of movement
    // head / tail: the stay centres at either end. They only extend the drawn path; their positions are
    // averages, so using them for speeds would invent speed spikes right where a stay starts or ends.
    if (pts.length < 2) { pts = [head].concat(pts, [tail]).filter(Boolean); head = tail = null; }
    if (pts.length < 2) return [];
    const sm = smoothPts(pts), v = speedsOf(sm), wins = makeWindows(sm, v);
    // two fixes more than 30 minutes apart = we do not know how the user got there (phone off, no signal)
    const gapLeg = pts.length <= 2 && pts[pts.length - 1].t - pts[0].t > 30 * 60000;
    const hintVotes = (w) => {
      const votes = {}; let lo = 0, hi = hints.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (hints[m].t < w.tc - Math.max(90000, w.half)) lo = m + 1; else hi = m; }
      for (let i = lo; i < hints.length && hints[i].t <= w.tc + Math.max(90000, w.half); i++) votes[hints[i].mode] = (votes[hints[i].mode] || 0) + hints[i].conf;
      return votes;
    };
    const labels = viterbi(wins, hintVotes);
    const lab = new Array(sm.length);
    for (let i = 0, w = 0; i < sm.length; i++) {
      while (w + 1 < wins.length && Math.abs(wins[w + 1].tc - sm[i].t) <= Math.abs(wins[w].tc - sm[i].t)) w++;
      lab[i] = labels[w];
    }
    let runs = [], s0 = 0;
    for (let i = 1; i <= sm.length; i++) if (i === sm.length || lab[i] !== lab[s0]) { runs.push({ a: s0, b: Math.min(i, sm.length - 1), mode: lab[s0] }); s0 = i; }
    const dur = (r) => sm[r.b].t - sm[r.a].t;
    const len = (r) => { let d = 0; for (let i = r.a + 1; i <= r.b; i++) d += dist(sm[i - 1], sm[i]); return d; };
    const join = () => { for (let k = runs.length - 1; k > 0; k--) if (runs[k].mode === runs[k - 1].mode) { runs[k - 1].b = runs[k].b; runs.splice(k, 1); } };
    for (let changed = true; changed && runs.length > 1;) {          // a "leg" shorter than a minute or 100 m is just a mode flicker
      changed = false; join();
      for (let k = 0; k < runs.length && runs.length > 1; k++) {
        const r = runs[k];
        if (dur(r) >= 60000 && len(r) >= 100) continue;
        const L = runs[k - 1], R = runs[k + 1];
        const tgt = L && R ? (L.mode === R.mode || dur(L) >= dur(R) ? k - 1 : k + 1) : L ? k - 1 : k + 1;
        if (tgt < k) runs[tgt].b = r.b; else runs[tgt].a = r.a;
        runs.splice(k, 1); changed = true; break;
      }
    }
    join();
    return runs.map((r, ri) => {
      let seg = sm.slice(r.a, r.b + 1);
      if (ri === 0 && head) seg = [head].concat(seg);
      if (ri === runs.length - 1 && tail) seg = seg.concat([tail]);
      const idx = rdp(seg, 6), vs = v.slice(r.a, r.b + 1).sort((a, b) => a - b);
      const path = idx.map((i) => [seg[i].lat, seg[i].lng]), times = idx.map((i) => seg[i].t);
      let d = 0; for (let i = 1; i < path.length; i++) d += d4(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
      const mid = (seg[0].t + seg[seg.length - 1].t) / 2, hinted = Object.keys(hintVotes({ tc: mid, half: (seg[seg.length - 1].t - seg[0].t) / 2 })).length > 0;
      const mode = gapLeg && !hinted ? 'other' : r.mode;                 // low confidence: say so instead of guessing
      return { kind: 'move', t0: seg[0].t, t1: seg[seg.length - 1].t, mode, uncertain: mode === 'other', path, times, dist: d, med: pct(vs, 0.5), p90: pct(vs, 0.9), max: vs[vs.length - 1] || 0, n: seg.length };
    });
  }

  function placeLabel(v) {
    const nm = v.name || '';
    if (nm && !/^[A-Za-z0-9_-]{20,}$/.test(nm)) return nm;           // skip opaque place IDs
    const t = (v.type || '').toLowerCase().replace(/_/g, ' ');
    return t && t !== 'unknown' && t !== 'place' ? t[0].toUpperCase() + t.slice(1) : 'Stopped';
  }

  // ---------- main ----------
  function analyze(data) {
    const F = despike(collect(data).filter((f) => f.acc <= CFG.maxAcc));
    if (F.length < 2) return [];
    // Google's own guesses become a soft prior: activity labels and per-fix activity records
    const hints = [];
    for (const h of data.hints || []) { const m = labelMode(h.type); if (m) hints.push({ t: h.t, mode: m, conf: h.conf }); }
    for (const tr of data.trips) {
      const m = tr.type === 'path' ? null : labelMode(tr.type);
      if (m && tr.end >= tr.start) for (let t = tr.start; t <= tr.end; t += 60000) hints.push({ t, mode: m, conf: 0.6 });
    }
    hints.sort((a, b) => a.t - b.t);

    const stays = detectStays(F), items = [];
    const centerFix = (s, t) => ({ t, lat: s.lat, lng: s.lng, acc: 10 });
    const addLegs = (pts, head, tail) => {
      // a leg with only one open end (start or end of the data) needs real evidence: a lone stray fix is not a trip
      if ((!head || !tail) && (pts.length < 3 || pts[pts.length - 1].t - pts[0].t < 60000)) return;
      for (const m of legsFrom(pts, hints, head, tail)) if (m.dist >= ((!head || !tail) ? 100 : CFG.minLegDist)) items.push(m);
    };
    let prev = null;
    for (const s of stays) {
      addLegs(F.slice(prev ? prev.i1 + 1 : 0, s.i0), prev ? centerFix(prev, prev.t1) : null, centerFix(s, s.t0));
      items.push({ kind: 'stay', t0: s.t0, t1: s.t1, lat: s.lat, lng: s.lng, name: 'Stopped', type: '', nd: 0 });
      prev = s;
    }
    if (prev) addLegs(F.slice(prev.i1 + 1), centerFix(prev, prev.t1), null);
    else addLegs(F, null, null);

    // a short stop between two legs of the same vehicle mode (traffic, a drop-off) is not an arrival
    const visitAt = (s) => {
      let best = null, bo = 0;
      for (const v of data.visits) {
        const o = Math.min(s.t1, v.end) - Math.max(s.t0, v.start);
        if (o > bo && d4(s.lat, s.lng, v.lat, v.lng) < 300) { bo = o; best = v; }
      }
      return best;
    };
    for (const it of items) if (it.kind === 'stay') { const v = visitAt(it); it.visit = v || null; if (v) { it.name = placeLabel(v); it.type = v.type; it.nd = it.t1 - it.t0; } }
    for (let k = 1; k < items.length - 1; k++) {
      const s = items[k], a = items[k - 1], b = items[k + 1];
      if (s.kind === 'stay' && !s.visit && s.t1 - s.t0 < CFG.trafficStay && a.kind === 'move' && b.kind === 'move' && a.mode === b.mode && (a.mode === 'drive' || a.mode === 'bike' || a.mode === 'transit')) {
        const path = a.path.concat(b.path.slice(1)), times = a.times.concat(b.times.slice(1));
        items.splice(k - 1, 3, { kind: 'move', t0: a.t0, t1: b.t1, mode: a.mode, path, times, dist: a.dist + b.dist, med: Math.max(a.med, b.med), p90: Math.max(a.p90, b.p90), max: Math.max(a.max, b.max), n: a.n + b.n });
        k = Math.max(0, k - 2);
      }
    }
    // an unnamed place where the nights are spent is most likely home
    const cell = (s) => Math.round(s.lat * 400) + ',' + Math.round(s.lng * 400);
    const night = new Map();
    for (const it of items) if (it.kind === 'stay') { let h = 0; for (let t = it.t0; t < it.t1; t += 1800000) { const hr = new Date(t).getHours(); if (hr >= 22 || hr < 7) h += 0.5; } night.set(cell(it), (night.get(cell(it)) || 0) + h); }
    let home = null, hb = 3; for (const [c, h] of night) if (h > hb) { hb = h; home = c; }
    for (const it of items) if (it.kind === 'stay' && it.name === 'Stopped' && cell(it) === home) it.name = 'Home';
    for (const it of items) if (it.kind === 'stay') it.nd = it.t1 - it.t0;
    return items;
  }

  // Yearly numbers from the timeline (so the stats agree with what the replay shows).
  function statsFromTimeline(tl, year) {
    const inYear = (t) => year == null || new Date(t).getFullYear() === year;
    const stays = tl.filter((s) => s.kind === 'stay' && inYear(s.t0)), legs = tl.filter((s) => s.kind === 'move' && inYear(s.t0));
    const byMode = {}; let total = 0, longest = null;
    for (const l of legs) { byMode[l.mode] = (byMode[l.mode] || 0) + l.dist / 1000; total += l.dist; if (!longest || l.dist > longest.dist) longest = { dist: l.dist, mode: l.mode, start: l.t0 }; }
    // one place = every stay within 150 m of it (a coarse grid would split a home near a cell edge into two)
    const places = [];
    for (const s of stays) {
      let p = null, pd = 150;
      for (const q of places) { const d = d4(s.lat, s.lng, q.lat, q.lng); if (d < pd) { pd = d; p = q; } }
      if (!p) { p = { lat: s.lat, lng: s.lng, name: '', visits: 0, hours: 0, names: {} }; places.push(p); }
      const h = (s.t1 - s.t0) / 3.6e6;
      p.lat += (s.lat - p.lat) / (p.visits + 1); p.lng += (s.lng - p.lng) / (p.visits + 1);
      p.visits++; p.hours += h;
      if (s.name && s.name !== 'Stopped') p.names[s.name] = (p.names[s.name] || 0) + h;
    }
    for (const p of places) p.name = Object.keys(p.names).sort((x, y) => p.names[y] - p.names[x])[0] || '';
    const days = new Set(); for (const s of tl) if (inYear(s.t0)) days.add(new Date(s.t0).toDateString());
    return { totalKm: total / 1000, byModeKm: byMode, visitCount: stays.length, uniquePlaces: places.length, topPlaces: places.slice().sort((a, b) => b.hours - a.hours).slice(0, 5), activeDays: days.size, longest };
  }

  const api = { analyze, statsFromTimeline, CFG, labelMode };
  if (typeof module !== 'undefined') module.exports = Object.assign(P, api); else Object.assign(P, api);
})(typeof self !== 'undefined' ? self : this);
