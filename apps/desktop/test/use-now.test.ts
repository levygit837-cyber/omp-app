import { describe, expect, test } from "bun:test";

// use-now.ts imports React hooks only; parseMs is pure.
import { parseMs } from "../src/renderer/timeline/use-now";

describe("parseMs", () => {
  test("reads a duration in either unit, because the build may rewrite 10000ms as 10s", () => {
    expect(parseMs("10000ms")).toBe(10_000);
    expect(parseMs("10s")).toBe(10_000);
    expect(parseMs(" 0.5s ")).toBe(500);
    expect(parseMs("120ms")).toBe(120);
  });

  test("anything else is zero, so a missing token shows the timer at once instead of never", () => {
    expect(parseMs("")).toBe(0);
    expect(parseMs("fast")).toBe(0);
  });
});
