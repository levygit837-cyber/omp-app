import { describe, expect, test } from "bun:test";
import {
  applyOp,
  isSessionSnapshot,
  isSessionViewModel,
  methodWrites,
  resultGuards,
  type SessionOp,
  type SessionViewModel,
} from "../src/index";

const empty: SessionViewModel = {
  id: "s1",
  cwd: "/work",
  status: "idle",
  model: null,
  timeline: [],
  warnings: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
  context: null,
  todo: [],
  pending: [],
  thinking: null,
  queue: { steering: [], followUp: [], liveSteered: 0 },
};

const fold = (ops: readonly SessionOp[], from = empty) => ops.reduce(applyOp, from);

describe("applyOp", () => {
  test("builds a conversation from ops", () => {
    const vm = fold([
      { type: "item.add", item: { kind: "user", id: "i0", text: "hi" } },
      { type: "status.set", status: "streaming" },
      { type: "item.add", item: { kind: "assistant", id: "i1", text: "", done: false } },
      { type: "item.appendText", itemId: "i1", text: "Hel" },
      { type: "item.appendText", itemId: "i1", text: "lo" },
      { type: "item.done", itemId: "i1" },
      { type: "status.set", status: "idle" },
      { type: "model.set", model: "p/m" },
    ]);
    expect(vm).toEqual({
      ...empty,
      model: "p/m",
      timeline: [
        { kind: "user", id: "i0", text: "hi" },
        { kind: "assistant", id: "i1", text: "Hello", done: true },
      ],
    });
  });

  test("does not mutate its input and keeps identity of untouched items", () => {
    const before = fold([
      { type: "item.add", item: { kind: "user", id: "i0", text: "hi" } },
      { type: "item.add", item: { kind: "assistant", id: "i1", text: "a", done: false } },
    ]);
    const snapshot = structuredClone(before);
    const after = applyOp(before, { type: "item.appendText", itemId: "i1", text: "b" });
    expect(before).toEqual(snapshot);
    expect(after.timeline[0]).toBe(before.timeline[0]);
    expect(after.timeline[1]).not.toBe(before.timeline[1]);
  });

  test("status.set carries the failure reason and the next status clears it", () => {
    const failed = applyOp(empty, { type: "status.set", status: "failed", error: "boom" });
    expect(failed).toMatchObject({ status: "failed", error: "boom" });
    const again = applyOp(failed, { type: "status.set", status: "streaming" });
    expect(again.status).toBe("streaming");
    expect("error" in again).toBe(false);
  });

  test("warning.add appends in order and leaves the timeline alone", () => {
    const a = { source: "mcp", server: "a", message: "boom" } as const;
    const b = { source: "mcp", server: "b", message: "bang" } as const;
    const vm = fold([
      { type: "warning.add", warning: a },
      { type: "warning.add", warning: b },
    ]);
    expect(vm.warnings).toEqual([a, b]);
    expect(vm.timeline).toBe(empty.timeline);
    expect(isSessionViewModel(vm)).toBe(true);
    expect(isSessionViewModel({ ...vm, warnings: [{ source: "mcp", server: 1 }] })).toBe(false);
  });

  test("user.files sets the files omp read on that user item only, and the guard checks them", () => {
    const vm = fold([
      { type: "item.add", item: { kind: "user", id: "i0", text: "read @a.ts" } },
      { type: "item.add", item: { kind: "assistant", id: "i1", text: "", done: false } },
      { type: "user.files", itemId: "i0", files: ["a.ts"] },
      { type: "user.files", itemId: "i1", files: ["ignored.ts"] },
    ]);
    expect(vm.timeline[0]).toMatchObject({ kind: "user", files: ["a.ts"] });
    expect(vm.timeline[1]).not.toHaveProperty("files");
    expect(isSessionViewModel(vm)).toBe(true);
    const bad = { ...vm, timeline: [{ kind: "user", id: "i0", text: "x", files: [1] }] };
    expect(isSessionViewModel(bad)).toBe(false);
  });

  test("ops for unknown items and ops of a newer protocol are no-ops", () => {
    const vm = fold([{ type: "item.add", item: { kind: "user", id: "i0", text: "hi" } }]);
    expect(applyOp(vm, { type: "item.appendText", itemId: "nope", text: "x" })).toBe(vm);
    expect(applyOp(vm, { type: "item.done", itemId: "nope" })).toBe(vm);
    expect(applyOp(vm, { type: "future.op" } as unknown as SessionOp)).toBe(vm);
  });
});

