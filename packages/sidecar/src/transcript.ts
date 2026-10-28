import {
  type CommandItem,
  type CompactionItem,
  type Item,
  joinsItem,
  type ToolCall,
  type ToolItem,
} from "@omp-app/protocol";
import type { StoredCommand } from "./command-entries";
import { distill, isRecord, toolTarget, toToolResult, writeOutput } from "./tool-output";
import { attachmentsOf, mentionedFiles } from "./user-message";

/**
 * The part of omp's `AgentMessage` the builder reads. Structural on purpose: the builder stays
 * pure and testable with plain objects, and omp's own message union is assignable to it.
 * Field names are omp's (`rpc-wire.generated.ts` ToolResultMessage, BashExecutionMessage,
 * CompactionSummaryMessage [V]).
 */
export interface TranscriptMessage {
  readonly role: string;
  readonly content?: unknown;
  /** Set on user messages omp injected itself (not typed by the person). */
  readonly synthetic?: boolean;
  /** Set on a user message that was injected into a running turn (`messages.ts:655` [V]). */
  readonly steering?: unknown;
  /** On a `fileMention` message: the files omp read (`FileMentionMessage` [V]). */
  readonly files?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  /**
   * On an assistant message of the transcript context: how many of its tool calls omp removed
   * because the session holds no result for them (`session-context.ts:722-748` [V]).
   */
  readonly strippedToolCalls?: unknown;
  /** Milliseconds since the epoch, on every stored message. */
  readonly timestamp?: unknown;
  // toolResult
  readonly toolCallId?: unknown;
  readonly toolName?: unknown;
  readonly isError?: unknown;
  readonly details?: unknown;
  // bashExecution
  readonly command?: unknown;
  readonly output?: unknown;
  readonly exitCode?: unknown;
  readonly cancelled?: unknown;
  // compactionSummary
  readonly shortSummary?: unknown;
  readonly tokensBefore?: unknown;
  readonly method?: unknown;
}

export interface Transcript {
  readonly items: readonly Item[];
  /** `provider/model` of the last assistant message; null when there is none. */
  readonly model: string | null;
  /**
   * What the stored session holds that the timeline has no item for, counted by label. Empty when
   * nothing was left out. Nothing is dropped without a trace: the caller turns this into a
   * warning on the session.
   */
  readonly omitted: Readonly<Record<string, number>>;
}

/**
 * How a message that has no item is named when it is reported as left out, by role. A role
 * missing here is counted under its own name, so a new omp role is never silent either. When a
 * role gets an item kind, it moves from here to a case in {@link buildTranscript}.
 */
const OMITTED_LABELS: Readonly<Record<string, string>> = {
  pythonExecution: "python runs",
  branchSummary: "branch summaries",
  custom: "custom messages",
  hookMessage: "hook messages",
  developer: "messages added by omp",
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** The text parts of a message's content, joined. Content is a string or a list of parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") text += part.text;
  }
  return text;
}

/**
 * omp's `ModelSwitch` method names to the compaction `action` the live event carries. `soft` is
 * the ordinary summarize-in-place, which the live event calls `context-full`.
 */
const ACTIONS: Readonly<Record<string, NonNullable<CompactionItem["action"]>>> = {
  remote: "remote",
  handoff: "handoff",
  shake: "shake",
  snapcompact: "snapcompact",
  soft: "context-full",
};

/**
 * Rebuilds the timeline of a stored session from its messages, the way the live reducer builds
 * it from events (`reducer.ts`): same item kinds, same `i<position>` ids, tool calls joined into
 * one line under the same rule (`joinsItem`), so a session that was resumed and one that ran
 * live read alike and new live items continue the ids.
 *
 * What a stored message does not carry is left absent, not invented:
 * - Times. A message has one timestamp, so a call starts and ends at its result's timestamp
 *   (no duration; a shell call still shows its own `wallTimeMs`). Reasoning has no times at all.
 * - Why and how a compaction ran: `reason` is never stored, `action` only through `method`.
 * - A call whose result is not in the session: omp removes it from the transcript context and
 *   only counts it (`strippedToolCalls`), so it is counted here, under its own label.
 *
 * Pure. A new item kind is one more `case`; what has no item yet is counted in `omitted`.
 */
