// Normalises Google Timeline exports into { visits, trips, points }.
// Supported: on-device Timeline.json (semanticSegments / iOS array),
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
          if (ll) { path.push(ll); out.points.push({ t: ms(p.time), lat: ll[0], lng: ll[1] }); }
        }
        out.trips.push({ start, end, type: 'path', dist: 0, path });
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

  function parseTimeline(json) {
    const out = { visits: [], trips: [], points: [] };
    if (Array.isArray(json)) fromSegments(json, out);                       // iOS export
    else if (json.semanticSegments) fromSegments(json.semanticSegments, out); // Android export
    else if (json.timelineObjects) fromTakeout(json.timelineObjects, out);   // Takeout SLH
    else if (json.locations) {                                               // Records.json
      for (const l of json.locations) {
        const ll = e7(l.latitudeE7, l.longitudeE7);
        if (ll) out.points.push({ t: ms(l.timestamp), lat: ll[0], lng: ll[1] });
      }
    } else throw new Error('Unrecognised Timeline format');
    out.visits = out.visits.filter((v) => !isNaN(v.start));
    out.trips = out.trips.filter((t) => !isNaN(t.start));
    out.visits.sort((a, b) => a.start - b.start);
    out.trips.sort((a, b) => a.start - b.start);
    return out;
  }

  function haversine(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function tripDistance(t) {
    if (t.dist) return t.dist;
    let d = 0;
    for (let i = 1; i < t.path.length; i++) d += haversine(t.path[i - 1], t.path[i]);
    return d;
  }

  // Stats for a year (or all years when year == null).
  function computeStats(data, year) {
    const inYear = (t) => year == null || new Date(t).getFullYear() === year;
    const visits = data.visits.filter((v) => inYear(v.start));
    const trips = data.trips.filter((t) => inYear(t.start));
    let totalDist = 0;
    const byType = {};
    // GPS 'path' segments overlap activity segments; only count them when nothing else exists.
    const hasActivities = trips.some((t) => t.type !== 'path');
    for (const t of trips) {
      if (hasActivities && t.type === 'path') continue;
      const d = tripDistance(t);
      totalDist += d;
      byType[t.type] = (byType[t.type] || 0) + d;
    }
    // Most-visited places, clustered on a ~100 m grid.
    const places = {};
    for (const v of visits) {
      const k = v.lat.toFixed(3) + ',' + v.lng.toFixed(3);
      const p = (places[k] = places[k] || { lat: v.lat, lng: v.lng, name: v.name, type: v.type, visits: 0, hours: 0 });
      p.visits++;
      p.hours += Math.max(0, (v.end - v.start) / 3.6e6);
      if (v.name && !p.name) p.name = v.name;
    }
    const topPlaces = Object.values(places).sort((a, b) => b.hours - a.hours).slice(0, 5);
    const days = new Set(trips.map((t) => new Date(t.start).toDateString()).concat(visits.map((v) => new Date(v.start).toDateString())));
    let longest = null;
    for (const t of trips) { const d = tripDistance(t); if (!longest || d > longest.dist) longest = { dist: d, type: t.type, start: t.start }; }
    return { totalKm: totalDist / 1000, byTypeKm: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v / 1000])), visitCount: visits.length, uniquePlaces: Object.keys(places).length, topPlaces, activeDays: days.size, longest };
  }

  const api = { parseTimeline, computeStats, haversine, tripDistance, parseLatLng };
  if (typeof module !== 'undefined') module.exports = api; else root.TL = api;
})(typeof self !== 'undefined' ? self : this);
