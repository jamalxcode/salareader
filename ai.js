// AI helpers: meaning vectors (search, topics, related articles) run in the
// browser with transformers.js; Claude (summaries, briefings) runs only when
// the reader has added their own API key.

// The self-contained browser build: the .web build imports onnxruntime by bare
// name, which a browser can't resolve without a bundler.
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';
const ANTHROPIC_SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.135.0/+esm';
// Must match scripts/fetch.mjs. English is small; multilingual covers 50+ languages.
export const EMBED_MODELS = {
  en: { id: 'Xenova/all-MiniLM-L6-v2', name: 'English', size: '25 MB', vectors: 'data/vectors.json' },
  multi: { id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', name: 'Multilingual (50+ languages)', size: 'about 120 MB', vectors: 'data/vectors-multi.json' },
};
export const EMBED_MODEL = EMBED_MODELS.en.id;

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

/** The reverse of decodeVector: int8, base64 (about 512 characters for 384 numbers). */
export function encodeVector(v) {
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round(v[i] * 127)));
  let bin = '';
  for (let i = 0; i < q.length; i++) bin += String.fromCharCode(q[i] & 255);
  return btoa(bin);
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

const extractors = new Map(); // model key -> Promise<pipeline>
let progressListeners = new Set();

/** Loads an in-browser model once (key: 'en' or 'multi'). onProgress(fraction 0..1) while downloading. */
export function loadEmbedder(onProgress, key = 'en') {
  if (onProgress) progressListeners.add(onProgress);
  let extractorPromise = extractors.get(key);
  if (!extractorPromise) {
    const files = new Map();
    extractorPromise = (async () => {
      const { pipeline, env } = await import(TRANSFORMERS_URL);
      env.allowLocalModels = false;
      return pipeline('feature-extraction', (EMBED_MODELS[key] || EMBED_MODELS.en).id, {
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
    extractors.set(key, extractorPromise);
    extractorPromise.catch(() => { extractors.delete(key); });
    extractorPromise.finally(() => { progressListeners = new Set(); }).catch(() => {});
  }
  return extractorPromise;
}

// The model runs in Web Workers (embed-worker.js), so the page stays
// responsive while it works. Big jobs are split across several workers (one
// CPU core each); extra workers start only once the model is downloaded, so
// it's fetched once. Falls back to this page if workers aren't available.
const workers = [];
let workerFailed = false;
let jobSeq = 0;
const pending = new Map();
const downloadListeners = new Set();
const modelReady = new Set(); // models a worker has loaded (so others load from the browser cache)
const poolSize = (key) => Math.max(1, Math.min(key === 'multi' ? 2 : 4, (navigator.hardwareConcurrency || 2) - 1));

function startWorker() {
  const w = new Worker(new URL('./embed-worker.js', import.meta.url), { type: 'module' });
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'download') { downloadListeners.forEach((fn) => fn(m.p)); return; }
    const job = pending.get(m.id);
    if (!job) return;
    if (m.type === 'progress') job.onEmbedded?.(m.done);
    else {
      pending.delete(m.id);
      if (m.type === 'done') { modelReady.add(job.model); job.resolve(m.vecs); } else job.reject(new Error(m.message));
    }
  };
  w.onerror = (e) => {
    // A worker that can't start (old browser): use this page instead.
    e.preventDefault?.();
    workerFailed = true;
    workers.length = 0;
    for (const [id, job] of pending) { pending.delete(id); embedHere(job.texts, null, job.key).then(job.resolve, job.reject); }
  };
  workers.push(w);
  return w;
}

function runOn(w, texts, key, onEmbedded) {
  return new Promise((resolve, reject) => {
    const id = ++jobSeq;
    const model = (EMBED_MODELS[key] || EMBED_MODELS.en).id;
    pending.set(id, { texts, key, model, onEmbedded, resolve, reject });
    w.postMessage({ id, model, texts });
  });
}

/**
 * Vectors for texts. onProgress(fraction) while the model downloads,
 * onEmbedded(done, total) while it works through many texts.
 */
export async function embed(texts, onProgress, key = 'en', onEmbedded) {
  if (!texts.length) return [];
  if (!workerFailed && !workers.length) { try { startWorker(); } catch { workerFailed = true; } }
  if (workerFailed) return embedHere(texts, onProgress, key, onEmbedded);
  const listener = onProgress ? (p) => onProgress(p) : null;
  if (listener) downloadListeners.add(listener);
  try {
    const model = (EMBED_MODELS[key] || EMBED_MODELS.en).id;
    // Split big jobs across workers once the model is on this device.
    if (texts.length >= 64 && modelReady.has(model)) while (workers.length < poolSize(key)) startWorker();
    const n = texts.length >= 64 && modelReady.has(model) ? Math.min(workers.length, poolSize(key)) : 1;
    const size = Math.ceil(texts.length / n);
    const done = new Array(n).fill(0);
    const parts = await Promise.all(Array.from({ length: n }, (_, k) => runOn(workers[k], texts.slice(k * size, (k + 1) * size), key,
      (d) => { done[k] = d; onEmbedded?.(done.reduce((a, b) => a + b, 0), texts.length); })));
    return parts.flat();
  } finally { if (listener) downloadListeners.delete(listener); }
}

async function embedHere(texts, onProgress, key, onEmbedded) {
  const extractor = await loadEmbedder(onProgress, key);
  const out = [];
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16);
    const t = await extractor(batch, { pooling: 'mean', normalize: true });
    const dim = t.dims[t.dims.length - 1];
    for (let b = 0; b < batch.length; b++) out.push(Float32Array.from(t.data.slice(b * dim, (b + 1) * dim)));
    onEmbedded?.(out.length, texts.length);
    await new Promise((r) => setTimeout(r, 0)); // let the page breathe between batches
  }
  return out;
}

