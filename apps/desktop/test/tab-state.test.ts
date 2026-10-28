import { describe, expect, test } from "bun:test";
import { MAIN_TAB } from "../src/renderer/delegation-view";
import {
  dismissTab,
  MAX_FILE_TABS,
  NO_TABS,
  rekeyTabs,
  selectedOf,
  selectTab,
} from "../src/renderer/tab-state";

const a = { kind: "subagent", id: "a" } as const;
const j = { kind: "job", id: "j" } as const;

describe("tab state", () => {
  test("each session remembers its own tab", () => {
    const state = selectTab(NO_TABS, "s1", a);
    expect(selectedOf(state, "s1")).toEqual(a);
    expect(selectedOf(state, "s2")).toEqual(MAIN_TAB);
  });

  test("closing the tab on screen falls back to the chat; closing another keeps the selection", () => {
    const shown = selectTab(NO_TABS, "s", a);
    expect(selectedOf(dismissTab(shown, "s", a), "s")).toEqual(MAIN_TAB);
    expect(selectedOf(dismissTab(shown, "s", j), "s")).toEqual(a);
  });

  test("the chat cannot be closed", () => {
    expect(dismissTab(NO_TABS, "s", MAIN_TAB)).toBe(NO_TABS);
  });

  test("picking a closed tab again brings it back", () => {
    const closed = dismissTab(NO_TABS, "s", a);
    expect(closed.dismissed.s).toEqual(["subagent:a"]);
    const back = selectTab(closed, "s", a);
    expect(back.dismissed.s).toEqual([]);
    expect(selectedOf(back, "s")).toEqual(a);
  });

  test("closing twice does not repeat the entry", () => {
    const once = dismissTab(NO_TABS, "s", a);
    expect(dismissTab(once, "s", a)).toBe(once);
  });

  test("session.moved: selection and closed tabs follow the new id", () => {
    const state = dismissTab(selectTab(NO_TABS, "old", a), "old", j);
    const moved = rekeyTabs(state, "old", "new");
    expect(selectedOf(moved, "new")).toEqual(a);
    expect(moved.dismissed.new).toEqual(["job:j"]);
    expect(selectedOf(moved, "old")).toEqual(MAIN_TAB);
    expect(moved.dismissed.old).toBeUndefined();
  });

  test("files open as tabs, once each, and closing one forgets it", () => {
    const f = { kind: "file", path: "src/a.ts" } as const;
    const once = selectTab(selectTab(NO_TABS, "s", f), "s", f);
    expect(once.files.s).toEqual(["src/a.ts"]);
    expect(selectedOf(once, "s")).toEqual(f);
    const closed = dismissTab(once, "s", f);
    expect(closed.files.s).toEqual([]);
    expect(selectedOf(closed, "s")).toEqual(MAIN_TAB);
    expect(dismissTab(closed, "s", f)).toBe(closed);
  });

  test("past the cap the oldest file tab is dropped", () => {
    let state = NO_TABS;
    for (let i = 0; i <= MAX_FILE_TABS; i++) {
      state = selectTab(state, "s", { kind: "file", path: `f${i}` });
    }
    expect(state.files.s).toHaveLength(MAX_FILE_TABS);
    expect(state.files.s?.[0]).toBe("f1");
  });

  test("session.moved: open files follow the new id", () => {
    const state = selectTab(NO_TABS, "old", { kind: "file", path: "a" });
    const moved = rekeyTabs(state, "old", "new");
    expect(moved.files.new).toEqual(["a"]);
    expect(moved.files.old).toBeUndefined();
  });
});
