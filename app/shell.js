// app/shell.js
// SansadSaar shell — corpus registry, AI worker management, BYOK providers,
// web search, settings + help UI, AI pill chrome, chip switcher, per-corpus
// status display, JS API surface (window.sansadsaar), cross-tab postMessage,
// and app init.
//
// What's NOT here: anything corpus-specific (DRSC report rendering, filters,
// exports, prompts). Those live in app/corpora/<id>/index.js. Shell is
// corpus-agnostic — adding CAG in v1.0b means dropping in another corpus
// module and registering it; no shell changes needed for the second chip.

import {
  loadSettings, saveSettings,
  escapeHtml, debounce,
  relativeTime, statusBucket,
  INTRO_SEEN_KEY,
} from './deps.js';
import { DRSCCorpus }  from './corpora/drsc/index.js';
import { CAGCorpus }   from './corpora/cag/index.js';
import { BillsCorpus } from './corpora/bills/index.js';

// ── Constants ───────────────────────────────────────────────────────────────

const PRODUCT = 'sansadsaar';
const VERSION = '1.0a-phase1';

// Data mirror URL. ?data=ghpages or ?data=<url> overrides for local dev /
// alternate origin testing. Default = sansadsaar-data.naklitechie.com (CF
// Workers + Static Assets, post-phase-3). sansad-files.naklitechie.com
// continues to serve the same Worker as a legacy alias — pass
// ?data=https://sansad-files.naklitechie.com/ to use it explicitly.
const DATA_BASE_URL = (() => {
  const u = new URL(window.location.href);
  const override = u.searchParams.get('data');
  if (override === 'ghpages') return 'https://naklitechie.github.io/parliamentwatch-data/';
  return override || 'https://sansadsaar-data.naklitechie.com/';
})();

// Local-AI model registry. Multimodal uses AutoProcessor +
// Gemma4ForConditionalGeneration; causal uses AutoTokenizer +
// AutoModelForCausalLM. The 'type' field drives the worker's load path.
const MODELS = {
  'gemma4-e2b': {
    id: 'onnx-community/gemma-4-E2B-it-ONNX',
    label: 'Gemma 4 E2B', size: '~1.5 GB',
    dtype: 'q4f16', type: 'multimodal', contextSize: 8192,
    genConfig: { temperature: 0.5, top_k: 40, top_p: 0.95, max_new_tokens: 1024, repetition_penalty: 1.1 },
  },
  'gemma4-e4b': {
    id: 'onnx-community/gemma-4-E4B-it-ONNX',
    label: 'Gemma 4 E4B', size: '~4.9 GB',
    dtype: 'q4f16', type: 'multimodal', contextSize: 12288,
    genConfig: { temperature: 0.5, top_k: 40, top_p: 0.95, max_new_tokens: 1024, repetition_penalty: 1.1 },
  },
  'bonsai-1.7b': {
    id: 'onnx-community/Ternary-Bonsai-1.7B-ONNX',
    label: 'Ternary Bonsai 1.7B', size: '~470 MB',
    dtype: 'q2f16', type: 'causal', contextSize: 32768,
    genConfig: { temperature: 0.7, top_k: 20, top_p: 0.8, max_new_tokens: 1024, repetition_penalty: 1.05 },
  },
  'bonsai-4b': {
    id: 'onnx-community/Ternary-Bonsai-4B-ONNX',
    label: 'Ternary Bonsai 4B', size: '~1.1 GB',
    dtype: 'q2f16', type: 'causal', contextSize: 32768,
    genConfig: { temperature: 0.7, top_k: 20, top_p: 0.8, max_new_tokens: 1024, repetition_penalty: 1.05 },
  },
  'bonsai-8b': {
    id: 'onnx-community/Ternary-Bonsai-8B-ONNX',
    label: 'Ternary Bonsai 8B', size: '~2.2 GB',
    dtype: 'q2f16', type: 'causal', contextSize: 65536,
    genConfig: { temperature: 0.7, top_k: 20, top_p: 0.8, max_new_tokens: 1024, repetition_penalty: 1.05 },
  },
};

