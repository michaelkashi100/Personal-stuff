// Generates a small synthetic Android-style Timeline.json (no real data).
const fs = require('fs');
const H = [48.137, 11.575], W = [48.15, 11.6], G = [48.12, 11.55];
const ll = (p) => `${p[0].toFixed(5)}°, ${p[1].toFixed(5)}°`;
const segs = [];
for (let d = 0; d < 10; d++) {
  const base = Date.UTC(2026, 5, 1 + d);
  const t = (h) => new Date(base + h * 3.6e6).toISOString();
  segs.push({ startTime: t(0), endTime: t(8), visit: { topCandidate: { placeId: 'Home', semanticType: 'HOME', placeLocation: { latLng: ll(H) } } } });
  const path = [0, .25, .5, .75, 1].map((k) => ({ point: ll([H[0] + (W[0] - H[0]) * k, H[1] + (W[1] - H[1]) * k]), time: t(8 + k * .5) }));
  segs.push({ startTime: t(8), endTime: t(8.5), activity: { start: { latLng: ll(H) }, end: { latLng: ll(W) }, distanceMeters: 3400, topCandidate: { type: 'IN_PASSENGER_VEHICLE' } } });
  segs.push({ startTime: t(8), endTime: t(8.5), timelinePath: path });
  segs.push({ startTime: t(8.5), endTime: t(17), visit: { topCandidate: { placeId: 'Work', semanticType: 'WORK', placeLocation: { latLng: ll(W) } } } });
  if (d % 2) {
    segs.push({ startTime: t(18), endTime: t(19), activity: { start: { latLng: ll(W) }, end: { latLng: ll(G) }, distanceMeters: 5200, topCandidate: { type: 'WALKING' } } });
    segs.push({ startTime: t(19), endTime: t(20.5), visit: { topCandidate: { placeId: 'Gym', semanticType: 'GYM', placeLocation: { latLng: ll(G) } } } });
  }
}
fs.writeFileSync(process.argv[2], JSON.stringify({ semanticSegments: segs }));
