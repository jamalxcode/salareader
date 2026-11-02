// Runs the in-browser AI model off the page's main thread, so working out
// thousands of articles never freezes the page. Small requests (a search
// query) jump ahead of big ones (all your feeds' articles).

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';
const extractors = new Map();
const jobs = [];
let running = false;

function load(model) {
  if (!extractors.has(model)) {
    const files = new Map();
    const p = (async () => {
      const { pipeline, env } = await import(TRANSFORMERS_URL);
      env.allowLocalModels = false;
      return pipeline('feature-extraction', model, {
        dtype: 'q8',
        progress_callback: (e) => {
          if (e.status !== 'progress' || !e.total) return;
          files.set(e.file, [e.loaded, e.total]);
          let l = 0, t = 0;
          for (const [a, b] of files.values()) { l += a; t += b; }
          postMessage({ type: 'download', model, p: t ? l / t : 0 });
        },
      });
    })();
    p.catch(() => extractors.delete(model));
    extractors.set(model, p);
  }
  return extractors.get(model);
}

async function run() {
  if (running) return;
  running = true;
  while (jobs.length) {
    // The job with the least left to do goes next, one batch at a time.
    jobs.sort((a, b) => (a.texts.length - a.done) - (b.texts.length - b.done));
    const job = jobs[0];
    try {
      const ex = await load(job.model);
      // Texts of similar length go together: a batch is padded to its longest text.
      job.order ??= job.texts.map((_, i) => i).sort((a, b) => job.texts[a].length - job.texts[b].length);
      const idx = job.order.slice(job.done, job.done + 16);
      const t = await ex(idx.map((i) => job.texts[i]), { pooling: 'mean', normalize: true });
      const dim = t.dims[t.dims.length - 1];
      idx.forEach((i, b) => { job.out[i] = Float32Array.from(t.data.slice(b * dim, (b + 1) * dim)); });
      job.done += idx.length;
      if (job.done < job.texts.length) { postMessage({ type: 'progress', id: job.id, done: job.done, total: job.texts.length }); continue; }
      jobs.shift();
      postMessage({ type: 'done', id: job.id, vecs: job.out }, job.out.map((v) => v.buffer));
    } catch (e) {
      jobs.splice(jobs.indexOf(job), 1);
      postMessage({ type: 'error', id: job.id, message: String(e?.message || e) });
    }
  }
  running = false;
}

onmessage = (e) => {
  const { id, model, texts } = e.data;
  jobs.push({ id, model, texts, done: 0, out: [] });
  run();
};
