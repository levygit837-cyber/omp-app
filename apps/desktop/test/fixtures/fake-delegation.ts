/**
 * Delegation for the fake sidecar: two subagents (one with a nested child) and one background
 * job per session, which a live omp cannot produce on demand. Wired by `fake-sidecar.ts`.
 *
 * Knobs (all optional; without `FAKE_DELEGATION` nothing here runs):
 * - FAKE_DELEGATION=1|running: set the delegation up after the first subscribe of each session.
 * - FAKE_DELEGATION=frames: also send `verify`'s view a burst of ops on its first subscribe.
 * - FAKE_SUBAGENT_FRAMES: size of that burst (default 400).
 * - FAKE_SUBAGENT_MS: `explore` completes after this many ms (default: never, so screenshots
 *   stay stable).
 * - FAKE_SUBAGENT_ODD_ID=1: one more subagent whose id holds a quote, a backslash and a bracket (omp's
 *   `task` names are any string), to prove nothing builds a CSS selector from an id.
 * - FAKE_SUBAGENT_EXTRA=<n>: n more subagents (`sa-extra-1`...), to fill the tab strip past its width.
 * - FAKE_CANCEL_FAILS=1: `subagent.cancel` rejects with STOP_FAILED_MESSAGE and leaves the
 *   subagent running.
 *
 * The recorded timeline in `subagent-view.json` is a real subagent run, exported by
 * `packages/sidecar/scripts/export-subagent-view.ts`.
 */
import { readFileSync } from "node:fs";
import {
  errorResponse,
  type Item,
  type JobInfo,
  okResponse,
  type ResponseEnvelope,
  type SessionOp,
  type SessionStatus,
  type SessionViewModel,
  STOP_FAILED_MESSAGE,
  type SubagentInfo,
  UNKNOWN_SESSION_MESSAGE,
} from "@omp-app/protocol";

/** What this module needs of a fake session: its view model. */
interface DelegationSession {
  vm: SessionViewModel;
}

/** What the fake sidecar lends: the session store and its `emit`. */
export interface DelegationHost<S extends DelegationSession> {
  emit(session: S, op: SessionOp): void;
  get(id: string): S | undefined;
  /** Registers a session under `id` with the given history and status; `seq` starts at 0. */
  open(id: string, cwd: string, timeline: Item[], status: SessionStatus): S;
  remove(id: string): void;
  chunkMs: number;
}

interface Recorded {
  info: SubagentInfo;
  view: SessionViewModel;
}

interface Tracked {
  info: SubagentInfo;
  /** Characters appended to the live item so far; picks the next chunk of the text. */
  written: number;
  framesSent: boolean;
}

interface Delegation {
  subagents: Map<string, Tracked>;
  job: JobInfo;
  timers: NodeJS.Timeout[];
}

const MODE = (process.env.FAKE_DELEGATION ?? "").trim();
const FRAMES = Number(process.env.FAKE_SUBAGENT_FRAMES ?? 400);
const EXTRA = Number(process.env.FAKE_SUBAGENT_EXTRA ?? 0);
const ODD_ID = process.env.FAKE_SUBAGENT_ODD_ID === "1";
const SUBAGENT_MS = process.env.FAKE_SUBAGENT_MS ? Number(process.env.FAKE_SUBAGENT_MS) : null;
const TOKEN_TICK_MS = 1000;
const CHUNK_SIZE = 12;
const LIVE_TEXT =
  "Reading the event log and the handshake path. The first frame carries the protocol version, " +
  "then the sidecar answers with its capabilities. Next I compare the sequence numbers of the " +
  "ops with the snapshot that came before them, and check that the clock used for the " +
  "timestamps never goes backwards between two frames of the same turn. ";

export const delegationEnabled = MODE !== "" && MODE !== "0";

let recordedCache: Recorded | undefined;
function recorded(): Recorded {
  recordedCache ??= JSON.parse(
    readFileSync(new URL("./subagent-view.json", import.meta.url), "utf8"),
  ) as Recorded;
  return recordedCache;
}

