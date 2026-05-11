// app/disk-sync.js
// "Save to Disk" — Phase 1 — File System Access API integration for SansadSaar.
//
// What it does today:
//   • User clicks the "Save to Disk" pill in the header → picks a folder →
//     we write the Tier A snapshot (meta + reports/records + manifest +
//     audit + sharded bundles + sharded indexes) of every registered
//     corpus to that folder. The folder structure mirrors the CF mirror
//     exactly — `<root>/drsc/...`, `<root>/cag/...`, `<root>/bills/...`.
//     A user could serve the folder via `python3 -m http.server` and
//     point ?data=http://localhost:8000/ at it; it'd work as-is.
//
//   • On page reload: we silently `queryPermission` on the stored
//     directory handle. If granted, we re-attach. If 'prompt', we show
//     "Reconnect to Disk" — clicking it requests permission (which needs
//     a user gesture). If 'denied' or the handle is invalid, we wipe
//     and revert to the "Save to Disk" state.
//
//   • Manual "Sync now" — re-runs the snapshot, picking up any
//     fresher CF data.
//
// What it does NOT do (Phase 2 territory, intentionally deferred):
//   • Read from disk during corpus asset loads. The corpus modules
//     still fetch from CF. The disk copy is for portability + archive
//     value, not yet for offline browsing.
//   • Background sync on meta.json change. User has to click "Sync".
//   • Save text/<id>.txt files (would balloon to ~700 MB once corpora
//     are fully extracted — Tier A is the index-only ~60 MB slice).
//
// Browser support: Chrome / Edge / Brave / Opera on desktop. Falls back
// to a hidden pill on Safari, Firefox, and mobile — the rest of the app
// works fine without disk sync.
//
// See CONV.md "File System Access API" + "Save-to-Disk pattern".

import { idbGet, idbPut } from './deps.js';

const HANDLE_KEY = 'disk-handle';   // in 'blobs' store

// ── Pure helpers ──────────────────────────────────────────────────────────

const isSupported = typeof window !== 'undefined'
                  && typeof window.showDirectoryPicker === 'function';

