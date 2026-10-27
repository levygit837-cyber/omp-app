import type { ThinkingItem } from "@omp-app/protocol";
import { ChevronDownIcon, ChevronRightIcon, ThinkingGlyph } from "@omp-app/ui";
import { useShownStatus } from "../shown-status";
import { formatDuration, formatElapsed, thinkingGist, tokensPerSecond } from "../tool-phrases";
import { useOpened } from "./opened";
import { useNow } from "./use-now";

/**
 * Reasoning. Alive: the turning glyph, "Thinking", a timer in mono and, once it has settled, the
 * tok/s the provider reports. Done: one event, "Thought for 8s" and the first line of the
 * reasoning, collapsed; the word is never repeated in the expanded text.
 */
export function ThinkingLine({ sessionId, item }: { sessionId: string; item: ThinkingItem }) {
  const streaming = useShownStatus(sessionId) === "streaming";
  const live = !item.done && streaming;
  const now = useNow(live);
  const [open, toggle] = useOpened(item.id);
  const gist = thinkingGist(item.text);
  const ended = item.endedAt ?? now;
  const spent = Math.max(0, ended - item.startedAt);
  const rate = live ? tokensPerSecond(item, now) : undefined;
  const expandable = !live && item.text.trim() !== "";
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;

  const header = live ? (
    <>
      <span className="text-text-primary">Thinking</span>
      <span className="font-mono text-size-sm text-text-primary"> {formatElapsed(spent)}</span>
      {rate !== undefined && <span className="text-text-dim">{` · ${rate} tok/s`}</span>}
    </>
  ) : (
    <span className="text-text-primary">{`Thought for ${formatDuration(spent)}`}</span>
  );

  return (
    <div data-testid="thinking-line" data-live={live}>
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex min-h-(--size-tool-row) w-full items-start gap-(--space-icon-phrase) rounded-sm text-left text-size-md leading-(--line-height-ui)"
        >
          <ThinkingGlyph className="text-icon-neutral" />
          <span className="shrink-0">{header}</span>
          {gist && !open && <span className="min-w-0 truncate text-text-dim">{`· ${gist}`}</span>}
          <Chevron
            aria-hidden="true"
            className="size-(--size-icon-ui) shrink-0 self-center text-text-dim"
          />
        </button>
      ) : (
        <div className="flex min-h-(--size-tool-row) items-start gap-(--space-icon-phrase) text-size-md leading-(--line-height-ui)">
          <ThinkingGlyph live={live} />
          <span className="min-w-0 break-words">{header}</span>
        </div>
      )}
      {live && gist && (
        <p className="pl-(--space-output-indent) text-size-md leading-(--line-height-ui) break-words text-text-dim">
          {`…${gist.slice(-120)}`}
        </p>
      )}
      {open && expandable && (
        <p className="pt-(--space-event-inner) pl-(--space-output-indent) text-size-md leading-(--line-height-prose) break-words whitespace-pre-wrap text-text-dim">
          {item.text.trim()}
        </p>
      )}
    </div>
  );
}
