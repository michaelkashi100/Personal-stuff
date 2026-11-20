// Synthetic large files (no real data) to test performance: Records.json style with N points.
const fs = require('fs'); const n = +process.argv[3];
const locs = []; let lat = 480000000, lng = 115000000;
for (let i = 0; i < n; i++) { lat += Math.round((Math.random() - .5) * 4000); lng += Math.round((Math.random() - .5) * 4000); locs.push({ latitudeE7: lat, longitudeE7: lng, timestamp: new Date(Date.UTC(2024, 0, 1) + i * 60000).toISOString() }); }
fs.writeFileSync(process.argv[2], JSON.stringify({ locations: locs }));
