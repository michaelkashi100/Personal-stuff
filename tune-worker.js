// Runs the tuning (tune.js) away from the screen, so the app stays responsive while it tests settings.
importScripts('parser.js', 'clean.js', 'tune.js');
self.onmessage = (e) => {
  try {
    const out = self.TL.tune.run(e.data.F, e.data.ctx, (p) => self.postMessage({ progress: p }));
    self.postMessage({ done: out });
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
