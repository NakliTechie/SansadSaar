// app/global-search.js
// Cross-corpus search modal — Cmd+K (or Ctrl+K) opens a unified search
// input that fans out to every loaded corpus's `api.searchForGlobal`,
// merges results grouped by corpus, and lets the user click (or keyboard-
// navigate) to jump straight to the matching report's dialog.
//
// Why this lives in the shell:
//   • Each corpus continues to own its own in-corpus search (the filter
//     row at the top of its list). That's the "search within this corpus"
//     path and isn't going away.
//   • Cross-corpus search is a separate UX — global hotkey + modal — so
//     the user doesn't have to switch corpora to find what they want.
//     It's a discovery affordance, not a primary one.
//
// Contract with corpus modules:
//   Every registered corpus exposes `api.searchForGlobal(query, opts) →
//   Promise<[{key, title, subtitle}]>`. The shell calls them all in
//   parallel; each corpus knows its own per-item formatting.

import { escapeHtml, debounce } from './deps.js';
import { highlightMatches, parseQuery } from './corpus-search.js';

let _deps     = null;
let _corpora  = null;          // Map<id, corpus>
let _activate = null;          // shell's activate(corpusId)
let _state    = {
  open:        false,
  query:       '',
  searching:   false,
  results:     [],             // [{corpusId, label, shortLabel, hits}]
  activeIndex: -1,             // flat index across all groups for ↑↓ nav
};

function flatHits() {
  // Flat array of (groupIdx, hitIdx, hit, corpusId) for keyboard nav.
  const out = [];
  for (let g = 0; g < _state.results.length; g++) {
    const grp = _state.results[g];
    for (let h = 0; h < grp.hits.length; h++) {
      out.push({ g, h, corpusId: grp.corpusId, hit: grp.hits[h] });
    }
  }
  return out;
}

function renderResults() {
  const root = document.getElementById('globalSearchResults');
  if (!root) return;

  if (!_state.query.trim()) {
    root.innerHTML = `<p class="global-search-empty">Type a query to search across every loaded corpus.</p>`;
    return;
  }
  if (_state.searching && !_state.results.length) {
    root.innerHTML = `<p class="global-search-empty">Searching…</p>`;
    return;
  }
  const total = _state.results.reduce((n, g) => n + g.hits.length, 0);
  if (!total) {
    root.innerHTML = `<p class="global-search-empty">No matches across DRSC + CAG + Bills.</p>`;
    return;
  }

  const parsedQ = parseQuery(_state.query);
  const flat    = flatHits();
  const html    = [];
  let runningIdx = 0;
  for (const grp of _state.results) {
    if (!grp.hits.length) continue;
    html.push(`
      <div class="global-search-group">
        <div class="global-search-group-head">
          <span class="label">${escapeHtml(grp.label)}</span>
          <span>${grp.hits.length} hit${grp.hits.length === 1 ? '' : 's'}</span>
        </div>
    `);
    for (const hit of grp.hits) {
      const isActive = runningIdx === _state.activeIndex;
      html.push(`
        <div class="global-search-hit${isActive ? ' active' : ''}"
             data-corpus="${escapeHtml(grp.corpusId)}"
             data-key="${escapeHtml(hit.key)}"
             data-idx="${runningIdx}">
          <div class="hit-title">${highlightMatches(hit.title, parsedQ)}</div>
          ${hit.subtitle ? `<div class="hit-meta">${highlightMatches(hit.subtitle, parsedQ)}</div>` : ''}
        </div>
      `);
      runningIdx++;
    }
    html.push(`</div>`);
  }
  root.innerHTML = html.join('');

  // Wire click handlers
  root.querySelectorAll('.global-search-hit').forEach(el => {
    el.addEventListener('click', () => {
      openHit(parseInt(el.dataset.idx, 10), flat);
    });
  });

  // Scroll the active hit into view if it isn't.
  const active = root.querySelector('.global-search-hit.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

async function runQuery(raw) {
  _state.query = raw;
  _state.activeIndex = -1;
  if (!raw.trim()) {
    _state.results = [];
    _state.searching = false;
    renderResults();
    return;
  }
  _state.searching = true;
  renderResults();

  // Fan out to every corpus that exposes searchForGlobal. Run in parallel.
  const corpora = [..._corpora.values()].filter(c => c.api?.searchForGlobal);
  const promises = corpora.map(async (c) => {
    try {
      const hits = await c.api.searchForGlobal(raw, { limit: 10 });
      return { corpusId: c.id, label: c.label, shortLabel: c.shortLabel, hits: hits || [] };
    } catch (e) {
      console.warn(`[global-search] ${c.id} search failed:`, e);
      return { corpusId: c.id, label: c.label, shortLabel: c.shortLabel, hits: [] };
    }
  });
  _state.results = await Promise.all(promises);
  // If the user has typed more since we kicked this off, our results are
  // stale — bail rather than render outdated hits.
  if (_state.query !== raw) return;
  _state.searching = false;
  renderResults();
}

const _debouncedRun = debounce((q) => runQuery(q), 180);

function openHit(idx, flat) {
  flat = flat || flatHits();
  if (idx < 0 || idx >= flat.length) return;
  const { corpusId, hit } = flat[idx];
  close();
  // activate handles the chip-switch + corpus boot if not already active;
  // we then call api.open(hit.key) once the activate has resolved.
  _activate(corpusId).then(() => {
    const c = _corpora.get(corpusId);
    if (c?.api?.open) c.api.open(hit.key);
  });
}

function navigate(delta) {
  const flat = flatHits();
  if (!flat.length) return;
  let next = _state.activeIndex + delta;
  if (next < 0) next = flat.length - 1;
  if (next >= flat.length) next = 0;
  _state.activeIndex = next;
  renderResults();
}

export function open() {
  const modal = document.getElementById('globalSearchModal');
  const input = document.getElementById('globalSearchInput');
  if (!modal || !input) return;
  _state.open = true;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  // Defer focus to after the open class settles — Chrome occasionally
  // misses focus if assigned before the modal becomes visible.
  setTimeout(() => input.focus(), 30);
  // Re-render against whatever's already in the box (e.g. user opened
  // the modal, closed it, reopened it — preserve the query).
  if (input.value !== _state.query) input.value = _state.query;
  renderResults();
}

export function close() {
  const modal = document.getElementById('globalSearchModal');
  if (!modal) return;
  _state.open = false;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

export function initGlobalSearch({ deps, corpora, activate }) {
  _deps     = deps;
  _corpora  = corpora;
  _activate = activate;

  const btn   = document.getElementById('globalSearchBtn');
  const input = document.getElementById('globalSearchInput');
  const closeBtn = document.getElementById('globalSearchCloseBtn');
  const modal = document.getElementById('globalSearchModal');

  if (btn)      btn.addEventListener('click', open);
  if (closeBtn) closeBtn.addEventListener('click', close);

  // Backdrop click closes the modal (same pattern as other modals).
  if (modal) modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });

  if (input) {
    input.addEventListener('input', (e) => _debouncedRun(e.target.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); navigate(1); }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); navigate(-1); }
      else if (e.key === 'Enter') {
        if (_state.activeIndex >= 0) {
          e.preventDefault();
          openHit(_state.activeIndex);
        } else {
          // Enter without highlight = jump to first hit if any
          const flat = flatHits();
          if (flat.length) openHit(0, flat);
        }
      }
    });
  }

  // Global hotkey: Cmd+K / Ctrl+K opens the modal; Esc closes when open.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      open();
      return;
    }
    if (e.key === 'Escape' && _state.open) {
      e.preventDefault();
      close();
    }
  });
}
