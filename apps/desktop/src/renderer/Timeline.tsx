import type { AssistantItem, Item } from "@omp-app/protocol";
import { Caret, Markdown } from "@omp-app/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useRef } from "react";
import { DecisionLine } from "./DecisionLine";
import { projectName } from "./format";
import { useCwd, useItem, useItemCount, useItemKind } from "./session-hooks";
import { useShownStatus } from "./shown-status";
import { CompactionLine, compactionVisible, RetryLine } from "./timeline/StatusLines";
import { ThinkingLine } from "./timeline/ThinkingLine";
import { ToolLine } from "./timeline/ToolLine";
import { UserMessage } from "./timeline/UserMessage";
import { useFollowBottom } from "./use-follow-bottom";

/** Height guess for a row that has not been measured yet; the measurement replaces it. */
const ESTIMATED_ROW = 96;
const OVERSCAN = 8;

/** Lines of the agent's work sit close together; a reply or a new turn gets more air. */
const WORK_KINDS: Record<string, true> = { tool: true, thinking: true, retry: true };

function gapBefore(previous: Item["kind"] | undefined, kind: Item["kind"]): string {
  if (previous === undefined) return "";
  if (kind === "user") return "pt-(--space-turn)";
  if (WORK_KINDS[previous] === true && WORK_KINDS[kind] === true) return "pt-(--space-tool-step)";
  return "pt-(--space-event)";
}

/** Links in a reply never navigate the window: main checks the address and opens the system browser. */
const openLink = (url: string) => void window.omp.app.openLink(url);

/** The reply. The caret shows only while it is the open message of a run that is really streaming. */
function Reply({ sessionId, item }: { sessionId: string; item: AssistantItem }) {
  const streaming = useShownStatus(sessionId) === "streaming" && !item.done;
  return (
    <div data-done={item.done} className="text-size-body leading-(--line-height-prose) break-words">
      {item.text === "" ? (
        streaming && <Caret />
      ) : (
        <Markdown text={item.text} streaming={streaming} onOpenLink={openLink} />
      )}
    </div>
  );
}

function Body({ sessionId, item }: { sessionId: string; item: Item }) {
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} />;
    case "assistant":
      return <Reply sessionId={sessionId} item={item} />;
    case "tool":
      return <ToolLine sessionId={sessionId} item={item} />;
    case "thinking":
      return <ThinkingLine sessionId={sessionId} item={item} />;
    case "compaction":
      return <CompactionLine sessionId={sessionId} item={item} />;
    case "retry":
      return <RetryLine sessionId={sessionId} item={item} />;
    case "decision":
      return <DecisionLine item={item} />;
    default:
      // A new item kind without a case here fails the typecheck instead of rendering nothing.
      return item satisfies never;
  }
}

/**
 * One row. It re-renders only when its own item changes (items keep identity otherwise).
 * The space above a row belongs to the row, so the virtualizer measures it: 64 before a
 * user message that opens a new turn, 6 between lines of work, 20 between other events, none
 * before the first.
 */
const Row = memo(function Row({ sessionId, index }: { sessionId: string; index: number }) {
  const item = useItem(sessionId, index);
  const previous = useItemKind(sessionId, index - 1);
  if (!item || (item.kind === "compaction" && !compactionVisible(item))) return null;
  return (
    <div className={gapBefore(previous, item.kind)} data-testid={`item-${item.kind}`}>
      <Body sessionId={sessionId} item={item} />
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
          // Rows mount and unmount as the user scrolls, so this container must not be read out:
          // the `Announcer` speaks at transitions instead. `aria-live="off"` here wins over the
          // polite region that `role="log"` implies for its descendants.
          <div aria-live="off" className="relative w-full" style={{ height: total }}>
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
