import { expect, test } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { emptyViewModel, reduceEvent } from "../src/reducer";
import { buildTranscript, describeOmitted } from "../src/transcript";
import { loadFixture } from "./replay";

const assistant = (text: string, model = "m1") => ({
  role: "assistant",
  provider: "p",
  model,
  content: [{ type: "text", text }],
});

test("user and assistant messages become items with position ids", () => {
  const { items, model } = buildTranscript([
    { role: "user", content: "hello" },
    assistant("hi there"),
    {
      role: "user",
      content: [
        { type: "text", text: "and " },
        { type: "text", text: "more" },
      ],
    },
    assistant("sure", "m2"),
  ]);
  expect(items).toEqual([
    { kind: "user", id: "i0", text: "hello" },
    { kind: "assistant", id: "i1", text: "hi there", done: true },
    { kind: "user", id: "i2", text: "and more" },
    { kind: "assistant", id: "i3", text: "sure", done: true },
  ]);
  expect(model).toBe("p/m2");
});

test("what has no item yet is counted by kind, never dropped without a trace", () => {
  const { items, model, omitted } = buildTranscript([
    { role: "user", content: "real" },
    { role: "user", content: "injected by omp", synthetic: true },
    // A result whose call is not in the session has nothing to attach to.
    { role: "toolResult", toolCallId: "gone", content: [{ type: "text", text: "output" }] },
    { role: "bashExecution" },
    { role: "pythonExecution" },
    { role: "custom", content: "note" },
    {
      role: "assistant",
      provider: "p",
      model: "m1",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "done" },
        { type: "toolCall", name: "bash" },
      ],
    },
  ]);
  expect(items.map((i) => i.id)).toEqual(["i0", "i1"]);
  expect(items[1]).toMatchObject({ kind: "assistant", text: "done" });
  expect(model).toBe("p/m1");
  expect(omitted).toEqual({
    "messages added by omp": 1,
    "tool results": 1,
    "shell commands": 1,
    "python runs": 1,
    "custom messages": 1,
    "reasoning blocks": 1,
    "tool calls": 1,
  });
});

/** A stored assistant message as `SessionManager` keeps it. */
const stored = (content: unknown[]) =>
  ({
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4o-mini",
    usage: {
      input: 0,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 20,
  }) as never;

test("tool calls, shell commands and compactions of a real stored session become their items", () => {
  const manager = SessionManager.inMemory("/work");
  manager.appendMessage({ role: "user", content: "run it", timestamp: 10 });
  const kept = manager.appendMessage(
    stored([
      { type: "text", text: "running" },
      {
        type: "toolCall",
        id: "t1",
        name: "bash",
        arguments: { command: "echo hi" },
        intent: "Say hi",
      },
      { type: "toolCall", id: "t2", name: "read", arguments: { path: "a.txt" } },
      { type: "toolCall", id: "t3", name: "read", arguments: { path: "b.txt" } },
      { type: "toolCall", id: "t4", name: "bash", arguments: { command: "false" } },
      { type: "toolCall", id: "t5", name: "grep", arguments: { pattern: "x" } },
    ]),
  );
  const result = (id: string, name: string, text: string, isError: boolean, details = {}) =>
    manager.appendMessage({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text }],
      isError,
      details,
      timestamp: 30,
    } as never);
  result("t1", "bash", "hi\n", false, { exitCode: 0, wallTimeMs: 12 });
  result("t2", "read", "1:one\n2:two\n", false);
  result("t3", "read", "Error: no such file", true);
  result("t4", "bash", "boom\nCommand exited with code 3", true, { exitCode: 3 });
  // t5 never got a result: the run ended first.
  manager.appendMessage({
    role: "bashExecution",
    command: "ls",
    output: "a\nb",
    cancelled: false,
    truncated: false,
    exitCode: 0,
    timestamp: 40,
  } as never);
  manager.appendMessage(stored([{ type: "text", text: "done" }]));
  manager.appendCompaction("a long summary", "short summary", kept, 5000);

  const { items, omitted } = buildTranscript(
    manager.buildSessionContext({ transcript: true }).messages as never,
  );
  // omp strips the call that never got a result and counts it; the builder passes the count on.
  expect(omitted).toEqual({ "tool calls without a result": 1 });
  // The transcript context keeps the whole history, so the compaction sits where it happened.
  expect(items.map((i) => i.kind)).toEqual([
    "user",
    "assistant",
    "tool",
    "tool",
    "tool",
    "tool",
    "assistant",
    "compaction",
  ]);
  const compaction = items.at(-1);
  if (compaction?.kind !== "compaction") throw new Error("the last item is not a compaction");
  expect(compaction).toMatchObject({
    state: "done",
    tokensBefore: 5000,
    summary: "short summary",
  });
  // omp does not store why a compaction ran: the item says nothing rather than guess.
  expect(compaction.reason).toBeUndefined();

  const tools = items.filter((i) => i.kind === "tool");
  // The agent's calls, in order; the two reads share a line, as they do live.
  expect(tools.map((t) => [t.tool, t.calls.map((c) => c.toolCallId)])).toEqual([
    ["bash", ["t1"]],
    ["read", ["t2", "t3"]],
    ["bash", ["t4"]],
    ["bash", ["bash-5"]],
  ]);
  expect(tools[0]).toMatchObject({ intent: "Say hi" });
  expect(tools[0]?.calls[0]).toMatchObject({
    status: "done",
    target: "echo hi",
    output: { kind: "shell", exitCode: 0, wallTimeMs: 12, lines: ["hi"] },
  });
  expect(tools[1]?.calls.map((c) => [c.status, c.target])).toEqual([
    ["done", "a.txt"],
    ["failed", "b.txt"],
  ]);
  expect(tools[1]?.calls[1]?.error).toBe("no such file");
  expect(tools[2]?.calls[0]).toMatchObject({
    status: "failed",
    output: { kind: "shell", exitCode: 3, lines: ["boom"] },
  });
  // The command the person ran: a line of its own, never folded into the agent's.
  expect(tools[3]?.calls[0]).toMatchObject({
    status: "done",
    target: "ls",
    output: { kind: "shell", exitCode: 0, lines: ["a", "b"] },
  });
});

