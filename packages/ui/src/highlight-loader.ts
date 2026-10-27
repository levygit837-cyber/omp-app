import type { HighlightSpan } from "./highlight-spans";
import { type LanguageId, resolveLanguage } from "./languages";

/** Above either bound the block renders as plain text: highlighting is synchronous and would block a frame. */
export const MAX_HIGHLIGHT_LINES = 2000;
export const MAX_HIGHLIGHT_CHARS = 200_000;
export const LRU_SIZE = 64;

type Highlighter = typeof import("./highlighter");

let core: Promise<Highlighter> | null = null;
let coreReady: Highlighter | null = null;
const loading = new Map<LanguageId, Promise<void>>();
const ready = new Set<LanguageId>();
const failed = new Set<LanguageId>();

/** True when the code is small enough to highlight. */
export function canHighlight(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_CHARS) return false;
  let lines = 1;
  for (let i = code.indexOf("\n"); i !== -1; i = code.indexOf("\n", i + 1)) {
    if (++lines > MAX_HIGHLIGHT_LINES) return false;
  }
  return true;
}

/** Starts (once per language) loading lowlight and the grammar. Never rejects: a failure leaves the block plain. */
export function ensureGrammar(id: LanguageId): Promise<void> {
  if (id === "plaintext" || ready.has(id) || failed.has(id)) return Promise.resolve();
  let pending = loading.get(id);
  if (!pending) {
    core ??= import("./highlighter");
    pending = core
      .then(async (mod) => {
        await mod.registerGrammar(id);
        coreReady = mod;
        ready.add(id);
      })
      .catch(() => {
        failed.add(id);
        core = null; // a failed core chunk may be retried by another language
      })
      .finally(() => loading.delete(id));
    loading.set(id, pending);
  }
  return pending;
}

/** True when the grammar is loaded, so `highlightCached` can answer synchronously. */
export function isGrammarReady(id: LanguageId): boolean {
  return ready.has(id);
}

const lru = new Map<string, HighlightSpan[]>();

/** Highlights with the loaded grammar, memoised by (language, code) in a bounded LRU. Null when not possible. */
export function highlightCached(id: LanguageId, code: string): HighlightSpan[] | null {
  if (!coreReady || !ready.has(id)) return null;
  const key = `${id}\u0000${code}`;
  const hit = lru.get(key);
  if (hit) {
    lru.delete(key);
    lru.set(key, hit);
    return hit;
  }
  let spans: HighlightSpan[];
  try {
    spans = coreReady.highlight(id, code);
  } catch {
    return null;
  }
  lru.set(key, spans);
  if (lru.size > LRU_SIZE) {
    const oldest = lru.keys().next();
    if (!oldest.done) lru.delete(oldest.value);
  }
  return spans;
}

/** Resolves a fence info string and reports whether a real grammar exists for it. */
export function grammarFor(info: string | null | undefined): LanguageId | null {
  const id = resolveLanguage(info);
  return id === null || id === "plaintext" ? null : id;
}
