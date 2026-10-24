import { join } from "node:path";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { SessionOpEvent, SessionSnapshot } from "@omp-app/protocol";

export const fixturesDir = join(import.meta.dir, "fixtures");

export interface Fixture {
  readonly header: {
    readonly scenario: string;
    readonly prompt: string;
    readonly sessionId: string;
    readonly cwd: string;
    readonly model: string | null;
  };
  readonly events: readonly AgentSessionEvent[];
}

/** Golden output of a replay: every op event in order and the final snapshot. */
export interface Golden {
  readonly ops: readonly SessionOpEvent[];
  readonly final: SessionSnapshot;
}

/** Reads `<name>.jsonl`: a header line, then one raw `AgentSessionEvent` per line. */
export async function loadFixture(name: string): Promise<Fixture> {
  const lines = (await Bun.file(join(fixturesDir, `${name}.jsonl`)).text()).trim().split("\n");
  const [header, ...events] = lines.map((line) => JSON.parse(line));
  return { header, events };
}

/** Compares against `<name>.golden.json`; `UPDATE_GOLDEN=1` rewrites it for review in the diff. */
export async function goldenFile(name: string, actual: Golden): Promise<Golden> {
  const file = Bun.file(join(fixturesDir, `${name}.golden.json`));
  if (process.env.UPDATE_GOLDEN === "1")
    await Bun.write(file, `${JSON.stringify(actual, null, 2)}\n`);
  return await file.json();
}
