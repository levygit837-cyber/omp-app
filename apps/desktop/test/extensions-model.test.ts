import { describe, expect, test } from "bun:test";
import type { McpServerEntry, SkillEntry } from "@omp-app/protocol";
import { wrapFocus } from "../src/renderer/dialog-focus";
import {
  draftChanged,
  draftOf,
  duplicateKey,
  EMPTY_DRAFT,
  failuresByServer,
  filterServers,
  filterSkills,
  groupSkills,
  inputOf,
  joinArgs,
  splitArgs,
} from "../src/renderer/extensions-model";

const entry = (over: Partial<McpServerEntry> = {}): McpServerEntry => ({
  name: "s",
  transport: "stdio",
  command: "npx",
  args: [],
  urlRedacted: false,
  envKeys: [],
  headerKeys: [],
  enabled: true,
  ...over,
});
const skill = (name: string, origin: SkillEntry["origin"], description?: string): SkillEntry => ({
  name,
  origin,
  provider: "OMP",
  state: "active",
  toggleable: true,
  ...(description === undefined ? {} : { description }),
});

describe("splitArgs / joinArgs", () => {
  test("whitespace separates, quotes group, a backslash escapes", () => {
    expect(splitArgs(`-y  @scope/pkg "a b" 'c d' e\\ f`)).toEqual([
      "-y",
      "@scope/pkg",
      "a b",
      "c d",
      "e f",
    ]);
    expect(splitArgs(`"" x`)).toEqual(["", "x"]);
    expect(splitArgs("   ")).toEqual([]);
    expect(splitArgs(`"unterminated arg`)).toEqual(["unterminated arg"]);
  });

  test("joining then splitting returns the same arguments", () => {
    const args = ["-y", "a b", `say "hi"`, "back\\slash", "", "plain", "it's"];
    expect(splitArgs(joinArgs(args))).toEqual(args);
  });
});

describe("the form", () => {
  test("an edit sends null for a stored value and the text for a retyped one", () => {
    const draft = draftOf(entry({ envKeys: ["A", "B"] }));
    expect(draft.env.every((r) => r.stored && r.value === "")).toBe(true);
    const retyped = {
      ...draft,
      env: [
        { key: "A", value: "", stored: true },
        { key: "B", value: "new", stored: false },
      ],
    };
    expect(inputOf(retyped).env).toEqual({ A: null, B: "new" });
  });

  test("a redacted URL is not put in the form, so the sidecar keeps the stored one", () => {
    const draft = draftOf(
      entry({ transport: "http", url: "https://•••@h/p", urlRedacted: true, command: undefined }),
    );
    expect(draft.url).toBe("");
    expect(inputOf(draft).url).toBeUndefined();
  });

  test("fields of the other transport are not sent, and empty rows are dropped", () => {
    const stdio = {
      ...draftOf(entry()),
      url: "https://x",
      headers: [{ key: "H", value: "v", stored: false }],
      env: [{ key: "  ", value: "ignored", stored: false }],
    };
    expect(inputOf(stdio)).toEqual({ name: "s", transport: "stdio", command: "npx" });
    const http = { ...stdio, transport: "http" as const, name: " api ", url: " https://x " };
    expect(inputOf(http)).toEqual({
      name: "api",
      transport: "http",
      url: "https://x",
      headers: { H: "v" },
    });
  });

  test("duplicate keys are found after trimming", () => {
    const row = (key: string) => ({ key, value: "", stored: false });
    expect(duplicateKey([row("A"), row(" "), row("B")])).toBeNull();
    expect(duplicateKey([row("A"), row("B"), row("A ")])).toBe("A");
  });
});

describe("lists", () => {
  test("filters servers by name or target, skills by name or description", () => {
    const servers = [
      entry({ name: "linear", transport: "http", url: "https://mcp.linear.app" }),
      entry({ name: "fs", command: "node", args: ["fs.js"] }),
    ];
    expect(filterServers(servers, " LINEAR ").map((s) => s.name)).toEqual(["linear"]);
    expect(filterServers(servers, "fs.js").map((s) => s.name)).toEqual(["fs"]);
    expect(filterServers(servers, "")).toBe(servers);
    const skills = [
      skill("pdf", "user", "Reads files"),
      skill("commit", "user", "Writes messages"),
    ];
    expect(filterSkills(skills, "files").map((s) => s.name)).toEqual(["pdf"]);
  });

  test("skills group project, user, plugin, without empty groups", () => {
    const groups = groupSkills([skill("a", "plugin"), skill("b", "project"), skill("c", "plugin")]);
    expect(groups.map((g) => [g.origin, g.skills.map((s) => s.name)])).toEqual([
      ["project", ["b"]],
      ["plugin", ["a", "c"]],
    ]);
  });

  test("server failures come from the session's mcp warnings, the latest per server", () => {
    expect(
      failuresByServer([
        { source: "mcp", server: "pw", message: "first" },
        { source: "session", title: "t", message: "x" },
        { source: "mcp", server: "pw", message: "second" },
      ]),
    ).toEqual({ pw: "second" });
    expect(failuresByServer(undefined)).toEqual({});
  });
});

describe("draftChanged", () => {
  test("a form nobody touched is not dirty; any edit is", () => {
    expect(draftChanged(EMPTY_DRAFT, { ...EMPTY_DRAFT })).toBe(false);
    expect(draftChanged(EMPTY_DRAFT, { ...EMPTY_DRAFT, name: "a" })).toBe(true);
    const stored = draftOf(entry({ envKeys: ["TOKEN"] }));
    expect(draftChanged(stored, draftOf(entry({ envKeys: ["TOKEN"] })))).toBe(false);
    expect(
      draftChanged(stored, { ...stored, env: [{ key: "TOKEN", value: "x", stored: false }] }),
    ).toBe(true);
  });
});

describe("wrapFocus", () => {
  test("Tab and Shift+Tab wrap inside the dialog and start at its edge from outside", () => {
    expect(wrapFocus(3, 0, false)).toBe(1);
    expect(wrapFocus(3, 2, false)).toBe(0);
    expect(wrapFocus(3, 0, true)).toBe(2);
    expect(wrapFocus(3, 1, true)).toBe(0);
    expect(wrapFocus(3, -1, false)).toBe(0);
    expect(wrapFocus(3, -1, true)).toBe(2);
    expect(wrapFocus(0, -1, false)).toBe(-1);
  });
});
