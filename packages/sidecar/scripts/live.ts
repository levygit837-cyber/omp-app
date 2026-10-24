/**
 * Live check (local, needs credentials in the shared `~/.omp`; not run in CI). Starts the real
 * sidecar from source, talks to it only through the app protocol, and runs two scenarios against
 * the pinned omp:
 *
 *   basic   prompt -> the answer streams in -> the session returns to idle
 *   cancel  prompt -> cancel mid-stream      -> the session returns to idle, partial text kept
 *
 * Prints the observed ops and the session file each scenario left in the CLI's session
 * directory. Pass `--keep` to leave the sessions in place, e.g. to resume one with the CLI.
 *
 *   bun run scripts/live.ts [--keep]
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import {
  applyOp,
  decodeFrame,
  FrameDecoder,
  isEventEnvelope,
  isResponseEnvelope,
  isSessionOpEvent,
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
const results: { scenario: string; sessionId: string; failures: string[] }[] = [];

async function scenario(
  name: "basic" | "cancel",
  prompt: string,
  check: (vm: SessionViewModel, mine: SessionOpEvent[]) => string[],
) {
  const { sessionId } = await ask("session.create", { cwd });
  const sub = await ask("session.subscribe", { sessionId });
  let vm = sub.snapshot;
  const from = ops.length;
  await ask("session.prompt", { sessionId, text: prompt });

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
  const failures: string[] = [];
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
    const t =
      item.text.length > 100
        ? `${item.text.slice(0, 100)}… (${item.text.length} chars)`
        : item.text;
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

console.log(`\nsession directory: ${join(getAgentDir(), "sessions")}`);
const sessionFiles: string[] = [];
for (const r of results) {
  const found = new Bun.Glob(`**/*${r.sessionId}*.jsonl`).scanSync({
    cwd: join(getAgentDir(), "sessions"),
  });
  const file = [...found][0];
  console.log(`  ${r.scenario}: ${file ? join(getAgentDir(), "sessions", file) : "NOT FOUND"}`);
  if (file) sessionFiles.push(join(getAgentDir(), "sessions", file));
  else r.failures.push("session file not found in the CLI session directory");
}
console.log(
  `resume: omp --resume ${results[0]?.sessionId.slice(0, 8)} -p "What did I ask first?"  (cwd ${cwd})`,
);

socket.end();
proc.kill();
await proc.exited;
const failed = results.filter((r) => r.failures.length > 0);
for (const r of failed) console.log(`FAIL ${r.scenario}: ${r.failures.join("; ")}`);
if (!keep) {
  for (const f of sessionFiles) rmSync(f, { force: true });
  rmSync(cwd, { recursive: true, force: true });
}
rmSync(runtimeDir, { recursive: true, force: true });
console.log(failed.length === 0 ? "\nlive: all scenarios passed" : "\nlive: FAILED");
process.exit(failed.length === 0 ? 0 : 1);
