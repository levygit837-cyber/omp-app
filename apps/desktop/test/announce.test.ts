import { describe, expect, test } from "bun:test";
import { ANNOUNCE_MAX, announce, announceControls, announceQueue } from "../src/renderer/announce";
import { shownStatus } from "../src/renderer/engine";

describe("announce", () => {
  const base = { engine: "ready" as const, lastReply: "Done." };

  test("says something when a turn starts, and only then", () => {
    expect(announce({ ...base, previous: "idle", status: "streaming" })).not.toBeNull();
    expect(announce({ ...base, previous: "streaming", status: "streaming" })).toBeNull();
    expect(announce({ ...base, previous: "idle", status: "idle" })).toBeNull();
  });

  test("says a short result when a turn ends, capped", () => {
    expect(announce({ ...base, previous: "streaming", status: "idle" })).toContain("Done.");
    const long = announce({
      ...base,
      previous: "streaming",
      status: "idle",
      lastReply: "word ".repeat(200),
    });
    expect(Array.from(long ?? "").length).toBeLessThan(ANNOUNCE_MAX + 40);
  });

  test("a turn cut short by a dead engine is not reported as finished", () => {
    const said = announce({ ...base, engine: "failed", previous: "streaming", status: "idle" });
    expect(said).not.toContain("finished");
  });
});

describe("shownStatus", () => {
  test("a turn does not run on a dead engine", () => {
    expect(shownStatus("streaming", "failed")).toBe("idle");
    expect(shownStatus("streaming", "restarting")).toBe("idle");
  });

  test("otherwise the session's own status stands", () => {
    expect(shownStatus("streaming", "ready")).toBe("streaming");
    expect(shownStatus("failed", "failed")).toBe("failed");
    expect(shownStatus(undefined, "ready")).toBeUndefined();
  });
});

describe("announceQueue", () => {
  const queue = (steering: string[], followUp: string[]) => ({
    steering,
    followUp,
    liveSteered: 0,
  });

  test("says which kind entered the queue", () => {
    expect(announceQueue(queue([], []), queue(["a"], []))).toBe("Steer queued");
    expect(announceQueue(queue([], []), queue([], ["a"]))).toBe("Follow-up queued");
  });

  test("says how many are left when one leaves, whether delivered or removed", () => {
    expect(announceQueue(queue(["a"], ["b"]), queue([], ["b"]))).toBe("1 queued");
    expect(announceQueue(queue([], ["b"]), queue([], []))).toBe("Queue empty");
  });

  test("a queue that did not change in size, or a first reading, is silent", () => {
    expect(announceQueue(queue(["a"], []), queue([], ["a"]))).toBeNull();
    expect(announceQueue(undefined, queue(["a"], []))).toBeNull();
  });
});

describe("announceControls", () => {
  test("names the new model or thinking level, only once both sides are known", () => {
    const was = { model: "p/one", thinking: "low" };
    expect(announceControls(was, { model: "p/two", thinking: "low" })).toBe("Model: two");
    expect(announceControls(was, { model: "p/one", thinking: "high" })).toBe("Thinking: high");
    expect(announceControls(was, was)).toBeNull();
    expect(announceControls({ model: undefined, thinking: undefined }, was)).toBeNull();
  });
});
