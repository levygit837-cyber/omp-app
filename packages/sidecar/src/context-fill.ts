import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { getSessionCompactionBoundaries } from "@oh-my-pi/pi-coding-agent/session/context-usage-runtime";
import type { ContextFill } from "@omp-app/protocol";

/**
 * How full the session's context window is, as omp measures it, plus the token count at which
 * omp compacts by itself when auto-compaction is on.
 *
 * - `getContextUsage()` returns `{tokens, contextWindow, percent}` or undefined before omp can
 *   measure (`agent-session.ts:13525`, `session/session-stats.ts:383`). [V]
 * - `getSessionCompactionBoundaries(settings, window, model)` returns `{thresholdPercent, ...}`
 *   or null when compaction is off (`session/context-usage-runtime.ts:21`). [V] The status line
 *   calls it the same way (`modes/status-line-host.ts:67`).
 */
export function readContextFill(session: AgentSession): ContextFill | null {
  const usage = session.getContextUsage();
  if (!usage || !(usage.contextWindow > 0)) return null;
  const boundaries = getSessionCompactionBoundaries(
    session.settings,
    usage.contextWindow,
    session.model,
  );
  return {
    tokens: Math.round(usage.tokens),
    window: usage.contextWindow,
    ...(boundaries
      ? { compactAtTokens: Math.round((boundaries.thresholdPercent / 100) * usage.contextWindow) }
      : {}),
  };
}
