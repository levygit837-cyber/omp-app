import { beforeEach, describe, expect, test } from "bun:test";
import {
  askKill,
  dismissKillError,
  failKill,
  focusKillOn,
  type KillTarget,
  killStore,
} from "../src/renderer/kill-state";

const target = (sessionId: string): KillTarget => ({
  sessionId,
  kind: "subagent",
  id: "sa",
  name: "Survey",
  anchor: { x: 0, y: 0, above: 0 },
  opener: null,
});

beforeEach(() => killStore.setState({ target: null, error: null }));

describe("the notice of a kill that failed", () => {
  test("stays while the session it belongs to is focused", () => {
    failKill("s1", "omp couldn’t stop that subagent.");
    focusKillOn("s1");
    expect(killStore.getState().error?.message).toBe("omp couldn’t stop that subagent.");
  });

  test("is dropped when another session, or none, takes focus", () => {
    failKill("s1", "x");
    focusKillOn("s2");
    expect(killStore.getState().error).toBeNull();
    failKill("s1", "x");
    focusKillOn(null);
    expect(killStore.getState().error).toBeNull();
  });

  test("is dropped when the next kill is asked for, and by dismissing it", () => {
    failKill("s1", "x");
    askKill(target("s1"));
    expect(killStore.getState().error).toBeNull();
    failKill("s1", "x");
    dismissKillError();
    expect(killStore.getState().error).toBeNull();
  });
});