// BYOK provider defaults. style determines the request shape (Anthropic
// has its own format; everything else is OpenAI-compatible).
const PROVIDER_DEFAULTS = {
  anthropic:  { url: 'https://api.anthropic.com/v1/messages',                model: 'claude-sonnet-4-5',     style: 'anthropic' },
  openai:     { url: 'https://api.openai.com/v1/chat/completions',           model: 'gpt-4o-mini',           style: 'openai' },
  gemini:     { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-2.5-flash', style: 'openai' },
  groq:       { url: 'https://api.groq.com/openai/v1/chat/completions',      model: 'llama-3.3-70b-versatile', style: 'openai' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions',        model: 'meta-llama/llama-3.3-70b-instruct:free', style: 'openai' },
  ollama:     { url: 'http://localhost:11434/v1/chat/completions',           model: 'llama3.2',              style: 'openai', noAuth: true },
  custom:     { url: '',                                                     model: '',                      style: 'openai' },
};

// ── Shell state (private) ───────────────────────────────────────────────────

const ai = {
  mode: 'local',                       // 'local' | 'api'
  localModel: 'gemma4-e2b',            // currently SELECTED (UI/state)
  loadedModel: null,                   // model key actually warm in the worker
  worker: null,
  workerReady: false,
  workerLoading: false,
  apiProvider: 'anthropic',
  apiKey: '',
  apiModel: '',
  apiBaseUrl: '',
  streaming: false,
  abortController: null,               // for fetch-based API streaming
  msgIdCounter: 0,
  pendingResolvers: new Map(),         // msgId → { onToken, onDone, onErr }
};

const search = { provider: 'none', apiKey: '', baseUrl: '' };

// Corpus registry — Map<id, corpus>.
const corpora = new Map();
let activeCorpusId = null;

// ── UI helpers (toast, modal control) ───────────────────────────────────────

function toast(msg, ms = 2400) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('open');
}

// ── Cross-tab postMessage (BroadcastChannel) ────────────────────────────────
//
// Same-origin only — different origins can't share a BroadcastChannel. The
// dual-app-URL setup means a user with tabs open at sansadsaar.naklitechie.com
// AND sansadlocal.naklitechie.com won't see cross-broadcasts (separate
// origins). Within a single origin, any tab broadcasting changes is heard
// by all other tabs. Used for settings sync + corpus activation hints.

const bc = ('BroadcastChannel' in window) ? new BroadcastChannel(PRODUCT) : null;
const broadcastListeners = new Set();

function broadcast(type, payload) {
  if (!bc) return;
  bc.postMessage({ type, payload, ts: Date.now() });
}

function onBroadcast(cb) {
  broadcastListeners.add(cb);
  return () => broadcastListeners.delete(cb);
}

if (bc) {
  bc.addEventListener('message', (e) => {
    for (const cb of broadcastListeners) {
      try { cb(e.data); } catch (err) { console.warn('broadcast listener error', err); }
    }
  });
}

// ── AI: local worker ────────────────────────────────────────────────────────

function createLocalWorker() {
  // Blob-URL ES module — same shape as LocalMind/VaultMind. The fetch
  // intercept layer is omitted (no resumable downloads needed for v1).
  const code = `
let env, AutoTokenizer, AutoModelForCausalLM, AutoProcessor, Gemma4ForConditionalGeneration, TextStreamer, InterruptableStoppingCriteria;
let stopping_criteria;

const __modReady = import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4/+esm').then(m => {
  env = m.env;
  AutoTokenizer = m.AutoTokenizer;
  AutoModelForCausalLM = m.AutoModelForCausalLM;
  AutoProcessor = m.AutoProcessor;
  Gemma4ForConditionalGeneration = m.Gemma4ForConditionalGeneration;
  TextStreamer = m.TextStreamer;
  InterruptableStoppingCriteria = m.InterruptableStoppingCriteria;
  env.allowLocalModels  = true;
  env.localModelPath    = '/models/';
  env.allowRemoteModels = true;
  stopping_criteria = new InterruptableStoppingCriteria();
});

let processor = null;
let tokenizer = null;
let model = null;

const progressCallback = (p) => self.postMessage({ type: 'progress', data: p });

async function loadMultimodal(modelId, dtype) {
  processor = await AutoProcessor.from_pretrained(modelId, { progress_callback: progressCallback });
  tokenizer = processor.tokenizer;
  model = await Gemma4ForConditionalGeneration.from_pretrained(modelId, {
    dtype, device: 'webgpu', progress_callback: progressCallback,
  });
  self.postMessage({ type: 'warmup' });
  const warmupInputs = tokenizer('a');
  await model.generate({ ...warmupInputs, max_new_tokens: 1 });
  self.postMessage({ type: 'ready' });
}

async function loadCausal(modelId, dtype) {
  processor = null;
  tokenizer = await AutoTokenizer.from_pretrained(modelId, { progress_callback: progressCallback });
  model = await AutoModelForCausalLM.from_pretrained(modelId, {
    dtype, device: 'webgpu', progress_callback: progressCallback,
  });
  self.postMessage({ type: 'warmup' });
  const warmupInputs = tokenizer('a');
  await model.generate({ ...warmupInputs, max_new_tokens: 1 });
  self.postMessage({ type: 'ready' });
}

async function generate(messages, id, gc) {
  stopping_criteria.reset();
  try {
    let inputs, streamerTok;
    if (processor) {
      const prompt = processor.apply_chat_template(messages, { add_generation_prompt: true });
      inputs = await processor(prompt, null, null, { add_special_tokens: false });
      streamerTok = processor.tokenizer;
    } else {
      inputs = tokenizer.apply_chat_template(messages, { add_generation_prompt: true, return_dict: true });
      streamerTok = tokenizer;
    }
    const streamer = new TextStreamer(streamerTok, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text) => self.postMessage({ type: 'token', token: text, id }),
    });
    await model.generate({
      ...inputs,
      max_new_tokens: gc?.max_new_tokens || 1024,
      do_sample: true,
      temperature: gc?.temperature ?? 0.5,
      top_k: gc?.top_k ?? 40,
      top_p: gc?.top_p ?? 0.95,
      repetition_penalty: gc?.repetition_penalty ?? 1.1,
      streamer,
      stopping_criteria,
    });
    self.postMessage({ type: 'complete', id });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err.message || String(err) });
    self.postMessage({ type: 'complete', id });
  }
}

self.addEventListener('message', async (e) => {
  await __modReady;
  const { type, modelId, modelType, dtype, messages, id, generationConfig } = e.data;
  if (type === 'load') {
    try {
      if (modelType === 'causal') await loadCausal(modelId, dtype);
      else await loadMultimodal(modelId, dtype);
    } catch (err) {
      self.postMessage({ type: 'error', message: 'Failed to load model: ' + (err.message || String(err)) });
    }
  } else if (type === 'generate') {
    await generate(messages, id, generationConfig);
  } else if (type === 'stop') {
    stopping_criteria?.interrupt();
  }
});
`;
  const blob = new Blob([code], { type: 'application/javascript' });
  const w = new Worker(URL.createObjectURL(blob), { type: 'module' });

  // Without this, blob-URL module workers fail completely silently — no
  // console, no network, nothing. Lesson learned the hard way in BabelLocal.
  w.addEventListener('error', (e) => {
    console.error('Worker error:', e.message, e);
    setLocalStatus('error', 'Worker error: ' + (e.message || 'unknown'));
  });

  w.addEventListener('message', (e) => {
    const d = e.data;
    if (d.type === 'progress') {
      handleLoadProgress(d.data);
    } else if (d.type === 'warmup') {
      setLoadProgress(98, 'Compiling WebGPU shaders...');
    } else if (d.type === 'ready') {
      const wasLoading = ai.workerLoading;
      ai.workerReady = true;
      ai.workerLoading = false;
      ai.loadedModel = ai.localModel;
      setLoadProgress(100, '');
      hideLoadProgress();
      setLocalStatus('ready', MODELS[ai.loadedModel].label + ' ready');
      const pill = document.getElementById('aiPill');
      pill?.classList.add('pulse');
      setTimeout(() => pill?.classList.remove('pulse'), 3200);
      if (wasLoading) {
        toast('AI ready — open any report and try the AI summary or Ask tab', 4000);
      }
    } else if (d.type === 'token') {
      const r = ai.pendingResolvers.get(d.id);
      if (r) r.onToken(d.token);
    } else if (d.type === 'complete') {
      const r = ai.pendingResolvers.get(d.id);
      if (r) {
        r.onDone();
        ai.pendingResolvers.delete(d.id);
      }
      ai.streaming = false;
    } else if (d.type === 'error') {
      const r = d.id != null ? ai.pendingResolvers.get(d.id) : null;
      if (r) {
        r.onErr(new Error(d.message));
        ai.pendingResolvers.delete(d.id);
      } else {
        setLocalStatus('error', d.message);
      }
      ai.streaming = false;
    }
  });
  return w;
}

// ── AI: status pill + load progress ────────────────────────────────────────

function setLocalStatus(kind, text) {
  const pill = document.getElementById('localStatus');
  if (!pill) return;
  pill.classList.remove('ready', 'loading', 'error');
  if (kind) pill.classList.add(kind);
  document.getElementById('localStatusText').textContent = text;
  refreshAIPill();
  notifyCorporaOfAIChange();
}

function refreshAIPill() {
  const pill = document.getElementById('aiPill');
  const txt  = document.getElementById('aiPillText');
  if (!pill || !txt) return;
  pill.classList.remove('ready', 'loading', 'error', 'api');
  if (ai.mode === 'api') {
    const cfg = getApiConfig();
    if (!cfg.apiKey && !cfg.noAuth) {
      txt.textContent = 'BYOK · set key';
    } else {
      pill.classList.add('api', 'ready');
      const labels = { anthropic:'Anthropic', openai:'OpenAI', gemini:'Gemini', groq:'Groq', openrouter:'OpenRouter', ollama:'Ollama', custom:'Custom' };
      txt.textContent = 'BYOK: ' + (labels[ai.apiProvider] || ai.apiProvider);
    }
    return;
  }
  if (!navigator.gpu) {
    pill.classList.add('error');
    txt.textContent = 'No WebGPU';
    return;
  }
  if (ai.workerReady) {
    pill.classList.add('ready');
    txt.textContent = MODELS[ai.localModel].label + ' ready';
    return;
  }
  if (ai.workerLoading) {
    pill.classList.add('loading');
    txt.textContent = 'Loading model…';
    return;
  }
  txt.textContent = 'AI off';
}

function notifyCorporaOfAIChange() {
  for (const c of corpora.values()) {
    try { c.refreshAIDependentTabs?.(); } catch (e) { console.warn('corpus refresh error', e); }
  }
}

function showLoadProgress() { document.getElementById('loadProgress')?.classList.add('visible'); }
function hideLoadProgress() { document.getElementById('loadProgress')?.classList.remove('visible'); }
function setLoadProgress(pct, label) {
  const fill = document.getElementById('loadProgressFill');
  const text = document.getElementById('loadProgressText');
  if (fill) fill.style.width = pct + '%';
  if (text) text.textContent = label || '';
}

let _currentDownloadFile = '';
function handleLoadProgress(p) {
  showLoadProgress();
  const fileName = p.file ? String(p.file).split('/').pop() : '';
  if (fileName) _currentDownloadFile = fileName;
  if (p.status === 'initiate') {
    setLoadProgress(2, `Fetching ${fileName}...`);
  } else if (p.status === 'progress_total' && p.loaded && p.total) {
    const pct = Math.min(96, Math.round((p.loaded / p.total) * 100));
    const mb = (p.loaded / 1048576).toFixed(0);
    const tot = (p.total / 1048576).toFixed(0);
    const label = _currentDownloadFile ? ` ${_currentDownloadFile}` : '';
    setLoadProgress(pct, `Downloading${label} — ${mb}/${tot} MB (${pct}%)`);
  } else if (p.status === 'loading') {
    setLoadProgress(96, `Loading ${fileName} into memory...`);
  }
}

// ── AI: model lifecycle ────────────────────────────────────────────────────

async function loadLocalModel() {
  if (!navigator.gpu) {
    setLocalStatus('error', 'WebGPU not available — switch to BYOK mode');
    return;
  }
  if (ai.workerLoading) return;
  if (ai.workerReady && ai.loadedModel === ai.localModel) {
    setLocalStatus('ready', MODELS[ai.localModel].label + ' ready');
    return;
  }
  // Different model selected — tear down existing worker.
  if (ai.worker) { try { ai.worker.terminate(); } catch {} ai.worker = null; }
  ai.workerReady = false;
  ai.loadedModel = null;
  ai.workerLoading = true;
  setLocalStatus('loading', 'Starting worker...');
  showLoadProgress();
  setLoadProgress(1, 'Initialising...');

  ai.worker = createLocalWorker();
  const m = MODELS[ai.localModel];
  ai.worker.postMessage({ type: 'load', modelId: m.id, modelType: m.type, dtype: m.dtype });
}

async function isModelCached(modelId) {
  try {
    const names = await caches.keys();
    for (const name of names) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      if (keys.some(req => req.url.includes(modelId))) return true;
    }
  } catch {}
  return false;
}

