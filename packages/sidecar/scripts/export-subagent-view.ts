/**
 * Replays the recorded `subagent.jsonl` through the real delegation tracker and writes the
 * finished subagent (its `SubagentInfo` and view snapshot) to
 * `apps/desktop/test/fixtures/subagent-view.json`, which the desktop fake sidecar plays back.
 * The view id is replaced by `__VIEW__`. Run: `bun packages/sidecar/scripts/export-subagent-view.ts`.
 */
import { join } from "node:path";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { DelegationRegistry, trackDelegation } from "../src/delegation";
import { emptyViewModel } from "../src/reducer";
import { SessionStore } from "../src/session-store";
import { fixturesDir } from "../test/replay";

const PLACEHOLDER = "__VIEW__";
const out = join(import.meta.dir, "../../../apps/desktop/test/fixtures/subagent-view.json");

/** One tick per call from a fixed origin, so times in a replay are stable. */
function ticking(origin = 1_000_000, step = 100): () => number {
  let t = origin - step;
  return () => (t += step);
}

/** The part of `AgentSession` the tracker reads; a recorded run needs nothing else. */
function standIn(cwd: string, agentId: string | undefined): AgentSession {
  return {
    getAgentId: () => agentId,
    sessionManager: { getCwd: () => cwd },
    asyncJobManager: undefined,
  } as unknown as AgentSession;
}

const rows = (await Bun.file(join(fixturesDir, "subagent.jsonl")).text())
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const [header, ...lines] = rows as [
  { sessionId: string; cwd: string; model: string | null },
  ...{ ch: string; data: unknown }[],
];

const id = header.sessionId;
const store = new SessionStore(ticking());
store.create(emptyViewModel({ id, cwd: header.cwd, model: header.model }));
const bus = new EventBus();
const registry = new DelegationRegistry();
const delegation = trackDelegation(
  store,
  standIn(header.cwd, "parent-agent"),
  { bus, registry, now: ticking(5_000_000, 1000) },
  () => id,
);
registry.add(() => id, delegation, store);
for (const line of lines) {
  if (line.ch === "session") store.dispatch(id, line.data as AgentSessionEvent);
  else bus.emit(line.ch, line.data);
}

const info = store.snapshot(id).snapshot.subagents[0];
if (!info) throw new Error("the recording produced no subagent");
const view = store.snapshot(info.viewId).snapshot;
const result = {
  info: { ...info, viewId: PLACEHOLDER },
  view: { ...view, id: PLACEHOLDER },
};
await Bun.write(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(`wrote ${out}: ${view.timeline.length} timeline items`);
// The tracker and the event bus keep timers or listeners alive; the export is done.
process.exit(0);
