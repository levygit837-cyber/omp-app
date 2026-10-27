/** highlight.js grammars we can load, by canonical name. `plaintext` means "no highlighting". */
export const LANGUAGE_IDS = [
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "diff",
  "dockerfile",
  "go",
  "ini",
  "java",
  "javascript",
  "json",
  "kotlin",
  "lua",
  "makefile",
  "markdown",
  "php",
  "plaintext",
  "python",
  "ruby",
  "rust",
  "scss",
  "sql",
  "swift",
  "typescript",
  "xml",
  "yaml",
] as const;

export type LanguageId = (typeof LANGUAGE_IDS)[number];

const ALIASES: Readonly<Record<string, LanguageId>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  javascript: "javascript",
  node: "javascript",
  json: "json",
  jsonc: "json",
  json5: "json",
  jsonl: "json",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  shellscript: "bash",
  zsh: "bash",
  console: "bash",
  python: "python",
  py: "python",
  python3: "python",
  rust: "rust",
  rs: "rust",
  go: "go",
  golang: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  csharp: "csharp",
  "c#": "csharp",
  cs: "csharp",
  css: "css",
  scss: "scss",
  html: "xml",
  htm: "xml",
  xhtml: "xml",
  xml: "xml",
  svg: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  markdown: "markdown",
  md: "markdown",
  diff: "diff",
  patch: "diff",
  sql: "sql",
  dockerfile: "dockerfile",
  docker: "dockerfile",
  makefile: "makefile",
  make: "makefile",
  mk: "makefile",
  kotlin: "kotlin",
  kt: "kotlin",
  swift: "swift",
  ruby: "ruby",
  rb: "ruby",
  php: "php",
  lua: "lua",
  text: "plaintext",
  txt: "plaintext",
  plain: "plaintext",
  plaintext: "plaintext",
  none: "plaintext",
};

export interface FenceInfo {
  /** First word of the info string, lowercased, with `language-` and a leading dot removed. */
  language: string | null;
  /** From `title="…"`, `filename=…` or `file=…` in the info string. */
  filename: string | null;
}

const ATTR = /\b(?:title|filename|file)=(?:"([^"]*)"|'([^']*)'|([^\s"'{}]+))/i;

/** Splits a fence info string (`ts`, `language-bash`, `bash title=x`, `ts {1,3}`) into language word and file name. */
export function parseFenceInfo(info: string | null | undefined): FenceInfo {
  const text = (info ?? "").trim();
  const attr = ATTR.exec(text);
  const filename = attr ? (attr[1] ?? attr[2] ?? attr[3] ?? null) : null;
  let word = text.split(/[\s{,]/, 1)[0] ?? "";
  if (word.includes("=")) word = "";
  word = word
    .toLowerCase()
    .replace(/^(?:language|lang)-/, "")
    .replace(/^\./, "");
  return { language: word === "" ? null : word, filename: filename === "" ? null : filename };
}

/** Maps a fence info string or language name to a loadable grammar, or null when unknown (render plain). */
export function resolveLanguage(info: string | null | undefined): LanguageId | null {
  const { language } = parseFenceInfo(info);
  if (language === null) return null;
  return Object.hasOwn(ALIASES, language) ? (ALIASES[language] ?? null) : null;
}
