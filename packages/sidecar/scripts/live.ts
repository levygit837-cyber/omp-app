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
 *   model   session.models lists real models; switching model and thinking shows in the view
 *           model and the next turn runs on the new model; both are refused while a turn runs
 *   steer   a message sent mid-turn is injected: queue.set shows it, then a `steered` user item
 *   followup  a follow-up sent mid-turn waits in the queue, then runs as its own turn
 *   stop-queue  Stop with a follow-up queued: what is left in the queue and whether a turn starts
 *   image   a generated PNG travels as base64; the model names its color
 *   file    an `@file` in the prompt: the agent answers from the file's content
 *   commands    builtins through `session.runCommand`, idle and mid-stream, with and without an
 *               argument; a refusal is omp's own sentence; a gated line is refused without
 *               `confirmed`; `/fresh` keeps the session id; the output is in the session file
 *
 *   plan-toggle plan mode on -> view model says so, off -> it says so
 *   plan-approve  plan mode on -> the agent writes a plan and proposes it -> the question carries
 *               both choices and the plan file reads back -> Approve and execute -> plan mode is
 *               off and the work starts (the file the plan describes appears)
 *   plan-refine the same proposal -> Refine plan -> plan mode stays on, the agent proposes again
 *   plan-cancel the same proposal -> cancel the question -> read as Refine plan: plan mode stays
 *               on and the agent proposes again (the turn is stopped by the script afterwards)
 *
 * The plan scenarios run on `kiro/claude-haiku-5.5`, pinned by a project-level `.omp/config.yml`
 * in the temp cwd, so the real `~/.omp/config.yml` is never written.
 *
 * Prints the observed ops and the session file each scenario left in the CLI's session
 * directory. Pass `--keep` to leave the sessions in place, e.g. to resume one with the CLI;
 * without it the run deletes its own session directory (named after its temp cwd) on every exit.
 *
 *   bun run scripts/live.ts [--keep] [--only=model,steer,...]
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, postmortem } from "@oh-my-pi/pi-utils";
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
import { ownsLiveSessionDir, stopThenClean } from "./live-cleanup";

const keep = process.argv.includes("--keep");
/** `--only=model,steer` runs just those scenarios. */
const only = process.argv
  .find((arg) => arg.startsWith("--only="))
  ?.slice(7)
  .split(",");
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
// The cheap model for every scenario of this run, from the project layer of the temp cwd.
mkdirSync(join(cwd, ".omp"), { recursive: true });
writeFileSync(
  join(cwd, ".omp", "config.yml"),
  "modelRoles:\n  default: kiro/claude-haiku-5.5:low\n  plan: kiro/claude-haiku-5.5:low\n",
);

/**
 * Removes this run's sessions (and their lock files) from the shared `~/.omp`: omp files them under
 * a directory named after the unique temp cwd, so that directory is ours alone. It is only removed
 * when `ownsLiveSessionDir` agrees, whatever form omp gave the name. Runs on every exit, including
 * a scenario that throws (omp's fatal handler) or a Ctrl-C. `--keep` skips it.
 */
function cleanup() {
  proc.kill();
  rmSync(runtimeDir, { recursive: true, force: true });
  if (keep) return;
  const sessionDir = SessionManager.getDefaultSessionDir(cwd);
  if (ownsLiveSessionDir(sessionDir, cwd)) {
    rmSync(sessionDir, { recursive: true, force: true });
  }
  rmSync(cwd, { recursive: true, force: true });
}
process.on("exit", cleanup);
// omp's fatal-error handler ends the process with `reallyExit`, which skips the `exit` event
// above: a scenario that throws would leave its temp folders and session directory behind.
// Registered with the same postmortem system, the cleanup runs on that path too (it is idempotent).
// The sidecar still writes its session file while it shuts down: remove the folders after it.
const stopAndClean = () =>
  stopThenClean({ stop: () => proc.kill(), exited: proc.exited, clean: cleanup, waitMs: 5_000 });
