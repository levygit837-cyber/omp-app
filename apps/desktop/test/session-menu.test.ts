import { describe, expect, test } from "bun:test";
import {
  CLEAR_BLOCKED,
  DELETE_BLOCKED,
  type SessionMenuInput,
  sessionMenuState,
} from "../src/renderer/session-menu";

const input = (over: Partial<SessionMenuInput> = {}): SessionMenuInput => ({
  open: true,
  readOnly: false,
  status: "idle",
  waiting: false,
  onDisk: true,
  ...over,
});

describe("Clear context and Delete session in the menu", () => {
  test("an idle, open session on disk offers both", () => {
    expect(sessionMenuState(input())).toEqual({
      clear: { state: "enabled" },
      delete: { state: "enabled" },
    });
  });

  test("a session that is not open, not on disk, or read-only offers neither", () => {
    for (const over of [{ open: false }, { onDisk: false }, { readOnly: true }]) {
      expect(sessionMenuState(input(over))).toEqual({
        clear: { state: "hidden" },
        delete: { state: "hidden" },
      });
    }
  });

  test("a running turn blocks both, and says how to get out", () => {
    expect(sessionMenuState(input({ status: "streaming" }))).toEqual({
      clear: { state: "blocked", reason: CLEAR_BLOCKED },
      delete: { state: "blocked", reason: DELETE_BLOCKED },
    });
    expect(CLEAR_BLOCKED).toContain("Esc");
    expect(DELETE_BLOCKED).toContain("Esc");
  });

  test("a turn waiting on the person can be deleted, not cleared", () => {
    expect(sessionMenuState(input({ status: "streaming", waiting: true }))).toEqual({
      clear: { state: "blocked", reason: CLEAR_BLOCKED },
      delete: { state: "enabled" },
    });
  });
});
