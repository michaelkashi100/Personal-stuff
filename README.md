# Personal-stuff
Not related to work

## My Timeline app
Static, offline-capable web app for exploring a Google Timeline export. Open `index.html` (or host the folder, e.g. GitHub Pages), pick your `Timeline.json` / `Records.json` / Semantic Location History file. Parsing happens in the browser; nothing is uploaded.

- `parser.js` – normalises the Google formats, computes stats
- `app.js` / `index.html` – map replay + year-in-review
- `test/make-sample.js` – generates a synthetic sample; `test/e2e.js` – Playwright check

The chosen file is kept as a private copy in the browser's IndexedDB on the device (never uploaded), so the app opens straight into it on later visits. Use *Stats → Change file* / *Forget my data* to replace or remove it.

The replay ignores GPS wobble (tiny moves around one spot are merged into the stay) and guesses the travel mode from the activity label and speed; the car icon is shown only while driving.

### How the data is understood
`analyze.js` turns the raw fixes into stays and legs (see the header comment): noise-adaptive stay detection, a Viterbi pass over windowed speed statistics to tell walking, running, cycling, driving, transit and flights apart, and Google's own activity hints as a prior. `test/analyze-eval.js` measures it against simulated days with known ground truth (`node test/analyze-eval.js -v`).

UI: one icon set (inline SVG, `ICON` in `app.js`), design tokens in `index.html`, screen wake lock while the app is open, and a finished day moves on to the next one. `test/ui-behavior.js` covers wake lock, day navigation, auto-advance, speed and the two-step forget.

Place names: stays are grouped into places (`TL.clusterPlaces`, 150 m) and the most visited unnamed places are asked about ("Is this your home?" / "Is this where you work?" from where the nights and days are spent, otherwise "What is this place for you?"). Names are kept only in this browser (`localStorage`, key `tl-places`). `test/places.js` and `test/places-ui.js` cover it.
