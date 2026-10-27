import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import {
  applyOp,
  type CompactionItem,
  EMPTY_USAGE,
  joinsItem,
  type RetryItem,
  type SessionOp,
  type SessionViewModel,
  type ToolCall,
  type ToolItem,
  type ToolOutput,
} from "@omp-app/protocol";
import {
  diffFromStreamUpdate,
  distill,
  shellOutput,
  todoFromResult,
  toolTarget,
  toToolResult,
  writeOutput,
} from "./tool-output";

/** What one event did to the view model: the new model and the ops that turn old into new. */
export interface Reduced {
  readonly viewModel: SessionViewModel;
  readonly ops: readonly SessionOp[];
}

type AgentMessage = Extract<AgentSessionEvent, { type: "message_start" }>["message"];
type UserMessage = Extract<AgentMessage, { role: "user" }>;
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

/** The text parts of a user or assistant message, joined. Content is a string or a list of parts. */
function textOf(content: UserMessage["content"] | AssistantMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (part?.type === "text") text += part.text ?? "";
  }
  return text;
}

function openAssistant(vm: SessionViewModel) {
  const last = vm.timeline[vm.timeline.length - 1];
  return last?.kind === "assistant" && !last.done ? last : undefined;
}

/** Item ids are positions in the append-only timeline, so they are unique and deterministic. */
const nextItemId = (vm: SessionViewModel): string => `i${vm.timeline.length}`;

/** Builds a `Reduced` by applying each op as it is produced, so later ops see earlier ones. */
class Step {
  viewModel: SessionViewModel;
  readonly ops: SessionOp[] = [];
  constructor(viewModel: SessionViewModel) {
    this.viewModel = viewModel;
  }
  push(op: SessionOp): void {
    this.viewModel = applyOp(this.viewModel, op);
    this.ops.push(op);
  }
  setStatus(status: SessionViewModel["status"], error?: string): void {
    if (this.viewModel.status === status && this.viewModel.error === error) return;
    this.push(
      error === undefined ? { type: "status.set", status } : { type: "status.set", status, error },
    );
  }
  done(): Reduced {
    return { viewModel: this.viewModel, ops: this.ops };
  }
}

/** The streaming thinking item: it is open only while it ends the timeline. */
function openThinking(vm: SessionViewModel) {
  const last = vm.timeline[vm.timeline.length - 1];
  return last?.kind === "thinking" && !last.done ? last : undefined;
}

/**
 * The assistant item a finished message or run closes. Reasoning, a retry or a compaction may
 * have been added after the text, so those items at the end of the timeline are looked through.
 */
function assistantToClose(vm: SessionViewModel) {
  for (let i = vm.timeline.length - 1; i >= 0; i--) {
    const item = vm.timeline[i];
    if (
      item?.kind === "thinking" ||
      item?.kind === "retry" ||
      item?.kind === "compaction" ||
      item?.kind === "decision"
    )
      continue;
    return item?.kind === "assistant" && !item.done ? item : undefined;
  }
  return undefined;
}

/** The tool item and call for `toolCallId`; recent items first, because that is where it is. */
function findCall(
  vm: SessionViewModel,
  toolCallId: string,
): { item: ToolItem; call: ToolCall } | undefined {
  for (let i = vm.timeline.length - 1; i >= 0; i--) {
    const item = vm.timeline[i];
    if (item?.kind !== "tool") continue;
    const call = item.calls.find((c) => c.toolCallId === toolCallId);
    if (call) return { item, call };
  }
  return undefined;
}

/** Latest status item of `kind` that is still going on. */
function latestActive<K extends "compaction" | "retry">(
  vm: SessionViewModel,
  kind: K,
): Extract<SessionViewModel["timeline"][number], { kind: K }> | undefined {
  for (let i = vm.timeline.length - 1; i >= 0; i--) {
    const item = vm.timeline[i];
    if (item?.kind !== kind) continue;
    const active = item.kind === "compaction" ? item.state === "running" : item.state === "waiting";
    return active ? (item as never) : undefined;
  }
  return undefined;
}