function param(params: unknown, key: string): string {
  const value = (params as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "string" ? value : "";
}

const SPECS = [
  { id: "sa-explore", agent: "explore", description: "Survey events", parentId: undefined },
  { id: "sa-verify", agent: "task", description: "Verify the handshake", parentId: undefined },
  { id: "sa-clock", agent: "task", description: "Check the clock", parentId: "sa-verify" },
] as const;

interface Spec {
  readonly id: string;
  readonly agent: string;
  readonly description: string;
  readonly parentId: string | undefined;
}
const ALL_SPECS: readonly Spec[] = [
  ...SPECS,
  ...(ODD_ID
    ? [{ id: 'Fix "auth"\\]', agent: "task", description: "Odd id", parentId: undefined }]
    : []),
  ...Array.from({ length: EXTRA }, (_, i) => ({
    id: `sa-extra-${i + 1}`,
    agent: "task",
    description: `Extra check ${i + 1}`,
    parentId: undefined,
  })),
];

export function createDelegation<S extends DelegationSession>(host: DelegationHost<S>) {
  const parents = new Map<string, Delegation>();
  /** viewId -> the parent session and subagent it belongs to. */
  const views = new Map<string, { parentId: string; subagentId: string }>();

  const viewIdOf = (sessionId: string, id: string) => `view:${sessionId}:${id}`;

  function setSubagent(parent: S, tracked: Tracked, patch: Partial<SubagentInfo>) {
    tracked.info = { ...tracked.info, ...patch };
    host.emit(parent, { type: "subagent.set", subagent: tracked.info });
  }

  function stopSubagent(parent: S, tracked: Tracked, status: "completed" | "aborted") {
    if (tracked.info.status !== "running") return;
    setSubagent(parent, tracked, { status, endedAt: Date.now() });
    const view = host.get(tracked.info.viewId);
    if (!view) return;
    host.emit(view, { type: "item.done", itemId: `${tracked.info.id}:live` });
    host.emit(view, { type: "status.set", status: "idle" });
  }

  function setup(parent: S): void {
    const sessionId = parent.vm.id;
    const now = Date.now();
    const d: Delegation = {
      subagents: new Map(),
      job: {
        id: "job-1",
        type: "bash",
        status: "running",
        label: "bun test --watch",
        startTime: now,
        progressText: "3 pass",
      },
      timers: [],
    };
    parents.set(sessionId, d);

    for (const spec of ALL_SPECS) {
      const viewId = viewIdOf(sessionId, spec.id);
      const history: Item[] =
        spec.id === "sa-explore"
          ? recorded().view.timeline.map((item) => ({ ...item, id: `${spec.id}:${item.id}` }))
          : [{ kind: "user", id: `${spec.id}:prompt`, text: spec.description }];
      history.push({ kind: "assistant", id: `${spec.id}:live`, text: "", done: false });
      host.open(viewId, parent.vm.cwd, history, "streaming");
      views.set(viewId, { parentId: sessionId, subagentId: spec.id });
      const info: SubagentInfo = {
        id: spec.id,
        viewId,
        agent: spec.agent,
        description: spec.description,
        status: "running",
        startedAt: now,
        tokens: 120,
        ...(spec.parentId ? { parentId: spec.parentId } : {}),
      };
      d.subagents.set(spec.id, { info, written: 0, framesSent: false });
      host.emit(parent, { type: "subagent.set", subagent: info });
    }
    host.emit(parent, { type: "jobs.set", jobs: [d.job] });

    // The views stream a slowly growing text; the counts on the parent tick up.
    d.timers.push(
      setInterval(
        () => {
          for (const tracked of d.subagents.values()) {
            if (tracked.info.status !== "running") continue;
            const view = host.get(tracked.info.viewId);
            if (!view) continue;
            const at = tracked.written % LIVE_TEXT.length;
            const text = LIVE_TEXT.slice(at, at + CHUNK_SIZE);
            tracked.written += text.length;
            host.emit(view, { type: "item.appendText", itemId: `${tracked.info.id}:live`, text });
          }
        },
        Math.max(1, host.chunkMs),
      ),
      setInterval(() => {
        for (const tracked of d.subagents.values()) {
          if (tracked.info.status !== "running") continue;
          setSubagent(parent, tracked, { tokens: tracked.info.tokens + 37 });
        }
      }, TOKEN_TICK_MS),
    );

    if (SUBAGENT_MS !== null) {
      d.timers.push(
        setInterval(function finish() {
          const explore = d.subagents.get("sa-explore");
          if (explore && Date.now() - explore.info.startedAt >= SUBAGENT_MS) {
            stopSubagent(parent, explore, "completed");
          }
        }, 50),
      );
    }
  }

  /** `FAKE_DELEGATION=frames`: a chatty subagent, as fast as the socket takes it. */
  function burst(view: S, subagentId: string): void {
    const live = `${subagentId}:live`;
    const toolId = (i: number) => `${subagentId}:t${i}`;
    for (let i = 0; i < FRAMES; i++) {
      const slot = i % 10;
      if (slot === 0) {
        host.emit(view, {
          type: "item.add",
          item: {
            kind: "tool",
            id: toolId(i),
            tool: "bash",
            intent: `Running step ${i}`,
            calls: [
              { toolCallId: `${subagentId}:c${i}`, status: "running", startedAt: Date.now() },
            ],
          },
        });
      } else if (slot === 1) {
        host.emit(view, {
          type: "tool.call.update",
          itemId: toolId(i - 1),
          toolCallId: `${subagentId}:c${i - 1}`,
          patch: { status: "done", endedAt: Date.now() },
        });
      } else {
        host.emit(view, { type: "item.appendText", itemId: live, text: `step ${i} ` });
      }
    }
  }

  return {
    isView: (id: string) => views.has(id),

    /** Call after a `session.subscribe` succeeded; defers so the snapshot's seq comes first. */
    onSubscribe(sessionId: string, session: S): void {
      if (!delegationEnabled) return;
      const view = views.get(sessionId);
      if (view) {
        if (MODE !== "frames" || view.subagentId !== "sa-verify") return;
        const tracked = parents.get(view.parentId)?.subagents.get(view.subagentId);
        if (!tracked || tracked.framesSent) return;
        tracked.framesSent = true;
        setTimeout(() => burst(session, view.subagentId), 0);
        return;
      }
      if (parents.has(sessionId)) return;
      setTimeout(() => {
        if (host.get(sessionId) === session && !parents.has(sessionId)) setup(session);
      }, 0);
    },

    /** The parent was closed: stop its timers and drop its views. */
    dispose(sessionId: string): void {
      const d = parents.get(sessionId);
      if (!d) return;
      for (const timer of d.timers) clearInterval(timer);
      for (const tracked of d.subagents.values()) {
        host.remove(tracked.info.viewId);
        views.delete(tracked.info.viewId);
      }
      parents.delete(sessionId);
    },

    /** `subagent.cancel` and `job.cancel`; undefined for any other method. */
    handle(method: string, id: string, params: unknown): ResponseEnvelope | undefined {
      if (method !== "subagent.cancel" && method !== "job.cancel") return undefined;
      const sessionId = param(params, "sessionId");
      const parent = host.get(sessionId);
      if (!parent || views.has(sessionId)) {
        return errorResponse(id, {
          code: "internal",
          message: `${UNKNOWN_SESSION_MESSAGE}: ${sessionId}`,
        });
      }
      const d = parents.get(sessionId);
      if (method === "job.cancel") {
        if (!d || d.job.id !== param(params, "jobId") || d.job.status !== "running") {
          return okResponse(id, { cancelled: false });
        }
        d.job = { ...d.job, status: "cancelled", endTime: Date.now() };
        host.emit(parent, { type: "jobs.set", jobs: [d.job] });
        return okResponse(id, { cancelled: true });
      }
      const tracked = d?.subagents.get(param(params, "subagentId"));
      if (!d || !tracked || tracked.info.status !== "running") {
        return okResponse(id, { cancelled: false });
      }
      if (process.env.FAKE_CANCEL_FAILS === "1") {
        return errorResponse(id, { code: "internal", message: STOP_FAILED_MESSAGE });
      }
      const doomed = new Set([tracked.info.id]);
      for (const other of d.subagents.values()) {
        if (other.info.parentId && doomed.has(other.info.parentId)) doomed.add(other.info.id);
      }
      for (const other of d.subagents.values()) {
        if (doomed.has(other.info.id)) stopSubagent(parent, other, "aborted");
      }
      return okResponse(id, { cancelled: true });
    },
  };
}
