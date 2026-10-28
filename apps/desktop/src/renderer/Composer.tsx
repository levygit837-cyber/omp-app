import { EMPTY_QUEUE } from "@omp-app/protocol";
import {
  AttachIcon,
  Button,
  Chip,
  FileIcon,
  IconButton,
  Notice,
  SendIcon,
  StateMark,
  StatusPill,
  StopIcon,
} from "@omp-app/ui";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { SidecarStatus } from "../shared/bridge";
import { composerView, type EnginePhase, escapeAction, keyStopsTurn } from "./composer-state";
import {
  type Draft,
  draftAfter,
  EMPTY_DRAFT,
  joinedText,
  restoredNote,
  takeBackQueued,
} from "./draft";
import { type DraftImage, imageChipText, readImages } from "./draft-images";
import { FileSuggest, SUGGEST_ID, suggestOptionId } from "./FileSuggest";
import { BranchChip } from "./files/BranchChip";
import { LOCKED_ID, LOCKED_WHILE_RUNNING, ModelControls } from "./ModelControls";
import { PlanToggle } from "./PlanToggle";
import {
  deliveryForKey,
  deliveryHint,
  imagesRefusal,
  type Mention,
  mentionAt,
  promptText,
  restorableOnStop,
  sameMention,
  stuckOnStop,
  withoutMention,
} from "./prompt-input";
import { QueueStrip } from "./QueueStrip";
import { COMPOSER_ID, waitingPlaceholder } from "./requests-view";
import { message } from "./session-controller";
import { useQueue } from "./session-hooks";
import { useShownStatus, useWaiting } from "./shown-status";

const MAC = navigator.userAgent.includes("Mac");
/** Wait this long after the last keystroke before asking for files. */
const SUGGEST_DELAY_MS = 80;

