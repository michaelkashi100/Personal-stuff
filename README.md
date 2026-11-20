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

## Android app (background recording)
A browser cannot track location in the background, so `android/` holds a small Android app that does, and bundles this same web app (no file picking, works offline).
- **Battery**: nothing runs while you are still. Android's activity recognition (a low-power sensor service) wakes the app when you start walking, cycling or driving; only then does a foreground service use GPS, in batches (`Policy.kt`), and it stops a few minutes after you are still again. Between trips there is one coarse check-in an hour, plus free passive fixes that other apps cause.
- **Privacy**: locations are stored in the app's private SQLite database on the phone. The web page can only reach them through the `TLNative` bridge, and its CSP still blocks all network requests except map tiles. *Save a backup* writes a file to Downloads.
- **Build**: `.github/workflows/android.yml` runs the Kotlin unit tests, checks that the web parser understands the exported file (`android/verify-export.js`), builds `timeline.apk`, and on `main` publishes it at `releases/download/android-latest/timeline.apk`. The signing key (`android/dev.keystore`) is committed on purpose so updates install over each other; it is a personal side-loaded app.
- **Web side**: `app.js` detects `window.TLNative` and adds the Recording card, opens straight into recorded data, and refreshes when the app comes to the front. `test/native.js` tests this against a simulated bridge.
