import {
  type Delivery,
  IMAGE_MIME_TYPES,
  isImageMimeType,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_PROMPT,
  MAX_TOTAL_IMAGE_BYTES,
  type ModelOption,
  type QueueName,
  type QueueState,
} from "@omp-app/protocol";

/**
 * Where a key press in the prompt field sends the prompt, or null when it sends nothing.
 *
 * The TUI sends a plain Enter typed during a turn as a steer and uses a separate chord for a
 * follow-up (`input-controller.ts` `#submitToFocusedSession`, `app.message.followUp` = ctrl+enter
 * [S]); the bar does the same with Ctrl/Cmd+Enter. Shift+Enter is a newline, and an Enter that
 * confirms an IME composition is not a submit.
 */
export function deliveryForKey(event: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly isComposing: boolean;
}): Delivery | null {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return null;
  return event.metaKey || event.ctrlKey ? "followUp" : "steer";
}

/** What the bar tells the person about the two gestures while the agent works. */
export function deliveryHint(mac: boolean): string {
  return `Enter steers · ${mac ? "⌘" : "Ctrl+"}Enter queues`;
}

/** An `@` reference being typed: the span of `text` it covers and what follows the `@`. */
export interface Mention {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/**
 * The reference under the caret, or null. An `@` starts one only at the start of the text or
 * after whitespace (an e-mail address is not a reference), and it ends at the first whitespace.
 */
export function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before.charAt(at - 1))) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, end: caret, query };
}

/** Whether two readings of the caret are the same reference (same `@` and same text after it). */
export function sameMention(a: Mention | null, b: Mention | null): boolean {
  return a !== null && b !== null && a.start === b.start && a.query === b.query;
}

/** `text` without the reference being typed, and where the caret goes. */
export function withoutMention(text: string, mention: Mention): { text: string; caret: number } {
  return {
    text: text.slice(0, mention.start) + text.slice(mention.end),
    caret: mention.start,
  };
}

/**
 * The text omp reads a file reference from: `@path`, quoted when the path has a space (omp takes
 * `@"a b"`, `file-mentions.ts` FILE_MENTION_REGEX [V]). Null for a path no `@` form can carry.
 */
export function mentionToken(path: string): string | null {
  if (/["\n\r]/.test(path)) return null;
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/** The prompt as sent: what was typed, then the chosen files as `@` references. */
export function promptText(text: string, files: readonly string[]): string {
  const tokens = files.flatMap((path) => mentionToken(path) ?? []);
  const typed = text.trim();
  return [typed, ...tokens].filter((part) => part !== "").join(" ");
}

export interface QueueRow {
  readonly key: string;
  readonly queue: QueueName;
  readonly text: string;
  /** False once omp has sent a steer into the response being streamed. */
  readonly removable: boolean;
}

/**
 * The rows of the queue strip, in the order omp delivers them: steering first, then follow-ups.
 *
 * omp removes a queued message by its text and takes the FIRST match of the queue
 * (`#findQueuedUserMessage`, `agent-session.ts:10022` [V]); it has no index or identity to remove
 * by. So only the first entry of a text is removable: removing a later duplicate would silently
 * take the earlier one, and a steer already sent into the response (`liveSteered`) would match
 * before a later entry with the same text.
 */
export function queueRows(queue: QueueState): QueueRow[] {
  const rows = (name: QueueName, texts: readonly string[], live: number): QueueRow[] =>
    texts.map((text, index) => ({
      key: `${name}:${index}`,
      queue: name,
      text,
      removable: index >= live && texts.indexOf(text) === index,
    }));
  return [
    ...rows("steering", queue.steering, queue.liveSteered),
    ...rows("followUp", queue.followUp, 0),
  ];
}

/**
 * What Stop takes out of the queue so it can go back into the input: every steer omp has not sent
 * into the response yet and every follow-up, oldest first, duplicates included (each removal by
 * text takes the first match, so removing them in this order takes each one once). An entry whose
 * text equals a steer already sent is left: the removal could match that one instead.
 */
export function restorableOnStop(queue: QueueState): { queue: QueueName; text: string }[] {
  const sent = new Set(queue.steering.slice(0, queue.liveSteered));
  return [
    ...queue.steering
      .slice(queue.liveSteered)
      .map((text) => ({ queue: "steering" as const, text })),
    ...queue.followUp.map((text) => ({ queue: "followUp" as const, text })),
  ].filter((entry) => !(entry.queue === "steering" && sent.has(entry.text)));
}

/**
 * Queued steers Stop cannot take back: their text equals a steer omp already put into the
 * response, so a removal by text could hit the sent one. They stay queued in omp and go out with
 * the next message the person sends; the note after Stop says so.
 */
export function stuckOnStop(queue: QueueState): { queue: QueueName; text: string }[] {
  const sent = new Set(queue.steering.slice(0, queue.liveSteered));
  return queue.steering
    .slice(queue.liveSteered)
    .filter((text) => sent.has(text))
    .map((text) => ({ queue: "steering" as const, text }));
}

/**
 * Images ride only on a message that starts a turn. omp lists a queued image-only follow-up as
 * "[Image]" and gives no way to get the bytes back, so Stop could not return them to the input
 * (`queued-messages.ts:113` [V]). Instead a message that would join a running turn takes none.
 */
export function imagesRefusal(streaming: boolean): string | null {
  return streaming ? "Images can be attached when the turn ends." : null;
}

export interface ProviderGroup {
  readonly provider: string;
  readonly models: readonly ModelOption[];
}

/** Models grouped by provider, providers and models in name order. */
export function groupByProvider(models: readonly ModelOption[]): ProviderGroup[] {
  const groups = new Map<string, ModelOption[]>();
  for (const model of models)
    groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, list]) => ({
      provider,
      models: list.toSorted((a, b) => a.name.localeCompare(b.name)),
    }));
}

/**
 * The thinking levels to offer for a model: `off`, `auto` and what the model accepts
 * (`getAvailableThinkingLevels` plus ACP's two extra entries, `acp-agent.ts` #buildThinkingOptions
 * [V]). Empty when the model has no thinking control, so the bar shows no control at all.
 */
export function thinkingChoices(model: ModelOption | undefined): string[] {
  if (!model || model.efforts.length === 0) return [];
  return ["off", "auto", ...model.efforts];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Why an image cannot be attached, as a sentence, or null when it can. */
export function imageProblem(
  file: { readonly type: string; readonly size: number },
  alreadyAttached: number,
  alreadyBytes = 0,
): string | null {
  if (!isImageMimeType(file.type)) {
    return `Only ${IMAGE_MIME_TYPES.map((type) => type.slice(6).toUpperCase()).join(", ")} images can be attached.`;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return `That image is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_IMAGE_BYTES)}.`;
  }
  if (alreadyAttached >= MAX_IMAGES_PER_PROMPT) {
    return `A message can carry up to ${MAX_IMAGES_PER_PROMPT} images.`;
  }
  if (alreadyBytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
    return `A message can carry up to ${formatBytes(MAX_TOTAL_IMAGE_BYTES)} of images.`;
  }
  return null;
}