describe("guards and gate", () => {
  test("isSessionSnapshot accepts a snapshot and rejects a malformed one", () => {
    expect(isSessionSnapshot({ snapshot: empty, seq: 0 })).toBe(true);
    expect(isSessionSnapshot({ snapshot: { ...empty, status: "bogus" }, seq: 0 })).toBe(false);
    expect(isSessionSnapshot({ snapshot: empty })).toBe(false);
    expect(
      isSessionSnapshot({
        snapshot: { ...empty, timeline: [{ kind: "assistant", id: "x", text: "t" }] },
        seq: 1,
      }),
    ).toBe(false);
  });

  test("session methods that change state are write methods", () => {
    expect(methodWrites["session.create"]).toBe(true);
    expect(methodWrites["session.prompt"]).toBe(true);
    expect(methodWrites["session.cancel"]).toBe(true);
    expect(methodWrites["session.subscribe"]).toBe(false);
    expect(methodWrites["session.unsubscribe"]).toBe(false);
  });
});

describe("command items and the commands result", () => {
  const command = {
    kind: "command",
    id: "i3",
    text: "/usage",
    state: "done",
    output: "5 turns",
    startedAt: 1,
    endedAt: 2,
  };

  const withItem = (item: object) => isSessionViewModel({ ...empty, timeline: [item] });

  test("a command item is an item; a bad state, a missing text or a stray flag is not", () => {
    expect(withItem(command)).toBe(true);
    expect(withItem({ ...command, state: "paused" })).toBe(false);
    expect(withItem({ ...command, text: undefined })).toBe(false);
    expect(withItem({ ...command, truncated: false })).toBe(false);
  });

  test("an item.patch reaches a command item and no other kind of item", () => {
    const vm = {
      ...empty,
      timeline: [command as never, { kind: "user", id: "i4", text: "hi" } as never],
    };
    const patched = applyOp(vm, {
      type: "item.patch",
      itemId: "i3",
      patch: { output: "more" },
    });
    expect(patched.timeline[0]).toMatchObject({ output: "more" });
    expect(applyOp(vm, { type: "item.patch", itemId: "i4", patch: { text: "x" } as never })).toBe(
      vm,
    );
  });

  test("session.commands answers with the shape the palette reads; anything else is refused", () => {
    const entry = {
      name: "effort",
      aliases: [],
      description: "Set effort",
      hint: "[level]",
      subcommands: [{ name: "low", description: "Less" }],
      confirm: { because: "Writes a file." },
      confirmVerbs: [{ verbs: ["reset"], because: "Spends one.", destructive: true }],
    };
    expect(resultGuards["session.commands"]({ commands: [entry] })).toBe(true);
    expect(resultGuards["session.commands"]({ commands: [{ ...entry, confirm: "Writes." }] })).toBe(
      false,
    );
    expect(
      resultGuards["session.commands"]({
        commands: [{ ...entry, confirmVerbs: [{ because: "No verbs." }] }],
      }),
    ).toBe(false);
    expect(resultGuards["session.commands"]({})).toBe(false);
  });

  test("running a builtin is a write; listing them is not", () => {
    expect(methodWrites["session.runCommand"]).toBe(true);
    expect(methodWrites["session.commands"]).toBe(false);
  });
});
