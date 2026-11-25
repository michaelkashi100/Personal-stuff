// Ground-truth evaluation of clean.js: a city walk with close-by GPS jumps (single fixes and short visits to a wrong
// spot), plus the place rules (spoofing to Lebanon, real and fake trips abroad). usage: node test/clean-eval.js
const C = require('../clean.js');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
function rng(seed) { let s = seed >>> 0 || 1; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); r.g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); return r; }
const O = { lat: 32.0853, lng: 34.7818 }, KX = 111320 * Math.cos(O.lat * Math.PI / 180), KY = 110540;
const toLL = (x, y) => [O.lat + y / KY, O.lng + x / KX];

// A walk on a street grid (blocks of 80-160 m, 90-degree turns at corners), one fix every ~4 s.
function cityWalk(seed, o = {}) {
  const r = rng(seed), fixes = [], truth = [], bad = [];
  let x = 0, y = 0, t = Date.UTC(2026, 10, 20, 8), h = 0;
  const legs = o.legs || 14;
  for (let L = 0; L < legs; L++) {
    const len = 80 + r() * 80, v = (o.speed || 1.4) * (0.9 + r() * 0.2);
    for (let d = 0; d < len; d += v * 4) {
      x += Math.sin(h) * v * 4; y += Math.cos(h) * v * 4; t += 4000;
      truth.push([x, y]);
      fixes.push({ t, x: x + r.g() * 4, y: y + r.g() * 4, acc: 5 + r() * 6 }); bad.push(false);
    }
    h += (r() < 0.5 ? 1 : -1) * Math.PI / 2;
  }
  // single jumps: 30-150 m sideways
  for (let i = 3; i < fixes.length - 3; i++) if (r() < (o.jumpRate ?? 0.08)) { const a = r() * 6.283, d = 30 + r() * 120; fixes[i].x = truth[i][0] + Math.sin(a) * d; fixes[i].y = truth[i][1] + Math.cos(a) * d; bad[i] = true; }
  // short visits to a wrong spot: 3-5 fixes in a row at one place 60-120 m away
  for (let e = 0; e < (o.clusters ?? 3); e++) {
    const i0 = 10 + Math.floor(r() * (fixes.length - 20)), len = 3 + Math.floor(r() * 3), a = r() * 6.283, d = 60 + r() * 60;
    const sx = truth[i0][0] + Math.sin(a) * d, sy = truth[i0][1] + Math.cos(a) * d;
    for (let k = i0; k < Math.min(fixes.length - 2, i0 + len); k++) { fixes[k].x = sx + r.g() * 3; fixes[k].y = sy + r.g() * 3; bad[k] = true; }
  }
  const F = fixes.map((f) => { const [lat, lng] = toLL(f.x, f.y); return { t: f.t, lat, lng, acc: Math.round(f.acc) }; });
  return { F, truth, bad };
}
const err = (ll, tr) => Math.hypot((ll[1] - O.lng) * KX - tr[0], (ll[0] - O.lat) * KY - tr[1]);
function auc(scoresGood, scoresBad) {           // P(random genuine fix scores higher than random jump)
  let win = 0; for (const g of scoresGood) for (const b of scoresBad) win += g > b ? 1 : g === b ? 0.5 : 0;
  return win / (scoresGood.length * scoresBad.length);
}

