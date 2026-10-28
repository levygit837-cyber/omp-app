import { describe, expect, test } from "bun:test";
import type { FileChange, GitBranch, Item, TreeEntry } from "@omp-app/protocol";
import {
  ancestorsOf,
  branchChip,
  branchNote,
  type DirNode,
  debounce,
  flattenTree,
  formatBytes,
  languageOf,
  legendOf,
  markersOf,
  navigateTree,
  searchEscape,
  searchTarget,
  shouldRefresh,
  type Timers,
  type TreeRow,
  touchEpoch,
} from "../src/renderer/files/files-model";

const change = (path: string, status: FileChange["status"] = "M"): FileChange => ({
  path,
  status,
  added: 1,
  removed: 0,
});
const branch = (over: Partial<GitBranch> = {}): GitBranch => ({
  name: "main",
  head: "abcdef1234",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  ...over,
});
const file = (name: string): TreeEntry => ({ name, kind: "file" });
const dir = (name: string): TreeEntry => ({ name, kind: "dir" });
const ready = (...entries: TreeEntry[]): DirNode => ({ state: "ready", entries, truncated: false });

describe("markers", () => {
  test("a change marks its file and every folder above it, and nothing else", () => {
    const markers = markersOf([change("src/a/b.ts", "A"), change("README.md")]);
    expect(markers.files).toEqual({ "src/a/b.ts": "A", "README.md": "M" });
    expect(Object.keys(markers.dirs).sort()).toEqual(["src", "src/a"]);
  });

  test("the legend lists only statuses that occur, in a fixed order", () => {
    expect(legendOf([change("a", "?"), change("b", "M"), change("c", "?")])).toEqual(["M", "?"]);
    expect(legendOf([])).toEqual([]);
  });
});

describe("branch", () => {
  test("the chip shows new, modified and deleted counts and leaves zeros out", () => {
    expect(branchChip(branch(), { added: 2, modified: 1, deleted: 0 })?.counts).toBe("+2 ~1");
    expect(branchChip(branch(), { added: 0, modified: 0, deleted: 3 })?.counts).toBe("-3");
    const clean = branchChip(branch(), { added: 0, modified: 0, deleted: 0 });
    expect(clean?.counts).toBe("");
    expect(clean?.label).toBe("Branch main, no changes");
  });

  test("a detached HEAD is named by its short commit; no commit and no branch has no chip", () => {
    const detached = branchChip(branch({ name: null }), { added: 0, modified: 1, deleted: 0 });
    expect(detached?.name).toBe("abcdef1");
    expect(detached?.label).toBe("Detached at abcdef1, 1 modified");
    expect(
      branchChip(branch({ name: null, head: null }), { added: 0, modified: 0, deleted: 0 }),
    ).toBeNull();
  });

  test("the note says how far the branch is from its upstream", () => {
    expect(branchNote(branch())).toBe("Up to date with origin/main");
    expect(branchNote(branch({ ahead: 1 }))).toBe("1 commit ahead of origin/main");
    expect(branchNote(branch({ behind: 2 }))).toBe("2 commits behind origin/main");
    expect(branchNote(branch({ ahead: 2, behind: 1 }))).toBe(
      "2 commits ahead and 1 commit behind origin/main",
    );
    expect(branchNote(branch({ upstream: null }))).toBe("No upstream branch");
    expect(branchNote(branch({ name: null }))).toBe("Detached HEAD");
  });
});

describe("tree rows", () => {
  const markers = markersOf([change("src/a.ts"), change("top.md", "A")]);
  const dirs: Record<string, DirNode> = {
    "": ready(dir("src"), dir("empty"), file("top.md")),
    src: ready(file("a.ts"), file("b.ts")),
    empty: ready(),
  };

  test("collapsed folders hide their children; changed files carry a letter, folders a dot", () => {
    const rows = flattenTree(dirs, new Set(), markers);
    expect(rows.map((r) => (r.kind === "entry" ? r.path : r.key))).toEqual([
      "src",
      "empty",
      "top.md",
    ]);
    const [src, , top] = rows;
    expect(src?.kind === "entry" && src.dot).toBe(true);
    expect(top?.kind === "entry" && top.status).toBe("A");
  });

  test("an open folder shows its children one level deeper with their position among siblings", () => {
    const rows = flattenTree(dirs, new Set(["src"]), markers);
    const a = rows.find((r) => r.kind === "entry" && r.path === "src/a.ts");
    expect(a).toMatchObject({ depth: 1, index: 1, siblings: 2, status: "M" });
  });

  test("not loaded, empty, failed and truncated folders say so instead of staying blank", () => {
    const notes = (nodes: Record<string, DirNode>, open: string[]) =>
      flattenTree(nodes, new Set(open), markersOf([]))
        .filter((r) => r.kind === "note")
        .map((r) => (r.kind === "note" ? r.text : ""));
    expect(notes({}, [])).toEqual(["Loading…"]);
    expect(notes({ "": ready(dir("empty")), empty: ready() }, ["empty"])).toEqual(["Empty folder"]);
    expect(notes({ "": { state: "failed", message: "nope" } }, [])).toEqual(["nope"]);
    expect(
      notes({ "": { state: "ready", entries: [file("a")], truncated: true } }, []),
    ).toHaveLength(1);
  });

  test("a file is never expanded, even if its path is in the set", () => {
    const rows = flattenTree(dirs, new Set(["top.md"]), markers);
    expect(rows.filter((r) => r.kind === "entry" && r.path === "top.md")).toMatchObject([
      { expanded: false },
    ]);
  });
});

