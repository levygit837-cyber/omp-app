import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAN_MAX_BYTES, readPlanFrom } from "../src/plan-reader";

let root: string;
let local: string;
let secret: string;

const read = (planFilePath: string | null, maxBytes?: number) =>
  readPlanFrom({ localRoot: local, planFilePath, ...(maxBytes ? { maxBytes } : {}) });

/**
 * A local root of its own. A plan the listing shows competes with the others on modification time,
 * newest first, as in omp (plan-mode/approved-plan.ts, issue #6569 [V]); in a root shared by
 * several tests the one read first depends on timestamps that tie on a fast file system.
 */
let roots = 0;
const aloneIn = (): { dir: string; read: typeof read } => {
  const dir = join(root, `alone-${++roots}`, "local");
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    read: (planFilePath, maxBytes) =>
      readPlanFrom({ localRoot: dir, planFilePath, ...(maxBytes ? { maxBytes } : {}) }),
  };
};

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-plan-reader-")));
  local = join(root, "artifacts", "local");
  mkdirSync(local, { recursive: true });
  secret = join(root, "secret.md");
  writeFileSync(secret, "# not a plan of this session");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the path omp reports", () => {
  test("a local:// plan is read", async () => {
    writeFileSync(join(local, "auth-plan.md"), "# Auth\n\n1. do it\n");
    expect(await read("local://auth-plan.md")).toEqual({
      state: "ok",
      file: "local://auth-plan.md",
      content: "# Auth\n\n1. do it\n",
      earlier: false,
    });
  });

  test("a path that is not a local:// URL is refused, whatever it points at", async () => {
    for (const path of [secret, "file:///etc/passwd", "PLAN.md", "../secret.md", "xd://propose"]) {
      expect(await read(path)).toEqual({ state: "refused", reason: "not_local" });
    }
  });

  test("a traversal in the name never leaves the root", async () => {
    for (const path of [
      "local://../secret.md",
      "local://a/../../secret.md",
      "local://..",
      "local:///etc/passwd",
      "local://a\\..\\secret.md",
    ]) {
      expect(await read(path)).toEqual({ state: "refused", reason: "outside_session" });
    }
  });

  test("no plan path means no plan", async () => {
    expect(await read(null)).toEqual({ state: "missing" });
  });
});

describe("symlinks", () => {
  test("a plan file that links outside the root is refused", async () => {
    symlinkSync(secret, join(local, "stolen-plan.md"));
    expect(await read("local://stolen-plan.md")).toEqual({
      state: "refused",
      reason: "outside_session",
    });
  });

  test("a directory that links outside the root does not lead out", async () => {
    symlinkSync(root, join(local, "out"));
    expect(await read("local://out/secret.md")).toEqual({
      state: "refused",
      reason: "outside_session",
    });
  });

  test("a link to a sibling folder whose name starts with the root's name is outside it", async () => {
    // `<root>-evil` shares the root's path as a string prefix; only the separator tells them apart.
    const sibling = `${local}-evil`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "stolen-plan.md"), "# not this session's");
    symlinkSync(sibling, join(local, "evil"));
    expect(await read("local://evil/stolen-plan.md")).toEqual({
      state: "refused",
      reason: "outside_session",
    });
  });

  test("a link inside the root to another file in it is read as that file", async () => {
    writeFileSync(join(local, "real.md"), "# real");
    symlinkSync(join(local, "real.md"), join(local, "alias.md"));
    expect(await read("local://alias.md")).toMatchObject({ state: "ok", content: "# real" });
  });

  test("a link dropped in the root is never picked by the fallback listing", async () => {
    const dir = join(root, "fresh");
    mkdirSync(join(dir, "local"), { recursive: true });
    symlinkSync(secret, join(dir, "local", "only-plan.md"));
    expect(
      await readPlanFrom({ localRoot: join(dir, "local"), planFilePath: "local://PLAN.md" }),
    ).toEqual({
      state: "missing",
    });
  });
});

describe("size and kind", () => {
  test("a file over the limit is refused without being read", async () => {
    const here = aloneIn();
    writeFileSync(join(here.dir, "huge-plan.md"), "x".repeat(PLAN_MAX_BYTES + 1));
    expect(await here.read("local://huge-plan.md")).toEqual({
      state: "refused",
      reason: "too_large",
    });
  });

  test("a file exactly at the limit is read", async () => {
    const here = aloneIn();
    writeFileSync(join(here.dir, "edge-plan.md"), "y".repeat(64));
    expect(await here.read("local://edge-plan.md", 64)).toMatchObject({ state: "ok" });
    expect(await here.read("local://edge-plan.md", 63)).toEqual({
      state: "refused",
      reason: "too_large",
    });
  });

  test("a directory is not a plan", async () => {
    const here = aloneIn();
    mkdirSync(join(here.dir, "dir-plan.md"));
    expect(await here.read("local://dir-plan.md")).toEqual({
      state: "refused",
      reason: "not_a_file",
    });
  });

  test("multi-byte text survives", async () => {
    const here = aloneIn();
    writeFileSync(join(here.dir, "pt-plan.md"), "# Ação\n\n- renomear o carregador\n");
    expect(await here.read("local://pt-plan.md")).toMatchObject({
      content: "# Ação\n\n- renomear o carregador\n",
    });
  });
});

describe("a plan that is not there", () => {
  test("a missing file is an answer, not an error", async () => {
    const dir = join(root, "empty");
    mkdirSync(join(dir, "local"), { recursive: true });
    expect(
      await readPlanFrom({
        localRoot: join(dir, "local"),
        planFilePath: "local://nothing-here-plan.md",
      }),
    ).toEqual({ state: "missing" });
  });

  test("a session whose local root does not exist yet has no plan", async () => {
    expect(
      await readPlanFrom({
        localRoot: join(root, "no", "such", "local"),
        planFilePath: "local://PLAN.md",
      }),
    ).toEqual({ state: "missing" });
  });
});

describe("finding the file the agent wrote", () => {
  // omp's state says `local://PLAN.md` until a proposal is reviewed, but the agent writes
  // `local://<slug>-plan.md` [V] prompts/system/plan-mode-active.md:7,21; omp then lists the root
  // newest first [V] plan-mode/approved-plan.ts.
  test("the newest plan file in the root stands in for the state's default name", async () => {
    const dir = join(root, "listing");
    mkdirSync(join(dir, "local"), { recursive: true });
    const old = join(dir, "local", "old-plan.md");
    const fresh = join(dir, "local", "fresh-plan.md");
    writeFileSync(old, "# old");
    writeFileSync(fresh, "# fresh");
    utimesSync(old, 1_000, 1_000);
    utimesSync(fresh, 2_000, 2_000);
    expect(
      await readPlanFrom({ localRoot: join(dir, "local"), planFilePath: "local://PLAN.md" }),
    ).toEqual({
      state: "ok",
      file: "local://fresh-plan.md",
      content: "# fresh",
      earlier: false,
    });
  });

  test("the file the state names wins when it exists but is not a plan.md name", async () => {
    const dir = join(root, "named");
    mkdirSync(join(dir, "local"), { recursive: true });
    writeFileSync(join(dir, "local", "notes.md"), "# named");
    writeFileSync(join(dir, "local", "newer-plan.md"), "# newer");
    expect(
      await readPlanFrom({ localRoot: join(dir, "local"), planFilePath: "local://notes.md" }),
    ).toMatchObject({
      file: "local://notes.md",
    });
  });
});
