import {
  type FileDiff,
  type SubagentRow,
  type ThinkingItem,
  type ToolCall,
  type ToolItem,
  type ToolOutput,
  type ToolStatus,
  toolItemStatus,
} from "@omp-app/protocol";

/**
 * The sentence of a tool line. Deterministic templates over what omp reported (`intent`,
 * `details` distilled by the sidecar): no model writes it. The catalog is the Pen frame `dkFa7`:
 * one sentence per tool in three moments.
 *
 *   running  the agent's own intent, as written, plus an ellipsis
 *   done     verb in the past + object + at most two quiet facts
 *   failed   what failed + the reason in at most four words
 *
 * A phrase is data, not markup: `Part`s say which words are code (mono) and which are the
 * diff's `+` and `-`; the component decides how to draw them.
 */

export interface Part {
  readonly text: string;
  /** Paths, commands, patterns: anything the reader may copy. */
  readonly mono?: boolean;
  readonly tone?: "add" | "remove";
}

export interface Phrase {
  readonly primary: readonly Part[];
  /** Quiet facts after the phrase, at most two, drawn as `· fact`. */
  readonly secondary: readonly (readonly Part[])[];
}

const plain = (text: string): Part => ({ text });
const code = (text: string): Part => ({ text, mono: true });

// -- Formatting --------------------------------------------------------------------------------

