import type {
  AskContent,
  AskField,
  AskValue,
  DecisionItem,
  PendingRequest,
  PermissionKind,
  PermissionOption,
  PermissionRequest,
} from "@omp-app/protocol";

/** Id of the wait band, so the docked tab can find it. */
export const BAND_ID = "wait-band";
/** The input bar's text field: focus goes back here when the last request is answered. */
export const COMPOSER_ID = "composer-input";

export function optionOf(
  request: PermissionRequest,
  kind: PermissionKind,
): PermissionOption | undefined {
  return request.options.find((option) => option.kind === kind);
}

/** One question that is a plain yes or no is answered by the buttons alone. */
export function isQuickConfirm(fields: readonly AskField[]): boolean {
  return fields.length === 1 && fields[0]?.type === "confirm";
}

// ── Keyboard ──────────────────────────────────────────────────────────────

/**
 * Where a key press landed, as far as the band cares.
 * `foreign` is a place where the person is typing that is not the band (a draft in the input
 * bar, a settings field): the band never reacts there, so it cannot steal a keystroke.
 * `empty-field` is an input bar with nothing typed: only Enter and Esc reach the band, as the
 * bar's own placeholder promises. `question` is the focusable, scrollable question text: the
 * arrow keys scroll it, so they are not the band's to take.
 */
export type KeyTarget =
  | "page"
  | "band"
  | "question"
  | "button"
  | "choice"
  | "text"
  | "empty-field"
  | "foreign";

/** The attribute that marks the question region; `targetOf` reads it as `dataset.question`. */
export const QUESTION_ATTRIBUTE = "data-question";

interface ElementLike {
  readonly tagName: string;
  readonly type?: string;
  readonly value?: string;
  readonly isContentEditable?: boolean;
  readonly dataset?: Readonly<Record<string, string | undefined>>;
}

/** Classifies the focused element. `where`: the band itself, inside the band, or elsewhere. */
export function targetOf(
  element: ElementLike | null,
  where: "band" | "band-self" | "outside",
): KeyTarget {
  if (where === "band-self") return "band";
  if (!element || element.tagName === "BODY") return "page";
  const tag = element.tagName;
  if (where === "band" && element.dataset?.question !== undefined) return "question";
  if (tag === "BUTTON") return "button";
  if (tag === "INPUT" && (element.type === "radio" || element.type === "checkbox")) {
    return where === "band" ? "choice" : "page";
  }
  const field =
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable === true;
  if (!field) return where === "band" ? "band" : "page";
  if (where === "band") return "text";
  return tag === "TEXTAREA" && element.value === "" ? "empty-field" : "foreign";
}

export interface KeyInput {
  readonly key: string;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly isComposing: boolean;
  /** Held key: auto-repeat must never answer a request the person has not read. */
  readonly repeat: boolean;
}

/**
 * Keys do nothing for this long after a request appears. A double-tapped or held Enter that was
 * meant for the input bar would otherwise allow a command nobody read.
 */
export const KEY_GRACE_MS = 300;

export type KeyAnswer =
  | { readonly type: "option"; readonly kind: PermissionKind }
  | { readonly type: "submit" }
  | { readonly type: "cancel" }
  | { readonly type: "digit"; readonly index: number }
  | { readonly type: "move"; readonly delta: 1 | -1 }
  | { readonly type: "confirm"; readonly value: boolean };

/**
 * What a key press answers, if anything.
 *
 * Esc rejects once (permission) or cancels (ask) from anywhere but a foreign text field. Enter
 * allows once, or sends the form, only where Enter has no other job: not on a focused button
 * (which it presses), not in the input bar (where it sends a message). ⌥Enter is allow always.
 * Digits pick an option of a form with one list; Y and N answer a plain yes or no. Nothing answers
 * on a held key or in the first `KEY_GRACE_MS` after the request showed (`sinceShownMs`).
 */
