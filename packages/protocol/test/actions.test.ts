import { describe, expect, test } from "bun:test";
import {
  isClearContextResult,
  isDeletePreview,
  isPauseState,
  isTimelineItem,
  methodWrites,
  pauseConfirmation,
  pauseLabel,
  resultGuards,
  sessionActionConfirmation,
} from "../src/index";

describe("sessionActionConfirmation", () => {
  test("clear asks about the title, keeps the timeline and says what stops", () => {
    const c = sessionActionConfirmation("clear", { title: "mcp.json loader" });
    expect(c.question).toBe("Clear context of “mcp.json loader”?");
    expect(c.because).toContain("the timeline stays visible above a “Context cleared” line");
    expect(c.because).toContain("Subagents and background jobs still running are stopped.");
    // omp drops the checkpoint runtime state on reset: the sentence must not promise them.
    expect(c.because).not.toContain("checkpoints");
    expect(c).toMatchObject({ confirm: "Clear", destructive: true });
  });

  test("delete counts subagent sessions in the Pen wording (a2EZt)", () => {
    const c = sessionActionConfirmation("delete", { title: "t", subagents: 2 });
    expect(c.question).toBe("Delete “t”?");
    expect(c.because).toBe(
      "Removes the session and its 2 subagent sessions from ~/.omp. The CLI loses it too. This cannot be undone.",
    );
    expect(c).toMatchObject({ confirm: "Delete", destructive: true });
    expect(sessionActionConfirmation("delete", { title: "t", subagents: 1 }).because).toContain(
      "its 1 subagent session from",
    );
  });

  test("delete without subagents names the file; waiting on a person words J5CJ7", () => {
    expect(sessionActionConfirmation("delete", { title: "t" }).because).toBe(
      "Removes the session file from ~/.omp. The CLI loses it too. This cannot be undone.",
    );
    expect(sessionActionConfirmation("delete", { title: "t", waiting: true }).because).toBe(
      "Removes the session file from ~/.omp, so the CLI loses it too. It is waiting for your approval; deleting rejects the request. This cannot be undone.",
    );
  });
});

test("the pause command's label follows the state, and the question says every session", () => {
  expect(pauseLabel(false)).toBe("Pause all agents");
  expect(pauseLabel(true)).toBe("Resume all agents");
  const c = pauseConfirmation();
  expect(c.because).toContain("Freezes every open session");
  expect(c.because).toContain("If omp restarts while paused, the sessions start unpaused.");
  expect(c).toMatchObject({ confirm: "Pause", destructive: false });
});

describe("result guards", () => {
  test("counts are whole and not negative", () => {
    expect(isClearContextResult({ dropped: 3 })).toBe(true);
    expect(isClearContextResult({ dropped: -1 })).toBe(false);
    expect(isClearContextResult({ dropped: 1.5 })).toBe(false);
    expect(isDeletePreview({ subagents: 0 })).toBe(true);
    expect(isDeletePreview({})).toBe(false);
  });

  test("pause state has a boolean and an optional finite start", () => {
    expect(isPauseState({ paused: false })).toBe(true);
    expect(isPauseState({ paused: true, since: 1 })).toBe(true);
    expect(isPauseState({ paused: "yes" })).toBe(false);
    expect(isPauseState({ paused: true, since: Number.NaN })).toBe(false);
  });

  test("every action method has its guard, and only the reads are writes-free", () => {
    expect(resultGuards["session.clearContext"]({ dropped: 0 })).toBe(true);
    expect(resultGuards["session.deletePreview"]({ subagents: 0 })).toBe(true);
    expect(resultGuards["session.delete"]({ subagents: 0 })).toBe(true);
    expect(resultGuards["agents.pauseState"]({ paused: false })).toBe(true);
    expect(resultGuards["agents.setPaused"]({ paused: true, since: 5 })).toBe(true);
    expect(methodWrites["session.clearContext"]).toBe(true);
    expect(methodWrites["session.delete"]).toBe(true);
    expect(methodWrites["agents.setPaused"]).toBe(true);
    expect(methodWrites["session.deletePreview"]).toBe(false);
    expect(methodWrites["agents.pauseState"]).toBe(false);
  });
});

test("a boundary item is a timeline item only with a numeric time", () => {
  expect(isTimelineItem({ kind: "boundary", id: "i0", at: 1 })).toBe(true);
  expect(isTimelineItem({ kind: "boundary", id: "i0", at: "1" })).toBe(false);
  expect(isTimelineItem({ kind: "boundary", id: "i0" })).toBe(false);
});
