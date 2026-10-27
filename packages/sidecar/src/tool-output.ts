/**
 * Distills omp's raw tool arguments and results into the small, wire-safe `ToolOutput` shapes of
 * the view model. Pure: no I/O, no clock. Every shape below was read from the pinned omp
 * (commit 0b5c27ab24, `packages/tui/src/tools/*` and `packages/coding-agent/src/**`); the ones
 * a recorded fixture covers say so, the others are tagged `[S]` (read in the type, never
 * recorded) and are unit-tested with hand-built values.
 *
 * Caps keep a `session.op` small: a read of a 10 MB file or a build log never crosses the wire.
 */
import type {
  DiffRow,
  FileDiff,
  ListEntry,
  MatchFile,
  SubagentRow,
  TodoPhase,
  TodoTask,
  ToolOutput,
} from "@omp-app/protocol";

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Rows of one file's diff kept on the wire; the rest is counted in `rowsOmitted`. */
export const MAX_DIFF_ROWS = 160;
/** Lines of command or plain output kept (the tail). */
export const MAX_SHELL_LINES = 12;
export const MAX_TEXT_LINES = 12;
export const MAX_LINE_CHARS = 240;
export const MAX_PATHS = 40;
export const MAX_MATCH_FILES = 12;
export const MAX_MATCHES_PER_FILE = 4;
export const MAX_LIST_ENTRIES = 12;
const MAX_TARGET_CHARS = 200;
const MAX_ERROR_CHARS = 200;

export interface ToolResult {
  readonly text: string;
  readonly details: Record<string, unknown>;
  readonly isError: boolean;
}

export interface Distilled {
  readonly output?: ToolOutput;
  readonly error?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Text of an omp tool result (`content` is a list of parts; image parts carry no text). */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  let text = "";
  for (const part of arr(content)) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") text += part.text;
  }
  return text;
}

/** Normalizes the result of `tool_execution_end` / a `partialResult`. */
export function toToolResult(result: unknown, isError: boolean): ToolResult {
  const r = isRecord(result) ? result : {};
  return {
    text: resultText(r.content),
    details: isRecord(r.details) ? r.details : {},
    isError,
  };
}