async function clearModelCache() {
  if (!confirm('Clear cached model weights? Next load will re-download.')) return;
  try {
    const names = await caches.keys();
    for (const name of names) await caches.delete(name);
    setLocalStatus('', 'Cache cleared — load again');
    ai.workerReady = false;
    ai.loadedModel = null;
    if (ai.worker) { ai.worker.terminate(); ai.worker = null; }
    toast('Model cache cleared');
  } catch (e) {
    toast('Could not clear cache');
  }
}

// ── AI: BYOK providers ──────────────────────────────────────────────────────

function getApiConfig() {
  const provider = ai.apiProvider;
  const def = PROVIDER_DEFAULTS[provider];
  return {
    provider,
    style: def.style,
    url: ai.apiBaseUrl || def.url,
    model: ai.apiModel || def.model,
    apiKey: ai.apiKey,
    noAuth: !!def.noAuth,
  };
}

async function generateApi(messages, onToken, signal) {
  const cfg = getApiConfig();
  if (!cfg.apiKey && !cfg.noAuth) throw new Error('Set an API key in Settings first.');
  if (!cfg.url) throw new Error('Set a Base URL in Settings (custom provider).');

  if (cfg.style === 'anthropic') return generateAnthropic(messages, onToken, signal, cfg);
  return generateOpenAICompatible(messages, onToken, signal, cfg);
}

