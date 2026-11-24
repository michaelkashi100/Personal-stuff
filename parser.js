// Normalises Google Timeline exports into { visits, trips, points, hints }.
//   visits : { start, end, lat, lng, type, name }
//   trips  : { start, end, type, dist, path:[[lat,lng]..] }   (Google's own activity segments / GPS paths)
//   points : { t, lat, lng, acc?, v?, alt?, vacc?, src?, sat?, cn0?, wifiN?, wifiH? }   (timed fixes; extras when present:
//            altitude, its accuracy, source GPS/WIFI/CELL, satellites used, signal strength, Wi-Fi networks seen, hashed connected Wi-Fi)
//   hints  : { t, type, conf }                                 (Google's on-device activity guesses, conf 0..1)
// Supported: on-device Timeline.json (semanticSegments + rawSignals, or the iOS array),
// Takeout Semantic Location History (timelineObjects), and Records.json (locations).
(function (root) {
  function parseLatLng(s) {
    // "48.1234°, 11.5678°"
    if (typeof s !== 'string') return null;
    const m = s.match(/(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)/);
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
  }
  const e7 = (a, b) => (a == null || b == null ? null : [a / 1e7, b / 1e7]);
  const ms = (t) => (t ? Date.parse(t) : NaN);
  const num = (x) => (x == null || x === '' || isNaN(+x) ? undefined : +x);
  const conf01 = (c) => { c = +c; return !(c >= 0) ? 0.5 : c > 1 ? Math.min(1, c / 100) : c; };

  const SRC = { GPS: 'gps', WIFI: 'wifi', CELL: 'cell', FUSED: 'fused', UNKNOWN: 'unknown' };
  function extras(p, o, altKey) {                             // optional signal details a fix may carry
    const alt = num(o[altKey]), vacc = num(o.verticalAccuracyMeters ?? o.verticalAccuracy), src = o.source ? SRC[String(o.source).toUpperCase()] || 'unknown' : undefined;
    if (alt !== undefined) p.alt = alt;
    if (vacc !== undefined) p.vacc = vacc;
    if (src) p.src = src;
    for (const k of ['sat', 'cn0', 'wifiN']) { const v = num(o[k]); if (v !== undefined) p[k] = v; }
    if (typeof o.wifiH === 'string' && o.wifiH) p.wifiH = o.wifiH;
    return p;
  }

  function fromSegments(segs, out) {
    for (const s of segs) {
      const start = ms(s.startTime), end = ms(s.endTime);
      if (s.visit) {
        const c = s.visit.topCandidate || {};
        const ll = parseLatLng(c.placeLocation && c.placeLocation.latLng);
        if (ll) out.visits.push({ start, end, lat: ll[0], lng: ll[1], type: c.semanticType || 'Place', name: c.placeId || '' });
      } else if (s.activity) {
        const a = s.activity, c = a.topCandidate || {};
        const p0 = parseLatLng(a.start && a.start.latLng), p1 = parseLatLng(a.end && a.end.latLng);
        out.trips.push({ start, end, type: (c.type || 'unknown').toLowerCase().replace(/_/g, ' '), dist: +a.distanceMeters || 0, path: [p0, p1].filter(Boolean) });
      } else if (s.timelinePath) {
        const path = [];
        for (const p of s.timelinePath) {
          const ll = parseLatLng(p.point);
          // Android gives an absolute time per point; the iOS export gives minutes since the segment start.
          const t = p.time ? ms(p.time) : start + (+p.durationMinutesOffsetFromStartTime || 0) * 60000;
          if (ll) { path.push(ll); if (t === t) out.points.push({ t, lat: ll[0], lng: ll[1] }); }
        }
        out.trips.push({ start, end, type: 'path', dist: 0, path });
      }
    }
  }

  // Android on-device export: raw position fixes (with accuracy and speed) and Google's activity guesses.
  function fromRawSignals(arr, out) {
    for (const r of arr) {
      if (!r) continue;
      const pos = r.position;
      if (pos) {
        const ll = parseLatLng(pos.LatLng || pos.latLng), t = ms(pos.timestamp);
        if (ll && t === t) out.points.push(extras({ t, lat: ll[0], lng: ll[1], acc: num(pos.accuracyMeters), v: num(pos.speedMetersPerSecond) }, pos, 'altitudeMeters'));
        continue;
      }
      const ws = r.wifiScan;                                   // how many Wi-Fi networks were around (urban / indoor context)
      if (ws && Array.isArray(ws.devicesRecords)) { const t = ms(ws.deliveryTime || ws.timestamp); if (t === t) out.wifi.push({ t, n: ws.devicesRecords.length }); continue; }
      const ar = r.activityRecord, pa = ar && ar.probableActivities;
      if (pa && pa.length) {
        const top = pa.reduce((a, b) => (conf01(b.confidence) > conf01(a.confidence) ? b : a));
        const t = ms(ar.timestamp);
        if (t === t) out.hints.push({ t, type: String(top.type || ''), conf: conf01(top.confidence) });
      }
    }
  }

  function fromTakeout(objs, out) {
    for (const o of objs) {
      if (o.placeVisit) {
        const v = o.placeVisit, l = v.location || {}, ll = e7(l.latitudeE7, l.longitudeE7);
        if (ll) out.visits.push({ start: ms(v.duration.startTimestamp), end: ms(v.duration.endTimestamp), lat: ll[0], lng: ll[1], type: 'Place', name: l.name || l.address || '' });
      } else if (o.activitySegment) {
        const a = o.activitySegment, path = [];
        const s = e7(a.startLocation && a.startLocation.latitudeE7, a.startLocation && a.startLocation.longitudeE7);
        const e = e7(a.endLocation && a.endLocation.latitudeE7, a.endLocation && a.endLocation.longitudeE7);
        if (s) path.push(s);
        for (const w of (a.waypointPath && a.waypointPath.waypoints) || []) { const p = e7(w.latE7, w.lngE7); if (p) path.push(p); }
        if (e) path.push(e);
        out.trips.push({ start: ms(a.duration.startTimestamp), end: ms(a.duration.endTimestamp), type: (a.activityType || 'unknown').toLowerCase(), dist: +a.distance || 0, path });
      }
    }
  }

  function fromRecords(locs, out) {
    for (const l of locs) {
      const ll = e7(l.latitudeE7, l.longitudeE7), t = ms(l.timestamp);
      if (!ll || t !== t) continue;
      out.points.push(extras({ t, lat: ll[0], lng: ll[1], acc: num(l.accuracy), v: num(l.velocity) }, l, 'altitude'));
      for (const a of l.activity || []) {                     // Google's per-fix activity guesses
        const list = a.activity || [];
        if (!list.length) continue;
        const top = list.reduce((x, y) => (conf01(y.confidence) > conf01(x.confidence) ? y : x));
        const at = ms(a.timestamp) || t;
        out.hints.push({ t: at, type: String(top.type || ''), conf: conf01(top.confidence) });
      }
    }
  }

  function parseTimeline(json) {
    const out = { visits: [], trips: [], points: [], hints: [], wifi: [] };
    if (Array.isArray(json)) fromSegments(json, out);                       // iOS export
    else if (json.semanticSegments) {                                       // Android export
      fromSegments(json.semanticSegments, out);
      if (json.rawSignals) fromRawSignals(json.rawSignals, out);
    } else if (json.timelineObjects) fromTakeout(json.timelineObjects, out); // Takeout Semantic Location History
    else if (json.locations) fromRecords(json.locations, out);               // Records.json
    else if (json.rawSignals) fromRawSignals(json.rawSignals, out);
    else throw new Error('Unrecognised Timeline format');
    out.visits = out.visits.filter((v) => !isNaN(v.start));
    out.trips = out.trips.filter((t) => !isNaN(t.start));
    out.visits.sort((a, b) => a.start - b.start);
    out.trips.sort((a, b) => a.start - b.start);
    if (out.wifi.length) {                                     // attach Wi-Fi counts to the nearest fix (within a minute)
      out.wifi.sort((a, b) => a.t - b.t);
      const pts = out.points.slice().sort((a, b) => a.t - b.t);
      let j = 0;
      for (const p of pts) {
        while (j + 1 < out.wifi.length && Math.abs(out.wifi[j + 1].t - p.t) <= Math.abs(out.wifi[j].t - p.t)) j++;
        if (p.wifiN === undefined && Math.abs(out.wifi[j].t - p.t) <= 60000) p.wifiN = out.wifi[j].n;
      }
    }
    delete out.wifi;
    return out;
  }

  function haversine(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  const api = { parseTimeline, haversine, parseLatLng };
  if (typeof module !== 'undefined') module.exports = api; else root.TL = api;
})(typeof self !== 'undefined' ? self : this);
