import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FilesDiffResult,
  type FilesReadResult,
  type FilesStatusResult,
  type FilesTreeResult,
  MAX_FILE_BYTES,
  MAX_FILE_PATH_CHARS,
} from "@omp-app/protocol";
import { filesHandlers } from "../src/files-handlers";
import { emptyViewModel } from "../src/reducer";
import { SessionStore } from "../src/session-store";

const client = { emit: () => {} };

let base: string;
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-files-")));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;
const gitEnv = {
  PATH: process.env.PATH ?? "",
  HOME: "/nonexistent",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

/** Plain git for fixtures: the test builds the repository, the code under test never writes. */
function git(cwd: string, ...args: string[]): string {
  const out = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
  if (out.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr.toString()}`);
  return out.stdout.toString();
}

/** A fresh folder (a repository when `repo`), with a session whose cwd it is. */
function project(repo = true) {
  const dir = join(base, `p${counter++}`);
  mkdirSync(dir, { recursive: true });
  if (repo) git(dir, "init", "-q", "-b", "main");
  return dir;
}

function open(cwd: string) {
  const store = new SessionStore();
  store.create(emptyViewModel({ id: "s1", cwd, model: "p/m" }));
  const handlers = filesHandlers({ cwdOf: () => cwd }, store);
  return {
    store,
    status: (): Promise<FilesStatusResult> => handlers["files.status"]({ sessionId: "s1" }, client),
    tree: (path = ""): Promise<FilesTreeResult> =>
      handlers["files.tree"]({ sessionId: "s1", path }, client),
    read: (path: string): Promise<FilesReadResult> =>
      handlers["files.read"]({ sessionId: "s1", path }, client),
    diff: (path: string): Promise<FilesDiffResult> =>
      handlers["files.diff"]({ sessionId: "s1", path }, client),
  };
}

const write = (dir: string, path: string, text: string | Uint8Array) => {
  const full = join(dir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
};

function commitAll(dir: string, message = "c") {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

function okStatus(result: FilesStatusResult) {
  if (result.state !== "ok") throw new Error(`status was ${result.state}`);
  return result;
}

describe("files.status", () => {
  test("reports the branch, ahead of its upstream, and every kind of change", async () => {
    const remote = join(base, `remote${counter++}`);
    mkdirSync(remote);
    git(remote, "init", "-q", "--bare", "-b", "main");
    const dir = project();
    write(dir, "kept.txt", "one\ntwo\n");
    write(dir, "gone.txt", "bye\n");
    write(dir, "old-name.txt", "rename me please, a few lines\nof text\nso git sees it\n");
    write(dir, "ignored.log", "x");
    write(dir, ".gitignore", "*.log\n");
    commitAll(dir);
    git(dir, "remote", "add", "origin", remote);
    git(dir, "push", "-q", "-u", "origin", "main");
    write(dir, "second.txt", "2\n");
    commitAll(dir, "second");

    write(dir, "kept.txt", "one\nTWO\nthree\n");
    rmSync(join(dir, "gone.txt"));
    git(dir, "mv", "old-name.txt", "new-name.txt");
    write(dir, "fresh.txt", "a\nb\n");
    git(dir, "add", "fresh.txt");
    write(dir, "untracked.txt", "u1\nu2\nu3\n");

    const status = okStatus(await open(dir).status());
    expect(status.branch).toMatchObject({
      name: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
    });
    const byPath = Object.fromEntries(status.changes.map((c) => [c.path, c]));
    expect(byPath["kept.txt"]).toMatchObject({ status: "M", added: 2, removed: 1 });
    expect(byPath["gone.txt"]).toMatchObject({ status: "D", added: 0, removed: 1 });
    expect(byPath["new-name.txt"]).toMatchObject({ status: "R", from: "old-name.txt" });
    expect(byPath["fresh.txt"]).toMatchObject({ status: "A", added: 2, removed: 0 });
    expect(byPath["untracked.txt"]).toMatchObject({ status: "?", added: 3, removed: 0 });
    expect(byPath["ignored.log"]).toBeUndefined();
    expect(status.totals).toEqual({ added: 2, modified: 2, deleted: 1 });
    expect(status.truncated).toBe(false);
  });

  test("a conflicted file is reported as U", async () => {
    const dir = project();
    write(dir, "f.txt", "base\n");
    commitAll(dir);
    git(dir, "checkout", "-q", "-b", "other");
    write(dir, "f.txt", "other\n");
    commitAll(dir, "other");
    git(dir, "checkout", "-q", "main");
    write(dir, "f.txt", "main\n");
    commitAll(dir, "main");
    Bun.spawnSync(["git", "merge", "other"], { cwd: dir, env: gitEnv });
    const status = okStatus(await open(dir).status());
    expect(status.changes.find((c) => c.path === "f.txt")?.status).toBe("U");
  });

  test("a fresh repository with no commit lists everything as untracked, with no head", async () => {
    const dir = project();
    write(dir, "a.txt", "x\n");
    const status = okStatus(await open(dir).status());
    expect(status.branch).toMatchObject({ name: "main", head: null, upstream: null });
    expect(status.changes.map((c) => c.status)).toEqual(["?"]);
  });

  test("a detached head has no branch name", async () => {
    const dir = project();
    write(dir, "a.txt", "x\n");
    commitAll(dir);
    git(dir, "checkout", "-q", "--detach");
    const status = okStatus(await open(dir).status());
    expect(status.branch.name).toBeNull();
    expect(status.branch.head).toHaveLength(7);
  });

  test("names with spaces, unicode, a newline and a leading dash come back as they are", async () => {
    const dir = project();
    const names = ["with space.txt", "ação-é.txt", "line\nbreak.txt", "-dash.txt", "a'quote\".txt"];
    for (const name of names) write(dir, name, "x\n");
    const status = okStatus(await open(dir).status());
    expect(status.changes.map((c) => c.path).sort()).toEqual([...names].sort());
  });

  test("from a subfolder of the repository, paths are relative to the session folder", async () => {
    const dir = project();
    write(dir, "top.txt", "t\n");
    write(dir, "pkg/app/in.txt", "i\n");
    commitAll(dir);
    write(dir, "top.txt", "t2\n");
    write(dir, "pkg/app/in.txt", "i2\n");
    write(dir, "pkg/app/new.txt", "n\n");
    const status = okStatus(await open(join(dir, "pkg/app")).status());
    expect(status.changes.map((c) => c.path)).toEqual(["in.txt", "new.txt"]);
    expect(status.changes.map((c) => c.status)).toEqual(["M", "?"]);
    expect(status.changes[0]).toMatchObject({ added: 1, removed: 1 });
  });

  test("a folder that is not a repository, and one that is gone", async () => {
    const plain = project(false);
    write(plain, "a.txt", "x");
    expect(await open(plain).status()).toEqual({ state: "not_repo" });
    const gone = project(false);
    const session = open(gone);
    rmSync(gone, { recursive: true });
    expect(await session.status()).toEqual({ state: "missing" });
  });

  test("a binary change has no line counts", async () => {
    const dir = project();
    write(dir, "b.bin", new Uint8Array([0, 1, 2, 3]));
    commitAll(dir);
    write(dir, "b.bin", new Uint8Array([0, 9, 9, 9, 9]));
    const status = okStatus(await open(dir).status());
    expect(status.changes[0]).toMatchObject({
      status: "M",
      added: null,
      removed: null,
      binary: true,
    });
  });

  test("a session that is gone is an unknown session", async () => {
    const dir = project();
    const session = open(dir);
    session.store.remove("s1");
    await expect(session.status()).rejects.toThrow("unknown session");
  });
});

describe("files.tree", () => {
  test("lists folders first, then files; ignored files and .git stay out", async () => {
    const dir = project();
    write(dir, "src/a.ts", "a");
    write(dir, "src/deep/b.ts", "b");
    write(dir, "z.txt", "z");
    write(dir, "a.txt", "a");
    write(dir, "skip.log", "x");
    write(dir, ".gitignore", "*.log\nbuild/\n");
    write(dir, "build/out.js", "o");
    const session = open(dir);
    const root = await session.tree();
    expect(root).toEqual({
      state: "ok",
      truncated: false,
      entries: [
        { name: "src", kind: "dir" },
        { name: ".gitignore", kind: "file" },
        { name: "a.txt", kind: "file" },
        { name: "z.txt", kind: "file" },
      ],
    });
    const src = await session.tree("src");
    expect(src).toMatchObject({
      state: "ok",
      entries: [
        { name: "deep", kind: "dir" },
        { name: "a.ts", kind: "file" },
      ],
    });
  });

  test("outside a repository the folder is listed as it is, without .git or links", async () => {
    const dir = project(false);
    write(dir, "a.txt", "a");
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "d"));
    symlinkSync("/etc", join(dir, "link"));
    const tree = await open(dir).tree();
    expect(tree).toMatchObject({
      state: "ok",
      entries: [
        { name: "d", kind: "dir" },
        { name: "a.txt", kind: "file" },
      ],
    });
  });

  test("a tracked file deleted from disk, and a tracked symlink, are not listed", async () => {
    const dir = project();
    write(dir, "real.txt", "r");
    write(dir, "gone.txt", "g");
    symlinkSync("/etc/hosts", join(dir, "link.txt"));
    commitAll(dir);
    rmSync(join(dir, "gone.txt"));
    const tree = await open(dir).tree();
    expect(tree).toMatchObject({ state: "ok", entries: [{ name: "real.txt", kind: "file" }] });
  });

  test("a folder that is gone, a file, and traversal are told apart", async () => {
    const dir = project();
    write(dir, "f.txt", "f");
    const session = open(dir);
    expect(await session.tree("nope")).toEqual({ state: "missing" });
    expect(await session.tree("f.txt")).toEqual({ state: "refused", reason: "not_a_file" });
    for (const bad of ["..", "../x", "/etc", "a//b", "a/", ".git", ".git/hooks", "./a", "a\0b"]) {
      await expect(session.tree(bad)).rejects.toThrow("invalid path");
    }
  });

  test("a symbolic link to a folder outside the project is refused", async () => {
    const dir = project();
    const outside = join(base, `outside${counter++}`);
    mkdirSync(outside);
    write(outside, "secret.txt", "s");
    symlinkSync(outside, join(dir, "escape"));
    expect(await open(dir).tree("escape")).toEqual({ state: "refused", reason: "outside_project" });
  });

  test("a very long path is refused before it reaches the disk", async () => {
    const dir = project();
    await expect(open(dir).tree("a/".repeat(MAX_FILE_PATH_CHARS))).rejects.toThrow("invalid path");
  });

  test("a folder over the cap answers a prefix and says so", async () => {
    const dir = project(false);
    for (let i = 0; i < 2_050; i++) writeFileSync(join(dir, `f${String(i).padStart(4, "0")}`), "");
    const tree = await open(dir).tree();
    expect(tree.state === "ok" && tree.truncated).toBe(true);
    expect(tree.state === "ok" && tree.entries.length).toBe(2_000);
  });
});

describe("files.read", () => {
  test("returns text, with its size", async () => {
    const dir = project();
    write(dir, "sub/é ñ.txt", "olá\n");
    const read = await open(dir).read("sub/é ñ.txt");
    expect(read).toEqual({ state: "ok", path: "sub/é ñ.txt", content: "olá\n", bytes: 5 });
  });

  test("binary, not-UTF-8 and over-limit files are not returned as text", async () => {
    const dir = project();
    write(dir, "nul.bin", new Uint8Array([104, 0, 105]));
    write(dir, "latin1.txt", new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
    write(dir, "big.txt", "x".repeat(MAX_FILE_BYTES + 1));
    write(dir, "edge.txt", "x".repeat(MAX_FILE_BYTES));
    const session = open(dir);
    expect(await session.read("nul.bin")).toEqual({ state: "binary", bytes: 3 });
    expect(await session.read("latin1.txt")).toEqual({ state: "binary", bytes: 4 });
    expect(await session.read("big.txt")).toEqual({
      state: "too_large",
      bytes: MAX_FILE_BYTES + 1,
      limit: MAX_FILE_BYTES,
    });
    expect((await session.read("edge.txt")).state).toBe("ok");
  });

  test("refuses a link to a file outside, a link inside, a link on the way, a folder, a pipe", async () => {
    const dir = project();
    const outside = join(base, `outside${counter++}`);
    mkdirSync(outside);
    write(outside, "secret.txt", "TOPSECRET");
    write(dir, "inside.txt", "ok");
    symlinkSync(join(outside, "secret.txt"), join(dir, "to-secret"));
    symlinkSync("inside.txt", join(dir, "to-inside"));
    symlinkSync(outside, join(dir, "dirlink"));
    mkdirSync(join(dir, "folder"));
    Bun.spawnSync(["mkfifo", join(dir, "pipe")]);
    const session = open(dir);
    const refused = async (path: string) => {
      const read = await session.read(path);
      expect(JSON.stringify(read)).not.toContain("TOPSECRET");
      return read;
    };
    expect(await refused("to-secret")).toEqual({ state: "refused", reason: "outside_project" });
    expect(await refused("to-inside")).toEqual({ state: "refused", reason: "outside_project" });
    expect(await refused("dirlink/secret.txt")).toEqual({
      state: "refused",
      reason: "outside_project",
    });
    expect(await refused("folder")).toEqual({ state: "refused", reason: "not_a_file" });
    expect(await refused("pipe")).toEqual({ state: "refused", reason: "not_a_file" });
    expect(await refused("missing.txt")).toEqual({ state: "refused", reason: "missing" });
    expect((await session.read("inside.txt")).state).toBe("ok");
  });

  test("never serves the repository's own files, or a path that climbs out", async () => {
    const dir = project();
    write(dir, "a.txt", "a");
    const session = open(dir);
    for (const bad of [
      "",
      ".git/config",
      "../a.txt",
      "/etc/passwd",
      "a.txt/",
      "x/../a.txt",
      "a\0.txt",
    ]) {
      await expect(session.read(bad)).rejects.toThrow("invalid path");
    }
  });

  test("when the session folder itself is a link, files inside it are still served", async () => {
    const dir = project();
    write(dir, "a.txt", "a");
    const link = join(base, `link${counter++}`);
    symlinkSync(dir, link);
    const session = open(link);
    expect((await session.read("a.txt")).state).toBe("ok");
  });
});

describe("files.diff", () => {
  test("a modified file: numbered rows against HEAD", async () => {
    const dir = project();
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    write(dir, "f.txt", `${lines.join("\n")}\n`);
    commitAll(dir);
    lines[2] = "changed 3";
    lines.splice(25, 1);
    write(dir, "f.txt", `${lines.join("\n")}\n`);
    const diff = await open(dir).diff("f.txt");
    if (diff.state !== "ok") throw new Error(diff.state);
    expect(diff).toMatchObject({ status: "M", added: 1, removed: 2, truncated: false });
    expect(diff.rows[0]).toEqual({ kind: "context", oldLine: 1, newLine: 1, text: "line 1" });
    const removed = diff.rows.filter((r) => r.kind === "remove");
    expect(removed.map((r) => [r.oldLine, r.text])).toEqual([
      [3, "line 3"],
      [26, "line 26"],
    ]);
    expect(diff.rows.filter((r) => r.kind === "skip")).toHaveLength(1);
    expect(diff.rows.find((r) => r.kind === "add")).toEqual({
      kind: "add",
      newLine: 3,
      text: "changed 3",
    });
  });

  test("an untracked file is all added; a deleted one is all removed", async () => {
    const dir = project();
    write(dir, "old.txt", "a\nb\n");
    commitAll(dir);
    rmSync(join(dir, "old.txt"));
    write(dir, "new.txt", "x\ny\nz\n");
    const session = open(dir);
    expect(await session.diff("new.txt")).toMatchObject({
      state: "ok",
      status: "?",
      added: 3,
      removed: 0,
    });
    const gone = await session.diff("old.txt");
    expect(gone).toMatchObject({ state: "ok", status: "D", added: 0, removed: 2 });
  });

  test("a rename shows its source", async () => {
    const dir = project();
    write(dir, "a.txt", "one\ntwo\nthree\nfour\n");
    commitAll(dir);
    git(dir, "mv", "a.txt", "b.txt");
    write(dir, "b.txt", "one\ntwo\nthree\nFOUR\n");
    const diff = await open(dir).diff("b.txt");
    expect(diff).toMatchObject({ state: "ok", status: "R", from: "a.txt", added: 1, removed: 1 });
  });

  test("binary, unchanged and non-repository answers", async () => {
    const dir = project();
    write(dir, "b.bin", new Uint8Array([0, 1]));
    write(dir, "same.txt", "s\n");
    commitAll(dir);
    write(dir, "b.bin", new Uint8Array([0, 2, 3]));
    write(dir, "u.bin", new Uint8Array([0, 5]));
    const session = open(dir);
    expect(await session.diff("b.bin")).toEqual({ state: "binary", status: "M" });
    expect(await session.diff("u.bin")).toEqual({ state: "binary", status: "?" });
    expect(await session.diff("same.txt")).toEqual({ state: "unchanged" });
    const plain = project(false);
    write(plain, "a.txt", "a");
    expect(await open(plain).diff("a.txt")).toEqual({ state: "unchanged" });
  });

  test("an untracked symlink to a secret is refused, not read", async () => {
    const dir = project();
    const outside = join(base, `outside${counter++}`);
    mkdirSync(outside);
    write(outside, "secret.txt", "TOPSECRET");
    write(dir, "a.txt", "a");
    commitAll(dir);
    symlinkSync(join(outside, "secret.txt"), join(dir, "sneaky"));
    const diff = await open(dir).diff("sneaky");
    expect(JSON.stringify(diff)).not.toContain("TOPSECRET");
    expect(diff.state).toBe("refused");
  });

  test("a branch with no commit diffs against the empty tree", async () => {
    const dir = project();
    write(dir, "a.txt", "a\nb\n");
    git(dir, "add", "a.txt");
    const diff = await open(dir).diff("a.txt");
    expect(diff).toMatchObject({ state: "ok", status: "A", added: 2, removed: 0 });
  });

  test("a name that looks like an option or a pathspec is that file", async () => {
    const dir = project();
    write(dir, "-p", "base\n");
    write(dir, "*", "star\n");
    commitAll(dir);
    write(dir, "-p", "changed\n");
    write(dir, "*", "star2\n");
    write(dir, "other.txt", "o\n");
    commitAll(dir, "o");
    write(dir, "-p", "changed again\n");
    const session = open(dir);
    expect(await session.diff("-p")).toMatchObject({ state: "ok", added: 1, removed: 1 });
    expect(await session.diff("*")).toEqual({ state: "unchanged" });
  });
});

/** Every file under `dir`, with size, mtime and a hash, to prove nothing was touched. */
function fingerprint(dir: string): string {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const info = statSync(full, { throwIfNoEntry: false });
      if (!info) continue;
      if (info.isDirectory()) {
        out.push(`d ${full} ${info.mtimeMs}`);
        walk(full);
      } else if (info.isFile()) {
        out.push(
          `f ${full} ${info.size} ${info.mtimeMs} ${createHash("sha1").update(readFileSync(full)).digest("hex")}`,
        );
      }
    }
  };
  walk(dir);
  return out.join("\n");
}

describe("no-write guarantee", () => {
  test("no method changes a byte, an mtime or the index, and no lock is left", async () => {
    const dir = project();
    write(dir, "a.txt", "a\n");
    write(dir, "sub/b.txt", "b\n");
    commitAll(dir);
    write(dir, "a.txt", "changed\n");
    write(dir, "new.txt", "n\n");
    // A stale index timestamp is what makes a plain `git status` want to rewrite the index.
    const future = new Date(Date.now() - 60_000);
    Bun.spawnSync(["touch", "-d", future.toISOString(), join(dir, "sub/b.txt")]);
    const before = fingerprint(dir);
    const session = open(dir);
    await session.status();
    await session.tree();
    await session.tree("sub");
    await session.read("a.txt");
    await session.diff("a.txt");
    await session.diff("new.txt");
    expect(fingerprint(dir)).toBe(before);
    expect(existsSync(join(dir, ".git/index.lock"))).toBe(false);
  });

  test("a read-only repository still answers", async () => {
    const dir = project();
    write(dir, "a.txt", "a\n");
    commitAll(dir);
    write(dir, "a.txt", "b\n");
    chmodSync(join(dir, ".git"), 0o555);
    try {
      expect(okStatus(await open(dir).status()).changes).toHaveLength(1);
    } finally {
      chmodSync(join(dir, ".git"), 0o755);
    }
  });
});

describe("a hostile repository", () => {
  test("nothing named by its config, hooks or attributes runs", async () => {
    const dir = project();
    const marker = join(base, `marker${counter++}`);
    mkdirSync(marker);
    const touch = (name: string) => `touch ${join(marker, name)}`;
    const script = (name: string) => {
      const path = join(base, `${name}-${counter++}.sh`);
      writeFileSync(path, `#!/bin/sh\n${touch(name)}\ncat\n`);
      chmodSync(path, 0o755);
      return path;
    };
    write(dir, "a.txt", "a\n");
    write(dir, "b.txt", "b\n");
    commitAll(dir);
    const hooks = join(dir, ".git/hooks");
    for (const hook of [
      "post-index-change",
      "post-checkout",
      "post-commit",
      "reference-transaction",
      "fsmonitor-watchman",
    ]) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\n${touch(hook)}\n`);
      chmodSync(join(hooks, hook), 0o755);
    }
    git(dir, "config", "core.fsmonitor", script("fsmonitor"));
    git(dir, "config", "core.pager", script("pager"));
    git(dir, "config", "core.hooksPath", join(dir, ".git/hooks"));
    git(dir, "config", "core.editor", script("editor"));
    git(dir, "config", "diff.external", script("external"));
    git(dir, "config", "diff.evil.textconv", script("textconv"));
    git(dir, "config", "core.sshCommand", script("ssh"));
    write(dir, ".gitattributes", "*.txt diff=evil\n");
    write(dir, "a.txt", "A\n");
    write(dir, "c.txt", "c\n");
    const session = open(dir);
    expect(okStatus(await session.status()).changes.length).toBeGreaterThan(0);
    await session.tree();
    expect((await session.diff("a.txt")).state).toBe("ok");
    expect((await session.diff("c.txt")).state).toBe("ok");
    expect((await session.read("a.txt")).state).toBe("ok");
    expect(readdirSync(marker)).toEqual([]);
  });

  test("a .git file that points at a work tree or a submodule still works", async () => {
    const main = project();
    write(main, "a.txt", "a\n");
    commitAll(main);
    const tree = join(base, `wt${counter++}`);
    git(main, "worktree", "add", "-q", "-b", "wt", tree);
    write(tree, "a.txt", "changed in the work tree\n");
    expect(readFileSync(join(tree, ".git"), "utf8")).toStartWith("gitdir:");
    const status = okStatus(await open(tree).status());
    expect(status.branch.name).toBe("wt");
    expect(status.changes.map((c) => c.path)).toEqual(["a.txt"]);
    expect(await open(tree).tree()).toMatchObject({ state: "ok" });
  });

  test("a repository that git refuses to open (unsafe owner or corrupt) is not a crash", async () => {
    const dir = project();
    write(dir, "a.txt", "a\n");
    writeFileSync(join(dir, ".git/HEAD"), "garbage\n");
    const result = await open(dir).status();
    expect(["not_repo", "ok"]).toContain(result.state);
  });
});

describe("a large tree", () => {
  test("hundreds of changes are listed and counted", async () => {
    const dir = project();
    write(dir, "seed.txt", "s\n");
    commitAll(dir);
    for (let i = 0; i < 600; i++) writeFileSync(join(dir, `n${i}.txt`), "x\n");
    const status = okStatus(await open(dir).status());
    expect(status.changes).toHaveLength(600);
    expect(status.totals.added).toBe(600);
  });
});

describe("session lifecycle", () => {
  test("a request under the id a session had before omp moved it reaches the successor", async () => {
    const dir = project();
    write(dir, "a.txt", "a\n");
    const session = open(dir);
    session.store.rekey("s1", "s2");
    expect(okStatus(await session.status()).changes.map((c) => c.path)).toEqual(["a.txt"]);
    expect((await session.read("a.txt")).state).toBe("ok");
  });

  test("closing the session kills the git child that is still running", async () => {
    const dir = project();
    write(dir, "a.txt", "a\n");
    // A `git` that records its pid and then hangs, found first on PATH.
    const shimDir = join(base, `shim${counter++}`);
    mkdirSync(shimDir);
    const pidFile = join(shimDir, "pid");
    writeFileSync(join(shimDir, "git"), `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 30\n`);
    chmodSync(join(shimDir, "git"), 0o755);
    const realPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${realPath}`;
    try {
      const session = open(dir);
      const pending = session.status();
      const outcome = pending.then(
        () => "answered",
        (error: Error) => error.message,
      );
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(20);
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      session.store.remove("s1");
      expect(await outcome).toContain("unknown session");
      let alive = true;
      for (let i = 0; i < 50 && alive; i++) {
        try {
          process.kill(pid, 0);
          await Bun.sleep(20);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      process.env.PATH = realPath;
    }
  });

  test("a newer status request supersedes the one still running", async () => {
    const dir = project();
    write(dir, "a.txt", "a\n");
    const shimDir = join(base, `shim${counter++}`);
    mkdirSync(shimDir);
    const realGit = Bun.which("git") ?? "git";
    // The first status call hangs; later ones run the real git.
    const flag = join(shimDir, "first");
    writeFileSync(
      join(shimDir, "git"),
      `#!/bin/sh\ncase "$*" in *"status --porcelain"*) if [ ! -e ${flag} ]; then touch ${flag}; exec sleep 30; fi;; esac\nexec ${realGit} "$@"\n`,
    );
    chmodSync(join(shimDir, "git"), 0o755);
    const realPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${realPath}`;
    try {
      const session = open(dir);
      const first = session.status().then(
        () => "answered",
        (error: Error) => error.message,
      );
      for (let i = 0; i < 100 && !existsSync(flag); i++) await Bun.sleep(20);
      const second = await session.status();
      expect(second.state).toBe("ok");
      expect(await first).toBe("files request superseded");
    } finally {
      process.env.PATH = realPath;
    }
  });
});
