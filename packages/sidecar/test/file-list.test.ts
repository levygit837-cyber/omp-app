import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FILE_MATCHES } from "@omp-app/protocol";
import { listFiles, scoreMatch } from "../src/file-list";

let base: string;
let root: string;
let outside: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "file-list-"));
  root = join(base, "project");
  outside = join(base, "outside");
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "README.md"), "");
  writeFileSync(join(root, "src", "index.ts"), "");
  writeFileSync(join(root, "src", "deep", "server.ts"), "");
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "");
  writeFileSync(join(root, ".env"), "");
  writeFileSync(join(root, ".git", "config"), "");
  writeFileSync(join(outside, "secret.txt"), "");
  symlinkSync(outside, join(root, "escape"));
  symlinkSync(join(outside, "secret.txt"), join(root, "secret-link.txt"));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("listFiles", () => {
  test("lists files and folders relative to the root, folders ending in a slash", async () => {
    const all = (await listFiles(root, "")).files;
    expect(all).toContain("README.md");
    expect(all).toContain("src/");
    expect(all).toContain("src/deep/server.ts");
  });

  test("never follows or lists a symbolic link, so nothing outside the root appears", async () => {
    const everything = (await listFiles(root, "")).files;
    expect(everything.some((path) => path.includes("escape"))).toBe(false);
    expect(everything.some((path) => path.includes("secret"))).toBe(false);
    expect((await listFiles(root, "secret")).files).toEqual([]);
    expect((await listFiles(root, "escape/")).files).toEqual([]);
  });

  test("a query that climbs out of the root matches nothing outside it", async () => {
    expect((await listFiles(root, "../outside/secret")).files).toEqual([]);
    expect((await listFiles(root, "/etc/passwd")).files).toEqual([]);
  });

  test("skips node_modules and .git, and hides dot files unless the query starts with a dot", async () => {
    const plain = (await listFiles(root, "")).files;
    expect(plain.some((path) => path.startsWith("node_modules"))).toBe(false);
    expect(plain).not.toContain(".env");
    expect((await listFiles(root, ".env")).files).toEqual([".env"]);
    expect((await listFiles(root, ".")).files.some((path) => path.startsWith(".git"))).toBe(false);
  });

  test("ranks the file name match above a match in a folder name", async () => {
    const found = (await listFiles(root, "server")).files;
    expect(found[0]).toBe("src/deep/server.ts");
  });

  test("bounds the number of matches", async () => {
    const crowded = join(base, "crowded");
    mkdirSync(crowded);
    for (let i = 0; i < MAX_FILE_MATCHES + 25; i++) writeFileSync(join(crowded, `f${i}.txt`), "");
    expect((await listFiles(crowded, "")).files.length).toBe(MAX_FILE_MATCHES);
  });

  test("a root that does not exist lists nothing", async () => {
    expect((await listFiles(join(base, "missing"), "")).files).toEqual([]);
  });
});

describe("scoreMatch", () => {
  test("null when the query characters do not appear in order", () => {
    expect(scoreMatch("src/index.ts", "xyz")).toBeNull();
    expect(scoreMatch("src/index.ts", "tsi")).toBeNull();
  });

  test("a contiguous match in the file name beats a scattered one", () => {
    const name = scoreMatch("src/main.ts", "main");
    const scattered = scoreMatch("m/a/i/n/x.ts", "main");
    expect(name).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(name as number).toBeGreaterThan(scattered as number);
  });

  test("is case-insensitive and prefers the shorter path", () => {
    const short = scoreMatch("a/Readme.md", "readme") as number;
    const long = scoreMatch("a/b/c/d/Readme.md", "readme") as number;
    expect(short).toBeGreaterThan(long);
  });
});

const FILES_PER_BULK_DIR = 500;

/**
 * Writes `count` empty files named `f<i>.txt` spread over nested directories under `dir`, all
 * at the same depth. Returns a directory one level below them, which a breadth-first walk
 * cannot reach once those files have used up its budget.
 */
function writeMany(dir: string, count: number): string {
  for (let d = 0; d * FILES_PER_BULK_DIR < count; d++) {
    const leaf = join(dir, `g${d % 10}`, `h${d}`);
    mkdirSync(leaf, { recursive: true });
    const end = Math.min(count, (d + 1) * FILES_PER_BULK_DIR);
    for (let i = d * FILES_PER_BULK_DIR; i < end; i++) writeFileSync(join(leaf, `f${i}.txt`), "");
  }
  const deeper = join(dir, "g0", "h0", "below");
  mkdirSync(deeper);
  return deeper;
}

const isolatedGitEnv = {
  PATH: process.env.PATH ?? "",
  HOME: tmpdir(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

describe("listFiles on a big tree", () => {
  let big: string;
  let repo: string;
  let plain: string;

  beforeAll(() => {
    big = mkdtempSync(join(tmpdir(), "file-list-big-"));
    repo = join(big, "repo");
    plain = join(big, "plain");
    const last = writeMany(repo, 26_000);
    writeFileSync(join(last, "needle-target.txt"), "");
    writeFileSync(join(repo, ".gitignore"), "dist/\n");
    writeMany(join(repo, "dist"), 25_000);
    writeFileSync(join(repo, "dist", "needle-ignored.txt"), "");
    symlinkSync(join(repo, "g0"), join(repo, "needle-dir-link"));
    symlinkSync(join(repo, ".gitignore"), join(repo, "needle-file-link"));
    const init = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: isolatedGitEnv });
    if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
    // Track the links too: `ls-files` reports tracked symbolic links as ordinary entries.
    const add = spawnSync("git", ["add", "needle-dir-link", "needle-file-link"], {
      cwd: repo,
      env: isolatedGitEnv,
    });
    if (add.status !== 0) throw new Error(`git add failed: ${add.stderr}`);

    const plainLast = writeMany(plain, 26_000);
    writeFileSync(join(plainLast, "needle-target.txt"), "");
  }, 60_000);

  afterAll(() => rmSync(big, { recursive: true, force: true }));

  test("in a git repository a file below the walk budget is found, ignored files are not", async () => {
    const result = await listFiles(repo, "needle");
    expect(result.files.filter((path) => path.endsWith("needle-target.txt")).length).toBe(1);
    expect(result.files.some((path) => path.startsWith("dist/"))).toBe(false);
    expect(result.files.some((path) => path.includes("needle-ignored"))).toBe(false);
    expect(result.truncated).toBe(false);
  }, 30_000);

  test("a symbolic link tracked by git never appears", async () => {
    const result = await listFiles(repo, "needle");
    expect(result.files.some((path) => path.includes("link"))).toBe(false);
    expect((await listFiles(repo, "needle-dir-link")).files).toEqual([]);
  }, 30_000);

  test("without git the walk reports that it stopped early for a match past its budget", async () => {
    const result = await listFiles(plain, "needle-target");
    expect(result.truncated).toBe(true);
    expect(result.files).toEqual([]);
  }, 30_000);

  test("a small tree is not truncated", async () => {
    expect((await listFiles(root, "")).truncated).toBe(false);
  });
});
