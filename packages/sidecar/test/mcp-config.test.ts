import { expect, test } from "bun:test";
import { parseMcpFailure, toAcpServers } from "../src/mcp-config";

const CD = ["-c", 'cd "$0" && exec "$@"'];

test("a stdio server's cwd is resolved against the session cwd; the default is the session cwd", () => {
  const [rel, abs] = toAcpServers(
    { r: { command: "x", cwd: "sub" }, a: { command: "x", cwd: "/elsewhere" } },
    "/proj",
  );
  expect(rel).toMatchObject({ args: [...CD, "/proj/sub", "x"] });
  expect(abs).toMatchObject({ args: [...CD, "/elsewhere", "x"] });
});

test("toAcpServers maps stdio, http and sse to the ACP shape", () => {
  expect(
    toAcpServers(
      {
        a: { type: "stdio", command: "bun", args: ["x"], env: { K: "v" } },
        b: { command: "bun" },
        c: { type: "http", url: "https://h", headers: { Authorization: "t" } },
        d: { type: "sse", url: "https://s" },
      },
      "/proj",
    ),
  ).toEqual([
    {
      type: "stdio",
      name: "a",
      command: "/bin/sh",
      args: [...CD, "/proj", "bun", "x"],
      env: [{ name: "K", value: "v" }],
    },
    { type: "stdio", name: "b", command: "/bin/sh", args: [...CD, "/proj", "bun"], env: [] },
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
