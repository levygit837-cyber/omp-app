/**
 * Dev script (local, needs credentials in the shared `~/.omp`): runs a real prompt against the
 * pinned omp and writes the raw `AgentSessionEvent` stream as JSONL to `test/fixtures/`.
 *
 *   bun run scripts/record.ts basic|cancel
 *
 * Line 1 is a header (`fixture: 1`) with what the replay needs to start from; every other line
 * is one event, verbatim except for scrubbing: the home directory becomes `~`, the temp working
 * directory becomes `/work/project`, and the script refuses to write anything that looks like a
 * credential.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { startOmpHost } from "../src/omp-host";

const SCENARIOS = {
  basic: { prompt: "Reply with exactly one word: pong. No tools.", cancelAfterDeltas: 0 },
  cancel: {
    prompt: "Count from 1 to 300, one number per line. No tools. Do not stop early.",
    cancelAfterDeltas: 5,
  },
} as const;

const name = process.argv[2];
if (name !== "basic" && name !== "cancel") {
  throw new Error("usage: bun run scripts/record.ts basic|cancel");
}
const scenario = SCENARIOS[name];

const SECRET =
  /sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|api[_-]?key"\s*:\s*"[^"]{8,}|eyJ[A-Za-z0-9_-]{20,}/;

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-record-")));
const home = homedir();

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
let cancelled: Promise<void> | undefined;

const host = await startOmpHost({
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
    });
  },
});
let sessionId: string | undefined;
sessionId = await host.createSession(cwd);
const created = session;
if (!created) throw new Error("session was not created");

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
// ACP answers "cancelled" before the session has finished unwinding; wait for its last events.
await created.waitForIdle();
const sessionFile = created.sessionFile;
await host.close();

const outDir = join(import.meta.dir, "../test/fixtures");
mkdirSync(outDir, { recursive: true });
const lines = [JSON.stringify(header), ...events].map(scrub);
const outFile = join(outDir, `${name}.jsonl`);
writeFileSync(outFile, `${lines.join("\n")}\n`);
console.error(
  `recorded ${events.length} events, stop reason ${stopReason}, ${lines.join("\n").length} bytes -> ${outFile}`,
);

// The recording session is throwaway; do not leave it among the user's real sessions.
if (sessionFile) rmSync(sessionFile, { force: true });
rmSync(cwd, { recursive: true, force: true });
process.exit(0);
