import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { type OmpHost, startOmpHost } from "../src/omp-host";
import { RequestRegistry } from "../src/request-registry";
import { attachSession } from "../src/session-bridge";
import { SessionStore } from "../src/session-store";

setDefaultTimeout(60_000);

/** Everything lives in one temp tree: the real ~/.omp is never read or written. */
let root: string;
let host: OmpHost;
const store = new SessionStore();
const requests = new RequestRegistry(store);
const savedEnv = {
  HOME: process.env.HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

const folder = (name: string): string => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const userMessage = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });
const assistantMessage = (text: string, model = "gpt-4o-mini") => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
  api: "openai-completions" as const,
  provider: "openai",
  model,
  usage: {
    input: 0,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop" as const,
  timestamp: 2,
});

/** Writes a session through omp's own SessionManager, the way the CLI would. */
async function craft(
  cwd: string,
  turns: readonly (readonly [string, string])[],
  title?: string,
  model?: string,
): Promise<string> {
  const manager = SessionManager.create(cwd);
  await manager.ensureOnDisk();
  for (const [ask, answer] of turns) {
    manager.appendMessage(userMessage(ask));
    manager.appendMessage(assistantMessage(answer, model));
  }
  if (title) await manager.setSessionName(title, "user");
  await manager.flush();
  const id = manager.getSessionId();
  await manager.close();
  return id;
}