async function generateAnthropic(messages, onToken, signal, cfg) {
  let system = '';
  const turns = [];
  for (const m of messages) {
    if (m.role === 'system') system = (system ? system + '\n\n' : '') + m.content;
    else turns.push({ role: m.role, content: [{ type: 'text', text: m.content }] });
  }
  const body = {
    model: cfg.model, system: system || undefined, messages: turns, max_tokens: 1024, stream: true,
  };
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': cfg.apiKey,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 240)}`);

  await streamSSE(res, (line) => {
    try {
      const j = JSON.parse(line);
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta' && j.delta?.text) {
        onToken(j.delta.text);
      }
    } catch {}
  });
}

async function generateOpenAICompatible(messages, onToken, signal, cfg) {
  const body = { model: cfg.model, messages, stream: true, max_tokens: 1024 };
  const headers = { 'Content-Type': 'application/json' };
  if (!cfg.noAuth) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  if (cfg.provider === 'openrouter') {
    headers['HTTP-Referer'] = location.origin;
    headers['X-Title'] = 'SansadSaar';
  }
  const res = await fetch(cfg.url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(`${cfg.provider} ${res.status}: ${(await res.text()).slice(0, 240)}`);

  await streamSSE(res, (line) => {
    if (line === '[DONE]') return;
    try {
      const j = JSON.parse(line);
      const tok = j.choices?.[0]?.delta?.content;
      if (tok) onToken(tok);
    } catch {}
  });
}

async function streamSSE(res, onLine) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const ln of lines) {
      if (ln.startsWith('data: ')) onLine(ln.slice(6).trim());
    }
  }
}

