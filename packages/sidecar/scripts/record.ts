/**
 * Dev script (local, needs credentials in the shared `~/.omp`): runs a real prompt against the
 * pinned omp and writes the raw `AgentSessionEvent` stream as JSONL to `test/fixtures/`.
 *
 *   bun run scripts/record.ts basic|cancel|tools|search|failures|todo|thinking|compaction|steering
 *
 * Line 1 is a header (`fixture: 1`) with what the replay needs to start from; every other line
 * is one event, verbatim except for scrubbing: the home directory becomes `~`, the temp working
 * directory becomes `/work/project`, and the script refuses to write anything that looks like a
 * credential.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { cfgCompactionThresholdTokens } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { startOmpHost } from "../src/omp-host";
import { RequestRegistry } from "../src/request-registry";
import { SessionStore } from "../src/session-store";

interface Scenario {
  readonly prompt: string;
  readonly cancelAfterDeltas: number;
  /** Files created in the temp project before the prompt, relative path -> content. */
  readonly files?: Readonly<Record<string, string>>;
  /**
   * Compaction trigger in tokens, set on the session's in-memory override layer only (never
   * written to `config.yml`). A value below the size of the system prompt makes omp compact on
   * its own as soon as the first turn ends.
   */
  readonly compactAtTokens?: number;
  /**
   * Cut every string longer than this many characters when writing, at every occurrence, with a
   * marker. For runs whose bulk is one big tool result repeated in five event types: the events,
   * their order and every field the app reads stay as omp sent them.
   */
  readonly clipStringsAt?: number;
  /**
   * Model (`provider/id`) and thinking level set on the session before the prompt, through the
   * same host calls the app uses. Recording them puts `model_changed` and `thinking_level_changed`
   * in the stream.
   */
  readonly model?: string;
  readonly thinking?: string;
  /**
   * Messages sent into the running turn once this many text deltas have streamed: first a
   * follow-up (queued until the turn ends), then a steer (injected into the turn).
   */
  readonly joinAfterDeltas?: number;
  readonly followUp?: string;
  readonly steer?: string;
}

const SCENARIOS: Record<string, Scenario> = {
  basic: { prompt: "Reply with exactly one word: pong. No tools.", cancelAfterDeltas: 0 },
  cancel: {
    prompt: "Count from 1 to 300, one number per line. No tools. Do not stop early.",
    cancelAfterDeltas: 5,
  },
  // One turn that reads, edits, writes and runs a shell command, in a tiny project.
  tools: {
    prompt:
      "In this directory: read notes.txt, use the edit tool to change the word draft to final in it, " +
      "use the write tool to create done.txt containing the single line ok, " +
      "then run `wc -l notes.txt` with bash. Finish with one short sentence.",
    cancelAfterDeltas: 0,
    files: { "notes.txt": "release notes\nstatus: draft\nowner: levy\n" },
  },
  // Search tools: grep with matches, glob, and a structural search.
  search: {
    prompt:
      "In this directory: use grep to find `retry` in the files, use glob to list the *.ts files, " +
      "then use ast_grep to find calls to `sleep(` in src/. One call per tool. " +
      "Finish with one short sentence.",
    cancelAfterDeltas: 0,
    files: {
      "src/supervisor.ts":
        "export async function run() {\n  await sleep(50);\n  retry();\n}\nfunction retry() {}\n",
      "src/clock.ts": "export const now = () => Date.now();\n// retry later\n",
      "README.md": "retry policy: none\n",
    },
  },
  // Tools that fail: a missing file and a command that exits non-zero.
  failures: {
    prompt:
      "Read the file missing.txt, then run `echo oops; exit 3` with bash. " +
      "Do not retry either. Finish with one short sentence.",
    cancelAfterDeltas: 0,
  },
  // The todo tool: the checklist the agent keeps.
  todo: {
    prompt:
      "Use the todo tool to create a list with exactly two tasks, `read notes` and `report`. " +
      "Then mark `read notes` done. Do nothing else. Finish with one short sentence.",
    cancelAfterDeltas: 0,
  },
  // A real automatic compaction. The trigger sits above the fixed context (system prompt and tool
  // schemas, about 15k tokens) and below what the file read adds, so the turn ends over it and
  // there is history to summarize.
  compaction: {
    prompt: "Read ledger.txt completely, then reply with exactly one word: pong.",
    cancelAfterDeltas: 0,
    compactAtTokens: 26000,
    clipStringsAt: 1200,
    files: {
      "ledger.txt": Array.from(
        { length: 900 },
        (_, i) =>
          `entry ${i + 1}: invoice ${1000 + i} settled on day ${(i % 28) + 1}, amount ${(i * 37) % 997}.${i % 100}`,
      ).join("\n"),
    },
  },
  // Prompt controls: a cheap model and a thinking level chosen before the turn, then a follow-up
  // and a steer sent while the agent is answering. The stream carries `model_changed`,
  // `thinking_level_changed`, `queue_update` and the steered user message.
  steering: {
    prompt: "Count from 1 to 40, one number per line. No tools. Do not stop early.",
    cancelAfterDeltas: 0,
    model: "kiro/claude-haiku-5.5",
    thinking: "low",
    joinAfterDeltas: 3,
    followUp: "After that, reply with exactly one word: done.",
    steer: "Stop counting at 10 and say so in one short sentence.",
  },
  // A run whose model reasons before answering.
  thinking: {
    prompt:
      "What is 17 times 23? Think it through step by step, then answer with the number only. No tools.",
    cancelAfterDeltas: 0,
  },
};