// ---- 1. city walk ----
let tot = { raw: 0, rawGood: 0, route: 0, n: 0, aucs: [], flag: 0, nBad: 0, lose: 0, nGood: 0, p95: [] };
for (const seed of [1, 2, 3, 4, 5, 6]) {
  const { F, truth, bad } = cityWalk(seed), res = C.clean(F);
  const good = [], badS = [];
  for (let i = 0; i < F.length; i++) {
    const e = err(res.route[i], truth[i]);
    tot.raw += err([F[i].lat, F[i].lng], truth[i]) ** 2; tot.route += e ** 2; tot.n++; tot.p95.push(e);
    if (!bad[i]) tot.rawGood += err([F[i].lat, F[i].lng], truth[i]) ** 2;
    (bad[i] ? badS : good).push(res.c[i]);
    if (bad[i]) { tot.nBad++; if (res.c[i] < 0.5) tot.flag++; } else { tot.nGood++; if (res.c[i] < 0.5) tot.lose++; }
  }
  tot.aucs.push(auc(good, badS));
}
const rmse = (s) => Math.sqrt(s / tot.n).toFixed(1);
tot.p95.sort((a, b) => a - b);
console.log(`   raw error ${rmse(tot.raw)} m (genuine fixes alone ${Math.sqrt(tot.rawGood / tot.nGood).toFixed(1)} m) -> likely path ${rmse(tot.route)} m, 95% within ${tot.p95[Math.floor(0.95 * tot.p95.length)].toFixed(1)} m`);
console.log(`   jumps caught ${(100 * tot.flag / tot.nBad).toFixed(0)}%, genuine fixes wrongly below 0.5: ${(100 * tot.lose / tot.nGood).toFixed(1)}%, AUC ${(tot.aucs.reduce((a, b) => a + b) / tot.aucs.length).toFixed(3)}`);
ok(Math.sqrt(tot.route / tot.n) < 8, 'the likely path stays within ~8 m of the true walk (RMS)');
ok(Math.sqrt(tot.route / tot.n) < Math.sqrt(tot.raw / tot.n) / 3, 'the likely path is far closer to the truth than the raw fixes');
ok(tot.flag / tot.nBad > 0.8, 'most jumps get a confidence below 0.5');
ok(tot.lose / tot.nGood < 0.05, 'fewer than 5% of genuine fixes are doubted');
ok(Math.min(...tot.aucs) > 0.95, 'confidence separates jumps from genuine fixes (AUC > 0.95 on every walk)');

// confidence is a number, not just yes/no
{ const { F } = cityWalk(9), res = C.clean(F), mid = [...res.c].filter((x) => x > 0.15 && x < 0.85).length;
  ok(mid > 0, 'some fixes get in-between confidences (' + mid + ' of ' + F.length + ')'); }

// look-ahead: with no look-ahead (decide at once) the path is worse than with the default
{ let e0 = 0, e1 = 0, nn = 0;
  for (const seed of [11, 12, 13]) { const { F, truth } = cityWalk(seed); const a = C.clean(F, { params: { lag: 0 } }), b = C.clean(F); for (let i = 0; i < F.length; i++) { e0 += err(a.route[i], truth[i]) ** 2; e1 += err(b.route[i], truth[i]) ** 2; nn++; } }
  console.log(`   look-ahead 0 -> ${Math.sqrt(e0 / nn).toFixed(1)} m, look-ahead ${C.DEFAULTS.lag} -> ${Math.sqrt(e1 / nn).toFixed(1)} m`);
  ok(e1 < e0, 'looking ahead a few fixes gives a better path than deciding at once'); }

// live: the newest fixes are marked as not final
{ const { F } = cityWalk(14), res = C.clean(F, { live: true }); ok(res.tentativeFrom === F.length - C.DEFAULTS.lag, 'live: the last ' + C.DEFAULTS.lag + ' fixes are tentative'); }