const oneLine = (text: string, max = 300): string => {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const sameOutput = (a: ToolOutput | undefined, b: ToolOutput | undefined): boolean =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/** Marks what a stopped run left half-done. Only the current run's items are looked at. */
function settleRun(step: Step, now: number): void {
  const { timeline } = step.viewModel;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (!item || item.kind === "user") break;
    if (item.kind === "tool") {
      for (const call of item.calls) {
        if (call.status !== "running") continue;
        step.push({
          type: "tool.call.update",
          itemId: item.id,
          toolCallId: call.toolCallId,
          patch: { status: "stopped", endedAt: now },
        });
      }
    } else if (item.kind === "thinking" && !item.done) {
      step.push({ type: "thinking.end", itemId: item.id, endedAt: now });
    } else if (item.kind === "retry" && item.state === "waiting") {
      step.push({
        type: "item.patch",
        itemId: item.id,
        patch: { state: "cancelled", endedAt: now },
      });
    }
  }
}

const modelName = (m: AssistantMessage): string => `${m.provider}/${m.model}`;

/**
 * `finalError` of the `auto_retry_end` omp emits when a stop (`abort`) interrupts a retry's
 * credential wait or backoff sleep (`turn-recovery.ts`, `#endCancelledRetry`). It is the only
 * signal that tells a user stop from a retry that ran out of attempts, so it is matched
 * exactly; the replay tests pin it to the installed omp.
 */
export const RETRY_CANCELLED = "Retry cancelled";

/**
 * Pure: no I/O, no randomness; `now` (ms since the epoch) is the caller's clock, because omp's
 * tool and lifecycle events carry no timestamps. Maps one `AgentSessionEvent` to the ops that
 * keep the view model in step. Events the view model has no place for produce no ops.
 */
