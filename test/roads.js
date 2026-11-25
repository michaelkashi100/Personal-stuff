// Driving: map matching onto roads (osm.js matchDrive). usage: node test/roads.js
const O = require('../osm.js');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
function rng(seed) { let s = seed >>> 0 || 1; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); r.g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); return r; }
const LAT = 32.08, LNG = 34.78, KX = 111320 * Math.cos(LAT * Math.PI / 180), KY = 110540;
const ll = (x, y) => [LAT + y / KY, LNG + x / KX], xy = (p) => [(p[1] - LNG) * KX, (p[0] - LAT) * KY];
const way = (pts) => { const f = []; for (const [x, y] of pts) { const [a, b] = ll(x, y); f.push(Math.round(a * 1e5), Math.round(b * 1e5)); } return f; };
// road A: east along y=0 from x=-200 to 600 (with vertices every 100 m); road B: parallel, 25 m north; road C: north from (500,0)
const A = way([[-200, 0], [-100, 0], [0, 0], [100, 0], [200, 0], [300, 0], [400, 0], [500, 0], [600, 0]]);
const B = way([[-200, 25], [600, 25]]);
const Cw = way([[500, 0], [500, 150], [500, 300], [500, 450]]);
const idx = O.buildRoadIndex([{ w: [A, B, Cw] }]);
ok(idx.roads === 3, 'three roads indexed');
// a drive along A, turning onto C at x=500; GPS noise 8 m and pulled 10 m toward B
const r = rng(4), truth = [], pts = [], times = [];
let t = 0;
for (let x = -150; x <= 500; x += 20) { truth.push([x, 0]); pts.push(ll(x + r.g() * 8, 10 + r.g() * 8)); times.push(t += 2000); }
for (let y = 20; y <= 400; y += 20) { truth.push([500, y]); pts.push(ll(500 + 10 + r.g() * 8, y + r.g() * 8)); times.push(t += 2000); }
pts.push(ll(900, 900)); times.push(t += 2000);                       // a point far from any road
const m = O.matchDrive(pts, times, idx, { snapDrive: 1, snapRadius: 40 });
const onRoad = (p) => { const [x, y] = xy(p); return Math.min(Math.abs(y) + (x < -200 || x > 600 ? 1e9 : 0), Math.abs(x - 500) + (y < 0 || y > 450 ? 1e9 : 0)); };
const onB = m.path.filter((p) => { const [x, y] = xy(p); return Math.abs(y - 25) < 2 && x < 480; }).length;
const inner = m.path.slice(0, -1);
ok(inner.every((p) => onRoad(p) < 1.5), 'every driving position lies on road A or C (worst ' + Math.max(...inner.map(onRoad)).toFixed(2) + ' m off)');
ok(onB === 0, 'the parallel road 25 m away is never used, although the GPS leaned toward it');
ok(m.path.some((p) => { const [x, y] = xy(p); return Math.abs(x - 500) < 1 && Math.abs(y) < 1; }), 'the path goes through the corner instead of cutting it');
const last = m.path[m.path.length - 1];
ok(Math.abs(last[0] - pts[pts.length - 1][0]) < 1e-9, 'a position with no road near it is left alone');
ok(m.times.length === m.path.length && m.times.every((v, i) => !i || v >= m.times[i - 1]), 'times stay in order for the added road points');
const half = O.matchDrive(pts, times, idx, { snapDrive: 0.5, snapRadius: 40 });
const d0 = Math.abs(xy(pts[3])[1]), d5 = Math.abs(xy(half.path[3])[1]);
ok(d5 < d0 && d5 > 0.2, 'a weaker snap moves the path part of the way');
ok(O.matchDrive(pts, times, idx, { snapDrive: 0 }).path.every((p, i) => p === pts[i] || (p[0] === pts[i][0] && p[1] === pts[i][1])), 'snap 0 changes nothing');
process.exit(fails ? 1 : 0);
