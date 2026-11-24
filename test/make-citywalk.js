// A Records.json day: a city walk in Tel Aviv with close-by GPS jumps (single fixes and short visits to a wrong spot),
// an hour "in Beirut" (GPS interference), and stops at both ends. usage: node make-citywalk.js out.json
const fs = require('fs');
function rng(seed) { let s = seed >>> 0 || 1; const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); r.g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); return r; }
const r = rng(7), O = { lat: 32.0853, lng: 34.7818 }, KX = 111320 * Math.cos(O.lat * Math.PI / 180), KY = 110540, locs = [];
let x = 0, y = 0, t = Date.UTC(2026, 10, 23, 7), h = 0;
const push = (px, py, acc, extra = {}) => locs.push({ latitudeE7: Math.round((O.lat + py / KY) * 1e7), longitudeE7: Math.round((O.lng + px / KX) * 1e7), accuracy: Math.round(acc), timestamp: new Date(t).toISOString(), source: 'GPS', altitude: 20 + r.g() * 3, ...extra });
for (let k = 0; k < 40; k++) { push(x + r.g() * 10, y + r.g() * 10, 15, { source: 'WIFI' }); t += 45000; }            // at home
const truthStart = locs.length;
for (let L = 0; L < 16; L++) {
  const len = 80 + r() * 80;
  for (let d = 0; d < len; d += 5.6) {
    x += Math.sin(h) * 5.6; y += Math.cos(h) * 5.6; t += 4000;
    let px = x + r.g() * 4, py = y + r.g() * 4;
    if (r() < 0.07) { const a = r() * 6.28, dd = 30 + r() * 110; px = x + Math.sin(a) * dd; py = y + Math.cos(a) * dd; }
    push(px, py, 5 + r() * 6);
  }
  h += (r() < 0.5 ? 1 : -1) * Math.PI / 2;
}
for (let e = 0; e < 3; e++) { const i0 = truthStart + 20 + Math.floor(r() * 300), a = r() * 6.28, d = 70 + r() * 40; for (let k = i0; k < i0 + 4; k++) { locs[k].latitudeE7 += Math.round(Math.cos(a) * d / KY * 1e7); locs[k].longitudeE7 += Math.round(Math.sin(a) * d / KX * 1e7); } }
for (let k = 0; k < 40; k++) { push(x + r.g() * 8, y + r.g() * 8, 12); t += 45000; }                                     // a café
for (let k = 0; k < 60; k++) { locs.push({ latitudeE7: 338200000 + Math.round(r.g() * 2000), longitudeE7: 354900000 + Math.round(r.g() * 2000), accuracy: 10, timestamp: new Date(t).toISOString(), source: 'GPS' }); t += 60000; }   // "Beirut"
for (let k = 0; k < 40; k++) { push(x + r.g() * 8, y + r.g() * 8, 12); t += 45000; }
fs.writeFileSync(process.argv[2], JSON.stringify({ locations: locs }));
console.log('wrote', locs.length, 'fixes');
