/**
 * The rich timeline: everything the agent does, as plain data the renderer can draw without
 * knowing omp. The sidecar distills omp's events into these shapes (`tool-output.ts`, `reducer.ts`),
 * so the wire carries a few hundred bytes per tool call, never a file or a full command output.
 *
 * Times are milliseconds since the epoch, stamped by the sidecar's clock (an injected `now`, so
 * the reducer stays pure). A replica computes a running duration against its own clock; both run
 * on the same machine.
 */
import { isRecord } from "./guards";

// -- Tool calls --------------------------------------------------------------------------------

/**
 * `stopped`: the run ended (stop, crash) before the tool reported back. Not a failure of the
 * tool itself, so it has no red mark.
 */
export type ToolStatus = "running" | "done" | "failed" | "stopped";

/** One row of a numbered diff. Same shape as `DiffLine` in `@omp-app/ui`, which cannot import this package. */
export interface DiffRow {
  readonly kind: "add" | "remove" | "context" | "skip";
  /** Line number in the old file; absent on `add` and `skip`. */
  readonly oldLine?: number;
  /** Line number in the new file; absent on `remove` and `skip`. */
  readonly newLine?: number;
  readonly text: string;
}

export interface FileDiff {
  /** As the agent wrote it (relative to the session folder) or absolute when omp resolved it. */
  readonly path: string;
  /** `write`: the whole file was written (omp does not say whether it existed). */
  readonly op: "write" | "create" | "update" | "delete" | "move";
  /** Previous path of a moved file. */
  readonly movedFrom?: string;
  /** Lines added and removed over the WHOLE change, including rows left out of `rows`. */
  readonly added: number;
  readonly removed: number;
  readonly rows: readonly DiffRow[];
  /** Changed or context rows that did not fit in `rows`. */
  readonly rowsOmitted: number;
}

export interface MatchLine {
  readonly line: number;
  readonly text: string;
}

export interface MatchFile {
  readonly path: string;
  readonly count: number;
  /** A few of the matches (line number and trimmed text); may be shorter than `count`. */
  readonly lines: readonly MatchLine[];
}

export interface SubagentRow {
  readonly id: string;
  readonly agent: string;
  readonly description: string;
  readonly status: "pending" | "running" | "completed" | "failed" | "aborted";
  readonly durationMs?: number;
  readonly tokens?: number;
}

