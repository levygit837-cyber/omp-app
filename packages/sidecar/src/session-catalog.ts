import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FIRST_PROMPT_MAX, type StoredSession } from "@omp-app/protocol";

/** omp's placeholder for a session file with no message in it. */
const NO_MESSAGES = "(no messages)";

const tidy = (text: string | undefined): string | null => {
  const flat = text?.replace(/\s+/g, " ").trim();
  return flat ? flat : null;
};

function toStored(info: SessionInfo): StoredSession {
  const first = info.firstMessage === NO_MESSAGES ? null : tidy(info.firstMessage);
  return {
    id: info.id,
    cwd: info.cwd,
    title: tidy(info.title),
    firstPrompt: first === null ? null : first.slice(0, FIRST_PROMPT_MAX),
    modified: info.modified.getTime(),
    turns: info.assistantTurns ?? 0,
  };
}

/**
 * Sessions the CLI's own picker (`omp --resume`, all projects) lists, in its order: pinned
 * first, then newest. This path only reads: `listAllSessions` scans the bucket directories and
 * reads each file's head and tail (session-listing.ts:659-669 [V]). The one routine in that file
 * that renames files, `recoverOrphanedBackups`, is called only from the per-directory scan
 * (session-listing.ts:617 [V]), which this path does not use. So listing is safe in a
 * `read_only` sidecar and on the user's real `~/.omp`.
 *
 * Left out, as the picker leaves them out: 0-turn stubs that have no title and no prompt. Also
 * left out: files from very old omp versions that record no folder, because a session without a
 * folder has no project to sit under and cannot be resumed from here.
 */
export async function listStoredSessions(): Promise<StoredSession[]> {
  const infos = await SessionManager.listAllForPicker();
  return infos.filter((info) => info.cwd !== "").map(toStored);
}

/** One session by id, including the 0-turn stubs the picker hides. */
export async function findStoredSession(sessionId: string): Promise<StoredSession | undefined> {
  const info = (await SessionManager.listAll()).find((candidate) => candidate.id === sessionId);
  return info && info.cwd !== "" ? toStored(info) : undefined;
}