/** `[notes.txt#CE4F]` header of omp's hashline edit input. [V] fixtures/tools.jsonl, edit call. */
const HASHLINE_HEADER = /^\[([^\]#\n]+)#[0-9A-Fa-f]+\]/;

/**
 * The call's main argument, short. Argument names: `path` (read, write, edit via header),
 * `command` (bash), `pattern` (grep), `query` (web_search). [V] fixtures/{tools,search,failures}.jsonl
 */
export function toolTarget(tool: string, args: unknown): string | undefined {
  const a = isRecord(args) ? args : {};
  let target: string | undefined;
  switch (tool) {
    case "bash":
      target = str(a.command);
      break;
    case "grep":
      target = str(a.pattern);
      break;
    case "glob":
      target = str(a.pattern) ?? str(a.path);
      break;
    case "ast_grep":
      target = str(a.pat) ?? str(a.pattern);
      break;
    case "web_search":
      target = str(a.query);
      break;
    case "edit": {
      const input = str(a.input);
      target = str(a.path) ?? (input ? HASHLINE_HEADER.exec(input)?.[1] : undefined);
      break;
    }
    case "todo":
    case "task":
      target = undefined;
      break;
    default:
      target = str(a.path) ?? str(a.file_path) ?? str(a.command) ?? str(a.query) ?? str(a.url);
  }
  return target === undefined ? undefined : clip(target.split("\n")[0] ?? target, MAX_TARGET_CHARS);
}

// -- Diffs -------------------------------------------------------------------------------------

/** `+12|text`, `-12|text`, ` 12|text`. [V] fixtures/tools.jsonl (tool_stream_update and edit result). */
const DIFF_ROW = /^([+\- ])\s*(\d+)\|(.*)$/;

/**
 * Parses omp's numbered diff. It is not a unified diff: every row carries one line number, the
 * old one on `-`, the new one on `+`. A context row's number is taken as both [I]: the fixture
 * only has context rows before the first change, where the two agree.
 * Rows that match nothing (omp's `...` gap markers, `@@` headers) become `skip` rows.
 */
export function parseOmpDiff(diff: string): { rows: DiffRow[]; added: number; removed: number } {
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  for (const raw of diff.split("\n")) {
    if (raw === "") continue;
    const m = DIFF_ROW.exec(raw);
    if (!m) {
      if (raw.startsWith("@@")) continue;
      if (rows.at(-1)?.kind !== "skip") rows.push({ kind: "skip", text: "" });
      continue;
    }
    const line = Number(m[2]);
    const text = clip(m[3] ?? "", MAX_LINE_CHARS);
    if (m[1] === "+") {
      added++;
      rows.push({ kind: "add", newLine: line, text });
    } else if (m[1] === "-") {
      removed++;
      rows.push({ kind: "remove", oldLine: line, text });
    } else {
      rows.push({ kind: "context", oldLine: line, newLine: line, text });
    }
  }
  return { rows, added, removed };
}

/** Keeps the first `MAX_DIFF_ROWS` rows, but never fewer changed rows than context rows would crowd out. */
function capRows(rows: DiffRow[]): { rows: DiffRow[]; omitted: number } {
  if (rows.length <= MAX_DIFF_ROWS) return { rows, omitted: 0 };
  return { rows: rows.slice(0, MAX_DIFF_ROWS), omitted: rows.length - MAX_DIFF_ROWS };
}

function fileDiff(path: string, op: FileDiff["op"], diff: string, movedFrom?: string): FileDiff {
  const parsed = parseOmpDiff(diff);
  const { rows, omitted } = capRows(parsed.rows);
  return {
    path,
    op,
    ...(movedFrom === undefined ? {} : { movedFrom }),
    added: parsed.added,
    removed: parsed.removed,
    rows,
    rowsOmitted: omitted,
  };
}

function editOp(op: unknown, moved: boolean): FileDiff["op"] {
  if (moved) return "move";
  return op === "create" || op === "delete" || op === "update" ? op : "update";
}

/** Live preview of an edit, from `tool_stream_update` (`update.files`). [V] fixtures/tools.jsonl */
export function diffFromStreamUpdate(update: unknown): ToolOutput | undefined {
  const files = arr(isRecord(update) ? update.files : undefined)
    .filter(isRecord)
    .flatMap((f) => {
      const path = str(f.path);
      return path === undefined ? [] : [fileDiff(path, editOp(f.op, false), str(f.diff) ?? "")];
    });
  return files.length === 0 ? undefined : { kind: "diff", files };
}

function editDiff(details: Record<string, unknown>): ToolOutput | undefined {
  const per = arr(details.perFileResults).filter(isRecord);
  const sources = per.length > 0 ? per : [details];
  const files: FileDiff[] = [];
  for (const f of sources) {
    const path = str(f.path);
    if (path === undefined || f.isError === true) continue;
    const moved = str(f.sourcePath);
    files.push(fileDiff(path, editOp(f.op, moved !== undefined), str(f.diff) ?? "", moved));
  }
  return files.length === 0 ? undefined : { kind: "diff", files };
}

/**
 * `write` has no diff in its result, only the path; the content is in the call's arguments, so
 * the whole file is shown as added rows. [V] fixtures/tools.jsonl: args `{path, content}`, result
 * details `{resolvedPath}`.
 */
export function writeOutput(args: unknown): ToolOutput | undefined {
  const a = isRecord(args) ? args : {};
  const path = str(a.path);
  // `xd://` paths are tool devices (`xd://ast_edit`, `xd://reject`), not files. [V] fixtures/search.jsonl
  if (path === undefined || path.startsWith("xd://")) return undefined;
  const content = typeof a.content === "string" ? a.content : "";
  const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  const rows: DiffRow[] = lines
    .slice(0, MAX_DIFF_ROWS)
    .map((text, i) => ({ kind: "add", newLine: i + 1, text: clip(text, MAX_LINE_CHARS) }));
  return {
    kind: "diff",
    files: [
      {
        path,
        op: "write",
        added: lines.length,
        removed: 0,
        rows,
        rowsOmitted: Math.max(0, lines.length - MAX_DIFF_ROWS),
      },
    ],
  };
}

// -- Shell, text -------------------------------------------------------------------------------

const EXIT_TRAILER = /\n*Command exited with code (\d+)\s*$/;

function tail(text: string, max: number): { lines: string[]; omitted: number } {
  const all = text.replace(/\s+$/, "").split("\n");
  if (all.length === 1 && all[0] === "") return { lines: [], omitted: 0 };
  const kept = all.slice(-max).map((l) => clip(l, MAX_LINE_CHARS));
  return { lines: kept, omitted: all.length - kept.length };
}

/**
 * Output of a shell call. `exitCode`, `wallTimeMs` and `timedOut` come from `details`; a running
 * call has none of them yet. [V] fixtures/failures.jsonl: failed text ends with
 * `Command exited with code 3`, which is dropped because `exitCode` says it.
 */
export function shellOutput(r: ToolResult): ToolOutput {
  const { lines, omitted } = tail(r.text.replace(EXIT_TRAILER, ""), MAX_SHELL_LINES);
  const exitCode = num(r.details.exitCode);
  const wallTimeMs = num(r.details.wallTimeMs);
  return {
    kind: "shell",
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(r.details.timedOut === true ? { timedOut: true } : {}),
    ...(wallTimeMs === undefined ? {} : { wallTimeMs: Math.round(wallTimeMs) }),
    lines,
    linesOmitted: omitted,
  };
}

function textOutput(text: string): ToolOutput | undefined {
  const { lines, omitted } = tail(text, MAX_TEXT_LINES);
  return lines.length === 0
    ? undefined
    : { kind: "text", text: lines.join("\n"), linesOmitted: omitted };
}

// -- Search ------------------------------------------------------------------------------------

/**
 * Parses the `displayContent` of `grep` / `ast_grep`:
 *
 *   # README.md#AA70          file at the root
 *   *1│retry policy: none
 *   # src/                    directory ...
 *   ## clock.ts#4F53          ... and its file
 *    1│export const now = ...   context row
 *   *2│// retry later          match row (`*`)
 *
 * [V] fixtures/search.jsonl (grep). `ast_grep` shares the renderer's gutter [S]
 * (`packages/tui/src/tools/ast-grep.ts:37`).
 */
export function parseMatchDisplay(display: string): Map<string, { line: number; text: string }[]> {
  const files = new Map<string, { line: number; text: string }[]>();
  let dir = "";
  let current: { line: number; text: string }[] | undefined;
  for (const raw of display.split("\n")) {
    const header = /^(#{1,2}) (.+?)(?:#[0-9A-Fa-f]+)?$/.exec(raw);
    if (header) {
      const name = header[2] ?? "";
      if (header[1] === "#" && name.endsWith("/")) {
        dir = name;
        current = undefined;
        continue;
      }
      const path = header[1] === "##" ? `${dir}${name}` : name;
      if (header[1] === "#") dir = "";
      current = files.get(path) ?? [];
      files.set(path, current);
      continue;
    }
    const row = /^([* ])\s*(\d+)│(.*)$/.exec(raw);
    if (row && current && row[1] === "*") {
      current.push({ line: Number(row[2]), text: clip((row[3] ?? "").trim(), MAX_LINE_CHARS) });
    }
  }
  return files;
}

function matchesOutput(details: Record<string, unknown>): ToolOutput | undefined {
  const matchCount = num(details.matchCount);
  const fileCount = num(details.fileCount);
  if (matchCount === undefined || fileCount === undefined) return undefined;
  const lines = parseMatchDisplay(str(details.displayContent) ?? "");
  const counts = arr(details.fileMatches)
    .filter(isRecord)
    .flatMap((f) =>
      str(f.path) !== undefined && num(f.count) !== undefined
        ? [[f.path as string, f.count as number] as const]
        : [],
    );
  const paths =
    counts.length > 0
      ? counts
      : [...lines.keys()].map((p) => [p, lines.get(p)?.length ?? 0] as const);
  const files: MatchFile[] = paths.slice(0, MAX_MATCH_FILES).map(([path, count]) => ({
    path,
    count,
    lines: (lines.get(path) ?? []).slice(0, MAX_MATCHES_PER_FILE),
  }));
  return {
    kind: "matches",
    matchCount,
    fileCount,
    files,
    filesOmitted: Math.max(0, fileCount - files.length),
  };
}

// -- Per tool ----------------------------------------------------------------------------------

function todoPhases(details: Record<string, unknown>): TodoPhase[] | undefined {
  if (!Array.isArray(details.phases)) return undefined;
  const phases: TodoPhase[] = [];
  for (const p of details.phases) {
    if (!isRecord(p) || typeof p.name !== "string") continue;
    const tasks: TodoTask[] = [];
    for (const t of arr(p.tasks)) {
      if (isRecord(t) && typeof t.content === "string" && typeof t.status === "string") {
        tasks.push({ content: t.content, status: t.status as TodoTask["status"] });
      }
    }
    phases.push({ name: p.name, tasks });
  }
  return phases;
}

/** `{done, total}` over every task of every phase. */
export function todoCounts(phases: readonly TodoPhase[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      total++;
      if (task.status === "completed") done++;
    }
  }
  return { done, total };
}

/** The phases the `todo` tool left, from its result details. [V] fixtures/todo.jsonl */
export function todoFromResult(r: ToolResult): TodoPhase[] | undefined {
  return todoPhases(r.details);
}

function subagents(details: Record<string, unknown>): ToolOutput | undefined {
  // `progress` is live (also in the final result of an async run); `results` is settled. [S]
  // packages/tui/src/tools/task.ts:2338 (AgentProgress), :2447 (SingleResult), :2543 (TaskToolDetails)
  const rows: SubagentRow[] = [];
  const settled = arr(details.results).filter(isRecord);
  const progress = arr(details.progress).filter(isRecord);
  for (const p of progress) {
    const id = str(p.id);
    if (id === undefined) continue;
    const done = settled.find((s) => s.id === id);
    const status = done
      ? done.aborted === true
        ? "aborted"
        : num(done.exitCode) === 0 && !done.error
          ? "completed"
          : "failed"
      : ((str(p.status) as SubagentRow["status"] | undefined) ?? "running");
    const durationMs = num(done?.durationMs) ?? num(p.durationMs);
    const tokens = num(done?.tokens) ?? num(p.tokens);
    rows.push({
      id,
      agent: str(p.agent) ?? "task",
      description: clip(str(p.description) ?? str(p.task) ?? "", MAX_LINE_CHARS),
      status,
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(tokens === undefined ? {} : { tokens }),
    });
  }
  if (rows.length === 0) {
    for (const s of settled) {
      const id = str(s.id);
      if (id === undefined) continue;
      const durationMs = num(s.durationMs);
      const tokens = num(s.tokens);
      rows.push({
        id,
        agent: str(s.agent) ?? "task",
        description: clip(str(s.description) ?? str(s.task) ?? "", MAX_LINE_CHARS),
        status:
          s.aborted === true
            ? "aborted"
            : num(s.exitCode) === 0 && !s.error
              ? "completed"
              : "failed",
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(tokens === undefined ? {} : { tokens }),
      });
    }
  }
  if (rows.length === 0) return undefined;
  const total = num(details.totalDurationMs);
  return { kind: "subagents", agents: rows, ...(total === undefined ? {} : { durationMs: total }) };
}

function webSearch(details: Record<string, unknown>): ToolOutput | undefined {
  // [S] packages/coding-agent/src/web/search/index.ts:333 (`details.response.sources`);
  // SearchSource at packages/tui/src/tools/web-search-types.ts:51.
  const response = isRecord(details.response) ? details.response : {};
  const sources = arr(response.sources).filter(isRecord);
  if (sources.length === 0) return undefined;
  const entries: ListEntry[] = sources.slice(0, MAX_LIST_ENTRIES).map((s) => {
    const url = str(s.url);
    return {
      title: clip(str(s.title) ?? url ?? "", MAX_LINE_CHARS),
      ...(url === undefined ? {} : { note: clip(url.replace(/^https?:\/\//, ""), MAX_LINE_CHARS) }),
    };
  });
  return { kind: "list", entries, total: sources.length };
}

function askAnswer(details: Record<string, unknown>): ToolOutput | undefined {
  // [S] packages/tui/src/tools/ask.ts:45 (AskToolDetails)
  const chosen = arr(details.selectedOptions).filter((o): o is string => typeof o === "string");
  const custom = str(details.customInput);
  if (custom !== undefined) chosen.push(custom);
  if (chosen.length === 0) return undefined;
  return {
    kind: "list",
    entries: chosen.map((title) => ({ title: clip(title, MAX_LINE_CHARS) })),
    total: chosen.length,
  };
}

function paths(tool: string, r: ToolResult, target: string | undefined): ToolOutput | undefined {
  if (tool === "glob") {
    const files = arr(r.details.files).filter((f): f is string => typeof f === "string");
    if (files.length === 0 && r.isError) return undefined;
    return {
      kind: "paths",
      count: num(r.details.fileCount) ?? files.length,
      paths: files.slice(0, MAX_PATHS),
    };
  }
  // read. [V] fixtures/tools.jsonl: details `{totalLines, ...}`; isDirectory [S] read.ts:57
  const path = target ?? str(r.details.resolvedPath);
  if (r.details.isDirectory === true) {
    const entries = r.text.split("\n").filter((l) => l.trim() !== "");
    return {
      kind: "paths",
      count: entries.length,
      paths: entries.slice(0, MAX_PATHS),
      directory: true,
    };
  }
  if (path === undefined) return undefined;
  const lines = num(r.details.totalLines);
  return { kind: "paths", count: 1, paths: [path], ...(lines === undefined ? {} : { lines }) };
}

/** First line of a failure, as omp wrote it, without an `Error:` prefix. */
export function errorLine(text: string): string {
  const first = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return clip(first.replace(/^Error:\s*/i, "").trim(), MAX_ERROR_CHARS);
}

/**
 * What a call shows once it ended. `target` is the call's main argument (`toolTarget`), which
 * `tool_execution_end` does not repeat. A failed call keeps the output of a shell command (the
 * tail is the reason) and drops the rest; its reason goes in `error`.
 */
export function distill(tool: string, r: ToolResult, target: string | undefined): Distilled {
  const failed = r.isError;
  const error = failed ? errorLine(r.text) || "failed" : undefined;
  const withError = (output: ToolOutput | undefined): Distilled => ({
    ...(output === undefined ? {} : { output }),
    ...(error === undefined ? {} : { error }),
  });
  switch (tool) {
    case "bash":
      return withError(shellOutput(r));
    case "read":
    case "glob":
      return failed ? withError(undefined) : withError(paths(tool, r, target));
    case "grep":
    case "ast_grep":
      return failed
        ? withError(undefined)
        : withError(matchesOutput(r.details) ?? textOutput(r.text));
    case "edit":
      return failed ? withError(undefined) : withError(editDiff(r.details));
    case "write":
      // The content is in the call's arguments, not in the result: the reducer keeps what the start showed.
      return withError(undefined);
    case "todo": {
      const phases = todoPhases(r.details);
      return failed || !phases
        ? withError(undefined)
        : withError({ kind: "todo", ...todoCounts(phases), phases });
    }
    case "task":
      return withError(subagents(r.details) ?? (failed ? undefined : textOutput(r.text)));
    case "web_search":
      return withError(failed ? undefined : (webSearch(r.details) ?? textOutput(r.text)));
    case "ask":
      return withError(failed ? undefined : askAnswer(r.details));
    default:
      return withError(failed ? undefined : textOutput(r.text));
  }
}