// ── AI: unified generate / stop ────────────────────────────────────────────

async function aiGenerate(messages, onToken) {
  if (ai.streaming) throw new Error('Already generating — wait or stop.');
  ai.streaming = true;
  try {
    if (ai.mode === 'api') {
      ai.abortController = new AbortController();
      try {
        await generateApi(messages, onToken, ai.abortController.signal);
      } finally {
        ai.abortController = null;
      }
    } else {
      if (!navigator.gpu) throw new Error('WebGPU not available — switch to BYOK mode in Settings.');
      if (!ai.workerReady) throw new Error('Local model not loaded. Open Settings → Load.');
      const id = ++ai.msgIdCounter;
      const m = MODELS[ai.localModel];
      await new Promise((resolve, reject) => {
        ai.pendingResolvers.set(id, { onToken, onDone: resolve, onErr: reject });
        ai.worker.postMessage({ type: 'generate', messages, id, generationConfig: m.genConfig });
      });
    }
  } finally {
    ai.streaming = false;
  }
}

function aiStop() {
  if (ai.mode === 'api' && ai.abortController) {
    ai.abortController.abort();
  } else if (ai.worker) {
    ai.worker.postMessage({ type: 'stop' });
  }
  ai.streaming = false;
}

function isAIUsable() {
  if (ai.mode === 'api') {
    const cfg = getApiConfig();
    return !!cfg.apiKey || !!cfg.noAuth;
  }
  return ai.workerReady;
}

function aiNotReadyHTML() {
  const reason = (() => {
    if (ai.mode === 'api') {
      return 'No API key set. Open <b>Settings</b> to add a key for your chosen provider — free options include Gemini, Groq, OpenRouter, and Ollama (local).';
    }
    if (!navigator.gpu) {
      return 'WebGPU isn\'t available in this browser. Switch <b>Settings → AI mode</b> to <b>BYOK</b> and add an API key (Gemini, Groq, OpenRouter all have free tiers).';
    }
    if (ai.workerLoading) {
      return 'Local model is loading — this can take a minute on first run while shaders compile. The pill at the top right tracks progress.';
    }
    return 'Local model not loaded yet. Open <b>Settings</b> to load Gemma 4 (~1.5 GB the first time, instant after that), or switch to <b>BYOK</b> mode.';
  })();
  return `<div class="ai-empty">
    <p>${reason}</p>
    <div class="ai-empty-cta"><button class="primary sm" data-action="open-settings">Open Settings</button></div>
  </div>`;
}

// Wires up the "Open Settings" button rendered by aiNotReadyHTML. Replaces
// the inline onclick that was in SansadLocal — friendlier to a future CSP.
function bindAINotReadyCTA(container) {
  const btn = container.querySelector('[data-action="open-settings"]');
  if (btn) btn.addEventListener('click', () => {
    renderSettings();
    openModal('settingsModal');
  });
}

// ── Web search providers ────────────────────────────────────────────────────

function isSearchConfigured() {
  const p = search.provider;
  if (!p || p === 'none') return false;
  if (p === 'searxng') return !!search.baseUrl;
  return !!search.apiKey;
}

const SearchProviders = {
  async tavily(query, apiKey) {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: 5, search_depth: 'basic' }),
    });
    if (!res.ok) throw new Error('Tavily ' + res.status + ': ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    return (j.results || []).map(r => ({ title: r.title, url: r.url, snippet: (r.content || '').slice(0, 600) }));
  },
  async brave(query, apiKey) {
    const res = await fetch('https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query), {
      headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' },
    });
    if (!res.ok) throw new Error('Brave ' + res.status + ': ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    return (j.web?.results || []).slice(0, 5).map(r => ({ title: r.title, url: r.url, snippet: (r.description || '').slice(0, 600) }));
  },
  async searxng(query, baseUrl) {
    const url = baseUrl.replace(/\/$/, '') + '/search?q=' + encodeURIComponent(query) + '&format=json';
    const res = await fetch(url);
    if (!res.ok) throw new Error('SearXNG ' + res.status + ': ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    return (j.results || []).slice(0, 5).map(r => ({ title: r.title, url: r.url, snippet: (r.content || '').slice(0, 600) }));
  },
};