describe("tree keys", () => {
  const dirs: Record<string, DirNode> = {
    "": ready(dir("src"), file("top.md")),
    src: ready(dir("deep"), file("a.ts")),
    "src/deep": ready(file("x.ts")),
  };
  const rows = (open: string[]): TreeRow[] => flattenTree(dirs, new Set(open), markersOf([]));

  test("arrows, Home and End move focus and stop at the ends", () => {
    const r = rows(["src"]);
    expect(navigateTree(r, "src", "ArrowDown")).toEqual({ kind: "focus", path: "src/deep" });
    expect(navigateTree(r, "src", "ArrowUp")).toBeNull();
    expect(navigateTree(r, "src/a.ts", "Home")).toEqual({ kind: "focus", path: "src" });
    expect(navigateTree(r, "src", "End")).toEqual({ kind: "focus", path: "top.md" });
    expect(navigateTree(r, "top.md", "ArrowDown")).toBeNull();
  });

  test("Right opens a closed folder, then enters it; Left closes it, then goes to the parent", () => {
    expect(navigateTree(rows([]), "src", "ArrowRight")).toEqual({ kind: "expand", path: "src" });
    const open = rows(["src"]);
    expect(navigateTree(open, "src", "ArrowRight")).toEqual({ kind: "focus", path: "src/deep" });
    expect(navigateTree(open, "src", "ArrowLeft")).toEqual({ kind: "collapse", path: "src" });
    expect(navigateTree(open, "src/a.ts", "ArrowLeft")).toEqual({ kind: "focus", path: "src" });
    expect(navigateTree(open, "top.md", "ArrowLeft")).toBeNull();
    expect(navigateTree(open, "top.md", "ArrowRight")).toBeNull();
  });

  test("Enter and Space open a file and toggle a folder; other keys and unknown rows do nothing", () => {
    const open = rows(["src"]);
    expect(navigateTree(open, "top.md", "Enter")).toEqual({ kind: "open", path: "top.md" });
    expect(navigateTree(open, "src", " ")).toEqual({ kind: "collapse", path: "src" });
    expect(navigateTree(rows([]), "src", "Enter")).toEqual({ kind: "expand", path: "src" });
    expect(navigateTree(open, "src", "a")).toBeNull();
    expect(navigateTree(open, "gone", "ArrowDown")).toBeNull();
  });
});

describe("refresh", () => {
  const tool = (name: string, ...statuses: ("running" | "done" | "failed")[]): Item =>
    ({
      kind: "tool",
      id: name,
      tool: name,
      calls: statuses.map((status, i) => ({ toolCallId: `${name}${i}`, status, startedAt: 0 })),
    }) as Item;

  test("only ended calls of tools that can write count; a running call does not", () => {
    expect(touchEpoch([])).toBe(0);
    expect(touchEpoch([tool("read", "done"), tool("grep", "done")])).toBe(0);
    expect(touchEpoch([tool("edit", "running")])).toBe(0);
    expect(touchEpoch([tool("edit", "done"), tool("bash", "failed", "running")])).toBe(2);
  });

  test("a refresh follows a finished write or the end of a turn, not the start of one", () => {
    expect(shouldRefresh({ epoch: 0, status: "idle" }, { epoch: 1, status: "streaming" })).toBe(
      true,
    );
    expect(shouldRefresh({ epoch: 1, status: "streaming" }, { epoch: 1, status: "idle" })).toBe(
      true,
    );
    expect(shouldRefresh({ epoch: 1, status: "idle" }, { epoch: 1, status: "streaming" })).toBe(
      false,
    );
    expect(
      shouldRefresh({ epoch: 1, status: "streaming" }, { epoch: 1, status: "streaming" }),
    ).toBe(false);
  });

  test("debounce runs once after the last trigger, and not at all once cancelled", () => {
    const pending: { cb: () => void; live: boolean }[] = [];
    const flush = () => {
      for (const slot of pending) {
        if (!slot.live) continue;
        slot.live = false;
        slot.cb();
      }
    };
    const timers: Timers = {
      set: (cb) => {
        const slot = { cb, live: true };
        pending.push(slot);
        return () => {
          slot.live = false;
        };
      },
    };
    let runs = 0;
    const d = debounce(() => runs++, 250, timers);
    d.trigger();
    d.trigger();
    d.trigger();
    flush();
    expect(runs).toBe(1);
    d.trigger();
    d.cancel();
    flush();
    expect(runs).toBe(1);
  });
});

describe("paths and display", () => {
  test("search results ending in a slash are folders", () => {
    expect(searchTarget("src/")).toEqual({ path: "src", kind: "dir" });
    expect(searchTarget("src/a.ts")).toEqual({ path: "src/a.ts", kind: "file" });
  });

  test("Esc clears a search with text and passes through when it is empty", () => {
    expect(searchEscape("ab")).toBe("clear");
    expect(searchEscape("")).toBe("pass");
  });

  test("ancestors run from the outermost folder in", () => {
    expect(ancestorsOf("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestorsOf("c.ts")).toEqual([]);
  });

  test("languages come from the extension or a whole name", () => {
    expect(languageOf("src/App.TSX")).toBe("tsx");
    expect(languageOf("Dockerfile")).toBe("dockerfile");
    expect(languageOf(".gitignore")).toBeNull();
    expect(languageOf("LICENSE")).toBeNull();
  });

  test("sizes use binary units", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });
});
