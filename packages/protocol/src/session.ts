/**
 * Session state sync. The sidecar owns one view model per session and publishes it as a full
 * snapshot (on subscribe) followed by ordered ops, each carrying a per-session `seq`.
 * A replica applies ops with `applyOp`; a `seq` gap means "ask for a fresh snapshot".
 *
 * Extending: add a new `Item` kind or a new `SessionOp` type and handle it in `applyOp`.
 * Existing kinds and ops keep their shape; `applyOp` ignores ops it does not know, so an
 * older replica never breaks on a newer op.
 */
import { isRecord } from "./guards";
import { type Attachment, isAttachment, isQueueState, type QueueState, sameQueue } from "./prompt";
import {
  type DecisionItem,
  isDecisionItem,
  isPendingRequest,
  type PendingRequest,
} from "./requests";
import {
  type CompactionItem,
  type ContextFill,
  isContextFill,
  isSessionUsage,
  isTimelineItem,
  isTodoPhase,
  type RetryItem,
  type SessionUsage,
  type ThinkingItem,
  type TodoPhase,
  type ToolCall,
  type ToolItem,
} from "./timeline";

export type SessionStatus = "idle" | "streaming" | "failed";

export interface UserItem {
  readonly kind: "user";
  readonly id: string;
  readonly text: string;
  /** True when the message was injected into a turn already running (a steer). */
  readonly steered?: boolean;
  /** Images and files that went with the message. Absent when there were none. */
  readonly attachments?: readonly Attachment[];
  /**
   * Paths of the `@` references omp actually read for this message (its `fileMention` message).
   * Absent when it read none. A reference typed into a message that joined a running turn is not
   * read (`joinActiveTurn` queues the raw text), so it never appears here.
   */
  readonly files?: readonly string[];
}

export interface AssistantItem {
  readonly kind: "assistant";
  readonly id: string;
  readonly text: string;
  /** False while the assistant message is still streaming. */
  readonly done: boolean;
}

/** One entry of the timeline. Discriminated by `kind`. */
export type Item =
  | UserItem
  | AssistantItem
  | ToolItem
  | ThinkingItem
  | CompactionItem
  | RetryItem
  | DecisionItem;

/** The fields of a status event an `item.patch` may change. `kind` and `id` never change. */
export type StatusItemPatch =
  | Partial<Omit<CompactionItem, "kind" | "id">>
  | Partial<Omit<RetryItem, "kind" | "id">>;

/** The fields of a tool call an update may change. `toolCallId` never changes. */
export type ToolCallPatch = Partial<Omit<ToolCall, "toolCallId">>;

/**
 * A non-blocking problem the session carries on despite. `source` says who raised it, so a
 * later ticket can add kinds (e.g. tool calls) without reinterpreting the others.
 */
export type SessionWarning =
  | {
      readonly source: "mcp";
      /** Name of the MCP server, as written in `mcp.json`. */
      readonly server: string;
      readonly message: string;
    }
  | {
      /** The sidecar noting something about the session itself (what was left out of its history, a move to a new file). */
      readonly source: "session";
      readonly title: string;
      readonly message: string;
    };

export interface SessionViewModel {
  readonly id: string;
  readonly cwd: string;
  readonly status: SessionStatus;
  /** Why the session is `failed`. Absent in every other status. */
  readonly error?: string;
  /** `provider/id` of the active model, or null when the session has none. */
  readonly model: string | null;
  /**
   * The thinking level the person chose for the session: `auto`, `off` or one of the model's
   * levels. Null until omp reports one. What the model accepts is `session.models`.
   */
  readonly thinking: string | null;
  readonly timeline: readonly Item[];
  /** Append-only, in the order they were raised. */
  readonly warnings: readonly SessionWarning[];
  /** Summed over every assistant message of the session so far. */
  readonly usage: SessionUsage;
  /** Null until omp can measure it (before the first model reply, or for a model without a window). */
  readonly context: ContextFill | null;
  /** The session's todo list as omp last reported it; empty when there is none. */
  readonly todo: readonly TodoPhase[];
  /**
   * Requests the agent is blocked on, oldest first. The first one is the one the person
   * answers; the rest wait their turn. A request that stops mattering is removed, not kept.
   */
  readonly pending: readonly PendingRequest[];
  /** Input waiting for the running turn: steering and follow-ups, as omp reports it. */
  readonly queue: QueueState;
}

