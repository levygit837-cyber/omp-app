import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { SessionViewModel } from "@omp-app/protocol";
import { emptyViewModel, RETRY_CANCELLED, reduceEvent, reduceModel } from "../src/reducer";

type Event<T extends AgentSessionEvent["type"]> = Extract<AgentSessionEvent, { type: T }>;
type Assistant = Extract<Event<"message_end">["message"], { role: "assistant" }>;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO_COST };

function assistant(patch: Partial<Assistant> & { text?: string } = {}): Assistant {
  const { text = "", ...rest } = patch;
  return {
    role: "assistant",
    content: text === "" ? [] : [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "p",
    model: "m",
    usage: USAGE,
    stopReason: "stop",
    timestamp: 0,
    ...rest,
  };
}

const agentStart: AgentSessionEvent = { type: "agent_start" };
const agentEnd = (extra: { yielded?: boolean } = {}): AgentSessionEvent => ({
  type: "agent_end",
  messages: [],
  ...extra,
});
const userStart = (text: string, synthetic?: boolean): AgentSessionEvent => ({
  type: "message_start",
  message: { role: "user", content: text, timestamp: 0, ...(synthetic ? { synthetic } : {}) },
});
const assistantStart = (message = assistant()): AgentSessionEvent => ({
  type: "message_start",
  message,
});
const delta = (text: string): AgentSessionEvent => ({
  type: "message_update",
  message: assistant(),
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: assistant() },
});
const thinkingDelta = (text: string): AgentSessionEvent => ({
  type: "message_update",
  message: assistant(),
  assistantMessageEvent: {
    type: "thinking_delta",
    contentIndex: 0,
    delta: text,
    partial: assistant(),
  },
});
const assistantEnd = (message: Assistant): AgentSessionEvent => ({ type: "message_end", message });
const retryStart: AgentSessionEvent = {
  type: "auto_retry_start",
  attempt: 1,
  maxAttempts: 3,
  delayMs: 1000,
  errorMessage: "overloaded",
};
const retryEnd = (success: boolean, finalError?: string): AgentSessionEvent => ({
  type: "auto_retry_end",
  success,
  attempt: 1,
  ...(finalError === undefined ? {} : { finalError }),
});

const start = (): SessionViewModel => emptyViewModel({ id: "s", cwd: "/w", model: null });

/** Feeds events through the reducer, as the store does: each step sees the previous model. */
function run(
  events: readonly AgentSessionEvent[],
  from = start(),
  clock: () => number = () => 1000,
) {
  let viewModel = from;
  const ops = events.flatMap((event) => {
    const reduced = reduceEvent(viewModel, event, clock());
    viewModel = reduced.viewModel;
    return reduced.ops;
  });
  return { viewModel, ops };
}

