import { describe, expect, test } from "bun:test";
import type { SettingEntry, SettingsListing } from "@omp-app/protocol";
import {
  changedByTab,
  effectiveChain,
  formatValue,
  matchedByKeyOnly,
  mergeEntries,
  parseJsonInput,
  parseNumberInput,
  resetTarget,
  searchEntries,
  sectionsOf,
  shortPath,
} from "../src/renderer/settings-model";

const unset = { set: false } as const;

function entry(over: Partial<SettingEntry> & { id: string }): SettingEntry {
  return {
    tab: "shell",
    group: "Bash",
    label: over.id,
    description: "",
    type: "number",
    secret: false,
    envActive: false,
    value: 1,
    source: "default",
    layers: { default: 1, global: unset, project: unset },
    ...over,
  };
}

const FILES: SettingsListing["files"] = {
  global: "/Users/me/.omp/agent/config.yml",
  project: "/Users/me/app/.omp/config.yml",
};

describe("sectionsOf", () => {
  test("groups contiguous entries by tab and section, keeping the listing order", () => {
    const sections = sectionsOf([
      entry({ id: "a", group: null }),
      entry({ id: "b", group: "Bash" }),
      entry({ id: "c", group: "Bash" }),
      entry({ id: "d", tab: "files", group: "Bash" }),
    ]);
    expect(sections.map((s) => [s.tab, s.group, s.entries.map((e) => e.id)])).toEqual([
      ["shell", null, ["a"]],
      ["shell", "Bash", ["b", "c"]],
      ["files", "Bash", ["d"]],
    ]);
  });
});

describe("changedByTab", () => {
  test("counts what the scope's own file sets, not what the other scope sets", () => {
    const entries = [
      entry({ id: "a", layers: { default: 1, global: { set: true, value: 2 }, project: unset } }),
      entry({ id: "b", layers: { default: 1, global: unset, project: { set: true, value: 3 } } }),
      entry({ id: "c", tab: "files" }),
    ];
    expect(changedByTab(entries, "global")).toEqual({ shell: 1 });
    expect(changedByTab(entries, "project")).toEqual({ shell: 1 });
  });
});

describe("searchEntries", () => {
  const entries = [
    entry({ id: "bash.timeout", label: "Command timeout", description: "Kills a bash call" }),
    entry({ id: "web.requestTimeout", label: "Request limit", description: "Network" }),
    entry({ id: "edit.fuzzy", label: "Fuzzy", description: "Whitespace drift" }),
  ];

  test("matches every word against label, description and key, case-insensitively", () => {
    expect(searchEntries(entries, "TIMEOUT").map((e) => e.id)).toEqual([
      "bash.timeout",
      "web.requestTimeout",
    ]);
    expect(searchEntries(entries, "bash kills").map((e) => e.id)).toEqual(["bash.timeout"]);
  });

  test("an empty query matches nothing, so the screen shows the section instead", () => {
    expect(searchEntries(entries, "   ")).toEqual([]);
  });

  test("flags a result that matched through its key only", () => {
    const [byText, byKey] = searchEntries(entries, "timeout");
    if (!byText || !byKey) throw new Error("expected two results");
    expect(matchedByKeyOnly(byText, "timeout")).toBe(false);
    expect(matchedByKeyOnly(byKey, "timeout")).toBe(true);
  });
});

describe("effectiveChain", () => {
  const e = entry({
    id: "retry.maxDelayMs",
    unit: "ms",
    value: 222,
    source: "project",
    layers: {
      default: 300000,
      global: { set: true, value: 111 },
      project: { set: true, value: 222 },
    },
  });

  test("project scope lists Project over Global over the default and marks the winner", () => {
    const rows = effectiveChain(e, FILES, "project");
    expect(rows.map((r) => [r.source, r.value, r.effective])).toEqual([
      ["project", "222 ms", true],
      ["global", "111 ms", false],
      ["default", "300000 ms", false],
    ]);
    expect(rows[0]?.where).toBe("~/app/.omp/config.yml");
  });

  test("global scope has no project row", () => {
    const rows = effectiveChain({ ...e, source: "global" }, FILES, "global");
    expect(rows.map((r) => r.source)).toEqual(["global", "default"]);
    expect(rows[0]?.effective).toBe(true);
  });

  test("a secret's layers show that they are set, never the value", () => {
    const secret = entry({
      id: "hindsight.apiToken",
      secret: true,
      value: null,
      source: "global",
      layers: { default: null, global: { set: true }, project: unset },
    });
    const rows = effectiveChain(secret, FILES, "global");
    expect(rows[0]?.value).toBe("set");
  });

  test("reset falls back to Global only when the global file sets the key", () => {
    expect(resetTarget(e, "project")).toBe("Global");
    expect(resetTarget(entry({ id: "x" }), "project")).toBe("default");
    expect(resetTarget(e, "global")).toBe("default");
  });
});

describe("formatValue", () => {
  test("uses option labels, units, On/Off and lists", () => {
    const withOptions = entry({
      id: "x",
      options: [{ value: "0", label: "Unlimited" }],
    });
    expect(formatValue(withOptions, 0)).toBe("Unlimited");
    expect(formatValue(entry({ id: "x", unit: "s" }), 60)).toBe("60 s");
    expect(formatValue(entry({ id: "x", type: "boolean" }), true)).toBe("On");
    expect(formatValue(entry({ id: "x", type: "array" }), [])).toBe("empty list");
    expect(formatValue(entry({ id: "x", type: "array" }), ["a", "b"])).toBe("a, b");
    expect(formatValue(entry({ id: "x" }), undefined)).toBe("not set");
  });
});

describe("mergeEntries", () => {
  test("replaces entries by id and leaves the rest, in place", () => {
    const listing: SettingsListing = {
      scope: "global",
      tabs: [],
      files: FILES,
      entries: [entry({ id: "a", value: 1 }), entry({ id: "b", value: 2 })],
    };
    const merged = mergeEntries(listing, [entry({ id: "b", value: 9 })]);
    expect(merged.entries.map((x) => [x.id, x.value])).toEqual([
      ["a", 1],
      ["b", 9],
    ]);
    expect(merged.entries[0]).toBe(listing.entries[0]);
  });
});

describe("input parsing", () => {
  test("a number field accepts decimals and refuses empty or non-numeric text", () => {
    expect(parseNumberInput(" 0.5 ")).toEqual({ ok: true, value: 0.5 });
    expect(parseNumberInput("").ok).toBe(false);
    expect(parseNumberInput("12ms").ok).toBe(false);
    expect(parseNumberInput("Infinity").ok).toBe(false);
  });

  test("JSON fields refuse text that does not parse", () => {
    expect(parseJsonInput('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonInput("{a:1}").ok).toBe(false);
  });

  test("shortPath shortens a home directory only", () => {
    expect(shortPath("/Users/me/x/.omp/config.yml")).toBe("~/x/.omp/config.yml");
    expect(shortPath("/opt/x")).toBe("/opt/x");
  });
});
