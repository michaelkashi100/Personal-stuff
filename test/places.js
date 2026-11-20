// Place grouping and home / work guesses. usage: node places.js
const TL = require('../parser.js'); require('../analyze.js');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const H = 3600000, base = Date.UTC(2026, 5, 1), at = (d, h) => base + d * 24 * H + h * H;   // tests run in UTC
const stay = (t0, t1, lat, lng, extra = {}) => ({ kind: 'stay', t0, t1, lat, lng, name: 'Stopped', ...extra });
const home = [32.0853, 34.7818], work = [32.1093, 34.8555], gym = [32.0668, 34.7647], cafe = [32.08, 34.78];
const tl = [];
for (let d = 0; d < 7; d++) {                      // home nights, work days (weekdays and weekend alike), gym most evenings, a cafe once
  tl.push(stay(at(d, 0), at(d, 7.5), home[0] + (d % 2) * 0.0003, home[1], { type: 'HOME' }));
  tl.push(stay(at(d, 9), at(d, 17), work[0], work[1] + (d % 3) * 0.0002));
  if (d % 2 === 0) tl.push(stay(at(d, 18), at(d, 19.5), gym[0], gym[1], { realName: 'City Gym' }));
  tl.push(stay(at(d, 20), at(d, 24), home[0], home[1]));
}
tl.push(stay(at(3, 12), at(3, 12.2), cafe[0], cafe[1]));
tl.sort((a, b) => a.t0 - b.t0);
const places = TL.clusterPlaces(tl);
const by = (lat, lng) => places.find((p) => Math.abs(p.lat - lat) < 0.002 && Math.abs(p.lng - lng) < 0.002);
ok(places.length === 4, 'stays within 150 m are one place (4 places from ' + tl.length + ' stays)');
ok(by(...home).visits === 14 && by(...home).guess === 'home', 'the place where the nights are spent is guessed to be home (' + by(...home).visits + ' visits)');
ok(by(...work).guess === 'work', 'the place that fills the days is guessed to be work');
ok(!by(...gym).guess && by(...gym).googleName === 'City Gym', 'a gym is not guessed as home or work, and keeps the name Google gave it');
ok(by(...cafe).guess === null && by(...cafe).visits === 1, 'a place visited once is not guessed');
ok(places[0].hours >= places[1].hours && places[1].hours >= places[2].hours, 'places are sorted by time spent');
ok(tl.every((s) => s.place), 'every stay points at its place');
ok(by(...home).googleType === 'HOME', 'Google\'s place type is kept');
