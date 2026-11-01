// AI helpers: meaning vectors (search, topics, related articles) run in the
// browser with transformers.js; Claude (summaries, briefings) runs only when
// the reader has added their own API key.

const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.web.min.js';
const ANTHROPIC_SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.135.0/+esm';
export const EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2'; // must match scripts/fetch.mjs

// ---------- vectors ----------

export function decodeVector(b64) {
  const bin = atob(b64);
  const v = new Float32Array(bin.length);
  let norm = 0;
  for (let i = 0; i < bin.length; i++) {
    let x = bin.charCodeAt(i);
    if (x > 127) x -= 256;
    v[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

let extractorPromise = null;
let progressListeners = new Set();

/** Loads the in-browser model once. onProgress(fraction 0..1) while downloading. */
export function loadEmbedder(onProgress) {
  if (onProgress) progressListeners.add(onProgress);
  if (!extractorPromise) {
    const files = new Map();
    extractorPromise = (async () => {
      const { pipeline, env } = await import(TRANSFORMERS_URL);
      env.allowLocalModels = false;
      return pipeline('feature-extraction', EMBED_MODEL, {
        dtype: 'q8',
        progress_callback: (p) => {
          if (p.status === 'progress' && p.total) {
            files.set(p.file, [p.loaded, p.total]);
            let l = 0, t = 0;
            for (const [a, b] of files.values()) { l += a; t += b; }
            progressListeners.forEach((fn) => fn(t ? l / t : 0));
          }
        },
      });
    })();
    extractorPromise.catch(() => { extractorPromise = null; });
    extractorPromise.finally(() => { progressListeners = new Set(); }).catch(() => {});
  }
  return extractorPromise;
}

export async function embed(texts, onProgress) {
  const extractor = await loadEmbedder(onProgress);
  const out = [];
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16);
    const t = await extractor(batch, { pooling: 'mean', normalize: true });
    const dim = t.dims[t.dims.length - 1];
    for (let b = 0; b < batch.length; b++) out.push(Float32Array.from(t.data.slice(b * dim, (b + 1) * dim)));
  }
  return out;
}

export const embedText = (it) => `${it.t}. ${it.s || ''}`.slice(0, 1000);

// ---------- Claude ----------

let sdkPromise = null;
const loadSdk = () => (sdkPromise ??= import(ANTHROPIC_SDK_URL).catch((e) => { sdkPromise = null; throw e; }));

// Models that support the server-side refusal fallback ("default" routing).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

/**
 * Streams a Claude answer. onText(chunk) is called as text arrives.
 * Returns the full text. Throws an Error with a friendly message.
 */
export async function askClaude({ apiKey, model, system, prompt, onText, signal }) {
  const mod = await loadSdk();
  const Anthropic = mod.default || mod.Anthropic;
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const params = {
    model,
    max_tokens: 4000,
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort: 'low' },
  };
  try {
    const stream = FALLBACK_MODELS.has(model)
      ? client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
      : client.messages.stream(params, { signal });
    let text = '';
    stream.on('text', (chunk) => { text += chunk; onText?.(chunk); });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error("Claude didn't answer this one.");
    return text;
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Your Anthropic API key was rejected. Check it in ⚙ Settings.');
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error("Your API key can't use this model. Try another in ⚙ Settings.");
    if (e instanceof Anthropic.NotFoundError) throw new Error('That model isn\'t available to your key. Pick another in ⚙ Settings.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude is rate-limiting your key. Try again in a minute.');
    if (e instanceof Anthropic.APIConnectionError) throw new Error("Couldn't reach Claude. Check your connection.");
    if (e instanceof Anthropic.APIError) throw new Error(`Claude error ${e.status ?? ''}: ${e.message}`);
    throw e;
  }
}
