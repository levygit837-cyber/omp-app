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

/**
 * Sessions carry no title yet, so the first line of the first prompt stands in for one.
 * Nothing is invented: until the user has said something it is "New session".
 */
export function sessionTitle(firstPrompt: string | undefined): string {
  const line = firstPrompt?.trim().split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ") ?? "";
  if (line.length === 0) return NEW_SESSION_TITLE;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
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

/** The state mark a session carries in the sidebar and its tab. */
export function sessionMark(status: SessionStatus | undefined): MarkState {
  if (status === "streaming") return "running";
  if (status === "failed") return "error";
  return "idle";
}