async function writeFile(dirHandle, name, content) {
  const fileHandle = await dirHandle.getFileHandle(name, { create: true });
  const writable   = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

// Each corpus's Tier A is its meta.json + the per-corpus-named primary
// + manifest + audit + the shards listed in meta.{search_bundle,search_index}.shards.
// Bills additionally has index-meta.json + index-*.json sharded by
// _shard_filename(). DRSC additionally has committees.json.
const CORPUS_ASSETS = {
  drsc:  ['meta.json', 'reports.json', 'manifest.json', 'audit.json', 'committees.json'],
  cag:   ['meta.json', 'reports.json', 'manifest.json', 'audit.json'],
  bills: ['meta.json', 'records.json', 'manifest.json', 'audit.json', 'index-meta.json'],
};

// ── Stateful module ───────────────────────────────────────────────────────

let _deps          = null;
let _dirHandle     = null;
let _state         = 'unsupported';      // unsupported|unsaved|connected|reconnect-needed
let _lastSyncAt    = null;
let _syncing       = false;
const _listeners   = new Set();

function notify() {
  for (const cb of _listeners) {
    try { cb(); } catch (e) { console.warn('disk-sync listener error', e); }
  }
}

function corpusIds() {
  // The shell registers corpora; we ask for what's currently registered.
  // Falls back to the static list above if the shell hasn't exposed an
  // enumerator yet (boot order shouldn't allow that, but be defensive).
  const product = _deps?.config?.product || 'sansadsaar';
  const api     = (typeof window !== 'undefined') && window[product];
  const dynamic = api?.corpora?.()?.map(c => c.id);
  return dynamic && dynamic.length ? dynamic : Object.keys(CORPUS_ASSETS);
}

async function syncCorpus(corpusId, root, onProgress) {
  const dataUrl = _deps.config.dataBaseUrl;
  const sub = await root.getDirectoryHandle(corpusId, { create: true });

  // Fetch meta first; the shard lists tell us what else to pull.
  const metaText = await fetchText(`${dataUrl}${corpusId}/meta.json`);
  await writeFile(sub, 'meta.json', metaText);
  onProgress?.(`${corpusId}/meta.json`);
  const meta = JSON.parse(metaText);

  // Static assets (those that always exist for this corpus).
  const baseAssets = CORPUS_ASSETS[corpusId] || ['meta.json', 'manifest.json'];
  for (const asset of baseAssets) {
    if (asset === 'meta.json') continue;   // already written
    try {
      const content = await fetchText(`${dataUrl}${corpusId}/${asset}`);
      await writeFile(sub, asset, content);
      onProgress?.(`${corpusId}/${asset}`);
    } catch (e) {
      // Some assets may not exist for a given corpus yet (e.g. audit.json
      // for a brand-new mirror). Skip with a warn — don't fail the sync.
      console.warn(`[disk-sync] skipped ${corpusId}/${asset}: ${e.message}`);
    }
  }

  // Sharded search-bundle / search-index, listed in meta.
  const shardLists = [
    ...(meta.search_bundle?.shards || []),
    ...(meta.search_index?.shards  || []),
  ];
  for (const shard of shardLists) {
    const content = await fetchText(`${dataUrl}${corpusId}/${shard}`);
    await writeFile(sub, shard, content);
    onProgress?.(`${corpusId}/${shard}`);
  }

  // Bills has a sharded index-NN.json on top of the bundle/index.
  if (corpusId === 'bills') {
    try {
      const indexMetaText = await fetchText(`${dataUrl}${corpusId}/index-meta.json`);
      const indexMeta = JSON.parse(indexMetaText);
      const shards = indexMeta?.shards || [];
      // index-meta.json may list shard names directly or as objects with .name
      const shardNames = shards.map(s => typeof s === 'string' ? s : s?.name).filter(Boolean);
      for (const shard of shardNames) {
        const content = await fetchText(`${dataUrl}${corpusId}/${shard}`);
        await writeFile(sub, shard, content);
        onProgress?.(`${corpusId}/${shard}`);
      }
    } catch (e) {
      console.warn(`[disk-sync] bills index-* sharding skipped: ${e.message}`);
    }
  }
}

async function fullSync(onProgress) {
  if (!_dirHandle) throw new Error('No folder connected');
  _syncing = true;
  notify();
  try {
    for (const id of corpusIds()) {
      await syncCorpus(id, _dirHandle, onProgress);
    }
    _lastSyncAt = Date.now();
  } finally {
    _syncing = false;
    notify();
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export function getDiskSyncState() {
  return {
    state:      _state,
    supported:  isSupported,
    syncing:    _syncing,
    lastSyncAt: _lastSyncAt,
  };
}

export function onDiskSyncChange(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

export async function initDiskSync(deps) {
  _deps = deps;
  if (!isSupported) {
    _state = 'unsupported';
    notify();
    return getDiskSyncState();
  }

  try {
    const stored = await idbGet('blobs', HANDLE_KEY);
    if (!stored) {
      _state = 'unsaved';
      notify();
      return getDiskSyncState();
    }
    // queryPermission is callable silently (no user gesture needed).
    let perm = 'denied';
    try {
      perm = await stored.queryPermission({ mode: 'readwrite' });
    } catch (e) {
      // Handle is invalid (folder moved/deleted, or stored under a
      // different origin's quota — rare but observed). Wipe and restart.
      console.warn('[disk-sync] handle queryPermission threw — wiping', e);
      await idbPut('blobs', HANDLE_KEY, null);
      _state = 'unsaved';
      notify();
      return getDiskSyncState();
    }
    if (perm === 'granted') {
      _dirHandle = stored;
      _state     = 'connected';
    } else if (perm === 'prompt') {
      _dirHandle = stored;   // keep so reconnect() can request without re-picking
      _state     = 'reconnect-needed';
    } else {
      // denied — wipe; user has to re-pick.
      await idbPut('blobs', HANDLE_KEY, null);
      _state = 'unsaved';
    }
  } catch (e) {
    console.warn('[disk-sync] init error', e);
    _state = 'unsaved';
  }
  notify();
  return getDiskSyncState();
}

/** First-time pick. Opens the folder picker, saves the handle, runs the
 *  initial snapshot sync. Must be called from a user gesture. */
export async function connectAndSync(onProgress) {
  if (!isSupported) throw new Error('File System Access API not supported in this browser');
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  _dirHandle = handle;
  _state     = 'connected';
  await idbPut('blobs', HANDLE_KEY, handle);
  notify();
  await fullSync(onProgress);
  return getDiskSyncState();
}

/** Re-grant permission on the previously-stored handle. Must be called
 *  from a user gesture. */
export async function reconnect() {
  if (!_dirHandle) return getDiskSyncState();
  const perm = await _dirHandle.requestPermission({ mode: 'readwrite' });
  if (perm === 'granted') {
    _state = 'connected';
  } else {
    _state = 'reconnect-needed';
  }
  notify();
  return getDiskSyncState();
}

/** Manual sync — re-writes Tier A from CF to disk. */
export async function syncNow(onProgress) {
  if (_state !== 'connected') throw new Error(`Cannot sync in state: ${_state}`);
  await fullSync(onProgress);
  return getDiskSyncState();
}

/** Forget the folder — clears handle from IDB, returns to unsaved state.
 *  Doesn't touch the user's actual folder on disk; it just stops syncing. */
export async function disconnect() {
  _dirHandle = null;
  _lastSyncAt = null;
  await idbPut('blobs', HANDLE_KEY, null);
  _state = isSupported ? 'unsaved' : 'unsupported';
  notify();
  return getDiskSyncState();
}