export const embedText = (it) => `${it.t}. ${it.s || ''}`.slice(0, 1000);

// ---------- AI assistants ----------
// The same six assistants as jamalterm: Claude through Anthropic's SDK,
// the rest through their OpenAI-compatible APIs with OpenAI's SDK.

const OPENAI_SDK_URL = 'https://cdn.jsdelivr.net/npm/openai@7.38.0/+esm';

export const PROVIDERS = [
  { id: 'anthropic', name: 'Claude', keyUrl: 'https://platform.claude.com/settings/keys', keyHint: 'sk-ant-…',
    models: [['claude-opus-5-5', 'Claude Opus 5.5 (best)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['claude-haiku-5-5', 'Claude Haiku 5.5 (cheapest)']] },
  { id: 'openai', name: 'ChatGPT', keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'sk-…', base: 'https://api.openai.com/v1' },
  { id: 'deepseek', name: 'DeepSeek', keyUrl: 'https://platform.deepseek.com/api_keys', keyHint: 'sk-…', base: 'https://api.deepseek.com', auto: 'deepseek-v4-flash' },
  { id: 'xai', name: 'Grok', keyUrl: 'https://console.x.ai', keyHint: 'xai-…', base: 'https://api.x.ai/v1' },
  { id: 'openrouter', name: 'OpenRouter', keyUrl: 'https://openrouter.ai/keys', keyHint: 'sk-or-…', base: 'https://openrouter.ai/api/v1', auto: 'openrouter/auto', signIn: true },
  { id: 'gemini', name: 'Gemini', keyUrl: 'https://aistudio.google.com/apikey', keyHint: 'AIza…', base: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
];
export const provider = (id) => PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];

let anthropicPromise = null;
let openaiPromise = null;
const loadAnthropic = () => (anthropicPromise ??= import(ANTHROPIC_SDK_URL).catch((e) => { anthropicPromise = null; throw e; }));
const loadOpenAI = () => (openaiPromise ??= import(OPENAI_SDK_URL).catch((e) => { openaiPromise = null; throw e; }));

/**
 * fetch without the SDK's x-stainless-* headers (OS, runtime and library
 * versions). They tell each AI company about your device, and Gemini
 * refuses browser requests that carry them.
 */
function plainFetch(url, init = {}) {
  const headers = new Headers(init.headers);
  for (const k of [...headers.keys()]) if (k.startsWith('x-stainless')) headers.delete(k);
  return fetch(url, { ...init, headers });
}

async function openaiClient(p, apiKey) {
  const mod = await loadOpenAI();
  const OpenAI = mod.default || mod.OpenAI;
  const defaultHeaders = p.id === 'openrouter'
    ? { 'HTTP-Referer': 'https://reader.sala.company', 'X-Title': 'Sala Reader' } // OpenRouter's app attribution
    : undefined;
  return { OpenAI, client: new OpenAI({ apiKey, baseURL: p.base, dangerouslyAllowBrowser: true, defaultHeaders, fetch: plainFetch }) };
}

// Skip models that can't chat (images, audio, embeddings, …). Same rules as jamalterm.
const NOT_CHAT = /(embed|image|dall|tts|whisper|audio|realtime|transcri|speech|moderation|search|live|sora|vision-preview|instruct|davinci|babbage)/i;
function isChatModel(pid, id) {
  if (NOT_CHAT.test(id)) return false;
  // Codex, deep-research and -pro models only work through the Responses API, not chat.
  if (pid === 'openai') return /^(gpt-|chatgpt-|o\d)/.test(id) && !/codex|deep-research|-pro\b/.test(id);
  if (pid === 'xai') return id.startsWith('grok-');
  if (pid === 'gemini') return id.startsWith('gemini-');
  return true;
}
/** Newer, general-purpose models first. */
export function rankModel(id) {
  const l = id.toLowerCase();
  const m = /(\d+(?:\.\d+)?)/.exec(l);
  let score = (m ? parseFloat(m[1]) : 0) * 100;
  for (const small of ['mini', 'nano', 'luna', 'lite', 'flash']) if (l.includes(small)) score -= 30;
  if (l.includes('pro')) score -= 10;
  if (/\d{4}-\d{2}-\d{2}|\d{4}$/.test(l)) score -= 5; // dated snapshots after the moving alias
  return score;
}

/** The chat models a provider offers to this key, best first. */
export async function listModels(pid, apiKey) {
  const p = provider(pid);
  if (p.models) return p.models.map(([id]) => id);
  const { OpenAI, client } = await openaiClient(p, apiKey);
  const out = [];
  try {
    for await (const m of client.models.list()) {
      const id = String(m.id).replace(/^models\//, ''); // Gemini lists "models/gemini-…"
      if (isChatModel(p.id, id)) out.push(id);
    }
  } catch (e) { throw friendlyError(p, e, OpenAI); }
  if (p.id !== 'openrouter') out.sort((a, b) => rankModel(b) - rankModel(a));
  return out;
}

const autoCache = new Map();
async function resolveModel(p, apiKey, model) {
  if (model && model !== 'auto') return model;
  if (p.models) return p.models[0][0];
  if (p.auto) return p.auto;
  const key = p.id + ':' + apiKey.slice(-6);
  if (!autoCache.has(key)) {
    const models = await listModels(p.id, apiKey);
    if (!models.length) throw new Error(`${p.name} offered no chat models to your key. Pick one in ⚙ Settings.`);
    autoCache.set(key, models[0]);
  }
  return autoCache.get(key);
}

// Claude models that support the server-side refusal fallback ("default" routing).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

/**
 * Streams an answer from the chosen assistant. onText(chunk) is called as
 * text arrives. Returns { text, model }. Throws an Error with a friendly message.
 */
/**
 * Asks an assistant. Either prompt (one question) or messages (a conversation:
 * [{role: 'user' | 'assistant', content}], starting and ending with 'user').
 */
export async function askAI({ providerId, apiKey, model, system, prompt, messages, onText, signal }) {
  const p = provider(providerId);
  if (!apiKey) throw new Error(`Add your ${p.name} API key in ⚙ Settings.`);
  messages ??= [{ role: 'user', content: prompt }];
  if (p.id === 'anthropic') return askClaude({ apiKey, model: await resolveModel(p, apiKey, model), system, messages, onText, signal });
  const resolved = await resolveModel(p, apiKey, model);
  const { OpenAI, client } = await openaiClient(p, apiKey);
  let text = '';
  try {
    const stream = await client.chat.completions.create({
      model: resolved,
      stream: true,
      messages: [{ role: 'system', content: system }, ...messages],
    }, { signal });
    for await (const chunk of stream) {
      const d = chunk.choices?.[0]?.delta;
      if (d?.refusal) throw new Error(`${p.name} declined to answer this one.`);
      if (d?.content) { text += d.content; onText?.(d.content); }
    }
  } catch (e) { throw friendlyError(p, e, OpenAI); }
  if (!text) throw new Error(`${p.name} sent an empty answer. Try again or pick another model.`);
  return { text, model: resolved };
}

// ---------- Grok with live X and web search ----------
// xAI's Responses API runs the searches on its side (x_search, web_search)
// and returns the answer with the posts and pages it used.

const GROK_SEARCH_MODEL = 'grok-4-1-fast';

/** Every cited link in a Responses API result, wherever it's reported. */
function grokCitations(res, text) {
  const out = new Map();
  const add = (url, title) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return;
    if (/^\s*\[?\d+\]?\s*$/.test(title || '')) title = ''; // Grok sometimes titles them just "1", "2"…
    if (!out.has(url)) out.set(url, { url, title: title || '' });
    else if (title && !out.get(url).title) out.get(url).title = title;
  };
  for (const c of res?.citations || []) typeof c === 'string' ? add(c) : add(c?.url, c?.title);
  for (const item of res?.output || []) {
    for (const part of item?.content || []) for (const a of part?.annotations || []) add(a?.url, a?.title);
    for (const r of item?.results || item?.action?.sources || []) add(r?.url, r?.title);
  }
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s)\]>"]+/g)) add(m[0].replace(/[.,;:]+$/, ''));
  return [...out.values()];
}

/**
 * Asks Grok with live search of X (and the web). fromDate (YYYY-MM-DD) limits
 * X results to newer posts. Returns { text, model, citations, searches }.
 */
export async function askGrokLive({ apiKey, model, system, messages, fromDate, web = true, x = true, webDomains, onText, signal }) {
  const p = provider('xai');
  if (!apiKey) throw new Error('Add your Grok (xAI) API key in ⚙ Settings to search X.');
  const { OpenAI, client } = await openaiClient(p, apiKey);
  const tools = [];
  if (x) tools.push({ type: 'x_search', ...(fromDate ? { from_date: fromDate } : {}) });
  // webDomains limits the web search to some sites (e.g. YouTube).
  if (web) tools.push({ type: 'web_search', ...(webDomains?.length ? { allowed_domains: webDomains } : {}) });
  const run = async (m) => {
    let text = '';
    let final = null;
    const stream = await client.responses.create({
      model: m,
      stream: true,
      instructions: system,
      input: messages.map((x) => ({ role: x.role, content: x.content })),
      tools,
    }, { signal });
    for await (const ev of stream) {
      if (ev.type === 'response.output_text.delta' && ev.delta) { text += ev.delta; onText?.(ev.delta); }
      else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') final = ev.response;
      else if (ev.type === 'response.failed' || ev.type === 'error') throw new Error(ev.response?.error?.message || ev.message || 'Grok stopped with an error.');
    }
    if (!text && final?.output_text) text = final.output_text;
    if (!text) throw new Error('Grok sent an empty answer. Try again.');
    const searches = (final?.output || []).filter((o) => /search/.test(o?.type || '')).length
      || final?.usage?.server_side_tool_usage_details?.x_search_calls + final?.usage?.server_side_tool_usage_details?.web_search_calls || 0;
    return { text, model: final?.model || m, citations: grokCitations(final, text), searches: Number(searches) || 0 };
  };
  // A model picked in Settings, else xAI's search model; fall back to it if the pick can't search.
  const picked = model && model !== 'auto' ? model : GROK_SEARCH_MODEL;
  try { return await run(picked); } catch (e) {
    if (picked !== GROK_SEARCH_MODEL && OpenAI && e instanceof OpenAI.APIError && [400, 404].includes(e.status)) {
      try { return await run(GROK_SEARCH_MODEL); } catch (e2) { throw friendlyError(p, e2, OpenAI); }
    }
    throw friendlyError(p, e, OpenAI);
  }
}

function friendlyError(p, e, OpenAI) {
  if (e?.name === 'AbortError') return e;
  if (OpenAI && e instanceof OpenAI.APIConnectionError) {
    return new Error(`Couldn't reach ${p.name} from this page. Check your connection. If it keeps happening, ${p.name} may not accept requests from websites; OpenRouter offers ${p.name}'s models and works here.`);
  }
  if (OpenAI && e instanceof OpenAI.APIError) {
    switch (e.status) {
      case 401: case 403: return new Error(`${p.name} didn't accept your API key. Check it in ⚙ Settings.`);
      case 400:
        // Gemini and Grok answer a bad key with 400.
        if (/api[ _-]?key|incorrect key|invalid key|authenticat/i.test(String(e.message))) return new Error(`${p.name} didn't accept your API key. Check it in ⚙ Settings.`);
        return new Error(`${p.name} couldn't handle that request (400). Try another model in ⚙ Settings.`);
      case 402: return new Error(`Your ${p.name} account is out of credit.`);
      case 404: return new Error(`That model isn't available to your ${p.name} key. Pick another in ⚙ Settings.`);
      case 429: return new Error(`${p.name} rate limit or quota reached. Try again in a moment, or check your plan's billing.`);
      case 500: case 502: case 503: case 529: return new Error(`${p.name} is busy right now. Try again in a moment.`);
      default: return new Error(`${p.name} API error ${e.status ?? ''}`.trim());
    }
  }
  return e instanceof Error ? e : new Error(String(e));
}

async function askClaude({ apiKey, model, system, messages, onText, signal }) {
  const mod = await loadAnthropic();
  const Anthropic = mod.default || mod.Anthropic;
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const params = {
    model,
    max_tokens: 4000,
    system,
    messages,
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
    return { text, model: msg.model || model };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Your Anthropic API key was rejected. Check it in ⚙ Settings.');
    if (e instanceof Anthropic.PermissionDeniedError) throw new Error("Your API key can't use this model. Try another in ⚙ Settings.");
    if (e instanceof Anthropic.NotFoundError) throw new Error("That model isn't available to your key. Pick another in ⚙ Settings.");
    if (e instanceof Anthropic.RateLimitError) throw new Error('Claude is rate-limiting your key. Try again in a minute.');
    if (e instanceof Anthropic.APIConnectionError) throw new Error("Couldn't reach Claude. Check your connection.");
    if (e instanceof Anthropic.APIError) throw new Error(`Claude error ${e.status ?? ''}: ${e.message}`);
    throw e;
  }
}

// ---------- Sign in with OpenRouter ----------
// OpenRouter's public OAuth PKCE flow (no app registration), as in jamalterm,
// except the callback is this page instead of a local server.

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function startOpenRouterSignIn() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem('sr.orVerifier', verifier);
  const callback = location.origin + location.pathname + '?openrouter=1';
  const q = new URLSearchParams({ callback_url: callback, code_challenge: challenge, code_challenge_method: 'S256' });
  location.href = `https://openrouter.ai/auth?${q}`;
}

/** If this page load is OpenRouter's redirect back, returns the new key (else null). */
export async function finishOpenRouterSignIn() {
  const params = new URLSearchParams(location.search);
  if (!params.has('openrouter')) return null;
  const code = params.get('code');
  const verifier = sessionStorage.getItem('sr.orVerifier');
  sessionStorage.removeItem('sr.orVerifier');
  history.replaceState(null, '', location.pathname + location.hash); // drop ?code= from the address bar
  if (!code || !verifier) throw new Error("OpenRouter sign-in didn't finish. Try again from ⚙ Settings.");
  const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  if (res.status === 403) throw new Error('OpenRouter rejected the sign-in code (it may have expired). Try again.');
  if (!res.ok) throw new Error(`OpenRouter sign-in failed (HTTP ${res.status}).`);
  const { key } = await res.json();
  if (!key) throw new Error("OpenRouter's answer had no key.");
  return key;
}
