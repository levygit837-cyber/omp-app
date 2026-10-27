import type {
  AskField,
  AskRequest,
  PendingRequest,
  PermissionKind,
  PermissionRequest,
} from "@omp-app/protocol";
import { AskIcon, Button, WaitBand } from "@omp-app/ui";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { toolIcon } from "./DecisionLine";
import { useElapsed } from "./engine";
import { clock } from "./format";
import {
  type AskDraft,
  askHint,
  BAND_ID,
  bandLabel,
  CANCEL_NOTE,
  COMPOSER_ID,
  canSend,
  createBandKeys,
  draftContent,
  initialDraft,
  isQuickConfirm,
  type KeyAnswer,
  optionOf,
  QUESTION_ATTRIBUTE,
  scopeNote,
  soleChoiceField,
} from "./requests-view";
import { message } from "./session-controller";
import { useWaiting } from "./shown-status";

/** Scrolls to the band and puts keyboard focus on it. Used by the docked tab. */
export function focusBand() {
  const band = document.getElementById(BAND_ID);
  band?.scrollIntoView({ block: "nearest" });
  band?.focus();
}

const KEY_HINT = "font-mono text-size-2xs";

/** Label and key hint of a permission button, as the design draws them. */
const PERMISSION_BUTTON: Record<
  PermissionKind,
  { label: string; hint: string | null; variant: "approval" | "secondary" | "ghost" }
> = {
  allow_once: { label: "Allow once", hint: "↵", variant: "approval" },
  allow_always: { label: "Always allow", hint: "⌥↵", variant: "secondary" },
  reject_once: { label: "Reject", hint: "esc", variant: "secondary" },
  reject_always: { label: "Always reject", hint: null, variant: "ghost" },
};

const PERMISSION_ORDER: readonly PermissionKind[] = [
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
];

/**
 * Keyboard of the band. Esc and Enter work from the band, from the page and from an empty input
 * bar; never while a draft is being typed elsewhere (see `keyAnswer`).
 */
function useBandKeys(
  request: PendingRequest,
  band: React.RefObject<HTMLElement | null>,
  on: (answer: KeyAnswer) => void,
) {
  const latest = useRef(on);
  latest.current = on;
  // The body is keyed by request id, so this is the moment that request first rendered.
  const keys = useRef<ReturnType<typeof createBandKeys> | null>(null);
  keys.current ??= createBandKeys(() => performance.now());
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const answer = keys.current?.answer(
        request,
        event,
        document.activeElement as HTMLElement | null,
        band.current,
      );
      if (!answer) return;
      event.preventDefault();
      latest.current(answer);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, band]);
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="font-mono text-size-xs text-text-dim">{children}</p>;
}

function Failure({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" className="text-size-sm text-state-error">
      {text}
    </p>
  ) : null;
}

// ── Permission ────────────────────────────────────────────────────────────

