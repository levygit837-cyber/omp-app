import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@oh-my-pi/pi-utils/acp";
import {
  type AskAction,
  type AskContent,
  type AskField,
  decisionForPermission,
  type PermissionOption,
  type PermissionRequest,
  STALE_REQUEST_MESSAGE,
} from "@omp-app/protocol";
import { checkAnswer, fieldsOf, summarize } from "./ask-schema";
import type { SessionStore } from "./session-store";

/** What the `session.answer*` handlers and the lifecycle hooks need from the registry. */
export interface RequestAnswers {
  answerPermission(sessionId: string, requestId: string, optionId: string): void;
  answerAsk(
    sessionId: string,
    requestId: string,
    action: AskAction,
    content: AskContent | undefined,
  ): void;
  /** The turn is over (or was cancelled): nothing the agent asked is still waiting. */
  dismissSession(sessionId: string): void;
  /** Feeds the agent events that say a request no longer matters. */
  agentEvent(sessionId: string, event: AgentSessionEvent): void;
}

const KINDS: Record<string, true> = {
  allow_once: true,
  allow_always: true,
  reject_once: true,
  reject_always: true,
};

interface Held {
  readonly sessionId: string;
  readonly requestId: string;
  /** Which answer command may settle it; the other one gets `stale request`. */
  readonly kind: "permission" | "ask";
  readonly subject: string;
  /** Resolves the ACP request that omp is blocked on. */
  readonly respond: (answer: Answer) => void;
  readonly toolCallId?: string;
  readonly toolKind?: string;
  /** Present on permissions: the options a valid answer must pick from. */
  readonly options?: readonly PermissionOption[];
  /** Present on asks: the fields a valid answer is checked against. */
  readonly fields?: readonly AskField[];
  readonly cleanup: () => void;
}

type Answer =
  | { readonly kind: "permission"; readonly optionId: string }
  | { readonly kind: "ask"; readonly action: AskAction; readonly content?: AskContent }
  | { readonly kind: "withdrawn" };

/** The exact payload of a gated call: the command if omp sent one, else its raw input. */
function payloadOf(call: RequestPermissionRequest["toolCall"]): string {
  const input = call.rawInput;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const command = (input as Record<string, unknown>).command;
    if (typeof command === "string" && command.length > 0) return command;
  }
  for (const part of call.content ?? []) {
    if (part.type === "content" && part.content.type === "text") return part.content.text;
  }
  return JSON.stringify(input ?? null, null, 2);
}

/** A decision is one line of the chat: a long question (a plan to approve) keeps its first line. */
const firstLine = (message: string): string =>
  message
    .split("\n")
    .find((line) => line.trim() !== "")
    ?.trim() ?? message;

/**
 * Holds what the agent is blocked on. The ACP client handlers register a request here and wait
 * on the promise it returns; the view model shows it (`pending`) until a person answers or it
 * stops mattering. Every way out removes the entry, so nothing lingers:
 * - answered through `answerPermission`/`answerAsk` (leaves a one-line decision);
 * - withdrawn by omp (`$/cancel_request` on a steer: the abort signal), by the tool ending,
 *   or by the turn ending or being cancelled (leaves nothing).
 * Form elicitations have no cancel message in ACP, so turn and tool end are the only signals.
 */
export class RequestRegistry implements RequestAnswers {
  readonly #store: SessionStore;
  readonly #now: () => number;
  readonly #held = new Map<string, Held>();
  #next = 0;

  constructor(store: SessionStore, now: () => number = Date.now) {
    this.#store = store;
    this.#now = now;
  }

