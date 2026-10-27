import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { SettingEntry } from "@omp-app/protocol";
import { YAML } from "bun";
import { listedSettings } from "../src/settings-catalog";
import { type RawClient, type RunningSidecar, startSidecar } from "./harness";

setDefaultTimeout(60_000);

/** Everything lives in one temp tree: the real ~/.omp is never read or written. */
let root: string;
let agentDir: string;
let project: string;
let sidecar: RunningSidecar | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "omp-app-settings-")));
  agentDir = join(root, "agent");
  project = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(project, { recursive: true });
});
afterEach(async () => {
  await sidecar?.stop();
  sidecar = undefined;
  rmSync(root, { recursive: true, force: true });
});

const globalFile = () => join(agentDir, "config.yml");
const projectDir = () => join(project, ".omp");
const projectFile = () => join(projectDir(), "config.yml");

/** The file as data; a missing or empty file reads as `{}`. */
const parsed = (file: string): unknown =>
  existsSync(file) ? (YAML.parse(readFileSync(file, "utf8")) ?? {}) : {};

async function connect(): Promise<RawClient> {
  sidecar = await startSidecar({
    PI_CODING_AGENT_DIR: agentDir,
    HOME: root,
    XDG_DATA_HOME: "",
    XDG_STATE_HOME: "",
  });
  return sidecar.connect();
}

/** A project is named by a session: the sidecar takes the directory from that session's cwd. */
async function openSession(client: RawClient, cwd = project): Promise<string> {
  return (await client.request("session.create", { cwd })).sessionId;
}

const entryOf = (entries: readonly SettingEntry[], id: string): SettingEntry => {
  const found = entries.find((e) => e.id === id);
  if (!found) throw new Error(`no entry ${id}`);
  return found;
};

const errorOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: Error & { code?: string }) => e,
  );

