import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

test("a newer shared schema refuses session.create and session.prompt, and creates no session file", async () => {
  sidecar = await startSidecar({
    PI_CODING_AGENT_DIR: join(home, "agent"),
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
  expect(await Bun.file(join(home, "agent", "sessions")).exists()).toBe(false);
});
