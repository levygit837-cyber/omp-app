import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { dirname, join } from "node:path";
import sidecarPkg from "../../../packages/sidecar/package.json" with { type: "json" };
import { SidecarSupervisor } from "../src/main/sidecar-supervisor";
import type { SidecarStatus } from "../src/shared/bridge";

setDefaultTimeout(90_000);

const sidecarEntry = join(import.meta.dir, "../../../packages/sidecar/src/main.ts");
const fakeSidecar = join(import.meta.dir, "fixtures/fake-sidecar.ts");

/** The omp version installed for the sidecar, read from its package.json on disk. */
async function installedOmpVersion(): Promise<string> {
  const index = Bun.fileURLToPath(
    import.meta.resolve("@oh-my-pi/pi-coding-agent", join(dirname(sidecarEntry), "x.ts")),
  );
  return (await Bun.file(join(dirname(index), "..", "package.json")).json()).version;
}
const supervisors: SidecarSupervisor[] = [];

function supervise(command: string, args: string[] = []): SidecarSupervisor {
  const s = new SidecarSupervisor({ command, args, startTimeoutMs: 60_000, killGraceMs: 2_000 });
  supervisors.push(s);
  return s;
}

/** Resolves with the first status satisfying `pred` (checking the current one first). */
function until<S extends SidecarStatus["state"]>(
  s: SidecarSupervisor,
  state: S,
): Promise<Extract<SidecarStatus, { state: S }>> {
  return new Promise((resolve) => {
    const check = (status: SidecarStatus) => {
      if (status.state !== state) return false;
      off();
      resolve(status as Extract<SidecarStatus, { state: S }>);
      return true;
    };
    const off = s.onStatus(check);
    check(s.status);
  });
}

async function pidsOf(pattern: string): Promise<number[]> {
  const out = Bun.spawnSync(["pgrep", "-f", pattern]).stdout.toString();
  return out.split("\n").filter(Boolean).map(Number);
}

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((s) => s.stop()));
});

describe("SidecarSupervisor with the real sidecar", () => {
  test("reaches ready with the installed omp version", async () => {
    const s = supervise(process.execPath, [sidecarEntry]);
    await s.start();
    const ready = await until(s, "ready");
    expect(ready.ompVersion).toBe(await installedOmpVersion());
    expect(ready.sidecarVersion).toBe(sidecarPkg.version);
  });

  test("detects an external kill, then restart brings a fresh sidecar", async () => {
    const s = supervise(process.execPath, [sidecarEntry]);
    await s.start();
    await until(s, "ready");
    const [pid] = await pidsOf(`${sidecarEntry} --socket=`);
    expect(pid).toBeGreaterThan(0);

    process.kill(pid as number, "SIGKILL");
    const failed = await until(s, "failed");
    expect(failed.error).toContain("exited unexpectedly");

    await s.restart();
    const ready = await until(s, "ready");
    expect(ready.ompVersion).toBe(await installedOmpVersion());
    const [newPid] = await pidsOf(`${sidecarEntry} --socket=`);
    expect(newPid).not.toBe(pid);
  });

  test("stop leaves no sidecar process behind", async () => {
    const s = supervise(process.execPath, [sidecarEntry]);
    await s.start();
    await until(s, "ready");
    expect((await pidsOf(`${sidecarEntry} --socket=`)).length).toBeGreaterThan(0);

    await s.stop();

    expect(await pidsOf(`${sidecarEntry} --socket=`)).toEqual([]);
  });
});

describe("SidecarSupervisor failure reporting", () => {
  test("a sidecar that dies on startup reports the exit and its last output", async () => {
    const s = supervise("/bin/sh", [
      "-c",
      'echo "line one"; echo "boom: bad config" >&2; exit 3',
      "sh",
    ]);
    await s.start();

    const failed = await until(s, "failed");

    expect(failed.error).toContain("code 3");
    // stdout and stderr are separate pipes: their relative order is not guaranteed.
    expect([...failed.logTail].sort()).toEqual(["boom: bad config", "line one"]);
  });

  test("a missing binary reports why it could not start", async () => {
    const s = supervise("/nonexistent/omp-app-sidecar");
    await s.start();

    const failed = await until(s, "failed");

    expect(failed.error).toContain("cannot start sidecar");
  });

  test("a process that never listens fails by timeout instead of hanging", async () => {
    const s = new SidecarSupervisor({
      command: "/bin/sh",
      args: ["-c", "sleep 30", "sh"],
      startTimeoutMs: 600,
      killGraceMs: 500,
    });
    supervisors.push(s);
    await s.start();

    const failed = await until(s, "failed");

    expect(failed.error).toContain("timed out");
  });
});

