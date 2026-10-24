import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeDir, sweepStaleRuntimeDirs } from "../src/main/runtime-dirs";

const bases: string[] = [];
function base(): string {
  const dir = mkdtempSync(join(tmpdir(), "runtime-dirs-test-"));
  bases.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of bases.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DEAD = 2_000_000_000; // above any real pid
const dead = (pid: number) => pid === DEAD;

describe("sweepStaleRuntimeDirs", () => {
  test("removes dirs of dead app instances and keeps those of live ones", () => {
    const root = base();
    const stale = join(root, `omp-app-${DEAD}-abc`);
    const live = join(root, "omp-app-1-abc");
    for (const d of [stale, live]) {
      mkdirSync(d);
      writeFileSync(join(d, "s.sock"), "");
    }

    const removed = sweepStaleRuntimeDirs({
      base: root,
      isAlive: (pid) => !dead(pid),
    });

    expect(removed).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  test("never removes the dir of the current process", () => {
    const root = base();
    const mine = createRuntimeDir(root);

    sweepStaleRuntimeDirs({ base: root, isAlive: () => false });

    expect(existsSync(mine)).toBe(true);
  });

  test("ignores names that are not runtime dirs and dirs owned by someone else", () => {
    const root = base();
    const other = join(root, "unrelated");
    const lookalike = join(root, "omp-app-test-xyz");
    const foreign = join(root, `omp-app-${DEAD}-foreign`);
    for (const d of [other, lookalike, foreign]) mkdirSync(d);

    const removed = sweepStaleRuntimeDirs({
      base: root,
      isAlive: dead,
      uid: (process.getuid?.() ?? 0) + 1,
    });

    expect(removed).toEqual([]);
    for (const d of [other, lookalike, foreign]) expect(existsSync(d)).toBe(true);
  });

  test("does not follow a symlink named like a runtime dir", () => {
    const root = base();
    const target = join(root, "precious");
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "");
    symlinkSync(target, join(root, `omp-app-${DEAD}-link`));

    sweepStaleRuntimeDirs({ base: root, isAlive: dead });

    expect(existsSync(join(target, "keep"))).toBe(true);
  });
});
