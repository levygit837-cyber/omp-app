import { marked, type Token, type Tokens } from "marked";

export interface Block {
  /** Position among the kept blocks: a stable key, because blocks only ever append during streaming. */
  index: number;
  token: Token;
  raw: string;
}

/**
 * Lexes the text into top-level blocks. The lexer is a single pass, O(total length) per call, so a
 * streamed message costs O(n) lexing per delta (O(n²) over the whole stream). Measured with
 * marked 18.1.2 on Bun 1.4, prose with lists and code fences: 5 kB 1.0 ms, 20 kB 2.4 ms, 100 kB
 * 12.7 ms per lex. A frame is 16.7 ms, so a reply of about 100 kB is where this needs a bound
 * (lex only the open tail); real replies are a few kB. Rendering is what we keep O(last block): each block is memoised on its raw text.
 * `space` and `def` (link reference definitions) tokens draw nothing and are dropped.
 */
export function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const token of marked.lexer(text)) {
    if (token.type === "space" || token.type === "def") continue;
    blocks.push({ index: blocks.length, token, raw: token.raw });
  }
  return blocks;
}

/**
 * True when a fenced code token still lacks its closing fence (the model is mid-block). Indented
 * code has no fence and is never open. marked accepts an unclosed fence as code to the end of text.
 */
export function isOpenFence(raw: string): boolean {
  const lines = raw.replace(/\s+$/, "").split("\n");
  const first = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? "");
  if (!first) return false;
  if (lines.length < 2) return true;
  const fence = first[1] ?? "";
  const last = (lines[lines.length - 1] ?? "").trim();
  return !(last.length >= fence.length && last === (fence[0] ?? "").repeat(last.length));
}

export interface ListMarker {
  /** Glyph drawn in the margin. */
  glyph: string;
  /** Screen reader text for task items; null for plain items. */
  label: string | null;
}

/** The margin marker of a list item: en dash, its number, or a ring/dot for task items (never a checkbox). */
export function listMarker(list: Tokens.List, item: Tokens.ListItem, index: number): ListMarker {
  if (item.task)
    return item.checked ? { glyph: "●", label: "done" } : { glyph: "○", label: "to do" };
  if (list.ordered)
    return { glyph: `${(typeof list.start === "number" ? list.start : 1) + index}.`, label: null };
  return { glyph: "–", label: null };
}

/** h1 and h2 take the title size; deeper levels stay at body size, so no jump is larger than one step. */
export function headingSize(depth: number): "lg" | "body" {
  return depth <= 2 ? "lg" : "body";
}