/** The input bar. The engine outranks the turn: see `composerView`. */
export function Composer({
  sessionId,
  sidecar,
  engine,
  onSent,
}: {
  sessionId: string;
  sidecar: SidecarStatus;
  engine: EnginePhase;
  /** Called when a prompt was accepted by the bridge, so the timeline follows the answer. */
  onSent: () => void;
}) {
  const status = useShownStatus(sessionId);
  const [draftState, setDraftState] = useState<Draft>(EMPTY_DRAFT);
  const { text, files, images } = draftState;
  const setText = (value: string) => setDraftState((d) => ({ ...d, text: value }));
  const setFiles = (next: (current: readonly string[]) => readonly string[]) =>
    setDraftState((d) => ({ ...d, files: next(d.files) }));
  const setImages = (next: (current: readonly DraftImage[]) => readonly DraftImage[]) =>
    setDraftState((d) => ({ ...d, images: next(d.images) }));
  const [error, setError] = useState<string | null>(null);
  /** What Stop did with the queue, said where the person is looking. */
  const [note, setNote] = useState<string | null>(null);
  const queue = useQueue(sessionId);
  const [mention, setMention] = useState<Mention | null>(null);
  const [suggestions, setSuggestions] = useState<readonly string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [active, setActive] = useState(0);
  const [dragging, setDragging] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const streaming = status === "streaming";
  const waiting = useWaiting(sessionId)[0];
  const readOnly = sidecar.state === "ready" && sidecar.mode === "read_only";
  const view = composerView({ readOnly, engine, streaming });
  // Esc stops a turn only while there is one to stop and an engine to tell. While the agent
  // waits for an answer Esc belongs to the band (reject / cancel): stopping is the Stop button.
  const cancellable = streaming && engine === "ready";
  const escStops = cancellable && !waiting;
  const suggesting = mention !== null;
  const draft = promptText(text, files);
  const sendable = view.kind === "input" && view.canSend && (draft !== "" || images.length > 0);

  // Stop aborts the turn but omp keeps what was queued, and delivers it in the next turn the
  // person starts (observed live, `scripts/live.ts` stop-queue). So Stop first takes every queued
  // message back out and puts it in the input; whatever omp no longer holds is not restored.
  const stop = useCallback(async () => {
    const held = queue ?? EMPTY_QUEUE;
    const back = await takeBackQueued(restorableOnStop(held), (name, text) =>
      window.omp.session.removeQueued(sessionId, name, text),
    );
    const stuck = stuckOnStop(held).length;
    if (back.length > 0) setDraftState((d) => draftAfter(d, { type: "stopped", back }));
    if (back.length > 0 || stuck > 0) setNote(restoredNote(back.length, stuck));
    window.omp.session.cancel(sessionId).catch((e: unknown) => setError(message(e)));
  }, [sessionId, queue]);

  useEffect(() => {
    if (!escStops) return;
    const onKey = (event: KeyboardEvent) => {
      if (keyStopsTurn(event.key, field.current?.closest("[inert]") != null)) void stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [escStops, stop]);

  // omp reads an `@` file only for a message that starts a turn, so while one runs the list is
  // not offered (see `joinedText`). A list open when the turn starts closes.
  useEffect(() => {
    if (streaming) setMention(null);
  }, [streaming]);

  // Files matching the `@` being typed. A slower answer to an older query is dropped.
  const query = mention?.query;
  useEffect(() => {
    if (query === undefined) {
      setSuggestions(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      window.omp.session
        .files(sessionId, query)
        .then((list) => {
          if (stale) return;
          setTruncated(list.truncated);
          setSuggestions(list.files.filter((path) => !files.includes(path)));
          setActive(0);
        })
        .catch((e: unknown) => {
          if (stale) return;
          setSuggestions([]);
          setError(message(e));
        });
    }, SUGGEST_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, sessionId, files]);

  // The reference closed with Esc. The caret has not moved, so the selection event that follows
  // the key would derive the same reference again; it stays closed until the reference changes.
  const dismissed = useRef<Mention | null>(null);
  const track = (value: string, caret: number) => {
    if (streaming) return;
    const next = mentionAt(value, caret);
    if (sameMention(next, dismissed.current)) return;
    dismissed.current = null;
    setMention(next);
  };

  const attach = async (picked: readonly File[]) => {
    const refusal = imagesRefusal(streaming);
    if (refusal) {
      setError(refusal);
      return;
    }
    const { added, problem } = await readImages(
      picked,
      images.length,
      images.reduce((total, image) => total + image.bytes, 0),
    );
    setImages((current) => [...current, ...added]);
    setError(problem);
  };

  const pick = (path: string) => {
    if (!mention) return;
    const next = withoutMention(text, mention);
    setText(next.text);
    setFiles((current) => (current.includes(path) ? current : [...current, path]));
    setMention(null);
    requestAnimationFrame(() => field.current?.setSelectionRange(next.caret, next.caret));
  };

  const submit = (delivery: "steer" | "followUp") => {
    if (!sendable) return;
    setError(null);
    setNote(null);
    const sent: Draft = { text, files, images };
    const joining = streaming;
    setDraftState((current) => draftAfter(current, { type: "sent" }));
    setMention(null);
    onSent();
    window.omp.session
      .prompt(sessionId, joining ? joinedText(text, files) : promptText(text, files), {
        images: images.map(({ mimeType, data }) => ({ mimeType, data })),
        delivery: joining ? delivery : undefined,
      })
      .catch((e: unknown) => {
        // Rejected: the person gets back everything they had put in, not an empty bar.
        setDraftState((current) => draftAfter(current, { type: "rejected", sent }));
        setError(message(e));
      });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit("steer");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggesting && suggestions && suggestions.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((active + step + suggestions.length) % suggestions.length);
        return;
      }
      if ((e.key === "Enter" && !e.nativeEvent.isComposing) || e.key === "Tab") {
        const path = suggestions[active];
        if (path) {
          e.preventDefault();
          pick(path);
          return;
        }
      }
    }
    if (
      e.key === "Escape" &&
      escapeAction({ listShown: suggesting, stopsTurn: escStops }) === "close-list"
    ) {
      // Closes the list and stops there: it must not also stop the turn.
      e.preventDefault();
      e.stopPropagation();
      dismissed.current = mention;
      setMention(null);
      return;
    }
    const delivery = deliveryForKey(e.nativeEvent);
    if (delivery) {
      e.preventDefault();
      submit(delivery);
    }
  };

  const hasFiles = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types).includes("Files");

  if (view.kind === "read-only") {
    return (
      <div
        data-testid="composer-read-only"
        className="flex w-(--layout-composer) max-w-full items-center gap-(--space-10) rounded-lg border border-border-hairline bg-bg-sidebar px-(--space-18) py-(--space-14)"
      >
        <StatusPill>Read-only</StatusPill>
        <p className="text-size-md text-text-secondary">
          Sending is paused while ~/.omp is newer than omp{" "}
          {sidecar.state === "ready" ? sidecar.ompVersion : ""}.
        </p>
      </div>
    );
  }

  const options = suggesting && suggestions !== null && suggestions.length > 0;
  return (
    <form
      onSubmit={onSubmit}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        setDragging(false);
        void attach(Array.from(event.dataTransfer.files));
      }}
      data-dragging={dragging || undefined}
      className="relative flex w-(--layout-composer) max-w-full flex-col gap-(--space-12) rounded-lg border border-border-hairline bg-bg-elevated px-(--space-18) pt-(--space-14) pb-(--space-12) data-dragging:border-border-field has-[textarea:focus-visible]:border-border-field has-[textarea:focus-visible]:outline-(length:--size-focus-ring) has-[textarea:focus-visible]:outline-focus-ring has-[textarea:focus-visible]:outline-solid has-[textarea:focus-visible]:outline-offset-(--space-2)"
    >
      {error && <Notice severity="error" title={error} />}
      {note && (
        <p role="status" data-testid="stop-note" className="text-size-sm text-text-secondary">
          {note}
        </p>
      )}
      <QueueStrip sessionId={sessionId} onError={setError} />
      {(files.length > 0 || images.length > 0) && (
        <ul
          data-testid="attachments"
          aria-label="Attachments"
          className="flex flex-wrap gap-(--space-6)"
        >
          {files.map((path) => (
            <li key={`file:${path}`}>
              <Chip
                icon={<FileIcon />}
                removeLabel={`Remove ${path}`}
                onRemove={() => {
                  setFiles((current) => current.filter((other) => other !== path));
                  field.current?.focus();
                }}
              >
                {path}
              </Chip>
            </li>
          ))}
          {images.map((image) => (
            <li key={`image:${image.id}`}>
              <Chip
                icon={<AttachIcon />}
                removeLabel={`Remove ${image.name}`}
                onRemove={() => {
                  setImages((current) => current.filter((other) => other.id !== image.id));
                  field.current?.focus();
                }}
              >
                {imageChipText(image)}
              </Chip>
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        {suggesting && (
          <FileSuggest files={suggestions} truncated={truncated} active={active} onPick={pick} />
        )}
        {waiting && (
          <StateMark
            state="approval"
            decorative
            className="pointer-events-none absolute top-(--space-4) left-0"
          />
        )}
        <textarea
          ref={field}
          id={COMPOSER_ID}
          data-testid="prompt-input"
          aria-label="Prompt"
          aria-controls={options ? SUGGEST_ID : undefined}
          aria-autocomplete={suggesting ? "list" : undefined}
          aria-activedescendant={options ? suggestOptionId(active) : undefined}
          value={text}
          placeholder={waiting ? waitingPlaceholder(waiting) : view.placeholder}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            track(e.target.value, e.target.selectionStart);
          }}
          onSelect={(e) => track(e.currentTarget.value, e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files).filter((file) =>
              file.type.startsWith("image/"),
            );
            if (pasted.length === 0) return;
            e.preventDefault();
            void attach(pasted);
          }}
          className={`max-h-(--layout-composer-input-max) w-full resize-none bg-transparent text-size-body leading-(--line-height-prose) text-text-primary outline-none field-sizing-content placeholder:text-text-dim${waiting ? " pl-(--space-24) placeholder:text-text-secondary" : ""}`}
        />
      </div>
      {/* Wraps: model, thinking and plan together are wider than the bar in a narrow window, and
          the send button would otherwise leave the box. */}
      <div className="flex flex-wrap items-center gap-x-(--space-8) gap-y-(--space-4)">
        <IconButton
          aria-label="Attach image"
          title="Attach an image (PNG, JPEG, GIF or WebP). You can also paste or drop one."
          disabled={!view.canSend}
          aria-disabled={streaming || undefined}
          onClick={() => {
            const refusal = imagesRefusal(streaming);
            if (refusal) setError(refusal);
            else picker.current?.click();
          }}
        >
          <AttachIcon />
        </IconButton>
        <input
          ref={picker}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/gif,image/webp"
          tabIndex={-1}
          aria-hidden="true"
          className="hidden"
          onChange={(e) => {
            void attach(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <ModelControls
          sessionId={sessionId}
          streaming={streaming}
          locked={engine !== "ready"}
          onError={setError}
        />
        <PlanToggle sessionId={sessionId} engineReady={engine === "ready"} readOnly={readOnly} />
        <BranchChip sessionId={sessionId} />
        {view.reason && <p className="text-size-sm text-text-dim">{view.reason}</p>}
        <span className="flex-1" />
        {streaming ? (
          <>
            {sendable && (
              <Button type="submit" aria-label="Steer">
                <SendIcon />
                Steer
              </Button>
            )}
            <Button
              variant="primary"
              className="h-(--size-send)"
              onClick={() => void stop()}
              disabled={!cancellable}
            >
              <StopIcon />
              Stop
            </Button>
          </>
        ) : (
          <Button
            type="submit"
            variant="primary"
            className="size-(--size-send) px-0"
            aria-label="Send"
            disabled={!sendable}
          >
            <SendIcon />
          </Button>
        )}
      </div>
      {streaming && (
        // Its own line, wrapping: in the button row it was cut to "Model an…".
        <p data-testid="delivery-hint" className="text-size-xs text-text-dim">
          {!waiting && `${deliveryHint(MAC)} · `}
          <span id={LOCKED_ID}>{LOCKED_WHILE_RUNNING}</span>
        </p>
      )}
    </form>
  );
}