export interface ListEntry {
  readonly title: string;
  /** Source, status or any quiet continuation. */
  readonly note?: string;
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";

export interface TodoTask {
  readonly content: string;
  readonly status: TodoStatus;
}

export interface TodoPhase {
  readonly name: string;
  readonly tasks: readonly TodoTask[];
}

/** What a finished (or, for `shell`, still running) call has to show. Discriminated by `kind`. */
export type ToolOutput =
  | { readonly kind: "diff"; readonly files: readonly FileDiff[] }
  | {
      readonly kind: "shell";
      /** Exit code of a command that ran to the end; absent while running or when killed. */
      readonly exitCode?: number;
      readonly timedOut?: boolean;
      readonly wallTimeMs?: number;
      /** The last lines of output, newest last. */
      readonly lines: readonly string[];
      /** Lines above `lines` that were not kept. */
      readonly linesOmitted: number;
    }
  | {
      readonly kind: "matches";
      readonly matchCount: number;
      readonly fileCount: number;
      readonly files: readonly MatchFile[];
      /** Files beyond `files` that matched too. */
      readonly filesOmitted: number;
    }
  | {
      readonly kind: "paths";
      /** Total entries, which can exceed `paths.length`. */
      readonly count: number;
      readonly paths: readonly string[];
      /** Lines of a read, when the call was a read. */
      readonly lines?: number;
      readonly directory?: boolean;
    }
  | {
      readonly kind: "todo";
      readonly done: number;
      readonly total: number;
      readonly phases: readonly TodoPhase[];
    }
  | {
      readonly kind: "subagents";
      readonly agents: readonly SubagentRow[];
      readonly durationMs?: number;
    }
  | {
      readonly kind: "list";
      readonly entries: readonly ListEntry[];
      readonly total: number;
    }
  | {
      /** Plain output of a tool with no richer shape (also the reason of a failed call). */
      readonly kind: "text";
      readonly text: string;
      readonly linesOmitted: number;
    };

export interface ToolCall {
  readonly toolCallId: string;
  readonly status: ToolStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  /**
   * The call's main argument, short: the path of a read, the command of a shell call, the
   * pattern of a search, the query of a web search. Absent when the tool has none.
   */
  readonly target?: string;
  /**
   * What the call produced. Shown while `done`; a `failed` call shows `error` and, for `shell`
   * only, its output (the tail of a failing command is the reason).
   */
  readonly output?: ToolOutput;
  /** Why a `failed` call failed, in one line, as omp worded it. */
  readonly error?: string;
}

/**
 * One line of the timeline for a tool. Consecutive calls of the same tool with the same intent
 * share an item (`calls` has more than one entry): the design folds them into a single line.
 */
export interface ToolItem {
  readonly kind: "tool";
  readonly id: string;
  /** omp's tool name (`read`, `bash`, `mcp__linear_list_issues`, ...). */
  readonly tool: string;
  /** The 2 to 6 word sentence the agent wrote for the call, as written. */
  readonly intent?: string;
  readonly calls: readonly ToolCall[];
}

// -- Thinking, status events -------------------------------------------------------------------

export interface ThinkingItem {
  readonly kind: "thinking";
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly startedAt: number;
  readonly endedAt?: number;
  /** Tokens the provider reported for the reasoning so far; absent when it reports none until the end. */
  readonly tokens?: number;
}

export type CompactionState = "running" | "done" | "failed" | "skipped" | "aborted";

/** A boundary in the agent's memory: everything above was summarized. */
export interface CompactionItem {
  readonly kind: "compaction";
  readonly id: string;
  readonly state: CompactionState;
  /** Absent on a compaction rebuilt from a stored session: omp does not keep why it ran. */
  readonly reason?: "threshold" | "overflow" | "idle" | "incomplete";
  /** Absent when a stored session does not say how it ran (older omp). */
  readonly action?: "context-full" | "remote" | "handoff" | "shake" | "snapcompact";
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly tokensBefore?: number;
  /** omp's short summary of what was kept, when it wrote one. */
  readonly summary?: string;
  readonly error?: string;
  /** The agent carries on by itself after the compaction. */
  readonly willRetry?: boolean;
}

export type RetryState = "waiting" | "recovered" | "failed" | "cancelled";

/** The provider failed and omp tries again. One item per failed run, updated per attempt. */
export interface RetryItem {
  readonly kind: "retry";
  readonly id: string;
  readonly state: RetryState;
  readonly attempt: number;
  readonly maxAttempts: number;
  /** When the wait for the current attempt ends. */
  readonly retryAt: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  /** What the provider said, as omp worded it. */
  readonly error: string;
}

/**
 * A slash command the person ran from the palette. omp prints a builtin's answer as text and
 * keeps no event for it, so the sidecar builds this item itself (`command-runner.ts`) and saves
 * it in the session file so a resumed session shows it again.
 */
export interface CommandItem {
  readonly kind: "command";
  readonly id: string;
  /** The line as sent, with its leading slash (`/model sonnet`). */
  readonly text: string;
  readonly state: ToolStatus;
  /** What omp printed, as it printed it; empty while it has printed nothing. */
  readonly output: string;
  /** The output was cut at {@link COMMAND_OUTPUT_MAX} characters. */
  readonly truncated?: boolean;
  readonly startedAt: number;
  readonly endedAt?: number;
}

/** Longest output a command item carries; `/dump` alone can print a whole transcript. */
export const COMMAND_OUTPUT_MAX = 64_000;

// -- Session-level facts -----------------------------------------------------------------------

/** Tokens and cost the session has used, summed from the assistant messages of its timeline. */
export interface SessionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** In the provider's currency units as omp reports them (USD). */
  readonly cost: number;
}