postmortem.register("live-cleanup", async () => {
  await stopAndClean();
});
// `process.exit` here would run the synchronous `exit` cleanup at once and cut the wait above, so
// the exit comes after it.
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(signal, () => void stopAndClean().finally(() => process.exit(code)));
}
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

/** The view model a subscriber would hold: the snapshot plus this session's ops since `from`. */
function replica(snapshot: SessionViewModel, sessionId: string, from: number): SessionViewModel {
  return ops
    .slice(from)
    .filter((o) => o.sessionId === sessionId)
    .reduce((vm, o) => applyOp(vm, o.op), snapshot);
}

async function scenario(
  name: string,
  prompt: string,
  check: (vm: SessionViewModel, mine: SessionOpEvent[]) => string[],
  drive?: (sessionId: string, from: number, failures: string[]) => Promise<void>,
  options: {
    /** Runs after the session exists and before the prompt (choose a model, for instance). */
    before?: (sessionId: string, failures: string[]) => Promise<void>;
    images?: { mimeType: string; data: string }[];
  } = {},
) {
  if (only && !only.includes(name)) return;
  const { sessionId } = await ask("session.create", { cwd });
  const sub = await ask("session.subscribe", { sessionId });
  let vm = sub.snapshot;
  // Taken before `setup`, so the ops it causes are part of the replica and of the seq check.
  const from = ops.length;
  const early: string[] = [];
  await options.before?.(sessionId, early);
  await ask("session.prompt", { sessionId, text: prompt, images: options.images });
  const failures: string[] = [...early];
  await drive?.(sessionId, from, failures);

  if (name === "cancel") {
    // Reasoning is on the timeline too (`thinking` items also take `item.appendText`), so wait
    // for text of the answer itself: cancelling during the reasoning leaves no answer to close.
    await until("first streamed answer text", () =>
      replica(sub.snapshot, sessionId, from).timeline.some(
        (i) => i.kind === "assistant" && i.text !== "",
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
    const a = vm.timeline.findLast((i) => i.kind === "assistant");
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

// ── Prompt controls (#14) ────────────────────────────────────────────────────────────────
/** The cheap model every prompt-control scenario runs on. */
const CHEAP = "kiro/claude-haiku-5.5";
const useCheap = async (sessionId: string) => {
  await ask("session.setModel", { sessionId, model: CHEAP });
};
const textOf = (vm: SessionViewModel) =>
  vm.timeline.flatMap((i) => (i.kind === "assistant" ? [i.text] : [])).join("\n");
const queueOps = (mine: SessionOpEvent[]) =>
  mine.flatMap((o) => (o.op.type === "queue.set" ? [o.op.queue] : []));
const COUNTING = "Count from 1 to 60, one number per line. No tools. Do not stop early.";

await scenario(
  "model",
  "Reply with exactly one word: pong. No tools.",
  (vm) => [
    ...(vm.model === CHEAP ? [] : [`model is ${vm.model}, expected ${CHEAP}`]),
    ...(vm.thinking === "low" ? [] : [`thinking is ${vm.thinking}, expected low`]),
    ...(/pong/i.test(textOf(vm)) ? [] : ["the turn did not answer"]),
  ],
  async (sessionId, _from, failures) => {
    // Refused while the turn runs: the choice is for the next turn.
    const refused = await ask("session.setModel", { sessionId, model: CHEAP }).then(
      () => false,
      (e: unknown) => String(e).includes("session is busy"),
    );
    if (!refused) failures.push("switching the model mid-turn was not refused as busy");
  },
  {
    before: async (sessionId, failures) => {
      const { models } = await ask("session.models", { sessionId });
      console.log(
        `models: ${models.length} (${[...new Set(models.map((m) => m.provider))].join(", ")})`,
      );
      const cheap = models.find((m) => m.id === CHEAP);
      if (!cheap) {
        failures.push(`${CHEAP} is not in session.models`);
        return;
      }
      console.log(`${CHEAP} efforts: ${JSON.stringify(cheap.efforts)}`);
      await useCheap(sessionId);
      const level = cheap.efforts.includes("low") ? "low" : (cheap.efforts[0] ?? "off");
      await ask("session.setThinking", { sessionId, level });
      const bad = await ask("session.setThinking", { sessionId, level: "bogus" }).then(
        () => false,
        () => true,
      );
      if (!bad) failures.push("an unknown thinking level was accepted");
    },
  },
);

/** A scenario that sends `text` with `delivery` once the answer to COUNTING is streaming. */
function joiningScenario(
  name: string,
  delivery: "steer" | "followUp",
  text: string,
  check: (vm: SessionViewModel, mine: SessionOpEvent[]) => string[],
) {
  return scenario(
    name,
    COUNTING,
    check,
    async (sessionId, from) => {
      await until("the answer to start streaming", () =>
        ops.slice(from).some((o) => o.sessionId === sessionId && o.op.type === "item.appendText"),
      );
      await ask("session.prompt", { sessionId, text, delivery });
    },
    { before: (sessionId) => useCheap(sessionId) },
  );
}

await joiningScenario(
  "steer",
  "steer",
  "Stop counting at 10 and say so in one short sentence.",
  (vm, mine) => {
    const steered = vm.timeline.find((i) => i.kind === "user" && i.steered === true);
    return [
      ...(queueOps(mine).some((q) => q.steering.length > 0)
        ? []
        : ["the steer never showed in the queue"]),
      ...(steered ? [] : ["no user item carries the steered flag"]),
      ...(vm.queue.steering.length === 0 ? [] : ["the steering queue did not drain"]),
    ];
  },
);

await joiningScenario(
  "followup",
  "followUp",
  "After that, reply with exactly one word: done.",
  (vm, mine) => {
    const users = vm.timeline.filter((i) => i.kind === "user");
    return [
      ...(queueOps(mine).some((q) => q.followUp.length > 0)
        ? []
        : ["the follow-up never showed in the queue"]),
      ...(users.length === 2 ? [] : [`expected 2 user items, found ${users.length}`]),
      ...(users.some((u) => u.kind === "user" && u.steered === true)
        ? ["a follow-up was flagged steered"]
        : []),
      ...(vm.queue.followUp.length === 0 ? [] : ["the follow-up queue did not drain"]),
      ...(/done/i.test(textOf(vm)) ? [] : ["the follow-up turn did not answer"]),
    ];
  },
);

// What Stop leaves behind: observed, and reported as such.
await scenario(
  "stop-queue",
  COUNTING,
  (vm, mine) => {
    console.log(
      `stop-queue: queue after stop ${JSON.stringify(vm.queue)}, user items ${vm.timeline.filter((i) => i.kind === "user").length}, status ${vm.status}`,
    );
    console.log(
      `stop-queue: queue states seen ${JSON.stringify(queueOps(mine).map((q) => [q.steering.length, q.followUp.length]))}`,
    );
    const users = vm.timeline.filter((i) => i.kind === "user").length;
    return [
      ...(vm.status === "idle" ? [] : [`status is ${vm.status}, expected idle`]),
      // omp's cancel aborts only: the follow-up stays queued and nothing starts it. The window
      // takes it back with `removeQueued` on Stop; this pins the omp behaviour that needs.
      ...(vm.queue.followUp.length === 1 && vm.queue.followUp[0] === "Then say: later."
        ? []
        : [`expected the follow-up to stay queued, queue is ${JSON.stringify(vm.queue)}`]),
      ...(users === 1 ? [] : [`expected 1 user item, found ${users}`]),
    ];
  },
  async (sessionId, from) => {
    await until("the answer to start streaming", () =>
      ops.slice(from).some((o) => o.sessionId === sessionId && o.op.type === "item.appendText"),
    );
    await ask("session.prompt", { sessionId, text: "Then say: later.", delivery: "followUp" });
    await until("the follow-up to be queued", () =>
      ops
        .slice(from)
        .some(
          (o) =>
            o.sessionId === sessionId &&
            o.op.type === "queue.set" &&
            o.op.queue.followUp.length > 0,
        ),
    );
    await ask("session.cancel", { sessionId });
    await Bun.sleep(4000);
  },
  { before: (sessionId) => useCheap(sessionId) },
);

/** A solid red 16x16 PNG, built here so the check needs no asset. */
function redPng(): string {
  const chunk = (type: string, body: Uint8Array) => {
    const head = new Uint8Array(4 + body.length);
    head.set(new TextEncoder().encode(type));
    head.set(body, 4);
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    out.set(head, 4);
    view.setUint32(8 + body.length, Bun.hash.crc32(head) >>> 0);
    return out;
  };
  const size = 16;
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, size);
  hv.setUint32(4, size);
  header.set([8, 2, 0, 0, 0], 8);
  const row = new Uint8Array(1 + size * 3);
  for (let x = 0; x < size; x++) row.set([255, 0, 0], 1 + x * 3);
  const raw = new Uint8Array(row.length * size);
  for (let y = 0; y < size; y++) raw.set(row, y * row.length);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  ];
  return Buffer.concat(parts).toString("base64");
}

await scenario(
  "image",
  "What single color fills this image? Answer with one lowercase word. No tools.",
  (vm) => {
    const user = vm.timeline.find((i) => i.kind === "user");
    return [
      ...(user?.kind === "user" && user.attachments?.[0]?.kind === "image"
        ? []
        : [
            "the user item carries no image attachment (omp re-encodes the image, so only its kind is checked)",
          ]),
      ...(/red/i.test(textOf(vm))
        ? []
        : [`the model did not name the color: ${JSON.stringify(textOf(vm))}`]),
    ];
  },
  undefined,
  {
    before: (sessionId) => useCheap(sessionId),
    images: [{ mimeType: "image/png", data: redPng() }],
  },
);

await Bun.write(join(cwd, "secret.txt"), "The password is BLUE-HERON-42.\n");
await scenario(
  "file",
  "What is the password in @secret.txt? Answer with the password only.",
  (vm) =>
    /BLUE-HERON-42/.test(textOf(vm))
      ? []
      : [`the agent did not read the file: ${JSON.stringify(textOf(vm))}`],
  undefined,
  { before: (sessionId) => useCheap(sessionId) },
);

// A `@file` typed into a steer is queued as raw text: omp reads files only for a prompt that
// starts a turn (`joinActiveTurn` vs `#prompt`). So no `user.files` op follows the steer, and an
// agent that wants the file has to open it with a tool; in the idle `file` scenario omp pre-reads
// it and no tool runs. The answer text is not checked: the agent may well read the file itself.
await Bun.write(join(cwd, "mid.txt"), "The code is GREEN-OTTER-77.\n");
await joiningScenario(
  "mid-turn-file",
  "steer",
  "Stop counting. What is the code in @mid.txt?",
  (vm, mine) => {
    const at = vm.timeline.findIndex((i) => i.kind === "user" && i.steered === true);
    const steer = vm.timeline[at];
    return [
      ...(at === -1 ? ["no steered user item"] : []),
      ...(steer?.kind === "user" && steer.files === undefined
        ? []
        : ["the steer carries files, but omp reads none for a joined message"]),
      ...(mine.some((o) => o.op.type === "user.files")
        ? ["a user.files op was emitted though no prompt started a turn with that file"]
        : []),
      ...(at !== -1 && vm.timeline.slice(at).some((i) => i.kind === "tool")
        ? []
        : ["the agent opened no file by itself after the steer"]),
    ];
  },
);

// Builtins run beside the turn and never through `session/prompt` (which would cancel it).
// `/switch` is session-only (`setModelTemporary`, builtin-modes.ts:525 [V]) so the real
// `config.yml` is not touched; `/effort` sets this session's thinking level.
if (!only || only.includes("commands")) {
  const { sessionId } = await ask("session.create", { cwd });
  const sub = await ask("session.subscribe", { sessionId });
  const from = ops.length;
  const failures: string[] = [];
  const view = () => replica(sub.snapshot, sessionId, from);
  const commandItems = () => view().timeline.filter((i) => i.kind === "command");
  const run = async (
    line: string,
    wanted: "done" | "failed" | "stopped" = "done",
    confirmed?: true,
  ) => {
    const before = commandItems().length;
    await ask("session.runCommand", { sessionId, text: line, ...(confirmed && { confirmed }) });
    await until(`${line} to end`, () => {
      const item = commandItems()[before];
      return item !== undefined && item.state !== "running";
    });
    const item = commandItems()[before];
    if (item?.kind !== "command") throw new Error("unreachable");
    console.log(`  ${line} -> ${item.state}: ${JSON.stringify(item.output.slice(0, 120))}`);
    if (item.state !== wanted) failures.push(`${line}: ${item.state}, wanted ${wanted}`);
    return item;
  };
  const idle = () => view().status === "idle";

  await run(`/switch ${process.env.LIVE_MODEL ?? "kiro/claude-haiku-5.5"}`);
  const bare = await run("/effort");
  if (bare.output === "") failures.push("/effort printed nothing");
  const withArg = await run("/effort low");
  if (!/low/i.test(withArg.output)) failures.push(`/effort low: ${withArg.output}`);
  await run("/usage");
  if (!idle()) failures.push("an idle command changed the status");

  // Mid-stream: the turn keeps going, the command answers beside it.
  await ask("session.prompt", {
    sessionId,
    text: "Count from 1 to 300, one number per line. No tools. Do not stop early.",
  });
  await until("answer text", () =>
    view().timeline.some((i) => i.kind === "assistant" && i.text !== ""),
  );
  const midBare = await run("/effort");
  const midArg = await run("/effort medium");
  if (view().status !== "streaming") failures.push("a command stopped the running turn");
  const refused = await run("/move /tmp", "failed", true);
  console.log(`  mid-stream refusal sentence: ${JSON.stringify(refused.output)}`);
  if (!/streaming/i.test(refused.output)) failures.push(`refusal is not omp's: ${refused.output}`);
  if (midBare.output === "" || midArg.output === "")
    failures.push("a mid-stream command was silent");
  await ask("session.cancel", { sessionId });
  await until("the cancelled turn to end", idle);
  const assistants = view().timeline.filter((i) => i.kind === "assistant");
  if (assistants.length !== 1)
    failures.push(`the commands split the reply into ${assistants.length}`);

  // A line that reaches beyond the session is refused by the sidecar without `confirmed`, and
  // leaves no timeline item behind.
  const itemsBefore = commandItems().length;
  const refusal = await ask("session.runCommand", { sessionId, text: "/export" }).then(
    () => null,
    (error: Error) => error.message,
  );
  console.log(`  /export without confirmed -> ${JSON.stringify(refusal)}`);
  if (!refusal?.startsWith("confirmation required"))
    failures.push(`/export was not refused: ${refusal}`);
  if (commandItems().length !== itemsBefore) failures.push("a refused line left an item");

  // `/fresh` replaces the provider session id; the session keeps its own id and file.
  await run("/fresh");
  await run("/effort");
  if (view().status !== "idle") failures.push(`status after /fresh: ${view().status}`);

  // `/force` is not gated, but it hands its text back and omp would dispatch that as a builtin:
  // the gate holds the handed-back line too, and the session file survives it.
  const sessionFile = [
    ...new Bun.Glob(`**/*${sessionId}*.jsonl`).scanSync({ cwd: join(getAgentDir(), "sessions") }),
  ][0];
  const handedBack = await run("/force read /session delete", "failed");
  console.log(`  handed-back /session delete -> ${JSON.stringify(handedBack.output)}`);
  if (!/needs a confirmation first/.test(handedBack.output))
    failures.push(`handed-back line not stopped: ${handedBack.output}`);
  if (!sessionFile || !existsSync(join(getAgentDir(), "sessions", sessionFile)))
    failures.push("the session file is gone after a handed-back /session delete");

  // Persisted: the session file carries the entries, and a resume replays them.
  const stored = new Bun.Glob(`**/*${sessionId}*.jsonl`).scanSync({
    cwd: join(getAgentDir(), "sessions"),
  });
  const file = [...stored][0];
  const lines = file
    ? (await Bun.file(join(getAgentDir(), "sessions", file)).text()).split("\n")
    : [];
  const entries = lines.filter((l) => l.includes('"omp-app/command"')).length;
  console.log(`\n== commands (${sessionId}): ${commandItems().length} items, ${entries} stored`);
  if (entries !== commandItems().length)
    failures.push(`stored ${entries}, shown ${commandItems().length}`);
  results.push({ scenario: "commands", sessionId, failures });
}

// ── Plan mode ───────────────────────────────────────────────────────────────

const planOf = (sessionId: string) =>
  ask("session.subscribe", { sessionId }).then((r) => r.snapshot.plan);
const planSetup = async (sessionId: string) => {
  await ask("session.setPlanMode", { sessionId, enabled: true });
};
/** Each scenario has its own target file, so one scenario's work is never read as another's. */
const planPrompt = (file: string) =>
  `Plan how to create a file named ${file} in ${cwd} that contains the single word hi. Keep the plan to three short steps, then propose it. Do not create the file before the plan is approved; once it is approved, create it.`;
const target = (file: string) => join(cwd, file);

/** The approval question omp raises for a proposal, with both choices, checked and returned. */
async function proposal(sessionId: string, from: number, failures: string[]) {
  const request = await nextRequest(sessionId, from);
  if (request.kind !== "ask") {
    failures.push(`expected the plan approval ask, got ${request.kind}`);
    return undefined;
  }
  const values = request.fields[0]?.choices?.map((c) => c.value).join("|");
  if (values !== "Approve and execute|Refine plan") failures.push(`choices: ${values}`);
  console.log(`  proposal: ${JSON.stringify(request.message.slice(0, 160))}`);
  const read = await ask("session.readPlan", { sessionId });
  console.log(
    `  readPlan: ${read.state}${read.state === "ok" ? ` ${read.file} (${read.content.length} chars)` : ""}`,
  );
  if (read.state !== "ok") failures.push(`the plan file was not found: ${JSON.stringify(read)}`);
  else if (read.content.trim() === "") failures.push("the plan file is empty");
  if (!(await planOf(sessionId)).enabled) failures.push("plan mode was off during the proposal");
  return request;
}

await scenario(
  "plan-toggle",
  "Count from 1 to 200, one number per line. No tools.",
  (vm) => (vm.plan.enabled ? ["plan mode should be off after turning it off"] : []),
  async (sessionId, from, failures) => {
    await until("plan mode on", () =>
      ops.some((o) => o.sessionId === sessionId && o.op.type === "plan.set" && o.op.plan.enabled),
    );
    if (!(await planOf(sessionId)).enabled)
      failures.push("the snapshot does not say plan mode is on");
    // The sidecar refuses a switch while the turn runs, in the direction that matters most here.
    const turn = (await ask("session.subscribe", { sessionId })).snapshot.status;
    if (turn === "streaming") {
      const refusal = await ask("session.setPlanMode", { sessionId, enabled: false }).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      console.log(`  switch during the turn: ${refusal ?? "ACCEPTED"}`);
      if (refusal !== "plan mode changes between turns") {
        failures.push(`a switch during the turn was not refused: ${refusal}`);
      }
      if (!(await planOf(sessionId)).enabled) failures.push("a refused switch changed the state");
    } else {
      console.log("  switch during the turn: not tried (the turn was already over)");
    }
    // In plan mode the agent works toward a proposal and does not end the turn by itself.
    await ask("session.cancel", { sessionId });
    await until("the turn to end", () => {
      const last = ops
        .slice(from)
        .filter((o) => o.sessionId === sessionId && o.op.type === "status.set")
        .at(-1);
      return last?.op.type === "status.set" && last.op.status !== "streaming";
    });
    await ask("session.setPlanMode", { sessionId, enabled: false });
    if ((await planOf(sessionId)).enabled) failures.push("the snapshot still says plan mode is on");
  },
  { before: planSetup },
);

await scenario(
  "plan-approve",
  planPrompt("approved.txt"),
  (vm) => [
    ...(vm.plan.enabled ? ["plan mode is still on after approving"] : []),
    ...(existsSync(target("approved.txt"))
      ? []
      : ["the work did not start: approved.txt was not created"]),
    ...(decided(vm).join() === "answered" ? [] : [`decisions: ${decided(vm).join() || "none"}`]),
    ...(vm.pending.length === 0 ? [] : ["a request is still pending"]),
  ],
  async (sessionId, from, failures) => {
    const request = await proposal(sessionId, from, failures);
    if (!request) return;
    await ask("session.answerAsk", {
      sessionId,
      requestId: request.id,
      action: "accept",
      content: { value: "Approve and execute" },
    });
    await until("plan mode to end", () =>
      ops
        .slice(from)
        .some((o) => o.sessionId === sessionId && o.op.type === "plan.set" && !o.op.plan.enabled),
    );
    console.log("  plan mode ended; waiting for the work to finish");
  },
  { before: planSetup },
);

await scenario(
  "plan-refine",
  planPrompt("refined.txt"),
  (vm) => [
    ...(vm.plan.enabled ? [] : ["plan mode ended after Refine plan"]),
    ...(existsSync(target("refined.txt"))
      ? ["the work started although the plan was only refined"]
      : []),
    ...(vm.status === "idle" ? [] : [`status is ${vm.status}, expected idle`]),
  ],
  async (sessionId, from, failures) => {
    const request = await proposal(sessionId, from, failures);
    if (!request) return;
    const after = ops.length;
    await ask("session.answerAsk", {
      sessionId,
      requestId: request.id,
      action: "accept",
      content: { value: "Refine plan" },
    });
    // The agent is told to update the plan and propose again: that second question is the proof
    // that plan mode survived. It is left unanswered and the turn is stopped.
    const again = await nextRequest(sessionId, after);
    if (again.kind !== "ask" || again.id === request.id)
      failures.push("no second proposal after Refine plan");
    console.log(
      `  second proposal: ${again.kind === "ask" ? JSON.stringify(again.message.slice(0, 100)) : again.kind}`,
    );
    await ask("session.cancel", { sessionId });
  },
  { before: planSetup },
);

// Cancelling the approval question is NOT the person stopping the agent, unlike the `ask` tool:
// omp reads a dismissed question as "Refine plan" and keeps plan mode, so the agent goes on and
// proposes again [V] acp-agent.ts:2400-2404. The turn is then stopped with session.cancel.
await scenario(
  "plan-cancel",
  planPrompt("cancelled.txt"),
  (vm) => [
    ...(vm.plan.enabled ? [] : ["plan mode ended after cancelling the question"]),
    ...(existsSync(target("cancelled.txt"))
      ? ["the work started although the question was cancelled"]
      : []),
    ...(vm.status === "idle" ? [] : [`status is ${vm.status}, expected idle`]),
    ...(vm.pending.length === 0 ? [] : ["a request is still pending"]),
  ],
  async (sessionId, from, failures) => {
    const request = await proposal(sessionId, from, failures);
    if (!request) return;
    const after = ops.length;
    await ask("session.answerAsk", { sessionId, requestId: request.id, action: "decline" });
    // The turn is still running and the agent asks again: that proves cancel was a refine.
    const again = await nextRequest(sessionId, after);
    if (again.kind !== "ask" || again.id === request.id)
      failures.push("no second proposal after cancelling the question");
    console.log(
      `  after cancel: ${again.kind === "ask" ? "the agent proposed again" : again.kind}`,
    );
    await ask("session.cancel", { sessionId });
  },
  { before: planSetup },
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
