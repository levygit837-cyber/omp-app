import {
  type JobInfo,
  type JobStatus,
  type SubagentInfo,
  type SubagentStatus,
  subagentLive,
} from "@omp-app/protocol";
import type { MarkState } from "@omp-app/ui";
import { clock } from "./format";

/**
 * What the center column can show for a session. The main chat is always there; subagents and
 * background jobs come and go with what omp reports; a file is there while the person keeps it
 * open. A new kind (a browser) is one more member here and one more case in `describeTab` and in
 * the panel that renders it: the compiler lists every place that needs it.
 */
export type TabRef =
  | { readonly kind: "main" }
  | { readonly kind: "subagent"; readonly id: string }
  | { readonly kind: "job"; readonly id: string }
  /** A file of the session's folder, read-only. `path` is relative to that folder. */
  | { readonly kind: "file"; readonly path: string };

export const MAIN_TAB: TabRef = { kind: "main" };

/** Stable identity of a tab, for equality, DOM ids and the dismissed set. */
export function tabKey(ref: TabRef): string {
  switch (ref.kind) {
    case "main":
      return "main";
    case "subagent":
      return `subagent:${ref.id}`;
    case "job":
      return `job:${ref.id}`;
    case "file":
      return `file:${ref.path}`;
    default:
      return ref satisfies never;
  }
}

/** DOM id of a tab, so its panel can name it. */
export const tabDomId = (ref: TabRef): string => `tab-${tabKey(ref).replace(/[^a-z0-9_-]/gi, "_")}`;

export interface Delegation {
  readonly subagents: readonly SubagentInfo[];
  readonly jobs: readonly JobInfo[];
}

/**
 * The tabs of a session, in order: the chat, its subagents as they started, its jobs, then the
 * files the person opened, in the order they were opened.
 */
export function tabsOf(
  delegation: Delegation,
  dismissed: ReadonlySet<string>,
  files: readonly string[] = [],
): TabRef[] {
  const tabs: TabRef[] = [MAIN_TAB];
  for (const sub of delegation.subagents) {
    const ref: TabRef = { kind: "subagent", id: sub.id };
    if (!dismissed.has(tabKey(ref))) tabs.push(ref);
  }
  for (const job of delegation.jobs) {
    const ref: TabRef = { kind: "job", id: job.id };
    if (!dismissed.has(tabKey(ref))) tabs.push(ref);
  }
  for (const path of files) tabs.push({ kind: "file", path });
  return tabs;
}

/**
 * The tab that is really shown: the one asked for while it still exists, else the chat. A job
 * that falls out of omp's recent list, or a tab that was dismissed, must not leave a blank panel.
 */
export function resolveTab(tabs: readonly TabRef[], wanted: TabRef | undefined): TabRef {
  if (!wanted) return MAIN_TAB;
  const key = tabKey(wanted);
  return tabs.find((tab) => tabKey(tab) === key) ?? MAIN_TAB;
}

/**
 * Roving focus over a tab list: Left/Right move with wrap, Home/End jump. Returns the key of the
 * tab to focus, or null when the key is not a tab-list key.
 */
export function moveTab(keys: readonly string[], current: string, key: string): string | null {
  const at = keys.indexOf(current);
  if (keys.length === 0) return null;
  switch (key) {
    case "ArrowRight":
      return keys[(at + 1) % keys.length] ?? null;
    case "ArrowLeft":
      return keys[(at <= 0 ? keys.length : at) - 1] ?? null;
    case "Home":
      return keys[0] ?? null;
    case "End":
      return keys.at(-1) ?? null;
    default:
      return null;
  }
}

/** A mark and the words for it. The words are the accessible name; shape carries the meaning. */
export interface Mark {
  readonly mark: MarkState;
  readonly label: string;
}

export function subagentMark(status: SubagentStatus): Mark {
  switch (status) {
    case "running":
      return { mark: "running", label: "Running" };
    case "completed":
      return { mark: "idle", label: "Finished" };
    case "failed":
      return { mark: "error", label: "Failed" };
    case "aborted":
      return { mark: "idle", label: "Stopped" };
    default:
      return status satisfies never;
  }
}

