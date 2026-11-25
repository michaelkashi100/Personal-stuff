// tune.js: learning the phone's noise (E), hold-out self-tuning (A), and agreement with your marks (B). usage: node test/tune.js
const T = require('../tune.js'), C = require('../clean.js');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
function rng(seed) { let s = seed >>> 0 || 1; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); r.g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); return r; }
const KX = 111320 * Math.cos(32.08 * Math.PI / 180), KY = 110540;
// a day: 3 long stays (known wobble 14 m, 6% jumps of ~200 m), connected by noisy walks with close-by jumps
function day(seed) {
  const r = rng(seed), F = [], stays = [], truth = [];
  let t = Date.UTC(2026, 10, 20, 7), x = 0, y = 0;
  for (let s = 0; s < 3; s++) {
    const t0 = t;
    for (let k = 0; k < 60; k++) { const jump = r() < 0.06, a = r() * 6.28, d = 200 * (0.7 + 0.6 * r()); F.push({ t, lat: 32.08 + (y + (jump ? Math.cos(a) * d : r.g() * 14)) / KY, lng: 34.78 + (x + (jump ? Math.sin(a) * d : r.g() * 14)) / KX, acc: 8, alt: 40 + r.g() * 4 }); truth.push([y, x]); t += 60000; }
    stays.push({ t0, t1: t - 60000 });
    const h = r() * 6.28;
    for (let k = 0; k < 120; k++) { x += Math.sin(h) * 5.6; y += Math.cos(h) * 5.6; t += 4000; const jump = r() < 0.08, a = r() * 6.28, d = 30 + r() * 100; F.push({ t, lat: 32.08 + (y + (jump ? Math.cos(a) * d : r.g() * 4)) / KY, lng: 34.78 + (x + (jump ? Math.sin(a) * d : r.g() * 4)) / KX, acc: 7, bad: jump }); truth.push([y, x]); }
  }
  return { F, stays, truth };
}
const { F, stays, truth } = day(5);
// E
const n = T.learnNoise(F, stays);
console.log('   learned:', JSON.stringify(n.learned), 'stats:', JSON.stringify(Object.fromEntries(Object.entries(n.stats).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(1) : v]))));
ok(Math.abs(n.stats.wobble - 14) < 3, 'measures the GPS wobble at stays (~14 m): ' + n.stats.wobble.toFixed(1));
ok(n.stats.jumpPct > 3 && n.stats.jumpPct < 10, 'measures how often it jumps (~6%): ' + n.stats.jumpPct.toFixed(1) + '%');
ok(n.stats.jumpSize > 120 && n.stats.jumpSize < 280, 'measures how far it jumps (~200 m): ' + Math.round(n.stats.jumpSize));
ok(n.learned.altTol >= 5 && n.learned.altTol <= 20, 'learns the altitude tolerance from the altitude spread: ' + n.learned.altTol);
ok(T.learnNoise(F.slice(0, 10), stays) === null, 'too little data: learns nothing');
// A
const good = T.holdout(F, C.DEFAULTS), bad = T.holdout(F, Object.assign({}, C.DEFAULTS, { sigmaMin: 30, wFit: 0, wSpeed: 0, jumpRate: 0.01 }));
console.log('   hold-out error: defaults ' + good.err.toFixed(1) + ' m, poor settings ' + bad.err.toFixed(1) + ' m (' + good.n + ' hidden fixes)');
ok(good.err < bad.err, 'the hold-out score prefers sensible settings');
const t0 = Date.now(), start = { sigmaMin: 25, wFit: 0.3, wSpeed: 0.2, jumpRate: 0.02, lag: 2 };
const out = T.run(F, { stays, start }, () => {});
const secs = (Date.now() - t0) / 1000;
console.log('   tuning: ' + out.before.err.toFixed(1) + ' m -> ' + out.after.err.toFixed(1) + ' m in ' + secs.toFixed(1) + ' s; changed ' + JSON.stringify(out.changed));
ok(out.after.J < out.before.J, 'tuning lowers the hold-out error');
const truthErr = (P) => { const res = C.clean(F, { params: P, noParts: true }); let e = 0, k = 0; for (let i = 0; i < F.length; i++) if (res.route[i] && !F[i].bad) { e += Math.hypot((res.route[i][0] - 32.08) * KY - truth[i][0], (res.route[i][1] - 34.78) * KX - truth[i][1]); k++; } return e / k; };
const eBad = truthErr(Object.assign({}, C.DEFAULTS, start)), eTuned = truthErr(out.params);
console.log('   distance from the true path: start ' + eBad.toFixed(1) + ' m -> tuned ' + eTuned.toFixed(1) + ' m');
ok(eTuned < eBad, 'the tuned settings are closer to the truth (which tuning never saw)');
ok(secs < 60, 'fast enough for a phone (' + secs.toFixed(1) + ' s here for ' + F.length + ' fixes)');
ok(out.report.steps.length > 0 && out.report.noise, 'it reports what it changed and what it measured');
// B
const jumps = F.map((f, i) => i).filter((i) => F[i].bad).slice(0, 10), fine = F.map((f, i) => i).filter((i) => !F[i].bad && i % 50 === 7).slice(0, 10);
const marks = jumps.map((i) => ({ t: F[i].t, ok: false })).concat(fine.map((i) => ({ t: F[i].t, ok: true })));
const m0 = T.holdout(F, Object.assign({}, C.DEFAULTS, { jumpRate: 0.01, wSpeed: 0.2, wFit: 0.3 }), { marks });
const mt = T.run(F, { stays, start: { jumpRate: 0.01, wSpeed: 0.2, wFit: 0.3 }, marks }, () => {});
console.log('   marks agreed: ' + Math.round(100 * m0.agree) + '% -> ' + Math.round(100 * mt.after.agree) + '% (' + m0.nMarks + ' marks)');
ok(mt.after.agree >= m0.agree && mt.after.marks <= m0.marks, 'tuning moves toward your marks');
const forced = C.clean(F, { marks });
ok(jumps.every((i) => forced.c[i] === 0) && fine.every((i) => forced.c[i] >= 0.99), 'your marks always win in the app itself');
process.exit(fails ? 1 : 0);
