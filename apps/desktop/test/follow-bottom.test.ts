import { describe, expect, test } from "bun:test";
import {
  FOLLOW_SLACK,
  followAfterScroll,
  isNearBottom,
  movesTowardsStart,
} from "../src/renderer/follow-bottom";

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

describe("followAfterScroll", () => {
  const away = { scrollTop: 100, clientHeight: 400, scrollHeight: 1000 };
  const end = { scrollTop: 600, clientHeight: 400, scrollHeight: 1000 };

  test("a scroll nobody asked for (the virtualizer's correction, content growth) keeps following", () => {
    expect(followAfterScroll(true, false, away)).toBe(true);
  });

  test("a scroll the user is doing, away from the end, stops following", () => {
    expect(followAfterScroll(true, true, away)).toBe(false);
  });

  test("a scroll that is not following stays not following until the end is reached", () => {
    expect(followAfterScroll(false, false, away)).toBe(false);
  });

  test("reaching the end resumes following, whoever scrolled", () => {
    expect(followAfterScroll(false, true, end)).toBe(true);
    expect(followAfterScroll(false, false, end)).toBe(true);
  });
});

describe("movesTowardsStart", () => {
  test("keys that go up", () => {
    for (const key of ["ArrowUp", "PageUp", "Home"])
      expect(movesTowardsStart(key, false)).toBe(true);
    expect(movesTowardsStart(" ", true)).toBe(true);
  });

  test("keys that do not", () => {
    for (const key of ["ArrowDown", "PageDown", "End", "a"]) {
      expect(movesTowardsStart(key, false)).toBe(false);
    }
    expect(movesTowardsStart(" ", false)).toBe(false);
  });
});
