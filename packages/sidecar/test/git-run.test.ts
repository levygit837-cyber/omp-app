import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { filterOverrides } from "../src/git-run";

/** What `git config --list -z --name-only --show-scope` prints: `scope NUL name NUL` pairs. */
const listing = (...pairs: [string, string][]) =>
  Buffer.from(pairs.map(([scope, name]) => `${scope}\0${name}\0`).join(""));

describe("filterOverrides", () => {
  test("every repository driver is blanked by name and made optional", () => {
    const env = filterOverrides(
      listing(["local", "filter.evil.clean"], ["local", "filter.evil.required"]),
    );
    const pairs = Object.entries(env ?? {}).filter(([k]) => k.startsWith("GIT_CONFIG_KEY_"));
    const values = pairs.map(([k, name]) => [name, env?.[k.replace("KEY", "VALUE")]]);
    expect(env?.GIT_CONFIG_COUNT).toBe("4");
    expect(values).toEqual([
      ["filter.evil.clean", ""],
      ["filter.evil.smudge", ""],
      ["filter.evil.process", ""],
      ["filter.evil.required", "false"],
    ]);
  });

  test("a name with dots, spaces, quotes or an equals sign is passed as data", () => {
    const env = filterOverrides(
      listing(
        ["local", "filter.dot.ted.name.clean"],
        ["worktree", 'filter.a "b"=c d.smudge'],
        ["local", "filter.dot.ted.name.process"],
      ),
    );
    const keys = Object.entries(env ?? {})
      .filter(([k]) => k.startsWith("GIT_CONFIG_KEY_"))
      .map(([, v]) => v);
    expect(keys).toContain("filter.dot.ted.name.clean");
    expect(keys).toContain('filter.a "b"=c d.required');
    // two variables of one driver are one driver
    expect(keys.filter((k) => k === "filter.dot.ted.name.required")).toHaveLength(1);
  });

  test("the person's own global and system drivers stay, other keys are ignored", () => {
    const env = filterOverrides(
      listing(
        ["global", "filter.lfs.clean"],
        ["system", "filter.other.clean"],
        ["local", "core.fsmonitor"],
        ["local", "filter.clean"],
        ["command", "filter.cmd.clean"],
      ),
    );
    expect(env).toEqual({});
  });

  test("a name git cannot take on a command line refuses the whole call", () => {
    expect(filterOverrides(listing(["local", "filter.a\nb.clean"]))).toBeNull();
  });
});
