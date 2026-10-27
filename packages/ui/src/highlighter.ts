// Loaded lazily (dynamic import from highlight-loader.ts): lowlight and highlight.js core live in
// their own chunk, and each grammar below is a separate chunk fetched the first time it is needed.
import type { Element, Root, RootContent } from "hast";
import type { LanguageFn } from "highlight.js";
import { createLowlight } from "lowlight";
import { type HighlightSpan, mergeSpans, tokenKind } from "./highlight-spans";
import type { LanguageId } from "./languages";

type Loader = () => Promise<{ default: LanguageFn }>;

// Literal specifiers: the bundler can only split chunks for string-literal import().
const GRAMMARS: Readonly<Record<Exclude<LanguageId, "plaintext">, Loader>> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  go: () => import("highlight.js/lib/languages/go"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  php: () => import("highlight.js/lib/languages/php"),
  python: () => import("highlight.js/lib/languages/python"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scss: () => import("highlight.js/lib/languages/scss"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

const lowlight = createLowlight();

/** Registers the grammar with lowlight. Resolves once `highlight(id, …)` can run. */
export async function registerGrammar(id: LanguageId): Promise<void> {
  if (id === "plaintext" || lowlight.registered(id)) return;
  const mod = await GRAMMARS[id]();
  lowlight.register(id, mod.default);
}

function walk(
  node: RootContent | Element,
  inherited: HighlightSpan["kind"],
  out: HighlightSpan[],
): void {
  if (node.type === "text") {
    out.push({ text: node.value, kind: inherited });
  } else if (node.type === "element") {
    const own = tokenKind((node.properties?.className as string[] | undefined) ?? []);
    for (const child of node.children) walk(child, own ?? inherited, out);
  }
}

/** Highlights `code` with an already registered grammar. Throws if the grammar is not registered. */
export function highlight(id: LanguageId, code: string): HighlightSpan[] {
  const tree: Root = lowlight.highlight(id, code);
  const out: HighlightSpan[] = [];
  for (const child of tree.children) walk(child, null, out);
  return mergeSpans(out);
}