describe("reduceEvent, synthetic events", () => {
  test("a plain answer: user item, streamed assistant item, closed, idle", () => {
    const { viewModel } = run([
      agentStart,
      userStart("hi"),
      assistantStart(),
      delta("po"),
      delta("ng"),
      assistantEnd(assistant({ text: "pong" })),
      agentEnd({ yielded: true }),
    ]);
    expect(viewModel.status).toBe("idle");
    expect(viewModel.model).toBe("p/m");
    expect(viewModel.timeline).toEqual([
      { kind: "user", id: "i0", text: "hi" },
      { kind: "assistant", id: "i1", text: "pong", done: true },
    ]);
  });

  test("synthetic user messages (auto-continue) are not shown", () => {
    const { viewModel, ops } = run([userStart("keep going", true)]);
    expect(ops).toEqual([]);
    expect(viewModel.timeline).toEqual([]);
  });

  test("thinking deltas and unknown event types produce no ops", () => {
    const { ops } = run([
      thinkingDelta("hmm"),
      { type: "turn_start" },
      { type: "advisor_cost_changed" },
    ]);
    expect(ops).toEqual([]);
  });

  test("an empty text delta is ignored", () => {
    expect(run([delta("")]).ops).toEqual([]);
  });

  test("message_end repairs deltas the stream dropped", () => {
    const { viewModel } = run([
      agentStart,
      assistantStart(),
      delta("hel"),
      assistantEnd(assistant({ text: "hello world" })),
    ]);
    expect(viewModel.timeline).toEqual([
      { kind: "assistant", id: "i0", text: "hello world", done: true },
    ]);
  });

  test("message_end with no streamed text adds the final message already closed", () => {
    const { viewModel } = run([assistantEnd(assistant({ text: "whole" }))]);
    expect(viewModel.timeline).toEqual([
      { kind: "assistant", id: "i0", text: "whole", done: true },
    ]);
  });

  test("message_end of a non-assistant message changes nothing", () => {
    const { ops } = run([
      { type: "message_end", message: { role: "user", content: "x", timestamp: 0 } },
    ]);
    expect(ops).toEqual([]);
  });

  test("a second assistant message after the first is closed gets its own item", () => {
    const { viewModel } = run([
      assistantStart(),
      delta("one"),
      assistantEnd(assistant({ text: "one" })),
      assistantStart(),
      delta("two"),
      assistantEnd(assistant({ text: "two" })),
    ]);
    expect(viewModel.timeline.map((i) => i.kind === "assistant" && i.text)).toEqual(["one", "two"]);
    expect(viewModel.timeline.map((i) => i.id)).toEqual(["i0", "i1"]);
  });
});

describe("reduceEvent, stop reasons", () => {
  test("stopReason error fails the session with the model's message and keeps the partial text", () => {
    const { viewModel } = run([
      agentStart,
      assistantStart(),
      delta("part"),
      assistantEnd(assistant({ text: "part", stopReason: "error", errorMessage: "rate limited" })),
      agentEnd({ yielded: true }),
    ]);
    expect(viewModel.status).toBe("failed");
    expect(viewModel.error).toBe("rate limited");
    expect(viewModel.timeline).toEqual([{ kind: "assistant", id: "i0", text: "part", done: true }]);
  });

  test("stopReason error without a message still says why", () => {
    const { viewModel } = run([assistantEnd(assistant({ stopReason: "error" }))]);
    expect(viewModel.status).toBe("failed");
    expect(viewModel.error).toBe("the model request failed");
  });

  test("a failure stays visible through agent_end and clears when the next run starts", () => {
    const failed = run([
      agentStart,
      assistantEnd(assistant({ stopReason: "error", errorMessage: "boom" })),
      agentEnd({ yielded: true }),
    ]).viewModel;
    expect(failed.status).toBe("failed");
    const next = run([agentStart], failed).viewModel;
    expect(next.status).toBe("streaming");
    expect(next.error).toBeUndefined();
  });

  test.each(["stop", "length", "toolUse", "aborted"] as const)(
    "stopReason %s is not a failure",
    (stopReason) => {
      const { viewModel } = run([
        agentStart,
        assistantStart(),
        delta("x"),
        assistantEnd(assistant({ text: "x", stopReason })),
        agentEnd({ yielded: true }),
      ]);
      expect(viewModel.status).toBe("idle");
      expect(viewModel.error).toBeUndefined();
    },
  );

  test("agent_end closes an item message_end never closed", () => {
    const { viewModel } = run([
      agentStart,
      assistantStart(),
      delta("cut"),
      agentEnd({ yielded: true }),
    ]);
    expect(viewModel.timeline).toEqual([{ kind: "assistant", id: "i0", text: "cut", done: true }]);
    expect(viewModel.status).toBe("idle");
  });

  test("agent_end with yielded:false keeps the session streaming (the agent continues alone)", () => {
    const { viewModel } = run([agentStart, agentEnd({ yielded: false })]);
    expect(viewModel.status).toBe("streaming");
  });

  test("agent_end with no yielded flag goes idle", () => {
    expect(run([agentStart, agentEnd()]).viewModel.status).toBe("idle");
  });
});

