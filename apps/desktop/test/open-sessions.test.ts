import { describe, expect, test } from "bun:test";
import type { StoredSession } from "@omp-app/protocol";
import { relativeTime } from "../src/renderer/format";
import {
  add,
  focus,
  NONE,
  parse,
  type ReopenApi,
  rekey,
  remove,
  reopen,
  serialize,
} from "../src/renderer/open-sessions";
import { buildRows, groupProjects, projectLabels, recentFolders } from "../src/renderer/projects";
import { SessionLostError } from "../src/renderer/session-store";

const set = (open: string[], focused: string | null) => ({ open, focused });

describe("open set", () => {
  test("add opens and focuses; adding an open session only moves focus", () => {
    const a = add(NONE, "a");
    const ab = add(a, "b");
    expect(ab).toEqual(set(["a", "b"], "b"));
    expect(add(ab, "a")).toEqual(set(["a", "b"], "a"));
  });

  test("focus ignores a session that is not open", () => {
    const state = set(["a"], "a");
    expect(focus(state, "zzz")).toBe(state);
    expect(focus(set(["a", "b"], "a"), "b").focused).toBe("b");
  });

  test("closing the focused session focuses the one that took its place, else the previous", () => {
    expect(remove(set(["a", "b", "c"], "b"), "b")).toEqual(set(["a", "c"], "c"));
    expect(remove(set(["a", "b", "c"], "c"), "c")).toEqual(set(["a", "b"], "b"));
    expect(remove(set(["a"], "a"), "a")).toEqual(NONE);
  });

  test("closing another session keeps the focus; closing an unknown one changes nothing", () => {
    expect(remove(set(["a", "b"], "a"), "b")).toEqual(set(["a"], "a"));
    const state = set(["a"], "a");
    expect(remove(state, "zzz")).toBe(state);
  });

  test("parse reads what serialize wrote and treats anything else as none open", () => {
    const state = set(["a", "b"], "b");
    expect(parse(serialize(state))).toEqual(state);
    expect(parse(null)).toEqual(NONE);
    expect(parse("{not json")).toEqual(NONE);
    expect(parse('"a string"')).toEqual(NONE);
    expect(parse('{"open":"a"}')).toEqual(NONE);
    // The old single-session key held a bare id; a bad shape never throws.
    expect(parse('{"open":["a",3,"","a"],"focused":"ghost"}')).toEqual(set(["a"], null));
  });
});

describe("rekey", () => {
  test("the open set and the focus follow a session to its new id, keeping its place", () => {
    expect(rekey(set(["a", "b", "c"], "b"), "b", "b2")).toEqual(set(["a", "b2", "c"], "b2"));
    expect(rekey(set(["a", "b"], "a"), "b", "b2")).toEqual(set(["a", "b2"], "a"));
  });

  test("an id that is not open, or does not change, changes nothing", () => {
    const state = set(["a"], "a");
    expect(rekey(state, "zzz", "y")).toBe(state);
    expect(rekey(state, "a", "a")).toBe(state);
  });

  test("a successor that is already open does not appear twice", () => {
    expect(rekey(set(["a", "b"], "a"), "a", "b")).toEqual(set(["b"], "b"));
  });
});

describe("reopen", () => {
  const api = (
    held: string[],
    onDisk: Record<string, string>,
  ): ReopenApi & { resumed: string[] } => {
    const resumed: string[] = [];
    return {
      resumed,
      async open(id) {
        if (!held.includes(id)) throw new SessionLostError(id);
        return id;
      },
      async resume(id) {
        const to = onDisk[id];
        if (!to) throw new Error(`session not found: ${id}`);
        resumed.push(id);
        held.push(to);
        return to;
      },
    };
  };

  test("a session the sidecar still holds is attached, not resumed", async () => {
    const fake = api(["a", "b"], {});
    const result = await reopen(fake, set(["a", "b"], "b"));
    expect(result).toEqual({ state: set(["a", "b"], "b"), focusedLost: false });
    expect(fake.resumed).toEqual([]);
  });

  test("a session the sidecar forgot is read from disk, keeping its place and focus", async () => {
    const fake = api(["b"], { a: "a" });
    const result = await reopen(fake, set(["a", "b"], "a"));
    expect(result.state).toEqual(set(["a", "b"], "a"));
    expect(fake.resumed).toEqual(["a"]);
  });

  test("a session that is on neither side is dropped; losing the focused one is reported", async () => {
    const fake = api(["b"], {});
    const result = await reopen(fake, set(["a", "b"], "a"));
    expect(result).toEqual({ state: set(["b"], "b"), focusedLost: true });
  });

  test("a session that moved to a new id while it was reopened is remembered under the new one", async () => {
    const fake: ReopenApi = {
      open: async (id) => (id === "old" ? "new" : id),
      resume: async (id) => id,
    };
    const result = await reopen(fake, set(["old", "b"], "old"));
    expect(result.state).toEqual(set(["new", "b"], "new"));
  });

  test("an error other than a lost session drops that session too, and the others survive", async () => {
    const fake: ReopenApi = {
      open: async (id) => {
        if (id === "a") throw new Error("ipc broke");
        return id;
      },
      resume: async (id) => id,
    };
    const result = await reopen(fake, set(["a", "b"], "b"));
    expect(result.state).toEqual(set(["b"], "b"));
  });

  test("nothing remembered, nothing opened", async () => {
    const result = await reopen(api([], {}), NONE);
    expect(result).toEqual({ state: NONE, focusedLost: false });
  });
});