export function buildTranscript(
  messages: readonly TranscriptMessage[],
  commands: readonly StoredCommand[] = [],
): Transcript {
  const items: Item[] = [];
  const omitted: Record<string, number> = {};
  const leaveOut = (label: string, count = 1): void => {
    if (count > 0) omitted[label] = (omitted[label] ?? 0) + count;
  };
  let model: string | null = null;

  /** Ids of the lines made from a command the person ran with `!`; the agent's calls never join them. */
  const ownRuns = new Set<string>();

  /** Adds a call to the tool item that ends the timeline when the live reducer would. */
  const addCall = (tool: string, intent: string | undefined, call: ToolCall): void => {
    const last = items.at(-1);
    if (last?.kind === "tool" && !ownRuns.has(last.id) && joinsItem(last, tool, intent)) {
      items[items.length - 1] = { ...last, calls: [...last.calls, call] };
      return;
    }
    items.push({
      kind: "tool",
      id: `i${items.length}`,
      tool,
      ...(intent === undefined ? {} : { intent }),
      calls: [call],
    });
  };

  /** The tool item and call for `toolCallId`; recent first. */
  const findCall = (
    toolCallId: string,
  ): { at: number; item: ToolItem; call: ToolCall } | undefined => {
    for (let at = items.length - 1; at >= 0; at--) {
      const item = items[at];
      if (item?.kind !== "tool") continue;
      const call = item.calls.find((c) => c.toolCallId === toolCallId);
      if (call) return { at, item, call };
    }
    return undefined;
  };

  /** Commands not yet placed, oldest first. A command goes before the first message that is newer. */
  const pending = [...commands].sort((a, b) => a.startedAt - b.startedAt);
  const placeCommands = (before: number | undefined): void => {
    while (pending[0] && (before === undefined || pending[0].startedAt <= before)) {
      const stored = pending.shift() as StoredCommand;
      const item: CommandItem = { kind: "command", id: `i${items.length}`, ...stored };
      items.push(item);
    }
  };

  for (const message of messages) {
    const at = num(message.timestamp) ?? 0;
    // A message without a time cannot be ordered against a command: the commands wait for the end.
    if (at > 0) placeCommands(at);
    switch (message.role) {
      case "user": {
        if (message.synthetic) {
          leaveOut("messages added by omp");
          break;
        }
        const attachments = attachmentsOf(message.content);
        items.push({
          kind: "user",
          id: `i${items.length}`,
          text: textOf(message.content),
          ...(message.steering === true ? { steered: true } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        });
        break;
      }

      case "fileMention": {
        // The files omp read for the user message before it. Without one to attach to (the
        // message was filtered) there is nothing to show, and that is counted as left out.
        const files = mentionedFiles(message);
        const at = items.findLastIndex((item) => item.kind === "user");
        const user = items[at];
        if (user?.kind === "user" && files.length > 0) items[at] = { ...user, files };
        else if (files.length > 0) leaveOut("file mentions");
        break;
      }

      case "assistant": {
        if (typeof message.provider === "string" && typeof message.model === "string")
          model = `${message.provider}/${message.model}`;
        const text = textOf(message.content);
        // A turn made only of tool calls has no text and, live, no text item either.
        if (text !== "")
          items.push({ kind: "assistant", id: `i${items.length}`, text, done: true });
        leaveOut("tool calls without a result", num(message.strippedToolCalls) ?? 0);
        for (const part of Array.isArray(message.content) ? message.content : []) {
          if (!isRecord(part)) continue;
          if (part.type === "thinking" || part.type === "redactedThinking") {
            leaveOut("reasoning blocks");
          } else if (part.type === "toolCall") {
            const id = str(part.id);
            const tool = str(part.name);
            if (!id || !tool) {
              leaveOut("tool calls");
              continue;
            }
            const intent = str(part.intent)?.trim();
            const target = toolTarget(tool, part.arguments);
            const output = tool === "write" ? writeOutput(part.arguments) : undefined;
            addCall(tool, intent, {
              toolCallId: id,
              status: "stopped",
              startedAt: at,
              endedAt: at,
              ...(target === undefined ? {} : { target }),
              ...(output === undefined ? {} : { output }),
            });
          }
        }
        break;
      }

      case "toolResult": {
        const found = findCall(str(message.toolCallId) ?? "");
        if (!found) {
          leaveOut("tool results");
          break;
        }
        const failed = message.isError === true;
        const distilled = distill(
          found.item.tool,
          toToolResult({ content: message.content, details: message.details }, failed),
          found.call.target,
        );
        // `write` shows what the call carried; its result only says how many bytes it wrote.
        const output = found.item.tool === "write" ? found.call.output : distilled.output;
        const call: ToolCall = {
          toolCallId: found.call.toolCallId,
          status: failed ? "failed" : "done",
          startedAt: at,
          endedAt: at,
          ...(found.call.target === undefined ? {} : { target: found.call.target }),
          ...(output === undefined ? {} : { output }),
          ...(distilled.error === undefined ? {} : { error: distilled.error }),
        };
        items[found.at] = {
          ...found.item,
          calls: found.item.calls.map((c) => (c === found.call ? call : c)),
        };
        break;
      }

      case "bashExecution": {
        // A command the person ran with `!`. It never joins an agent's line: it is not the agent's.
        const command = str(message.command);
        if (!command) {
          leaveOut("shell commands");
          break;
        }
        const exitCode = num(message.exitCode);
        const stopped = message.cancelled === true;
        const failed = !stopped && exitCode !== undefined && exitCode !== 0;
        const distilled = distill(
          "bash",
          toToolResult(
            { content: [{ type: "text", text: str(message.output) ?? "" }], details: { exitCode } },
            failed,
          ),
          command,
        );
        const id = `i${items.length}`;
        ownRuns.add(id);
        items.push({
          kind: "tool",
          id,
          tool: "bash",
          calls: [
            {
              toolCallId: `bash-${items.length}`,
              status: stopped ? "stopped" : failed ? "failed" : "done",
              startedAt: at,
              endedAt: at,
              target: command,
              ...(distilled.output === undefined ? {} : { output: distilled.output }),
              ...(distilled.error === undefined ? {} : { error: distilled.error }),
            },
          ],
        });
        break;
      }

      case "compactionSummary": {
        const action = typeof message.method === "string" ? ACTIONS[message.method] : undefined;
        const summary = str(message.shortSummary);
        const tokensBefore = num(message.tokensBefore);
        items.push({
          kind: "compaction",
          id: `i${items.length}`,
          state: "done",
          startedAt: at,
          endedAt: at,
          ...(action === undefined ? {} : { action }),
          ...(tokensBefore === undefined ? {} : { tokensBefore }),
          ...(summary === undefined ? {} : { summary }),
        });
        break;
      }

      default:
        leaveOut(OMITTED_LABELS[message.role] ?? message.role);
    }
  }
  placeCommands(undefined);
  return { items, model, omitted };
}

/** What was left out as a phrase ("reasoning blocks (3) and custom messages (1)"), or null. */
export function describeOmitted(omitted: Readonly<Record<string, number>>): string | null {
  const parts = Object.entries(omitted).map(([label, count]) => `${label} (${count})`);
  if (parts.length === 0) return null;
  const last = parts.pop() as string;
  return parts.length === 0 ? last : `${parts.join(", ")} and ${last}`;
}
