import { subagentLive } from "@omp-app/protocol";
import { cx, StateMark } from "@omp-app/ui";
import { useMemo } from "react";
import { statusNote, subagentMark, subagentName, subagentTree } from "./delegation-view";
import { useSubagents } from "./session-hooks";
import { useNow } from "./timeline/use-now";
import { showTab } from "./use-tabs";

/**
 * The subagents of an open session, nested under its row (Pen `ZBxmu`): never sessions of their
 * own. A subagent started by another hangs under it. Picking one focuses the parent session and
 * shows that subagent's tab.
 */
export function SubagentRows({
  sessionId,
  shown,
  onSelect,
}: {
  sessionId: string;
  /** Id of the subagent whose tab is on screen in this session, if any. */
  shown: string | null;
  onSelect: (sessionId: string) => void;
}) {
  const subagents = useSubagents(sessionId);
  const rows = useMemo(() => subagentTree(subagents), [subagents]);
  const live = subagents.some((s) => subagentLive(s.status));
  const now = useNow(live);
  if (rows.length === 0) return null;
  return (
    <ul aria-label="Subagents" className="flex flex-col gap-(--space-2) pb-(--space-2)">
      {rows.map(({ sub, depth, last }) => {
        const mark = subagentMark(sub.status);
        const name = subagentName(sub);
        const note = statusNote(sub.status, sub.startedAt, sub.endedAt, now);
        return (
          <li key={sub.id}>
            <button
              type="button"
              data-testid="subagent-row"
              data-subagent-id={sub.id}
              data-status={sub.status}
              aria-current={shown === sub.id ? "true" : undefined}
              aria-label={`${name}, ${mark.label}`}
              onClick={() => {
                onSelect(sessionId);
                showTab(sessionId, { kind: "subagent", id: sub.id });
              }}
              style={{ paddingLeft: `calc(var(--space-30) + ${depth} * var(--space-18))` }}
              className={cx(
                "flex w-full items-center gap-(--space-8) rounded-sm py-(--space-4) pr-(--space-8) text-left text-size-sm hover:bg-bg-hover",
                shown === sub.id ? "bg-bg-selected text-text-primary" : "text-text-secondary",
              )}
            >
              <span aria-hidden="true" className="w-(--space-12) shrink-0 font-mono text-text-dim">
                {last ? "└" : "├"}
              </span>
              <StateMark state={mark.mark} decorative />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              {note !== "" && (
                <span className="shrink-0 font-mono text-size-2xs text-text-dim">{note}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
