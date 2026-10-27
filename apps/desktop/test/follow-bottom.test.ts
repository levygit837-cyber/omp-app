import { describe, expect, test } from "bun:test";
import { FOLLOW_SLACK, isNearBottom } from "../src/renderer/follow-bottom";

const metrics = (scrollTop: number) => ({ scrollTop, clientHeight: 400, scrollHeight: 1000 });

describe("isNearBottom", () => {
  test("is true at the very end", () => {
    expect(isNearBottom(metrics(600))).toBe(true);
  });

  test("tolerates sub-pixel and one-line drift up to the slack", () => {
    expect(isNearBottom(metrics(600 - FOLLOW_SLACK))).toBe(true);
  });

  test("is false once the user is further up than the slack", () => {
    expect(isNearBottom(metrics(600 - FOLLOW_SLACK - 1))).toBe(false);
  });

  test("a container shorter than its viewport is at the bottom", () => {
    expect(isNearBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 300 })).toBe(true);
  });
});
