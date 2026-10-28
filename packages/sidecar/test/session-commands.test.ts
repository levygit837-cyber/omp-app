import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import {
  decodeFrame,
  FrameDecoder,
  isResponseEnvelope,
  type MethodName,
  type Methods,
  RequestCorrelator,
  type SessionViewModel,
} from "@omp-app/protocol";
import { COMMAND_ENTRY_TYPE } from "../src/command-entries";
import { type OmpHost, startOmpHost } from "../src/omp-host";
import { RequestRegistry } from "../src/request-registry";
import { type Server, startServer } from "../src/server";
import { attachSession } from "../src/session-bridge";
import { sessionHandlers } from "../src/session-handlers";
import { SessionStore } from "../src/session-store";
import { registerEchoModel, startEchoModel, useEchoModel } from "./fixtures/echo-model";

setDefaultTimeout(60_000);

let root: string;
let host: OmpHost;
let server: Server;
let model: ReturnType<typeof startEchoModel>;
let hold: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let inModel: ReturnType<typeof Promise.withResolvers<void>>;
const store = new SessionStore();
const requests = new RequestRegistry(store);
const sessions: AgentSession[] = [];
const savedEnv = {
  HOME: process.env.HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

interface Client {
  request<M extends MethodName>(m: M, p?: Methods[M]["params"]): Promise<Methods[M]["result"]>;
  close(): void;
}

async function connect(socketPath: string): Promise<Client> {
  const correlator = new RequestCorrelator();
  const decoder = new FrameDecoder();
  const text = new TextDecoder();
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, chunk) {
        for (const line of decoder.push(text.decode(chunk, { stream: true }))) {
          const frame = decodeFrame(line);
          if (frame.ok && isResponseEnvelope(frame.envelope)) correlator.receive(frame.envelope);
        }
      },
    },
  });
  return {
    request(method, params) {
      const { frame, response } = correlator.create(method, params);
      socket.write(frame);
      return response;
    },
    close: () => void socket.end(),
  };
}

const errorMessage = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: Error) => e.message,
  );

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

const view = (id: string): SessionViewModel => store.snapshot(id).snapshot;
const commandsOf = (id: string) => view(id).timeline.filter((i) => i.kind === "command");

async function openSession(name: string): Promise<string> {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  const id = await host.createSession(cwd);
  await useEchoModel(sessions.at(-1) as AgentSession);
  return id;
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-cmds-")));
  const agentDir = join(root, "home", ".omp", "agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.HOME = join(root, "home");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  inModel = Promise.withResolvers();
  model = startEchoModel(async () => {
    inModel.resolve();
    await hold?.promise;
  });
  registerEchoModel(agentDir, model.port);
  setAgentDir(agentDir);
  resetSettingsForTest();
  host = await startOmpHost({
    requests,
    onSessionCreated: (session) => {
      sessions.push(session);
      attachSession(store, session, requests);
    },
    onMcpFailure: () => {},
  });
  server = startServer(
    join(root, "s.sock"),
    // Handlers for the real host; the type is the full handler map, this file only calls session.*.
    sessionHandlers(host, store, requests) as never,
    false,
  );
});

