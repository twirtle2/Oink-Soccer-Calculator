let ready;
async function loadEngine(baseUrl) {
  if (!ready) ready = (async () => {
    await import(/* @vite-ignore */ `${baseUrl}engine/wasm_exec.js`);
    const go = new globalThis.Go();
    const response = await fetch(`${baseUrl}engine/oink-engine.wasm`);
    if (!response.ok) throw new Error(`Engine download failed (${response.status}).`);
    const bytes = await response.arrayBuffer();
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
    void go.run(instance);
    if (typeof globalThis.runOinkMatches !== 'function') throw new Error('Engine did not start.');
  })();
  return ready;
}
self.onmessage = async (event) => {
  try {
    await loadEngine(event.data.baseUrl);
    if (event.data.jobs) {
      const results = [];
      for (const job of event.data.jobs) {
        const response = JSON.parse(globalThis.runOinkMatches(JSON.stringify(job.request)));
        results.push({ key: job.key, results: response.results || [], error: response.error || '' });
        self.postMessage({ progress: results.length, total: event.data.jobs.length });
      }
      self.postMessage({ batchResults: results });
    } else {
      const response = JSON.parse(globalThis.runOinkMatches(JSON.stringify(event.data.request)));
      if (response.error) throw new Error(response.error);
      self.postMessage({ results: response.results });
    }
  } catch (error) {
    self.postMessage({ error: error.message || 'Simulation failed.' });
  }
};