function PermissionBody({
  sessionId,
  request,
  band,
}: {
  sessionId: string;
  request: PermissionRequest;
  band: React.RefObject<HTMLElement | null>;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  const Icon = toolIcon(request.toolKind);
  const run = request.toolKind === "execute";
  const answer = useCallback(
    (kind: PermissionKind) => {
      const option = optionOf(request, kind);
      if (!option) return;
      setFailure(null);
      window.omp.session
        .answerPermission(sessionId, request.id, option.optionId)
        .catch((e: unknown) => setFailure(message(e)));
    },
    [sessionId, request],
  );
  useBandKeys(request, band, (a) => a.type === "option" && answer(a.kind));
  const always = optionOf(request, "allow_always") ?? optionOf(request, "reject_always");
  const extra = request.paths.filter((p) => !request.payload.includes(p));

  return (
    <>
      <div className="flex min-h-(--size-tool-row) items-start gap-(--space-icon-phrase) text-size-md">
        <span className="flex h-(--size-tool-row) items-center">
          <Icon className="text-icon-neutral" />
        </span>
        <p className="flex min-w-0 flex-col gap-(--space-4) py-(--space-2)">
          <span className="text-text-primary">{run ? "Wants to run" : request.title}</span>
          {(run || request.payload !== request.title) && (
            <code
              data-testid="request-payload"
              className="font-mono text-size-sm break-all whitespace-pre-wrap text-text-primary"
            >
              {request.payload}
            </code>
          )}
        </p>
      </div>
      <div className="flex flex-col gap-(--space-6) pl-(--space-output-indent)">
        {extra.length > 0 && (
          <p className="font-mono text-size-xs break-all text-text-secondary">
            {extra.join(" → ")}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-(--space-8) pt-(--space-6)">
          {PERMISSION_ORDER.filter((kind) => optionOf(request, kind)).map((kind) => {
            const button = PERMISSION_BUTTON[kind];
            return (
              <Button
                key={kind}
                variant={button.variant}
                data-testid={`answer-${kind}`}
                onClick={() => answer(kind)}
              >
                {button.label}
                {button.hint && (
                  <span
                    className={`${KEY_HINT} ${button.variant === "approval" ? "text-on-accent-hint" : "text-text-dim"}`}
                  >
                    {button.hint}
                  </span>
                )}
              </Button>
            );
          })}
        </div>
        {always && <Hint>{scopeNote(request)}</Hint>}
        <Failure text={failure} />
      </div>
    </>
  );
}

// ── Ask ───────────────────────────────────────────────────────────────────

const ROW =
  "flex items-baseline gap-(--space-12) rounded-sm px-(--space-10) py-(--space-6) text-size-md has-[:checked]:bg-bg-user has-[:focus-visible]:outline-(length:--size-focus-ring) has-[:focus-visible]:outline-focus-ring has-[:focus-visible]:outline-solid";

/** A square that fills when ticked: selection is a shape, not only a background. */
function Tick() {
  return (
    <span
      aria-hidden="true"
      className="size-(--space-12) shrink-0 self-center rounded-sm border border-border-field in-[label:has(:checked)]:border-state-approval in-[label:has(:checked)]:bg-state-approval"
    />
  );
}

function Choices({
  field,
  message,
  draft,
  set,
  shownKeys,
}: {
  field: AskField;
  /** The question already on screen; a field titled the same is not repeated. */
  message: string;
  draft: AskDraft;
  set: (key: string, value: AskDraft[string]) => void;
  shownKeys: boolean;
}) {
  const multi = field.type === "multi";
  const picked = draft[field.key];
  const chosen = Array.isArray(picked) ? picked : [];
  const toggle = (value: string) =>
    set(field.key, chosen.includes(value) ? chosen.filter((v) => v !== value) : [...chosen, value]);
  return (
    <fieldset className="flex flex-col gap-(--space-4)">
      {field.title && field.title !== message && (
        <legend className="pb-(--space-4) text-text-secondary">{field.title}</legend>
      )}
      {field.choices?.map((choice, index) => (
        <label key={choice.value} className={ROW}>
          <input
            type={multi ? "checkbox" : "radio"}
            name={field.key}
            className="sr-only"
            checked={multi ? chosen.includes(choice.value) : picked === choice.value}
            onChange={() => (multi ? toggle(choice.value) : set(field.key, choice.value))}
            data-testid={`choice-${choice.value}`}
          />
          {multi && <Tick />}
          {shownKeys && index < 9 && (
            <span className="font-mono text-size-xs text-text-dim">{index + 1}</span>
          )}
          <span className="text-text-primary">{choice.label}</span>
          {choice.description && (
            <span className="text-size-sm text-text-secondary">{choice.description}</span>
          )}
        </label>
      ))}
      {field.otherKey && (
        <label className={ROW}>
          <input
            type="text"
            aria-label={field.otherLabel ?? "Something else"}
            placeholder={field.otherLabel ?? "Something else…"}
            value={String(draft[field.otherKey] ?? "")}
            onChange={(e) => field.otherKey && set(field.otherKey, e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-text-primary outline-none placeholder:text-text-secondary"
          />
        </label>
      )}
    </fieldset>
  );
}

function AskBody({
  sessionId,
  request,
  band,
}: {
  sessionId: string;
  request: AskRequest;
  band: React.RefObject<HTMLElement | null>;
}) {
  const { fields } = request;
  const [draft, setDraft] = useState<AskDraft>(() => initialDraft(fields));
  const [failure, setFailure] = useState<string | null>(null);
  const quick = isQuickConfirm(fields);
  const sole = soleChoiceField(fields);
  const set = (key: string, value: AskDraft[string]) => setDraft((d) => ({ ...d, [key]: value }));

  const send = useCallback(
    (action: "accept" | "decline", content?: AskDraft) => {
      setFailure(null);
      window.omp.session
        .answerAsk(sessionId, request.id, action, content)
        .catch((e: unknown) => setFailure(message(e)));
    },
    [sessionId, request.id],
  );
  const submit = () => canSend(fields, draft) && send("accept", draftContent(fields, draft));
  const confirm = (value: boolean) => {
    const field = fields[0];
    if (field) send("accept", { [field.key]: value });
  };

  useBandKeys(request, band, (a) => {
    if (a.type === "cancel") send("decline");
    else if (a.type === "submit") submit();
    else if (a.type === "confirm") confirm(a.value);
    else if (a.type === "move" && sole?.choices) {
      const values = sole.choices.map((c) => c.value);
      const at = values.indexOf(String(draft[sole.key]));
      const next = values[Math.min(values.length - 1, Math.max(0, at + a.delta))];
      if (next !== undefined) set(sole.key, next);
    } else if (a.type === "digit" && sole?.choices?.[a.index]) {
      const value = sole.choices[a.index]?.value;
      if (value === undefined) return;
      if (sole.type === "select") set(sole.key, value);
      else {
        const now = Array.isArray(draft[sole.key]) ? (draft[sole.key] as string[]) : [];
        set(sole.key, now.includes(value) ? now.filter((v) => v !== value) : [...now, value]);
      }
    }
  });

  const hint = askHint(fields);
  return (
    <>
      <div className="flex min-h-(--size-tool-row) items-start gap-(--space-icon-phrase) text-size-md">
        <span className="flex h-(--size-tool-row) items-center">
          <AskIcon className="text-icon-neutral" />
        </span>
        <section
          {...{ [QUESTION_ATTRIBUTE]: "" }}
          aria-label="Question"
          // A scrollable region must take focus, or a long plan cannot be read by keyboard.
          // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region, see above
          tabIndex={0}
          className="max-h-(--layout-band-message-max) min-w-0 overflow-y-auto py-(--space-2) break-words whitespace-pre-wrap text-text-primary"
        >
          {request.message}
        </section>
      </div>
      <div className="flex flex-col gap-(--space-8) pl-(--space-output-indent)">
        {!quick &&
          fields.map((field) =>
            field.type === "select" || field.type === "multi" ? (
              <Choices
                key={field.key}
                field={field}
                message={request.message}
                draft={draft}
                set={set}
                shownKeys={sole !== undefined}
              />
            ) : field.type === "confirm" ? (
              <label key={field.key} className={ROW}>
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={draft[field.key] === true}
                  onChange={(e) => set(field.key, e.target.checked)}
                />
                <Tick />
                <span className="text-text-primary">{field.title ?? "Yes"}</span>
              </label>
            ) : (
              <label key={field.key} className="flex flex-col gap-(--space-4)">
                {field.title && <span className="text-text-secondary">{field.title}</span>}
                <input
                  type="text"
                  value={String(draft[field.key] ?? "")}
                  onChange={(e) => set(field.key, e.target.value)}
                  className="rounded-sm border border-border-field bg-transparent px-(--space-12) py-(--space-8) text-size-md text-text-primary"
                />
              </label>
            ),
          )}
        <div className="flex flex-wrap items-center gap-(--space-8) pt-(--space-4)">
          {quick ? (
            <>
              <Button variant="approval" data-testid="answer-yes" onClick={() => confirm(true)}>
                Yes <span className={`${KEY_HINT} text-on-accent-hint`}>Y</span>
              </Button>
              <Button data-testid="answer-no" onClick={() => confirm(false)}>
                No <span className={`${KEY_HINT} text-text-dim`}>N</span>
              </Button>
            </>
          ) : (
            <Button
              variant="approval"
              data-testid="answer-send"
              disabled={!canSend(fields, draft)}
              onClick={submit}
            >
              Send <span className={`${KEY_HINT} text-on-accent-hint`}>↵</span>
            </Button>
          )}
          <Button variant="ghost" data-testid="answer-cancel" onClick={() => send("decline")}>
            Cancel <span className={`${KEY_HINT} text-text-dim`}>esc</span>
          </Button>
        </div>
        {hint && (
          <Hint>
            {hint} · {CANCEL_NOTE}
          </Hint>
        )}
        <Failure text={failure} />
      </div>
    </>
  );
}

// ── The band ──────────────────────────────────────────────────────────────

function Timer({ since, more }: { since: number; more: number }) {
  const elapsed = useElapsed(since);
  return (
    <>
      · {clock(elapsed)}
      {more > 0 && ` · ${more} more waiting`}
    </>
  );
}

/**
 * The agent is blocked and waits for a person: the chat's one boxed element, shown between the
 * timeline and the input bar. The oldest request is on screen; a second one waits its turn and
 * is counted in the header. Takes focus when it appears, unless the person is typing elsewhere.
 */
export function WaitingBand({ sessionId }: { sessionId: string }) {
  const waiting = useWaiting(sessionId);
  const request = waiting[0];
  const band = useRef<HTMLElement>(null);
  const id = request?.id;
  const hadRequest = useRef(false);

  // The last answer removes the band, and a focused node that is removed leaves focus on the page
  // body: put it back in the input bar. Focus the person moved elsewhere stays where it is.
  useEffect(() => {
    if (!id && hadRequest.current) {
      const active = document.activeElement;
      if (!active || active === document.body) document.getElementById(COMPOSER_ID)?.focus();
    }
    hadRequest.current = id !== undefined;
  }, [id]);

  // Focus moves to the band for a new request only from the page, never out of a text field.
  useEffect(() => {
    if (!id) return;
    const active = document.activeElement;
    if (!active || active === document.body) band.current?.focus({ preventScroll: true });
    band.current?.scrollIntoView({ block: "nearest" });
  }, [id]);

  if (!request) return null;
  return (
    <WaitBand
      ref={band}
      id={BAND_ID}
      data-testid="wait-band"
      data-kind={request.kind}
      aria-label={request.kind === "permission" ? "Waiting for your approval" : "The agent asks"}
      label={bandLabel(request)}
      timer={<Timer since={request.raisedAt} more={waiting.length - 1} />}
    >
      {request.kind === "permission" ? (
        <PermissionBody key={request.id} sessionId={sessionId} request={request} band={band} />
      ) : (
        <AskBody key={request.id} sessionId={sessionId} request={request} band={band} />
      )}
    </WaitBand>
  );
}
