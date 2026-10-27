import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { type OmpHost, startOmpHost } from "../src/omp-host";
import { RequestRegistry } from "../src/request-registry";
import { attachSession } from "../src/session-bridge";
import { SessionStore } from "../src/session-store";

setDefaultTimeout(60_000);

const echo = join(import.meta.dir, "fixtures", "echo-mcp.mjs");
const stdio = (label: string, extra: Record<string, unknown> = {}) => ({
  command: process.execPath,
  args: [echo, label],
  ...extra,
});

/** Everything lives in one temp tree: the real ~/.omp is never read or written. */
let root: string;
let agentDir: string;
let host: OmpHost;
const store = new SessionStore();
const sessions = new Map<string, AgentSession>();
const savedEnv = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };

const writeJson = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
const project = (name: string, servers?: Record<string, unknown>) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (servers) writeJson(join(dir, ".omp", "mcp.json"), { mcpServers: servers });
  return dir;
};
const MCP = (server: string, label: string) => `mcp__${server}_echo_${label}`;

async function open(cwd: string): Promise<{ id: string; tools: string[] }> {
  const id = await host.createSession(cwd);
  const session = sessions.get(id);
  if (!session) throw new Error("session was not registered");
  return { id, tools: session.getAllToolNames().filter((n) => n.startsWith("mcp__")) };
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-mcp-")));
  agentDir = join(root, "home", ".omp", "agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.HOME = join(root, "home");
  setAgentDir(agentDir);
  writeJson(join(agentDir, "mcp.json"), {
    mcpServers: {
      shared: stdio("user"),
      useronly: stdio("useronly"),
      off: stdio("off", { enabled: false }),
      denied: stdio("denied"),
      broken: { command: "/nonexistent/omp-app-no-such-binary" },
    },
    disabledServers: ["denied"],
  });
  const requests = new RequestRegistry(store);
  host = await startOmpHost({
    requests,
    onSessionCreated: (session) => {
      attachSession(store, session, requests);
      sessions.set(session.sessionId, session);
    },
    onMcpFailure: (sessionId, server, message) =>
      store.warn(sessionId, { source: "mcp", server, message }),
  });
});

afterAll(async () => {
  await host?.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("a user server is a tool of a new session; disabled ones are not passed", async () => {
  const { tools } = await open(project("plain"));
  expect(tools).toContain(MCP("useronly", "useronly"));
  expect(tools.some((n) => n.startsWith("mcp__off_"))).toBe(false);
  expect(tools.some((n) => n.startsWith("mcp__denied_"))).toBe(false);
});

test("a project server exists only in sessions of that project", async () => {
  const withIt = await open(project("with-p", { onlyhere: stdio("onlyhere") }));
  const without = await open(project("without-p"));
  expect(withIt.tools).toContain(MCP("onlyhere", "onlyhere"));
  expect(without.tools).not.toContain(MCP("onlyhere", "onlyhere"));
});

test("a stdio server starts in the session's project dir, like the CLI", async () => {
  const dir = project("relative", {
    rel: { command: process.execPath, args: ["./tools/echo-mcp.mjs", "rel"] },
    sub: { command: process.execPath, args: ["./echo-mcp.mjs", "sub"], cwd: "tools" },
  });
  mkdirSync(join(dir, "tools"), { recursive: true });
  copyFileSync(echo, join(dir, "tools", "echo-mcp.mjs"));
  const { tools } = await open(dir);
  expect(tools).toContain(MCP("rel", "rel"));
  expect(tools).toContain(MCP("sub", "sub"));
});

test("a project definition overrides the user one with the same name", async () => {
  const over = await open(project("override", { shared: stdio("project") }));
  const plain = await open(project("no-override"));
  expect(over.tools).toContain(MCP("shared", "project"));
  expect(over.tools).not.toContain(MCP("shared", "user"));
  expect(plain.tools).toContain(MCP("shared", "user"));
});

test("a project can disable a user server by redefining it as disabled", async () => {
  const { tools } = await open(
    project("mutes", { useronly: stdio("useronly", { enabled: false }) }),
  );
  expect(tools.some((n) => n.startsWith("mcp__useronly_"))).toBe(false);
});

test("a failing server yields a warning op and the session stays usable", async () => {
  const { id, tools } = await open(project("failing"));
  // omp queues its failure notice and sends it ~50ms after session/new returns.
  const deadline = Date.now() + 10_000;
  while (store.snapshot(id).snapshot.warnings.length === 0 && Date.now() < deadline)
    await Bun.sleep(25);
  const { snapshot, seq } = store.snapshot(id);
  expect(snapshot.warnings).toHaveLength(1);
  expect(snapshot.warnings[0]).toMatchObject({ source: "mcp", server: "broken" });
  expect(snapshot.warnings[0]?.message.length).toBeGreaterThan(0);
  expect(seq).toBeGreaterThan(0);
  expect(snapshot.status).toBe("idle");
  expect(tools).toContain(MCP("useronly", "useronly"));
});

test("sessions in different projects do not see each other's servers", async () => {
  const a = await open(project("iso-a", { alpha: stdio("alpha") }));
  const b = await open(project("iso-b", { beta: stdio("beta") }));
  expect(a.tools).toContain(MCP("alpha", "alpha"));
  expect(a.tools).not.toContain(MCP("beta", "beta"));
  expect(b.tools).toContain(MCP("beta", "beta"));
  expect(b.tools).not.toContain(MCP("alpha", "alpha"));
});