describe("settings.list", () => {
  test("lists the registry grouped by tab and section, with the type of each setting", async () => {
    const client = await connect();
    const listing = await client.request("settings.list", { scope: "global" });

    expect(listing.tabs.map((t) => t.id)).toContain("tools");
    expect(listing.entries.length).toBe(listedSettings().length);
    const types = new Set<string>(listing.entries.map((e) => e.type));
    for (const type of ["boolean", "string", "number", "enum", "array", "record"])
      expect(types).toContain(type);
    // Every entry belongs to a listed tab, and a grouped entry to one of that tab's sections.
    for (const entry of listing.entries) {
      const tab = listing.tabs.find((t) => t.id === entry.tab);
      expect(tab).toBeDefined();
      if (entry.group !== null) expect(tab?.groups).toContain(entry.group);
    }
    expect(listing.files).toEqual({ global: globalFile(), project: null });
  });

  test("a secret is masked in the listing and appears only through reveal", async () => {
    writeFileSync(globalFile(), "hindsight:\n  apiToken: s3cr3t-token\n");
    const client = await connect();
    const listing = await client.request("settings.list", { scope: "global" });
    const secrets = listing.entries.filter((e) => e.secret);

    expect(secrets.map((e) => e.id)).toContain("hindsight.apiToken");
    expect(JSON.stringify(listing)).not.toContain("s3cr3t-token");
    const token = entryOf(listing.entries, "hindsight.apiToken");
    expect(token.value).toBeNull();
    expect(token.layers.global).toEqual({ set: true });

    expect(
      await client.request("settings.reveal", { scope: "global", id: "hindsight.apiToken" }),
    ).toEqual({
      value: "s3cr3t-token",
    });
    const plain = await errorOf(
      client.request("settings.reveal", { scope: "global", id: "retry.maxDelayMs" }),
    );
    expect(plain?.code).toBe("internal");
  });

  test("the project scope hides a project-held secret in the listing", async () => {
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(projectFile(), "hindsight:\n  apiToken: project-s3cr3t\n");
    const client = await connect();
    const sessionId = await openSession(client);

    const listing = await client.request("settings.list", { scope: "project", sessionId });
    expect(JSON.stringify(listing)).not.toContain("project-s3cr3t");
    expect(entryOf(listing.entries, "hindsight.apiToken").layers.project).toEqual({ set: true });
    expect(
      await client.request("settings.reveal", {
        scope: "project",
        sessionId,
        id: "hindsight.apiToken",
      }),
    ).toEqual({ value: "project-s3cr3t" });
  });

  test("a condition that is not met disables the dependent setting until its parent is on", async () => {
    writeFileSync(globalFile(), "plan:\n  enabled: false\n");
    const client = await connect();
    const { entries } = await client.request("settings.list", { scope: "global" });
    expect(entryOf(entries, "plan.autosave").disabledReason).toBeString();
    expect(entryOf(entries, "plan.enabled").disabledReason).toBeUndefined();

    // The change that turns the parent on also reports the dependent as available.
    const change = await client.request("settings.set", {
      scope: "global",
      id: "plan.enabled",
      value: true,
    });
    expect(change.ok).toBe(true);
    if (change.ok) expect(entryOf(change.entries, "plan.autosave").disabledReason).toBeUndefined();
  });

  test("a list the project sets locks the global editor but stays editable in the project scope", async () => {
    const client = await connect();
    const sessionId = await openSession(client);
    const set = await client.request("settings.set", {
      scope: "project",
      sessionId,
      id: "contextFiles.extra",
      value: ["NOTES.md"],
    });
    expect(set.ok).toBe(true);

    const inProject = await client.request("settings.list", { scope: "project", sessionId });
    expect(entryOf(inProject.entries, "contextFiles.extra").disabledReason).toBeUndefined();
    const inGlobal = await client.request("settings.list", { scope: "global", sessionId });
    expect(entryOf(inGlobal.entries, "contextFiles.extra").disabledReason).toContain(
      "project scope",
    );
  });

  test("a project config that does not parse is reported, left untouched, and refuses edits", async () => {
    const client = await connect();
    const sessionId = await openSession(client);
    // After the session exists: omp moves a config it cannot parse aside when a session starts.
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(projectFile(), "bash: [unclosed\n  x: : :\n");

    const listing = await client.request("settings.list", { scope: "project", sessionId });
    expect(listing.projectError).toContain("not valid YAML");
    const change = await client.request("settings.set", {
      scope: "project",
      sessionId,
      id: "retry.maxDelayMs",
      value: 1000,
    });
    expect(change.ok).toBe(false);
    expect(readFileSync(projectFile(), "utf8")).toBe("bash: [unclosed\n  x: : :\n");
    expect(existsSync(join(projectDir(), "config.yml.bak"))).toBe(false);
  });
});

/** The effective value follows omp's own merge, which a plain "project over global" does not. */
describe("effective value", () => {
  test("a null in the project file is unset, so the next layer does not apply either", async () => {
    // omp merges the project layer over the global one before reading, and a merged null is
    // unset: the default applies, not the global value (probed on the pinned omp).
    writeFileSync(globalFile(), "retry:\n  maxDelayMs: 7000\n");
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(projectFile(), "retry:\n  maxDelayMs: null\n");
    const client = await connect();
    const sessionId = await openSession(client);

    const entry = entryOf(
      (await client.request("settings.list", { scope: "project", sessionId })).entries,
      "retry.maxDelayMs",
    );
    expect(entry.value).toBe(300000);
    expect(entry.source).toBe("default");
  });

  test("the project's legacy settings.json counts, and config.yml wins over it", async () => {
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(
      join(projectDir(), "settings.json"),
      JSON.stringify({ retry: { maxRetries: 4242, maxDelayMs: 1 } }),
    );
    writeFileSync(projectFile(), "retry:\n  maxDelayMs: 9\n");
    const client = await connect();
    const sessionId = await openSession(client);

    const { entries } = await client.request("settings.list", { scope: "project", sessionId });
    const legacy = entryOf(entries, "retry.maxRetries");
    expect(legacy.value).toBe(4242);
    expect(legacy.source).toBe("project");
    expect(entryOf(entries, "retry.maxDelayMs").value).toBe(9);
  });

  test("records merge key by key across the layers", async () => {
    writeFileSync(globalFile(), "tools:\n  approval:\n    bash: allow\n    edit: prompt\n");
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(projectFile(), "tools:\n  approval:\n    edit: deny\n");
    const client = await connect();
    const sessionId = await openSession(client);

    const entry = entryOf(
      (await client.request("settings.list", { scope: "project", sessionId })).entries,
      "tools.approval",
    );
    expect(entry.value).toEqual({ edit: "deny", bash: "allow" });
    expect(entry.source).toBe("project");
  });
});

