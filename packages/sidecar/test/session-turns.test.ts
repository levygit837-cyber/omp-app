import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { type OmpHost, startOmpHost } from "../src/omp-host";
import { RequestRegistry } from "../src/request-registry";
import { attachSession } from "../src/session-bridge";
import { SessionStore } from "../src/session-store";

setDefaultTimeout(60_000);

let root: string;
let host: OmpHost;
let model: ReturnType<typeof Bun.serve>;
const store = new SessionStore();
const requests = new RequestRegistry(store);
const sessions: AgentSession[] = [];
const savedEnv = {
  HOME: process.env.HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

/** Both turns are inside the model call before either is answered: the sessions truly overlap. */
const bothAsked = Promise.withResolvers<void>();
let asked = 0;

/** An OpenAI-compatible endpoint that echoes the last user message back, streamed in two chunks. */
function startModel() {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        messages: { role: string; content: unknown }[];
      };
      const last = body.messages.filter((m) => m.role === "user").at(-1);
      // omp sends the content as parts, with a system reminder before the prompt.
      const parts = Array.isArray(last?.content)
        ? (last.content as { type: string; text?: string }[])
        : [{ type: "text", text: String(last?.content) }];
      const text = parts.filter((part) => part.type === "text").at(-1)?.text ?? "";
      if (++asked === 2) bothAsked.resolve();
      await bothAsked.promise;
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id: "c1",
          object: "chat.completion.chunk",
          created: 1,
          model: "echo",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      const half = Math.ceil(text.length / 2);
      const stream = [
        chunk({ role: "assistant", content: "" }),
        chunk({ content: `echo ${text.slice(0, half)}` }),
        chunk({ content: text.slice(half) }),
        chunk({}, "stop"),
        "data: [DONE]\n\n",
      ].join("");
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-turns-")));
  const agentDir = join(root, "home", ".omp", "agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.HOME = join(root, "home");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
  model = startModel();
  // The local server is a custom provider of the throwaway agent dir. Settings are a process-wide
  // singleton that another test file may have loaded first, so each session picks the model itself.
  writeFileSync(
    join(agentDir, "models.yml"),
    [
      "providers:",
      "  local-echo:",
      `    baseUrl: http://127.0.0.1:${model.port}/v1`,
      "    apiKey: sk-test-not-a-real-key",
      "    api: openai-completions",
      "    models:",
      "      - id: echo",
      "        name: Echo",
      "",
    ].join("\n"),
  );
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

afterAll(async () => {
  model?.stop(true);
  await host?.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("two real sessions run a turn each at the same time and keep their own timelines", async () => {
  const dirs = ["one", "two"].map((name) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  });
  const [a, b] = await Promise.all(dirs.map((dir) => host.createSession(dir)));
  expect(a).not.toBe(b);
  for (const session of sessions.slice(-2)) {
    const echo = session.modelRegistry.find("local-echo", "echo");
    if (!echo) throw new Error("the local model is not in the registry");
    await session.setModel(echo, "default", { persist: false });
  }

  // Prompt one, then the other: neither can finish until both are inside the model call.
  const stops = await Promise.all([
    host.prompt(a as string, "alpha question"),
    host.prompt(b as string, "beta question"),
  ]);
  expect(stops).toEqual(["end_turn", "end_turn"]);

  const textOf = (id: string) =>
    store
      .snapshot(id)
      .snapshot.timeline.map((i) =>
        i.kind === "user" || i.kind === "assistant" ? `${i.kind}:${i.text}` : i.kind,
      )
      .join("|");
  expect(textOf(a as string)).toBe("user:alpha question|assistant:echo alpha question");
  expect(textOf(b as string)).toBe("user:beta question|assistant:echo beta question");
  expect(store.snapshot(a as string).snapshot.status).toBe("idle");
  expect(store.snapshot(b as string).snapshot.status).toBe("idle");
});