export function reduceEvent(
  viewModel: SessionViewModel,
  event: AgentSessionEvent,
  now: number,
): Reduced {
  const step = new Step(viewModel);
  switch (event.type) {
    case "agent_start":
      step.setStatus("streaming");
      break;

    case "agent_end": {
      const open = assistantToClose(step.viewModel);
      if (open) step.push({ type: "item.done", itemId: open.id });
      // `yielded: false`: the agent carries on by itself, so its calls are not abandoned.
      if (event.yielded !== false) settleRun(step, now);
      // A failure stays visible until the next run starts. `yielded: false` means the agent
      // continues on its own (retry, compaction), so the session is still working.
      if (step.viewModel.status !== "failed" && event.yielded !== false) step.setStatus("idle");
      break;
    }

    case "message_start": {
      const message = event.message;
      if (message?.role === "user") {
        if (message.synthetic) break;
        step.push({
          type: "item.add",
          item: { kind: "user", id: nextItemId(step.viewModel), text: textOf(message.content) },
        });
      } else if (message?.role === "assistant") {
        const model = modelName(message);
        if (model !== step.viewModel.model) {
          step.push({ type: "model.set", model });
        }
      }
      break;
    }

    case "message_update": {
      const update = event.assistantMessageEvent;
      if (!update) break;
      if (update.type === "thinking_start") {
        step.push({
          type: "item.add",
          item: {
            kind: "thinking",
            id: nextItemId(step.viewModel),
            text: "",
            done: false,
            startedAt: now,
          },
        });
        break;
      }
      if (update.type === "thinking_delta") {
        const thinking = openThinking(step.viewModel);
        if (thinking && update.delta !== "") {
          step.push({ type: "item.appendText", itemId: thinking.id, text: update.delta });
        }
        const tokens = update.partial?.usage?.output ?? 0;
        if (thinking && tokens > 0) {
          step.push({ type: "thinking.tokens", itemId: thinking.id, tokens });
        }
        break;
      }
      if (update.type === "thinking_end") {
        const thinking = openThinking(step.viewModel);
        if (!thinking) break;
        // Deltas are the live path; the end event repairs any the stream dropped.
        const content = update.content ?? "";
        if (content.length > thinking.text.length && content.startsWith(thinking.text)) {
          step.push({
            type: "item.appendText",
            itemId: thinking.id,
            text: content.slice(thinking.text.length),
          });
        }
        const tokens = update.partial?.usage?.output ?? 0;
        step.push({
          type: "thinking.end",
          itemId: thinking.id,
          endedAt: now,
          ...(tokens > 0 ? { tokens } : {}),
        });
        break;
      }
      if (update.type !== "text_delta" || update.delta === "") break;
      const open = openAssistant(step.viewModel);
      if (open) {
        step.push({ type: "item.appendText", itemId: open.id, text: update.delta });
      } else {
        step.push({
          type: "item.add",
          item: {
            kind: "assistant",
            id: nextItemId(step.viewModel),
            text: update.delta,
            done: false,
          },
        });
      }
      break;
    }

    case "message_end": {
      const message = event.message;
      if (message?.role !== "assistant") break;
      const finalText = textOf(message.content);
      const u = message.usage;
      if (u) {
        const prev = step.viewModel.usage;
        step.push({
          type: "usage.set",
          usage: {
            inputTokens: prev.inputTokens + (u.input ?? 0),
            outputTokens: prev.outputTokens + (u.output ?? 0),
            cacheReadTokens: prev.cacheReadTokens + (u.cacheRead ?? 0),
            cacheWriteTokens: prev.cacheWriteTokens + (u.cacheWrite ?? 0),
            cost: prev.cost + (u.cost?.total ?? 0),
          },
        });
      }
      const open = assistantToClose(step.viewModel);
      if (open) {
        // Deltas are the live path; the final message repairs any the stream dropped.
        if (finalText.length > open.text.length && finalText.startsWith(open.text)) {
          step.push({
            type: "item.appendText",
            itemId: open.id,
            text: finalText.slice(open.text.length),
          });
        }
        step.push({ type: "item.done", itemId: open.id });
      } else if (finalText !== "") {
        step.push({
          type: "item.add",
          item: { kind: "assistant", id: nextItemId(step.viewModel), text: finalText, done: true },
        });
      }
      if (message.stopReason === "error") {
        step.setStatus("failed", message.errorMessage ?? "the model request failed");
      }
      break;
    }

    case "tool_execution_start": {
      // omp ids are unique per call. A start for an id that already has a call is a replay or a
      // bug upstream: it must not reopen or join the finished call, so it is ignored.
      if (findCall(step.viewModel, event.toolCallId)) break;
      const tool = event.toolName;
      const intent = event.intent?.trim() ? event.intent.trim() : undefined;
      const output = tool === "write" ? writeOutput(event.args) : undefined;
      const target = toolTarget(tool, event.args);
      const call: ToolCall = {
        toolCallId: event.toolCallId,
        status: "running",
        startedAt: now,
        ...(target === undefined ? {} : { target }),
        ...(output === undefined ? {} : { output }),
      };
      const last = step.viewModel.timeline[step.viewModel.timeline.length - 1];
      if (last?.kind === "tool" && joinsItem(last, tool, intent)) {
        step.push({ type: "tool.call.add", itemId: last.id, call });
      } else {
        step.push({
          type: "item.add",
          item: {
            kind: "tool",
            id: nextItemId(step.viewModel),
            tool,
            ...(intent === undefined ? {} : { intent }),
            calls: [call],
          },
        });
      }
      break;
    }

    case "tool_execution_update": {
      // Only a shell command has output worth showing before it ends.
      if (event.toolName !== "bash") break;
      const found = findCall(step.viewModel, event.toolCallId);
      if (found?.call.status !== "running") break;
      const output = shellOutput(toToolResult(event.partialResult, false));
      if (sameOutput(found.call.output, output)) break;
      step.push({
        type: "tool.call.update",
        itemId: found.item.id,
        toolCallId: event.toolCallId,
        patch: { output },
      });
      break;
    }

    case "tool_stream_update": {
      // The edit tool's diff preview. It can arrive before the call has started: nothing to show yet.
      const found = findCall(step.viewModel, event.toolCallId);
      if (found?.call.status !== "running") break;
      const output = diffFromStreamUpdate(event.update);
      if (!output || sameOutput(found.call.output, output)) break;
      step.push({
        type: "tool.call.update",
        itemId: found.item.id,
        toolCallId: event.toolCallId,
        patch: { output },
      });
      break;
    }

    case "tool_execution_end": {
      const found = findCall(step.viewModel, event.toolCallId);
      if (!found) break;
      const result = toToolResult(event.result, event.isError === true);
      const distilled = distill(event.toolName, result, found.call.target);
      // `write` shows what the call carried; its result only says how many bytes it wrote.
      const output = event.toolName === "write" ? found.call.output : distilled.output;
      step.push({
        type: "tool.call.update",
        itemId: found.item.id,
        toolCallId: event.toolCallId,
        patch: {
          status: result.isError ? "failed" : "done",
          endedAt: now,
          ...(output === undefined ? {} : { output }),
          ...(distilled.error === undefined ? {} : { error: distilled.error }),
        },
      });
      if (event.toolName === "todo" && !result.isError) {
        const phases = todoFromResult(result);
        if (phases) step.push({ type: "todo.set", todo: phases });
      }
      break;
    }

    case "todo_auto_clear":
      if (step.viewModel.todo.length > 0) step.push({ type: "todo.set", todo: [] });
      break;

    case "auto_compaction_start": {
      const item: CompactionItem = {
        kind: "compaction",
        id: nextItemId(step.viewModel),
        state: "running",
        reason: event.reason,
        action: event.action,
        startedAt: now,
      };
      step.push({ type: "item.add", item });
      break;
    }

    case "auto_compaction_end": {
      const active = latestActive(step.viewModel, "compaction");
      if (!active) break;
      const summary = event.result?.shortSummary;
      step.push({
        type: "item.patch",
        itemId: active.id,
        patch: {
          state: event.aborted
            ? "aborted"
            : event.skipped
              ? "skipped"
              : event.errorMessage
                ? "failed"
                : "done",
          endedAt: now,
          willRetry: event.willRetry,
          ...(event.result ? { tokensBefore: event.result.tokensBefore } : {}),
          ...(summary ? { summary } : {}),
          ...(event.errorMessage ? { error: oneLine(event.errorMessage) } : {}),
        },
      });
      break;
    }

    case "auto_retry_start": {
      step.setStatus("streaming");
      const active = latestActive(step.viewModel, "retry");
      const error = oneLine(event.errorMessage ?? "");
      if (active) {
        step.push({
          type: "item.patch",
          itemId: active.id,
          patch: {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            retryAt: now + event.delayMs,
            error,
          },
        });
      } else {
        const item: RetryItem = {
          kind: "retry",
          id: nextItemId(step.viewModel),
          state: "waiting",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          retryAt: now + event.delayMs,
          startedAt: now,
          error,
        };
        step.push({ type: "item.add", item });
      }
      break;
    }
    case "auto_retry_end": {
      const active = latestActive(step.viewModel, "retry");
      const cancelled = !event.success && event.finalError === RETRY_CANCELLED;
      if (active) {
        step.push({
          type: "item.patch",
          itemId: active.id,
          patch: {
            state: event.success ? "recovered" : cancelled ? "cancelled" : "failed",
            endedAt: now,
            ...(!event.success && !cancelled && event.finalError
              ? { error: oneLine(event.finalError) }
              : {}),
          },
        });
      }
      if (event.success) break;
      if (event.finalError === RETRY_CANCELLED) {
        // The user stopped the session while it waited to retry: that is a stop, not a failure.
        const open = assistantToClose(step.viewModel);
        if (open) step.push({ type: "item.done", itemId: open.id });
        step.setStatus("idle");
      } else {
        step.setStatus("failed", event.finalError ?? "retries exhausted");
      }
      break;
    }

    default:
      break;
  }
  return step.done();
}

/** `model_changed` carries no payload, so the caller reads the session's model and passes it in. */
export function reduceModel(viewModel: SessionViewModel, model: string | null): Reduced {
  return viewModel.model === model
    ? { viewModel, ops: [] }
    : {
        viewModel: applyOp(viewModel, { type: "model.set", model }),
        ops: [{ type: "model.set", model }],
      };
}

/** View model of a session nothing has happened in yet. */
export function emptyViewModel(init: {
  id: string;
  cwd: string;
  model: string | null;
  usage?: SessionViewModel["usage"];
  context?: SessionViewModel["context"];
}): SessionViewModel {
  return {
    id: init.id,
    cwd: init.cwd,
    status: "idle",
    model: init.model,
    timeline: [],
    warnings: [],
    usage: init.usage ?? EMPTY_USAGE,
    context: init.context ?? null,
    todo: [],
    pending: [],
  };
}
