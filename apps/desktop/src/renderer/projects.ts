import type { StoredSession } from "@omp-app/protocol";
import { sessionTitle } from "./format";

/** One sidebar row. */
export interface SessionRowData {
  readonly id: string;
  readonly cwd: string;
  /** Null for a session that is open but not on disk yet: the row reads its title from the replica. */
  readonly title: string | null;
  /** Last activity, epoch ms. Null for a session not on disk yet. */
  readonly modified: number | null;
}

export interface ProjectGroup {
  readonly cwd: string;
  readonly sessions: readonly SessionRowData[];
}

/**
 * Every session the sidebar shows: the open ones the disk listing does not have yet (a new
 * session has no turn, and omp's picker hides those) first, then those on disk in the order the
 * sidecar sent them, which is omp's picker order: pinned first, then newest. `openCwds` maps
 * each open session id to its folder.
 */
export function buildRows(
  stored: readonly StoredSession[],
  openCwds: ReadonlyMap<string, string>,
): SessionRowData[] {
  const listed = new Set(stored.map((s) => s.id));
  const fresh: SessionRowData[] = [];
  for (const [id, cwd] of openCwds) {
    if (!listed.has(id)) fresh.push({ id, cwd, title: null, modified: null });
  }
  return [
    ...fresh,
    ...stored.map((s) => ({
      id: s.id,
      cwd: s.cwd,
      title: s.title ?? sessionTitle(s.firstPrompt ?? undefined),
      modified: s.modified,
    })),
  ];
}

/**
 * Groups rows by folder without re-sorting: a folder sits where its first row is and rows keep
 * their order inside it, so omp's pinned-first order survives (the app has no pin data of its own
 * to rebuild it from).
 */
export function groupProjects(rows: readonly SessionRowData[]): ProjectGroup[] {
  const byCwd = new Map<string, SessionRowData[]>();
  for (const row of rows) {
    const group = byCwd.get(row.cwd);
    if (group) group.push(row);
    else byCwd.set(row.cwd, [row]);
  }
  return [...byCwd].map(([cwd, sessions]) => ({ cwd, sessions }));
}

/** The folders to offer when no session is open: the first ones in list order. */
export function recentFolders(rows: readonly SessionRowData[], limit: number): string[] {
  return groupProjects(rows)
    .slice(0, limit)
    .map((group) => group.cwd);
}

/**
 * A label per folder: its name, with parent folders added only where two folders share a name
 * (`work/app` and `play/app`), so the label alone tells them apart.
 */
export function projectLabels(cwds: readonly string[]): Map<string, string> {
  const unique = [...new Set(cwds)];
  const parts = new Map(unique.map((cwd) => [cwd, cwd.split(/[\\/]/).filter(Boolean)]));
  const depth = new Map(unique.map((cwd) => [cwd, 1]));
  const label = (cwd: string): string => {
    const segments = parts.get(cwd) ?? [];
    return segments.length === 0 ? cwd : segments.slice(-(depth.get(cwd) ?? 1)).join("/");
  };
  for (;;) {
    const seen = new Map<string, string[]>();
    for (const cwd of unique) seen.set(label(cwd), [...(seen.get(label(cwd)) ?? []), cwd]);
    let grew = false;
    for (const same of seen.values()) {
      if (same.length < 2) continue;
      for (const cwd of same) {
        if ((depth.get(cwd) ?? 1) < (parts.get(cwd)?.length ?? 0)) {
          depth.set(cwd, (depth.get(cwd) ?? 1) + 1);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  return new Map(unique.map((cwd) => [cwd, label(cwd)]));
}
