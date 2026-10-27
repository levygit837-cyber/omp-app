/**
 * Live check (local, needs credentials in the shared `~/.omp`; not run in CI). Starts the real
 * sidecar from source, talks to it only through the app protocol, and runs the scenarios against
 * the pinned omp:
 *
 *   basic   prompt -> the answer streams in -> the session returns to idle
 *   cancel  prompt -> cancel mid-stream      -> the session returns to idle, partial text kept
 *   reject  a gated bash call raises a permission -> reject once -> the command never runs
 *   allow   the same call -> allow once -> the command runs
 *   ask     the `ask` tool raises a form -> pick an option -> the agent repeats it
 *   ask-cancel  the same form -> cancel it -> omp aborts the turn, the session ends idle
 *
 * Prints the observed ops and the session file each scenario left in the CLI's session
 * directory. Pass `--keep` to leave the sessions in place, e.g. to resume one with the CLI;
 * without it the run deletes its own session directory (named after its temp cwd) on every exit.
 *
 *   bun run scripts/live.ts [--keep]
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import {
  applyOp,
  decodeFrame,
  FrameDecoder,
  isEventEnvelope,
  isResponseEnvelope,
  isSessionOpEvent,
  type PendingRequest,
  RequestCorrelator,
  type SessionOpEvent,
  type SessionViewModel,
} from "@omp-app/protocol";

const keep = process.argv.includes("--keep");
const entry = join(import.meta.dir, "../src/main.ts");
const runtimeDir = mkdtempSync(join(tmpdir(), "omp-app-live-"));
const socketPath = join(runtimeDir, "s.sock");
const proc = Bun.spawn([process.execPath, entry, `--socket=${socketPath}`], {
  stdin: "ignore",
  stdout: "ignore",
  stderr: "inherit",
});
while (!existsSync(socketPath)) {
  if (proc.exitCode !== null) throw new Error("sidecar exited early");
  await Bun.sleep(50);
}

const correlator = new RequestCorrelator();
const decoder = new FrameDecoder();
const text = new TextDecoder();
const ops: SessionOpEvent[] = [];
const socket = await Bun.connect({
  unix: socketPath,
  socket: {
    data(_s, chunk) {
      for (const line of decoder.push(text.decode(chunk, { stream: true }))) {
        const frame = decodeFrame(line);
        if (!frame.ok) throw new Error(`non-frame: ${line}`);
        if (isResponseEnvelope(frame.envelope)) correlator.receive(frame.envelope);
        else if (isEventEnvelope(frame.envelope) && isSessionOpEvent(frame.envelope.data)) {
          ops.push(frame.envelope.data);
        }
      }
    },
  },
});
function ask<M extends Parameters<typeof correlator.create>[0]>(
  method: M,
  params?: Parameters<typeof correlator.create<M>>[1],
) {
  const { frame, response } = correlator.create(method, params);
  socket.write(frame);
  return response;
}

async function until(label: string, predicate: () => boolean, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}

const handshake = await ask("handshake");
console.log(`sidecar up: omp ${handshake.ompVersion}, mode ${handshake.mode}`);
if (handshake.mode !== "normal") throw new Error("sidecar is read_only; cannot run live scenarios");

const cwd = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-live-project-")));

/**
 * Leaves nothing in the shared `~/.omp` behind: omp files this run's sessions (and their lock
 * files) under a directory named after the unique temp cwd, so that directory is ours alone.
 * Runs on every exit, including a scenario that throws or a Ctrl-C. `--keep` skips it.
 */
