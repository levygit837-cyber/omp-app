import type { SessionStatus } from "@omp-app/protocol";
import type { MarkState } from "@omp-app/ui";

/** Last path segment, for either separator. A bare root ("/") has none and yields "". */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut === -1 ? trimmed : trimmed.slice(cut + 1);
}

/** The project a session belongs to: its folder name, or the whole path for a root. */
export function projectName(cwd: string): string {
  return basename(cwd) || cwd;
}

export const NEW_SESSION_TITLE = "New session";
const TITLE_MAX = 48;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Sessions carry no title yet, so the first line of the first prompt stands in for one.
 * Nothing is invented: until the user has said something it is "New session".
 */
export function sessionTitle(firstPrompt: string | undefined): string {
  const line = firstPrompt?.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ") ?? "";
  if (line.length === 0) return NEW_SESSION_TITLE;
  // Grapheme clusters, not UTF-16 units or code points: a cut must not split a flag, a ZWJ
  // family or a letter with its combining mark.
  const graphemes = Array.from(GRAPHEMES.segment(line), (part) => part.segment);
  return graphemes.length > TITLE_MAX
    ? `${graphemes
        .slice(0, TITLE_MAX - 1)
        .join("")
        .trimEnd()}…`
    : line;
}

/** `provider/id` shown as the id alone, as in the design. Null when the session has no model. */
export function modelLabel(model: string | null | undefined): string | null {
  if (!model) return null;
  return model.slice(model.lastIndexOf("/") + 1);
}

/** m:ss. Negative input counts as zero. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  return `${Math.floor(total / 60)}:${seconds}`;
}

/** The state mark a session carries in the sidebar and its tab. A question waiting outranks the rest. */
export function sessionMark(status: SessionStatus | undefined, waiting = false): MarkState {
  if (waiting) return "approval";
  if (status === "streaming") return "running";
  if (status === "failed") return "error";
  return "idle";
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago `modified` was, in the shortest unit that fits: now, 5m, 3h, 2d, 3w, 8mo, 2y. */
export function relativeTime(modified: number, now: number): string {
  const age = Math.max(0, now - modified);
  if (age < MINUTE) return "now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h`;
  if (age < 7 * DAY) return `${Math.floor(age / DAY)}d`;
  if (age < 30 * DAY) return `${Math.floor(age / (7 * DAY))}w`;
  if (age < 365 * DAY) return `${Math.floor(age / (30 * DAY))}mo`;
  return `${Math.floor(age / (365 * DAY))}y`;
}
