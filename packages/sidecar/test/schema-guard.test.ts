import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { type RunningSidecar, startSidecar } from "./harness";

setDefaultTimeout(60_000);

let home: string;
let agentDir: string;
let sidecar: RunningSidecar | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "omp-app-guard-"));
  agentDir = join(home, "agent");
  mkdirSync(agentDir, { recursive: true });
});
afterEach(async () => {
  await sidecar?.stop();
  sidecar = undefined;
  rmSync(home, { recursive: true, force: true });
});

const dbPath = () => join(agentDir, "agent.db");

/** A database whose `schema_version` table says `version`, as an omp of that version leaves it. */
function craftDb(version: number): void {
  const db = new Database(dbPath(), { create: true });
  db.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
  db.run("INSERT INTO schema_version(version) VALUES (?)", [version]);
  db.close();
}

async function fingerprint(path: string): Promise<{ hash: string; mtimeMs: number }> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).bytes());
  return { hash: hasher.digest("hex"), mtimeMs: statSync(path).mtimeMs };
}

const launch = () =>
  startSidecar({
    PI_CODING_AGENT_DIR: agentDir,
    HOME: home,
    XDG_DATA_HOME: "",
    XDG_STATE_HOME: "",
  });

describe("schema guard", () => {
  test("a missing database is normal mode", async () => {
    sidecar = await launch();
    const client = await sidecar.connect();
    const hs = await client.request("handshake");
    expect(hs.mode).toBe("normal");
    expect(hs.schema).toBeUndefined();
    await expect(client.request("debug.write")).resolves.toEqual({ wrote: true });
  });

  test("an equal schema is normal mode", async () => {
    craftDb(SCHEMA_VERSION);
    sidecar = await launch();
    const client = await sidecar.connect();
    expect((await client.request("handshake")).mode).toBe("normal");
    await expect(client.request("debug.write")).resolves.toEqual({ wrote: true });
  });

  test("an older schema is normal mode", async () => {
    craftDb(SCHEMA_VERSION - 1);
    sidecar = await launch();
    const client = await sidecar.connect();
    expect((await client.request("handshake")).mode).toBe("normal");
  });

  test("a newer schema is read_only with both versions; writes are refused; the file is untouched", async () => {
    craftDb(SCHEMA_VERSION + 1);
    const before = await fingerprint(dbPath());
    sidecar = await launch();
    const client = await sidecar.connect();

    const hs = await client.request("handshake");
    expect(hs.mode).toBe("read_only");
    expect(hs.schema).toEqual({ onDisk: SCHEMA_VERSION + 1, expected: SCHEMA_VERSION });

    const refused = await client.request("debug.write").then(
      () => null,
      (e: Error & { code?: string }) => e,
    );
    expect(refused?.code).toBe("read_only");

    // Non-writing methods keep working.
    expect((await client.request("handshake")).mode).toBe("read_only");

    client.close();
    await sidecar.proc.exited;
    expect(await fingerprint(dbPath())).toEqual(before);
  });

  test("a corrupt database fails startup with a one-line message naming the path", async () => {
    writeFileSync(dbPath(), "this is not a sqlite database, just text\n".repeat(50));
    const proc = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../src/main.ts"),
        `--socket=${join(home, "s.sock")}`,
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, HOME: home },
      },
    );
    const stderr = await new Response(proc.stderr).text();

    expect(await proc.exited).not.toBe(0);
    const fatal = stderr.split("\n").filter((l) => l.includes("fatal:"));
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toContain(`cannot read agent database ${dbPath()}`);
  });
});
