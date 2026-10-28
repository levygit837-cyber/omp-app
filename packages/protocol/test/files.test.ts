import { describe, expect, test } from "bun:test";
import {
  isFilesDiffResult,
  isFilesReadResult,
  isFilesStatusResult,
  isFilesTreeResult,
  MAX_CHANGES,
  MAX_DIFF_ROWS,
  MAX_FILE_BYTES,
  MAX_FILE_PATH_CHARS,
  MAX_TREE_ENTRIES,
} from "../src/files";

const branch = { name: "main", head: "abc1234", upstream: null, ahead: 0, behind: 0 };
const totals = { added: 0, modified: 0, deleted: 0 };
const change = (i: number) => ({ path: `f${i}`, status: "M", added: 1, removed: 0 });
const status = (changes: unknown[]) => ({
  state: "ok",
  branch,
  changes,
  totals,
  truncated: false,
});

describe("the files guards enforce the limits the protocol declares", () => {
  test("a status holds at most MAX_CHANGES changes", () => {
    const at = Array.from({ length: MAX_CHANGES }, (_, i) => change(i));
    expect(isFilesStatusResult(status(at))).toBe(true);
    expect(isFilesStatusResult(status([...at, change(MAX_CHANGES)]))).toBe(false);
  });

  test("a tree holds at most MAX_TREE_ENTRIES entries, none empty or too long", () => {
    const entry = (i: number) => ({ name: `n${i}`, kind: "file" });
    const at = Array.from({ length: MAX_TREE_ENTRIES }, (_, i) => entry(i));
    expect(isFilesTreeResult({ state: "ok", entries: at, truncated: true })).toBe(true);
    expect(
      isFilesTreeResult({
        state: "ok",
        entries: [...at, entry(MAX_TREE_ENTRIES)],
        truncated: true,
      }),
    ).toBe(false);
    const tenThousand = Array.from({ length: 10_000 }, (_, i) => entry(i));
    expect(isFilesTreeResult({ state: "ok", entries: tenThousand, truncated: true })).toBe(false);
    expect(
      isFilesTreeResult({ state: "ok", entries: [{ name: "", kind: "file" }], truncated: false }),
    ).toBe(false);
    expect(
      isFilesTreeResult({
        state: "ok",
        entries: [{ name: "x".repeat(MAX_FILE_PATH_CHARS + 1), kind: "dir" }],
        truncated: false,
      }),
    ).toBe(false);
  });

  test("a diff holds at most MAX_DIFF_ROWS rows", () => {
    const row = { kind: "context", text: "x", oldLine: 1, newLine: 1 };
    const diff = (rows: unknown[]) => ({
      state: "ok",
      path: "a.ts",
      status: "M",
      rows,
      added: 0,
      removed: 0,
      truncated: true,
    });
    expect(isFilesDiffResult(diff(Array.from({ length: MAX_DIFF_ROWS }, () => row)))).toBe(true);
    expect(isFilesDiffResult(diff(Array.from({ length: MAX_DIFF_ROWS + 1 }, () => row)))).toBe(
      false,
    );
  });

  test("a read holds at most MAX_FILE_BYTES, with text no longer than its bytes", () => {
    const read = (content: string, bytes: number) => ({ state: "ok", path: "a", content, bytes });
    expect(isFilesReadResult(read("x".repeat(MAX_FILE_BYTES), MAX_FILE_BYTES))).toBe(true);
    expect(isFilesReadResult(read("x", MAX_FILE_BYTES + 1))).toBe(false);
    expect(isFilesReadResult(read("x".repeat(10), 3))).toBe(false);
  });

  test("a path over MAX_FILE_PATH_CHARS is refused wherever a result carries one", () => {
    const long = "p".repeat(MAX_FILE_PATH_CHARS + 1);
    expect(isFilesStatusResult(status([{ ...change(0), path: long }]))).toBe(false);
    expect(isFilesStatusResult(status([{ ...change(0), status: "R", from: long }]))).toBe(false);
    expect(isFilesReadResult({ state: "ok", path: long, content: "", bytes: 0 })).toBe(false);
  });
});
