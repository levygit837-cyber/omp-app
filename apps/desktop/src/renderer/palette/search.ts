/**
 * Fuzzy matching for the command palette. Pure: no DOM, no state.
 *
 * A match has a tier, and a tier always outranks the one below it, whatever the text:
 * name prefix, then a word start inside the name, then any substring, then a subsequence
 * (`cmpt` finds `compact`), and last a hit in the description. Inside a tier the earlier and
 * the shorter the text, the better.
 */

/** Half-open `[start, end)` ranges into the matched text, for drawing the hit heavier. */
export type Range = readonly [number, number];

export interface Match {
  readonly score: number;
  readonly ranges: readonly Range[];
}

const PREFIX = 1000;
const WORD_START = 800;
const SUBSTRING = 600;
const SUBSEQUENCE = 300;
/** A subsequence never falls under this, so the description tier (below) stays under it. */
const SUBSEQUENCE_FLOOR = 150;
const DESCRIPTION = 50;

/**
 * How `query` matches `text`, or null. Case-insensitive; the query is trimmed. An empty query
 * matches everything with score 0 and nothing to highlight.
 */
export function matchText(query: string, text: string): Match | null {
  const q = query.trim().toLowerCase();
  if (q === "") return { score: 0, ranges: [] };
  const t = text.toLowerCase();
  // A few letters change length when lowercased; positions would then point at other letters.
  const aligned = t.length === text.length;
  const hit = (start: number, end: number): readonly Range[] => (aligned ? [[start, end]] : []);

  if (t.startsWith(q)) {
    return { score: PREFIX - Math.min(t.length - q.length, 100), ranges: hit(0, q.length) };
  }
  for (let from = t.indexOf(q, 1); from !== -1; from = t.indexOf(q, from + 1)) {
    // A word starts after anything that is not a letter or a digit (`-`, `/`, space, `.`).
    if (!/[\p{L}\p{N}]/u.test(t[from - 1] ?? "")) {
      return { score: WORD_START - Math.min(from, 100), ranges: hit(from, from + q.length) };
    }
  }
  const at = t.indexOf(q);
  if (at !== -1) return { score: SUBSTRING - Math.min(at, 100), ranges: hit(at, at + q.length) };

  const positions: number[] = [];
  let from = 0;
  for (const ch of q) {
    const next = t.indexOf(ch, from);
    if (next === -1) return null;
    positions.push(next);
    from = next + ch.length;
  }
  const first = positions[0] ?? 0;
  const last = positions[positions.length - 1] ?? 0;
  const scatter = last - first - (q.length - 1);
  return {
    score: Math.max(SUBSEQUENCE_FLOOR, SUBSEQUENCE - scatter),
    ranges: aligned ? merge(positions) : [],
  };
}

/** Consecutive positions become one range. */
function merge(positions: readonly number[]): Range[] {
  const out: [number, number][] = [];
  for (const p of positions) {
    const tail = out[out.length - 1];
    if (tail && tail[1] === p) tail[1] = p + 1;
    else out.push([p, p + 1]);
  }
  return out;
}

/** What an item offers to be found by. */
export interface Searchable {
  readonly name: string;
  /** Other names that count as the name (a command's aliases). */
  readonly alt?: readonly string[];
  readonly description?: string;
}

export interface Ranked<T> {
  readonly item: T;
  readonly score: number;
  /** Where the query hit the name, for highlighting; empty when only an alias or the description matched. */
  readonly ranges: readonly Range[];
}

/**
 * The items that match, best first; equal scores keep their input order. With an empty query every
 * item stays, in order. A description hit counts for little: it ranks below every name hit.
 */
export function rank<T>(
  items: readonly T[],
  query: string,
  searchable: (item: T) => Searchable,
): Ranked<T>[] {
  const out: (Ranked<T> & { readonly order: number })[] = [];
  items.forEach((item, order) => {
    const s = searchable(item);
    const byName = matchText(query, s.name);
    const byAlias = (s.alt ?? []).map((alt) => matchText(query, alt));
    const best = [byName, ...byAlias].reduce<Match | null>(
      (a, b) => (b && (!a || b.score > a.score) ? b : a),
      null,
    );
    if (best) {
      out.push({ item, score: best.score, ranges: byName?.ranges ?? [], order });
      return;
    }
    const byDescription = s.description ? matchText(query, s.description) : null;
    if (byDescription) {
      // Tier first, then how good the hit was inside it (0 to 10).
      out.push({
        item,
        score: DESCRIPTION + Math.round(byDescription.score / 100),
        ranges: [],
        order,
      });
    }
  });
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out.map(({ item, score, ranges }) => ({ item, score, ranges }));
}

export interface Segment {
  readonly text: string;
  readonly hit: boolean;
}

/** `text` cut at the edges of `ranges` (sorted, not overlapping, as {@link matchText} makes them). */
export function segments(text: string, ranges: readonly Range[]): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) out.push({ text: text.slice(at, start), hit: false });
    out.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}