export function keyAnswer(
  request: PendingRequest,
  input: KeyInput,
  target: KeyTarget,
  sinceShownMs: number,
): KeyAnswer | null {
  if (input.isComposing || input.metaKey || input.ctrlKey || target === "foreign") return null;
  if (input.repeat || sinceShownMs < KEY_GRACE_MS) return null;
  if (target === "empty-field" && input.key !== "Enter" && input.key !== "Escape") return null;
  const permission = request.kind === "permission";
  if (input.key === "Escape") {
    return permission ? { type: "option", kind: "reject_once" } : { type: "cancel" };
  }
  if (input.key === "Enter") {
    if (target === "button" || input.shiftKey) return null;
    if (permission) return { type: "option", kind: input.altKey ? "allow_always" : "allow_once" };
    return isQuickConfirm(request.fields) ? null : { type: "submit" };
  }
  if (permission || input.altKey || target === "text" || input.shiftKey) return null;
  // Arrows move the choice only from the band itself; on a focused radio the browser moves it.
  if ((input.key === "ArrowDown" || input.key === "ArrowUp") && target === "band") {
    return soleChoiceField(request.fields)?.type === "select"
      ? { type: "move", delta: input.key === "ArrowDown" ? 1 : -1 }
      : null;
  }
  if (isQuickConfirm(request.fields)) {
    const key = input.key.toLowerCase();
    return key === "y" || key === "n" ? { type: "confirm", value: key === "y" } : null;
  }
  const digit = /^[1-9]$/.test(input.key) ? Number(input.key) - 1 : -1;
  return digit >= 0 && soleChoiceField(request.fields) ? { type: "digit", index: digit } : null;
}

/** What `createBandKeys` needs of the band element. */
interface BandNode {
  contains(other: unknown): boolean;
}

/**
 * The key handling of one request's band. It is created when the request first renders and keeps
 * that moment, so the first `KEY_GRACE_MS` after it ignore every key; a queued second request
 * gets its own, because its band body is a new mount. The clock is injected so a test can move it.
 */
export function createBandKeys(now: () => number) {
  const shownAt = now();
  return {
    answer(
      request: PendingRequest,
      input: KeyInput,
      active: ElementLike | null,
      band: BandNode | null,
    ): KeyAnswer | null {
      const where = !band
        ? "outside"
        : (active as unknown) === band
          ? "band-self"
          : band.contains(active)
            ? "band"
            : "outside";
      return keyAnswer(request, input, targetOf(active, where), now() - shownAt);
    },
  };
}

/** The field the digit keys act on: only when the form is one list of choices. */
export function soleChoiceField(fields: readonly AskField[]): AskField | undefined {
  const [field] = fields;
  return fields.length === 1 && (field?.type === "select" || field?.type === "multi")
    ? field
    : undefined;
}

// ── Ask drafts ────────────────────────────────────────────────────────────

export type AskDraft = Readonly<Record<string, AskValue>>;

/**
 * Defaults the agent sent; a select starts on its first choice, as the design highlights it, and
 * a yes/no box starts unchecked, which is an answer (no) and not a missing one.
 */
export function initialDraft(fields: readonly AskField[]): AskDraft {
  const draft: Record<string, AskValue> = {};
  for (const field of fields) {
    if (field.default !== undefined) draft[field.key] = field.default;
    else if (field.type === "select" && field.choices?.[0])
      draft[field.key] = field.choices[0].value;
    else if (field.type === "confirm") draft[field.key] = false;
  }
  return draft;
}

const filled = (value: AskValue | undefined): boolean =>
  typeof value === "string"
    ? value.trim() !== ""
    : Array.isArray(value)
      ? value.length > 0
      : value !== undefined;

/** True when every required question has an answer (a typed "other" counts). */
export function canSend(fields: readonly AskField[], draft: AskDraft): boolean {
  return fields.every((field) => {
    if (!field.required) return true;
    const other = field.otherKey ? draft[field.otherKey] : undefined;
    return filled(draft[field.key]) || filled(other);
  });
}

