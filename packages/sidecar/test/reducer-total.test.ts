import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { SessionViewModel } from "@omp-app/protocol";
import { emptyViewModel, reduceEvent } from "../src/reducer";

/**
 * `reduceEvent` runs inside omp's event callback. The types say which fields exist, but a
 * provider or an omp upgrade can leave one out, and a throw there used to skip the rest of the
 * handler. These tests feed every handled event with each of its fields missing, one at a time.
 */

const cast = (value: unknown): AgentSessionEvent => value as AgentSessionEvent;
const usage = {
  input: 1,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  totalTokens: 10,
  cost: { total: 0.5 },
};
const partial = { role: "assistant", content: [], usage, stopReason: "stop" };
const assistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "hi" }],
  provider: "p",
  model: "m",
  usage,
  stopReason: "stop",
};
const toolResult = { content: [{ type: "text", text: "ok" }], details: {}, isError: false };

const update = (assistantMessageEvent: unknown) =>
  cast({ type: "message_update", message: assistantMessage, assistantMessageEvent });

/** What has happened before the event under test, so it finds the item it acts on. */
const open = {
  thinking: [
    cast({ type: "agent_start" }),
    update({ type: "thinking_start", contentIndex: 0, partial }),
  ],
  tool: [
    cast({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "ls" },
      intent: "Listing",
    }),
  ],
  retry: [
    cast({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "x" }),
  ],
  compaction: [
    cast({ type: "auto_compaction_start", reason: "threshold", action: "context-full" }),
  ],
  text: [
    cast({ type: "agent_start" }),
    update({ type: "text_delta", contentIndex: 0, delta: "a", partial }),
  ],
  none: [],
};

const CASES: ReadonlyArray<{ name: string; before: readonly AgentSessionEvent[]; event: unknown }> =
  [
    {
      name: "agent_end",
      before: open.tool,
      event: { type: "agent_end", messages: [], yielded: true },
    },
    {
      name: "user message_start",
      before: open.none,
      event: { type: "message_start", message: { role: "user", content: "go", timestamp: 0 } },
    },
    {
      name: "assistant message_start",
      before: open.none,
      event: { type: "message_start", message: assistantMessage },
    },
    {
      name: "thinking_start",
      before: open.none,
      event: {
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial },
      },
    },
    {
      name: "thinking_delta",
      before: open.thinking,
      event: {
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hm", partial },
      },
    },
    {
      name: "thinking_end",
      before: open.thinking,
      event: {
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "hm", partial },
      },
    },
    {
      name: "text_delta",
      before: open.text,
      event: {
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "b", partial },
      },
    },
    {
      name: "message_end",
      before: open.text,
      event: { type: "message_end", message: assistantMessage },
    },
    {
      name: "message_end that failed",
      before: open.text,
      event: {
        type: "message_end",
        message: { ...assistantMessage, stopReason: "error", errorMessage: "boom" },
      },
    },
    {
      name: "tool_execution_start",
      before: open.none,
      event: {
        type: "tool_execution_start",
        toolCallId: "c9",
        toolName: "write",
        args: { path: "a.txt", content: "x" },
        intent: "Writing",
      },
    },
    {
      name: "tool_execution_update",
      before: open.tool,
      event: {
        type: "tool_execution_update",
        toolCallId: "c1",
        toolName: "bash",
        args: {},
        partialResult: toolResult,
      },
    },
    {
      name: "tool_stream_update",
      before: open.tool,
      event: {
        type: "tool_stream_update",
        toolCallId: "c1",
        update: { path: "a.txt", diff: "@@" },
      },
    },
    {
      name: "tool_execution_end",
      before: open.tool,
      event: {
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "bash",
        result: toolResult,
        isError: false,
      },
    },
    {
      name: "todo tool end",
      before: [
        cast({ type: "tool_execution_start", toolCallId: "t1", toolName: "todo", args: {} }),
      ],
      event: {
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "todo",
        result: {
          ...toolResult,
          details: { phases: [{ name: "P", tasks: [{ content: "a", status: "pending" }] }] },
        },
        isError: false,
      },
    },
    { name: "todo_auto_clear", before: open.none, event: { type: "todo_auto_clear" } },
    {
      name: "auto_compaction_start",
      before: open.none,
      event: { type: "auto_compaction_start", reason: "threshold", action: "context-full" },
    },
    {
      name: "auto_compaction_end",
      before: open.compaction,
      event: {
        type: "auto_compaction_end",
        action: "context-full",
        aborted: false,
        willRetry: false,
        result: { summary: "s", shortSummary: "ss", tokensBefore: 5, firstKeptEntryId: "e" },
      },
    },
    {
      name: "auto_retry_start",
      before: open.none,
      event: {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 10,
        errorMessage: "x",
      },
    },
    {
      name: "auto_retry_end",
      before: open.retry,
      event: { type: "auto_retry_end", success: false, attempt: 1, finalError: "gave up" },
    },
  ];

