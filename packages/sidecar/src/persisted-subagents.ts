import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isAdvisorTranscriptName } from "@oh-my-pi/pi-coding-agent/advisor/transcript-recorder";
import { getAgentTombstonePath } from "@oh-my-pi/pi-coding-agent/registry/agent-tombstone";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import type { Item, SubagentStatus } from "@omp-app/protocol";
import { isRecord } from "./tool-output";
import { buildTranscript, type TranscriptMessage } from "./transcript";

/**
 * A subagent read back from the transcript file omp keeps for it. omp writes each subagent's
 * transcript as `<root session file minus .jsonl>/<id>.jsonl`; a subagent that spawned its own
 * children has a sibling directory `<id>/` with their transcripts
 * (`registry/persisted-agents.ts` `registerPersistedSubagentsFromDir` [V]).
 */
export interface PersistedSubagent {
  /** The transcript's file stem, which is the id omp's registry knows the agent by. */
  readonly id: string;
  /** Agent definition name from `session_init.agent`; `"task"` when the file does not name one. */
  readonly agent: string;
  /**
   * What the assignment was, from `session_init.task`: the lines under `# Target` when the task
   * has that section, else the whole task, whitespace collapsed, at most 200 characters. The
   * short `description` the parent model gave the task tool is NOT stored in the transcript [V:
   * `SessionInitEntry` has no such field], so this is a summary of the task, not that text.
   * Null when the file has no `session_init` or an empty task.
   */
  readonly description: string | null;
  /** `session_init.task` as stored, untruncated; null when absent. Lets a caller tell a label from task text. */
  readonly task: string | null;
  readonly status: SubagentStatus;
  /** Milliseconds since the epoch: the session header's time, else the first entry's. */
  readonly startedAt: number;
  /** Time of the last entry that carries one. Absent when the file has no timed entry. */
  readonly endedAt?: number;
  /** Input plus output tokens summed over the assistant messages; cache reads are left out. */
  readonly tokens: number;
  /** `provider/model` of the last assistant message; null when there is none. */
  readonly model: string | null;
  readonly timeline: readonly Item[];
  /** Id of the subagent whose directory held this transcript; absent for the root's children. */
  readonly parentId?: string;
}

/** What the status derivation reads from a message: its role and, on an assistant, why it stopped. */
export interface StatusMessage {
  readonly role: string;
  readonly stopReason?: unknown;
}

/**
 * How a persisted subagent ended, from what is on disk. Pure.
 *
 * - `tombstoned` (omp's `<transcript>.jsonl.tombstone` marker, left by an explicit kill [V:
 *   `registry/agent-tombstone.ts`]) -> `aborted`.
 * - The conversation does not end on an assistant message (no messages, or it stops on a tool
 *   result or the task prompt), or that assistant message stopped to call tools (`toolUse`): the
 *   run was cut off, e.g. the host died -> `aborted`.
 * - The last assistant message stopped with `error` -> `failed`; with `aborted` -> `aborted`.
 * - Otherwise (`stop`, `length`) -> `completed`. `length` is a truncated answer, but it is an
 *   answer; the run ended on its own.
 *
 * Never `running`: a file on disk cannot tell a live run from a dead one, and the
 * caller only reads files for sessions whose subagents are not in memory.
 */
export function deriveSubagentStatus(
  messages: readonly StatusMessage[],
  tombstoned: boolean,
): SubagentStatus {
  if (tombstoned) return "aborted";
  const last = messages.at(-1);
  if (last?.role !== "assistant") return "aborted";
  switch (last.stopReason) {
    case "error":
      return "failed";
    case "aborted":
    case "toolUse":
      return "aborted";
    default:
      return "completed";
  }
}

const DESCRIPTION_MAX = 200;

/** See {@link PersistedSubagent.description}. */
function describeTask(task: unknown): string | null {
  if (typeof task !== "string") return null;
  const lines = task.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim().toLowerCase() === "# target");
  const target: string[] = [];
  if (at >= 0) {
    for (const line of lines.slice(at + 1)) {
      if (line.trimStart().startsWith("# ")) break;
      target.push(line);
    }
  }
  const text = (target.length > 0 ? target : lines).join(" ").replace(/\s+/g, " ").trim();
  return text === "" ? null : text.slice(0, DESCRIPTION_MAX);
}

const time = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms;
};

function tokensOf(messages: readonly TranscriptMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (!("usage" in m) || !isRecord(m.usage)) continue;
    const usage = m.usage;
    for (const key of ["input", "output"]) {
      const n = usage[key];
      if (typeof n === "number" && Number.isFinite(n)) total += n;
    }
  }
  return total;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** One transcript file to a subagent; null when it holds nothing a subagent can be made of. */
