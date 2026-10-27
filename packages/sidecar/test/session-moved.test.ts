import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import type { SessionOpEvent } from "@omp-app/protocol";
import { type OmpHost, startOmpHost } from "../src/omp-host";
import { RequestRegistry } from "../src/request-registry";
import { attachSession } from "../src/session-bridge";
import { SessionStore } from "../src/session-store";

setDefaultTimeout(60_000);

let root: string;
let host: OmpHost;
const store = new SessionStore();
const requests = new RequestRegistry(store);
const sessions: AgentSession[] = [];
const savedEnv = {
  HOME: process.env.HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-moved-")));
  const agentDir = join(root, "home", ".omp", "agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.HOME = join(root, "home");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  setAgentDir(agentDir);
  host = await startOmpHost({
    requests,
    onSessionCreated: (session) => {
      sessions.push(session);
      attachSession(store, session, requests);
    },
    onMcpFailure: () => {},
  });
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("a session another live process holds moves to a new id; the app follows and keeps working", async () => {
  // The lease directory is shared with the child through the environment, and under bun test it
  // is a temp dir: the user's real state dir is never touched.
  expect(process.env.PI_TEST_SESSION_OWNERS_DIR).toBeTruthy();
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });

  const other = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures", "hold-session.ts"),
      process.env.PI_CODING_AGENT_DIR as string,
      cwd,
    ],
    { stdout: "pipe", stdin: "ignore", stderr: "inherit", env: process.env },
  );
  try {
    const reader = other.stdout.getReader();
    const first = await reader.read();
    const held = JSON.parse(new TextDecoder().decode(first.value)) as { id: string; file: string };
    const originalBytes = readFileSync(held.file, "utf8");

    // The app opens it: it has the full history, and nothing has moved yet.
    const openedAs = await host.resumeSession(held.id);
    expect(openedAs).toBe(held.id);
    expect(store.snapshot(held.id).snapshot.timeline.map((i) => i.kind)).toEqual([
      "user",
      "assistant",
    ]);
    const events: SessionOpEvent[] = [];
    store.subscribe(held.id, "test", (event) => events.push(event));

    // The app's first write: omp sees the other process owns the file and moves off it.
    const session = sessions.at(-1) as AgentSession;
    session.sessionManager.appendMessage({ role: "user", content: "from the app", timestamp: 3 });
    await session.sessionManager.flush();

    const movedTo = session.sessionId;
    expect(movedTo).not.toBe(held.id);
    // The store follows: the old id is gone, the new one holds the same session with a warning.
    expect(store.has(held.id)).toBe(false);
    expect(store.has(movedTo)).toBe(true);
    expect(store.current(held.id)).toBe(movedTo);
    const view = store.snapshot(movedTo).snapshot;
    expect(view.id).toBe(movedTo);
    expect(view.warnings.map((w) => (w.source === "session" ? w.title : w.source))).toContain(
      "This session moved to a new file",
    );
    // Subscribers were told under the old id, so the replica and the open set can move.
    expect(events.find((e) => e.op.type === "session.moved")).toMatchObject({
      sessionId: held.id,
      op: { type: "session.moved", id: movedTo },
    });
    // The other process's file is exactly as it left it; the app's turn is in the successor.
    expect(readFileSync(held.file, "utf8")).toBe(originalBytes);
    const listed = (await host.list()).map((s) => s.id);
    expect(listed).toContain(movedTo);
    expect(listed).toContain(held.id);

    // ACP still keys the session by the old id; the host maps the new one to it.
    await host.closeSession(movedTo);
    store.remove(movedTo);
    expect(store.has(movedTo)).toBe(false);
  } finally {
    other.kill();
    await other.exited;
  }
});
