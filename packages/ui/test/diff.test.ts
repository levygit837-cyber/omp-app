import { describe, expect, test } from "bun:test";
import { type DiffLine, diffStats, parseUnifiedDiff } from "../src/diff";

const SAMPLE = `diff --git a/x.ts b/x.ts
index 1..2 100644
--- a/x.ts
+++ b/x.ts
@@ -14,3 +14,4 @@ createSupervisor
 const sup = create({
-  sleep: wait,
+  clock,
+  tick,
 });
@@ -40 +41 @@
-old
+new
\\ No newline at end of file
`;

describe("parseUnifiedDiff", () => {
  const lines = parseUnifiedDiff(SAMPLE);

  test("numbers lines and ignores headers", () => {
    expect(lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["skip", undefined, undefined],
      ["context", 14, 14],
      ["remove", 15, undefined],
      ["add", undefined, 15],
      ["add", undefined, 16],
      ["context", 16, 17],
      ["skip", undefined, undefined],
      ["remove", 40, undefined],
      ["add", undefined, 41],
    ]);
    expect(lines[0]?.text).toBe("… 13 lines above");
    expect(lines[1]?.text).toBe("const sup = create({");
    expect(lines[6]?.text).toBe("… 23 lines");
  });

  test("stats", () => {
    expect(diffStats(lines)).toEqual({ added: 3, removed: 2 });
  });

  test("CRLF", () => {
    const out = parseUnifiedDiff("@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+c\r\n");
    expect(out.map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  test("a removed line starting with dashes is not a header", () => {
    const out = parseUnifiedDiff("--- a\n+++ b\n@@ -1,2 +1,1 @@\n--- not a header\n x\n");
    expect(out.map((l) => [l.kind, l.text])).toEqual([
      ["remove", "-- not a header"],
      ["context", "x"],
    ]);
  });

  test("empty input and text outside hunks", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("hello\nworld")).toEqual([]);
  });
});

describe("diffStats", () => {
  test("ignores context and skip", () => {
    const lines: DiffLine[] = [
      { kind: "skip", text: "…" },
      { kind: "context", text: "a" },
      { kind: "add", text: "b" },
    ];
    expect(diffStats(lines)).toEqual({ added: 1, removed: 0 });
  });
});
