// Cross-check: the file the Kotlin recorder exports must be understood by the web app's own parser and analyser.
// usage: node android/verify-export.js path/to/export-sample.json
const fs = require('fs'); const TL = require('../parser.js'); require('../analyze.js');
const json = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const d = TL.parseTimeline(json);
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
ok(d.points.length === 200, 'all 200 fixes parsed (' + d.points.length + ')');
ok(d.points.every((p) => p.acc > 0 && p.v >= 0 && Math.abs(p.lat - 32.09) < 0.1), 'accuracy, speed and coordinates survive the round trip');
ok(d.points.every((p) => p.alt >= 30 && p.alt <= 32 && p.src === 'gps' && p.sat === 9 && p.cn0 === 34 && p.wifiN === 12), 'altitude, source, satellites, signal strength and Wi-Fi count survive the round trip');
ok(d.points.filter((p) => p.wifiH === 'ab12cd34ef56ab78').length === 10, 'the scrambled Wi-Fi code survives the round trip');
ok(d.hints.length >= 15 && d.hints.every((h) => h.type === 'IN_VEHICLE'), 'activity records arrive as hints (' + d.hints.length + ')');
const tl = TL.analyze(d), moves = tl.filter((s) => s.kind === 'move');
ok(moves.length >= 1 && moves[0].mode === 'drive', 'a 29 km/h stretch with IN_VEHICLE hints is analysed as driving (' + moves.map((m) => m.mode).join(',') + ')');
