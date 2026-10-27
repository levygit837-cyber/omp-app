import { Caret } from "@omp-app/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useRef } from "react";
import { projectName } from "./format";
import { useCwd, useItem, useItemCount, useItemKind } from "./session-hooks";
import { useFollowBottom } from "./use-follow-bottom";

/** Height guess for a row that has not been measured yet; the measurement replaces it. */
const ESTIMATED_ROW = 96;
const OVERSCAN = 8;

/**
 * One row. It re-renders only when its own item changes (items keep identity otherwise).
 * The space above a row belongs to the row, so the virtualizer measures it: 64 before a
 * user message that opens a new turn, 20 between the events of a turn, none before the first.
 */
const Row = memo(function Row({ sessionId, index }: { sessionId: string; index: number }) {
  const item = useItem(sessionId, index);
  const previous = useItemKind(sessionId, index - 1);
  if (!item) return null;
  const gap =
    previous === undefined ? "" : item.kind === "user" ? "pt-(--space-turn)" : "pt-(--space-event)";
  return (
    <div className={gap} data-testid={`item-${item.kind}`}>
      {item.kind === "user" ? (
        <div className="flex justify-end">
          <p className="max-w-(--layout-user-band-max) rounded-sm bg-bg-user px-(--space-user-band-x) py-(--space-user-band-y) text-size-body leading-(--line-height-prose) break-words whitespace-pre-wrap">
            {item.text}
          </p>
        </div>
      ) : (
        <p
          data-done={item.done}
          className="text-size-body leading-(--line-height-prose) break-words whitespace-pre-wrap"
        >
          {item.text}
          {!item.done && <Caret />}
        </p>
      )}
    </div>
  );
});

/** A session with nothing said yet: the folder, and the question the design asks. */
function EmptySession({ sessionId }: { sessionId: string }) {
  const cwd = useCwd(sessionId);
  if (!cwd) return null;
  return (
    <div className="flex flex-col gap-(--space-10) pb-(--space-24)">
      <h1 className="text-size-title font-medium">What should omp do in {projectName(cwd)}?</h1>
      <p className="font-mono text-size-xs text-text-dim">{cwd}</p>
    </div>
  );
}

/**
 * The conversation, virtualized: only the rows near the viewport are in the DOM, however long
 * the session. Follows the end while the answer streams, until the user scrolls up.
 */
export function Timeline({ sessionId, resume }: { sessionId: string; resume: number }) {
  const count = useItemCount(sessionId);
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scroller.current,
    estimateSize: () => ESTIMATED_ROW,
    overscan: OVERSCAN,
    // The timeline is append-only, so the index is a stable identity.
    getItemKey: (index) => index,
  });
  const total = virtualizer.getTotalSize();
  useFollowBottom(scroller, total, resume);

  return (
    <div
      ref={scroller}
      role="log"
      aria-label="Conversation"
      data-testid="timeline"
      data-count={count}
      className="min-h-0 flex-1 overflow-y-auto px-(--space-48) pt-(--space-10)"
    >
      <div className="mx-auto flex min-h-full w-(--layout-chat-column) max-w-full flex-col justify-end">
        {count === 0 ? (
          <EmptySession sessionId={sessionId} />
        ) : (
          <div className="relative w-full" style={{ height: total }}>
            {virtualizer.getVirtualItems().map((row) => (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={row.index}
                className="absolute left-0 w-full"
                style={{ top: row.start }}
              >
                <Row sessionId={sessionId} index={row.index} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