/** How full the model's context window is, as omp measures it. */
export interface ContextFill {
  readonly tokens: number;
  readonly window: number;
  /** Tokens at which omp compacts by itself; absent when auto-compaction is off. */
  readonly compactAtTokens?: number;
}

// -- Guards ------------------------------------------------------------------------------------

const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optNumber = (v: unknown): boolean => v === undefined || isNumber(v);
const optString = (v: unknown): boolean => v === undefined || isString(v);
const every = (v: unknown, test: (x: unknown) => boolean): boolean =>
  Array.isArray(v) && v.every(test);

const STATUSES: Record<string, true> = { running: true, done: true, failed: true, stopped: true };

function isDiffRow(v: unknown): boolean {
  return (
    isRecord(v) &&
    (v.kind === "add" || v.kind === "remove" || v.kind === "context" || v.kind === "skip") &&
    optNumber(v.oldLine) &&
    optNumber(v.newLine) &&
    isString(v.text)
  );
}

function isFileDiff(v: unknown): boolean {
  return (
    isRecord(v) &&
    isString(v.path) &&
    (v.op === "write" ||
      v.op === "create" ||
      v.op === "update" ||
      v.op === "delete" ||
      v.op === "move") &&
    optString(v.movedFrom) &&
    isNumber(v.added) &&
    isNumber(v.removed) &&
    every(v.rows, isDiffRow) &&
    isNumber(v.rowsOmitted)
  );
}

function isMatchFile(v: unknown): boolean {
  return (
    isRecord(v) &&
    isString(v.path) &&
    isNumber(v.count) &&
    every(v.lines, (l) => isRecord(l) && isNumber(l.line) && isString(l.text))
  );
}

function isSubagent(v: unknown): boolean {
  return (
    isRecord(v) &&
    isString(v.id) &&
    isString(v.agent) &&
    isString(v.description) &&
    (v.status === "pending" ||
      v.status === "running" ||
      v.status === "completed" ||
      v.status === "failed" ||
      v.status === "aborted") &&
    optNumber(v.durationMs) &&
    optNumber(v.tokens)
  );
}

const TODO_STATUSES: Record<string, true> = {
  pending: true,
  in_progress: true,
  completed: true,
  abandoned: true,
  blocked: true,
};

export function isTodoPhase(v: unknown): v is TodoPhase {
  return (
    isRecord(v) &&
    isString(v.name) &&
    every(
      v.tasks,
      (t) =>
        isRecord(t) &&
        isString(t.content) &&
        isString(t.status) &&
        Object.hasOwn(TODO_STATUSES, t.status),
    )
  );
}

export function isToolOutput(v: unknown): v is ToolOutput {
  if (!isRecord(v)) return false;
  switch (v.kind) {
    case "diff":
      return every(v.files, isFileDiff);
    case "shell":
      return (
        optNumber(v.exitCode) &&
        (v.timedOut === undefined || typeof v.timedOut === "boolean") &&
        optNumber(v.wallTimeMs) &&
        every(v.lines, isString) &&
        isNumber(v.linesOmitted)
      );
    case "matches":
      return (
        isNumber(v.matchCount) &&
        isNumber(v.fileCount) &&
        every(v.files, isMatchFile) &&
        isNumber(v.filesOmitted)
      );
    case "paths":
      return (
        isNumber(v.count) &&
        every(v.paths, isString) &&
        optNumber(v.lines) &&
        (v.directory === undefined || typeof v.directory === "boolean")
      );
    case "todo":
      return isNumber(v.done) && isNumber(v.total) && every(v.phases, isTodoPhase);
    case "subagents":
      return every(v.agents, isSubagent) && optNumber(v.durationMs);
    case "list":
      return (
        isNumber(v.total) &&
        every(v.entries, (e) => isRecord(e) && isString(e.title) && optString(e.note))
      );
    case "text":
      return isString(v.text) && isNumber(v.linesOmitted);
    default:
      return false;
  }
}

