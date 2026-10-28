import { describe, expect, test } from "bun:test";
import { findTabElement } from "../src/renderer/tab-lookup";

const tab = (tabKey: string) => ({ dataset: { tabKey } });

// Ids omp may hand over: `task` names are unconstrained strings (`task/types.ts:49` [V]).
const AWKWARD = [
  'subagent:Fix "auth"',
  "subagent:a\\b",
  "subagent:]",
  'subagent:"]; alert(1); ["',
  "subagent:réviser le côté 日本語 🚀",
  "subagent:with space",
  "job:it's",
  "subagent:",
];

describe("finding a tab by its key", () => {
  test.each(AWKWARD)("finds %s and no other tab", (key) => {
    const tabs = [tab("main"), ...AWKWARD.map(tab), tab("job:last")];
    expect(findTabElement(tabs, key)).toBe(tabs[AWKWARD.indexOf(key) + 1]);
  });

  test("is exact: a key that is a prefix, a suffix or a case variant of another finds only itself", () => {
    const tabs = [tab("subagent:a"), tab('subagent:a"'), tab("subagent:A"), tab("xsubagent:a")];
    expect(findTabElement(tabs, "subagent:a")).toBe(tabs[0]);
    expect(findTabElement(tabs, 'subagent:a"')).toBe(tabs[1]);
    expect(findTabElement(tabs, "subagent:A")).toBe(tabs[2]);
  });

  test("is undefined when no tab has the key, or the elements carry none", () => {
    expect(findTabElement([tab("main")], "job:gone")).toBeUndefined();
    expect(findTabElement([{ dataset: {} }], "main")).toBeUndefined();
    expect(findTabElement([], "main")).toBeUndefined();
  });
});
