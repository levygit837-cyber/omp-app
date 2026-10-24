import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeRuntimeDir } from "../src/runtime-dir";

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "runtime-dir-test-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("removeRuntimeDir", () => {
  test("removes the whole per-launch dir, including leftovers next to the socket", () => {
    const dir = join(root(), "omp-app-4242-AbCdEf");
    mkdirSync(dir);
    writeFileSync(join(dir, "s.sock"), "");
    writeFileSync(join(dir, "leftover"), "");

    removeRuntimeDir(join(dir, "s.sock"));

    expect(existsSync(dir)).toBe(false);
  });

  test("leaves a directory that is not a per-launch dir alone and removes only the socket", () => {
    const dir = join(root(), "somewhere-else");
    mkdirSync(dir);
    writeFileSync(join(dir, "s.sock"), "");
    writeFileSync(join(dir, "precious"), "");

    removeRuntimeDir(join(dir, "s.sock"));

    expect(existsSync(join(dir, "s.sock"))).toBe(false);
    expect(existsSync(join(dir, "precious"))).toBe(true);
  });

  test("does not treat a lookalike name as a per-launch dir", () => {
    const dir = join(root(), "omp-app-test-xyz");
    mkdirSync(dir);
    writeFileSync(join(dir, "keep"), "");

    removeRuntimeDir(join(dir, "s.sock"));

    expect(existsSync(join(dir, "keep"))).toBe(true);
  });
});
