// Android-style export where consecutive visits have NO activity segment between them, plus a stationary last day.
const fs = require('fs');
const P = [[32.0853, 34.7818], [32.1093, 34.8555], [32.0668, 34.7647]], ll = (p) => `${p[0].toFixed(5)}°, ${p[1].toFixed(5)}°`;
const segs = [], pid = (i) => 'ChIJ' + 'x'.repeat(20) + i;
const iso = (d, h) => new Date(Date.UTC(2026, 10, d) + h * 3.6e6).toISOString().replace('Z', '+00:00');
for (let d = 10; d <= 12; d++) [[0, 8, 0], [9, 14, 1], [15, 23, 2]].forEach(([a, b, k]) => segs.push({ startTime: iso(d, a), endTime: iso(d, b), visit: { hierarchyLevel: 0, probability: 0.9, topCandidate: { placeId: pid(k), semanticType: ['HOME', 'WORK', 'UNKNOWN'][k], probability: 0.9, placeLocation: { latLng: ll(P[k]) } } } }));
segs.push({ startTime: iso(13, 0), endTime: iso(13, 10), visit: { topCandidate: { placeId: pid(0), semanticType: 'HOME', placeLocation: { latLng: ll(P[0]) } } } });
fs.writeFileSync(process.argv[2], JSON.stringify({ semanticSegments: segs, rawSignals: [], userLocationProfile: {} }));
