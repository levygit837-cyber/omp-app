import { describe, expect, test } from "bun:test";
import {
  contextMeter,
  formatCost,
  formatTokens,
  percentOf,
  summarizeTodo,
} from "../src/renderer/right-panel/facts";

describe("formatTokens", () => {
  test("small counts are exact, thousands get one decimal, round thousands drop it", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(48_200)).toBe("48.2k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });
  test("rounding up across a unit boundary moves to the next unit", () => {
    expect(formatTokens(999_960)).toBe("1M");
  });
  test("negative and non-finite counts read as zero", () => {
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});

describe("formatCost", () => {
  test("nothing spent yields null", () => {
    expect(formatCost(0)).toBeNull();
    expect(formatCost(-1)).toBeNull();
    expect(formatCost(Number.NaN)).toBeNull();
  });
  test("cents from one cent up, three decimals below", () => {
    expect(formatCost(0.31)).toBe("$0.31");
    expect(formatCost(12.345)).toBe("$12.35");
    expect(formatCost(0.0042)).toBe("$0.004");
    expect(formatCost(0.00001)).toBe("<$0.001");
  });
});

describe("percentOf", () => {
  test("clamps to 0..100 and tolerates a missing window", () => {
    expect(percentOf(50, 200)).toBe(25);
    expect(percentOf(300, 200)).toBe(100);
    expect(percentOf(-1, 200)).toBe(0);
    expect(percentOf(10, 0)).toBe(0);
  });
});

describe("contextMeter", () => {
  test("carries the compaction threshold only when auto-compaction is on and inside the window", () => {
    const on = contextMeter({ tokens: 48_200, window: 200_000, compactAtTokens: 160_000 });
    expect(on.compactPercent).toBe(80);
    expect(on.compactAt).toBe("160k");
    expect(on.used).toBe("48.2k");
    expect(on.window).toBe("200k");
    const off = contextMeter({ tokens: 48_200, window: 200_000 });
    expect(off.compactPercent).toBeNull();
    expect(off.compactAt).toBeNull();
    expect(
      contextMeter({ tokens: 1, window: 100, compactAtTokens: 500 }).compactPercent,
    ).toBeNull();
  });
});

describe("summarizeTodo", () => {
  test("counts completed tasks over all tasks and drops empty phases", () => {
    const summary = summarizeTodo([
      {
        name: "A",
        tasks: [
          { content: "one", status: "completed" },
          { content: "two", status: "in_progress" },
          { content: "three", status: "abandoned" },
        ],
      },
      { name: "empty", tasks: [] },
      { name: "B", tasks: [{ content: "four", status: "completed" }] },
    ]);
    expect(summary.done).toBe(2);
    expect(summary.total).toBe(4);
    expect(summary.groups.map((g) => g.name)).toEqual(["A", "B"]);
  });
  test("no phases is an empty summary", () => {
    expect(summarizeTodo([])).toEqual({ groups: [], done: 0, total: 0 });
  });
});
