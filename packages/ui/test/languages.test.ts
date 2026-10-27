import { describe, expect, test } from "bun:test";
import { parseFenceInfo, resolveLanguage } from "../src/languages";

describe("resolveLanguage", () => {
  test.each([
    ["ts", "typescript"],
    ["typescript", "typescript"],
    ["TSX", "typescript"],
    ["sh", "bash"],
    ["zsh", "bash"],
    ["language-bash", "bash"],
    ["bash title=x", "bash"],
    ["ts {1,3}", "typescript"],
    [".py", "python"],
    ["C++", "cpp"],
    ["yml", "yaml"],
    ["toml", "ini"],
    ["html", "xml"],
    ["text", "plaintext"],
  ])("%j -> %s", (info, id) => {
    expect(resolveLanguage(info)).toBe(id as never);
  });

  test.each([["klingon"], [""], [null], [undefined], ["title=x"], ["constructor"], ["__proto__"]])(
    "%j is unknown",
    (info) => {
      expect(resolveLanguage(info)).toBeNull();
    },
  );
});

describe("parseFenceInfo", () => {
  test("extracts file name", () => {
    expect(parseFenceInfo('ts title="src/a.ts"')).toEqual({ language: "ts", filename: "src/a.ts" });
    expect(parseFenceInfo("bash file=run.sh")).toEqual({ language: "bash", filename: "run.sh" });
  });
  test("no language", () => {
    expect(parseFenceInfo("title=x")).toEqual({ language: null, filename: "x" });
  });
});
