// Android on-device style export built from a simulated day: dense rawSignals (positions + activity records + bulky
// wifi scans) plus Google's own semanticSegments (named visits, labelled activities). usage: node make-android.js out.json
const fs = require('fs'); const { simulate, COMMUTE } = require('./sim.js');
const { json, gt } = simulate(7, COMMUTE, { velocity: true }), L = json.locations, ll = (a, b) => `${(a / 1e7).toFixed(6)}°, ${(b / 1e7).toFixed(6)}°`;
const raw = [], segs = [], ts = (t) => new Date(t).toISOString().replace('Z', '+00:00');
const mean = (t0, t1) => { const f = L.filter((l) => Date.parse(l.timestamp) >= t0 && Date.parse(l.timestamp) <= t1); return [f.reduce((a, l) => a + l.latitudeE7, 0) / f.length, f.reduce((a, l) => a + l.longitudeE7, 0) / f.length]; };
for (const l of L) { raw.push({ position: { LatLng: ll(l.latitudeE7, l.longitudeE7), accuracyMeters: l.accuracy, speedMetersPerSecond: l.velocity, source: 'GPS', timestamp: l.timestamp } }); if (Math.random() < 0.02) raw.push({ wifiScan: { deliveryTime: l.timestamp, devicesRecords: [{ mac: 1, rawRssi: -60 }] } }); }
const act = { walk: 'ON_FOOT', drive: 'IN_VEHICLE', bike: 'ON_BICYCLE' }, lab = { walk: 'WALKING', drive: 'IN_PASSENGER_VEHICLE', bike: 'UNKNOWN_ACTIVITY_TYPE' };
let stayNo = 0; const types = ['HOME', 'WORK', 'UNKNOWN', 'WORK', 'GYM', 'HOME'];
for (const g of gt) {
  if (g.kind === 'stay') { const c = mean(g.t0, g.t1); segs.push({ startTime: ts(g.t0), endTime: ts(g.t1), visit: { hierarchyLevel: 0, probability: 0.9, topCandidate: { placeId: 'ChIJ' + 'z'.repeat(20) + stayNo, semanticType: types[stayNo++] || 'UNKNOWN', probability: 0.9, placeLocation: { latLng: ll(c[0], c[1]) } } } }); }
  else {
    const a = mean(g.t0, g.t0 + 20000), b = mean(g.t1 - 20000, g.t1);
    segs.push({ startTime: ts(g.t0), endTime: ts(g.t1), activity: { start: { latLng: ll(a[0], a[1]) }, end: { latLng: ll(b[0], b[1]) }, distanceMeters: 1000, topCandidate: { type: lab[g.mode], probability: 0.8 } } });
    for (let t = g.t0; t < g.t1; t += 120000) raw.push({ activityRecord: { probableActivities: [{ type: act[g.mode], confidence: 0.8 }], timestamp: ts(t) } });
  }
}
fs.writeFileSync(process.argv[2], JSON.stringify({ semanticSegments: segs, rawSignals: raw, userLocationProfile: {} }));
