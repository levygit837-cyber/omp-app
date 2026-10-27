import { describe, expect, test } from "bun:test";
import {
  applyOp,
  isSessionSnapshot,
  isSessionViewModel,
  methodWrites,
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