function cleanup() {
  proc.kill();
  rmSync(runtimeDir, { recursive: true, force: true });
  if (keep) return;
  const sessionDir = SessionManager.getDefaultSessionDir(cwd);
  if (basename(sessionDir).startsWith("-tmp-omp-app-live-project-")) {
    rmSync(sessionDir, { recursive: true, force: true });
  }
  rmSync(cwd, { recursive: true, force: true });
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
const results: { scenario: string; sessionId: string; failures: string[] }[] = [];

/** The next request the sidecar raised for `sessionId` after op index `from`. */
async function nextRequest(sessionId: string, from: number): Promise<PendingRequest> {
  let found: PendingRequest | undefined;
  await until("a request to answer", () => {
    for (const o of ops.slice(from)) {
      if (o.sessionId === sessionId && o.op.type === "request.add") found = o.op.request;
    }
    return found !== undefined;
  });
  if (!found) throw new Error("unreachable");
  return found;
}

async function scenario(
  name: string,
  prompt: string,
  check: (vm: SessionViewModel, mine: SessionOpEvent[]) => string[],
  drive?: (sessionId: string, from: number, failures: string[]) => Promise<void>,
) {
  const { sessionId } = await ask("session.create", { cwd });
  const sub = await ask("session.subscribe", { sessionId });
  let vm = sub.snapshot;
  const from = ops.length;
  await ask("session.prompt", { sessionId, text: prompt });
  const failures: string[] = [];
  await drive?.(sessionId, from, failures);

  if (name === "cancel") {
    await until("first streamed text", () =>
      ops
        .slice(from)
        .some(
          (o) =>
            o.op.type === "item.appendText" ||
            (o.op.type === "item.add" && o.op.item.kind === "assistant"),
        ),
    );
    await ask("session.cancel", { sessionId });
  }
  await until(`${name} to finish`, () => {
    const mine = ops.slice(from).filter((o) => o.sessionId === sessionId);
    const last = [...mine].reverse().find((o) => o.op.type === "status.set");
    return last?.op.type === "status.set" && last.op.status !== "streaming";
  });
  await Bun.sleep(300); // trailing ops after the status flip would show up here

  const mine = ops.slice(from).filter((o) => o.sessionId === sessionId);
  let expected = sub.seq;
  for (const o of mine) {
    if (o.seq !== ++expected) failures.push(`seq gap: expected ${expected}, got ${o.seq}`);
    vm = applyOp(vm, o.op);
  }
  const server = await ask("session.subscribe", { sessionId });
  if (JSON.stringify(server.snapshot) !== JSON.stringify(vm)) {
    failures.push("replica built from ops differs from the sidecar's snapshot");
  }
  failures.push(...check(vm, mine));

  const kinds = mine
    .map((o) => o.op.type)
    .reduce<Record<string, number>>((acc, t) => {
      acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    }, {});
  console.log(`\n== ${name} (${sessionId})`);
  console.log(`ops: ${JSON.stringify(kinds)}`);
  console.log(`status: ${vm.status}, model: ${vm.model}`);
  for (const item of vm.timeline) {
    if (item.kind === "decision") {
      console.log(`  decision: ${item.outcome} ${JSON.stringify(item.subject)}`);
      continue;
    }
    const body =
      "text" in item ? item.text : item.kind === "tool" ? (item.intent ?? item.tool) : item.kind;
    const t = body.length > 100 ? `${body.slice(0, 100)}… (${body.length} chars)` : body;
    console.log(
      `  ${item.kind}${item.kind === "assistant" ? (item.done ? " [done]" : " [open]") : ""}: ${JSON.stringify(t)}`,
    );
  }
  results.push({ scenario: name, sessionId, failures });
}

await scenario("basic", "Reply with exactly one word: pong. No tools.", (vm) => {
  const a = vm.timeline.at(-1);
  return [
    ...(vm.status === "idle" ? [] : [`status is ${vm.status}, expected idle`]),
    ...(a?.kind === "assistant" && a.done && /pong/i.test(a.text)
      ? []
      : ["no completed answer containing pong"]),
  ];
});
await scenario(
  "cancel",
  "Count from 1 to 400, one number per line. No tools. Do not stop early.",
  (vm) => {
    const a = vm.timeline.at(-1);
    return [
      ...(vm.status === "idle" ? [] : [`status is ${vm.status}, expected idle`]),
      ...(a?.kind === "assistant" && a.done ? [] : ["the partial answer was not closed"]),
      ...(a?.kind === "assistant" && !a.text.includes("400") ? [] : ["the run was not cancelled"]),
    ];
  },
);

/** A bash call the agent cannot make without asking: it touches a file, so the effect is checkable. */
const gatedFile = join(cwd, "gated.txt");
const touchPrompt = `Use the bash tool to run \`touch ${gatedFile}\`. If it is denied, only say 'denied'.`;
const decided = (vm: SessionViewModel) =>
  vm.timeline.flatMap((i) => (i.kind === "decision" ? [i.outcome] : []));

/** Waits for the permission, checks it shows the four options and the exact command, answers it. */
const answerGate =
  (optionKind: string) => async (sessionId: string, from: number, failures: string[]) => {
    const request = await nextRequest(sessionId, from);
    if (request.kind !== "permission")
      return void failures.push(`expected a permission, got ${request.kind}`);
    const kinds = request.options
      .map((o) => o.kind)
      .sort()
      .join(",");
    if (kinds !== "allow_always,allow_once,reject_always,reject_once")
      failures.push(`options: ${kinds}`);
    if (!request.payload.includes(gatedFile))
      failures.push(`payload lacks the command: ${request.payload}`);
    console.log(
      `  permission: ${JSON.stringify(request.title)} payload=${JSON.stringify(request.payload)}`,
    );
    const option = request.options.find((o) => o.kind === optionKind);
    if (!option) return void failures.push(`no ${optionKind} option`);
    await ask("session.answerPermission", {
      sessionId,
      requestId: request.id,
      optionId: option.optionId,
    });
  };

await scenario(
  "reject",
  touchPrompt,
  (vm) => [
    ...(existsSync(gatedFile) ? ["the rejected command ran"] : []),
    ...(decided(vm).join() === "rejected_once"
      ? []
      : [`decisions: ${decided(vm).join() || "none"}`]),
    ...(vm.pending.length === 0 ? [] : ["a request is still pending"]),
  ],
  answerGate("reject_once"),
);
await scenario(
  "allow",
  touchPrompt,
  (vm) => [
    ...(existsSync(gatedFile) ? [] : ["the allowed command did not run"]),
    ...(decided(vm).join() === "allowed_once"
      ? []
      : [`decisions: ${decided(vm).join() || "none"}`]),
    ...(vm.pending.length === 0 ? [] : ["a request is still pending"]),
  ],
  answerGate("allow_once"),
);
await scenario(
  "ask",
  "Use the ask tool to ask me which color I prefer, with the options blue, green and red. Then repeat the option I chose in one short English sentence.",
  (vm) => {
    const last = [...vm.timeline].reverse().find((i) => i.kind === "assistant");
    return [
      ...(decided(vm).join() === "answered" ? [] : [`decisions: ${decided(vm).join() || "none"}`]),
      ...(last?.kind === "assistant" && /green/i.test(last.text)
        ? []
        : ["the agent did not repeat green"]),
      ...(vm.pending.length === 0 ? [] : ["a request is still pending"]),
    ];
  },
  async (sessionId, from, failures) => {
    const request = await nextRequest(sessionId, from);
    if (request.kind !== "ask") return void failures.push(`expected an ask, got ${request.kind}`);
    const field = request.fields[0];
    const green = field?.choices?.find((c) => /green/i.test(c.label) || /green/i.test(c.value));
    console.log(
      `  ask: ${JSON.stringify(request.message)} fields=${JSON.stringify(request.fields)}`,
    );
    if (field?.type !== "select" || !green)
      return void failures.push("no select with a green choice");
    await ask("session.answerAsk", {
      sessionId,
      requestId: request.id,
      action: "accept",
      content: { [field.key]: green.value },
    });
  },
);

// Cancelling a form is not a skip: omp reads it as the person stopping the agent
// [V] acp-agent.ts:567-569,717 -> tools/ask.ts:784-787 -> session-tools.ts:432-434.
await scenario(
  "ask-cancel",
  "Use the ask tool to ask me which color I prefer, with the options blue, green and red. Do nothing else.",
  (vm) => [
    ...(vm.status === "idle" ? [] : [`status is ${vm.status}, expected idle`]),
    ...(decided(vm).join() === "cancelled" ? [] : [`decisions: ${decided(vm).join() || "none"}`]),
    ...(vm.pending.length === 0 ? [] : ["a request is still pending"]),
  ],
  async (sessionId, from, failures) => {
    const request = await nextRequest(sessionId, from);
    if (request.kind !== "ask") return void failures.push(`expected an ask, got ${request.kind}`);
    await ask("session.answerAsk", { sessionId, requestId: request.id, action: "decline" });
  },
);

console.log(`\nsession directory: ${join(getAgentDir(), "sessions")}`);

for (const r of results) {
  const found = new Bun.Glob(`**/*${r.sessionId}*.jsonl`).scanSync({
    cwd: join(getAgentDir(), "sessions"),
  });
  const file = [...found][0];
  console.log(`  ${r.scenario}: ${file ? join(getAgentDir(), "sessions", file) : "NOT FOUND"}`);
  if (!file) r.failures.push("session file not found in the CLI session directory");
}
console.log(
  `resume: omp --resume ${results[0]?.sessionId.slice(0, 8)} -p "What did I ask first?"  (cwd ${cwd})`,
);

socket.end();
proc.kill();
await proc.exited;
const failed = results.filter((r) => r.failures.length > 0);
for (const r of failed) console.log(`FAIL ${r.scenario}: ${r.failures.join("; ")}`);
console.log(failed.length === 0 ? "\nlive: all scenarios passed" : "\nlive: FAILED");
process.exit(failed.length === 0 ? 0 : 1);
