/**
 * Requests the agent raised and a person has to answer: a permission to run a gated tool, or an
 * `ask` form. They live in the session view model (`pending`), so a window that reloads gets
 * them back with the snapshot. Nothing here knows ACP: the sidecar translates.
 */
import { isRecord } from "./guards";

/** What picking an option means. These are the four kinds omp offers for a gated tool call. */
export type PermissionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface PermissionOption {
  /** Opaque id the answer carries back. */
  readonly optionId: string;
  readonly name: string;
  readonly kind: PermissionKind;
}

/** A gated tool call waiting for an allow or reject. */
export interface PermissionRequest {
  readonly kind: "permission";
  readonly id: string;
  /** Same id as the tool call item in the timeline, when the timeline has one. */
  readonly toolCallId: string;
  /** Short label for the call, e.g. `Run bash command`. Also the subject of the decision line. */
  readonly title: string;
  /** Tool class when omp says (`execute`, `edit`, ...). */
  readonly toolKind?: string;
  /**
   * The exact payload being authorized: the command text omp attached, or else the tool's raw
   * input as JSON. Never summarized, never truncated.
   */
  readonly payload: string;
  /** Files the call touches, as omp reported them. */
  readonly paths: readonly string[];
  readonly options: readonly PermissionOption[];
  /** Epoch ms when the sidecar received it; the docked tab counts up from here. */
  readonly raisedAt: number;
}

export type AskFieldType = "select" | "multi" | "confirm" | "input";

export interface AskChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/** One question of an ask form, normalized from the elicitation schema. */
export interface AskField {
  /** Key of the answer in the `content` the response carries. */
  readonly key: string;
  readonly type: AskFieldType;
  readonly title?: string;
  readonly description?: string;
  readonly required: boolean;
  /** `select` and `multi` only. */
  readonly choices?: readonly AskChoice[];
  /** Key of the free-text "other" answer that goes with a `select` or `multi`, when offered. */
  readonly otherKey?: string;
  readonly otherLabel?: string;
  /** Preselected value: a choice value, a string list (`multi`), a boolean or text. */
  readonly default?: AskValue;
}

export type AskValue = string | number | boolean | readonly string[];

/** A form the agent wants filled in. */
export interface AskRequest {
  readonly kind: "ask";
  readonly id: string;
  readonly message: string;
  readonly fields: readonly AskField[];
  readonly raisedAt: number;
}

export type PendingRequest = PermissionRequest | AskRequest;

/** How an answered request reads in the timeline afterwards. */
export type DecisionOutcome =
  | "allowed_once"
  | "allowed_always"
  | "rejected_once"
  | "rejected_always"
  | "answered"
  | "cancelled";

/** The plain one-line event a request collapses to once a person answered it. */
export interface DecisionItem {
  readonly kind: "decision";
  readonly id: string;
  readonly outcome: DecisionOutcome;
  /** What was decided about: the tool call title, or the ask message. */
  readonly subject: string;
  /** Tool class of a permission (`execute`, ...), so the line can wear the tool's icon. */
  readonly toolKind?: string;
  /** What the person answered to an ask, in words (`bun test`). Absent when skipped. */
  readonly detail?: string;
}

/** Answer to an ask form: the values by field key. */
export type AskContent = Readonly<Record<string, AskValue>>;

/**
 * `accept` submits `content`. `decline` closes the form without an answer, and omp reads that as
 * the person cancelling the `ask` tool: it aborts the agent's whole turn
 * [V] acp-agent.ts:567-569,717 -> tools/ask.ts:784-787 -> session-tools.ts:432-434.
 */
export type AskAction = "accept" | "decline";

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

export const isAskValue = (v: unknown): v is AskValue =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean" || isStringArray(v);

export function isAskContent(v: unknown): v is AskContent {
  return isRecord(v) && Object.values(v).every(isAskValue);
}

function isPermissionOption(v: unknown): v is PermissionOption {
  return (
    isRecord(v) &&
    typeof v.optionId === "string" &&
    typeof v.name === "string" &&
    (v.kind === "allow_once" ||
      v.kind === "allow_always" ||
      v.kind === "reject_once" ||
      v.kind === "reject_always")
  );
}

function isAskChoice(v: unknown): v is AskChoice {
  return (
    isRecord(v) &&
    typeof v.value === "string" &&
    typeof v.label === "string" &&
    (v.description === undefined || typeof v.description === "string")
  );
}

function isAskField(v: unknown): v is AskField {
  return (
    isRecord(v) &&
    typeof v.key === "string" &&
    (v.type === "select" || v.type === "multi" || v.type === "confirm" || v.type === "input") &&
    typeof v.required === "boolean" &&
    (v.title === undefined || typeof v.title === "string") &&
    (v.description === undefined || typeof v.description === "string") &&
    (v.choices === undefined || (Array.isArray(v.choices) && v.choices.every(isAskChoice))) &&
    (v.otherKey === undefined || typeof v.otherKey === "string") &&
    (v.otherLabel === undefined || typeof v.otherLabel === "string") &&
    (v.default === undefined || isAskValue(v.default))
  );
}

export function isPendingRequest(v: unknown): v is PendingRequest {
  if (!isRecord(v) || typeof v.id !== "string" || typeof v.raisedAt !== "number") return false;
  if (v.kind === "permission") {
    return (
      typeof v.toolCallId === "string" &&
      typeof v.title === "string" &&
      (v.toolKind === undefined || typeof v.toolKind === "string") &&
      typeof v.payload === "string" &&
      isStringArray(v.paths) &&
      Array.isArray(v.options) &&
      v.options.every(isPermissionOption)
    );
  }
  if (v.kind === "ask") {
    return typeof v.message === "string" && Array.isArray(v.fields) && v.fields.every(isAskField);
  }
  return false;
}

export function isDecisionItem(v: unknown): v is DecisionItem {
  return (
    isRecord(v) &&
    v.kind === "decision" &&
    typeof v.id === "string" &&
    typeof v.subject === "string" &&
    (v.toolKind === undefined || typeof v.toolKind === "string") &&
    (v.detail === undefined || typeof v.detail === "string") &&
    (v.outcome === "allowed_once" ||
      v.outcome === "allowed_always" ||
      v.outcome === "rejected_once" ||
      v.outcome === "rejected_always" ||
      v.outcome === "answered" ||
      v.outcome === "cancelled")
  );
}

/** The decision a chosen permission option records. */
export const decisionForPermission = (kind: PermissionKind): DecisionOutcome =>
  kind === "allow_once"
    ? "allowed_once"
    : kind === "allow_always"
      ? "allowed_always"
      : kind === "reject_once"
        ? "rejected_once"
        : "rejected_always";
