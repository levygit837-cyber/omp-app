import { describe, expect, test } from "bun:test";
import { matchText, rank } from "../src/renderer/palette/search";

const find = (query: string, names: string[], description?: Record<string, string>) =>
  rank(names, query, (name) => ({
    name,
    ...(description?.[name] ? { description: description[name] } : {}),
  })).map((r) => r.item);

describe("matchText", () => {
  test("an empty query matches everything and highlights nothing", () => {
    expect(matchText("  ", "compact")).toEqual({ score: 0, ranges: [] });
  });

  test("is case-insensitive and reports where the hit is", () => {
    expect(matchText("COM", "compact")?.ranges).toEqual([[0, 3]]);
    expect(matchText("pac", "compact")?.ranges).toEqual([[3, 6]]);
  });

  test("a subsequence matches and highlights each run of letters", () => {
    expect(matchText("cmpt", "compact")?.ranges).toEqual([
      [0, 1],
      [2, 4],
      [6, 7],
    ]);
    expect(matchText("xyz", "compact")).toBeNull();
  });

  test("letters must appear in order", () => {
    expect(matchText("tcp", "compact")).toBeNull();
  });
});

describe("rank", () => {
  test("a name prefix beats a word start, a substring and a subsequence, in that order", () => {
    const names = ["xx-mcp-tools", "reload-mcp", "mapcore-p", "mcp"];
    expect(find("mcp", names)).toEqual(["mcp", "xx-mcp-tools", "reload-mcp", "mapcore-p"]);
  });

  test("inside a tier the earlier hit wins", () => {
    expect(find("mcp", ["reload-mcp", "a-mcp"])).toEqual(["a-mcp", "reload-mcp"]);
  });

  test("a word start beats a substring in the middle of a word", () => {
    expect(find("mod", ["permodel", "per-model"])).toEqual(["per-model", "permodel"]);
  });

  test("a shorter name wins inside a tier, and ties keep the input order", () => {
    expect(find("co", ["compact", "co", "context", "copy"])).toEqual([
      "co",
      "copy",
      "compact",
      "context",
    ]);
    expect(find("c", ["cb", "ca"])).toEqual(["cb", "ca"]);
  });

  test("a description hit ranks under every name hit, even a weak one", () => {
    const description = { export: "Writes the session to a file", model: "pick a model" };
    // "file" is a prefix of nothing here; it is in export's description, and a subsequence of "profile".
    expect(find("file", ["export", "profile"], description)).toEqual(["profile", "export"]);
  });

  test("an alias finds the item, and the name is not highlighted for a hit that is not in it", () => {
    const item = { n: "worktree", a: ["zq"] };
    const out = rank([item], "zq", (x) => ({ name: x.n, alt: x.a }));
    expect(out.map((r) => r.item)).toEqual([item]);
    expect(out[0]?.ranges).toEqual([]);
  });

  test("the name's own hit is highlighted when the name matches", () => {
    const out = rank([{ n: "switch", a: ["sw"] }], "sw", (x) => ({ name: x.n, alt: x.a }));
    expect(out[0]?.ranges).toEqual([[0, 2]]);
  });

  test("with no query every item stays in order", () => {
    expect(find("", ["b", "a", "c"])).toEqual(["b", "a", "c"]);
  });
});
