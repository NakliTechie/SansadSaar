// app/ai-streaming.js
// Shared streaming-AI persistence helper. Used by every corpus module to
// run a streaming AI call with the "decouple inflight from committed
// cache" semantics — partial output stays in a local buffer until we
// decide it's worth committing.
//
// Why this is a separate module:
//   • All current corpora (DRSC, CAG, Bills) and every future one will
//     have a summary tab + a chat tab that stream tokens from an AI
//     and persist the result to IDB + state.cache. The persistence
//     logic — when to commit, when to discard, when to keep the
//     previous good value — is non-trivial and identical across
//     corpora. The original cut had three subtle bugs that were silently
//     copy-pasted into each module (see CONV.md "Streaming AI
//     persistence pattern" for the full story).
//
//   • Per the spec, each corpus module owns its own *state* (state.cache
//     shape, key naming convention, prompt builder, system prompt).
//     What it should NOT own is the buffer-vs-commit decision logic —
//     that's where bugs lurk, and where one good implementation beats
//     three copy-pasted ones.
//
// Design contract: this module never touches `state.cache.<store>[key]`
// or IDB directly. It just runs the AI, manages the inflight buffer,
// and returns a decision. The caller persists per its own conventions.

/**
 * Run a streaming AI completion. Accumulates the streamed output in a
 * private inflight buffer; calls `onText(cumulativeSoFar)` after every
 * token so the caller can live-update the DOM; returns a structured
 * decision when the stream ends (cleanly or via error).
 *
 * @param {Object}   args
 * @param {Function} args.generate                Async fn: (messages, onToken) => Promise.
 *                                                The shell's deps.ai.generate.
 * @param {Array}    args.messages                Chat messages to send.
 * @param {Function} [args.onText]                Called with the cumulative inflight
 *                                                text after every token. The corpus
 *                                                module typically updates a DOM
 *                                                node here (gated by its own
 *                                                streamingContext check).
 * @param {number}   [args.substantialThreshold]  Minimum chars in inflight to count
 *                                                an error-interrupted stream as a
 *                                                "substantive partial" (i.e., worth
 *                                                committing). Default 100.
 *
 * @returns {Promise<{ok: true, text: string, partial: boolean} | {ok: false, error: Error}>}
 *
 *   ok: true   → there's something worth committing. `text` is the full
 *                successful output (partial: false) or a substantive
 *                partial + "[Error: ...]" suffix (partial: true). Caller
 *                should update state.cache and idbPut.
 *
 *   ok: false  → the stream errored before producing meaningful output.
 *                Caller should preserve the previous cached value and
 *                surface the error (toast, message, etc) without
 *                clobbering whatever was there.
 *
 * The caller is solely responsible for state.cache mutations, IDB writes,
 * UI re-rendering after completion, and clearing any streamingContext
 * flags. Keeping those out of this helper is intentional: each corpus has
 * its own conventions and we don't want to enforce them here.
 */
export async function streamWithPersistence({
  generate,
  messages,
  onText,
  substantialThreshold = 100,
}) {
  let inflight = '';
  try {
    await generate(messages, (tok) => {
      inflight += tok;
      if (onText) onText(inflight);
    });
    return { ok: true, text: inflight, partial: false };
  } catch (e) {
    if (inflight.length > substantialThreshold) {
      return {
        ok: true,
        text: inflight + '\n\n[Error: ' + e.message + ']',
        partial: true,
      };
    }
    return { ok: false, error: e };
  }
}