export function jobMark(status: JobStatus): Mark {
  switch (status) {
    case "running":
      return { mark: "running", label: "Running" };
    case "completed":
      return { mark: "idle", label: "Finished" };
    case "failed":
      return { mark: "error", label: "Failed" };
    case "cancelled":
      return { mark: "idle", label: "Cancelled" };
    default:
      return status satisfies never;
  }
}

/** What a subagent is called: the description its parent gave it, else its agent. */
export const subagentName = (sub: SubagentInfo): string => sub.description?.trim() || sub.agent;

/** What a job is called: its label, which for a shell job is the command. */
export const jobName = (job: JobInfo): string => job.label.trim() || job.type;

/** A node of the subagent tree with its depth, in the order a list shows it. */
export interface TreeRow {
  readonly sub: SubagentInfo;
  readonly depth: number;
  /** Last among its siblings: its connector ends instead of continuing. */
  readonly last: boolean;
}

/**
 * Subagents as a tree under their parent: a subagent started by another one hangs under it.
 * One whose parent is not in the list (the parent was never seen) is a root, so nothing vanishes.
 */
export function subagentTree(subagents: readonly SubagentInfo[]): TreeRow[] {
  const byId = new Map(subagents.map((s) => [s.id, s]));
  // A parent counts only if following parents from it never comes back to the child: members of
  // a cycle omp reported become roots instead of disappearing.
  const loops = (sub: SubagentInfo): boolean => {
    const seen = new Set([sub.id]);
    for (let at = byId.get(sub.parentId ?? ""); at; at = byId.get(at.parentId ?? "")) {
      if (seen.has(at.id)) return true;
      seen.add(at.id);
    }
    return false;
  };
  const children = new Map<string | undefined, SubagentInfo[]>();
  for (const sub of subagents) {
    const parent =
      sub.parentId !== undefined && byId.has(sub.parentId) && !loops(sub)
        ? sub.parentId
        : undefined;
    const siblings = children.get(parent) ?? [];
    siblings.push(sub);
    children.set(parent, siblings);
  }
  const rows: TreeRow[] = [];
  const walk = (parent: string | undefined, depth: number, seen: ReadonlySet<string>) => {
    const siblings = children.get(parent) ?? [];
    siblings.forEach((sub, index) => {
      if (seen.has(sub.id)) return;
      rows.push({ sub, depth, last: index === siblings.length - 1 });
      walk(sub.id, depth + 1, new Set(seen).add(sub.id));
    });
  };
  walk(undefined, 0, new Set());
  return rows;
}

/** How much delegated work is going on, for the strip above the input bar. */
export interface DelegationSummary {
  readonly subagentsRunning: number;
  readonly subagentsTotal: number;
  readonly jobsRunning: readonly JobInfo[];
}

export function summarize(delegation: Delegation): DelegationSummary {
  return {
    subagentsRunning: delegation.subagents.filter((s) => subagentLive(s.status)).length,
    subagentsTotal: delegation.subagents.length,
    jobsRunning: delegation.jobs.filter((j) => j.status === "running"),
  };
}

/** Whether anything is still working: the strip shows only then (finished work is silent). */
export const isBusy = (s: DelegationSummary): boolean =>
  s.subagentsRunning > 0 || s.jobsRunning.length > 0;

/** `1 of 2 subagents`, or `2 subagents` when all of them run; singular for one. */
export function subagentsPhrase(s: DelegationSummary): string | null {
  if (s.subagentsRunning === 0) return null;
  const noun = s.subagentsTotal === 1 ? "subagent" : "subagents";
  return s.subagentsRunning === s.subagentsTotal
    ? `${s.subagentsRunning} ${noun}`
    : `${s.subagentsRunning} of ${s.subagentsTotal} ${noun}`;
}

/**
 * The short word or time at the end of a row: a running thing shows how long it has run, a
 * finished one how long it took, a failed or stopped one says so in words (never color alone).
 */
export function statusNote(
  status: SubagentStatus | JobStatus,
  startedAt: number,
  endedAt: number | undefined,
  now: number,
): string {
  switch (status) {
    case "failed":
      return "failed";
    case "aborted":
      return "stopped";
    case "cancelled":
      return "cancelled";
    case "running":
      return clock(now - startedAt);
    case "completed":
      return endedAt === undefined ? "" : clock(endedAt - startedAt);
    default:
      return status satisfies never;
  }
}

/** Tokens as the design writes counts: 950, 12.4k. */
export function tokensLabel(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}