/** The answer the sidecar validates: only what the person filled in. */
export function draftContent(fields: readonly AskField[], draft: AskDraft): AskContent {
  const content: Record<string, AskValue> = {};
  for (const field of fields) {
    const value = draft[field.key];
    const other = field.otherKey ? draft[field.otherKey] : undefined;
    if (filled(other) && field.otherKey) content[field.otherKey] = other as AskValue;
    else if (filled(value) && value !== undefined) content[field.key] = value;
  }
  return content;
}

// ── Words ─────────────────────────────────────────────────────────────────

/** Header label of the band. */
export function bandLabel(request: PendingRequest): string {
  if (request.kind === "permission") return "WAITING FOR YOU";
  const [field] = request.fields;
  if (request.fields.length !== 1 || !field) return "QUESTION";
  const part: Record<AskField["type"], string> = {
    select: "PICK ONE",
    multi: "PICK ANY",
    confirm: "YES OR NO",
    input: "YOUR ANSWER",
  };
  return `QUESTION · ${part[field.type]}`;
}

/**
 * What "always" covers, said truthfully: omp keeps the decision per tool for the session
 * [V] acp-permission-gate.ts:55-95 (cacheKey), session-tools.ts:464,1140, and asks again for a
 * bash command it flags as critical, or one that matches a prompt pattern the user configured
 * [V] session-tools.ts:943,964 (`cacheable = !resolved.override`), tools/bash.ts:553,582,592
 * (the three `override: true` prompts). Nothing in the request says whether this prompt is one of
 * those, so the exception is stated for bash.
 */
export function scopeNote(request: PermissionRequest): string {
  const exception =
    request.toolKind === "execute"
      ? ", except for critical commands and ones that match a prompt pattern"
      : "";
  return `Always: omp stops asking for this tool for the rest of the session${exception}.`;
}

/** What cancelling an ask costs: omp reads it as the person stopping the agent. */
export const CANCEL_NOTE = "cancel stops the agent’s turn";

/** The hint line under a form. */
export function askHint(fields: readonly AskField[]): string | null {
  if (isQuickConfirm(fields)) return "y yes · n no · esc cancel";
  const sole = soleChoiceField(fields);
  if (sole?.type === "select") return "↑↓ move · 1–9 pick · ↵ send · esc cancel";
  if (sole?.type === "multi") return "1–9 toggle · ↵ send · esc cancel";
  return "↵ send · esc cancel";
}

/** What the input bar says while the agent waits. */
export function waitingPlaceholder(request: PendingRequest): string {
  const answer =
    request.kind === "permission" ? "↵ allow once · esc reject" : "↵ send · esc cancel";
  return `The agent is waiting for your answer above · ${answer}`;
}

/** The polite announcement when a request appears. */
export function requestAnnouncement(request: PendingRequest): string {
  return request.kind === "permission"
    ? `Waiting for your approval: ${request.title}`
    : `The agent asks: ${request.message}`;
}

export interface DecisionParts {
  /** First words of the line. */
  readonly lead: string;
  /** What it was about, in mono when it is a command or a path. */
  readonly subject: string;
  readonly mono: boolean;
  /** Quiet words after the subject, if any. */
  readonly tail: string | null;
  /** What the person chose, set in mono, if they chose something. */
  readonly detail: string | null;
}

/** How an answered request reads as a plain line of the chat. */
export function decisionParts(item: DecisionItem): DecisionParts {
  const permission: Partial<Record<DecisionItem["outcome"], string>> = {
    allowed_once: "Allowed once",
    allowed_always: "Always allowed",
    rejected_once: "Rejected",
    rejected_always: "Always rejected",
  };
  const lead = permission[item.outcome];
  if (lead) return { lead, subject: item.subject, mono: true, tail: null, detail: null };
  if (item.outcome === "cancelled") {
    return { lead: "Asked", subject: item.subject, mono: false, tail: "cancelled", detail: null };
  }
  return {
    lead: "Asked",
    subject: item.subject,
    mono: false,
    tail: item.detail ? "you answered" : "answered",
    detail: item.detail ?? null,
  };
}
