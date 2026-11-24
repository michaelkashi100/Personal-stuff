// osm.js geometry: inside / depth / density / nearest outside spot / streets, and path refinement. usage: node test/osm-unit.js
const O = require('../osm.js');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sq = (lat, lng, h) => { const r = []; for (const [a, b] of [[-h, -h], [-h, h], [h, h], [h, -h], [-h, -h]]) r.push(Math.round((lat + a) * 1e5), Math.round((lng + b) * 1e5)); return r; };
const B = sq(32.08, 34.78, 0.0002);                              // a ~44 x 38 m building
const street = []; for (const lng of [34.775, 34.785]) street.push(Math.round(32.0805 * 1e5), Math.round(lng * 1e5));   // an east-west street ~55 m north of its centre
const idx = O.buildIndex([{ b: [B], r: [street] }]);
ok(idx.buildings === 1 && idx.streets === 1, 'the index holds one building and one street');
ok(idx.depth(32.08, 34.78) > 15 && idx.depth(32.08, 34.78) < 25, 'the middle of the building is ~19-22 m from its walls (' + idx.depth(32.08, 34.78).toFixed(1) + ' m)');
ok(idx.depth(32.081, 34.78) === 0, 'a point outside has depth 0');
const o = idx.outside(32.08, 34.7801);
ok(o && idx.depth(o[0], o[1]) === 0, 'the nearest outside spot is outside');
ok(idx.density(32.08, 34.78) > 0.5 && idx.density(32.09, 34.78) === 0, 'density is high on the building and 0 far away');
const s = idx.street(32.0803, 34.78, 30);
ok(s && Math.abs(s.lat - 32.0805) < 1e-6, 'the nearest street point is on the street');
ok(!idx.street(32.0803, 34.78, 10), 'no street within 10 m there');
const pts = [[32.08, 34.7799], [32.0804, 34.78], [32.0812, 34.78]];
O.refinePath(pts, idx, null, { wRoad: 0.5 });
ok(idx.depth(pts[0][0], pts[0][1]) === 0, 'a path point inside the building is moved outside');
ok(Math.abs(pts[1][0] - 32.08045) < 2e-5, 'a point 11 m from a street is pulled halfway toward it');
ok(pts[2][0] === 32.0812, 'a point far from streets is left alone');
const [x, y] = O.tileOf(32.08, 34.78), bx = O.tileBox(x, y);
ok(bx.s <= 32.08 && bx.n >= 32.08 && bx.w <= 34.78 && bx.e >= 34.78 && (bx.e - bx.w) * 111320 * Math.cos(32.08 * Math.PI / 180) < 700, 'map squares are ~600 m and contain their point');
const c = O.compact({ elements: [{ type: 'way', tags: { building: 'yes' }, geometry: [{ lat: 1, lon: 2 }, { lat: 1, lon: 3 }, { lat: 2, lon: 3 }, { lat: 1, lon: 2 }] }, { type: 'way', tags: { highway: 'footway' }, geometry: [{ lat: 1, lon: 2 }, { lat: 1, lon: 3 }] }, { type: 'way', tags: { name: 'x' }, geometry: [{ lat: 1, lon: 2 }, { lat: 1, lon: 3 }] }] });
ok(c.b.length === 1 && c.r.length === 1 && c.b[0][0] === 100000, 'downloads are stored compactly (buildings + streets only)');
// the cleaning uses the index: a fix inside a building while walking is doubted
const C = require('../clean.js'), F = [];
for (let k = 0; k < 40; k++) F.push({ t: 1e12 + k * 4000, lat: 32.0812 - k * 0.00005 * 0 + 0, lng: 34.7760 + k * 0.00006, acc: 6 });
F[20] = { ...F[20], lat: 32.08, lng: 34.78 };                      // put one fix in the building (also off the line)
const r1 = C.clean(F), r2 = C.clean(F, { buildings: idx });
ok(r2.parts[20].build < 0 && r2.c[20] <= r1.c[20], 'with buildings, a fix inside one while walking gets less confidence (' + r1.c[20].toFixed(2) + ' -> ' + r2.c[20].toFixed(2) + ')');
process.exit(fails ? 1 : 0);
