// Synthetic Timeline "days" with known ground truth and realistic GPS noise (no real data).
// Used to measure stay detection and travel-mode recognition in analyze.js.
const O = { lat: 32.0853, lng: 34.7818 };
function rng(seed) { let s = seed >>> 0 || 1; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); r.g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); return r; }

// plan: [{ stay: minutes, indoor? } | { move: 'walk'|'bike'|'drive'|'train', m: metres }]
function simulate(seed, plan, o = {}) {
  const r = rng(seed), dtMove = 5, dtStill = o.dtStill || 45;
  let seg_hint = null, x = 0, y = 0, t = Date.UTC(2026, 5, 10), h = r() * 6.28, fixes = [], gt = [];
  const push = (px, py, sig, acc, v) => {
    const f = { x: px + r.g() * sig, y: py + r.g() * sig, t, acc };
    if (o.velocity && v != null) f.v = Math.max(0, v + r.g() * 0.25);
    if (seg_hint) f.hint = seg_hint;
    fixes.push(f);
  };
  for (const seg of plan) {
    const t0 = t;
    if (seg.gap != null) { t += seg.gap * 60000; if (seg.teleport) { x += seg.teleport * Math.sin(h); y += seg.teleport * Math.cos(h); } continue; }
    if (seg.stay != null) {
      const end = t + seg.stay * 60000, cx = x, cy = y, ns = seg.noise || 1; let dx = 0, dy = 0, alt = 0;
      while (t < end) {
        dx = Math.max(-45 * ns, Math.min(45 * ns, dx + r.g() * 4 * ns)); dy = Math.max(-45 * ns, Math.min(45 * ns, dy + r.g() * 4 * ns)); alt ^= 1;
        if (r() > 0.04) {
          if (r() < 0.02) push(cx + (r() - 0.5) * 700, cy + (r() - 0.5) * 700, 0, 90 + r() * 50, 0);      // wifi/cell outlier
          else push(cx + dx + (seg.alt ? (alt ? seg.alt : -seg.alt) : 0), cy + dy, (seg.indoor === false ? 6 : 22) * ns, seg.indoor === false ? 8 + r() * 6 : 25 + r() * 35, 0.05);
        }
        t += dtStill * 1000 * (0.7 + r() * 0.6);
      }
      gt.push({ kind: 'stay', t0, t1: Math.min(t, end) });
    } else {
      const mode = seg.move; seg_hint = seg.hint || null;
      let left = seg.m, v = 0, sinceLight = 0, lightAt = 350 + r() * 250, stopLeft = 0, city = mode === 'drive' ? Math.min(3500, seg.m * 0.5) : 0, travelled = 0;
      push(x, y, 5, 6 + r() * 5, 0);
      while (left > 0) {
        const dt = dtMove * (0.8 + r() * 0.4);
        let target;
        if (mode === 'walk') target = 1.4 + r.g() * 0.15;
        else if (mode === 'run') target = 3.0 + r.g() * 0.25;
        else if (mode === 'bike') target = 5.5 + r.g() * 0.5;
        else if (mode === 'train') target = 38 + r.g() * 1;
        else target = travelled < city ? 12 + r.g() * 1.5 : 26 + r.g() * 1.5;
        if ((mode === 'drive' && travelled < city) || mode === 'bike') {                 // traffic lights
          if (stopLeft > 0) { target = 0; stopLeft -= dt; }
          else if (sinceLight > lightAt) { stopLeft = (mode === 'bike' ? 8 : 15) + r() * 25; sinceLight = 0; lightAt = 350 + r() * 250; target = 0; if (mode === 'drive') h += (r() < 0.5 ? 1 : -1) * 1.5708; }
        }
        v += (target - v) * Math.min(1, dt / (mode === 'walk' ? 2 : 6));
        if (mode === 'walk' || mode === 'bike' || mode === 'run') h += (seg.loop ? 0.0 : 0.0) + r.g() * 0.03 + (seg.loop ? 6.2832 / (seg.m / Math.max(0.1, v * dt)) : 0); else if (mode === 'drive' && travelled >= city) h += r.g() * 0.01;
        const step = Math.max(0, v) * dt; x += step * Math.sin(h); y += step * Math.cos(h); left -= step; sinceLight += step; travelled += step; t += dt * 1000;
        push(x, y, mode === 'drive' || mode === 'train' ? 5 : 6, 5 + r() * 7, v);
        if (r() < 0.02) fixes[fixes.length - 1].x += r.g() * 40;                                  // multipath glitch
      }
      seg_hint = null;
      gt.push({ kind: 'move', mode: mode === 'train' ? 'transit' : mode, t0, t1: t });
    }
  }
  if (o.sparse) { const thin = [], rr = rng(seed + 99); let last = -1e18; for (const f of fixes) if (f.t - last >= o.sparse * 1000 * (0.8 + rr() * 0.4)) { thin.push(f); last = f.t; } fixes = thin; }
  const kx = 111320 * Math.cos(O.lat * Math.PI / 180);
  const locations = fixes.map((f) => ({ latitudeE7: Math.round((O.lat + f.y / 111320) * 1e7), longitudeE7: Math.round((O.lng + f.x / kx) * 1e7), accuracy: Math.round(f.acc), timestamp: new Date(f.t).toISOString(), ...(f.v != null && o.velocity ? { velocity: +f.v.toFixed(2) } : {}), ...(f.hint ? { activity: [{ timestamp: new Date(f.t).toISOString(), activity: [{ type: f.hint, confidence: 80 }] }] } : {}) }));
  return { json: { locations }, gt };
}

