import { describe, expect, test } from "bun:test";
import { composerView } from "../src/renderer/composer-state";

describe("composerView", () => {
  test("idle and ready asks for work and can send", () => {
    expect(composerView({ readOnly: false, engine: "ready", streaming: false })).toEqual({
      kind: "input",
      canSend: true,
      reason: null,
      placeholder: "Ask omp to change something…",
    });
  });

  test("streaming and ready invites steering but cannot send a second prompt yet", () => {
    const view = composerView({ readOnly: false, engine: "ready", streaming: true });
    expect(view).toMatchObject({
      kind: "input",
      canSend: false,
      placeholder: "Steer the agent, or queue what comes next…",
    });
  });

  test("read-only replaces the input entirely", () => {
    expect(composerView({ readOnly: true, engine: "ready", streaming: false })).toEqual({
      kind: "read-only",
    });
  });

  test("the engine outranks the turn: a stopped engine pauses sending even while streaming", () => {
    const view = composerView({ readOnly: false, engine: "failed", streaming: true });
    expect(view).toMatchObject({ kind: "input", canSend: false, reason: "omp is stopped" });
  });

  test("starting and restarting say so and keep the draft", () => {
    for (const engine of ["starting", "restarting"] as const) {
      const view = composerView({ readOnly: false, engine, streaming: false });
      expect(view).toMatchObject({ kind: "input", canSend: false });
      if (view.kind === "input") expect(view.placeholder).toContain("Your draft is kept");
    }
  });
});
