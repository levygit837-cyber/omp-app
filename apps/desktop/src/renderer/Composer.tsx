import { Button, Notice, SendIcon, StateMark, StatusPill, StopIcon } from "@omp-app/ui";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { SidecarStatus } from "../shared/bridge";
import { composerView, type EnginePhase, keyStopsTurn } from "./composer-state";
import { modelLabel } from "./format";
import { COMPOSER_ID, waitingPlaceholder } from "./requests-view";
import { message } from "./session-controller";
import { useModel } from "./session-hooks";
import { useShownStatus, useWaiting } from "./shown-status";

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
  const model = modelLabel(useModel(sessionId));
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const streaming = status === "streaming";
  const waiting = useWaiting(sessionId)[0];
  const readOnly = sidecar.state === "ready" && sidecar.mode === "read_only";
  const view = composerView({ readOnly, engine, streaming });
  // Esc stops a turn only while there is one to stop and an engine to tell. While the agent
  // waits for an answer Esc belongs to the band (reject / cancel): stopping is the Stop button.
  const cancellable = streaming && engine === "ready";
  const escStops = cancellable && !waiting;

  const cancel = useCallback(() => {
    window.omp.session.cancel(sessionId).catch((e: unknown) => setError(message(e)));
  }, [sessionId]);

  useEffect(() => {
    if (!escStops) return;
    const onKey = (event: KeyboardEvent) => {
      if (keyStopsTurn(event.key, field.current?.closest("[inert]") != null)) cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [escStops, cancel]);

  const send = (event: FormEvent) => {
    event.preventDefault();
    const prompt = text.trim();
    if (view.kind !== "input" || !view.canSend || !prompt) return;
    setError(null);
    setText("");
    onSent();
    window.omp.session.prompt(sessionId, prompt).catch((e: unknown) => setError(message(e)));
  };

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

  return (
    <form
      onSubmit={send}
      className="flex w-(--layout-composer) max-w-full flex-col gap-(--space-12) rounded-lg border border-border-hairline bg-bg-elevated px-(--space-18) pt-(--space-14) pb-(--space-12) has-[textarea:focus-visible]:border-border-field has-[textarea:focus-visible]:outline-(length:--size-focus-ring) has-[textarea:focus-visible]:outline-focus-ring has-[textarea:focus-visible]:outline-solid has-[textarea:focus-visible]:outline-offset-(--space-2)"
    >
      {error && <Notice severity="error" title={error} />}
      <div className="relative">
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
          value={text}
          placeholder={waiting ? waitingPlaceholder(waiting) : view.placeholder}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          className={`max-h-(--layout-composer-input-max) w-full resize-none bg-transparent text-size-body leading-(--line-height-prose) text-text-primary outline-none field-sizing-content placeholder:text-text-dim${waiting ? " pl-(--space-24) placeholder:text-text-secondary" : ""}`}
        />
      </div>
      <div className="flex items-center gap-(--space-16)">
        {model && (
          <p className="flex items-baseline gap-(--space-6) text-size-sm text-text-dim">
            model <span className="font-mono text-size-xs text-text-primary">{model}</span>
          </p>
        )}
        {view.reason && <p className="text-size-sm text-text-dim">{view.reason}</p>}
        <span className="flex-1" />
        {streaming ? (
          <Button
            variant="primary"
            className="h-(--size-send)"
            onClick={cancel}
            disabled={!cancellable}
          >
            <StopIcon />
            Stop
          </Button>
        ) : (
          <Button
            type="submit"
            variant="primary"
            className="size-(--size-send) px-0"
            aria-label="Send"
            disabled={!view.canSend || text.trim().length === 0}
          >
            <SendIcon />
          </Button>
        )}
      </div>
    </form>
  );
}
