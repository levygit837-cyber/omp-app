/** A run of code text with the kind of token it belongs to (null: plain). */
export interface HighlightSpan {
  text: string;
  kind: HighlightKind | null;
}

/**
 * Color is rare in this design, so highlight.js scopes collapse to four kinds that differ by
 * luminance and weight only (see .ui-hl-* in components.css). Everything else stays plain.
 */
export type HighlightKind = "keyword" | "string" | "number" | "comment";

const KINDS: Readonly<Record<string, HighlightKind>> = {
  keyword: "keyword",
  built_in: "keyword",
  type: "keyword",
  literal: "keyword",
  "selector-tag": "keyword",
  section: "keyword",
  doctag: "keyword",
  string: "string",
  regexp: "string",
  symbol: "string",
  "template-string": "string",
  number: "number",
  comment: "comment",
  quote: "comment",
};

/** Maps the class list of a highlight.js node (`["hljs-keyword"]`) to a kind; null when it has none of ours. */
export function tokenKind(classNames: readonly string[]): HighlightKind | null {
  for (const name of classNames) {
    if (!name.startsWith("hljs-")) continue;
    const kind = KINDS[name.slice(5)];
    if (kind) return kind;
  }
  return null;
}

/** Joins neighbours of the same kind and drops empty runs, so React renders fewer elements. */
export function mergeSpans(spans: readonly HighlightSpan[]): HighlightSpan[] {
  const out: HighlightSpan[] = [];
  for (const span of spans) {
    if (span.text === "") continue;
    const last = out[out.length - 1];
    if (last && last.kind === span.kind) last.text += span.text;
    else out.push({ text: span.text, kind: span.kind });
  }
  return out;
}
