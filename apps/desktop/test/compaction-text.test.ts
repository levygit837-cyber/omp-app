import { describe, expect, test } from "bun:test";
import type { CompactionItem } from "@omp-app/protocol";
import { compactionSize } from "../src/renderer/timeline/compaction-text";

const done = (tokensBefore?: number): CompactionItem => ({
  kind: "compaction",
  id: "i1",
  state: "done",
  reason: "threshold",
  action: "context-full",
  startedAt: 0,
  endedAt: 1,
  ...(tokensBefore === undefined ? {} : { tokensBefore }),
});

describe("compactionSize", () => {
  test("a real size is printed in thousands", () => {
    expect(compactionSize(done(184_000))).toBe("184k tokens summarized");
    expect(compactionSize(done(1000))).toBe("1k tokens summarized");
  });

  test("below a thousand tokens, or unknown, there is no number: the line is still there", () => {
    expect(compactionSize(done(41))).toBeUndefined();
    expect(compactionSize(done(999))).toBeUndefined();
    expect(compactionSize(done(0))).toBeUndefined();
    expect(compactionSize(done())).toBeUndefined();
  });
});