const stored = (id: string, cwd: string, modified: number, patch: Partial<StoredSession> = {}) =>
  ({
    id,
    cwd,
    title: null,
    firstPrompt: "hello there",
    modified,
    turns: 1,
    ...patch,
  }) satisfies StoredSession;

describe("projects", () => {
  test("a row's title is omp's own title, else the first prompt, else New session", () => {
    const rows = buildRows(
      [
        stored("a", "/p", 3, { title: "Named by omp" }),
        stored("b", "/p", 2),
        stored("c", "/p", 1, { firstPrompt: null }),
      ],
      new Map(),
    );
    expect(rows.map((r) => r.title)).toEqual(["Named by omp", "hello there", "New session"]);
  });

  test("an open session the disk listing lacks is added with no title and no time", () => {
    const rows = buildRows(
      [stored("a", "/p", 1)],
      new Map([
        ["a", "/p"],
        ["fresh", "/q"],
      ]),
    );
    expect(rows.find((r) => r.id === "fresh")).toEqual({
      id: "fresh",
      cwd: "/q",
      title: null,
      modified: null,
    });
    expect(rows.filter((r) => r.id === "a")).toHaveLength(1);
  });

  test("order is omp's: rows keep their order, a folder sits where its first row is", () => {
    // omp lists pinned first, then newest. The app has no pin data, so it must not re-sort.
    const rows = buildRows(
      [stored("pinned", "/old", 1), stored("b", "/new", 9), stored("c", "/old", 5)],
      new Map([["fresh", "/old"]]),
    );
    const groups = groupProjects(rows);
    expect(groups.map((g) => g.cwd)).toEqual(["/old", "/new"]);
    expect(groups[0]?.sessions.map((s) => s.id)).toEqual(["fresh", "pinned", "c"]);
  });

  test("recent folders are the first ones in list order, at most `limit`", () => {
    const rows = buildRows(
      [stored("d", "/2", 4), stored("c", "/3", 3), stored("b", "/2", 2), stored("a", "/1", 1)],
      new Map(),
    );
    expect(recentFolders(rows, 2)).toEqual(["/2", "/3"]);
    expect(recentFolders([], 3)).toEqual([]);
  });

  test("two folders with one name get their parent folder in the label", () => {
    const labels = projectLabels(["/work/app", "/play/app", "/work/other", "/a/b/lib", "/c/b/lib"]);
    expect(labels.get("/work/app")).toBe("work/app");
    expect(labels.get("/play/app")).toBe("play/app");
    expect(labels.get("/work/other")).toBe("other");
    expect(labels.get("/a/b/lib")).toBe("a/b/lib");
    expect(labels.get("/c/b/lib")).toBe("c/b/lib");
    expect(projectLabels(["/"]).get("/")).toBe("/");
  });
});

describe("relativeTime", () => {
  const now = Date.UTC(2026, 9, 27, 12);
  const ago = (ms: number) => relativeTime(now - ms, now);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  test("uses the shortest unit that fits", () => {
    expect(ago(0)).toBe("now");
    expect(ago(59_000)).toBe("now");
    expect(ago(5 * MIN)).toBe("5m");
    expect(ago(3 * HOUR)).toBe("3h");
    expect(ago(2 * DAY)).toBe("2d");
    expect(ago(15 * DAY)).toBe("2w");
    expect(ago(90 * DAY)).toBe("3mo");
    expect(ago(800 * DAY)).toBe("2y");
  });

  test("a time in the future (clock skew) reads as now", () => {
    expect(relativeTime(now + 5 * MIN, now)).toBe("now");
  });
});