describe("settings.set and settings.reset", () => {
  test("a global write lands in the agent dir's config.yml and reads back", async () => {
    const client = await connect();
    const change = await client.request("settings.set", {
      scope: "global",
      id: "retry.maxDelayMs",
      value: 12345,
    });
    expect(change.ok).toBe(true);
    if (change.ok) {
      const edited = entryOf(change.entries, "retry.maxDelayMs");
      expect(edited.value).toBe(12345);
      expect(edited.source).toBe("global");
    }
    expect(readFileSync(globalFile(), "utf8")).toContain("maxDelayMs: 12345");
    expect(existsSync(projectFile())).toBe(false);

    const listing = await client.request("settings.list", { scope: "global" });
    const entry = entryOf(listing.entries, "retry.maxDelayMs");
    expect(entry.value).toBe(12345);
    expect(entry.layers.global).toEqual({ set: true, value: 12345 });
    expect(entry.layers.default).toBe(300000);
  });

  test("a project write lands in <project>/.omp/config.yml, not in the global file", async () => {
    const client = await connect();
    const sessionId = await openSession(client);
    writeFileSync(globalFile(), "retry:\n  maxDelayMs: 111\n");
    const change = await client.request("settings.set", {
      scope: "project",
      sessionId,
      id: "retry.maxDelayMs",
      value: 222,
    });
    expect(change.ok).toBe(true);

    expect(readFileSync(projectFile(), "utf8")).toContain("maxDelayMs: 222");
    expect(readFileSync(globalFile(), "utf8")).toContain("maxDelayMs: 111");

    const inProject = entryOf(
      (await client.request("settings.list", { scope: "project", sessionId })).entries,
      "retry.maxDelayMs",
    );
    expect(inProject.value).toBe(222);
    expect(inProject.source).toBe("project");
    expect(inProject.layers.global).toEqual({ set: true, value: 111 });
    expect(inProject.layers.project).toEqual({ set: true, value: 222 });

    const inGlobal = entryOf(
      (await client.request("settings.list", { scope: "global", sessionId })).entries,
      "retry.maxDelayMs",
    );
    expect(inGlobal.value).toBe(111);
    expect(inGlobal.source).toBe("global");
  });

  test("reset removes the key from that scope's file only, so the next layer applies", async () => {
    const client = await connect();
    const sessionId = await openSession(client);
    writeFileSync(globalFile(), "retry:\n  maxDelayMs: 111\n");
    await client.request("settings.set", {
      scope: "project",
      sessionId,
      id: "retry.maxDelayMs",
      value: 222,
    });

    const reset = await client.request("settings.reset", {
      scope: "project",
      sessionId,
      id: "retry.maxDelayMs",
    });
    expect(reset.ok).toBe(true);
    if (reset.ok) expect(entryOf(reset.entries, "retry.maxDelayMs").value).toBe(111);
    // The parent key goes with its last child.
    expect(parsed(projectFile())).toEqual({});
    expect(parsed(globalFile())).toEqual({ retry: { maxDelayMs: 111 } });

    await client.request("settings.reset", { scope: "global", id: "retry.maxDelayMs" });
    const entry = entryOf(
      (await client.request("settings.list", { scope: "global" })).entries,
      "retry.maxDelayMs",
    );
    expect(entry.value).toBe(300000);
    expect(entry.source).toBe("default");
  });

  test("a global write keeps what another process wrote to config.yml since the last one", async () => {
    const client = await connect();
    await client.request("settings.set", { scope: "global", id: "retry.maxDelayMs", value: 111 });
    // Someone edits the file by hand while the app runs.
    writeFileSync(globalFile(), "retry:\n  maxDelayMs: 111\nask:\n  timeout: 42\n");

    await client.request("settings.set", { scope: "global", id: "retry.maxRetries", value: 7 });
    expect(parsed(globalFile())).toEqual({
      retry: { maxDelayMs: 111, maxRetries: 7 },
      ask: { timeout: 42 },
    });

    // A reset after another external edit also starts from the file as it is now.
    writeFileSync(
      globalFile(),
      "retry:\n  maxDelayMs: 111\n  maxRetries: 7\nask:\n  timeout: 50\n",
    );
    await client.request("settings.reset", { scope: "global", id: "retry.maxRetries" });
    expect(parsed(globalFile())).toEqual({ retry: { maxDelayMs: 111 }, ask: { timeout: 50 } });
  });

  test("a reset that changes nothing in a project leaves no .omp directory or lock behind", async () => {
    const client = await connect();
    const sessionId = await openSession(client);
    const reset = await client.request("settings.reset", {
      scope: "project",
      sessionId,
      id: "retry.maxDelayMs",
    });
    expect(reset.ok).toBe(true);
    expect(existsSync(projectDir())).toBe(false);
  });

  test("writes sent together all land, one after the other", async () => {
    const client = await connect();
    const sessionId = await openSession(client);
    const ids = ["retry.maxDelayMs", "ask.timeout", "retry.maxRetries"];
    const changes = await Promise.all([
      ...ids.map((id, i) =>
        client.request("settings.set", { scope: "global", id, value: 100 + i }),
      ),
      client.request("settings.set", {
        scope: "project",
        sessionId,
        id: "retry.maxDelayMs",
        value: 5,
      }),
    ]);
    expect(changes.every((c) => c.ok)).toBe(true);
    expect(parsed(globalFile())).toEqual({
      retry: { maxDelayMs: 100, maxRetries: 102 },
      ask: { timeout: 101 },
    });
    expect(parsed(projectFile())).toEqual({ retry: { maxDelayMs: 5 } });
  });

  test.each([
    ["a number", "retry.maxDelayMs", "soon"],
    ["an enum", "statusLine.preset", "no-such-preset"],
    ["an array", "contextFiles.extra", "NOTES.md"],
    ["a record", "retry.fallbackChains", 5],
  ])(
    "a value omp refuses for %s comes back as data and writes nothing",
    async (_kind, id, value) => {
      const client = await connect();
      const change = await client.request("settings.set", { scope: "global", id, value });
      expect(change.ok).toBe(false);
      if (!change.ok) expect(change.message).toContain(id);
      expect(existsSync(globalFile())).toBe(false);
    },
  );

  test("an unknown setting is an invalid request", async () => {
    const client = await connect();
    const unknown = await errorOf(
      client.request("settings.set", { scope: "global", id: "no.such", value: 1 }),
    );
    expect(unknown?.message).toContain("unknown setting");
  });
});