afterAll(async () => {
  server?.stop();
  model?.stop(true);
  await host?.close();
  resetSettingsForTest();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("session.commands lists only builtins omp can run without a terminal", async () => {
  const id = await openSession("list");
  const client = await connect(join(root, "s.sock"));
  const { commands } = await client.request("session.commands", { sessionId: id });
  client.close();
  const names = commands.map((c) => c.name);
  // `handle` exists: runnable. `pause`, `clear`, `resume`, `collab` only have a terminal handler.
  expect(names).toContain("effort");
  expect(names).toContain("usage");
  for (const tuiOnly of ["pause", "clear", "resume", "collab", "settings"])
    expect(names).not.toContain(tuiOnly);
  const effort = commands.find((c) => c.name === "effort");
  expect(effort?.hint).toBe("[level]");
  expect(effort?.subcommands.length).toBeGreaterThan(0);
  // The sentences travel with the listing so the palette can ask; what they gate is tested below.
  expect(commands.find((c) => c.name === "share")?.confirm?.because).toContain("Uploads");
  expect(commands.find((c) => c.name === "effort")?.confirm).toBeUndefined();
  expect(
    commands.find((c) => c.name === "usage")?.confirmVerbs?.find((v) => v.verbs.includes("reset")),
  ).toMatchObject({ destructive: true });
});

test("runCommand puts omp's answer on the timeline, and a name omp would send to the model is refused", async () => {
  const id = await openSession("idle");
  const client = await connect(join(root, "s.sock"));
  expect(await client.request("session.runCommand", { sessionId: id, text: "/effort" })).toBeNull();
  await until(() => commandsOf(id)[0]?.state === "done", "the command to finish");
  const item = commandsOf(id)[0];
  expect(item?.text).toBe("/effort");
  expect(item?.output).not.toBe("");
  // Never an assistant turn: the line did not reach the model.
  expect(view(id).timeline.some((i) => i.kind === "user" || i.kind === "assistant")).toBe(false);
  expect(view(id).status).toBe("idle");

  // `pause` is terminal-only, a made-up name is nothing: both would otherwise go to the model.
  expect(
    await errorMessage(client.request("session.runCommand", { sessionId: id, text: "/pause" })),
  ).toStartWith("unknown command");
  expect(
    await errorMessage(client.request("session.runCommand", { sessionId: id, text: "/nonsense" })),
  ).toStartWith("unknown command");
  expect(
    await errorMessage(client.request("session.runCommand", { sessionId: id, text: "hello" })),
  ).toStartWith("unknown command");
  expect(commandsOf(id)).toHaveLength(1);
  client.close();
});

test("a builtin run while a turn streams leaves the turn alone, and the reply keeps one item", async () => {
  const id = await openSession("streaming");
  const client = await connect(join(root, "s.sock"));
  hold = Promise.withResolvers();
  inModel = Promise.withResolvers();
  await client.request("session.prompt", { sessionId: id, text: "slow question" });
  await inModel.promise;
  expect(view(id).status).toBe("streaming");

  await client.request("session.runCommand", { sessionId: id, text: "/effort" });
  await until(() => commandsOf(id)[0]?.state === "done", "the command to finish mid-turn");
  expect(view(id).status).toBe("streaming");

  hold.resolve();
  hold = undefined;
  await until(() => view(id).status === "idle", "the turn to end");
  const kinds = view(id).timeline.map((i) => i.kind);
  expect(kinds.filter((k) => k === "assistant")).toHaveLength(1);
  const reply = view(id).timeline.find((i) => i.kind === "assistant");
  expect(reply?.kind === "assistant" && reply.text).toBe("echo slow question");
  expect(reply?.kind === "assistant" && reply.done).toBe(true);
  client.close();
});

test("a finished command is saved in the session file and comes back when the session is resumed", async () => {
  const id = await openSession("resume");
  const client = await connect(join(root, "s.sock"));
  await client.request("session.prompt", { sessionId: id, text: "hello" });
  await until(() => view(id).status === "idle" && view(id).timeline.length > 1, "the turn");
  await client.request("session.runCommand", { sessionId: id, text: "/effort" });
  await until(() => commandsOf(id)[0]?.state === "done", "the command");
  const live = commandsOf(id)[0];

  const session = sessions.find((s) => s.sessionId === id) as AgentSession;
  const saved = session.sessionManager
    .getBranch()
    .filter((e) => e.type === "custom" && e.customType === COMMAND_ENTRY_TYPE);
  expect(saved).toHaveLength(1);
  // The model never reads it: a plain custom entry is not a message of the context.
  expect(
    session.sessionManager.buildSessionContext().messages.some((m) => m.role === "custom"),
  ).toBe(false);

  await client.request("session.close", { sessionId: id });
  const reopened = await client.request("session.resume", { sessionId: id });
  const timeline = view(reopened.sessionId).timeline;
  const back = timeline.find((i) => i.kind === "command");
  expect(back?.kind === "command" && back.text).toBe("/effort");
  expect(back?.kind === "command" && back.output).toBe(live?.kind === "command" ? live.output : "");
  expect(back?.kind === "command" && back.state).toBe("done");
  // After the first turn, as it happened.
  expect(timeline.map((i) => i.kind)).toEqual(["user", "assistant", "command"]);
  client.close();
});

test("a line that reaches beyond the session is refused without the person's answer, and runs with it", async () => {
  const id = await openSession("gated");
  const client = await connect(join(root, "s.sock"));
  const run = (text: string, confirmed?: true) =>
    client.request("session.runCommand", {
      sessionId: id,
      text,
      ...(confirmed ? { confirmed } : {}),
    });

  // Gated by the command, by its first argument, through an alias and through the colon form.
  for (const text of [
    "/export",
    "/usage reset",
    "/session delete",
    "/session:delete",
    "/worktree x",
  ]) {
    expect(await errorMessage(run(text))).toStartWith("confirmation required");
  }
  expect(commandsOf(id)).toHaveLength(0);

  // The same command without the destructive verb needs nothing.
  for (const text of ["/usage", "/session info", "/session", "/effort"]) {
    expect(await errorMessage(run(text))).toBeNull();
  }
  await until(
    () => commandsOf(id).length === 4 && commandsOf(id).every((c) => c.state !== "running"),
    "four commands",
  );

  // With the answer it starts. `usage reset` without an account only lists the saved resets.
  expect(await errorMessage(run("/usage reset", true))).toBeNull();
  await until(
    () => commandsOf(id).length === 5 && commandsOf(id)[4]?.state !== "running",
    "the confirmed command",
  );
  client.close();
});

test("a session deleted with /session delete is not written back by the command that deleted it", async () => {
  const id = await openSession("deleted");
  const client = await connect(join(root, "s.sock"));
  await client.request("session.prompt", { sessionId: id, text: "hello" });
  await until(() => view(id).status === "idle" && view(id).timeline.length > 1, "the turn");
  const session = sessions.find((s) => s.sessionId === id) as AgentSession;
  const file = session.sessionManager.getSessionFile() as string;
  expect(existsSync(file)).toBe(true);

  await client.request("session.runCommand", {
    sessionId: id,
    text: "/session delete",
    confirmed: true,
  });
  await until(() => commandsOf(id)[0]?.state === "done", "the delete");
  expect(existsSync(file)).toBe(false);
  // Still open, so the next command ends too; it shows, and the file stays gone.
  await client.request("session.runCommand", { sessionId: id, text: "/effort" });
  await until(() => commandsOf(id)[1]?.state === "done", "the next command");
  expect(existsSync(file)).toBe(false);
  client.close();
});

test("a setting a builtin writes reaches the other open sessions", async () => {
  const a = await openSession("settings-a");
  const b = await openSession("settings-b");
  const client = await connect(join(root, "s.sock"));
  const headless = (sessionId: string): unknown => {
    const session = sessions.find((s) => s.sessionId === sessionId) as AgentSession;
    return lookup("browser.headless")?.get(session.settings);
  };
  expect(headless(a)).toBe(true);
  expect(headless(b)).toBe(true);

  await client.request("session.runCommand", { sessionId: a, text: "/browser visible" });
  await until(() => commandsOf(a)[0]?.state === "done", "/browser");
  expect(commandsOf(a)[0]?.output).toContain("visible");
  expect(headless(a)).toBe(false);
  expect(headless(b)).toBe(false);
  client.close();
});

async function onDiskSession(name: string, client: Client): Promise<{ id: string; file: string }> {
  const id = await openSession(name);
  await client.request("session.prompt", { sessionId: id, text: "hello" });
  await until(() => view(id).status === "idle" && view(id).timeline.length > 1, "the turn");
  const session = sessions.find((s) => s.sessionId === id) as AgentSession;
  const file = session.sessionManager.getSessionFile() as string;
  expect(existsSync(file)).toBe(true);
  return { id, file };
}

test("a gated line handed back by /force is not run: the item fails with a sentence and nothing happens", async () => {
  const client = await connect(join(root, "s.sock"));
  const { id, file } = await onDiskSession("handed-back", client);
  const target = join(root, "handed-back", "x.html");
  const turnsBefore = view(id).timeline.filter((i) => i.kind === "user").length;

  // `/force` is not gated, so the palette asks nothing for it; what it carries is.
  const lines = [
    "/force read /session delete",
    "/force read /session:delete",
    `/force read /export ${target}`,
    "/force read /usage reset",
  ];
  for (const [n, text] of lines.entries()) {
    expect(
      await errorMessage(client.request("session.runCommand", { sessionId: id, text })),
    ).toBeNull();
    await until(
      () => commandsOf(id)[n]?.state !== "running" && commandsOf(id).length === n + 1,
      text,
    );
    expect(commandsOf(id)[n]).toMatchObject({ state: "failed" });
    expect(commandsOf(id)[n]?.output).toContain("needs a confirmation first");
  }
  await Bun.sleep(200);
  expect(existsSync(file)).toBe(true);
  expect(existsSync(target)).toBe(false);
  // No prompt reached the model.
  expect(view(id).timeline.filter((i) => i.kind === "user")).toHaveLength(turnsBefore);
  client.close();
});

test("a handed-back line that is plain text still goes to the model", async () => {
  const client = await connect(join(root, "s.sock"));
  const { id } = await onDiskSession("handed-back-plain", client);
  const turnsBefore = view(id).timeline.filter((i) => i.kind === "user").length;
  await client.request("session.runCommand", { sessionId: id, text: "/force read say hi" });
  await until(
    () => view(id).timeline.filter((i) => i.kind === "user").length === turnsBefore + 1,
    "the turn",
  );
  await until(() => view(id).status === "idle", "idle");
  expect(commandsOf(id)[0]).toMatchObject({ state: "done" });
  client.close();
});

test("the composer cannot run a gated builtin through session.prompt either, whatever surrounds it", async () => {
  const client = await connect(join(root, "s.sock"));
  const { id, file } = await onDiskSession("composer", client);
  const target = join(root, "composer", "y.html");
  for (const text of [
    "/session delete",
    "  /session delete",
    "\n/session delete\n",
    "/session:delete",
    "/session\ndelete",
    `/export ${target}`,
    ` \t/export ${target}`,
    "/usage reset",
  ]) {
    expect(
      await errorMessage(client.request("session.prompt", { sessionId: id, text })),
    ).toStartWith("confirmation required");
  }
  await Bun.sleep(200);
  expect(existsSync(file)).toBe(true);
  expect(existsSync(target)).toBe(false);
  // Ordinary text and a command that needs nothing still go through.
  expect(
    await errorMessage(client.request("session.prompt", { sessionId: id, text: "/effort" })),
  ).toBeNull();
  expect(
    await errorMessage(client.request("session.prompt", { sessionId: id, text: "hello again" })),
  ).toBeNull();
  client.close();
});

test("the host refuses a gated builtin on the prompt path for any caller, and leaves the session alone", async () => {
  const client = await connect(join(root, "s.sock"));
  const { id, file } = await onDiskSession("host-door", client);
  // The text a builtin hands back reaches the host through this call, not through the handler.
  expect(await errorMessage(host.prompt(id, "/session delete"))).toStartWith(
    "confirmation required",
  );
  expect(await errorMessage(host.prompt(id, "/export /nowhere/z.html"))).toStartWith(
    "confirmation required",
  );
  await Bun.sleep(200);
  expect(existsSync(file)).toBe(true);
  expect(await host.prompt(id, "plain text")).toBe("end_turn");
  client.close();
});
