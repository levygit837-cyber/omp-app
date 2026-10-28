import type { BoundaryItem, CompactionItem, RetryItem } from "@omp-app/protocol";
import { StateMark } from "@omp-app/ui";
import { wallClock } from "../format";
import { useShownStatus } from "../shown-status";
import { formatDuration } from "../tool-phrases";
import { compactionSize } from "./compaction-text";
import { useOpened } from "./opened";
import { useNow } from "./use-now";

const LINE =
  "flex min-h-(--size-tool-row) items-start gap-(--space-icon-phrase) text-size-md leading-(--line-height-ui)";
const MARK_CELL = "flex size-(--size-icon-tool) shrink-0 items-center justify-center";

/** A compaction that did nothing leaves no trace in the timeline. */
export function compactionVisible(item: CompactionItem): boolean {
  return item.state !== "skipped";
}

/**
 * The boundary where the agent's memory was summarized (frame `LYUPo`, B): a rule with the words
 * on it, then what the agent keeps. Running, it is a line with the arc like any long tool.
 */
export function CompactionLine({ sessionId, item }: { sessionId: string; item: CompactionItem }) {
  const streaming = useShownStatus(sessionId) === "streaming";
  const [open, toggle] = useOpened(item.id);
  const state = item.state === "running" && !streaming ? "aborted" : item.state;

  if (state === "running") {
    return (
      <div data-testid="compaction-line" data-state="running" className={LINE}>
        <span className={MARK_CELL}>
          <StateMark state="running" decorative />
        </span>
        <span>Compacting context…</span>
      </div>
    );
  }
  if (state === "failed" || state === "aborted") {
    return (
      <div data-testid="compaction-line" data-state={state} className={LINE}>
        <span className={MARK_CELL}>
          <StateMark state={state === "failed" ? "error" : "idle"} decorative />
        </span>
        <span className="min-w-0 break-words">
          <span className="text-text-primary">
            {state === "failed" ? "Couldn’t compact the context" : "Compaction stopped"}
          </span>
          {item.error && <span className="text-text-dim">{` · ${item.error}`}</span>}
        </span>
      </div>
    );
  }
  return (
    <div
      data-testid="compaction-line"
      data-state="done"
      className="flex flex-col items-center gap-(--space-4)"
    >
      <div className="flex w-full items-center gap-(--space-12) text-size-md text-text-secondary">
        <span aria-hidden="true" className="h-px flex-1 bg-border-hairline" />
        <span>
          Context compacted
          {compactionSize(item) && (
            <span className="text-text-dim">{` · ${compactionSize(item)}`}</span>
          )}
        </span>
        <span aria-hidden="true" className="h-px flex-1 bg-border-hairline" />
      </div>
      <p className="text-size-sm text-text-dim">
        The agent keeps a summary of everything above.
        {item.summary && (
          <>
            {" "}
            <button
              type="button"
              aria-expanded={open}
              onClick={toggle}
              className="rounded-sm text-text-secondary underline"
            >
              {open ? "Hide summary" : "Read summary"}
            </button>
          </>
        )}
      </p>
      {open && item.summary && (
        <p className="w-full text-size-md leading-(--line-height-prose) break-words whitespace-pre-wrap text-text-dim">
          {item.summary}
        </p>
      )}
    </div>
  );
}

/** Provider failed and omp tries again: the reason, the countdown, then one quiet line. */
export function RetryLine({ sessionId, item }: { sessionId: string; item: RetryItem }) {
  const streaming = useShownStatus(sessionId) === "streaming";
  const waiting = item.state === "waiting" && streaming;
  const now = useNow(waiting);
  const state = item.state === "waiting" && !streaming ? "cancelled" : item.state;

  if (waiting) {
    const left = Math.max(0, item.retryAt - now);
    return (
      <div data-testid="retry-line" data-state="waiting" className={LINE}>
        <span className={MARK_CELL}>
          <StateMark state="running" decorative />
        </span>
        <span className="min-w-0 break-words">
          <span className="text-text-primary">{`Retrying in ${formatDuration(Math.ceil(left / 1000) * 1000)}`}</span>
          <span className="text-text-dim">{` · attempt ${item.attempt} of ${item.maxAttempts} · ${item.error}`}</span>
        </span>
      </div>
    );
  }
  const text =
    state === "recovered"
      ? `Recovered after ${item.attempt} ${item.attempt === 1 ? "attempt" : "attempts"}`
      : state === "failed"
        ? `Gave up after ${item.attempt} of ${item.maxAttempts} attempts`
        : "Retry stopped";
  return (
    <div data-testid="retry-line" data-state={state} className={LINE}>
      <span className={MARK_CELL}>
        <StateMark state={state === "failed" ? "error" : "idle"} decorative />
      </span>
      <span className="min-w-0 break-words">
        <span className="text-text-primary">{text}</span>
        <span className="text-text-dim">{` · ${item.error}`}</span>
      </span>
    </div>
  );
}

/**
 * Where the agent's memory was cleared: a quiet rule with the words and the time on it. The
 * lines above stay on screen and in the session file; the agent no longer sees them. No Pen frame
 * draws it, so it borrows the rule of the compaction line.
 */
export function BoundaryLine({ item }: { item: BoundaryItem }) {
  return (
    <div
      data-testid="boundary-line"
      className="flex w-full items-center gap-(--space-12) text-size-md text-text-secondary"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-border-hairline" />
      <span>
        Context cleared
        <time dateTime={new Date(item.at).toISOString()} className="text-text-dim">
          {` · ${wallClock(item.at)}`}
        </time>
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-border-hairline" />
    </div>
  );
}