async function runSearch(query) {
  if (search.provider === 'tavily')  return SearchProviders.tavily(query, search.apiKey);
  if (search.provider === 'brave')   return SearchProviders.brave(query, search.apiKey);
  if (search.provider === 'searxng') return SearchProviders.searxng(query, search.baseUrl);
  throw new Error('No web search provider configured');
}

// ── Settings UI ────────────────────────────────────────────────────────────

function renderSettings() {
  document.getElementById('aiMode').value        = ai.mode;
  document.getElementById('localModel').value    = ai.localModel;
  document.getElementById('apiProvider').value   = ai.apiProvider;
  document.getElementById('apiKey').value        = ai.apiKey || '';
  document.getElementById('apiModel').value      = ai.apiModel || '';
  document.getElementById('apiBaseUrl').value    = ai.apiBaseUrl || '';
  document.getElementById('searchProvider').value = search.provider || 'none';
  document.getElementById('searchApiKey').value   = search.apiKey || '';
  document.getElementById('searchBaseUrl').value  = search.baseUrl || '';

  toggleAISections();
  toggleProviderRows();
  toggleSearchRows();

  // Mount each registered corpus's settings section.
  const corpusContainer = document.getElementById('corpusSettingsSections');
  if (corpusContainer) {
    corpusContainer.innerHTML = '';
    for (const c of corpora.values()) {
      if (typeof c.renderSettingsSection !== 'function') continue;
      const wrap = document.createElement('div');
      wrap.dataset.corpus = c.id;
      corpusContainer.appendChild(wrap);
      try { c.renderSettingsSection(wrap); } catch (e) { console.warn('corpus settings render error', c.id, e); }
    }
  }

  // Status pill
  if (ai.workerReady)        setLocalStatus('ready', MODELS[ai.localModel].label + ' ready');
  else if (ai.workerLoading) setLocalStatus('loading', 'Loading…');
  else if (!navigator.gpu)   setLocalStatus('error', 'WebGPU not available');
  else                       setLocalStatus('', 'Not loaded');

  isModelCached(MODELS[ai.localModel].id).then(cached => {
    if (!ai.workerReady && !ai.workerLoading) {
      setLocalStatus('', cached ? 'Cached — click Load to enable' : 'Not loaded');
    }
  });
}

function toggleAISections() {
  const mode = document.getElementById('aiMode').value;
  document.getElementById('localAISection').style.display = mode === 'local' ? '' : 'none';
  document.getElementById('apiAISection').style.display   = mode === 'api'   ? '' : 'none';
}

function toggleProviderRows() {
  const p = document.getElementById('apiProvider').value;
  document.getElementById('baseUrlRow').style.display = (p === 'ollama' || p === 'custom') ? '' : 'none';
  const def = PROVIDER_DEFAULTS[p];
  document.getElementById('apiModel').placeholder = def.model;
  document.getElementById('apiBaseUrl').placeholder = def.url;
}

function toggleSearchRows() {
  const p = document.getElementById('searchProvider').value;
  document.getElementById('searchKeyRow').style.display = (p === 'tavily' || p === 'brave') ? '' : 'none';
  document.getElementById('searchUrlRow').style.display = (p === 'searxng') ? '' : 'none';
}

function applyShellSettingsFromUI() {
  ai.mode        = document.getElementById('aiMode').value;
  ai.localModel  = document.getElementById('localModel').value;
  ai.apiProvider = document.getElementById('apiProvider').value;
  ai.apiKey      = document.getElementById('apiKey').value.trim();
  ai.apiModel    = document.getElementById('apiModel').value.trim();
  ai.apiBaseUrl  = document.getElementById('apiBaseUrl').value.trim();
  search.provider = document.getElementById('searchProvider').value;
  search.apiKey   = document.getElementById('searchApiKey').value.trim();
  search.baseUrl  = document.getElementById('searchBaseUrl').value.trim();

  // Persist into the single legacy settings JSON (preserves existing keys).
  const s = loadSettings();
  s.aiMode         = ai.mode;
  s.localModel     = ai.localModel;
  s.apiProvider    = ai.apiProvider;
  s.apiKey         = ai.apiKey;
  s.apiModel       = ai.apiModel;
  s.apiBaseUrl     = ai.apiBaseUrl;
  s.searchProvider = search.provider;
  s.searchApiKey   = search.apiKey;
  s.searchBaseUrl  = search.baseUrl;
  saveSettings(s);
}

function loadShellSettings() {
  const s = loadSettings();
  if (s.aiMode)         ai.mode        = s.aiMode;
  if (s.localModel)     ai.localModel  = s.localModel;
  if (s.apiProvider)    ai.apiProvider = s.apiProvider;
  if (s.apiKey)         ai.apiKey      = s.apiKey;
  if (s.apiModel)       ai.apiModel    = s.apiModel;
  if (s.apiBaseUrl)     ai.apiBaseUrl  = s.apiBaseUrl;
  if (s.searchProvider) search.provider = s.searchProvider;
  if (s.searchApiKey)   search.apiKey   = s.searchApiKey;
  if (s.searchBaseUrl)  search.baseUrl  = s.searchBaseUrl;
}

