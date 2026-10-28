import { Chip } from "@omp-app/ui";
import { queueRows } from "./prompt-input";
import { message } from "./session-controller";
import { useQueue } from "./session-hooks";

const KIND_WORD = { steering: "steer", followUp: "after" } as const;

/**
 * What is waiting for the agent, above the input: steers not yet sent into the response, then the
 * follow-ups for after the turn. An entry can be removed only while omp still holds it; a steer
 * already sent into the response is shown as sent and has no button (`liveSteered`).
 */
export function QueueStrip({
  sessionId,
  onError,
}: {
  sessionId: string;
  onError: (text: string) => void;
}) {
  const queue = useQueue(sessionId);
  const rows = queue ? queueRows(queue) : [];
  if (rows.length === 0) return null;
  return (
    <ul
      data-testid="queue-strip"
      aria-label="Queued messages"
      className="flex flex-wrap gap-(--space-6)"
    >
      {rows.map((row) => (
        <li key={row.key} aria-label={`${KIND_WORD[row.queue]}: ${row.text}`}>
          <Chip
            muted={!row.removable}
            icon={<span className="text-size-2xs text-text-dim">{KIND_WORD[row.queue]}</span>}
            removeLabel={`Remove queued message: ${row.text}`}
            onRemove={
              row.removable
                ? () => {
                    window.omp.session
                      .removeQueued(sessionId, row.queue, row.text)
                      .catch((e: unknown) => onError(message(e)));
                  }
                : undefined
            }
          >
            {row.text.replace(/\s+/g, " ")}
          </Chip>
        </li>
      ))}
    </ul>
  );
}
