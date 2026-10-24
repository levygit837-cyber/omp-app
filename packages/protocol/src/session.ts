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

export type SessionStatus = "idle" | "streaming" | "failed";

export interface UserItem {
  readonly kind: "user";
  readonly id: string;
  readonly text: string;
}

export interface AssistantItem {
  readonly kind: "assistant";
  readonly id: string;
  readonly text: string;
  /** False while the assistant message is still streaming. */
  readonly done: boolean;
}

/** One entry of the timeline. Discriminated by `kind`. */
export type Item = UserItem | AssistantItem;

/**
 * A non-blocking problem the session carries on despite. `source` says who raised it, so a
 * later ticket can add kinds (e.g. tool calls) without reinterpreting this one.
 */
export interface SessionWarning {
  readonly source: "mcp";
  /** Name of the MCP server, as written in `mcp.json`. */
  readonly server: string;
  readonly message: string;
}

export interface SessionViewModel {
  readonly id: string;
  readonly cwd: string;
  readonly status: SessionStatus;
  /** Why the session is `failed`. Absent in every other status. */
  readonly error?: string;
  /** `provider/id` of the active model, or null when the session has none. */
  readonly model: string | null;
  readonly timeline: readonly Item[];
  /** Append-only, in the order they were raised. */
  readonly warnings: readonly SessionWarning[];
}

/** A change to the view model. Discriminated by `type`. */
export type SessionOp =
  | { readonly type: "item.add"; readonly item: Item }
  | { readonly type: "item.appendText"; readonly itemId: string; readonly text: string }
  | { readonly type: "item.done"; readonly itemId: string }
  | {
      readonly type: "status.set";
      readonly status: SessionStatus;
      readonly error?: string;
    }
  | { readonly type: "model.set"; readonly model: string | null }
  | { readonly type: "warning.add"; readonly warning: SessionWarning };

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
        item.kind === "assistant" || item.kind === "user"
          ? { ...item, text: item.text + op.text }
          : item,
      );
    case "item.done":
      return updateItem(vm, op.itemId, (item) =>
        item.kind === "assistant" && !item.done ? { ...item, done: true } : item,
      );
    case "status.set": {
      const { error: _previous, ...rest } = vm;
      return { ...rest, status: op.status, ...(op.error === undefined ? {} : { error: op.error }) };
    }
    case "model.set":
      return vm.model === op.model ? vm : { ...vm, model: op.model };
    case "warning.add":
      return { ...vm, warnings: [...vm.warnings, op.warning] };
    default:
      return vm;
  }
}

function isWarning(v: unknown): v is SessionWarning {
  return (
    isRecord(v) &&
    v.source === "mcp" &&
    typeof v.server === "string" &&
    typeof v.message === "string"
  );
}

function isItem(v: unknown): v is Item {
  if (!isRecord(v) || typeof v.id !== "string") return false;
  if (v.kind === "user") return typeof v.text === "string";
  if (v.kind === "assistant") return typeof v.text === "string" && typeof v.done === "boolean";
  return false;
}

export function isSessionViewModel(v: unknown): v is SessionViewModel {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    typeof v.cwd === "string" &&
    (v.status === "idle" || v.status === "streaming" || v.status === "failed") &&
    (v.error === undefined || typeof v.error === "string") &&
    (v.model === null || typeof v.model === "string") &&
    Array.isArray(v.timeline) &&
    v.timeline.every(isItem) &&
    Array.isArray(v.warnings) &&
    v.warnings.every(isWarning)
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
