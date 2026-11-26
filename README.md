# Personal-stuff
Not related to work

## My Timeline app
Static, offline-capable web app for exploring a Google Timeline export. Open `index.html` (or host the folder, e.g. GitHub Pages), pick your `Timeline.json` / `Records.json` / Semantic Location History file. Parsing happens in the browser; nothing is uploaded.

- `parser.js` – normalises the Google formats, computes stats
- `app.js` / `index.html` – map replay + year-in-review
- `test/make-sample.js` – generates a synthetic sample; `test/e2e.js` – Playwright check

The chosen file is kept as a private copy in the browser's IndexedDB on the device (never uploaded), so the app opens straight into it on later visits. Use *Stats → Change file* / *Forget my data* to replace or remove it.

The replay ignores GPS wobble (tiny moves around one spot are merged into the stay) and guesses the travel mode from the activity label and speed; the car icon is shown only while driving.

### GPS cleaning and the Path lab
`clean.js` gives every fix a confidence between 0 and 1 and rebuilds the likely path from them, each fix pulling as much as its confidence allows (a Kalman filter with a fixed-lag smoother, so each point is decided a few fixes later). The evidence, as log-likelihood ratios that are added up: distance from the path the other fixes describe, turns and out-and-backs, speed (could you reach this fix and come back?), acceleration, signal quality, altitude, buildings, routes you usually take; plus where you can be at all (never in the Middle East outside Israel; abroad only as a real, long enough trip reached at a believable speed). The same Wi-Fi network for 5+ minutes means you were not moving. `osm.js` downloads building outlines and streets from OpenStreetMap for the ~600 m squares a viewed day passes through (14-day / 20 MB cache). The **Path lab** (sliders button on the map) shows the raw GPS, every fix coloured by confidence (tap one for the reasons) and the likely path, with all the settings live. Tests: `test/clean-eval.js` (simulated city walks with known truth), `test/osm-unit.js`, `test/osm.js`, `test/lab.js`.

### Driving on roads
While driving, the likely path is map-matched onto the roads (`osm.js` `matchDrive`, a hidden-Markov match: candidates on drivable roads within 40 m, staying on the same or a connected road, following the road's own corners). Road outlines come from OpenStreetMap in ~2.4 km squares, cached like the buildings. Sliders: *Driving: snap to roads* and *Driving: farthest road*. Tests: `test/roads.js`, `test/roads-ui.js`.

### Tuning
In the Path lab, **Tune automatically** runs `tune.js` in a worker (`tune-worker.js`) on your last 30 days: it measures how your GPS wobbles and jumps at places you stayed (checking the learned values on simulated walks with that noise), then searches the settings that best predict readings it hid from itself, and that agree with the fixes you marked **Wrong** / **Right** (tap a dot). Your marks always win in the app itself (`tl-marks`). Tests: `test/tune.js`, `test/tune-ui.js`.

### How the data is understood
`analyze.js` turns the raw fixes into stays and legs (see the header comment): noise-adaptive stay detection, a Viterbi pass over windowed speed statistics to tell walking, running, cycling, driving, transit and flights apart, and Google's own activity hints as a prior. `test/analyze-eval.js` measures it against simulated days with known ground truth (`node test/analyze-eval.js -v`).

UI: one icon set (inline SVG, `ICON` in `app.js`), design tokens in `index.html`, screen wake lock while the app is open, and a finished day moves on to the next one. `test/ui-behavior.js` covers wake lock, day navigation, auto-advance, speed and the two-step forget.

Story mode: a day opens as an overview of its places (numbered pins, named) over the dimmed path. Tap the path and that trip plays, sped up, to the place it leads to; a card then tells you about the place (first visit, time since the last one, how often and how long you are there, when you usually arrive, where you usually come from and go next, favourite of its kind, a night away, distance from home) and waits for **Next stop**. Tap a pin to jump straight to its card. `insightsFor` in `app.js` picks the five most telling facts.

Place names: stays are grouped into places (`TL.clusterPlaces`, 150 m) and the most visited unnamed places are asked about ("Is this your home?" / "Is this where you work?" from where the nights and days are spent, otherwise "What is this place for you?"). Names are kept only in this browser (`localStorage`, key `tl-places`). `test/places.js` and `test/places-ui.js` cover it.

## Android app (background recording)
A browser cannot track location in the background, so `android/` holds a small Android app that does, and bundles this same web app (no file picking, works offline).
- **Battery, without Google services**: the recorder waits on the phone's own motion chips (the *significant motion* sensor and the step counter); only when you start moving does it run GPS (`LocationManager`), in batches (`Policy.kt`), guess walking / cycling / driving itself (`ActivityGuess.kt`), and stop a few minutes after you are still again. Between trips there is a check-in once an hour (a recent free position other apps caused, or a short GPS try), plus those free passive fixes. Android requires a small "Timeline is ready" notification to keep the recorder alive.
- **Signal details** for the cleaning (altitude, satellites and signal strength, Wi-Fi networks around, a salted hash of the connected Wi-Fi) are stored next to each fix and deleted after 3 days.
- **Privacy**: locations are stored in the app's private SQLite database on the phone. The web page can only reach them through the `TLNative` bridge, and its CSP still blocks all network requests except map tiles. *Save a backup* writes a file to Downloads.
- **Build**: `.github/workflows/android.yml` runs the Kotlin unit tests, checks that the web parser understands the exported file (`android/verify-export.js`), builds `timeline.apk`, and on `main` publishes it at `releases/download/android-latest/timeline.apk`. The signing key (`android/dev.keystore`) is committed on purpose so updates install over each other; it is a personal side-loaded app.
- **Web side**: `app.js` detects `window.TLNative` and adds the Recording card, opens straight into recorded data, and refreshes when the app comes to the front. `test/native.js` tests this against a simulated bridge.

### Updates without reinstalling (Android)
- **Screens and analysis** (the web app) update over the air: the Pages deploy publishes `bundle.json` (every file with its SHA-256 and a build time, made by `.github/scripts/make_bundle.py`); the app downloads a newer build, verifies every hash, refuses unsafe paths, and swaps the whole folder in one step. It serves the downloaded copy from the same address as before (so your data and place names stay), falls back to the copy inside the APK, and drops a downloaded copy once an APK newer than it is installed. The page reloads itself when new screens arrive. Rules: `Bundle.kt`, `Updater.kt`.
- **The recorder** (the APK) cannot be swapped silently by Android. When a newer release exists, Insights shows *Update now*; the app downloads the APK and hands it to Android's installer (one confirmation). Same signing key, so data is kept.
- The only network traffic from the app is the update check (this site and the GitHub release), never any of your data. *Update automatically* can be switched off.
