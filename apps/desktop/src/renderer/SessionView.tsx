import { type FormEvent, memo, useCallback, useEffect, useState } from "react";
import type { SidecarStatus } from "../shared/bridge";
import {
  replicas,
  useCwd,
  useItem,
  useItemCount,
  useSessionError,
  useStatus,
  useSyncError,
  useWarnings,
} from "./session-hooks";
import { SessionLostError } from "./session-store";

/** Survives a window reload (same tab), so a reload re-attaches to the running session. */
const STORAGE_KEY = "omp-app.sessionId";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One timeline row. Re-renders only when its own item changes (items keep identity otherwise). */
const TimelineItem = memo(function TimelineItem({
  sessionId,
  index,
}: {
  sessionId: string;
  index: number;
}) {
  const item = useItem(sessionId, index);
  if (!item) return null;
  return (
    <li
      data-testid={`item-${item.kind}`}
      data-done={item.kind === "assistant" ? item.done : undefined}
    >
      <span className="text-size-xs uppercase text-text-secondary">{item.kind}</span>
      <pre className="whitespace-pre-wrap font-text text-size-sm">{item.text}</pre>
    </li>
  );
});

/** Non-blocking problems the session carries on despite. Raw text; #11 gives it a design. */
function Warnings({ sessionId }: { sessionId: string }) {
  const warnings = useWarnings(sessionId);
  if (!warnings || warnings.length === 0) return null;
  return (
    <ul
      data-testid="session-warnings"
      aria-label="Session warnings"
      className="flex flex-col gap-1"
    >
      {warnings.map((w, index) => (
        // Append-only list, so the index is a stable identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
        <li key={index} data-testid="session-warning" className="text-size-xs">
          {w.source} server "{w.server}": {w.message}
        </li>
      ))}
    </ul>
  );
}

function Timeline({ sessionId }: { sessionId: string }) {
  const count = useItemCount(sessionId);
  return (
    <ol
      data-testid="timeline"
      role="log"
      aria-label="Conversation"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto rounded-sm bg-bg-elevated p-3"
    >
      {Array.from({ length: count }, (_, index) => (
        // The timeline is append-only, so the index is a stable identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: append-only list
        <TimelineItem key={index} sessionId={sessionId} index={index} />
      ))}
    </ol>
  );
}

function Composer({ sessionId }: { sessionId: string }) {
  const status = useStatus(sessionId);
  const sessionError = useSessionError(sessionId);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const streaming = status === "streaming";

  const cancel = useCallback(() => {
    window.omp.session.cancel(sessionId).catch((e: unknown) => setError(message(e)));
  }, [sessionId]);

  useEffect(() => {
    if (!streaming) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [streaming, cancel]);

  const send = (event: FormEvent) => {
    event.preventDefault();
    const prompt = text.trim();
    if (!prompt || streaming) return;
    setError(null);
    setText("");
    window.omp.session.prompt(sessionId, prompt).catch((e: unknown) => setError(message(e)));
  };

  return (
    <form onSubmit={send} className="flex flex-col gap-2">
      <p
        data-testid="session-status"
        data-status={status}
        aria-live="polite"
        className="text-size-xs text-text-secondary"
      >
        Status: {status ?? "unknown"}
      </p>
      {(error ?? sessionError) && (
        <p role="alert" data-testid="session-error" className="text-size-sm font-medium">
          {error ?? sessionError}
        </p>
      )}
      <label className="flex flex-col gap-1 text-size-sm">
        Prompt
        <textarea
          data-testid="prompt-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) e.currentTarget.form?.requestSubmit();
          }}
          rows={3}
          className="rounded-sm border border-border-field bg-bg-base p-2"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={streaming || text.trim().length === 0}
          className="rounded-sm bg-accent px-3 py-1 text-on-accent disabled:opacity-50"
        >
          Send
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={!streaming}
          className="rounded-sm border border-accent px-3 py-1 disabled:opacity-50"
        >
          Stop (Esc)
        </button>
      </div>
    </form>
  );
}

/** The session's directory, read from the replica so it survives a reload. */
function SessionCwd({ sessionId }: { sessionId: string }) {
  const cwd = useCwd(sessionId);
  if (!cwd) return null;
  return (
    <code data-testid="session-cwd" className="truncate text-size-xs">
      {cwd}
    </code>
  );
}

/** Pick a directory, start a session in it, prompt, watch the answer stream in. */
export function SessionView({ sidecar }: { sidecar: SidecarStatus }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  // True once the sidecar stopped knowing the session (it restarted): sessions do not survive
  // that. The replica is already gone then, so there is no timeline and no composer to show.
  const [lost, setLost] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const syncError = useSyncError();
  const ready = sidecar.state === "ready";
  const readOnly = sidecar.state === "ready" && sidecar.mode === "read_only";

  // After a reload, or when the sidecar comes back after a restart: subscribe again to the
  // session in use. The snapshot restores it; "unknown session" means it is gone for good.
  useEffect(() => {
    if (!ready) return;
    const id = sessionStorage.getItem(STORAGE_KEY);
    if (!id) return;
    replicas.open(id).then(
      () => {
        setSessionId(id);
        setLost(false);
      },
      (e: unknown) => {
        if (!(e instanceof SessionLostError)) return setError(message(e));
        sessionStorage.removeItem(STORAGE_KEY);
        setSessionId(null);
        setLost(true);
      },
    );
  }, [ready]);

  const start = async () => {
    setError(null);
    try {
      const dir = await window.omp.session.pickDirectory();
      if (!dir) return;
      const id = await window.omp.session.create(dir);
      await replicas.open(id);
      const previous = sessionId;
      sessionStorage.setItem(STORAGE_KEY, id);
      setSessionId(id);
      setLost(false);
      if (previous) await replicas.close(previous).catch(() => undefined);
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <section
      className="flex min-h-0 w-[48rem] max-w-full flex-1 flex-col gap-3"
      aria-label="Session"
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid="pick-directory"
          onClick={() => void start()}
          disabled={!ready || readOnly}
          className="rounded-sm bg-accent px-3 py-1 text-on-accent disabled:opacity-50"
        >
          {sessionId ? "New session…" : "Pick a directory…"}
        </button>
        {sessionId && <SessionCwd sessionId={sessionId} />}
      </div>
      {lost && (
        <p role="alert" data-testid="session-lost" className="text-size-sm font-medium">
          Session lost — start a new one. The sidecar restarted and no longer has this session.
        </p>
      )}
      {(error ?? syncError) && (
        <p role="alert" className="text-size-sm font-medium">
          {error ?? syncError}
        </p>
      )}
      {sessionId && (
        <>
          <Warnings sessionId={sessionId} />
          <Timeline sessionId={sessionId} />
          <Composer sessionId={sessionId} />
        </>
      )}
    </section>
  );
}