/** A change to the view model. Discriminated by `type`. */
export type SessionOp =
  | { readonly type: "item.add"; readonly item: Item }
  | { readonly type: "item.appendText"; readonly itemId: string; readonly text: string }
  | { readonly type: "item.done"; readonly itemId: string }
  /** The files omp read for a user message, as its `fileMention` message reports them. */
  | { readonly type: "user.files"; readonly itemId: string; readonly files: readonly string[] }
  | {
      readonly type: "status.set";
      readonly status: SessionStatus;
      readonly error?: string;
    }
  | { readonly type: "model.set"; readonly model: string | null }
  | { readonly type: "thinking.set"; readonly thinking: string | null }
  | { readonly type: "queue.set"; readonly queue: QueueState }
  | { readonly type: "warning.add"; readonly warning: SessionWarning }
  /** Adds a call to a tool item that is already on the timeline (a grouped line). */
  | { readonly type: "tool.call.add"; readonly itemId: string; readonly call: ToolCall }
  | {
      readonly type: "tool.call.update";
      readonly itemId: string;
      readonly toolCallId: string;
      readonly patch: ToolCallPatch;
    }
  /** Closes a thinking item. `tokens` is what the provider counted for the reasoning, if it did. */
  | {
      readonly type: "thinking.end";
      readonly itemId: string;
      readonly endedAt: number;
      readonly tokens?: number;
    }
  /** Tokens the provider has counted so far for an open thinking item. */
  | { readonly type: "thinking.tokens"; readonly itemId: string; readonly tokens: number }
  /** Shallow-merges into a compaction or retry item. */
  | { readonly type: "item.patch"; readonly itemId: string; readonly patch: StatusItemPatch }
  | { readonly type: "usage.set"; readonly usage: SessionUsage }
  | { readonly type: "context.set"; readonly context: ContextFill | null }
  | { readonly type: "todo.set"; readonly todo: readonly TodoPhase[] }
  | { readonly type: "request.add"; readonly request: PendingRequest }
  /**
   * Removes a pending request. `item` is the one-line event it leaves behind when a person
   * answered; absent when the request simply stopped mattering (turn cancelled, steered).
   */
  | {
      readonly type: "request.settle";
      readonly requestId: string;
      readonly item?: DecisionItem;
    }
  /**
   * The session now lives under another id: another omp process owns its file, so omp keeps
   * saving to a new one. This op is delivered under the old id; every later op uses `id`, and
   * `seq` carries on. Applying it sets `vm.id`.
   */
  | { readonly type: "session.moved"; readonly id: string };

/** Full state of a session at `seq`: the number of ops applied since it was created. */
export interface SessionSnapshot {
  readonly snapshot: SessionViewModel;
  readonly seq: number;
}

/** Payload of the `session.op` event. `seq` increases by one per op, per session. */
export interface SessionOpEvent {
  readonly sessionId: string;
  readonly seq: number;
  readonly op: SessionOp;
}

function updateItem(
  vm: SessionViewModel,
  itemId: string,
  update: (item: Item) => Item,
): SessionViewModel {
  // The streaming item is almost always at the end, so search backwards.
  for (let i = vm.timeline.length - 1; i >= 0; i--) {
    const item = vm.timeline[i];
    if (item?.id !== itemId) continue;
    const next = update(item);
    if (next === item) return vm;
    const timeline = vm.timeline.slice();
    timeline[i] = next;
    return { ...vm, timeline };
  }
  return vm;
}

/**
 * Pure and immutable: items and fields an op does not touch keep their identity, so selectors
 * on a replica only fire for what changed. Unknown ops and unknown item ids are no-ops.
 */