const timelineOf = (id: string) => store.snapshot(id).snapshot.timeline;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-catalog-")));
  const agentDir = join(root, "home", ".omp", "agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.HOME = join(root, "home");
  // A key makes the bundled openai models restorable. Nothing here ever calls the API.
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  setAgentDir(agentDir);
  host = await startOmpHost({
    requests,
    onSessionCreated: (session) => attachSession(store, session, requests),
    onMcpFailure: () => {},
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

test("list matches the CLI picker's list, and resume brings the full history", async () => {
  const alpha = folder("alpha");
  const beta = folder("beta");
  const titled = await craft(alpha, [["first question", "first answer"]], "Named by the user");
  const plain = await craft(beta, [
    ["how do I list files?", "use ls"],
    ["and hidden ones?", "ls -a"],
  ]);
  // A session that never got a message: the CLI picker hides it, so the app does too.
  const stub = SessionManager.create(folder("gamma"));
  await stub.ensureOnDisk();
  const stubId = stub.getSessionId();
  await stub.close();

  const listed = await host.list();
  const picker = await SessionManager.listAllForPicker();
  expect(listed.map((s) => s.id)).toEqual(picker.map((s) => s.id));
  expect(listed.map((s) => s.id)).not.toContain(stubId);
  expect(new Set(listed.map((s) => s.id))).toEqual(new Set([titled, plain]));

  const byId = new Map(listed.map((s) => [s.id, s]));
  expect(byId.get(titled)).toMatchObject({ cwd: alpha, title: "Named by the user", turns: 1 });
  expect(byId.get(plain)).toMatchObject({
    cwd: beta,
    title: null,
    firstPrompt: "how do I list files?",
    turns: 2,
  });

  const opened = await host.resumeSession(plain);
  expect(opened).toBe(plain);
  expect(timelineOf(plain)).toEqual([
    { kind: "user", id: "i0", text: "how do I list files?" },
    { kind: "assistant", id: "i1", text: "use ls", done: true },
    { kind: "user", id: "i2", text: "and hidden ones?" },
    { kind: "assistant", id: "i3", text: "ls -a", done: true },
  ]);
  expect(store.snapshot(plain).snapshot.cwd).toBe(beta);
  expect(store.snapshot(plain).snapshot.status).toBe("idle");
  await host.closeSession(plain);
});

test("fork copies the history into a new session and leaves the source alone", async () => {
  const dir = folder("forks");
  const source = await craft(dir, [
    ["one", "uno"],
    ["two", "dos"],
  ]);
  await host.resumeSession(source);
  const before = timelineOf(source);

  const copy = await host.forkSession(source);
  expect(copy).not.toBe(source);
  expect(timelineOf(copy)).toEqual(before);
  expect(store.snapshot(copy).snapshot.cwd).toBe(dir);

  // Both exist on disk now, and the source is unchanged.
  const ids = (await host.list()).map((s) => s.id);
  expect(ids).toContain(source);
  expect(ids).toContain(copy);
  expect(timelineOf(source)).toEqual(before);

  // omp records the fork's parent by session id in the header (`SessionManager.fork`).
  const parent = (await SessionManager.listAll()).find((s) => s.id === copy)?.parentSessionPath;
  expect(parent).toBe(source);

  await host.closeSession(source);
  await host.closeSession(copy);
});

test("close frees the session in memory and keeps it on disk; it resumes again", async () => {
  const id = await craft(folder("closing"), [["keep me", "kept"]]);
  await host.resumeSession(id);
  await host.closeSession(id);

  expect((await host.list()).map((s) => s.id)).toContain(id);
  store.remove(id);
  await host.resumeSession(id);
  expect(timelineOf(id)).toHaveLength(2);
  await host.closeSession(id);
});

test("a session id that is not on disk is an error, not a new empty session", async () => {
  await expect(host.resumeSession("00000000-0000-0000-0000-000000000000")).rejects.toThrow(
    /not found/,
  );
  await expect(host.forkSession("00000000-0000-0000-0000-000000000000")).rejects.toThrow(
    /not found/,
  );
});

test("a session whose model cannot be restored fails to open and registers nothing", async () => {
  const id = await craft(folder("lost-model"), [["hi", "hello"]], undefined, "no-such-model-xyz");
  await expect(host.resumeSession(id)).rejects.toThrow();
  expect(store.has(id)).toBe(false);
  // It is still listed: the file is fine, only this machine cannot run its model.
  expect((await host.list()).map((s) => s.id)).toContain(id);
});

test("a session whose folder is gone is refused with a plain message, and nothing is registered", async () => {
  const dir = folder("vanishing");
  const id = await craft(dir, [["hi", "hello"]]);
  rmSync(dir, { recursive: true });

  await expect(host.resumeSession(id)).rejects.toThrow(`folder no longer exists: ${dir}`);
  await expect(host.forkSession(id)).rejects.toThrow(`folder no longer exists: ${dir}`);
  expect(store.has(id)).toBe(false);
  // The file is fine and stays listed; only this machine lost the folder.
  expect((await host.list()).map((s) => s.id)).toContain(id);
});

test("opening several sessions at once registers each under its own id", async () => {
  const a = await craft(folder("race-a"), [["from a", "answer a"]]);
  const b = await craft(folder("race-b"), [["from b", "answer b"]]);

  const results = await Promise.allSettled([
    host.resumeSession(a),
    host.resumeSession(b),
    host.resumeSession(a),
  ]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
  expect(timelineOf(a).map((i) => ("text" in i ? i.text : ""))).toEqual(["from a", "answer a"]);
  expect(timelineOf(b).map((i) => ("text" in i ? i.text : ""))).toEqual(["from b", "answer b"]);

  // Closing while another open is in flight leaves the other one registered.
  await Promise.allSettled([host.closeSession(a), host.resumeSession(b)]);
  expect(store.has(b)).toBe(true);
  await host.closeSession(b);
});

test("a stored session with a tool call, a compaction and a custom message resumes with their items and names what it leaves out", async () => {
  const dir = folder("rich");
  const manager = SessionManager.create(dir);
  await manager.ensureOnDisk();
  manager.appendMessage(userMessage("run it"));
  const firstKept = manager.appendMessage({
    ...assistantMessage("running"),
    content: [
      { type: "text" as const, text: "running" },
      { type: "toolCall" as const, id: "t1", name: "bash", arguments: { command: "true" } },
    ],
  });
  manager.appendMessage({
    role: "toolResult" as const,
    toolCallId: "t1",
    toolName: "bash",
    content: [{ type: "text" as const, text: "ok" }],
    isError: false,
    timestamp: 3,
  });
  manager.appendMessage(assistantMessage("done"));
  manager.appendCompaction("earlier work", "earlier", firstKept, 1000);
  manager.appendCustomMessageEntry("note", "a custom note", true);
  manager.appendMessage(userMessage("next"));
  manager.appendMessage(assistantMessage("ok next"));
  await manager.flush();
  const id = manager.getSessionId();
  await manager.close();

  await host.resumeSession(id);
  const view = store.snapshot(id).snapshot;
  // The tool call, its result and the compaction are items; only the custom message is left out,
  // and the session says so.
  expect(view.timeline.filter((i) => i.kind === "user").map((i) => i.text)).toContain("next");
  const tool = view.timeline.find((i) => i.kind === "tool");
  expect(tool).toMatchObject({
    tool: "bash",
    calls: [{ toolCallId: "t1", status: "done", target: "true", output: { kind: "shell" } }],
  });
  expect(view.timeline.find((i) => i.kind === "compaction")).toMatchObject({
    state: "done",
    summary: "earlier",
  });
  const warning = view.warnings.find(
    (w) => w.source === "session" && w.title === "Earlier entries are not shown",
  );
  expect(warning?.message).toStartWith("custom messages (1) are not shown here yet.");
  await host.closeSession(id);
});