const agentBash = (id: string, command: string) => ({
  role: "assistant",
  provider: "p",
  model: "m1",
  content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
});
const ranByPerson = (command: string) => ({
  role: "bashExecution",
  command,
  output: "",
  cancelled: false,
  exitCode: 0,
  timestamp: 5,
});

test("a command the person ran with ! and the agent's next bash call are two lines", () => {
  const { items } = buildTranscript([
    ranByPerson("ls"),
    agentBash("t1", "pwd"),
    { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [], isError: false },
  ] as never);
  expect(items.map((i) => (i.kind === "tool" ? i.calls.map((c) => c.target) : i.kind))).toEqual([
    ["ls"],
    ["pwd"],
  ]);
});

test("the agent's bash call and the command the person ran next are two lines", () => {
  const { items } = buildTranscript([agentBash("t1", "pwd"), ranByPerson("ls")] as never);
  expect(items.map((i) => (i.kind === "tool" ? i.calls.map((c) => c.target) : i.kind))).toEqual([
    ["pwd"],
    ["ls"],
  ]);
});

test("two agent bash calls in a row still share one line, as they do live", () => {
  const { items } = buildTranscript([agentBash("t1", "a"), agentBash("t2", "b")] as never);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ kind: "tool", tool: "bash" });
  expect(items[0]?.kind === "tool" && items[0].calls).toHaveLength(2);
});

test("a role omp adds later is counted under its own name", () => {
  expect(buildTranscript([{ role: "mystery", content: 1 }])).toEqual({
    items: [],
    model: null,
    omitted: { mystery: 1 },
  });
  expect(buildTranscript([])).toEqual({ items: [], model: null, omitted: {} });
});

test("the omitted counts read as one sentence", () => {
  expect(describeOmitted({})).toBeNull();
  expect(describeOmitted({ "tool results": 1 })).toBe("tool results (1)");
  expect(describeOmitted({ "tool results": 3, "compaction summaries": 1 })).toBe(
    "tool results (3) and compaction summaries (1)",
  );
});

test("a rebuilt timeline equals the one the live reducer built from the same turn", async () => {
  // The recorded events of a real turn: the reducer's result is the reference.
  const fixture = await loadFixture("basic");
  let live = emptyViewModel({ id: "s", cwd: "/x", model: null });
  const messages: { role: string; content?: unknown; provider?: unknown; model?: unknown }[] = [];
  for (const event of fixture.events) {
    live = reduceEvent(live, event, 0).viewModel;
    if (event.type === "message_end") messages.push(event.message);
  }
  expect(live.timeline.length).toBeGreaterThan(0);

  const rebuilt = buildTranscript(messages);
  expect(rebuilt.items).toEqual(live.timeline);
  expect(rebuilt.model).toBe(live.model);

  // And new live items continue the ids after a rebuilt history.
  const resumed = reduceEvent(
    { ...emptyViewModel({ id: "s", cwd: "/x", model: null }), timeline: rebuilt.items },
    { type: "message_start", message: { role: "user", content: "again", timestamp: 0 } },
    0,
  );
  const added = resumed.ops.find((op) => op.type === "item.add");
  expect(added).toMatchObject({ item: { id: `i${rebuilt.items.length}` } });
});

test("a resumed prompt keeps the files omp read, and a message without one keeps none", () => {
  const { items, omitted } = buildTranscript([
    { role: "user", content: "read @a.ts" },
    { role: "fileMention", files: [{ path: "a.ts", content: "x" }] },
    assistant("done"),
    { role: "user", content: "also @b.ts", steering: true },
  ]);
  expect(items[0]).toEqual({ kind: "user", id: "i0", text: "read @a.ts", files: ["a.ts"] });
  expect(items[2]).toEqual({ kind: "user", id: "i2", text: "also @b.ts", steered: true });
  expect(omitted).toEqual({});
});

test("a file mention with no user message to attach to is counted as left out", () => {
  const { items, omitted } = buildTranscript([
    { role: "fileMention", files: [{ path: "a.ts", content: "x" }] },
  ]);
  expect(items).toEqual([]);
  expect(omitted).toEqual({ "file mentions": 1 });
});

test("a resumed steer keeps its badge and a resumed image its type and size", () => {
  const { items } = buildTranscript([
    { role: "user", content: "start" },
    assistant("working"),
    { role: "user", content: "use tabs", steering: true },
    {
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image", mimeType: "image/png", data: "AAAA" },
      ],
    },
  ]);
  expect(items[2]).toEqual({ kind: "user", id: "i2", text: "use tabs", steered: true });
  expect(items[3]).toEqual({
    kind: "user",
    id: "i3",
    text: "what is this",
    attachments: [{ kind: "image", mimeType: "image/png", bytes: 3 }],
  });
});
