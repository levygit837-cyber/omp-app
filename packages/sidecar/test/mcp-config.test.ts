import { expect, test } from "bun:test";
import { parseMcpFailure, toAcpServers } from "../src/mcp-config";

test("toAcpServers maps stdio, http and sse to the ACP shape", () => {
  expect(
    toAcpServers({
      a: { type: "stdio", command: "bun", args: ["x"], env: { K: "v" } },
      b: { command: "bun" },
      c: { type: "http", url: "https://h", headers: { Authorization: "t" } },
      d: { type: "sse", url: "https://s" },
    }),
  ).toEqual([
    { type: "stdio", name: "a", command: "bun", args: ["x"], env: [{ name: "K", value: "v" }] },
    { type: "stdio", name: "b", command: "bun", args: [], env: [] },
    { type: "http", name: "c", url: "https://h", headers: [{ name: "Authorization", value: "t" }] },
    { type: "sse", name: "d", url: "https://s", headers: [] },
  ]);
});

test("parseMcpFailure reads omp's failure notice and ignores other text", () => {
  const text =
    'MCP server "my srv" failed to connect: spawn x ENOENT. Its tools are unavailable until the client restarts the session.';
  expect(parseMcpFailure(text)).toEqual({ server: "my srv", message: "spawn x ENOENT" });
  expect(parseMcpFailure("hello")).toBeNull();
});