// ── Chip switcher + per-corpus status pill ──────────────────────────────────

function renderCorpusChips() {
  const el = document.getElementById('corpusChips');
  if (!el) return;
  // Group chips by macroGroup. With one corpus this is trivial; future
  // corpora will fan out under their group headings.
  const groups = new Map();   // macroGroup → [corpus]
  for (const c of corpora.values()) {
    const g = c.macroGroup || 'other';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }

  // Single-group case: skip the group label so v1.0a phase 1 isn't visually
  // noisier than necessary. When a second group lands the labels appear.
  const showGroupLabels = groups.size > 1;

  const html = [];
  for (const [g, list] of groups) {
    if (showGroupLabels) {
      html.push(`<span class="corpus-group-label">${escapeHtml(g)}</span>`);
    }
    for (const c of list) {
      const active = c.id === activeCorpusId;
      html.push(`<button class="corpus-chip${active ? ' active' : ''}"
                          data-corpus="${escapeHtml(c.id)}"
                          role="tab"
                          aria-selected="${active}"
                          tabindex="${active ? '0' : '-1'}"
                          title="${escapeHtml(c.label)}">${escapeHtml(c.shortLabel)}</button>`);
    }
  }
  el.innerHTML = html.join(' ');

  // Click + keyboard
  el.querySelectorAll('.corpus-chip').forEach(btn => {
    btn.addEventListener('click', () => activate(btn.dataset.corpus));
  });
}

async function refreshCorpusStatus() {
  const el = document.getElementById('corpusStatus');
  if (!el) return;
  const c = corpora.get(activeCorpusId);
  if (!c) { el.textContent = ''; return; }

  let status;
  try {
    status = await c.fetchStatus?.();
  } catch (e) {
    status = { lastUpdate: null, error: e?.message || 'fetch failed' };
  }

  el.classList.remove('ready', 'stale', 'error');
  if (!status || status.error || !status.lastUpdate) {
    el.classList.add('error');
    el.innerHTML = `<span class="dot"></span><span>${escapeHtml(c.shortLabel)}: data unavailable</span>`;
    return;
  }
  const bucket = statusBucket(status.lastUpdate);
  el.classList.add(bucket);
  const rel = relativeTime(status.lastUpdate) || 'unknown';
  el.innerHTML = `<span class="dot"></span><span>${escapeHtml(c.shortLabel)}: updated ${escapeHtml(rel)}</span>`;
}

// Each corpus is responsible for making its own `activate()` idempotent —
// shell calls it on every chip click. Corpora typically gate heavy one-time
// work (data fetch, IDB hydration) behind a private `_activated` flag and
// always re-render their filter row / list, so a multi-corpus switch
// round-trip restores the right UI in `#filtersContainer` and `#reportsList`.
async function activate(corpusId) {
  const c = corpora.get(corpusId);
  if (!c) return;
  const isSameAsActive = activeCorpusId === corpusId;
  activeCorpusId = corpusId;
  renderCorpusChips();
  if (typeof c.activate === 'function') {
    const ok = await c.activate(deps);
    if (ok === false) return;
  }
  if (!isSameAsActive) await refreshCorpusStatus();
  broadcast('corpus-activated', { corpus: corpusId });
}

// ── deps factory — what corpus modules see ──────────────────────────────────

const deps = {
  config: { dataBaseUrl: DATA_BASE_URL, version: VERSION, product: PRODUCT },

  ai: {
    generate: aiGenerate,
    stop:     aiStop,
    isUsable: isAIUsable,
    streaming: () => ai.streaming,
    mode: () => ai.mode,
    notReadyHTML: aiNotReadyHTML,
    bindNotReadyCTA: bindAINotReadyCTA,
  },

  search: {
    run:          runSearch,
    isConfigured: isSearchConfigured,
  },

  ui: {
    toast,
    openModal,
    closeModal,
    escapeHtml,
    debounce,
  },

  // Which corpus is currently active in the shell. Each corpus uses this
  // to guard handlers on shared DOM (most notably the report-dialog
  // tab buttons): every corpus binds its own click listener at activate
  // time, so without the guard a click would fan out to all corpora and
  // the last-to-fire would stomp the active corpus's render. Each
  // corpus's switchReportTab early-returns if `deps.activeCorpus() !== <id>`.
  activeCorpus: () => activeCorpusId,

  broadcast,
  onBroadcast,
};

// ── JS API surface (window.sansadsaar) ──────────────────────────────────────
//
// Stable surface for power users / external scripts / cross-tab sync.
// Each registered corpus contributes `api: { list, get, search, ... }` —
// the shell aggregates onto window.sansadsaar.<corpusId>. Plus shell-level
// helpers and broadcast channel access.