const name = process.argv[2];
const scenario = name ? SCENARIOS[name] : undefined;
if (!name || !scenario) {
  throw new Error(`usage: bun run scripts/record.ts ${Object.keys(SCENARIOS).join("|")}`);
}

const SECRET =
  /sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|api[_-]?key"\s*:\s*"[^"]{8,}|eyJ[A-Za-z0-9_-]{20,}/;

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-record-")));
const home = homedir();
for (const [file, content] of Object.entries(scenario.files ?? {})) {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), content);
}

function clip(value: unknown, max: number): unknown {
  if (typeof value === "string") {
    return value.length > max
      ? `${value.slice(0, max)}… [clipped ${value.length - max} chars]`
      : value;
  }
  if (Array.isArray(value)) return value.map((v) => clip(v, max));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clip(v, max)]));
  }
  return value;
}

function scrub(text: string): string {
  const out = text.replaceAll(cwd, "/work/project").replaceAll(home, "~");
  const hit = SECRET.exec(out);
  if (hit)
    throw new Error(`refusing to write: line looks like a credential (${hit[0].slice(0, 8)}…)`);
  return out;
}

const events: string[] = [];
let session: AgentSession | undefined;
let deltas = 0;
let joinCount = 0;
let cancelled: Promise<void> | undefined;
const joined: Promise<boolean>[] = [];

// No session is registered in this store, so a permission or ask cancels at once.
const host = await startOmpHost({
  autoApprove: true,
  requests: new RequestRegistry(new SessionStore()),
  onMcpFailure: () => {},
  onSessionCreated: (created) => {
    session = created;
    created.subscribe((event) => {
      events.push(JSON.stringify(event));
      if (
        scenario.cancelAfterDeltas > 0 &&
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta" &&
        ++deltas === scenario.cancelAfterDeltas &&
        sessionId
      ) {
        cancelled = host.cancel(sessionId);
      }
      if (
        scenario.joinAfterDeltas !== undefined &&
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta" &&
        ++joinCount === scenario.joinAfterDeltas &&
        sessionId
      ) {
        if (scenario.followUp) joined.push(host.join(sessionId, scenario.followUp, [], "followUp"));
        if (scenario.steer) joined.push(host.join(sessionId, scenario.steer, [], "steer"));
      }
    });
  },
});
let sessionId: string | undefined;
sessionId = await host.createSession(cwd);
const created = session;
if (!created) throw new Error("session was not created");

if (scenario.compactAtTokens !== undefined) {
  cfgCompactionThresholdTokens.override(created.settings, scenario.compactAtTokens);
}

if (scenario.model) await host.setModel(sessionId, scenario.model);
if (scenario.thinking) host.setThinking(sessionId, scenario.thinking);

const header = {
  fixture: 1,
  scenario: name,
  prompt: scenario.prompt,
  sessionId,
  cwd: "/work/project",
  model: created.model ? `${created.model.provider}/${created.model.id}` : null,
};
const stopReason = await host.prompt(sessionId, scenario.prompt);
await cancelled;
const admitted = await Promise.all(joined);
if (admitted.includes(false)) throw new Error("omp declined a message sent into the running turn");
// ACP answers "cancelled" before the session has finished unwinding; wait for its last events.
await created.waitForIdle();
if (scenario.compactAtTokens !== undefined) {
  // Compaction runs after the turn the prompt returned for: wait for its closing event.
  const deadline = Date.now() + 120_000;
  while (!events.some((e) => e.includes('"auto_compaction_end"')) && Date.now() < deadline) {
    await Bun.sleep(250);
  }
  await created.waitForIdle();
}
const sessionFile = created.sessionFile;
await host.close();

const outDir = join(import.meta.dir, "../test/fixtures");
mkdirSync(outDir, { recursive: true });
const clipAt = scenario.clipStringsAt;
const kept =
  clipAt === undefined ? events : events.map((e) => JSON.stringify(clip(JSON.parse(e), clipAt)));
const lines = [JSON.stringify(header), ...kept].map(scrub);
const outFile = join(outDir, `${name}.jsonl`);
writeFileSync(outFile, `${lines.join("\n")}\n`);
console.error(
  `recorded ${events.length} events, stop reason ${stopReason}, ${lines.join("\n").length} bytes -> ${outFile}`,
);

// The recording session is throwaway; do not leave it among the user's real sessions.
if (sessionFile) rmSync(sessionFile, { force: true });
rmSync(cwd, { recursive: true, force: true });
process.exit(0);
