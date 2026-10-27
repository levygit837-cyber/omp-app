import { describe, expect, test } from "bun:test";
import {
  FOLLOW_SLACK,
  followAfterRelease,
  followAfterScroll,
  isNearBottom,
  isScrollPress,
  jumpTarget,
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

describe("a held press (scrollbar drag, selection drag)", () => {
  const away = { scrollTop: 100, clientHeight: 400, scrollHeight: 1000 };
  const end = { scrollTop: 600, clientHeight: 400, scrollHeight: 1000 };

  test("turns following off whatever the geometry says, even at the end", () => {
    expect(followAfterScroll(true, false, away, true)).toBe(false);
    expect(followAfterScroll(true, false, end, true)).toBe(false);
  });

  test("on release it follows again only if the user left the view at the end", () => {
    expect(followAfterRelease(end)).toBe(true);
    expect(followAfterRelease(away)).toBe(false);
  });

  test("content that grew under the held press does not undo having reached the end", () => {
    const leftAtEnd = { scrollTop: 600, clientHeight: 400, scrollHeight: 1000 };
    const atRelease = { ...leftAtEnd, scrollHeight: 1100 };
    expect(isNearBottom(atRelease)).toBe(false);
    expect(followAfterRelease(leftAtEnd)).toBe(true);
  });

  test("only the primary button takes hold of the scroller", () => {
    expect(isScrollPress(0)).toBe(true);
    expect(isScrollPress(1)).toBe(false);
    expect(isScrollPress(2)).toBe(false);
  });
});

describe("jumpTarget", () => {
  const none = { meta: false, ctrl: false, alt: false };

  test("Home and End jump to the start and the end", () => {
    expect(jumpTarget("Home", none)).toBe("start");
    expect(jumpTarget("End", none)).toBe("end");
  });

  test("Cmd+Up and Cmd+Down do the same", () => {
    expect(jumpTarget("ArrowUp", { ...none, meta: true })).toBe("start");
    expect(jumpTarget("ArrowDown", { ...none, meta: true })).toBe("end");
  });

  test("a plain arrow is a line scroll, not a jump", () => {
    expect(jumpTarget("ArrowUp", none)).toBeNull();
    expect(jumpTarget("ArrowDown", none)).toBeNull();
  });

  test("Cmd+Home and any key with Ctrl or Alt are left to the browser", () => {
    expect(jumpTarget("Home", { ...none, meta: true })).toBeNull();
    expect(jumpTarget("End", { ...none, ctrl: true })).toBeNull();
    expect(jumpTarget("ArrowUp", { ...none, meta: true, alt: true })).toBeNull();
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
