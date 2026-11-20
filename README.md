# Personal-stuff
Not related to work

## My Timeline app
Static, offline-capable web app for exploring a Google Timeline export. Open `index.html` (or host the folder, e.g. GitHub Pages), pick your `Timeline.json` / `Records.json` / Semantic Location History file. Parsing happens in the browser; nothing is uploaded.

- `parser.js` – normalises the Google formats, computes stats
- `app.js` / `index.html` – map replay + year-in-review
- `test/make-sample.js` – generates a synthetic sample; `test/e2e.js` – Playwright check
