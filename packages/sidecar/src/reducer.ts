import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { applyOp, type SessionOp, type SessionViewModel } from "@omp-app/protocol";

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
  let text = "";
  for (const part of content) {
    if (part.type === "text") text += part.text;
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

const modelName = (m: AssistantMessage): string => `${m.provider}/${m.model}`;

/**
 * `finalError` of the `auto_retry_end` omp emits when a stop (`abort`) interrupts a retry's
 * credential wait or backoff sleep (`turn-recovery.ts`, `#endCancelledRetry`). It is the only
 * signal that tells a user stop from a retry that ran out of attempts, so it is matched
 * exactly; the replay tests pin it to the installed omp.
 */
export const RETRY_CANCELLED = "Retry cancelled";

/**
 * Pure: no I/O, no clock, no randomness. Maps one `AgentSessionEvent` to the ops that keep the
 * view model in step. Events the view model has no place for yet (tool calls, thinking,
 * compaction, ...) produce no ops. A later ticket adds a case here and an op in the protocol.
 */
export function reduceEvent(viewModel: SessionViewModel, event: AgentSessionEvent): Reduced {
  const step = new Step(viewModel);
  switch (event.type) {
    case "agent_start":
      step.setStatus("streaming");
      break;

    case "agent_end": {
      const open = openAssistant(step.viewModel);
      if (open) step.push({ type: "item.done", itemId: open.id });
      // A failure stays visible until the next run starts. `yielded: false` means the agent
      // continues on its own (retry, compaction), so the session is still working.
      if (step.viewModel.status !== "failed" && event.yielded !== false) step.setStatus("idle");
      break;
    }

    case "message_start": {
      const message = event.message;
      if (message.role === "user") {
        if (message.synthetic) break;
        step.push({
          type: "item.add",
          item: { kind: "user", id: nextItemId(step.viewModel), text: textOf(message.content) },
        });
      } else if (message.role === "assistant") {
        const model = modelName(message);
        if (model !== step.viewModel.model) {
          step.push({ type: "model.set", model });
        }
      }
      break;
    }

    case "message_update": {
      const update = event.assistantMessageEvent;
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
      if (message.role !== "assistant") break;
      const finalText = textOf(message.content);
      const open = openAssistant(step.viewModel);
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

    case "auto_retry_start":
      step.setStatus("streaming");
      break;
    case "auto_retry_end":
      if (event.success) break;
      if (event.finalError === RETRY_CANCELLED) {
        // The user stopped the session while it waited to retry: that is a stop, not a failure.
        const open = openAssistant(step.viewModel);
        if (open) step.push({ type: "item.done", itemId: open.id });
        step.setStatus("idle");
      } else {
        step.setStatus("failed", event.finalError ?? "retries exhausted");
      }
      break;

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
}): SessionViewModel {
  return { id: init.id, cwd: init.cwd, status: "idle", model: init.model, timeline: [] };
}
