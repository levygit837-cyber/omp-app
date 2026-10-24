import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { type RunningSidecar, startSidecar } from "./harness";

setDefaultTimeout(60_000);

let home: string;
let sidecar: RunningSidecar | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "omp-app-session-guard-"));
  mkdirSync(join(home, "agent"), { recursive: true });
  const db = new Database(join(home, "agent", "agent.db"), { create: true });
  db.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
  db.run("INSERT INTO schema_version(version) VALUES (?)", [SCHEMA_VERSION + 1]);
  db.close();
});
afterEach(async () => {
  await sidecar?.stop();
  sidecar = undefined;
  rmSync(home, { recursive: true, force: true });
});

const agentDir = () => join(home, "agent");

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).bytes());
  return hasher.digest("hex");
}

test("a newer shared schema refuses session.create and session.prompt, and writes nothing", async () => {
  const dbBefore = await sha256(join(agentDir(), "agent.db"));
  sidecar = await startSidecar({
    PI_CODING_AGENT_DIR: agentDir(),
    HOME: home,
    XDG_DATA_HOME: "",
    XDG_STATE_HOME: "",
  });
  const client = await sidecar.connect();
  expect((await client.request("handshake")).mode).toBe("read_only");

  const code = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: Error & { code?: string }) => e.code,
    );
  expect(await code(client.request("session.create", { cwd: home }))).toBe("read_only");
  expect(await code(client.request("session.prompt", { sessionId: "x", text: "hi" }))).toBe(
    "read_only",
  );
  expect(await code(client.request("session.cancel", { sessionId: "x" }))).toBe("read_only");

  client.close();
  await sidecar.proc.exited;
  // `existsSync`, not `Bun.file(dir).exists()`: the latter is false for a directory.
  expect(existsSync(join(agentDir(), "sessions"))).toBe(false);
  expect(await sha256(join(agentDir(), "agent.db"))).toBe(dbBefore);
});

test("existsSync sees a directory where Bun.file().exists() does not (guards the assertion above)", async () => {
  mkdirSync(join(agentDir(), "sessions"));
  expect(existsSync(join(agentDir(), "sessions"))).toBe(true);
  expect(await Bun.file(join(agentDir(), "sessions")).exists()).toBe(false);
});