/** Polls until `check` is true; a failed child is killed asynchronously, so counts settle. */
async function eventually(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(25);
  }
}

const fakePattern = `${fakeSidecar} --socket=`;
const liveFakes = () => pidsOf(fakePattern);
const noFakes = () => eventually(async () => (await liveFakes()).length === 0, "no live child");

function superviseFake(
  mode: string,
  extra: Partial<ConstructorParameters<typeof SidecarSupervisor>[0]> = {},
) {
  const s = new SidecarSupervisor({
    command: process.execPath,
    args: [fakeSidecar],
    env: { ...process.env, FAKE_SIDECAR: mode },
    startTimeoutMs: 10_000,
    killGraceMs: 2_000,
    ...extra,
  });
  supervisors.push(s);
  return s;
}

describe("SidecarSupervisor lifecycle", () => {
  test("two concurrent restarts end with exactly one live child, ready", async () => {
    const s = superviseFake("ok");
    await s.start();
    await until(s, "ready");
    const [first] = await liveFakes();

    await Promise.all([s.restart(), s.restart()]);
    await until(s, "ready");

    const pids = await liveFakes();
    expect(pids).toHaveLength(1);
    expect(pids[0]).not.toBe(first);
  });

  test("ready carries the read-only mode and both schema versions", async () => {
    const s = superviseFake("read-only");
    await s.start();

    const ready = await until(s, "ready");

    expect(ready.mode).toBe("read_only");
    expect(ready.schema).toEqual({ onDisk: 7, expected: 6 });
  });

  test("ready in normal mode carries no schema", async () => {
    const s = superviseFake("ok");
    await s.start();

    const ready = await until(s, "ready");

    expect(ready.mode).toBe("normal");
    expect(ready.schema).toBeUndefined();
  });

  test("a restart issued while starting replaces the child instead of adding one", async () => {
    const s = superviseFake("slow"); // listens only after 600 ms: still starting when restarted
    await s.start();
    expect(s.status.state).toBe("starting");

    await s.restart();
    await until(s, "ready");

    expect(await liveFakes()).toHaveLength(1);
  });

  test("stop while starting leaves no child and the aborted run never reports an outcome", async () => {
    const s = superviseFake("slow");
    const seen: string[] = [];
    s.onStatus((status) => seen.push(status.state));
    await s.start();

    await s.stop();
    await Bun.sleep(1_500); // longer than the child's startup delay and the connect retry

    expect(await liveFakes()).toEqual([]);
    expect(seen).toEqual(["starting"]);
    expect(s.status.state).toBe("starting");
  });

  test("calling start twice does not orphan the first child", async () => {
    const s = superviseFake("ok");
    await Promise.all([s.start(), s.start()]);
    await until(s, "ready");
    await s.start(); // once more, now that it is ready

    expect(await liveFakes()).toHaveLength(1);
    await s.stop();
    expect(await liveFakes()).toEqual([]);
  });

  test("start works again after stop", async () => {
    const s = superviseFake("ok");
    await s.start();
    await until(s, "ready");
    await s.stop();
    expect(await liveFakes()).toEqual([]);

    await s.start();
    await until(s, "ready");

    expect(await liveFakes()).toHaveLength(1);
  });

  test("a handshake that never gets answered fails by timeout and kills the child", async () => {
    const s = superviseFake("silent", { startTimeoutMs: 800 });
    await s.start();

    const failed = await until(s, "failed");

    expect(failed.error).toContain("did not answer the handshake in time");
    await noFakes();
  });

  test("a sidecar speaking another protocol version is refused", async () => {
    const s = superviseFake("old-protocol");
    await s.start();

    const failed = await until(s, "failed");

    expect(failed.error).toContain("protocol");
    await noFakes();
  });

  test("restart after a failure launches a new child and goes back to starting", async () => {
    const s = superviseFake("silent", { startTimeoutMs: 500 });
    await s.start();
    await until(s, "failed");
    await noFakes();

    await s.restart();

    expect(s.status.state).toBe("starting");
    expect(await liveFakes()).toHaveLength(1);
    const failedAgain = await until(s, "failed");
    expect(failedAgain.error).toContain("did not answer the handshake in time");
    await noFakes();
  });
});
