// Synthetic noisy data (no real data). usage: node make-noisy.js outdir
const fs = require('fs'); const out = process.argv[2];
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const jit = (p, m) => [p[0] + ((rnd() - .5) * 2 * m) / 111320, p[1] + ((rnd() - .5) * 2 * m) / (111320 * Math.cos((p[0] * Math.PI) / 180))];
const mv = (p, mN, mE) => [p[0] + mN / 111320, p[1] + mE / (111320 * Math.cos((p[0] * Math.PI) / 180))];
const ll = (p) => `${p[0].toFixed(6)}°, ${p[1].toFixed(6)}°`, iso = (d, h) => new Date(Date.UTC(2026, 5, d) + h * 3.6e6).toISOString();
const H = [32.0853, 34.7818];
// Android-style export
const segs = [], visit = (d, a, b, p, type = 'UNKNOWN') => segs.push({ startTime: iso(d, a), endTime: iso(d, b), visit: { topCandidate: { placeId: 'ChIJ' + 'q'.repeat(20), semanticType: type, placeLocation: { latLng: ll(jit(p, 40)) } } } });
const act = (d, a, b, p, q, dist, type) => segs.push({ startTime: iso(d, a), endTime: iso(d, b), activity: { start: { latLng: ll(p) }, end: { latLng: ll(q) }, distanceMeters: dist, topCandidate: { type } } });
// Day 1: Home with a fake 55 m "walk" in the middle, a 15 km unlabeled drive, work, a 1 km unlabeled walk, gym
const W = mv(H, 10600, 10600), G = mv(W, 700, 700);
visit(1, 0, 8, H, 'HOME'); act(1, 8, 8.167, H, jit(H, 60), 55, 'WALKING'); visit(1, 8.167, 9, H, 'HOME');
act(1, 9, 9.333, H, W, 15000, 'UNKNOWN_ACTIVITY_TYPE'); visit(1, 9.333, 17, W, 'WORK');
act(1, 17, 17.2, W, G, 1000, 'UNKNOWN_ACTIVITY_TYPE'); visit(1, 17.2, 19, G, 'GYM');
// Day 2: wrong labels: "walking" at 40 km/h for 5 km, "driving" 600 m at 2 km/h
const A = mv(H, 0, 5000), B = mv(A, 600, 0);
visit(2, 0, 8, H, 'HOME'); act(2, 8, 8.125, H, A, 5000, 'WALKING'); visit(2, 8.2, 10, A);
act(2, 10, 10.3, A, B, 600, 'IN_PASSENGER_VEHICLE'); visit(2, 10.3, 11, B);
fs.writeFileSync(out + '/noisy-visits.json', JSON.stringify({ semanticSegments: segs }));
// Records.json: 8 h stationary with +/-40 m noise, 3 spikes 2 km away, 5 junk low-accuracy fixes, then a 20 min 50 km/h trip, then 4 h stationary
const locs = [], push = (t, p, acc = 20) => locs.push({ latitudeE7: Math.round(p[0] * 1e7), longitudeE7: Math.round(p[1] * 1e7), timestamp: new Date(Date.UTC(2026, 5, 3) + t * 60000).toISOString(), accuracy: acc });
for (let t = 0; t < 480; t++) push(t, [100, 200, 300].includes(t) ? mv(H, 2000, 0) : jit(H, 40));
for (let t = 0; t < 5; t++) push(50 + t + 0.5, mv(H, 5000, 0), 800);
const E = mv(H, 11800, 11800);
for (let k = 0; k <= 20; k++) push(480 + k, [H[0] + ((E[0] - H[0]) * k) / 20, H[1] + ((E[1] - H[1]) * k) / 20]);
for (let t = 501; t < 740; t++) push(t, jit(E, 40));
fs.writeFileSync(out + '/noisy-records.json', JSON.stringify({ locations: locs }));