export function applyOp(vm: SessionViewModel, op: SessionOp): SessionViewModel {
  switch (op.type) {
    case "item.add":
      return { ...vm, timeline: [...vm.timeline, op.item] };
    case "item.appendText":
      return updateItem(vm, op.itemId, (item) =>
        item.kind === "assistant" || item.kind === "user" || item.kind === "thinking"
          ? { ...item, text: item.text + op.text }
          : item,
      );
    case "item.done":
      return updateItem(vm, op.itemId, (item) =>
        item.kind === "assistant" && !item.done ? { ...item, done: true } : item,
      );
    case "user.files":
      return updateItem(vm, op.itemId, (item) =>
        item.kind === "user" ? { ...item, files: op.files } : item,
      );
    case "status.set": {
      const { error: _previous, ...rest } = vm;
      return { ...rest, status: op.status, ...(op.error === undefined ? {} : { error: op.error }) };
    }
    case "model.set":
      return vm.model === op.model ? vm : { ...vm, model: op.model };
    case "thinking.set":
      return vm.thinking === op.thinking ? vm : { ...vm, thinking: op.thinking };
    case "queue.set":
      return sameQueue(vm.queue, op.queue) ? vm : { ...vm, queue: op.queue };
    case "warning.add":
      return { ...vm, warnings: [...vm.warnings, op.warning] };
    case "tool.call.add":
      return updateItem(vm, op.itemId, (item) =>
        item.kind === "tool" ? { ...item, calls: [...item.calls, op.call] } : item,
      );
    case "tool.call.update":
      return updateItem(vm, op.itemId, (item) => {
        if (item.kind !== "tool") return item;
        const at = item.calls.findIndex((c) => c.toolCallId === op.toolCallId);
        const call = item.calls[at];
        if (!call) return item;
        const calls = item.calls.slice();
        calls[at] = { ...call, ...op.patch };
        return { ...item, calls };
      });
    case "thinking.end":
      return updateItem(vm, op.itemId, (item) =>
        item.kind === "thinking" && !item.done
          ? {
              ...item,
              done: true,
              endedAt: op.endedAt,
              ...(op.tokens === undefined ? {} : { tokens: op.tokens }),
            }
          : item,
      );
    case "thinking.tokens":
      return updateItem(vm, op.itemId, (item) =>
        item.kind === "thinking" && item.tokens !== op.tokens
          ? { ...item, tokens: op.tokens }
          : item,
      );
    case "item.patch":
      return updateItem(vm, op.itemId, (item) =>
        item.kind === "compaction" || item.kind === "retry"
          ? ({ ...item, ...op.patch } as Item)
          : item,
      );
    case "usage.set":
      return { ...vm, usage: op.usage };
    case "context.set":
      return { ...vm, context: op.context };
    case "todo.set":
      return { ...vm, todo: op.todo };
    case "request.add":
      return vm.pending.some((r) => r.id === op.request.id)
        ? vm
        : { ...vm, pending: [...vm.pending, op.request] };
    case "request.settle": {
      if (!vm.pending.some((r) => r.id === op.requestId)) return vm;
      const pending = vm.pending.filter((r) => r.id !== op.requestId);
      return op.item ? { ...vm, pending, timeline: [...vm.timeline, op.item] } : { ...vm, pending };
    }
    case "session.moved":
      return { ...vm, id: op.id };
    default:
      return vm;
  }
}

function isWarning(v: unknown): v is SessionWarning {
  if (!isRecord(v) || typeof v.message !== "string") return false;
  if (v.source === "mcp") return typeof v.server === "string";
  return v.source === "session" && typeof v.title === "string";
}

function isItem(v: unknown): v is Item {
  if (!isRecord(v) || typeof v.id !== "string") return false;
  if (v.kind === "user") {
    return (
      typeof v.text === "string" &&
      (v.steered === undefined || typeof v.steered === "boolean") &&
      (v.attachments === undefined ||
        (Array.isArray(v.attachments) && v.attachments.every(isAttachment))) &&
      (v.files === undefined ||
        (Array.isArray(v.files) && v.files.every((f) => typeof f === "string")))
    );
  }
  if (v.kind === "assistant") return typeof v.text === "string" && typeof v.done === "boolean";
  if (v.kind === "decision") return isDecisionItem(v);
  return isTimelineItem(v);
}

export function isSessionViewModel(v: unknown): v is SessionViewModel {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    typeof v.cwd === "string" &&
    (v.status === "idle" || v.status === "streaming" || v.status === "failed") &&
    (v.error === undefined || typeof v.error === "string") &&
    (v.model === null || typeof v.model === "string") &&
    (v.thinking === null || typeof v.thinking === "string") &&
    isQueueState(v.queue) &&
    Array.isArray(v.timeline) &&
    v.timeline.every(isItem) &&
    Array.isArray(v.warnings) &&
    v.warnings.every(isWarning) &&
    isSessionUsage(v.usage) &&
    (v.context === null || isContextFill(v.context)) &&
    Array.isArray(v.todo) &&
    v.todo.every(isTodoPhase) &&
    Array.isArray(v.pending) &&
    v.pending.every(isPendingRequest)
  );
}

export function isSessionSnapshot(v: unknown): v is SessionSnapshot {
  return isRecord(v) && typeof v.seq === "number" && isSessionViewModel(v.snapshot);
}

export function isSessionOpEvent(v: unknown): v is SessionOpEvent {
  return (
    isRecord(v) &&
    typeof v.sessionId === "string" &&
    typeof v.seq === "number" &&
    isRecord(v.op) &&
    typeof v.op.type === "string"
  );
}