function buildJSAPI() {
  const api = {
    version: VERSION,
    product: PRODUCT,
    corpora: () => [...corpora.values()].map(c => ({
      id: c.id, label: c.label, shortLabel: c.shortLabel, macroGroup: c.macroGroup, primaryUnit: c.primaryUnit,
    })),
    active: () => activeCorpusId,
    setActive: (id) => activate(id),
    broadcast,
    onBroadcast,
    toast,
    ai: {
      mode:     () => ai.mode,
      isUsable: isAIUsable,
      generate: aiGenerate,
      stop:     aiStop,
    },
  };
  for (const c of corpora.values()) {
    if (c.api) api[c.id] = c.api;
  }
  window[PRODUCT] = api;
}

// ── Init ────────────────────────────────────────────────────────────────────

function attachShellHandlers() {
  // Settings modal
  document.getElementById('settingsBtn').addEventListener('click', () => { renderSettings(); openModal('settingsModal'); });
  document.getElementById('settingsCloseBtn').addEventListener('click', () => closeModal('settingsModal'));
  document.getElementById('aiMode').addEventListener('change',         toggleAISections);
  document.getElementById('apiProvider').addEventListener('change',    toggleProviderRows);
  document.getElementById('searchProvider').addEventListener('change', toggleSearchRows);
  document.getElementById('loadModelBtn').addEventListener('click', () => { applyShellSettingsFromUI(); loadLocalModel(); });
  document.getElementById('clearCacheBtn').addEventListener('click', clearModelCache);
  document.getElementById('saveSettingsBtn').addEventListener('click', () => {
    applyShellSettingsFromUI();
    // Each corpus reads its own form fields and persists what it owns.
    for (const c of corpora.values()) {
      try { c.applySettingsFromUI?.(); } catch (e) { console.warn('corpus settings apply error', c.id, e); }
    }
    refreshAIPill();
    notifyCorporaOfAIChange();
    closeModal('settingsModal');
    toast('Settings saved');
    broadcast('settings-saved');
  });

  // AI pill → opens settings
  document.getElementById('aiPill').addEventListener('click', () => {
    renderSettings();
    openModal('settingsModal');
  });

  // Help modal
  document.getElementById('helpBtn').addEventListener('click', () => openModal('helpModal'));
  document.getElementById('helpCloseBtn').addEventListener('click', () => closeModal('helpModal'));
  document.querySelectorAll('#helpModal .tab-btn').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#helpModal .tab-btn').forEach(x => x.classList.toggle('active', x === b));
      document.querySelectorAll('#helpModal .tab-pane').forEach(p => p.classList.remove('active'));
      const id = { about: 'hAbout', browse: 'hBrowse', ai: 'hAI', privacy: 'hPrivacy', credits: 'hCredits' }[b.dataset.htab];
      document.getElementById(id)?.classList.add('active');
    });
  });

  // Modal backdrop close + Escape
  document.querySelectorAll('.modal-bg').forEach(bg => {
    bg.addEventListener('click', e => { if (e.target === bg) bg.classList.remove('open'); });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-bg.open').forEach(m => m.classList.remove('open'));
    }
  });

  // Cross-tab sync — when settings change in one tab, refresh AI pill in others.
  onBroadcast((data) => {
    if (!data) return;
    if (data.type === 'settings-saved') {
      loadShellSettings();
      refreshAIPill();
      notifyCorporaOfAIChange();
    }
  });
}

async function init() {
  loadShellSettings();

  // Register corpora before anything else so renderSettings can iterate
  // them and JS API can be built once. activeCorpusId stays null until
  // activate() sets it — that's what gates _activated bookkeeping.
  corpora.set(DRSCCorpus.id,  DRSCCorpus);
  corpora.set(CAGCorpus.id,   CAGCorpus);
  corpora.set(BillsCorpus.id, BillsCorpus);

  attachShellHandlers();
  buildJSAPI();
  refreshAIPill();

  // Activate the first corpus — this also renders chips and fetches data.
  await activate(DRSCCorpus.id);

  // First-visit hint: auto-open Help once. Per-machine flag, separate from
  // the settings JSON so toggling settings doesn't reset it.
  try {
    if (!localStorage.getItem(INTRO_SEEN_KEY)) {
      document.querySelectorAll('#helpModal .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.htab === 'about'));
      document.querySelectorAll('#helpModal .tab-pane').forEach(p => p.classList.toggle('active', p.id === 'hAbout'));
      openModal('helpModal');
      localStorage.setItem(INTRO_SEEN_KEY, '1');
    }
  } catch {}

  // Auto-load AI if its weights are already cached.
  if (ai.mode === 'local' && navigator.gpu) {
    isModelCached(MODELS[ai.localModel].id).then(cached => {
      if (cached) loadLocalModel();
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
