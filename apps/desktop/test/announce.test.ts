import { describe, expect, test } from "bun:test";
import { ANNOUNCE_MAX, announce } from "../src/renderer/announce";
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
