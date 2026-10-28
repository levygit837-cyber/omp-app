import { describe, expect, test } from "bun:test";
import { allAdded, parseNumstat, parseStatus, parseUnifiedDiff, totalsOf } from "../src/git-parse";

const nul = (...fields: string[]) => `${fields.join("\0")}\0`;
const oid = "a".repeat(40);

describe("parseStatus", () => {
  test("reads the branch header and every entry kind", () => {
    const text = nul(
      `# branch.oid ${oid}`,
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      `1 .M N... 100644 100644 100644 ${oid} ${oid} dir/with space.txt`,
      `1 A. N... 000000 100644 100644 ${oid} ${oid} added.txt`,
      `1 D. N... 100644 000000 000000 ${oid} ${oid} deleted.txt`,
      `2 R. N... 100644 100644 100644 ${oid} ${oid} R100 new.txt`,
      "old.txt",
      `u UU N... 100644 100644 100644 100644 ${oid} ${oid} ${oid} conflict.txt`,
      "? untracked file.txt",
      "! ignored.log",
    );
    const parsed = parseStatus(text);
    expect(parsed.branch).toEqual({
      name: "main",
      head: "aaaaaaa",
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
    });
    expect(parsed.entries).toEqual([
      { path: "dir/with space.txt", status: "M" },
      { path: "added.txt", status: "A" },
      { path: "deleted.txt", status: "D" },
      { path: "new.txt", from: "old.txt", status: "R" },
      { path: "conflict.txt", status: "U" },
      { path: "untracked file.txt", status: "?" },
    ]);
  });

  test("an initial branch has no head and a detached head has no name", () => {
    const initial = parseStatus(nul("# branch.oid (initial)", "# branch.head main"));
    expect(initial.branch).toMatchObject({ name: "main", head: null, upstream: null, ahead: 0 });
    const detached = parseStatus(nul(`# branch.oid ${oid}`, "# branch.head (detached)"));
    expect(detached.branch.name).toBeNull();
  });

  test("a newline or a dash in a name is data", () => {
    const parsed = parseStatus(nul("? a\nb.txt", "? -x"));
    expect(parsed.entries.map((e) => e.path)).toEqual(["a\nb.txt", "-x"]);
  });

  test("output cut at the cap drops the last, possibly partial, entry", () => {
    const cut = `${nul("? one.txt")}? tw`;
    expect(parseStatus(cut).entries.map((e) => e.path)).toEqual(["one.txt"]);
  });
});

describe("totalsOf", () => {
  test("untracked counts as added, a rename or conflict as modified", () => {
    expect(
      totalsOf([
        { status: "?" },
        { status: "A" },
        { status: "D" },
        { status: "R" },
        { status: "U" },
      ]),
    ).toEqual({ added: 2, modified: 2, deleted: 1 });
  });
});

describe("parseNumstat", () => {
  test("counts, binary files and renames keyed by the new path", () => {
    const text = nul("3\t1\ta b.txt", "-\t-\tbin.dat", "0\t0\t", "old.txt", "new.txt");
    const parsed = parseNumstat(text);
    expect(parsed.get("a b.txt")).toEqual({ added: 3, removed: 1, binary: false });
    expect(parsed.get("bin.dat")).toEqual({ added: null, removed: null, binary: true });
    expect(parsed.get("new.txt")).toEqual({ added: 0, removed: 0, binary: false });
  });
});

describe("parseUnifiedDiff", () => {
  const diff = [
    "diff --git a/f b/f",
    "index 1..2 100644",
    "--- a/f",
    "+++ b/f",
    "@@ -3,3 +3,3 @@ context",
    " keep",
    "-old",
    "+new",
    " keep2",
    "\\ No newline at end of file",
    "@@ -20,2 +20,3 @@",
    " k",
    "+extra",
    " k2",
    "",
  ].join("\n");

  test("numbers rows from the hunk headers and marks the gap between hunks", () => {
    const parsed = parseUnifiedDiff(diff);
    if (parsed.kind !== "rows") throw new Error("expected rows");
    expect(parsed.added).toBe(2);
    expect(parsed.removed).toBe(1);
    expect(parsed.rows.map((r) => r.kind)).toEqual([
      "skip",
      "context",
      "remove",
      "add",
      "context",
      "skip",
      "context",
      "add",
      "context",
    ]);
    expect(parsed.rows[2]).toEqual({ kind: "remove", oldLine: 4, text: "old" });
    expect(parsed.rows[3]).toEqual({ kind: "add", newLine: 4, text: "new" });
    expect(parsed.rows[7]).toEqual({ kind: "add", newLine: 21, text: "extra" });
  });

  test("a file with no hunk and a binary marker is binary", () => {
    expect(parseUnifiedDiff("diff --git a/b b/b\nBinary files a/b and b/b differ\n")).toEqual({
      kind: "binary",
    });
  });

  test("a deletion hunk with a zero count on the new side", () => {
    const parsed = parseUnifiedDiff("--- a/f\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n");
    if (parsed.kind !== "rows") throw new Error("expected rows");
    expect(parsed.rows).toEqual([
      { kind: "remove", oldLine: 1, text: "a" },
      { kind: "remove", oldLine: 2, text: "b" },
    ]);
  });
});

describe("allAdded", () => {
  test("numbers every line and drops a trailing carriage return", () => {
    const parsed = allAdded("a\r\nb\n");
    if (parsed.kind !== "rows") throw new Error("expected rows");
    expect(parsed.rows).toEqual([
      { kind: "add", newLine: 1, text: "a" },
      { kind: "add", newLine: 2, text: "b" },
    ]);
    expect(parsed.added).toBe(2);
  });
});