// ---- 2. places ----
const at = (lat, lng, t, acc = 8) => ({ t, lat, lng, acc });
const H = 3600000, t0 = Date.UTC(2026, 10, 20, 6);
function series(lat, lng, from, hours, stepMin = 5) { const out = []; for (let t = from; t < from + hours * H; t += stepMin * 60000) out.push(at(lat + (Math.random() - 0.5) * 2e-4, lng + (Math.random() - 0.5) * 2e-4, t)); return out; }
ok(C.regionOf(32.08, 34.78) === 'home' && C.regionOf(31.77, 35.21) === 'home' && C.regionOf(33.0, 35.75) === 'home' && C.regionOf(31.9, 35.2) === 'home', 'Tel Aviv, Jerusalem, the Golan and the West Bank are home');
ok(C.regionOf(29.52, 34.93) === 'home' && C.regionOf(33.10, 35.12) === 'home', 'Eilat and Rosh HaNikra (border towns) are home');
ok(C.regionOf(33.82, 35.49) === 'never' && C.regionOf(33.51, 36.29) === 'never' && C.regionOf(30.04, 31.24) === 'never' && C.regionOf(31.95, 35.93) === 'never', 'Beirut, Damascus, Cairo and Amman are never real');
ok(C.regionOf(51.5, -0.12) === 'abroad' && C.regionOf(41.0, 28.97) === 'abroad' && C.regionOf(34.9, 33.6) === 'abroad', 'London, Istanbul and Cyprus are abroad (allowed for real trips)');
{ // spoofing: two hours "at Beirut airport" in the middle of a day in Tel Aviv
  const F = [].concat(series(32.08, 34.78, t0, 3), series(33.82, 35.49, t0 + 3 * H, 2), series(32.08, 34.78, t0 + 5 * H, 3));
  const res = C.clean(F), bei = F.map((f, i) => i).filter((i) => F[i].lat > 33.5);
  ok(bei.every((i) => res.c[i] === 0 && res.why[i] === 'never'), 'two hours "in Beirut" are ignored (confidence 0)');
  ok(F.every((f, i) => f.lat > 33.5 || res.c[i] > 0.5), 'the Tel Aviv fixes around it are kept'); }
{ // a real trip: Tel Aviv, flight gap, three days in London
  const F = [].concat(series(32.0, 34.88, t0, 2), series(51.47, -0.45, t0 + 7 * H, 72, 15), series(32.0, 34.88, t0 + 84 * H, 2));
  const res = C.clean(F); ok(F.every((f, i) => res.c[i] > 0.3), 'a three-day trip to London (reached by plane) is kept'); }
{ // three hours "in London" between two fixes in Tel Aviv an hour apart: impossible
  const F = [].concat(series(32.08, 34.78, t0, 2), series(51.5, -0.12, t0 + 2 * H + 600000, 3), series(32.08, 34.78, t0 + 5 * H + 1200000, 2));
  const res = C.clean(F), lon = F.map((f, i) => i).filter((i) => F[i].lat > 50);
  ok(lon.every((i) => res.c[i] === 0 && res.why[i] === 'abroad'), 'a few hours "in London" without a flight are ignored'); }
{ // "I really was there": a confirmed stretch is kept
  const F = [].concat(series(32.08, 34.78, t0, 2), series(51.5, -0.12, t0 + 2 * H + 600000, 3), series(32.08, 34.78, t0 + 5 * H + 1200000, 2));
  const res = C.clean(F, { trusted: [[t0 + 2 * H, t0 + 6 * H]] });
  ok(F.every((f, i) => f.lat < 50 || res.c[i] > 0), 'a stretch you confirmed is kept'); }
{ // Wi-Fi: same network for 30 min = one position, GPS wandering 300 m is noise
  const F = []; for (let k = 0; k < 30; k++) F.push({ t: t0 + k * 60000, lat: 32.08 + (k % 7 === 3 ? 0.0027 : (Math.random() - 0.5) * 1e-4), lng: 34.78, acc: 15, wifiH: 'abc' });
  const res = C.clean(F), r0 = res.route[0];
  ok(res.route.every((r) => r[0] === r0[0] && r[1] === r0[1]), 'same Wi-Fi for 30 minutes = one position');
  ok(F.every((f, i) => Math.abs(f.lat - 32.0827) > 0.001 || res.c[i] <= 0.1), 'GPS wandering 300 m away while on the same Wi-Fi is doubted');
  const res2 = C.clean(F, { placeWifi: [{ lat: 32.0801, lng: 34.7803, hashes: ['abc'] }] });
  ok(res2.route[5][0] === 32.0801, 'a place that knows this Wi-Fi puts you there'); }
{ // altitude: one fix 60 m above its neighbours
  const { F } = cityWalk(21, { jumpRate: 0, clusters: 0 }); F.forEach((f) => (f.alt = 30));
  const i = 40; F[i].alt = 95; const res = C.clean(F);
  ok(res.parts[i].alt < -1 && res.c[i] < res.c[i - 1], 'a fix 65 m above its neighbours is doubted (altitude ' + res.parts[i].alt.toFixed(1) + ')'); }
{ // signal: a cell-tower fix vs GPS fixes
  const { F } = cityWalk(22, { jumpRate: 0, clusters: 0 }); F.forEach((f) => (f.src = 'gps')); F[30].src = 'cell';
  const res = C.clean(F); ok(res.c[30] < res.c[29], 'a cell-tower position gets less confidence than GPS around it'); }
{ // usual routes: the same walk on other days raises confidence a little
  const a = cityWalk(31, { jumpRate: 0, clusters: 0 }).F, b = cityWalk(31, { jumpRate: 0, clusters: 0 }).F.map((f) => ({ ...f, t: f.t + 86400000 })), cc = cityWalk(31, { jumpRate: 0, clusters: 0 }).F.map((f) => ({ ...f, t: f.t + 2 * 86400000 }));
  const all = a.concat(b, cc), first = C.clean(all), fam = C.familiarity(all, first), res = C.clean(all, { familiar: fam });
  const inc = res.parts.filter((p) => p && p.fam > 0).length; ok(inc > all.length * 0.5, 'a route walked on other days gets the "usual route" bonus (' + inc + ' fixes)'); }
{ // a day at work: drive north, 8 hours there, drive back south the same way. The U-turn is excused by the stay;
  // the same U-turn without a stay (a quick out-and-back) is not.
  const day = [], t0w = Date.UTC(2026, 10, 25, 6), step = 15 * 25;   // 25 m/s, a fix every 15 s
  const at2 = (y, t) => { const [lat, lng] = [32.0853 + y / 110540, 34.7818]; return { t, lat, lng, acc: 6 }; };
  let t = t0w; for (let y = 0; y <= 6000; y += step) { day.push(at2(y, t)); t += 15000; }
  for (let k = 0; k < 96; k++) { day.push(at2(6000 + (Math.random() - 0.5) * 20, t)); t += 300000; }
  for (let y = 6000 - step; y >= 0; y -= step) { day.push(at2(y, t)); t += 15000; }
  const r = C.clean(day), arriveI = Math.round(6000 / step), leaveI = arriveI + 96;
  const worst = Math.min(...[arriveI, arriveI + 1, leaveI, leaveI + 1].map((i) => r.parts[i].turn));
  ok(worst > -0.3 && [arriveI, leaveI + 1].every((i) => r.c[i] > 0.7), 'going back the way you came after 8 hours at work is not a suspicious turn (worst turn ' + worst.toFixed(2) + ')');
  const quick = []; t = t0w; for (let y = 0; y <= 3000; y += step) { quick.push(at2(y, t)); t += 15000; }
  quick.push(at2(3000 + step, t)); t += 15000;
  for (let y = 3000; y >= 0; y -= step) { quick.push(at2(y, t)); t += 15000; }
  const rq = C.clean(quick), qi = Math.round(3000 / step) + 1;
  ok(rq.parts[qi].turn < -1, 'the same U-turn without a stop still counts against the fix (' + rq.parts[qi].turn.toFixed(2) + ')'); }
{ // speed: 1000 fixes, timing
  const big = []; for (let s = 40; s < 60; s++) big.push(...cityWalk(s).F.map((f) => ({ ...f, t: f.t + (s - 40) * 86400000 })));
  const t = Date.now(); C.clean(big); const ms = Date.now() - t;
  ok(ms < 2000, 'fast enough: ' + big.length + ' fixes in ' + ms + ' ms'); }
process.exit(fails ? 1 : 0);
