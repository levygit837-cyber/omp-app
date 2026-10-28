import { describe, expect, test } from "bun:test";
import { commandEnded } from "../src/renderer/command-refresh";
import type { SessionsState } from "../src/renderer/session-store";
import { fakeViewModel } from "./fixtures/fake-timeline";

const command = (state: "running" | "done" | "failed") => ({
  kind: "command" as const,
  id: "c1",
  text: "/rename x",
  state,
  output: "",
  startedAt: 1,
});

const withTimeline = (timeline: ReturnType<typeof command>[]): SessionsState => ({
  sessions: { s1: fakeViewModel({ id: "s1", cwd: "/work", model: "m", timeline }) },
  error: null,
});

describe("commandEnded", () => {
  test("true when a running command item is done or failed in the next state", () => {
    expect(commandEnded(withTimeline([command("running")]), withTimeline([command("done")]))).toBe(
      true,
    );
    expect(
      commandEnded(withTimeline([command("running")]), withTimeline([command("failed")])),
    ).toBe(true);
  });

  test("false while it still runs, when it was already over, and when it is gone", () => {
    expect(
      commandEnded(withTimeline([command("running")]), withTimeline([command("running")])),
    ).toBe(false);
    expect(commandEnded(withTimeline([command("done")]), withTimeline([command("done")]))).toBe(
      false,
    );
    expect(commandEnded(withTimeline([command("running")]), withTimeline([]))).toBe(false);
  });
});
