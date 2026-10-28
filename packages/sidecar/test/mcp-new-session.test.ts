import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { mcpHandlers } from "../src/extensions-handlers";
import { type OmpHost, startOmpHost } from "../src/omp-host";
import { RequestRegistry } from "../src/request-registry";
import { attachSession } from "../src/session-bridge";
import { SessionStore } from "../src/session-store";
import { settingsControl } from "../src/settings-handlers";

setDefaultTimeout(60_000);

const echo = join(import.meta.dir, "fixtures", "echo-mcp.mjs");
const MCP = (server: string, label: string) => `mcp__${server}_echo_${label}`;

let root: string;
let project: string;
let host: OmpHost;
const store = new SessionStore();
const sessions = new Map<string, AgentSession>();
const savedEnv = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };

async function open(): Promise<{ id: string; tools: string[] }> {
  const id = await host.createSession(project);
  const session = sessions.get(id);
  if (!session) throw new Error("session was not registered");
  return { id, tools: session.getAllToolNames().filter((n) => n.startsWith("mcp__")) };
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-mcp-ns-")));
  const agentDir = join(root, "home", ".omp", "agent");
  project = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });
  process.env.HOME = join(root, "home");
  setAgentDir(agentDir);
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
  const requests = new RequestRegistry(store);
  resetSettingsForTest();
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
  resetSettingsForTest();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("a change made through mcp.* reaches the next session and never the open one", async () => {
  const handlers = mcpHandlers(settingsControl(host, store));
  const before = await open();
  expect(before.tools).toEqual([]);

  const added = await handlers["mcp.add"](
    {
      scope: "global",
      server: {
        name: "later",
        transport: "stdio",
        command: process.execPath,
        args: [echo, "later"],
      },
    },
    {} as never,
  );
  expect(added.ok).toBe(true);

  const after = await open();
  expect(after.tools).toContain(MCP("later", "later"));
  // The session opened before the change keeps its tools: there is no hot reload.
  expect(
    sessions
      .get(before.id)
      ?.getAllToolNames()
      .some((n) => n.startsWith("mcp__later_")),
  ).toBe(false);

  const off = await handlers["mcp.setEnabled"](
    { scope: "global", name: "later", enabled: false },
    {} as never,
  );
  expect(off.ok).toBe(true);
  expect((await open()).tools).not.toContain(MCP("later", "later"));
  // ...and the one that had it keeps it.
  expect(sessions.get(after.id)?.getAllToolNames()).toContain(MCP("later", "later"));

  await handlers["mcp.remove"]({ scope: "global", name: "later" }, {} as never);
});

test("a file edited by hand between two sessions is what the second session starts", async () => {
  const file = join(root, "home", ".omp", "agent", "mcp.json");
  const write = (server: string) =>
    writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { [server]: { command: process.execPath, args: [echo, server] } },
      }),
    );
  // Written behind omp's back, as a person fixing the file in an editor would. omp keeps a
  // process-wide content cache that only its own writers invalidate.
  write("first");
  const one = await open();
  expect(one.tools).toContain(MCP("first", "first"));

  write("second");
  const two = await open();
  expect(two.tools).toContain(MCP("second", "second"));
  expect(two.tools).not.toContain(MCP("first", "first"));
});