export function isToolCall(v: unknown): v is ToolCall {
  return (
    isRecord(v) &&
    isString(v.toolCallId) &&
    isString(v.status) &&
    Object.hasOwn(STATUSES, v.status) &&
    isNumber(v.startedAt) &&
    optNumber(v.endedAt) &&
    optString(v.target) &&
    optString(v.error) &&
    (v.output === undefined || isToolOutput(v.output))
  );
}

/** The kinds this module owns; `isTimelineItem` answers for exactly these. */
export function isTimelineItem(
  v: unknown,
): v is ToolItem | ThinkingItem | CompactionItem | RetryItem | CommandItem {
  if (!isRecord(v) || !isString(v.id)) return false;
  switch (v.kind) {
    case "tool":
      return isString(v.tool) && optString(v.intent) && every(v.calls, isToolCall);
    case "thinking":
      return (
        isString(v.text) &&
        typeof v.done === "boolean" &&
        isNumber(v.startedAt) &&
        optNumber(v.endedAt) &&
        optNumber(v.tokens)
      );
    case "compaction":
      return (
        isString(v.state) &&
        optString(v.reason) &&
        optString(v.action) &&
        isNumber(v.startedAt) &&
        optNumber(v.endedAt) &&
        optNumber(v.tokensBefore) &&
        optString(v.summary) &&
        optString(v.error)
      );
    case "command":
      return (
        isString(v.text) &&
        isString(v.state) &&
        v.state in STATUSES &&
        isString(v.output) &&
        (v.truncated === undefined || v.truncated === true) &&
        isNumber(v.startedAt) &&
        optNumber(v.endedAt)
      );
    case "retry":
      return (
        isString(v.state) &&
        isNumber(v.attempt) &&
        isNumber(v.maxAttempts) &&
        isNumber(v.retryAt) &&
        isNumber(v.startedAt) &&
        optNumber(v.endedAt) &&
        isString(v.error)
      );
    default:
      return false;
  }
}

export function isSessionUsage(v: unknown): v is SessionUsage {
  return (
    isRecord(v) &&
    isNumber(v.inputTokens) &&
    isNumber(v.outputTokens) &&
    isNumber(v.cacheReadTokens) &&
    isNumber(v.cacheWriteTokens) &&
    isNumber(v.cost)
  );
}

export function isContextFill(v: unknown): v is ContextFill {
  return isRecord(v) && isNumber(v.tokens) && isNumber(v.window) && optNumber(v.compactAtTokens);
}

export const EMPTY_USAGE: SessionUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
};

// -- Pure helpers shared by the sidecar and the renderer --------------------------------------

/** The status of a whole item: the worst of its calls, `running` while any is. */
export function toolItemStatus(item: ToolItem): ToolStatus {
  let failed = false;
  let stopped = false;
  for (const call of item.calls) {
    if (call.status === "running") return "running";
    if (call.status === "failed") failed = true;
    else if (call.status === "stopped") stopped = true;
  }
  return failed ? "failed" : stopped ? "stopped" : "done";
}

/** Two intents are the same sentence when only case and surrounding space differ. */
export function sameIntent(a: string | undefined, b: string | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/**
 * Tools whose calls never share a line: each has a result of its own to read (a question and its
 * answer, a plan, a delegated run).
 */
const SOLO_TOOLS: Record<string, true> = {
  ask: true,
  todo: true,
  task: true,
  checkpoint: true,
  rewind: true,
};

/** Whether a call of `tool` with `intent` joins the tool item that ends the timeline. */
export function joinsItem(item: ToolItem, tool: string, intent: string | undefined): boolean {
  return item.tool === tool && !Object.hasOwn(SOLO_TOOLS, tool) && sameIntent(item.intent, intent);
}