async function readOne(
  file: string,
  id: string,
  parentId?: string,
): Promise<PersistedSubagent | null> {
  const loaded = await loadEntriesFromFile(file);
  const entries: SessionEntry[] = [];
  let header: unknown;
  for (const entry of loaded) {
    if (entry.type === "session") header = entry;
    else entries.push(entry);
  }
  if (entries.length === 0) return null;

  let init: Record<string, unknown> | undefined;
  for (const entry of entries) {
    if (entry.type === "session_init") {
      init = entry as unknown as Record<string, unknown>;
      break;
    }
  }
  // The same builder a resumed main session goes through (`AgentSession.buildTranscriptSessionContext`
  // calls `sessionManager.buildSessionContext({transcript: true})` [V: session-provider-boundary.ts:154]),
  // which is this pure function over the entries and the leaf the entries replay to.
  const context = buildSessionContext(entries, undefined, undefined, { transcript: true });
  const messages = context.messages as unknown as readonly TranscriptMessage[];
  const transcript = buildTranscript(messages);

  let endedAt: number | undefined;
  for (let i = entries.length - 1; i >= 0 && endedAt === undefined; i--) {
    endedAt = time(entries[i]?.timestamp);
  }
  const startedAt =
    time(isRecord(header) ? header.timestamp : undefined) ??
    time(entries[0]?.timestamp) ??
    (await stat(file)).birthtimeMs;

  return {
    id,
    agent: typeof init?.agent === "string" && init.agent !== "" ? init.agent : "task",
    description: describeTask(init?.task),
    task: typeof init?.task === "string" && init.task !== "" ? init.task : null,
    status: deriveSubagentStatus(
      messages as readonly StatusMessage[],
      await exists(getAgentTombstonePath(file)),
    ),
    startedAt,
    ...(endedAt === undefined ? {} : { endedAt }),
    tokens: tokensOf(messages),
    model: transcript.model,
    timeline: transcript.items,
    ...(parentId === undefined ? {} : { parentId }),
  };
}

/** Transcripts read at once. Each one is parsed in full, so this bounds memory, not just handles. */
const CONCURRENCY = 4;

interface Found {
  file: string;
  id: string;
  parentId?: string;
}

async function collect(dir: string, parentId: string | undefined, out: Found[]): Promise<void> {
  let names: Dirent[];
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // no directory (a session that never ran a subagent), or unreadable
  }
  const dirs = new Set(names.filter((e) => e.isDirectory()).map((e) => e.name));
  for (const entry of names) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl") || entry.name.includes(".bak")) continue;
    // The advisor's transcript shares the directory but is not a subagent.
    if (isAdvisorTranscriptName(entry.name)) continue;
    const id = entry.name.slice(0, -".jsonl".length);
    out.push({ file: join(dir, entry.name), id, ...(parentId === undefined ? {} : { parentId }) });
    // A stem is no proof of a child directory ("." / ".." / symlinks), so only a real directory.
    if (id !== "." && id !== ".." && dirs.has(id)) await collect(join(dir, id), id, out);
  }
}

/**
 * How many subagent transcripts `loadPersistedSubagents` would find for the session file,
 * without reading any of them. This is the number `session.delete` removes with the session.
 */
export async function countPersistedSubagents(sessionFile: string): Promise<number> {
  if (!sessionFile.endsWith(".jsonl")) return 0;
  const found: Found[] = [];
  await collect(sessionFile.slice(0, -".jsonl".length), undefined, found);
  return found.length;
}

/**
 * The subagents of a stored session, read from the transcripts omp keeps in the session's
 * artifacts directory (`<sessionFile minus .jsonl>/`), oldest first. Includes nested ones.
 *
 * Never throws for the content of the directory: a missing directory gives `[]`, and a file that
 * cannot be read or holds no entries is skipped, the rest still load.
 */
export async function loadPersistedSubagents(sessionFile: string): Promise<PersistedSubagent[]> {
  if (!sessionFile.endsWith(".jsonl")) return [];
  const found: Found[] = [];
  await collect(sessionFile.slice(0, -".jsonl".length), undefined, found);

  const results: (PersistedSubagent | null)[] = new Array(found.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next++;
      const item = found[at];
      if (!item) return;
      try {
        results[at] = await readOne(item.file, item.id, item.parentId);
      } catch {
        results[at] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, found.length) }, worker));

  return results
    .filter((r): r is PersistedSubagent => r !== null)
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}
