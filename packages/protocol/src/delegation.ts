/**
 * Delegated work: subagents (task tool) and background jobs of one session.
 *
 * Only jobs the session itself owns are listed (omp refuses to cancel the rest, and the jobs of a
 * subagent belong to that subagent's own view). A `task` job is the subagent it runs: it shows up
 * as a subagent, not twice.
 *
 * Both lists live in the parent's view model (`SessionViewModel.subagents` / `.jobs`), so they
 * ride the same snapshot, `seq` and `session.moved` rules as everything else. A subagent's own
 * timeline is a separate view model of the same shape, stored under `SubagentInfo.viewId`; the
 * renderer subscribes to it with `session.subscribe(viewId)` and applies the same ops. It is
 * read-only: every method that drives a session refuses a `viewId` as an unknown session.
 */
import { isRecord } from "./guards";

/** omp announces `started`, then one final status; there is no queued state to show. */
export type SubagentStatus = "running" | "completed" | "failed" | "aborted";

export const SUBAGENT_STATUSES: readonly SubagentStatus[] = [
  "running",
  "completed",
  "failed",
  "aborted",
];

export interface SubagentInfo {
  /** omp's id of the subagent, unique within the process. What `subagent.cancel` takes. */
  readonly id: string;
  /**
   * Key of the subagent's own view model. Opaque; it never changes, not even when the parent
   * moves to a new id, so a subscription to it survives `session.moved`.
   */
  readonly viewId: string;
  /** Agent definition that runs it (`task`, `explore`, ...). */
  readonly agent: string;
  /** Short description the parent gave it; null when it gave none. */
  readonly description: string | null;
  readonly status: SubagentStatus;
  /** Epoch ms the sidecar first saw it. */
  readonly startedAt: number;
  /** Epoch ms it reached a final status; absent while it runs. */
  readonly endedAt?: number;
  /** Input + output tokens counted so far. */
  readonly tokens: number;
  /** `id` of the subagent that spawned it; absent when the session itself did. */
  readonly parentId?: string;
}

export type JobStatus = "running" | "completed" | "failed" | "cancelled";
export type JobType = "bash" | "task" | "eval";

export interface JobInfo {
  readonly id: string;
  readonly type: JobType;
  readonly status: JobStatus;
  readonly label: string;
  /** Epoch ms. The elapsed time is computed by the reader. */
  readonly startTime: number;
  readonly endTime?: number;
  /** Last progress line omp reported, cut to a short length. */
  readonly progressText?: string;
}

const JOB_TYPES: readonly string[] = ["bash", "task", "eval"];
const JOB_STATUSES: readonly string[] = ["running", "completed", "failed", "cancelled"];

export function isSubagentInfo(v: unknown): v is SubagentInfo {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    typeof v.viewId === "string" &&
    typeof v.agent === "string" &&
    (v.description === null || typeof v.description === "string") &&
    typeof v.status === "string" &&
    SUBAGENT_STATUSES.includes(v.status as SubagentStatus) &&
    typeof v.startedAt === "number" &&
    (v.endedAt === undefined || typeof v.endedAt === "number") &&
    typeof v.tokens === "number" &&
    (v.parentId === undefined || typeof v.parentId === "string")
  );
}

export function isJobInfo(v: unknown): v is JobInfo {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    typeof v.type === "string" &&
    JOB_TYPES.includes(v.type) &&
    typeof v.status === "string" &&
    JOB_STATUSES.includes(v.status) &&
    typeof v.label === "string" &&
    typeof v.startTime === "number" &&
    (v.endTime === undefined || typeof v.endTime === "number") &&
    (v.progressText === undefined || typeof v.progressText === "string")
  );
}

/** Whether a subagent in this status is still doing work (and can be killed). */
export const subagentLive = (status: SubagentStatus): boolean => status === "running";

/**
 * What `subagent.cancel` rejects with when omp failed to stop a subagent that is still running
 * afterwards. The window maps it to a sentence; the text itself is never shown.
 */
export const STOP_FAILED_MESSAGE = "could not stop subagent";

/** Result of `subagent.cancel` and `job.cancel`: false when it had already finished. */
export interface CancelResult {
  readonly cancelled: boolean;
}

export const isCancelResult = (v: unknown): v is CancelResult =>
  isRecord(v) && typeof v.cancelled === "boolean";
