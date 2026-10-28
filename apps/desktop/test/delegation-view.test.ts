import { describe, expect, test } from "bun:test";
import type { JobInfo, SubagentInfo } from "@omp-app/protocol";
import {
  isBusy,
  MAIN_TAB,
  moveTab,
  resolveTab,
  statusNote,
  subagentsPhrase,
  subagentTree,
  summarize,
  tabKey,
  tabsOf,
  tokensLabel,
} from "../src/renderer/delegation-view";

const sub = (id: string, over: Partial<SubagentInfo> = {}): SubagentInfo => ({
  id,
  viewId: `view:s:${id}`,
  agent: "task",
  description: null,
  status: "running",
  startedAt: 1000,
  tokens: 0,
  ...over,
});
const job = (id: string, over: Partial<JobInfo> = {}): JobInfo => ({
  id,
  type: "bash",
  status: "running",
  label: id,
  startTime: 1000,
  ...over,
});

describe("tabs of a session", () => {
  const delegation = { subagents: [sub("a"), sub("b")], jobs: [job("j")] };

  test("the chat comes first, then subagents in start order, then jobs", () => {
    expect(tabsOf(delegation, new Set()).map(tabKey)).toEqual([
      "main",
      "subagent:a",
      "subagent:b",
      "job:j",
    ]);
  });

  test("a dismissed tab leaves the bar, the chat can never be dismissed", () => {
    const keys = tabsOf(delegation, new Set(["subagent:a", "main"])).map(tabKey);
    expect(keys).toEqual(["main", "subagent:b", "job:j"]);
  });

  test("a tab that no longer exists falls back to the chat instead of a blank panel", () => {
    const tabs = tabsOf(delegation, new Set());
    expect(resolveTab(tabs, { kind: "job", id: "gone" })).toEqual(MAIN_TAB);
    expect(resolveTab(tabs, { kind: "subagent", id: "b" })).toEqual({ kind: "subagent", id: "b" });
    expect(resolveTab(tabs, undefined)).toEqual(MAIN_TAB);
  });

  test("a subagent and a job with the same id are different tabs", () => {
    expect(tabKey({ kind: "subagent", id: "x" })).not.toBe(tabKey({ kind: "job", id: "x" }));
  });
});

describe("roving focus", () => {
  const keys = ["main", "subagent:a", "job:j"];

  test("arrows wrap around both ends", () => {
    expect(moveTab(keys, "job:j", "ArrowRight")).toBe("main");
    expect(moveTab(keys, "main", "ArrowLeft")).toBe("job:j");
    expect(moveTab(keys, "main", "ArrowRight")).toBe("subagent:a");
  });

  test("Home and End jump; other keys are left alone", () => {
    expect(moveTab(keys, "subagent:a", "Home")).toBe("main");
    expect(moveTab(keys, "subagent:a", "End")).toBe("job:j");
    expect(moveTab(keys, "main", "a")).toBeNull();
    expect(moveTab([], "main", "ArrowRight")).toBeNull();
  });
});

describe("subagent tree", () => {
  test("a child hangs under its parent, even when it was listed first", () => {
    const rows = subagentTree([sub("kid", { parentId: "dad" }), sub("dad")]);
    expect(rows.map((r) => [r.sub.id, r.depth])).toEqual([
      ["dad", 0],
      ["kid", 1],
    ]);
  });

  test("the last sibling is marked so its connector can end", () => {
    const rows = subagentTree([sub("a"), sub("b")]);
    expect(rows.map((r) => r.last)).toEqual([false, true]);
  });

  test("a parent that was never seen makes the child a root: nothing vanishes", () => {
    const rows = subagentTree([sub("orphan", { parentId: "unknown" })]);
    expect(rows.map((r) => [r.sub.id, r.depth])).toEqual([["orphan", 0]]);
  });

  test("members of a cycle reported by omp all stay listed, once each", () => {
    const rows = subagentTree([sub("a", { parentId: "b" }), sub("b", { parentId: "a" })]);
    expect(rows.map((r) => r.sub.id).sort()).toEqual(["a", "b"]);
  });

  test("a subagent that names itself as parent is still listed", () => {
    const rows = subagentTree([sub("a", { parentId: "a" })]);
    expect(rows.map((r) => r.sub.id)).toEqual(["a"]);
  });
});

describe("summary above the input bar", () => {
  test("counts live subagents and running jobs; finished work is silent", () => {
    const s = summarize({
      subagents: [sub("a"), sub("b", { status: "completed" }), sub("c")],
      jobs: [job("j"), job("k", { status: "cancelled" })],
    });
    expect(s.subagentsRunning).toBe(2);
    expect(s.jobsRunning.map((j) => j.id)).toEqual(["j"]);
    expect(isBusy(s)).toBe(true);
    expect(isBusy(summarize({ subagents: [sub("a", { status: "failed" })], jobs: [] }))).toBe(
      false,
    );
  });

  test("phrase says how many of how many, and nothing when none runs", () => {
    const of = (running: number, total: number) =>
      subagentsPhrase({ subagentsRunning: running, subagentsTotal: total, jobsRunning: [] });
    expect(of(1, 2)).toBe("1 of 2 subagents");
    expect(of(2, 2)).toBe("2 subagents");
    expect(of(1, 1)).toBe("1 subagent");
    expect(of(0, 3)).toBeNull();
  });
});

describe("status words", () => {
  test("running shows elapsed time, finished shows how long it took", () => {
    expect(statusNote("running", 1000, undefined, 66_000)).toBe("1:05");
    expect(statusNote("completed", 1000, 8000, 99_000)).toBe("0:07");
  });

  test("failed and stopped say so in words", () => {
    expect(statusNote("failed", 0, 5, 9)).toBe("failed");
    expect(statusNote("aborted", 0, 5, 9)).toBe("stopped");
    expect(statusNote("cancelled", 0, 5, 9)).toBe("cancelled");
  });

  test("tokens read as the design writes them", () => {
    expect(tokensLabel(950)).toBe("950");
    expect(tokensLabel(1240)).toBe("1.2k");
    expect(tokensLabel(12_400)).toBe("12k");
  });
});
