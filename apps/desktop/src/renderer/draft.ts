import { MAX_IMAGES_PER_PROMPT, type QueueName } from "@omp-app/protocol";
import type { DraftImage } from "./draft-images";

/** What the person has in the input bar and has not sent. */
export interface Draft {
  readonly text: string;
  readonly files: readonly string[];
  readonly images: readonly DraftImage[];
}

export const EMPTY_DRAFT: Draft = { text: "", files: [], images: [] };

/**
 * Puts a draft that was not accepted back in the bar. What was sent comes first and what was
 * typed since follows, so nothing of either is lost; images beyond the limit stay out.
 */
export function restoreDraft(current: Draft, sent: Draft): Draft {
  const text = [sent.text, current.text].filter((part) => part !== "").join("\n");
  const files = [...sent.files, ...current.files.filter((path) => !sent.files.includes(path))];
  const ids = new Set(sent.images.map((image) => image.id));
  const images = [...sent.images, ...current.images.filter((image) => !ids.has(image.id))].slice(
    0,
    MAX_IMAGES_PER_PROMPT,
  );
  return { text, files, images };
}

/** Queued messages that came back (a stop) go in front of what is typed, one per line. */
export function withQueuedText(text: string, texts: readonly string[]): string {
  return [...texts, text].filter((part) => part !== "").join("\n");
}

/**
 * The text of a message that joins a running turn. omp reads `@` files only for a prompt that
 * starts a turn (`#prompt`, `agent-session.ts:8482` [V]; `joinActiveTurn` queues the raw text,
 * `:8905-8960` [V]), so a chosen file would be a dead reference there: it goes as a plain path,
 * which the agent can still open itself.
 */
export function joinedText(text: string, files: readonly string[]): string {
  return [text.trim(), ...files].filter((part) => part !== "").join(" ");
}

/**
 * The sentence under the bar after a stop. `count` queued messages came back; `stuck` could not
 * (see `stuckOnStop`) and stay queued in omp until the next message goes out.
 */
export function restoredNote(count: number, stuck = 0): string {
  const back =
    count === 0
      ? "Stopped."
      : count === 1
        ? "Stopped. The queued message is back in the input."
        : `Stopped. ${count} queued messages are back in the input.`;
  if (stuck === 0) return back;
  return stuck === 1
    ? `${back} 1 repeats a message omp already took, so it stays queued and goes out with your next message.`
    : `${back} ${stuck} repeat messages omp already took, so they stay queued and go out with your next message.`;
}

/**
 * Stop: asks `remove` to take each queued message back and returns the texts it did. A removal
 * that throws (the message was delivered meanwhile) or says no is skipped; the rest still go.
 */
export async function takeBackQueued(
  entries: readonly { queue: QueueName; text: string }[],
  remove: (queue: QueueName, text: string) => Promise<boolean>,
): Promise<string[]> {
  const back: string[] = [];
  for (const entry of entries) {
    try {
      if (await remove(entry.queue, entry.text)) back.push(entry.text);
    } catch {
      // The queue moved on while stopping: Stop still goes ahead.
    }
  }
  return back;
}

/** What happens to the draft, as one pure step so each case can be tested. */
export type DraftEvent =
  | { readonly type: "sent" }
  /** The prompt was refused: everything that was sent comes back. */
  | { readonly type: "rejected"; readonly sent: Draft }
  /** Stop took queued messages back out of omp. */
  | { readonly type: "stopped"; readonly back: readonly string[] };

export function draftAfter(draft: Draft, event: DraftEvent): Draft {
  switch (event.type) {
    case "sent":
      return EMPTY_DRAFT;
    case "rejected":
      return restoreDraft(draft, event.sent);
    case "stopped":
      return event.back.length === 0
        ? draft
        : { ...draft, text: withQueuedText(draft.text, event.back) };
  }
}