describe("the project of a settings call", () => {
  test("is the cwd of the named session; the project scope needs a known session", async () => {
    const client = await connect();
    const noSession = await errorOf(client.request("settings.list", { scope: "project" }));
    expect(noSession?.message).toContain("session");
    const unknown = await errorOf(
      client.request("settings.list", { scope: "project", sessionId: "no-such-session" }),
    );
    expect(unknown?.message).toContain("unknown session");

    // A global listing with a stale session id still works: it just has no project layer.
    const listing = await client.request("settings.list", {
      scope: "global",
      sessionId: "no-such-session",
    });
    expect(listing.files.project).toBeNull();
  });

  test("a directory sent by the caller is ignored: the write lands in the session's own project", async () => {
    const client = await connect();
    const sessionId = await openSession(client);
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    // Not a literal, so the extra `cwd` reaches the socket the way a hostile caller would send it.
    const hostile = {
      scope: "project" as const,
      sessionId,
      cwd: elsewhere,
      id: "retry.maxDelayMs",
    };
    const change = await client.request("settings.set", { ...hostile, value: 777 });
    expect(change.ok).toBe(true);
    expect(readFileSync(projectFile(), "utf8")).toContain("maxDelayMs: 777");
    expect(existsSync(join(elsewhere, ".omp"))).toBe(false);

    const reset = await client.request("settings.reset", hostile);
    expect(reset.ok).toBe(true);
    expect(existsSync(join(elsewhere, ".omp"))).toBe(false);
  });

  test("never the home directory: omp ignores a project config there", async () => {
    const client = await connect();
    const sessionId = await openSession(client, root); // HOME of the sidecar is `root`
    const refused = await client.request("settings.set", {
      scope: "project",
      sessionId,
      id: "retry.maxDelayMs",
      value: 5,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain("home directory");
    expect(existsSync(join(root, ".omp", "config.yml"))).toBe(false);

    // The project listing explains itself instead of failing; omp reads nothing from there.
    const listing = await client.request("settings.list", { scope: "project", sessionId });
    expect(listing.projectError).toContain("home directory");
    expect(listing.files.project).toBeNull();
    const reveal = await errorOf(
      client.request("settings.reveal", { scope: "project", sessionId, id: "hindsight.apiToken" }),
    );
    expect(reveal?.message).toContain("home directory");
  });
});

describe("read_only mode", () => {
  test("a newer shared schema refuses every settings write, still reads, and touches no file", async () => {
    const db = new Database(join(agentDir, "agent.db"), { create: true });
    db.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
    db.run("INSERT INTO schema_version(version) VALUES (?)", [SCHEMA_VERSION + 1]);
    db.close();
    writeFileSync(globalFile(), "retry:\n  maxDelayMs: 111\nhindsight:\n  apiToken: ro-token\n");

    const client = await connect();
    expect((await client.request("handshake")).mode).toBe("read_only");

    const set = await errorOf(
      client.request("settings.set", { scope: "global", id: "retry.maxDelayMs", value: 5 }),
    );
    const reset = await errorOf(
      client.request("settings.reset", { scope: "global", id: "retry.maxDelayMs" }),
    );
    const projectSet = await errorOf(
      client.request("settings.set", {
        scope: "project",
        sessionId: "any",
        id: "retry.maxDelayMs",
        value: 5,
      }),
    );
    expect([set?.code, reset?.code, projectSet?.code]).toEqual([
      "read_only",
      "read_only",
      "read_only",
    ]);
    expect(existsSync(projectDir())).toBe(false);
    expect(readFileSync(globalFile(), "utf8")).toBe(
      "retry:\n  maxDelayMs: 111\nhindsight:\n  apiToken: ro-token\n",
    );

    // Reading keeps working, secrets included: reveal is a read.
    const listing = await client.request("settings.list", { scope: "global" });
    expect(entryOf(listing.entries, "retry.maxDelayMs").value).toBe(111);
    expect(
      await client.request("settings.reveal", { scope: "global", id: "hindsight.apiToken" }),
    ).toEqual({ value: "ro-token" });
  });
});

describe("global files that cannot be used as they are", () => {
  test("a malformed global config is reported as a sentence, never with its contents, and stays untouched", async () => {
    const secret = "sk-live-do-not-echo-0123456789";
    const body = `providers:\n  key: "${secret}\n  : : [\n`;
    writeFileSync(globalFile(), body);
    const client = await connect();
    const failure = await errorOf(client.request("settings.list", { scope: "global" }));
    expect(failure).not.toBeNull();
    expect(failure?.message).toContain("config.yml");
    expect(failure?.message).not.toContain(secret);
    const written = await errorOf(
      client.request("settings.set", { scope: "global", id: "retry.maxDelayMs", value: 5 }),
    );
    expect(written?.message).not.toContain(secret);
    expect(readFileSync(globalFile(), "utf8")).toBe(body);
  });

  test("a config.yml that is a dangling symlink reads as an empty file and does not crash the listing", async () => {
    symlinkSync(join(root, "gone.yml"), globalFile());
    const client = await connect();
    const listing = await client.request("settings.list", { scope: "global" });
    const entry = entryOf(listing.entries, "retry.maxDelayMs");
    expect(entry.source).toBe("default");
    expect(listing.files.global).toBe(globalFile());
  });
});
