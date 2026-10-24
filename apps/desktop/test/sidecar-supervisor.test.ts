import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { SidecarSupervisor } from "../src/main/sidecar-supervisor";
import type { SidecarStatus } from "../src/shared/bridge";

setDefaultTimeout(90_000);

const sidecarEntry = join(import.meta.dir, "../../../packages/sidecar/src/main.ts");
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
    expect(ready.ompVersion).toBe("18.12.6");
    expect(ready.sidecarVersion).toBe("0.0.0");
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
    expect(ready.ompVersion).toBe("18.12.6");
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
    expect(failed.logTail).toEqual(["line one", "boom: bad config"]);
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