const COMMUTE = [
  { stay: 420 }, { move: 'walk', m: 600 }, { move: 'drive', m: 18000 }, { move: 'walk', m: 250 },
  { stay: 230 }, { move: 'walk', m: 500 }, { stay: 30, indoor: false }, { move: 'walk', m: 500 }, { stay: 200 },
  { move: 'bike', m: 7000 }, { stay: 60 }, { move: 'walk', m: 1200 }, { stay: 480 },
];

// Compare a timeline (from analyze) with ground truth.
function evaluate(timeline, gt) {
  const at = (t) => timeline.find((s) => t >= s.t0 && t <= s.t1) || null;
  const conf = {}; let moveOk = 0, moveN = 0, stayOk = 0, stayN = 0;
  for (const g of gt) {
    for (let t = g.t0 + 90000; t < g.t1 - 90000; t += 10000) {
      const s = at(t);
      if (g.kind === 'stay') { stayN++; if (s && s.kind === 'stay') stayOk++; }
      else { moveN++; const got = s ? (s.kind === 'stay' ? 'stay' : s.mode) : 'none'; const k = g.mode + '->' + got; conf[k] = (conf[k] || 0) + 1; if (got === g.mode) moveOk++; }
    }
  }
  const gStays = gt.filter((g) => g.kind === 'stay' && g.t1 - g.t0 >= 8 * 60000);
  const dStays = timeline.filter((s) => s.kind === 'stay');
  const found = gStays.filter((g) => dStays.some((s) => Math.min(g.t1, s.t1) - Math.max(g.t0, s.t0) >= 0.8 * (g.t1 - g.t0))).length;
  const falseStays = dStays.filter((s) => !gt.some((g) => g.kind === 'stay' && Math.min(g.t1, s.t1) - Math.max(g.t0, s.t0) >= 0.5 * (s.t1 - s.t0))).length;
  return { stayTime: stayN ? stayOk / stayN : 1, modeTime: moveN ? moveOk / moveN : 1, stayRecall: gStays.length ? found / gStays.length : 1, gtStays: gStays.length, falseStays, conf };
}
module.exports = { simulate, evaluate, COMMUTE };
