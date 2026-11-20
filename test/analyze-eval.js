// Ground-truth evaluation of analyze.js. usage: node analyze-eval.js [-v]
const TL = require('../parser.js'); require('../analyze.js');
const { simulate, evaluate, COMMUTE } = require('./sim.js');
const verbose = process.argv.includes('-v');
let fail = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail = 1; };
function run(name, plan, o, seeds, min) {
  const agg = { stayTime: 0, modeTime: 0, stayRecall: 0, falseStays: 0, conf: {} }; let n = 0;
  for (const seed of seeds) {
    const { json, gt } = simulate(seed, plan, o), t0 = Date.now();
    const tl = TL.analyze(TL.parseTimeline(json)), e = evaluate(tl, gt);
    agg.stayTime += e.stayTime; agg.modeTime += e.modeTime; agg.stayRecall += e.stayRecall; agg.falseStays += e.falseStays; n++;
    for (const k in e.conf) agg.conf[k] = (agg.conf[k] || 0) + e.conf[k];
    if (verbose && seed === seeds[0]) console.log('   ', tl.map((s) => (s.kind === 'stay' ? `S${Math.round((s.t1 - s.t0) / 60000)}m` : `${s.mode}${(s.dist / 1000).toFixed(1)}km@${Math.round(s.med * 3.6)}`)).join(' '), `(${Date.now() - t0} ms)`);
  }
  const r = { stayTime: agg.stayTime / n, modeTime: agg.modeTime / n, stayRecall: agg.stayRecall / n, falseStays: agg.falseStays };
  console.log(`   ${name}: still-time ${(r.stayTime * 100).toFixed(1)}%  mode-time ${(r.modeTime * 100).toFixed(1)}%  stays found ${(r.stayRecall * 100).toFixed(0)}%  false stays ${r.falseStays}`, verbose ? JSON.stringify(agg.conf) : '');
  ok(r.stayTime >= min.stayTime && r.modeTime >= min.modeTime && r.stayRecall >= min.stayRecall && r.falseStays <= min.falseStays, name);
}
const seeds = [1, 2, 3, 4, 5, 6];
run('commute day, GPS every ~5 s', COMMUTE, {}, seeds, { stayTime: 0.97, modeTime: 0.9, stayRecall: 1, falseStays: 0 });
run('commute day, with device speed', COMMUTE, { velocity: true }, seeds, { stayTime: 0.97, modeTime: 0.93, stayRecall: 1, falseStays: 0 });
run('commute day, sparse (1 fix/min)', COMMUTE, { sparse: 60, dtStill: 120 }, seeds, { stayTime: 0.95, modeTime: 0.75, stayRecall: 0.9, falseStays: 1 });
run('24 h stationary, noisy indoor GPS', [{ stay: 1440 }], {}, seeds, { stayTime: 0.99, modeTime: 1, stayRecall: 1, falseStays: 0 });
run('stationary + long drive + stationary', [{ stay: 300 }, { move: 'drive', m: 40000 }, { stay: 300 }], {}, seeds, { stayTime: 0.97, modeTime: 0.95, stayRecall: 1, falseStays: 0 });
run('bike ride', [{ stay: 60 }, { move: 'bike', m: 9000 }, { stay: 60 }], {}, seeds, { stayTime: 0.97, modeTime: 0.9, stayRecall: 1, falseStays: 0 });
run('walk then drive then walk', [{ stay: 60 }, { move: 'walk', m: 700 }, { move: 'drive', m: 9000 }, { move: 'walk', m: 400 }, { stay: 60 }], {}, seeds, { stayTime: 0.97, modeTime: 0.88, stayRecall: 1, falseStays: 0 });
run('run (10.8 km/h)', [{ stay: 60 }, { move: 'run', m: 5000 }, { stay: 60 }], {}, seeds, { stayTime: 0.97, modeTime: 0.85, stayRecall: 1, falseStays: 0 });
run('train, with Google activity hints', [{ stay: 60 }, { move: 'train', m: 60000, hint: 'IN_RAIL_VEHICLE' }, { stay: 60 }], {}, seeds, { stayTime: 0.97, modeTime: 0.9, stayRecall: 1, falseStays: 0 });
run('1.6x indoor GPS noise (drift to 72 m)', COMMUTE.map((s) => (s.stay ? { ...s, noise: 1.6 } : s)), {}, seeds, { stayTime: 0.96, modeTime: 0.9, stayRecall: 1, falseStays: 0 });
run('stay where the fix flips between two spots 140 m apart', [{ stay: 240, alt: 70 }, { move: 'walk', m: 900 }, { stay: 120 }], {}, seeds, { stayTime: 0.96, modeTime: 0.9, stayRecall: 1, falseStays: 0 });
run('walk around the block (returns to start)', [{ stay: 60 }, { move: 'walk', m: 1800, loop: true }, { stay: 60 }], {}, seeds, { stayTime: 0.95, modeTime: 0.85, stayRecall: 1, falseStays: 1 });
{
  // a 7-minute full stop in the middle of a drive (traffic jam) must not become an "arrival"
  let stays = 0;
  for (const seed of seeds) { const { json } = simulate(seed, [{ stay: 60 }, { move: 'drive', m: 12000 }, { stay: 7, indoor: false }, { move: 'drive', m: 12000 }, { stay: 60 }], {}); stays += TL.analyze(TL.parseTimeline(json)).filter((s) => s.kind === 'stay').length; }
  ok(stays === 2 * seeds.length, 'traffic jam: 7 min full stop mid-drive is not a stay (' + stays + ' stays over ' + seeds.length + ' runs)');
}
{
  // phone off for 5 h, then somewhere 30 km away: a visible, honest "no data" leg, not a confident walk
  const { json } = simulate(3, [{ stay: 120 }, { gap: 300, teleport: 30000 }, { stay: 120 }], {});
  const tl = TL.analyze(TL.parseTimeline(json)), mv = tl.filter((s) => s.kind === 'move');
  ok(mv.length === 1 && mv[0].mode === 'other', 'data gap with a jump: one low-confidence leg (' + mv.map((m) => m.mode).join(',') + ')');
}
process.exit(fail);
