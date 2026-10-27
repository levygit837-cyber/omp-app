import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { type OmpHost, startOmpHost } from "../src/omp-host";
import { RequestRegistry } from "../src/request-registry";
import { attachSession } from "../src/session-bridge";
import { SessionStore } from "../src/session-store";
import { settingsControl, settingsHandlers } from "../src/settings-handlers";
import { registerEchoModel, startEchoModel } from "./fixtures/echo-model";

setDefaultTimeout(60_000);

/** Everything lives in one temp tree: the real ~/.omp is never read or written. */
let root: string;
let host: OmpHost;
const store = new SessionStore();
const requests = new RequestRegistry(store);
const sessions = new Map<string, AgentSession>();
const savedEnv = {
  HOME: process.env.HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};
/** Resuming the held session restores its recorded model, which must resolve without the network. */
let model: ReturnType<typeof startEchoModel>;
const SETTING = "retry.maxDelayMs";

beforeAll(async () => {
  // omp's Settings is a process-wide singleton bound to the agent dir of its first init. A test file that
  // starts the host must drop it, or the next file reuses an instance whose dir is already deleted.
  resetSettingsForTest();
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-live-")));
  const agentDir = join(root, "home", ".omp", "agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.HOME = join(root, "home");
  setAgentDir(agentDir);
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  model = startEchoModel();
  registerEchoModel(agentDir, model.port);
  host = await startOmpHost({
    requests,
    onSessionCreated: (session) => {
      attachSession(store, session, requests);
      sessions.set(session.sessionId, session);
    },
    onMcpFailure: () => {},
  });
});

afterAll(async () => {
  model?.stop(true);
  await host?.close();
  resetSettingsForTest();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function valueIn(sessionId: string): unknown {
  const session = sessions.get(sessionId);
  const setting = lookup(SETTING);
  if (!session || !setting) throw new Error("session or setting missing");
  return setting.get(session.settings);
}

const handlersForHost = () => settingsHandlers(settingsControl(host, store));

test("a running session sees a global and then a project edit without a restart", async () => {
  const handlers = handlersForHost();
  const client = { emit() {} };
  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });
  const other = join(root, "other");
  mkdirSync(other, { recursive: true });
  const sessionId = await host.createSession(cwd);
  const otherId = await host.createSession(other);
  expect(valueIn(sessionId)).toBe(300000);

  await handlers["settings.set"]({ scope: "global", id: SETTING, value: 1111 }, client);
  expect(valueIn(sessionId)).toBe(1111);
  expect(valueIn(otherId)).toBe(1111);

  // The project half: the edit reaches the session of that project and no other.
  await handlers["settings.set"]({ scope: "project", sessionId, id: SETTING, value: 2222 }, client);
  expect(valueIn(sessionId)).toBe(2222);
  expect(valueIn(otherId)).toBe(1111); // another project's session is untouched

  await handlers["settings.reset"]({ scope: "project", sessionId, id: SETTING }, client);
  expect(valueIn(sessionId)).toBe(1111);
  await handlers["settings.reset"]({ scope: "global", id: SETTING }, client);
  expect(valueIn(sessionId)).toBe(300000);
});

test("a session created after an edit starts with it", async () => {
  const handlers = handlersForHost();
  const client = { emit() {} };
  await handlers["settings.set"]({ scope: "global", id: SETTING, value: 3333 }, client);
  const cwd = join(root, "later");
  mkdirSync(cwd, { recursive: true });
  expect(valueIn(await host.createSession(cwd))).toBe(3333);
  await handlers["settings.reset"]({ scope: "global", id: SETTING }, client);
});

test("a session that cannot reload is reported, and the others still reload", async () => {
  const handlers = handlersForHost();
  const client = { emit() {} };
  const broken = join(root, "broken");
  mkdirSync(broken, { recursive: true });
  const brokenId = await host.createSession(broken);
  const healthy = join(root, "healthy");
  mkdirSync(healthy, { recursive: true });
  const healthyId = await host.createSession(healthy);

  // The project config of one live session turns invalid after the session started.
  mkdirSync(join(broken, ".omp"), { recursive: true });
  writeFileSync(join(broken, ".omp", "config.yml"), "retry: [unclosed\n  x: : :\n");

  const change = await handlers["settings.set"](
    { scope: "global", id: SETTING, value: 4444 },
    client,
  );
  expect(change.ok).toBe(true);
  if (change.ok) expect(change.reloadFailed).toBe(1);
  expect(valueIn(healthyId)).toBe(4444);
  expect(valueIn(brokenId)).not.toBe(4444);

  rmSync(join(broken, ".omp"), { recursive: true, force: true });
  const fixed = await handlers["settings.reset"]({ scope: "global", id: SETTING }, client);
  expect(fixed.ok && fixed.reloadFailed === undefined).toBe(true);
});

test("a closed session is no longer reloaded, and the others still are", async () => {
  const handlers = handlersForHost();
  const client = { emit() {} };
  const closing = join(root, "closing");
  mkdirSync(closing, { recursive: true });
  const closingId = await host.createSession(closing);
  const staying = join(root, "staying");
  mkdirSync(staying, { recursive: true });
  const stayingId = await host.createSession(staying);
  const before = host.liveSessionSettings().length;

  await handlers["settings.set"]({ scope: "global", id: SETTING, value: 5100 }, client);
  expect(valueIn(closingId)).toBe(5100);

  await host.closeSession(closingId);
  expect(host.liveSessionSettings().length).toBe(before - 1);
  await handlers["settings.set"]({ scope: "global", id: SETTING, value: 5200 }, client);
  expect(valueIn(stayingId)).toBe(5200);
  expect(valueIn(closingId)).toBe(5100); // dropped from the reload set: it kept its last value
  await handlers["settings.reset"]({ scope: "global", id: SETTING }, client);
});

test("a session omp moves to a new file keeps being reloaded, and is dropped when it closes", async () => {
  const handlers = handlersForHost();
  const client = { emit() {} };
  const cwd = join(root, "moved");
  mkdirSync(cwd, { recursive: true });
  // A second process holds the session file, which makes omp move our first write to a new id.
  const other = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures", "hold-session.ts"),
      join(root, "home", ".omp", "agent"),
      cwd,
    ],
    { stdout: "pipe", stdin: "ignore", stderr: "inherit", env: process.env },
  );
  try {
    const first = await other.stdout.getReader().read();
    const held = JSON.parse(new TextDecoder().decode(first.value)) as { id: string };
    expect(await host.resumeSession(held.id)).toBe(held.id);
    const session = sessions.get(held.id) as AgentSession;
    session.sessionManager.appendMessage({ role: "user", content: "from the app", timestamp: 3 });
    await session.sessionManager.flush();
    const movedTo = session.sessionId;
    expect(movedTo).not.toBe(held.id);

    await handlers["settings.set"]({ scope: "global", id: SETTING, value: 6100 }, client);
    expect(valueIn(held.id)).toBe(6100); // the moved session was reloaded

    await host.closeSession(movedTo); // closing under the new id reaches the same clone
    await handlers["settings.set"]({ scope: "global", id: SETTING, value: 6200 }, client);
    expect(valueIn(held.id)).toBe(6100);
    await handlers["settings.reset"]({ scope: "global", id: SETTING }, client);
  } finally {
    other.kill();
    await other.exited;
  }
});