describe("reduceEvent, auto retry", () => {
  test("retry that succeeds: streaming throughout, idle at the end, no failure", () => {
    const { viewModel, ops } = run([
      agentStart,
      assistantEnd(assistant({ stopReason: "error", errorMessage: "overloaded" })),
      agentEnd({ yielded: false }),
      retryStart,
      retryEnd(true),
      agentStart,
      assistantStart(),
      delta("ok"),
      assistantEnd(assistant({ text: "ok" })),
      agentEnd({ yielded: true }),
    ]);
    // The first attempt's error is shown while the retry runs...
    expect(ops.filter((o) => o.type === "status.set").map((o) => o.status)).toEqual([
      "streaming",
      "failed",
      "streaming",
      "idle",
    ]);
    // ...and the successful retry clears it.
    expect(viewModel.status).toBe("idle");
    expect(viewModel.error).toBeUndefined();
  });

  test("auto_retry_start puts a failed session back to streaming", () => {
    const failed = run([assistantEnd(assistant({ stopReason: "error", errorMessage: "x" }))]);
    const { viewModel } = run([retryStart], failed.viewModel);
    expect(viewModel.status).toBe("streaming");
    expect(viewModel.error).toBeUndefined();
  });

  test("retry exhausted: failed with omp's final error", () => {
    const { viewModel } = run([retryStart, retryEnd(false, "503 Service Unavailable")]);
    expect(viewModel.status).toBe("failed");
    expect(viewModel.error).toBe("503 Service Unavailable");
  });

  test("retry exhausted without a message still says why", () => {
    const { viewModel } = run([retryStart, retryEnd(false)]);
    expect(viewModel.status).toBe("failed");
    expect(viewModel.error).toBe("retries exhausted");
  });

  test("a stop during the retry wait is a stop, not a failure: idle, nothing left open", () => {
    // The failed attempt streamed some text and was never closed by a message_end.
    const { viewModel } = run([
      agentStart,
      assistantStart(),
      delta("par"),
      retryStart,
      retryEnd(false, RETRY_CANCELLED),
    ]);
    expect(viewModel.status).toBe("idle");
    expect(viewModel.error).toBeUndefined();
    // The text is closed; the retry the stop interrupted stays on the timeline as cancelled.
    expect(viewModel.timeline).toMatchObject([
      { kind: "assistant", id: "i0", text: "par", done: true },
      { kind: "retry", id: "i1", state: "cancelled" },
    ]);
  });

  test("a stop during the wait after a failed attempt clears that attempt's error", () => {
    const { viewModel } = run([
      agentStart,
      assistantEnd(assistant({ stopReason: "error", errorMessage: "overloaded" })),
      retryStart,
      retryEnd(false, RETRY_CANCELLED),
    ]);
    expect(viewModel.status).toBe("idle");
    expect(viewModel.error).toBeUndefined();
  });

  test("RETRY_CANCELLED is the text the installed omp emits", async () => {
    const source = await Bun.file(
      Bun.fileURLToPath(import.meta.resolve("@oh-my-pi/pi-coding-agent/session/turn-recovery")),
    ).text();
    expect(source).toContain(`finalError: "${RETRY_CANCELLED}"`);
  });
});

describe("reduceModel", () => {
  test("sets the model once and is a no-op when unchanged", () => {
    const first = reduceModel(start(), "a/b");
    expect(first.ops).toEqual([{ type: "model.set", model: "a/b" }]);
    expect(first.viewModel.model).toBe("a/b");
    expect(reduceModel(first.viewModel, "a/b").ops).toEqual([]);
  });

  test("an assistant message from another model switches the model", () => {
    const { ops } = run([assistantStart(assistant({ provider: "x", model: "y" }))]);
    expect(ops).toEqual([{ type: "model.set", model: "x/y" }]);
  });
});