  /** `session/request_permission`: resolves with the person's pick, or `cancelled`. */
  permission(
    params: RequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    const options = params.options.filter((o) => KINDS[o.kind]) as PermissionOption[];
    if (!this.#store.has(params.sessionId) || options.length === 0 || signal?.aborted) {
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    }
    const requestId = `req-${++this.#next}`;
    const call = params.toolCall;
    const title = call.title ?? call.toolCallId;
    const request: PermissionRequest = {
      kind: "permission",
      id: requestId,
      toolCallId: call.toolCallId,
      title,
      ...(call.kind ? { toolKind: call.kind } : {}),
      payload: payloadOf(call),
      paths: (call.locations ?? []).map((l) => l.path),
      options,
      raisedAt: this.#now(),
    };
    const { promise, resolve } = Promise.withResolvers<RequestPermissionResponse>();
    const withdraw = () => this.#withdraw(requestId);
    signal?.addEventListener("abort", withdraw, { once: true });
    this.#held.set(requestId, {
      sessionId: params.sessionId,
      requestId,
      kind: "permission",
      subject: title,
      toolCallId: call.toolCallId,
      ...(call.kind ? { toolKind: call.kind } : {}),
      options,
      respond: (answer) =>
        resolve(
          answer.kind === "permission"
            ? { outcome: { outcome: "selected", optionId: answer.optionId } }
            : { outcome: { outcome: "cancelled" } },
        ),
      cleanup: () => signal?.removeEventListener("abort", withdraw),
    });
    this.#store.addRequest(params.sessionId, request);
    return promise;
  }

  /** `elicitation/create`: resolves with the filled form, or a decline. */
  elicitation(params: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    const decline: CreateElicitationResponse = { action: "decline" };
    if (!this.#store.has(params.sessionId)) return Promise.resolve({ action: "cancel" });
    const schema = "requestedSchema" in params ? params.requestedSchema : undefined;
    const fields = params.mode === "form" && schema ? fieldsOf(schema) : undefined;
    if (!fields) {
      // A form that drops a question would answer a different one; say no instead.
      console.error(`[sidecar] elicitation declined: schema not renderable (${params.message})`);
      return Promise.resolve(decline);
    }
    const requestId = `req-${++this.#next}`;
    const { promise, resolve } = Promise.withResolvers<CreateElicitationResponse>();
    this.#held.set(requestId, {
      sessionId: params.sessionId,
      requestId,
      kind: "ask",
      subject: firstLine(params.message),
      fields,
      respond: (answer) =>
        resolve(
          answer.kind === "ask" && answer.action === "accept" && answer.content
            ? { action: "accept", content: answer.content as Record<string, never> }
            : answer.kind === "ask"
              ? decline
              : { action: "cancel" },
        ),
      cleanup: () => {},
    });
    this.#store.addRequest(params.sessionId, {
      kind: "ask",
      id: requestId,
      message: params.message,
      fields,
      raisedAt: this.#now(),
    });
    return promise;
  }

  answerPermission(sessionId: string, requestId: string, optionId: string): void {
    const held = this.#take(sessionId, requestId, "permission");
    const option = held.options?.find((o) => o.optionId === optionId);
    if (!option) {
      this.#held.set(requestId, held); // a bad answer leaves the request waiting
      throw new Error(`not an offered option: ${optionId}`);
    }
    held.cleanup();
    this.#store.settleRequest(sessionId, requestId, {
      outcome: decisionForPermission(option.kind),
      subject: held.subject,
      ...(held.toolKind ? { toolKind: held.toolKind } : {}),
    });
    held.respond({ kind: "permission", optionId });
  }

  answerAsk(
    sessionId: string,
    requestId: string,
    action: AskAction,
    content: AskContent | undefined,
  ): void {
    const held = this.#take(sessionId, requestId, "ask");
    let checked: AskContent | undefined;
    if (action === "accept") {
      try {
        checked = checkAnswer(held.fields ?? [], content ?? {});
      } catch (error) {
        this.#held.set(requestId, held); // a bad answer leaves the form waiting
        throw error;
      }
    }
    held.cleanup();
    const detail = checked ? summarize(held.fields ?? [], checked) : "";
    this.#store.settleRequest(sessionId, requestId, {
      outcome: action === "accept" ? "answered" : "cancelled",
      subject: held.subject,
      ...(detail ? { detail } : {}),
    });
    held.respond({ kind: "ask", action, ...(checked ? { content: checked } : {}) });
  }

  dismissSession(sessionId: string): void {
    for (const held of [...this.#held.values()]) {
      if (held.sessionId === sessionId) this.#withdraw(held.requestId);
    }
  }

  /** Feeds the events that say a request no longer matters. Called by the session bridge. */
  agentEvent(sessionId: string, event: AgentSessionEvent): void {
    if (event.type === "agent_end") {
      this.dismissSession(sessionId);
    } else if (event.type === "tool_execution_end") {
      for (const held of [...this.#held.values()]) {
        if (held.sessionId !== sessionId) continue;
        // An ask form carries no tool call id: the `ask` tool ending closes its forms.
        if (held.toolCallId === event.toolCallId || (held.fields && event.toolName === "ask")) {
          this.#withdraw(held.requestId);
        }
      }
    }
  }

  #take(sessionId: string, requestId: string, kind: Held["kind"]): Held {
    const held = this.#held.get(requestId);
    // Another session's id, or the other kind of request, is not this caller's to answer.
    if (!held || held.sessionId !== sessionId || held.kind !== kind) {
      throw new Error(`${STALE_REQUEST_MESSAGE}: ${requestId}`);
    }
    this.#held.delete(requestId);
    return held;
  }

  /** The request stopped mattering: drop it without a decision and tell omp it was cancelled. */
  #withdraw(requestId: string): void {
    const held = this.#held.get(requestId);
    if (!held) return;
    this.#held.delete(requestId);
    held.cleanup();
    this.#store.settleRequest(held.sessionId, requestId);
    held.respond({ kind: "withdrawn" });
  }
}
