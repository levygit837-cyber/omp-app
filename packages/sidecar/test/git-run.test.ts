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

  // Every shape of name is the text between `filter.` and the LAST dot of the key, so a name can
  // be empty, only dots, start or end with a dot, or spell a variable (`x.clean`).
  const shapes: [label: string, key: string, name: string][] = [
    ['empty (`[filter ""]`)', "filter..clean", ""],
    ["one dot", "filter...clean", "."],
    ["only dots", "filter.....clean", "..."],
    ["starts with a dot", "filter..a.clean", ".a"],
    ["ends with a dot", "filter.a..clean", "a."],
    ["spells a variable: clean", "filter.x.clean.clean", "x.clean"],
    ["spells a variable: smudge", "filter.x.smudge.process", "x.smudge"],
    ["spells a variable: process", "filter.x.process.smudge", "x.process"],
    ["spells a variable: required", "filter.x.required.required", "x.required"],
    ["is a variable name", "filter.clean.clean", "clean"],
    ["has a space and a quote", 'filter.a "b".clean', 'a "b"'],
    ["has an equals sign", "filter.a=b.clean", "a=b"],
  ];
  for (const [label, key, name] of shapes) {
    test(`a driver whose name ${label} is overridden by that exact name`, () => {
      const env = filterOverrides(listing(["local", key]));
      const keys = Object.entries(env ?? {})
        .filter(([k]) => k.startsWith("GIT_CONFIG_KEY_"))
        .map(([, v]) => v);
      expect(keys).toEqual([
        `filter.${name}.clean`,
        `filter.${name}.smudge`,
        `filter.${name}.process`,
        `filter.${name}.required`,
      ]);
    });
  }

  test("a section without a name is not a driver", () => {
    expect(filterOverrides(listing(["local", "filter.clean"]))).toEqual({});
  });

  test("a name that is not valid UTF-8 refuses the call: it could not be passed back as it is", () => {
    const bytes = Buffer.concat([
      Buffer.from("local\0filter.bad"),
      Buffer.from([0xff, 0xfe]),
      Buffer.from("name.clean\0"),
    ]);
    expect(filterOverrides(bytes)).toBeNull();
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
