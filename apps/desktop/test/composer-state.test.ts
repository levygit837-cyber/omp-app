import { describe, expect, test } from "bun:test";
import { composerView, keyStopsTurn } from "../src/renderer/composer-state";

describe("composerView", () => {
  test("idle and ready asks for work and can send", () => {
    expect(composerView({ readOnly: false, engine: "ready", streaming: false })).toMatchObject({
      kind: "input",
      canSend: true,
      reason: null,
    });
  });

  test("streaming and ready invites steering but cannot send a second prompt yet", () => {
    const view = composerView({ readOnly: false, engine: "ready", streaming: true });
    expect(view).toMatchObject({ kind: "input", canSend: false, reason: null });
  });

  test("read-only replaces the input entirely", () => {
    expect(composerView({ readOnly: true, engine: "ready", streaming: false })).toEqual({
      kind: "read-only",
    });
  });

  test("the engine outranks the turn: a stopped engine pauses sending even while streaming", () => {
    const view = composerView({ readOnly: false, engine: "failed", streaming: true });
    expect(view).toMatchObject({ kind: "input", canSend: false });
    if (view.kind === "input") expect(view.reason).not.toBeNull();
  });

  test("starting and restarting say so and keep the draft", () => {
    for (const engine of ["starting", "restarting"] as const) {
      const view = composerView({ readOnly: false, engine, streaming: false });
      expect(view).toMatchObject({ kind: "input", canSend: false });
      if (view.kind === "input") expect(view.reason).not.toBeNull();
    }
  });
});

describe("keyStopsTurn", () => {
  test("Esc stops the turn from the session view", () => {
    expect(keyStopsTurn("Escape", false)).toBe(true);
  });

  test("Esc that leaves Settings does not stop the turn behind it", () => {
    expect(keyStopsTurn("Escape", true)).toBe(false);
  });

  test("no other key stops a turn", () => {
    expect(keyStopsTurn("Enter", false)).toBe(false);
    expect(keyStopsTurn("c", false)).toBe(false);
  });
});