/** Every way to remove one field, at any depth up to three, from a plain JSON value. */
function withoutEachField(
  value: unknown,
  path: string[] = [],
): Array<{ path: string; value: unknown }> {
  if (value === null || typeof value !== "object" || path.length >= 3) return [];
  const out: Array<{ path: string; value: unknown }> = [];
  for (const key of Object.keys(value)) {
    const copy = structuredClone(value) as Record<string, unknown>;
    delete copy[key];
    out.push({ path: [...path, key].join("."), value: copy });
  }
  return out;
}

/** The same, one level down: the broken child is put back into an intact parent. */
function variants(event: unknown): Array<{ path: string; event: unknown }> {
  const out = withoutEachField(event).map((v) => ({ path: v.path, event: v.value }));
  for (const [key, child] of Object.entries(event as Record<string, unknown>)) {
    for (const v of withoutEachField(child, [key])) {
      out.push({ path: v.path, event: { ...(event as object), [key]: v.value } });
    }
    if (child && typeof child === "object") {
      for (const [k2, grand] of Object.entries(child)) {
        for (const v of withoutEachField(grand, [key, k2])) {
          out.push({
            path: v.path,
            event: { ...(event as object), [key]: { ...child, [k2]: v.value } },
          });
        }
      }
    }
  }
  return out;
}

function reduceAll(events: readonly AgentSessionEvent[], from: SessionViewModel): SessionViewModel {
  let vm = from;
  for (const event of events) vm = reduceEvent(vm, event, 1000).viewModel;
  return vm;
}

describe("reduceEvent is total over its handled events", () => {
  for (const { name, before, event } of CASES) {
    test(`${name}: the intact event reduces`, () => {
      const vm = reduceAll(before, emptyViewModel({ id: "s", cwd: "/w", model: null }));
      expect(() => reduceEvent(vm, cast(event), 2000)).not.toThrow();
    });

    test(`${name}: no missing field makes it throw`, () => {
      const base = reduceAll(before, emptyViewModel({ id: "s", cwd: "/w", model: null }));
      const thrown: string[] = [];
      for (const v of variants(event)) {
        try {
          reduceEvent(base, cast(v.event), 2000);
        } catch (error) {
          thrown.push(`${v.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      expect(thrown).toEqual([]);
    });
  }
});

describe("a tool call id that already has a call", () => {
  const start = (id: string, tool = "bash") =>
    cast({
      type: "tool_execution_start",
      toolCallId: id,
      toolName: tool,
      args: { command: "ls" },
      intent: "Listing",
    });
  const end = (id: string) =>
    cast({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: "bash",
      result: toolResult,
      isError: false,
    });

  test("a second start with the id of a finished call changes nothing", () => {
    const finished = reduceAll(
      [start("c1"), end("c1")],
      emptyViewModel({ id: "s", cwd: "/w", model: null }),
    );
    const again = reduceEvent(finished, start("c1"), 5000);
    expect(again.ops).toEqual([]);
    expect(again.viewModel).toBe(finished);
    const item = again.viewModel.timeline[0];
    expect(item?.kind === "tool" && item.calls.map((c) => c.status)).toEqual(["done"]);
  });

  test("a second start with the id of a running call changes nothing either", () => {
    const running = reduceAll([start("c1")], emptyViewModel({ id: "s", cwd: "/w", model: null }));
    expect(reduceEvent(running, start("c1"), 5000).ops).toEqual([]);
  });

  test("a different id still joins the line of the same tool and intent", () => {
    const vm = reduceAll(
      [start("c1"), end("c1"), start("c2")],
      emptyViewModel({ id: "s", cwd: "/w", model: null }),
    );
    expect(vm.timeline).toHaveLength(1);
    const item = vm.timeline[0];
    expect(item?.kind === "tool" && item.calls.map((c) => c.toolCallId)).toEqual(["c1", "c2"]);
  });
});
