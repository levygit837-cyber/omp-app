import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOp,
  decodeFrame,
  FrameDecoder,
  isEventEnvelope,
  isResponseEnvelope,
  RequestCorrelator,
  type SessionOpEvent,
  type SessionViewModel,
} from "@omp-app/protocol";

// The Electron smoke and the evidence runs use this fixture in place of omp, so its prompt
// controls have to follow the sidecar's contract: busy while a turn runs, steers that leave the
// queue and land as steered items, follow-ups that run after the turn.
setDefaultTimeout(30_000);

const fake = join(import.meta.dir, "fixtures/fake-sidecar.ts");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function connectToFake(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omp-app-fake-prompt-"));
  const socketPath = join(dir, "s.sock");
  const proc = Bun.spawn([process.execPath, fake, `--socket=${socketPath}`], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, FAKE_SIDECAR: "ok", FAKE_CHUNK_MS: "20", ...env },
  });
  cleanups.push(async () => {
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  });
  // `Bun.file().exists()` is false for a socket; `stat` is what answers.
  while (
    !(await Bun.file(socketPath)
      .stat()
      .then(
        () => true,
        () => false,
      ))
  )
    await Bun.sleep(20);

  const correlator = new RequestCorrelator();
  const decoder = new FrameDecoder();
  const ops: SessionOpEvent[] = [];
  const socket = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, chunk) {
        for (const line of decoder.push(new TextDecoder().decode(chunk))) {
          const frame = decodeFrame(line);
          if (!frame.ok) continue;
          if (isResponseEnvelope(frame.envelope)) correlator.receive(frame.envelope);
          else if (isEventEnvelope(frame.envelope)) ops.push(frame.envelope.data as SessionOpEvent);
        }
      },
    },
  });
  cleanups.push(() => void socket.end());
  const request = (method: string, params?: unknown) => {
    const { frame, response } = correlator.create(method as never, params as never);
    socket.write(frame);
    return response as Promise<Record<string, unknown>>;
  };
  await request("handshake");
  const { sessionId } = (await request("session.create", { cwd: "/work" })) as {
    sessionId: string;
  };
  const { snapshot } = (await request("session.subscribe", { sessionId })) as unknown as {
    snapshot: SessionViewModel;
  };
  const replica = () => ops.reduce((vm, o) => applyOp(vm, o.op), snapshot);
  const until = async (ready: (vm: SessionViewModel) => boolean) => {
    while (!ready(replica())) await Bun.sleep(10);
  };
  return { request, sessionId, replica, until, proc, ops };
}

test("model and thinking switch while idle, and are refused as busy during a turn", async () => {
  const c = await connectToFake({ FAKE_MODEL: "anthropic/claude-opus-5-5" });
  expect(c.replica().thinking).toBe("off");

  await c.request("session.setThinking", { sessionId: c.sessionId, level: "high" });
  await c.request("session.setModel", { sessionId: c.sessionId, model: "openai/gpt-5" });
  await c.until((vm) => vm.model === "openai/gpt-5");
  // The level survives a switch between models that both have a thinking control.
  expect(c.replica().thinking).toBe("high");
  await c.request("session.setModel", {
    sessionId: c.sessionId,
    model: "anthropic/claude-haiku-5-5",
  });
  await c.until((vm) => vm.model === "anthropic/claude-haiku-5-5");
  // A model without a thinking control has no level at all.
  expect(c.replica().thinking).toBeNull();

  await expect(
    c.request("session.setThinking", { sessionId: c.sessionId, level: "bogus" }),
  ).rejects.toThrow();
  await expect(
    c.request("session.setModel", { sessionId: c.sessionId, model: "nope/none" }),
  ).rejects.toThrow("unknown model");

  await c.request("session.prompt", { sessionId: c.sessionId, text: "go" });
  await c.until((vm) => vm.status === "streaming");
  await expect(
    c.request("session.setModel", { sessionId: c.sessionId, model: "openai/gpt-5" }),
  ).rejects.toThrow("session is busy");
  // The process survived all of the above.
  expect(c.proc.exitCode).toBeNull();
});

test("a steer leaves the queue as a steered item, a follow-up runs as its own turn", async () => {
  const c = await connectToFake({ FAKE_CHUNK_MS: "60" });
  await c.request("session.prompt", { sessionId: c.sessionId, text: "first" });
  await c.until((vm) => vm.status === "streaming");
  await c.request("session.prompt", {
    sessionId: c.sessionId,
    text: "later",
    delivery: "followUp",
  });
  await c.request("session.prompt", { sessionId: c.sessionId, text: "now" });
  await c.until((vm) => vm.timeline.some((i) => i.kind === "user" && i.text === "now"));
  // The held state is transient; the ops history is what proves it existed.
  const queues = c.ops.flatMap((o) => (o.op.type === "queue.set" ? [o.op.queue] : []));
  expect(queues.some((q) => q.steering.includes("now") && q.followUp.includes("later"))).toBe(true);
  expect(c.replica().queue.steering).toEqual([]);
  const steered = c.replica().timeline.find((i) => i.kind === "user" && i.text === "now");
  expect(steered).toMatchObject({ steered: true });

  await c.until((vm) => vm.timeline.some((i) => i.kind === "user" && i.text === "later"));
  const later = c.replica().timeline.find((i) => i.kind === "user" && i.text === "later");
  expect(later).not.toHaveProperty("steered");
  await c.until((vm) => vm.status === "idle" && vm.queue.followUp.length === 0);
});

test("a queued entry can be removed while it is held, once", async () => {
  const c = await connectToFake({ FAKE_CHUNK_MS: "60" });
  await c.request("session.prompt", { sessionId: c.sessionId, text: "first" });
  await c.until((vm) => vm.status === "streaming");
  await c.request("session.prompt", {
    sessionId: c.sessionId,
    text: "later",
    delivery: "followUp",
  });
  await c.until((vm) => vm.queue.followUp.length === 1);
  const args = { sessionId: c.sessionId, queue: "followUp", text: "later" };
  expect(await c.request("session.removeQueued", args)).toEqual({ removed: true });
  expect(await c.request("session.removeQueued", args)).toEqual({ removed: false });
  await c.until((vm) => vm.queue.followUp.length === 0);
});

test("models are empty without credentials, and files filter by the query", async () => {
  const c = await connectToFake({ FAKE_MODELS: "none", FAKE_FILES: "a.ts,src/b.ts" });
  expect(await c.request("session.models", { sessionId: c.sessionId })).toEqual({ models: [] });
  expect(await c.request("session.files", { sessionId: c.sessionId, query: "b" })).toEqual({
    files: ["src/b.ts"],
  });
});