/** `340ms`, `2.4s`, `18s`, `1m 12s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** The running timer: whole seconds up to 59s, then `1m 04s` (so the digits do not dance). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  return at === -1 ? trimmed : trimmed.slice(at + 1) || trimmed;
}

/** First line of a command, whitespace folded, clipped. */
function commandText(command: string | undefined): string {
  const line = (command ?? "").split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/**
 * The reason of a failure in at most four words, as the design asks. Known causes get the
 * short form; anything else is cut at four words.
 */
export function shortReason(error: string | undefined): string {
  if (!error) return "";
  if (/not found|no such|does not exist|ENOENT/i.test(error)) return "not found";
  if (/too large|too big|exceeds/i.test(error)) return "too large";
  if (/permission|EACCES|read-only|EROFS/i.test(error)) return "permission denied";
  if (/timed? ?out/i.test(error)) return "timed out";
  if (/rate.?limit|429/i.test(error)) return "rate limited";
  const words = error
    .replace(/^Error:\s*/i, "")
    .split(/\s+/)
    .filter(Boolean);
  return words.length <= 4 ? words.join(" ") : `${words.slice(0, 4).join(" ")}…`;
}

const withEllipsis = (text: string): string => (/(\.{3}|…)$/.test(text) ? text : `${text}…`);

// -- Reading the calls of an item --------------------------------------------------------------

function diffsOf(calls: readonly ToolCall[]): FileDiff[] {
  return calls.flatMap((c) => (c.output?.kind === "diff" ? c.output.files : []));
}

function outputsOf<K extends ToolOutput["kind"]>(
  calls: readonly ToolCall[],
  kind: K,
): Extract<ToolOutput, { kind: K }>[] {
  return calls.flatMap((c) =>
    c.output?.kind === kind ? [c.output as Extract<ToolOutput, { kind: K }>] : [],
  );
}

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/** Wall time of the calls that ended; a call without an end adds nothing. */
function spent(calls: readonly ToolCall[]): number {
  return sum(calls.map((c) => (c.endedAt === undefined ? 0 : c.endedAt - c.startedAt)));
}

const firstFailed = (calls: readonly ToolCall[]): ToolCall | undefined =>
  calls.find((c) => c.status === "failed");

// -- Running -----------------------------------------------------------------------------------

/** Used only when the agent wrote no intent. */
const RUNNING_FALLBACK: Record<string, string> = {
  read: "Reading",
  write: "Writing",
  edit: "Editing",
  grep: "Searching for",
  glob: "Listing files matching",
  ast_grep: "Searching syntax for",
  bash: "Running",
  eval: "Evaluating",
  task: "Delegating",
  wait: "Waiting",
  ask: "Asking",
  todo: "Planning",
  web_search: "Searching the web for",
  checkpoint: "Saving a checkpoint",
  rewind: "Rewinding",
};

function running(item: ToolItem): Phrase {
  const target = item.calls.at(-1)?.target;
  if (item.intent) return { primary: [plain(withEllipsis(item.intent))], secondary: [] };
  const verb = RUNNING_FALLBACK[item.tool];
  if (!verb)
    return { primary: [plain("Running "), code(toolLabel(item.tool)), plain("…")], secondary: [] };
  const mono = item.tool === "bash" ? commandText(target) : target;
  return {
    primary: mono ? [plain(`${verb} `), code(mono), plain("…")] : [plain(withEllipsis(verb))],
    secondary: [],
  };
}

// -- Done --------------------------------------------------------------------------------------

/** Name of an MCP tool without the `mcp__` prefix; any other tool as is. */
export function toolLabel(tool: string): string {
  return tool.startsWith("mcp__") ? tool.slice("mcp__".length) : tool;
}

function pathParts(item: ToolItem): { paths: string[]; first: string | undefined } {
  const paths = [...new Set(item.calls.flatMap((c) => (c.target ? [c.target] : [])))];
  return { paths, first: paths[0] };
}

/** `xd://ast_edit` and its kind are devices of the agent, not files. */
const device = (target: string | undefined): string | undefined =>
  target?.startsWith("xd://") ? target.slice("xd://".length) : undefined;

function done(item: ToolItem): Phrase {
  const { calls } = item;
  const dev =
    item.tool === "read" || item.tool === "write" ? device(item.calls[0]?.target) : undefined;
  if (dev !== undefined) {
    return {
      primary: [plain(item.tool === "read" ? "Read " : "Called "), code(dev)],
      secondary: [],
    };
  }
  const { paths, first } = pathParts(item);
  switch (item.tool) {
    case "read": {
      const lines = sum(outputsOf(calls, "paths").map((o) => o.lines ?? 0));
      const entries = outputsOf(calls, "paths").find((o) => o.directory);
      const facts = lines > 0 ? [[plain(plural(lines, "line"))]] : [];
      if (entries) {
        return {
          primary: [plain("Listed "), code(basename(first ?? ""))],
          secondary: [[plain(plural(entries.count, "entry", "entries"))]],
        };
      }
      return paths.length === 1 && first
        ? { primary: [plain("Read "), code(basename(first))], secondary: facts }
        : {
            primary: [plain(`Read ${plural(paths.length || calls.length, "file")}`)],
            secondary: facts,
          };
    }
    case "write": {
      const diffs = diffsOf(calls);
      const lines = sum(diffs.map((d) => d.added));
      const facts = lines > 0 ? [[plain(plural(lines, "line"))]] : [];
      return paths.length === 1 && first
        ? { primary: [plain("Wrote "), code(basename(first))], secondary: facts }
        : {
            primary: [plain(`Wrote ${plural(paths.length || calls.length, "file")}`)],
            secondary: facts,
          };
    }
    case "edit": {
      const diffs = diffsOf(calls);
      const files = [...new Set(diffs.map((d) => d.path))];
      const added = sum(diffs.map((d) => d.added));
      const removed = sum(diffs.map((d) => d.removed));
      const name = files.length === 1 ? basename(files[0] ?? "") : first ? basename(first) : "";
      const moved = diffs.some((d) => d.op === "move");
      const delta: Part[] =
        diffs.length === 0
          ? []
          : [
              { text: `+${added}`, tone: "add" },
              plain(" "),
              { text: `-${removed}`, tone: "remove" },
            ];
      const verb = moved ? "Moved " : "Edited ";
      return {
        primary:
          files.length > 1
            ? [plain(`Edited ${plural(files.length, "file")}`)]
            : [plain(verb), code(name)],
        secondary: delta.length > 0 ? [delta] : [],
      };
    }
    case "grep":
    case "ast_grep": {
      const outs = outputsOf(calls, "matches");
      const matches = sum(outs.map((o) => o.matchCount));
      const fileCount = sum(outs.map((o) => o.fileCount));
      if (outs.length > 0 && matches === 0) {
        return { primary: [plain("No matches for "), code(first ?? "")], secondary: [] };
      }
      if (outs.length === 0)
        return { primary: [plain("Searched "), code(first ?? "")], secondary: [] };
      const found =
        item.tool === "ast_grep" ? plural(matches, "node") : plural(matches, "match", "matches");
      return { primary: [plain(`Found ${found} in ${plural(fileCount, "file")}`)], secondary: [] };
    }
    case "glob": {
      const count = sum(outputsOf(calls, "paths").map((o) => o.count));
      return count === 0
        ? { primary: [plain("No files match "), code(first ?? "")], secondary: [] }
        : {
            primary: [plain(`Found ${plural(count, "file")} matching `), code(first ?? "")],
            secondary: [],
          };
    }
    case "bash": {
      // omp times the command itself (`wallTimeMs`); the sidecar's stamps also include queueing.
      const timed = calls.map((c) =>
        c.output?.kind === "shell" ? c.output.wallTimeMs : undefined,
      );
      const time = timed.every((t) => t !== undefined) ? sum(timed as number[]) : spent(calls);
      const facts = time > 0 ? [[plain(formatDuration(time))]] : [];
      return calls.length === 1
        ? { primary: [plain("Ran "), code(commandText(first))], secondary: facts }
        : { primary: [plain(`Ran ${plural(calls.length, "command")}`)], secondary: facts };
    }
    case "eval": {
      const time = spent(calls);
      return {
        primary: [plain("Evaluated code")],
        secondary: time > 0 ? [[plain(formatDuration(time))]] : [],
      };
    }
    case "task": {
      const rows: SubagentRow[] = outputsOf(calls, "subagents").flatMap((o) => o.agents);
      const duration = outputsOf(calls, "subagents")[0]?.durationMs ?? spent(calls);
      const facts = duration > 0 ? [[plain(formatDuration(duration))]] : [];
      return rows.length === 0
        ? { primary: [plain("Delegated a task")], secondary: facts }
        : { primary: [plain(`${plural(rows.length, "subagent")} done`)], secondary: facts };
    }
    case "wait":
      return { primary: [plain(`Waited ${formatDuration(spent(calls))}`)], secondary: [] };
    case "ask": {
      const answers = outputsOf(calls, "list").flatMap((o) => o.entries.map((e) => e.title));
      return answers.length > 0
        ? { primary: [plain("You chose "), code(answers.join(", "))], secondary: [] }
        : { primary: [plain("Asked a question")], secondary: [] };
    }
    case "todo": {
      const last = outputsOf(calls, "todo").at(-1);
      return last
        ? { primary: [plain(`Todo · ${last.done} of ${last.total} done`)], secondary: [] }
        : { primary: [plain("Updated the todo list")], secondary: [] };
    }
    case "web_search": {
      const total = sum(outputsOf(calls, "list").map((o) => o.total));
      return total > 0
        ? { primary: [plain(`Found ${plural(total, "result")}`)], secondary: [] }
        : { primary: [plain("Searched the web")], secondary: [] };
    }
    case "checkpoint":
      return { primary: [plain("Checkpoint saved")], secondary: [] };
    case "rewind":
      return { primary: [plain("Rewound to the checkpoint")], secondary: [] };
    case "recall":
      return { primary: [plain("Recalled from memory")], secondary: [] };
    case "retain":
      return { primary: [plain("Saved to memory")], secondary: [] };
    case "reflect":
      return { primary: [plain("Reflected on memory")], secondary: [] };
    default: {
      const time = spent(calls);
      return {
        primary: [code(toolLabel(item.tool))],
        secondary: time >= 1000 ? [[plain(formatDuration(time))]] : [],
      };
    }
  }
}

// -- Failed ------------------------------------------------------------------------------------

function failed(item: ToolItem): Phrase {
  const call = firstFailed(item.calls);
  const reason = shortReason(call?.error);
  const why = reason ? [[plain(reason)]] : [];
  const target = call?.target;
  switch (item.tool) {
    case "read":
      return { primary: [plain("Couldn’t read "), code(basename(target ?? ""))], secondary: why };
    case "write":
      return { primary: [plain("Couldn’t write "), code(basename(target ?? ""))], secondary: why };
    case "edit":
      return { primary: [plain("Edit didn’t apply")], secondary: why };
    case "grep":
    case "glob":
      return { primary: [plain("Search failed")], secondary: why };
    case "ast_grep":
      return {
        primary: [
          plain(/pars/i.test(call?.error ?? "") ? "Pattern didn’t parse" : "Search failed"),
        ],
        secondary: why,
      };
    case "bash": {
      const out = call?.output?.kind === "shell" ? call.output : undefined;
      if (out?.timedOut) {
        const waited =
          out.wallTimeMs !== undefined ? ` after ${formatDuration(out.wallTimeMs)}` : "";
        return {
          primary: [plain(`Timed out${waited} · `), code(commandText(target))],
          secondary: [],
        };
      }
      const exit = out?.exitCode !== undefined ? [[plain(`exit ${out.exitCode}`)]] : why;
      return { primary: [code(commandText(target)), plain(" failed")], secondary: exit };
    }
    case "eval":
      return { primary: [plain("Eval failed")], secondary: why };
    case "task": {
      const rows = outputsOf(item.calls, "subagents").flatMap((o) => o.agents);
      const bad = rows.filter((r) => r.status === "failed" || r.status === "aborted").length;
      return rows.length > 1 && bad > 0
        ? { primary: [plain(`${bad} of ${plural(rows.length, "subagent")} failed`)], secondary: [] }
        : { primary: [plain("Delegated task failed")], secondary: why };
    }
    case "wait":
      return {
        primary: [plain(`Stopped waiting after ${formatDuration(spent(item.calls))}`)],
        secondary: [],
      };
    case "ask":
      return { primary: [plain("Question dismissed")], secondary: [] };
    case "todo":
      return { primary: [plain("Couldn’t update the todo list")], secondary: why };
    case "web_search":
      return { primary: [plain("Search failed")], secondary: why };
    case "checkpoint":
      return { primary: [plain("Couldn’t save the checkpoint")], secondary: why };
    case "rewind":
      return { primary: [plain("Rewind failed")], secondary: why };
    default:
      return { primary: [code(toolLabel(item.tool)), plain(" failed")], secondary: why };
  }
}

/** The sentence of a tool line for the moment it is in. A stopped call reads as a running one that did not finish. */
export function toolPhrase(item: ToolItem, status: ToolStatus = toolItemStatus(item)): Phrase {
  if (status === "running") return running(item);
  if (status === "failed") return failed(item);
  if (status === "stopped") {
    const base = running(item);
    // "Reading notes…" stopped: the ellipsis would promise more work, so it goes.
    const primary = base.primary
      .map((p, i, all) =>
        i === all.length - 1 ? { ...p, text: p.text.replace(/(\.{3}|…)$/, "") } : p,
      )
      .filter((p) => p.text !== "");
    return { primary, secondary: [[plain("stopped")]] };
  }
  return done(item);
}

// -- Thinking ----------------------------------------------------------------------------------

/** First line of the reasoning, for the collapsed line. */
export function thinkingGist(text: string): string {
  const line =
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/**
 * Tokens per second from the provider's token count and the time it took, shown after 2 s when
 * the figure has settled. Absent when the provider reports no count until the end.
 */
export function tokensPerSecond(item: ThinkingItem, now: number): number | undefined {
  if (item.tokens === undefined || item.tokens <= 0) return undefined;
  const seconds = ((item.endedAt ?? now) - item.startedAt) / 1000;
  return seconds >= 2 ? Math.round(item.tokens / seconds) : undefined;
}
