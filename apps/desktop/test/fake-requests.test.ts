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
  STALE_REQUEST_MESSAGE,
} from "@omp-app/protocol";

// The evidence runs and the Electron smoke use this fixture in place of omp, so what it serves
// has to follow the protocol the way the real sidecar does: this drives it over a real socket.
setDefaultTimeout(30_000);

const fake = join(import.meta.dir, "fixtures/fake-sidecar.ts");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function connectToFake(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "omp-app-fake-req-"));
  const socketPath = join(dir, "s.sock");
  const proc = Bun.spawn([process.execPath, fake, `--socket=${socketPath}`], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, FAKE_SIDECAR: "ok", FAKE_REQUEST: script, FAKE_CHUNK_MS: "1" },
  });
  cleanups.push(async () => {
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  });
  const listening = async () => {
    while (
      !(await Bun.file(socketPath)
        .stat()
        .then(
          () => true,
          () => false,
        ))
    )
      await Bun.sleep(20);
  };
  await listening();

  const correlator = new RequestCorrelator();
  const decoder = new FrameDecoder();
  const ops: SessionOpEvent[] = [];
  const waiters = new Set<() => void>();
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
        for (const wake of waiters) wake();
      },
    },
  });
  cleanups.push(() => void socket.end());
  return {
    ops,
    request: <M extends Parameters<RequestCorrelator["create"]>[0]>(
      method: M,
      params?: Parameters<RequestCorrelator["create"]>[1],
    ) => {
      const { frame, response } = correlator.create(method, params as never);
      socket.write(frame);
      return response as Promise<Record<string, never>>;
    },
    /** Resolves once `ready()` holds, re-checking on every frame that arrives. */
    async until(ready: () => boolean) {
      while (!ready()) {
        const { promise, resolve } = Promise.withResolvers<void>();
        waiters.add(resolve);
        await promise;
        waiters.delete(resolve);
      }
    },
  };
}

test("the fake raises a permission, survives a reload, refuses a stale answer and settles with a decision line", async () => {
  const c = await connectToFake("permission");
  await c.request("handshake");
  const { sessionId } = (await c.request("session.create", { cwd: "/work" })) as unknown as {
    sessionId: string;
  };
  const first = (await c.request("session.subscribe", { sessionId })) as unknown as {
    snapshot: SessionViewModel;
  };
  await c.request("session.prompt", { sessionId, text: "go" });
  await c.until(() => c.ops.some((o) => o.op.type === "request.add"));

  // A window that reloads subscribes again and finds the request in the snapshot.
  const again = (await c.request("session.subscribe", { sessionId })) as unknown as {
    snapshot: SessionViewModel;
  };
  expect(again.snapshot.pending).toHaveLength(1);
  const [request] = again.snapshot.pending;
  expect(request).toMatchObject({ kind: "permission", toolKind: "execute", paths: [] });

  await expect(
    c.request("session.answerPermission", { sessionId, requestId: "nope", optionId: "allow_once" }),
  ).rejects.toThrow(STALE_REQUEST_MESSAGE);

  await c.request("session.answerPermission", {
    sessionId,
    requestId: request?.id ?? "",
    optionId: "reject_once",
  });
  await c.until(() => c.ops.some((o) => o.op.type === "status.set" && o.op.status === "idle"));

  const replica = c.ops.reduce((vm, o) => applyOp(vm, o.op), first.snapshot);
  expect(replica.pending).toEqual([]);
  expect(replica.timeline.find((i) => i.kind === "decision")).toMatchObject({
    outcome: "rejected_once",
    toolKind: "execute",
  });
});
