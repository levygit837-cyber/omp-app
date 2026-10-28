import { describe, expect, test } from "bun:test";
import { MCP_LIMITS } from "@omp-app/protocol";
import { mcpSecretRef, mcpServerInput } from "../src/main/extensions-input";

const valid = { name: "docs", transport: "stdio", command: "npx", args: ["-y", "docs"] };

describe("mcpServerInput: the first door for what the renderer sends", () => {
  test("rebuilds a valid server field by field and drops what it does not know", () => {
    expect(
      mcpServerInput({
        ...valid,
        env: { TOKEN: null, MODE: "x" },
        extra: "ignored",
        __proto__: {},
      }),
    ).toEqual({ ...valid, env: { TOKEN: null, MODE: "x" } });
  });

  test("refuses wrong types", () => {
    for (const bad of [
      null,
      [],
      { ...valid, name: 1 },
      { ...valid, transport: "ws" },
      { ...valid, args: [1] },
      { ...valid, command: 2 },
      { ...valid, env: { K: 3 } },
      { ...valid, env: [] },
    ]) {
      expect(() => mcpServerInput(bad)).toThrow();
    }
  });

  test("refuses sizes beyond the limits and accepts the limits themselves", () => {
    const at = (n: number) => "a".repeat(n);
    const many = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`K${i}`, "v"]));
    expect(() =>
      mcpServerInput({
        name: at(MCP_LIMITS.name),
        transport: "stdio",
        command: at(MCP_LIMITS.command),
        args: Array.from({ length: MCP_LIMITS.args }, () => at(MCP_LIMITS.arg)),
        env: { ...many(MCP_LIMITS.entries - 1), [at(MCP_LIMITS.key)]: at(MCP_LIMITS.value) },
      }),
    ).not.toThrow();
    for (const bad of [
      { ...valid, name: at(MCP_LIMITS.name + 1) },
      { ...valid, command: at(MCP_LIMITS.command + 1) },
      { ...valid, url: at(MCP_LIMITS.url + 1) },
      { ...valid, args: Array.from({ length: MCP_LIMITS.args + 1 }, () => "a") },
      { ...valid, args: [at(MCP_LIMITS.arg + 1)] },
      { ...valid, env: many(MCP_LIMITS.entries + 1) },
      { ...valid, env: { [at(MCP_LIMITS.key + 1)]: "v" } },
      { ...valid, headers: { K: at(MCP_LIMITS.value + 1) } },
    ]) {
      expect(() => mcpServerInput(bad)).toThrow(/longer than|more than/);
    }
  });
});

describe("mcpSecretRef", () => {
  test("accepts the three kinds and refuses the rest or an oversized key", () => {
    expect(mcpSecretRef({ kind: "url" })).toEqual({ kind: "url" });
    expect(mcpSecretRef({ kind: "env", key: "T", extra: 1 })).toEqual({ kind: "env", key: "T" });
    expect(() => mcpSecretRef({ kind: "header" })).toThrow();
    expect(() => mcpSecretRef({ kind: "env", key: "k".repeat(MCP_LIMITS.key + 1) })).toThrow();
    expect(() => mcpSecretRef({ kind: "file" })).toThrow();
  });
});
