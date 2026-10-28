import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { LIVE_PROJECT_PREFIX, ownsLiveSessionDir, stopThenClean } from "../scripts/live-cleanup";

let root: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-cleanup-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

// omp's own answer for the session directory of a folder, under a throwaway sessions root.
const dirOf = (cwd: string) => SessionManager.getDefaultSessionDir(cwd, join(root, "agent"));

test("the directory omp makes for a temp project is recognised, in the temp-root form", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), LIVE_PROJECT_PREFIX)));
  try {
    expect(dirOf(cwd)).toContain("-tmp-");
    expect(ownsLiveSessionDir(dirOf(cwd), cwd)).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("and in the form omp gives a folder outside the temp root and home (`--path--`)", () => {
  // The folder need not exist for omp to name its directory; this one is outside both roots.
  const cwd = join("/opt", `${LIVE_PROJECT_PREFIX}AbC123`);
  const dir = dirOf(cwd);
  expect(dir.split("/").at(-1)).toStartWith("--");
  expect(ownsLiveSessionDir(dir, cwd)).toBe(true);
});

test("the sessions of another folder are never claimed, however alike the name", () => {
  const mine = join(root, `${LIVE_PROJECT_PREFIX}AbC12`);
  mkdirSync(mine, { recursive: true });
  for (const other of [
    join(root, `${LIVE_PROJECT_PREFIX}ZzZ999`),
    join(root, "my-real-project"),
    // ends in this run's folder name plus more: a longer name is another folder
    join(root, `${LIVE_PROJECT_PREFIX}AbC12x`),
  ]) {
    mkdirSync(other, { recursive: true });
    expect(ownsLiveSessionDir(dirOf(other), mine)).toBe(false);
  }
});

test("a folder that is not a live project is never cleaned, even for its own directory", () => {
  const cwd = join(root, "my-real-project");
  mkdirSync(cwd, { recursive: true });
  expect(ownsLiveSessionDir(dirOf(cwd), cwd)).toBe(false);
});

test("the folders are removed only after the sidecar has exited", async () => {
  const events: string[] = [];
  const exit = Promise.withResolvers<void>();
  const done = stopThenClean({
    stop: () => events.push("stop"),
    exited: exit.promise,
    clean: () => events.push("clean"),
    waitMs: 5_000,
  });
  await Bun.sleep(30);
  // The sidecar is still shutting down (it writes its session file now): nothing is removed yet.
  expect(events).toEqual(["stop"]);
  events.push("sidecar wrote its session file");
  exit.resolve();
  expect(await done).toBe("exited");
  expect(events).toEqual(["stop", "sidecar wrote its session file", "clean"]);
});

test("a sidecar that never exits does not hold the cleanup back for good", async () => {
  const events: string[] = [];
  const outcome = await stopThenClean({
    stop: () => events.push("stop"),
    exited: new Promise(() => {}),
    clean: () => events.push("clean"),
    waitMs: 40,
  });
  expect(outcome).toBe("timed_out");
  expect(events).toEqual(["stop", "clean"]);
});

test("the folders are removed even when waiting for the sidecar fails", async () => {
  const events: string[] = [];
  await expect(
    stopThenClean({
      stop: () => {},
      exited: Promise.reject(new Error("gone")),
      clean: () => events.push("clean"),
      waitMs: 1_000,
    }),
  ).rejects.toThrow("gone");
  expect(events).toEqual(["clean"]);
});
