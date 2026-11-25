// Tuning the GPS cleaning from your own data (runs in a Web Worker, see tune-worker.js; plain functions, so Node tests too).
//
//  E. learnNoise   how much your phone's GPS wobbles and how often it jumps, measured at places where you stayed a
//                  long time (you were not moving, so every metre of spread is GPS error). Sets the matching settings,
//                  then checks them on simulated walks with that noise (known truth) and keeps a value only if it helps.
//  A. holdout      hide every 5th fix, rebuild the path from the others, and measure how close the path passes to the
//                  hidden fixes (errors capped, so a hidden jump cannot dominate). No labels needed.
//  B. marks        fixes you marked "wrong" / "right" in the Path lab: the settings should agree with them.
//  search          coordinate search over the settings that shape the path, minimising  holdout error + 5 x marks loss.
(function (root) {
  const C = typeof module !== 'undefined' ? require('./clean.js') : root.TL.cleanApi;
  const RAD = Math.PI / 180;
  const dist = (la1, ln1, la2, ln2) => { const dLat = (la2 - la1) * RAD, dLng = (ln2 - ln1) * RAD, h = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * RAD) * Math.cos(la2 * RAD) * Math.sin(dLng / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(h)); };
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const median = (a) => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const KEYS = ['jumpRate', 'sigmaMin', 'jumpRadius', 'wFit', 'wTurn', 'kWalk', 'kCar', 'wSpeed', 'wAccel', 'lag', 'dwellMin'];
  const range = (key) => { const s = C.SLIDERS.find((x) => x[0] === key); return s ? { min: s[2], max: s[3], step: s[4] } : { min: 0, max: 10, step: 0.1 }; };
  const snap = (key, v) => { const r = range(key); v = clamp(v, r.min, r.max); return +(Math.round(v / r.step) * r.step).toFixed(4); };

  // ---- A. hold-out score ----
  function holdout(F, P, ctx) {
    ctx = ctx || {};
    const markSet = new Set((ctx.marks || []).map((m) => m.t));
    const keep = [], hide = [];
    for (let i = 0; i < F.length; i++) (i % 5 === 2 && i > 0 && i < F.length - 1 && !markSet.has(F[i].t) ? hide : keep).push(F[i]);
    const res = C.clean(keep, { params: P, noParts: true, trusted: ctx.trusted, placeWifi: ctx.placeWifi });
    const cap = ctx.cap || 60, T = keep.map((f) => f.t), ok = (j) => res.route[j] && res.c[j] >= res.P.keep;
    let sum = 0, n = 0;
    for (const h of hide) {
      let lo = 0, hi = T.length; while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] <= h.t) lo = m + 1; else hi = m; }
      let a = lo - 1, b = lo, s = 0;
      while (a >= 0 && !ok(a) && s++ < 5) a--;
      s = 0; while (b < keep.length && !ok(b) && s++ < 5) b++;
      if (a < 0 || b >= keep.length || !ok(a) || !ok(b) || T[b] - T[a] > 180000) continue;
      const u = T[b] === T[a] ? 0 : (h.t - T[a]) / (T[b] - T[a]), A = res.route[a], B = res.route[b];
      sum += Math.min(cap, dist(A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u, h.lat, h.lng)); n++;
    }
    // B. agreement with your marks (the marks themselves are not applied here, or they would always agree)
    let mloss = 0, mn = 0, agree = 0;
    if (ctx.marks && ctx.marks.length) {
      const idx = new Map(keep.map((f, j) => [f.t, j]));
      for (const m of ctx.marks) { const j = idx.get(m.t); if (j == null) continue; const c = res.c[j], p = clamp(m.ok ? c : 1 - c, 0.01, 1); mloss -= Math.log(p); mn++; if ((c >= 0.5) === !!m.ok) agree++; }
    }
    const err = n ? sum / n : Infinity, marks = mn ? mloss / mn : 0;
    return { err, n, marks, agree: mn ? agree / mn : null, nMarks: mn, J: err + 5 * marks };
  }

  // ---- E. your phone's noise, from long stays ----
  function learnNoise(F, stays) {
    const rs = [], accs = [], outs = [], alts = [];
    let used = 0, total = 0, out = 0;
    const T = F.map((f) => f.t);
    for (const s of stays || []) {
      if (s.t1 - s.t0 < 30 * 60000) continue;
      let lo = 0, hi = T.length; while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < s.t0) lo = m + 1; else hi = m; }
      const pts = []; for (let i = lo; i < F.length && F[i].t <= s.t1; i++) if (C.regionOf(F[i].lat, F[i].lng) !== 'never') pts.push(F[i]);   // interference is not GPS noise
      if (pts.length < 8) continue;
      used++;
      const cl = median(pts.map((p) => p.lat)), cg = median(pts.map((p) => p.lng));   // the stay's own centre (robust)
      const d = pts.map((p) => dist(cl, cg, p.lat, p.lng)), sg = Math.max(3, median(d) / 1.1774);   // Rayleigh: median = 1.18 sigma
      pts.forEach((p, k) => { if (d[k] > 3000) return; total++; if (d[k] > Math.max(3 * sg, 50)) { out++; outs.push(d[k]); } else { rs.push(d[k]); accs.push(p.acc || 20); } });   // kilometres away = interference, not a jump
      const al = pts.filter((p) => p.alt != null).map((p) => p.alt);
      if (al.length >= 8) { const ma = median(al); alts.push(...al.map((a) => a - ma)); }
    }
    if (!used || total < 30) return null;
    const sigma = median(rs) / 1.1774, medAcc = median(accs);
    const learned = {
      sigmaMin: snap('sigmaMin', Math.sqrt(Math.max(4, sigma * sigma - medAcc * medAcc))),
      jumpRate: snap('jumpRate', clamp((1.5 * out) / total, 0.01, 0.3)),
      jumpRadius: snap('jumpRadius', outs.length >= 3 ? median(outs) : 150),
    };
    if (alts.length >= 30) { const mad = median(alts.map(Math.abs)) * 1.4826; learned.altTol = snap('altTol', 3 * mad); }
    return { learned, stats: { stays: used, fixes: total, wobble: sigma, medAcc, jumpPct: (100 * out) / total, jumpSize: outs.length ? median(outs) : null } };
  }

  // Simulated walks with a given noise (known truth): used to check that learned values really help.
  function simWalk(seed, noise) {
    let s = seed >>> 0 || 1; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296), g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
    const O = { lat: 32.0853, lng: 34.7818 }, KX = 111320 * Math.cos(O.lat * RAD), KY = 110540, F = [], truth = [];
    let x = 0, y = 0, t = Date.UTC(2026, 0, 1, 8), h = 0;
    for (let L = 0; L < 12; L++) {
      const len = 80 + r() * 80;
      for (let d = 0; d < len; d += 5.6) {
        x += Math.sin(h) * 5.6; y += Math.cos(h) * 5.6; t += 4000;
        let px = x + g() * noise.wobble, py = y + g() * noise.wobble;
        if (r() < noise.jumpRate) { const a = r() * 6.283, dd = noise.jumpSize * (0.5 + r()); px = x + Math.sin(a) * dd; py = y + Math.cos(a) * dd; }
        truth.push([O.lat + y / KY, O.lng + x / KX]); F.push({ t, lat: O.lat + py / KY, lng: O.lng + px / KX, acc: Math.round(noise.acc) });
      }
      h += (r() < 0.5 ? 1 : -1) * Math.PI / 2;
    }
    return { F, truth };
  }
  function simError(P, noise) {
    let e = 0, n = 0;
    for (const seed of [3, 7, 11]) { const { F, truth } = simWalk(seed, noise), res = C.clean(F, { params: P, noParts: true }); for (let i = 0; i < F.length; i++) if (res.route[i]) { e += Math.min(80, dist(res.route[i][0], res.route[i][1], truth[i][0], truth[i][1])); n++; } }
    return e / Math.max(1, n);
  }

  // ---- the whole run: E, check E on simulations, then A (+ B) ----
  function run(F, ctx, onProgress) {
    ctx = ctx || {};
    const start = Object.assign({}, C.DEFAULTS, ctx.start || {}), report = { steps: [] };
    const say = (msg, frac) => { if (onProgress) onProgress({ msg, frac }); };
    say('Measuring how your GPS wobbles…', 0.02);
    let P = Object.assign({}, start);
    const noise = learnNoise(F, ctx.stays);
    report.noise = noise ? noise.stats : null;
    if (noise) {
      const simN = { wobble: Math.max(2, noise.stats.wobble), jumpRate: Math.min(0.3, noise.stats.jumpPct / 100 + 0.02), jumpSize: noise.stats.jumpSize || 100, acc: noise.stats.medAcc || 8 };
      let base = simError(P, simN);
      for (const k of Object.keys(noise.learned)) {
        const trial = Object.assign({}, P, { [k]: noise.learned[k] }), e = simError(trial, simN);
        const keep = e <= base * 1.02;
        report.steps.push({ key: k, from: P[k], to: noise.learned[k], kept: keep, why: 'measured' });
        if (keep) { P = trial; base = Math.min(base, e); }
      }
    }
    say('Testing settings on your own days…', 0.1);
    const before = holdout(F, start, ctx);
    let best = holdout(F, P, ctx);
    const total = 2 * KEYS.length * 2;
    let done = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (const k of KEYS) {
        const r = range(k), v = P[k];
        const cands = k === 'lag' ? [v - 4, v + 4] : [v * 0.6 || r.step, v * 1.5 || r.step * 3];
        for (const c0 of cands) {
          const c = snap(k, c0); done++;
          say('Trying ' + k + ' = ' + c, 0.1 + 0.88 * Math.min(1, done / total));
          if (c === P[k]) continue;
          const trial = Object.assign({}, P, { [k]: c }), sc = holdout(F, trial, ctx);
          if (sc.J < best.J * 0.995) { report.steps.push({ key: k, from: P[k], to: c, kept: true, why: 'better on your days' }); P = trial; best = sc; }
        }
      }
    }
    say('Done', 1);
    const changed = {}; for (const k in P) if (P[k] !== start[k]) changed[k] = P[k];
    return { params: P, changed, before, after: best, report };
  }

  const api = { holdout, learnNoise, simWalk, simError, run, KEYS };
  if (typeof module !== 'undefined') module.exports = api; else { root.TL = root.TL || {}; root.TL.tune = api; }
})(typeof self !== 'undefined' ? self : this);
